import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { VoiceJobs } from '../lib/voice-jobs.mjs';
import { SpeechProviderError } from '../lib/speech-provider.mjs';
import { waveFixture, until, jsonReply } from './support/speech-fixtures.mjs';
import { customVoiceResult, previewFixture } from './support/voice-fixtures.mjs';
const request = (op, patch = {}) => ({ operationId: op, kind: 'design', name: '温暖女声', voiceId: `jc_${op.replace(/-/g, '_')}`, prompt: '温暖清晰的女声', previewText: '试听文案。', model: 'speech-2.8-hd', ...patch });
async function setup(t, integrations = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-voice-jobs-')), store = new Store(root); await store.init();
  await store.saveSpeechSettings({ region: 'domestic', model: 'speech-2.8-hd', apiKey: 'voice-job-secret' });
  const options = { createVoice: async (_settings, req) => customVoiceResult(req), ...integrations }, owner = { root, store, options, jobs: new VoiceJobs(store, options) };
  await owner.jobs.init(); t.after(async () => { await owner.jobs.close(); await rm(root, { recursive: true, force: true }); }); return owner;
}

test('音色创建连续提交与并发同操作重放；相同 Voice ID 保留原任务，失败前不重复创建', async t => {
  let calls = 0; const releases = [];
  const { jobs, store } = await setup(t, { createVoice: async (_settings, req) => { calls++; await new Promise(resolve => releases.push(resolve)); return customVoiceResult(req); } });
  t.after(() => releases.forEach(release => release()));
  const input = request('operation-first'), [first, same] = await Promise.all([jobs.start(input), jobs.start(input)]);
  assert.equal(first.id, same.id);
  const second = await jobs.start(request('operation-second')); assert.notEqual(first.id, second.id);
  await until(() => calls === 2);
  await assert.rejects(jobs.start(request('operation-first', { prompt: '不同音色' })), error => error.status === 409);
  await assert.rejects(jobs.start(request('operation-another', { voiceId: input.voiceId })), error => error.status === 409);
  releases.splice(0).forEach(release => release()); await until(() => jobs.get(first.id).state === 'done' && jobs.get(second.id).state === 'done');
  assert.equal(calls, 2); assert.equal((await jobs.localVoices('speech-2.8-hd')).length, 2);
  assert.doesNotMatch(JSON.stringify(await jobs.list('speech-2.8-hd')), /voice-job-secret/);
  await store.saveSpeechSettings({ region: 'domestic', model: 'speech-2.8-hd', apiKey: '' });
  assert.equal((await jobs.start(input)).id, first.id);
});
test('排队音色保留提交时的连接，修改密钥和区域后不会改用另一个账户', async t => {
  const calls = [], releases = [];
  const { jobs, store } = await setup(t, { createVoice: async (settings, req) => { calls.push({ key: settings.apiKey, region: settings.region }); await new Promise(resolve => releases.push(resolve)); return customVoiceResult(req); } });
  t.after(() => releases.forEach(release => release()));
  const accepted = []; for (let i = 0; i < 3; i++) accepted.push(await jobs.start(request(`operation-queue-${i}`)));
  await until(() => calls.length === 2);
  await store.saveSpeechSettings({ region: 'international', model: 'speech-2.8-hd', apiKey: 'other-voice-key' });
  assert.equal((await jobs.list('speech-2.8-hd')).length, 0);
  releases.splice(0).forEach(release => release()); await until(() => calls.length === 3); releases.splice(0).forEach(release => release());
  await until(() => accepted.every(job => jobs.get(job.id).state === 'done'));
  assert.ok(calls.every(call => call.key === 'voice-job-secret' && call.region === 'domestic'));
});
test('本机录音可试听，重复上传恢复同一记录；远程上传发生在明确创建后，账户隔离', async t => {
  let uploads = 0, creates = 0;
  const { jobs, store } = await setup(t, { uploadRecording: async () => { uploads++; return '1768987900000051201'; },
    createVoice: async (_settings, req, id) => { creates++; assert.equal(id, '1768987900000051201'); return customVoiceResult(req); } });
  const recording = await jobs.upload('speech-2.8-hd', { name: '我的声音.wav', operationId: 'upload-operation-a' }, waveFixture(12));
  assert.equal(uploads, 0); assert.equal(creates, 0);
  assert.equal((await jobs.upload('speech-2.8-hd', { name: '我的声音.wav', operationId: 'upload-operation-a' }, waveFixture(12))).id, recording.id);
  assert.deepEqual(await readFile(jobs.recordingMedia(recording.id).filename), waveFixture(12));
  const first = await jobs.start(request('operation-clone-a', { kind: 'clone', recordingId: recording.id }));
  await until(() => jobs.get(first.id).state === 'done');
  const second = await jobs.start(request('operation-clone-b', { kind: 'clone', recordingId: recording.id }));
  await until(() => jobs.get(second.id).state === 'done'); assert.equal(uploads, 1); assert.equal(creates, 2);
  await store.saveSpeechSettings({ region: 'domestic', model: 'speech-2.8-hd', apiKey: 'another-account-key' });
  await assert.rejects(jobs.start(request('operation-wrong-account', { kind: 'clone', recordingId: recording.id })), /账户不匹配/);
});
test('创建成功后本地保存失败可在重启后恢复，只保存原结果而不重新创建', async t => {
  let calls = 0; const owner = await setup(t, { createVoice: async (_settings, req) => { calls++; return customVoiceResult(req); } });
  const original = owner.store.mutate.bind(owner.store); let fail = true;
  owner.store.mutate = operation => original(async state => { const result = await operation(state); if (fail && state.voiceJobs.some(job => job.state === 'done')) { fail = false; throw new Error('disk error'); } return result; });
  const first = await owner.jobs.start(request('operation-save-failure'));
  await until(() => owner.jobs.get(first.id).state === 'save_pending' && !owner.jobs.busy.has(first.id));
  assert.match(await readFile(owner.jobs.resultFile(first.id), 'utf8'), /jc_operation_save_failure/);
  await owner.jobs.close(); const restored = new Store(owner.root); await restored.init(); owner.jobs = new VoiceJobs(restored, owner.options); await owner.jobs.init();
  await owner.jobs.retrySave(first.id); await until(() => owner.jobs.get(first.id).state === 'done'); assert.equal(calls, 1);
  assert.deepEqual(await readFile(owner.jobs.previewMedia(first.id).filename), waveFixture());
});
test('试听下载失败保留已创建 Voice ID；重启后重试试听不调用创建接口', async t => {
  let creates = 0, downloads = 0;
  const owner = await setup(t, { createVoice: async (_settings, req) => { creates++; return { ...customVoiceResult(req), preview: null, previewUrl: 'https://filecdn.minimax.chat/demo.wav' }; },
    downloadPreview: async () => { downloads++; if (downloads === 1) throw new Error('offline'); return previewFixture(); } });
  const first = await owner.jobs.start(request('operation-preview-failure'));
  await until(() => owner.jobs.get(first.id).state === 'done'); assert.equal(owner.jobs.get(first.id).previewState, 'pending');
  assert.equal((await owner.jobs.localVoices('speech-2.8-hd'))[0].id, first.request.voiceId);
  await owner.jobs.close(); const restored = new Store(owner.root); await restored.init(); owner.jobs = new VoiceJobs(restored, owner.options); await owner.jobs.init();
  await owner.jobs.retryPreview(first.id); await until(() => owner.jobs.get(first.id).previewState === 'ready'); assert.equal(creates, 1); assert.equal(downloads, 2);
});
test('创建中断不自动重试；核对平台只读取列表，找到同类型同 Voice ID 后恢复', async t => {
  let creates = 0, reads = 0;
  const input = request('operation-uncertain');
  const { jobs } = await setup(t, { createVoice: async () => { creates++; throw new SpeechProviderError('连接中断', { uncertain: true }); },
    fetcher: async (url, options) => { reads++; assert.ok(url.endsWith('/get_voice')); assert.equal(JSON.parse(options.body).voice_type, 'all'); return jsonReply({ base_resp: { status_code: 0 }, voice_generation: [{ voice_id: input.voiceId, voice_name: '音色' }] }); } });
  const first = await jobs.start(input); await until(() => jobs.get(first.id).state === 'uncertain'); jobs.tick();
  assert.equal((await jobs.start(input)).id, first.id); assert.equal(creates, 1);
  const recovered = await jobs.reconcile(first.id); assert.equal(recovered.state, 'done'); assert.equal(recovered.voiceId, input.voiceId);
  assert.equal(creates, 1); assert.equal(reads, 1);
});
test('核对列表未找到音色不认定失败；明确结束后保留本地记录且没有再次创建', async t => {
  let calls = 0;
  const { jobs } = await setup(t, { createVoice: async () => { calls++; throw new SpeechProviderError('timeout', { uncertain: true }); },
    fetcher: async () => jsonReply({ base_resp: { status_code: 0 }, system_voice: [] }) });
  const job = await jobs.start(request('operation-no-voice')); await until(() => jobs.get(job.id).state === 'uncertain');
  assert.equal((await jobs.reconcile(job.id)).state, 'uncertain'); await assert.rejects(jobs.resolve(job.id, {}), error => error.status === 409);
  assert.equal((await jobs.resolve(job.id, { confirmed: true })).state, 'failed'); assert.equal(calls, 1);
});
test('重启中断创建且无结果文件时转为需核对，不自动重放收费创建', async t => {
  let calls = 0; const owner = await setup(t, { createVoice: async () => { calls++; throw new Error('should not create'); } }); await owner.jobs.close();
  await owner.store.mutate(state => state.voiceJobs.push({ id: 'interrupted-job', state: 'creating', request: request('operation-interrupted'), accountKey: 'fixture' }));
  owner.jobs = new VoiceJobs(owner.store, owner.options); await owner.jobs.init(); assert.equal(owner.jobs.get('interrupted-job').state, 'uncertain'); assert.equal(calls, 0);
});
