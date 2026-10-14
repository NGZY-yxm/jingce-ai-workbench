import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { SpeechJobs } from '../lib/speech-jobs.mjs';
import { SpeechProviderError } from '../lib/speech-provider.mjs';
import { createProject, setAssetDeleted } from '../lib/workflow.mjs';
import { waveFixture, until } from './support/speech-fixtures.mjs';

const result = () => ({ audio: waveFixture(), mime: 'audio/wav', extension: '.wav', duration: 0.25, usageCharacters: 8, traceId: 'fixture-trace' });
const request = (operationId, patch = {}) => ({ operationId, text: '镜策配音测试。', voiceId: 'fixture-voice', model: 'speech-2.8-hd', format: 'wav', ...patch });
async function setup(t, synthesize = async () => result()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-speech-jobs-')), store = new Store(root); await store.init();
  await store.saveSpeechSettings({ region: 'domestic', model: 'speech-2.8-hd', apiKey: 'job-private-key' });
  const project = createProject({ title: '配音任务验证' });
  await store.mutate(state => state.projects.push(project));
  const owner = { root, store, project, jobs: new SpeechJobs(store, { synthesize }) }; await owner.jobs.init();
  t.after(async () => { await owner.jobs.close(); await rm(root, { recursive: true, force: true }); }); return owner;
}

test('配音任务接收后允许继续提交；相同操作编号并发重放只生成一次，不同编号可生成同一文案', async t => {
  const releases = []; let calls = 0;
  const owner = await setup(t, async () => { calls++; await new Promise(resolve => releases.push(resolve)); return result(); });
  const { jobs, store, project, root } = owner;
  const firstRequest = request('operation-first');
  const [first, replay] = await Promise.all([jobs.start(project.id, firstRequest), jobs.start(project.id, firstRequest)]);
  assert.equal(first.id, replay.id);
  const second = await jobs.start(project.id, request('operation-second'));
  assert.notEqual(first.id, second.id);
  await until(() => calls === 2); assert.equal(jobs.list(project.id).length, 2);
  await assert.rejects(jobs.start(project.id, request('operation-first', { text: '其他文案' })), error => error.status === 409);
  releases.forEach(release => release());
  await until(() => jobs.list(project.id).every(job => job.state === 'done'));
  assert.equal(calls, 2); assert.equal(store.get(project.id).assets.length, 2);
  const firstAsset = store.get(project.id).assets.find(asset => asset.jobId === first.id);
  assert.equal(firstAsset.kind, 'audio'); assert.equal(firstAsset.source, 'model'); assert.equal(firstAsset.duration, 0.25);
  assert.deepEqual(await readFile(path.join(root, 'assets', firstAsset.file)), waveFixture());
  assert.doesNotMatch(await readFile(path.join(root, 'projects.json'), 'utf8'), /job-private-key/);
  assert.doesNotMatch(JSON.stringify(jobs.list(project.id)), /job-private-key/);
  await store.saveSpeechSettings({ region: 'domestic', model: 'speech-2.8-hd', apiKey: '' });
  assert.equal((await jobs.start(project.id, firstRequest)).id, first.id, '移除密钥后原操作仍返回已有任务');
});

test('任务继续接收并在后台按三个并发排队，每个任务保留提交时的连接和文案', async t => {
  const calls = [], releases = [];
  const { jobs, store, project } = await setup(t, async (settings, input) => {
    calls.push({ key: settings.apiKey, text: input.text }); await new Promise(resolve => releases.push(resolve)); return result();
  });
  for (let index = 0; index < 5; index++) await jobs.start(project.id, request(`operation-queue-${index}`, { text: `文案 ${index}` }));
  await until(() => calls.length === 3); assert.equal(jobs.list(project.id).filter(job => job.state === 'waiting').length, 2);
  await store.saveSpeechSettings({ region: 'international', model: 'speech-2.8-turbo', apiKey: 'replacement-private-key' });
  releases.splice(0).forEach(release => release());
  await until(() => calls.length === 5); releases.splice(0).forEach(release => release());
  await until(() => jobs.list(project.id).every(job => job.state === 'done'));
  assert.ok(calls.every(call => call.key === 'job-private-key'));
  assert.deepEqual(calls.map(call => call.text), ['文案 0', '文案 1', '文案 2', '文案 3', '文案 4']);
});

