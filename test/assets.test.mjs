import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createStudio } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { createProject, updateProject, setAssetDeleted } from '../lib/workflow.mjs';
import { compositionClips, compositionAudio, compose } from '../lib/compose.mjs';
import { CosStorage, storageConfigForTests } from '../lib/storage.mjs';
import { resolveSceneReferences } from '../public/reference-model.js';

function referenceProject(project = createProject(), portrait = { id: 'portrait', kind: 'image', name: '人物.png' }) {
  project.assets = [portrait, { id: 'street', kind: 'image', name: '街道.png' },
    { id: 'result', kind: 'video', name: '生成视频.mp4', file: 'result.mp4', mime: 'video/mp4', source: 'model', sceneId: 'one' },
    { id: 'music', kind: 'audio', name: '音乐.wav', file: 'music.wav', mime: 'audio/wav' }];
  return updateProject(project, { revision: project.revision, graph: { nodes: [
    { id: 'portrait-card', kind: 'image', assetId: portrait.id },
    { id: 'street-card', kind: 'image', assetId: 'street' },
    { id: 'result-card', kind: 'video', assetId: 'result' },
    { id: 'music-card', kind: 'audio', assetId: 'music' },
    { id: 'one-card', kind: 'video', sceneId: 'one' },
    { id: 'two-card', kind: 'video', sceneId: 'two' },
  ], links: [
    { id: 'portrait-link', from: 'portrait-card', to: 'one-card' },
    { id: 'street-link', from: 'street-card', to: 'one-card' },
    { id: 'output-link', from: 'one-card', to: 'two-card', reference: { assetId: 'result', kind: 'video' } },
    { id: 'material-link', from: 'result-card', to: 'two-card' },
  ] }, scenes: [
    { id: 'one', title: '人物进入街道', videoAssetId: 'result', videoPrompt: '@图片1走入@图片2的街道', references: [
      { refId: 'manual-portrait', assetId: portrait.id, kind: 'image', note: '保留服装' },
      { refId: 'manual-street', assetId: 'street', kind: 'image' },
    ] },
    { id: 'two', title: '运镜参考', videoAssetId: 'result', videoPrompt: '参考@视频1的运镜', references: [
      { nodeId: 'one-card', assetId: 'result', kind: 'video' },
    ] },
  ] });
}

async function temporaryRoot(t, prefix) {
  const parent = path.resolve(os.tmpdir()), root = await mkdtemp(path.join(parent, prefix));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith(prefix));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('删除引用中的图片：断开画布与手动参考、提示词标记失效，恢复不接管原引用', () => {
  const project = referenceProject(), original = structuredClone(project);
  const removed = setAssetDeleted(project, 'portrait', true);
  assert.deepEqual(project, original, '不得直接修改调用方的工程');
  assert.ok(removed.assets.find(asset => asset.id === 'portrait').deletedAt);
  assert.equal(removed.revision, project.revision + 1);
  assert.deepEqual(removed.scenes[0].references.map(item => item.assetId), ['street']);
  assert.equal(removed.scenes[0].videoPrompt, '@图片1（已断开）走入@图片1的街道');
  assert.equal(removed.scenes[0].promptMentions[0].missing, true);
  assert.notEqual(removed.scenes[0].promptMentions[1].missing, true);
  assert.equal(removed.graph.nodes.find(node => node.id === 'portrait-card').assetId, '');
  assert.equal(removed.graph.nodes.find(node => node.id === 'portrait-card').assetName, '人物.png');
  assert.equal(removed.graph.links.some(link => link.id === 'portrait-link'), false);
  assert.equal(removed.scenes[0].videoAssetId, 'result');
  assert.doesNotThrow(() => updateProject(removed, { revision: removed.revision, graph: removed.graph, scenes: removed.scenes }));
  assert.deepEqual(setAssetDeleted(removed, 'portrait', true), removed, '重复删除不改变时间和版本');
  const restored = setAssetDeleted(removed, 'portrait', false);
  assert.equal(restored.assets.find(asset => asset.id === 'portrait').deletedAt, null);
  assert.deepEqual(restored.scenes, removed.scenes);
  assert.deepEqual(restored.graph, removed.graph);
  assert.throws(() => setAssetDeleted(project, 'missing', true), error => error.status === 404);
});

