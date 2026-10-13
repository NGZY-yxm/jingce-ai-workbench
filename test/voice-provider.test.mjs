import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadCloneRecording, createCustomVoice, parseVoiceJson, downloadVoicePreview, resolveVoicePreview } from '../lib/voice-provider.mjs';
import { waveFixture, jsonReply } from './support/speech-fixtures.mjs';
const settings = { region: 'domestic', model: 'speech-2.8-hd', apiKey: 'voice-private-key' };
const request = { kind: 'clone', voiceId: 'jc_fixture_voice', previewText: '试听。', model: 'speech-2.8-hd', noiseReduction: true, volumeNormalization: false };

test('录音以官方 multipart purpose=voice_clone 上传，int64 File ID 保持原始精度', async () => {
  const bytes = waveFixture(12), id = '1768987900000051201';
  const result = await uploadCloneRecording(settings, bytes, { name: '录音.wav', mime: 'audio/wav' }, async (url, options) => {
    assert.equal(url, 'https://api.minimax.cn/v1/files/upload'); assert.equal(options.headers.Authorization, 'Bearer voice-private-key');
    assert.ok(!options.headers['Content-Type']); assert.equal(options.body.get('purpose'), 'voice_clone');
    const file = options.body.get('file'); assert.equal(file.name, '录音.wav'); assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
    return new Response(`{"base_resp":{"status_code":0},"file":{"file_id":${id}}}`);
  });
  assert.equal(result, id);
  assert.deepEqual(parseVoiceJson('{"n":1768987900000051201,"s":"1234567890000000000"}'), { n: id, s: '1234567890000000000' });
});
test('复刻请求保留精确数字 File ID，按所选模型试听，不使用错误的克隆字段', async () => {
  await createCustomVoice(settings, request, '1768987900000051201', async (url, options) => {
    assert.equal(url, 'https://api.minimax.cn/v1/voice_clone'); assert.match(options.body, /"file_id":1768987900000051201/);
    assert.deepEqual(parseVoiceJson(options.body), { file_id: '1768987900000051201', voice_id: request.voiceId, text: request.previewText, model: request.model, need_noise_reduction: true, need_volume_normalization: false });
    return jsonReply({ base_resp: { status_code: 0 }, demo_audio: 'https://filecdn.minimax.chat/voice-demo.mp3', trace_id: 'trace-a' });
  });
  const result = await createCustomVoice(settings, { ...request, previewText: '' }, '12345', async (_url, options) => {
    const body = JSON.parse(options.body); assert.equal(body.text, undefined); assert.equal(body.model, undefined);
    return jsonReply({ base_resp: { status_code: 0 } });
  });
  assert.equal(result.voiceId, request.voiceId); assert.equal(result.previewUrl, '');
});
test('文字设计使用官方 prompt、preview_text、voice_id，读取 trial_audio 十六进制预览', async () => {
  const bytes = waveFixture();
  const result = await createCustomVoice({ ...settings, region: 'international' }, { ...request, kind: 'design', prompt: '清澈女声' }, '', async (url, options) => {
    assert.equal(url, 'https://api.minimax.io/v1/voice_design');
    assert.deepEqual(JSON.parse(options.body), { prompt: '清澈女声', preview_text: request.previewText, voice_id: request.voiceId });
    return jsonReply({ base_resp: { status_code: 0 }, voice_id: request.voiceId, trial_audio: bytes.toString('hex') });
  });
  assert.deepEqual(Buffer.from(result.preview.audio, 'base64'), bytes);
});
test('创建成功而试听缺失或异常仍保存 Voice ID；异常地址不访问内网', async () => {
  for (const demo_audio of ['https://127.0.0.1/private', 'http://filecdn.minimax.chat/demo', 'https://localhost/private']) {
    const result = await createCustomVoice(settings, request, '123', async () => jsonReply({ base_resp: { status_code: 0 }, demo_audio }));
    assert.equal(result.voiceId, request.voiceId); assert.equal(result.previewUrl, ''); assert.match(result.previewMessage, /音色已创建/);
  }
  const result = await createCustomVoice(settings, { ...request, kind: 'design' }, '', async () => jsonReply({ base_resp: { status_code: 0 }, voice_id: request.voiceId, trial_audio: 'bad' }));
  assert.equal(result.voiceId, request.voiceId); assert.equal(result.preview, null);
});
test('试听下载只访问官方 HTTPS CDN，禁止向 CDN 发送 API Key，限制重定向目标', async () => {
  const preview = await downloadVoicePreview('https://filecdn.minimax.chat/demo.wav', async (_url, options) => { assert.equal(options.method, 'GET'); assert.equal(options.headers, undefined); return new Response(waveFixture()); });
  assert.equal(preview.mime, 'audio/wav');
  let calls = 0;
  await assert.rejects(downloadVoicePreview('https://filecdn.minimax.chat/demo', async () => { calls++; return new Response('', { status: 302, headers: { location: 'https://127.0.0.1/private' } }); }));
  assert.equal(calls, 1);
});
test('创建超时与不可读成功响应标为需核对；明确认证失败脱敏且可区分上传阶段', async () => {
  await assert.rejects(createCustomVoice(settings, request, '123', async () => { throw new Error('network'); }), error => error.uncertain === true);
  await assert.rejects(createCustomVoice(settings, request, '123', async () => new Response('incomplete')), error => error.uncertain === true);
  await assert.rejects(createCustomVoice(settings, request, '123', async () => jsonReply({ base_resp: { status_code: 1004, status_msg: 'Bearer voice-private-key rejected' }, trace_id: 'voice-private-key' })), error => !error.uncertain && !error.message.includes(settings.apiKey) && !error.traceId.includes(settings.apiKey));
  await assert.rejects(uploadCloneRecording(settings, waveFixture(12), { name: 'a.wav' }, async () => { throw new Error('network'); }), error => error.uncertain === false);
});

test('试听可来自对象存储 CDN，生产下载解析并固定公网 IP，阻止 DNS 指向私网或混合解析', async () => {
  const publicUrl = 'https://minimax-example.oss-cn-shanghai.aliyuncs.com/demo.wav';
  const resolved = await resolveVoicePreview(publicUrl, async () => [{ address: '8.8.8.8', family: 4 }]);
  assert.equal(resolved.url.href, publicUrl); assert.equal(resolved.pinned.address, '8.8.8.8');
  for (const addresses of [[], [{ address: '192.168.1.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]]) {
    await assert.rejects(resolveVoicePreview(publicUrl, async () => addresses));
  }
  const result = await createCustomVoice(settings, request, '123', async () => jsonReply({ base_resp: { status_code: 0 }, demo_audio: publicUrl }));
  assert.equal(result.previewUrl, publicUrl);
});