test('已生成但素材保存失败时重试只保存已有音频，重启后仍可恢复，不重复调用模型', async t => {
  let calls = 0; const owner = await setup(t, async () => { calls++; return result(); });
  const { store, project } = owner, originalMutate = store.mutate.bind(store); let rejectAssetSave = true;
  store.mutate = operation => originalMutate(async state => {
    const saved = await operation(state);
    if (rejectAssetSave && state.projects.some(item => item.assets.length)) { rejectAssetSave = false; throw new Error('simulated disk failure'); }
    return saved;
  });
  const job = await owner.jobs.start(project.id, request('operation-save-recovery'));
  await until(() => owner.jobs.get(job.id).state === 'save_pending' && !owner.jobs.busy.has(job.id));
  assert.equal(calls, 1); assert.equal(store.get(project.id).assets.length, 0);
  await owner.jobs.close();
  const restored = new Store(owner.root); await restored.init();
  owner.jobs = new SpeechJobs(restored, { synthesize: async () => { calls++; return result(); } }); await owner.jobs.init();
  assert.equal(owner.jobs.get(job.id).state, 'save_pending');
  await Promise.all([owner.jobs.retrySave(job.id), owner.jobs.retrySave(job.id)]);
  await until(() => owner.jobs.get(job.id).state === 'done');
  assert.equal(calls, 1); assert.equal(restored.get(project.id).assets.length, 1);
  await owner.jobs.retrySave(job.id); assert.equal(restored.get(project.id).assets.length, 1);
});

test('重启中断的提交变为需核对状态，刷新与操作重放都不自动再次生成', async t => {
  let calls = 0; const owner = await setup(t, async () => { calls++; throw new SpeechProviderError('连接中断', { uncertain: true, traceId: 'trace-uncertain' }); });
  const originalRequest = request('operation-uncertain'); const job = await owner.jobs.start(owner.project.id, originalRequest);
  await until(() => owner.jobs.get(job.id).state === 'uncertain'); await owner.jobs.close();
  await owner.store.mutate(state => { state.speechJobs[0].state = 'submitting'; });
  const restored = new Store(owner.root); await restored.init();
  owner.jobs = new SpeechJobs(restored, { synthesize: async () => { calls++; return result(); } }); await owner.jobs.init();
  assert.equal(owner.jobs.get(job.id).state, 'uncertain');
  assert.equal((await owner.jobs.start(owner.project.id, originalRequest)).id, job.id); assert.equal(calls, 1);
  await assert.rejects(owner.jobs.retrySave(job.id), error => error.status === 409);
  await assert.rejects(owner.jobs.resolve(job.id, { confirmed: false }), error => error.status === 409);
  assert.equal((await owner.jobs.resolve(job.id, { confirmed: true })).state, 'failed'); assert.equal(calls, 1);
});

test('生成期间删除工程仍保存结果；彻底删除需等待任务结束，并清理语音文件与连接快照', async t => {
  let release;
  const { jobs, store, project, root } = await setup(t, async () => { await new Promise(resolve => release = resolve); return result(); });
  const job = await jobs.start(project.id, request('operation-delete-project'));
  await until(() => Boolean(release)); await store.setDeleted(project.id, true);
  await assert.rejects(store.permanentlyDelete(project.id), error => error.status === 409);
  release(); await until(() => jobs.get(job.id).state === 'done');
  assert.equal(store.get(project.id, true).assets.length, 1);
  const assetFile = store.get(project.id, true).assets[0].file;
  await store.permanentlyDelete(project.id);
  assert.equal(jobs.list(project.id).length, 0);
  for (const file of [path.join(root, 'assets', assetFile), jobs.resultFile(job.id), jobs.connectionFile(job.id)]) await assert.rejects(readFile(file), error => error.code === 'ENOENT');
});

test('声音卡片接收首个结果，后续配音保留为独立素材，不替换已有选用', async t => {
  const { jobs, store, project } = await setup(t);
  await store.update(project.id, current => { current.graph.nodes.push({ id: 'audio-card', kind: 'audio', assetId: '', label: '配音卡', note: '', status: 'pending' }); return current; });
  const first = await jobs.start(project.id, request('operation-node-first', { nodeId: 'audio-card' }));
  await until(() => jobs.get(first.id).state === 'done');
  const firstAsset = jobs.get(first.id).assetId;
  const second = await jobs.start(project.id, request('operation-node-second', { nodeId: 'audio-card' }));
  await until(() => jobs.get(second.id).state === 'done');
  assert.equal(store.get(project.id).graph.nodes[0].assetId, firstAsset); assert.equal(store.get(project.id).assets.length, 2);
});