test('删除视频同时清空成片选用和跨分镜结果连线，保留其它素材、分镜及已导出成片', () => {
  const project = referenceProject();
  project.exports = [{ id: 'finished-cut', state: 'done', file: 'finished-cut.mp4' }];
  const removed = setAssetDeleted(project, 'result', true);
  assert.ok(removed.scenes.every(scene => !scene.videoAssetId));
  assert.equal(removed.scenes[1].references.length, 0);
  assert.equal(removed.scenes[1].videoPrompt, '参考@视频1（已断开）的运镜');
  assert.deepEqual(removed.graph.links.map(link => link.id), ['portrait-link', 'street-link']);
  assert.equal(removed.graph.nodes.length, project.graph.nodes.length);
  assert.deepEqual(removed.exports, project.exports);
  assert.deepEqual(removed.scenes[0].references, project.scenes[0].references);
  assert.throws(() => updateProject(removed, { revision: removed.revision,
    scenes: removed.scenes.map(scene => ({ ...scene, videoAssetId: 'result' })) }), /不存在的视频/);
  assert.throws(() => updateProject(removed, { revision: removed.revision,
    graph: { ...removed.graph, nodes: removed.graph.nodes.map(node => node.id === 'result-card' ? { ...node, assetId: 'result' } : node) } }), /不存在或类型不匹配/);
});

test('旧页面或撤销快照中的已删除素材不会重新加入参考清单', () => {
  const project = referenceProject();
  project.assets[0].deletedAt = new Date().toISOString();
  const references = resolveSceneReferences(project, project.scenes[0]);
  assert.deepEqual(references.map(reference => reference.assetId), ['street']);
});

test('HTTP 素材删除与恢复：鉴权、项目隔离、保留文件和平台任务、重启后持久化', async t => {
  const root = await temporaryRoot(t, 'jingce-assets-http-');
  const options = { root, catalog: [], tools: { ready: true }, integrations: {
    submit: async () => { throw new Error('测试不得提交生成任务'); },
    poll: async (_settings, job) => ({ taskId: job.providerTaskId, state: 'running', progress: null }),
  } };
  let app = await createStudio(options), url = await app.start(0);
  t.after(() => app.close());
  let bootstrap = await (await fetch(url + '/api/bootstrap')).json();
  const send = (route, method = 'GET', body, extra = {}) => fetch(url + route, { method,
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const project = await (await send('/api/projects', 'POST', { title: '删除验证' })).json();
  const other = await (await send('/api/projects', 'POST', { title: '隔离工程' })).json();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const upload = await fetch(url + '/api/projects/' + project.id + '/assets', { method: 'POST',
    headers: { 'X-Studio-Token': bootstrap.token, 'X-File-Name': encodeURIComponent('人物.png'), 'Content-Type': 'application/octet-stream' }, body: png });
  assert.equal(upload.status, 201);
  const { asset } = await upload.json();
  await writeFile(path.join(root, 'assets', 'result.mp4'), Buffer.from('retained video file'));
  await writeFile(path.join(root, 'assets', 'music.wav'), Buffer.from('retained audio file'));
  await app.store.update(project.id, current => referenceProject(current, asset));
  await app.store.mutate(state => {
    state.jobs.push({ id: 'done-job', projectId: project.id, sceneId: 'one', state: 'done', assetId: 'result',
      providerTaskId: 'provider-done', message: '已保存', createdAt: new Date().toISOString() },
    { id: 'accepted-job', projectId: project.id, sceneId: 'two', state: 'running', references: [{ assetId: asset.id, kind: 'image' }],
      providerTaskId: 'provider-running', message: '正在生成', createdAt: new Date().toISOString() });
  });
  const initialJobs = structuredClone(app.store.state.jobs);
  const route = '/api/projects/' + project.id + '/assets/' + asset.id;
  assert.equal((await send(route, 'DELETE', undefined, { 'X-Studio-Token': '' })).status, 403);
  assert.equal((await send(route + '/restore', 'POST', {}, { 'X-Studio-Token': '' })).status, 403);
  assert.equal((await send(route, 'DELETE', undefined, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await send('/api/projects/' + other.id + '/assets/' + asset.id, 'DELETE')).status, 404);
  assert.equal((await send('/api/projects/' + other.id + '/assets/' + asset.id + '/restore', 'POST', {})).status, 404);
  assert.equal((await send('/api/projects/' + project.id + '/assets/missing', 'DELETE')).status, 404);
  assert.equal((await send('/api/projects/missing/assets/' + asset.id, 'DELETE')).status, 404);
  const removedResponse = await send(route, 'DELETE'); assert.equal(removedResponse.status, 200);
  const removed = await removedResponse.json();
  assert.ok(removed.assets.find(item => item.id === asset.id).deletedAt);
  assert.equal(removed.scenes[0].references.some(item => item.assetId === asset.id), false);
  assert.deepEqual(Buffer.from(await (await send('/api/assets/' + asset.id)).arrayBuffer()), png);
  const ranged = await send('/api/assets/' + asset.id, 'GET', undefined, { Range: 'bytes=0-7' });
  assert.equal(ranged.status, 206); assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), png.subarray(0, 8));
  assert.deepEqual(app.store.state.jobs, initialJobs, '不得取消、删除或重复提交平台任务');
  await send('/api/projects/' + project.id + '/assets/music', 'DELETE');
  const invalidAudio = await send('/api/projects/' + project.id + '/compose', 'POST', { audioAssetId: 'music' });
  assert.equal(invalidAudio.status, 400); assert.match((await invalidAudio.json()).error, /背景音乐/);
  assert.equal(app.store.get(project.id).exports.length, 0, '无效素材必须在创建合成任务前被拒绝');
  await send('/api/projects/' + project.id + '/assets/result', 'DELETE');
  assert.ok(app.store.get(project.id).scenes.every(scene => !scene.videoAssetId));
  assert.equal((await send('/api/projects/' + project.id + '/compose', 'POST', {})).status, 400);
  assert.equal(await readFile(path.join(root, 'assets', 'result.mp4'), 'utf8'), 'retained video file');
  assert.equal(await readFile(path.join(root, 'assets', 'music.wav'), 'utf8'), 'retained audio file');
  assert.deepEqual(app.store.state.jobs, initialJobs);
  await app.close(); app = await createStudio(options); url = await app.start(0);
  bootstrap = await (await fetch(url + '/api/bootstrap')).json();
  const persisted = await (await send('/api/projects/' + project.id)).json();
  assert.ok(persisted.assets.find(item => item.id === asset.id).deletedAt);
  assert.ok(persisted.scenes.every(scene => !scene.videoAssetId));
  assert.equal(app.store.state.jobs.find(job => job.id === 'accepted-job').providerTaskId, 'provider-running');
  const restoredResponse = await send(route + '/restore', 'POST', {}); assert.equal(restoredResponse.status, 200);
  const restored = await restoredResponse.json();
  assert.equal(restored.assets.find(item => item.id === asset.id).deletedAt, null);
  assert.equal(restored.scenes[0].references.some(item => item.assetId === asset.id), false);
  assert.deepEqual(Buffer.from(await (await send('/api/assets/' + asset.id)).arrayBuffer()), png);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'projects.json'), 'utf8')).projects
    .find(item => item.id === project.id).assets.find(item => item.id === asset.id).deletedAt, null);
});

