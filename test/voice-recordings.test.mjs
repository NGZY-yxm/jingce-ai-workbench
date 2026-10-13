import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectVoiceRecording } from '../lib/voice-recordings.mjs';
import { normalizeVoiceRequest, estimateVoicePreviewCost } from '../public/voice-parameters.js';
import { normalizeSpeechRequest } from '../public/speech-parameters.js';
import { waveFixture } from './support/speech-fixtures.mjs';
import { mp3Fixture, m4aFixture } from './support/voice-fixtures.mjs';

test('复刻录音根据实际 WAV、MP3、M4A 结构读取时长，扩展名与文件内容一致', () => {
  for (const [name, bytes] of [['录音.wav', waveFixture(12)], ['录音.mp3', mp3Fixture(12)], ['录音.m4a', m4aFixture(12)]]) {
    const result = inspectVoiceRecording(bytes, name); assert.ok(result.duration >= 12 && result.duration < 12.04); assert.equal(result.extension, '.' + name.split('.').at(-1));
  }
  assert.throws(() => inspectVoiceRecording(waveFixture(12), '伪装.mp3'));
  assert.throws(() => inspectVoiceRecording(m4aFixture(12, true), '视频.m4a'), /视频轨道/);
});
test('录音时长、20 MB 限额与损坏文件在调用 MiniMax 前拒绝', () => {
  assert.throws(() => inspectVoiceRecording(waveFixture(9), '短.wav'), /10 秒/);
  assert.throws(() => inspectVoiceRecording(waveFixture(301), '长.wav'), /5 分钟/);
  assert.throws(() => inspectVoiceRecording(Buffer.alloc(20 * 1024 * 1024 + 1), '过大.wav'), error => error.status === 413);
  assert.throws(() => inspectVoiceRecording(Buffer.from('RIFF'), '损坏.wav'));
  assert.throws(() => inspectVoiceRecording(waveFixture(12).subarray(0, 100), '截断.wav'));
  assert.throws(() => inspectVoiceRecording(mp3Fixture().subarray(0, 300), '截断.mp3'));
  assert.throws(() => inspectVoiceRecording(m4aFixture().subarray(0, 80), '截断.m4a'));
});
test('自定义 Voice ID 与两种流程各自文案要求校验，后续正式配音支持 256 位 ID', () => {
  const request = { kind: 'clone', name: '我的声音', voiceId: 'jc_voice_123', model: 'speech-2.8-hd', recordingId: 'recording-fixture' };
  for (const voiceId of ['short', '12345678', 'abcdefgh_', 'abcdefgh-', 'has space', 'a'.repeat(257)]) assert.throws(() => normalizeVoiceRequest({ ...request, voiceId }));
  const longId = 'a'.repeat(256); assert.equal(normalizeVoiceRequest({ ...request, voiceId: longId }).voiceId, longId);
  assert.equal(normalizeSpeechRequest({ text: '配音', voiceId: longId }).voiceId, longId);
  assert.throws(() => normalizeVoiceRequest({ ...request, recordingId: '' }), /上传/);
  assert.throws(() => normalizeVoiceRequest({ ...request, previewText: '字'.repeat(1001) }), /1000/);
  const design = { ...request, kind: 'design', prompt: '温暖女声', previewText: '测试试听。' };
  assert.throws(() => normalizeVoiceRequest({ ...design, previewText: '' }), /试听文案/);
  assert.throws(() => normalizeVoiceRequest({ ...design, previewText: '字'.repeat(501) }), /500/);
  assert.throws(() => normalizeVoiceRequest({ ...design, prompt: '' }), /描述/);
  assert.equal(normalizeVoiceRequest(design).recordingId, '');
});

test('设计试听使用官方独立单价，复刻试听随所选模型估算，国际接口不换算价格', () => {
  assert.equal(estimateVoicePreviewCost('字', 'design', 'speech-2.8-hd').amount, 0.0004);
  assert.equal(estimateVoicePreviewCost('字', 'clone', 'speech-2.8-hd').amount, 0.0007);
  assert.equal(estimateVoicePreviewCost('字', 'clone', 'speech-2.8-turbo').amount, 0.0004);
  assert.equal(estimateVoicePreviewCost('字', 'design', 'speech-2.8-hd', 'international'), null);
});