test('语音生成卡再次生成时选用最新结果，旧音频仍保留在素材库', async t => {
  const { jobs, store, project } = await setup(t);
  await store.update(project.id, current => {
    current.graph.nodes.push({ id: 'speech-card', kind: 'audio', role: 'speech-generation', label: '语音生成',
      speechConfig: { text: '第一段旁白。', model: 'speech-2.8-hd', voiceId: 'fixture-voice' } });
    return current;
  });
  const first = await jobs.start(project.id, request('speech-card-first', { nodeId: 'speech-card' }));
  await until(() => jobs.get(first.id).state === 'done');
  const second = await jobs.start(project.id, request('speech-card-second', { nodeId: 'speech-card', text: '第二段旁白。' }));
  await until(() => jobs.get(second.id).state === 'done');
  const saved = store.get(project.id);
  assert.equal(saved.graph.nodes[0].assetId, jobs.get(second.id).assetId);
  assert.equal(saved.assets.length, 2);
  assert.ok(saved.assets.some(asset => asset.id === jobs.get(first.id).assetId));
  assert.equal(saved.graph.nodes[0].speechConfig.text, '第一段旁白。');
});


test('删除配音可恢复：保留音频和操作编号，断开画布引用，重启后仍保持删除状态', async t => {
  let calls = 0;
  const owner = await setup(t, async () => { calls++; return result(); });
  const { jobs, store, project, root } = owner;
  await store.update(project.id, current => {
    current.graph.nodes.push({ id: 'deletable-audio', kind: 'audio', label: '配音卡片', assetId: '', note: '', status: 'pending' }); return current;
  });
  const input = request('operation-soft-delete', { nodeId: 'deletable-audio' });
  const job = await jobs.start(project.id, input);
  await until(() => jobs.get(job.id).state === 'done' && !jobs.busy.has(job.id));
  const asset = store.get(project.id).assets[0];
  assert.equal(store.get(project.id).graph.nodes[0].assetId, asset.id);
  const deleted = await jobs.setDeleted(job.id, true);
  assert.ok(deleted.deletedAt);
  assert.equal(deleted.deletedAt, store.get(project.id).assets[0].deletedAt);
  assert.equal(store.state.speechJobs[0].deletedAt, deleted.deletedAt);
  assert.equal((await jobs.setDeleted(job.id, true)).deletedAt, deleted.deletedAt);
  assert.equal(jobs.list(project.id).length, 0);
  assert.equal(jobs.list(project.id, true)[0].deletedAt, store.get(project.id).assets[0].deletedAt);
  assert.equal(store.get(project.id).graph.nodes[0].assetId, '');
  assert.deepEqual(await readFile(path.join(root, 'assets', asset.file)), waveFixture());
  assert.ok((await readFile(jobs.resultFile(job.id))).length);
  assert.ok((await readFile(jobs.connectionFile(job.id))).length);
  assert.equal((await jobs.start(project.id, input)).id, job.id);
  assert.equal(calls, 1);
  await jobs.close();
  const restored = new Store(root); await restored.init();
  owner.store = restored; owner.jobs = new SpeechJobs(restored, { synthesize: async () => { calls++; return result(); } }); await owner.jobs.init();
  assert.equal(owner.jobs.list(project.id).length, 0);
  assert.ok(owner.jobs.list(project.id, true)[0].deletedAt);
  const recovered = await owner.jobs.setDeleted(job.id, false);
  assert.equal(recovered.deletedAt, null);
  assert.equal(owner.jobs.list(project.id).length, 1);
  assert.equal(restored.get(project.id).assets[0].deletedAt, null);
  assert.equal(restored.get(project.id).graph.nodes[0].assetId, '', '恢复后由用户重新放到画布');
  assert.deepEqual(await readFile(path.join(root, 'assets', asset.file)), waveFixture());
  assert.equal(calls, 1);
});

test('素材库中的旧配音删除记录也可恢复或彻底删除，素材库恢复后禁止直接清理音频', async t => {
  const { jobs, store, project, root } = await setup(t);
  const job = await jobs.start(project.id, request('operation-legacy-delete'));
  await until(() => jobs.get(job.id).state === 'done' && !jobs.busy.has(job.id));
  const asset = store.get(project.id).assets[0];
  await store.update(project.id, current => setAssetDeleted(current, asset.id, true));
  assert.equal(store.state.speechJobs[0].deletedAt, undefined);
  assert.equal(jobs.list(project.id).length, 0);
  assert.ok(jobs.get(job.id).deletedAt);
  await jobs.setDeleted(job.id, false);
  assert.equal(jobs.list(project.id).length, 1);
  await jobs.setDeleted(job.id, true);
  await store.update(project.id, current => setAssetDeleted(current, asset.id, false));
  assert.equal(jobs.get(job.id).deletedAt, null);
  assert.equal(jobs.list(project.id).length, 1);
  await assert.rejects(jobs.permanentlyDelete(job.id), { status: 409 });
  assert.deepEqual(await readFile(path.join(root, 'assets', asset.file)), waveFixture());
  await store.update(project.id, current => setAssetDeleted(current, asset.id, true));
  await jobs.permanentlyDelete(job.id);
  assert.equal(jobs.list(project.id, true).length, 0);
  assert.equal(store.get(project.id).assets.length, 0);
  await assert.rejects(readFile(path.join(root, 'assets', asset.file)), { code: 'ENOENT' });
});