test('COS 准备素材会拒绝已删除文件，即使旧任务中已有公网链接也不会绕过检查', async t => {
  const root = await temporaryRoot(t, 'jingce-assets-storage-'), store = new Store(root); await store.init();
  const project = setAssetDeleted(referenceProject(), 'portrait', true);
  await store.mutate(state => { state.projects.push(project); });
  let requests = 0;
  const storage = new CosStorage(root, store, { requestImpl: () => { requests++; throw new Error('不得访问云存储'); } });
  await storage.saveSettings(storageConfigForTests());
  for (const publicUrl of ['', 'https://cdn.example.org/person.png']) {
    await assert.rejects(storage.prepareReferences({ projectId: project.id,
      references: [{ assetId: 'portrait', kind: 'image', publicUrl }] }), /参考素材已删除/);
  }
  assert.equal(requests, 0);
  await store.update(project.id, current => setAssetDeleted(current, 'portrait', false));
  const job = { projectId: project.id, references: [{ assetId: 'portrait', kind: 'image', publicUrl: 'https://cdn.example.org/person.png' }] };
  assert.deepEqual(await storage.prepareReferences(job), job.references);
});

test('成片入口拒绝已删除的视频和音乐，恢复后允许重新选用', async () => {
  const project = referenceProject(), deletedVideo = structuredClone(project), deletedAudio = structuredClone(project);
  deletedVideo.assets.find(item => item.id === 'result').deletedAt = new Date().toISOString();
  deletedAudio.assets.find(item => item.id === 'music').deletedAt = new Date().toISOString();
  assert.throws(() => compositionClips(deletedVideo), /尚未选择用于成片的素材/);
  assert.throws(() => compositionAudio(deletedAudio, 'music'), /背景音乐/);
  assert.throws(() => compositionAudio(project, 'portrait'), /背景音乐/);
  assert.equal(compositionAudio(project), null);
  await assert.rejects(compose(deletedAudio, 'unused', 'no-export', 'music'), /背景音乐/);
  deletedVideo.assets.find(item => item.id === 'result').deletedAt = null;
  assert.equal(compositionClips(deletedVideo).length, 2);
  assert.equal(compositionAudio(project, 'music').id, 'music');
});
