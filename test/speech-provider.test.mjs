import test from 'node:test';
import assert from 'node:assert/strict';
import { listSpeechVoices, synthesizeSpeech, normalizeSpeechSettings, publicSpeechSettings, SpeechProviderError } from '../lib/speech-provider.mjs';
import { normalizeSpeechRequest, estimateSpeechCost } from '../public/speech-parameters.js';
import { waveFixture, speechReply, jsonReply } from './support/speech-fixtures.mjs';

const settings = { region: 'domestic', model: 'speech-2.8-hd', apiKey: 'minimax-test-secret' };
const input = { model: 'speech-2.8-hd', text: '镜策配音测试。\n第二行可编辑。', voiceId: 'fixture-voice', speed: 1.1, vol: 1.2, pitch: -2, emotion: 'calm', format: 'wav' };

test('MiniMax 配音使用官方国内接口和最小非流式请求，保存完整 WAV 与平台计费信息', async () => {
  const audio = waveFixture();
  const result = await synthesizeSpeech(settings, input, async (url, options) => {
    assert.equal(url, 'https://api.minimax.cn/v1/t2a_v2'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer minimax-test-secret'); assert.ok(options.signal);
    assert.deepEqual(JSON.parse(options.body), { model: input.model, text: input.text, stream: false,
      voice_setting: { voice_id: input.voiceId, speed: 1.1, vol: 1.2, pitch: -2, emotion: 'calm' },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'wav', channel: 1 }, output_format: 'hex' });
    return jsonReply(speechReply(audio));
  });
  assert.deepEqual(result.audio, audio); assert.equal(result.mime, 'audio/wav'); assert.equal(result.extension, '.wav');
  assert.equal(result.duration, 0.25); assert.equal(result.usageCharacters, 12); assert.equal(result.traceId, 'fixture-trace');
});

test('官方国际接口可选择，MP3 输出不发送空情绪参数', async () => {
  const result = await synthesizeSpeech({ ...settings, region: 'international' }, { text: 'hello', format: 'mp3' }, async (url, options) => {
    assert.equal(url, 'https://api.minimax.io/v1/t2a_v2'); assert.equal(JSON.parse(options.body).voice_setting.emotion, undefined);
    return jsonReply(speechReply(Buffer.from('ID3fixture')));
  });
  assert.equal(result.mime, 'audio/mpeg');
});

test('读取账户系统、复刻和设计音色只调用 get_voice，不提交配音，并过滤重复项', async () => {
  let count = 0;
  const result = await listSpeechVoices(settings, async (url, options) => {
    count++; assert.equal(url, 'https://api.minimax.cn/v1/get_voice'); assert.deepEqual(JSON.parse(options.body), { voice_type: 'all' });
    return jsonReply({ base_resp: { status_code: 0 }, system_voice: [{ voice_id: 'a', voice_name: '测试音色', description: ['男声', '中文'] }, { voice_id: 'a' }],
      voice_cloning: [{ voice_id: 'b', voice_name: '已复刻' }], voice_generation: [{ voice_id: 'c', voice_name: '已设计' }] });
  });
  assert.equal(count, 1); assert.deepEqual(result.voices.map(voice => voice.type), ['system', 'cloned', 'designed']);
  assert.equal(result.voices[0].description, '男声，中文'); assert.match(result.message, /未提交配音/);
});

test('参数与区域在请求前校验，支持 Unicode 字符计数和完整文案，不静默更换模型情绪', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error('should not fetch'); };
  for (const patch of [{ model: 'unknown' }, { text: '' }, { text: '字'.repeat(10000) }, { speed: 2.1 }, { speed: '1' },
    { vol: 0 }, { vol: 11 }, { pitch: 0.5 }, { pitch: -13 }, { emotion: 'whisper' }, { voiceId: '\n' }, { format: 'flac' }]) {
    await assert.rejects(synthesizeSpeech(settings, { ...input, ...patch }, fetcher));
  }
  await assert.rejects(synthesizeSpeech({ ...settings, region: 'wrong' }, input, fetcher));
  await assert.rejects(synthesizeSpeech({ ...settings, apiKey: '' }, input, fetcher));
  assert.equal(calls, 0);
  assert.doesNotThrow(() => normalizeSpeechRequest({ text: '🙂'.repeat(9999) }));
  assert.equal(normalizeSpeechRequest({ text: '第一行\n第二行' }).name, '配音 · 第一行 第二行');
  assert.equal(normalizeSpeechRequest({ text: '低音量', vol: 0.001, model: 'speech-2.6-hd', emotion: 'whisper' }).emotion, 'whisper');
});

test('保存密钥时仅接受官方连接，留空保留、移除清空，公开设置不含密钥', () => {
  assert.equal(normalizeSpeechSettings({ apiKey: '' }, settings).apiKey, settings.apiKey);
  assert.equal(normalizeSpeechSettings({ clearKey: true }, settings).apiKey, '');
  assert.throws(() => normalizeSpeechSettings({ baseUrl: 'https://attacker.invalid' }, settings));
  assert.throws(() => normalizeSpeechSettings({ apiKey: 'a\nb' }, settings));
  assert.doesNotMatch(JSON.stringify(publicSpeechSettings(settings)), /minimax-test-secret/);
});

test('HTTP 200 的平台认证失败仍为失败，密钥与编码密钥在错误和追踪号中脱敏', async () => {
  const secretSettings = { ...settings, apiKey: 'secret/+?=' };
  await assert.rejects(synthesizeSpeech(secretSettings, input, async () => jsonReply({ base_resp: { status_code: 1004,
    status_msg: `bad ${secretSettings.apiKey} ${encodeURIComponent(secretSettings.apiKey)}` }, trace_id: secretSettings.apiKey })), error => {
    assert.ok(error instanceof SpeechProviderError); assert.equal(error.uncertain, false); assert.equal(error.providerCode, 1004);
    assert.doesNotMatch(error.message + error.traceId, /secret|%2F|%2B/); return true;
  });
});

test('连接、平台超时、损坏响应、部分音频和错误格式均保留需核对状态，绝不自动重试', async () => {
  for (const fetcher of [async () => { throw new Error('network'); }, async () => jsonReply({ base_resp: { status_code: 1001, status_msg: 'timeout' } }),
    async () => new Response('{'), async () => jsonReply({ data: {} }),
    async () => jsonReply(speechReply(undefined, { data: { status: 1, audio: waveFixture().toString('hex') } })),
    async () => jsonReply(speechReply(undefined, { data: { status: 2, audio: 'a1z2' } })),
    async () => jsonReply(speechReply(undefined, { data: { status: 2, audio: '123' } })),
    async () => jsonReply(speechReply(Buffer.from('ID3wrong-format')))]) {
    let calls = 0;
    await assert.rejects(synthesizeSpeech(settings, input, async (...args) => { calls++; return fetcher(...args); }), error => error.uncertain === true);
    assert.equal(calls, 1);
  }
});

test('国内基础合成估价按汉字双计数，HD 与 Turbo 使用当前官方单价；国际接口不猜价', () => {
  assert.deepEqual(estimateSpeechCost('中文a\n', 'speech-2.8-hd'), { characters: 6, pricePerTenThousand: 3.5, amount: 0.0021 });
  assert.equal(estimateSpeechCost('一万'.repeat(2500), 'speech-2.8-turbo').amount, 2);
  assert.equal(estimateSpeechCost('text', 'speech-2.8-hd', 'international'), null);
});