test('彻底删除配音只清理该任务音频、结果缓存与连接快照，旧操作重放不会再次收费', async t => {
  let calls = 0;
  const { jobs, store, project, root } = await setup(t, async () => { calls++; return result(); });
  const input = request('operation-permanent-delete');
  const first = await jobs.start(project.id, input);
  const second = await jobs.start(project.id, request('operation-retained-audio'));
  await until(() => jobs.list(project.id).every(job => job.state === 'done') && !jobs.busy.size);
  const firstAsset = store.get(project.id).assets.find(asset => asset.jobId === first.id);
  const secondAsset = store.get(project.id).assets.find(asset => asset.jobId === second.id);
  await assert.rejects(jobs.permanentlyDelete(first.id), { status: 409 });
  await jobs.setDeleted(first.id, true);
  const deleted = await jobs.permanentlyDelete(first.id);
  assert.equal(deleted.cleanupPending, 0);
  assert.equal(jobs.list(project.id, true).length, 1);
  assert.equal(store.get(project.id).assets.length, 1);
  assert.throws(() => jobs.get(first.id), { status: 404 });
  for (const file of [path.join(root, 'assets', firstAsset.file), jobs.resultFile(first.id), jobs.connectionFile(first.id)]) {
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  }
  assert.deepEqual(await readFile(path.join(root, 'assets', secondAsset.file)), waveFixture());
  assert.ok((await readFile(jobs.resultFile(second.id))).length);
  assert.ok((await readFile(jobs.connectionFile(second.id))).length);
  await assert.rejects(jobs.start(project.id, input), { status: 410 });
  await assert.rejects(jobs.setDeleted(first.id, false), { status: 404 });
  await assert.rejects(jobs.permanentlyDelete(first.id), { status: 404 });
  const restarted = new Store(root); await restarted.init();
  assert.equal(restarted.state.speechJobs.length, 1);
  const restartedJobs = new SpeechJobs(restarted, { synthesize: async () => { calls++; return result(); } });
  await assert.rejects(restartedJobs.start(project.id, input), { status: 410 });
  assert.equal(calls, 2);
});

test('生成、保存、待核对和本地忙碌的配音不允许删除或彻底删除', async t => {
  const { jobs, store, project } = await setup(t);
  const job = await jobs.start(project.id, request('operation-delete-guards'));
  await until(() => jobs.get(job.id).state === 'done' && !jobs.busy.has(job.id));
  const assetId = jobs.get(job.id).assetId;
  await jobs.close();
  for (const state of ['waiting', 'submitting', 'saving', 'save_pending', 'uncertain']) {
    await store.mutate(current => { current.speechJobs[0].state = state; });
    await assert.rejects(jobs.setDeleted(job.id, true), { status: 409 });
    await store.update(project.id, current => setAssetDeleted(current, assetId, true));
    await assert.rejects(jobs.permanentlyDelete(job.id), { status: 409 });
    await store.update(project.id, current => setAssetDeleted(current, assetId, false));
  }
  await store.mutate(current => { current.speechJobs[0].state = 'done'; });
  jobs.busy.add(job.id);
  await assert.rejects(jobs.setDeleted(job.id, true), { status: 409 });
  await store.update(project.id, current => setAssetDeleted(current, assetId, true));
  await assert.rejects(jobs.permanentlyDelete(job.id), { status: 409 });
  jobs.busy.delete(job.id);
  assert.equal(store.state.speechJobs.length, 1);
});

test('配音清理中断会保存待清理文件队列，重启后清理音频及缓存', async t => {
  const { jobs, store, project, root } = await setup(t);
  const job = await jobs.start(project.id, request('operation-cleanup-recovery'));
  await until(() => jobs.get(job.id).state === 'done' && !jobs.busy.has(job.id));
  const asset = store.get(project.id).assets[0];
  await jobs.setDeleted(job.id, true);
  store.cleanupDeletedFiles = async () => { throw new Error('模拟清理中断'); };
  assert.equal((await jobs.permanentlyDelete(job.id)).cleanupPending, 3);
  assert.equal(store.state.speechJobs.length, 0);
  assert.equal(store.get(project.id).assets.length, 0);
  assert.deepEqual(await readFile(path.join(root, 'assets', asset.file)), waveFixture());
  const restored = new Store(root); await restored.init();
  assert.equal(restored.state.pendingFileDeletes.length, 0);
  for (const file of [path.join(root, 'assets', asset.file), jobs.resultFile(job.id), jobs.connectionFile(job.id)]) {
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  }
});
