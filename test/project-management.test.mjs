import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { createProject, touch } from '../lib/workflow.mjs';
import { createStudio } from '../server.mjs';

async function temporaryRoot(t) {
  const parent = path.resolve(os.tmpdir()), root = await mkdtemp(path.join(parent, 'jingce-project-delete-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith('jingce-project-delete-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
async function studio(t, integrations = {}) {
  const root = await temporaryRoot(t);
  const app = await createStudio({ root, catalog: [], tools: { ready: false }, integrations });
  const base = await app.start(0);
  t.after(() => app.close());
  const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token };
  const send = (route, method = 'GET', body, extra = {}) => fetch(base + route, { method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const project = await (await send('/api/projects', 'POST', { title: '需要删除的项目', brief: { product: '雨夜' } })).json();
  return { app, root, base, send, project };
}
const expectGone = filename => assert.rejects(readFile(filename), { code: 'ENOENT' });

test('项目软删除保持内容、文件和任务，恢复和重新启动后仍一致', async t => {
  const root = await temporaryRoot(t), store = new Store(root); await store.init();
  const project = createProject({ title: '保留全部内容' });
  project.assets.push({ id: 'material', kind: 'image', file: 'material.png', name: '图片' });
  const job = { id: 'accepted', projectId: project.id, state: 'queued', providerTaskId: 'existing-platform-id', deletedAt: '2026-10-07T00:00:00Z' };
  await writeFile(path.join(root, 'assets/material.png'), 'keep');
  await store.mutate(state => { state.projects.push(project); state.jobs.push(job); });
  const deleted = await store.setDeleted(project.id, true);
  assert.ok(deleted.deletedAt); assert.equal(deleted.revision, project.revision + 1);
  assert.equal(store.list().length, 0); assert.equal(store.list(true).length, 1);
  assert.throws(() => store.get(project.id), error => error.status === 410);
  assert.deepEqual(store.get(project.id, true).assets, project.assets);
  assert.deepEqual(store.state.jobs, [job]);
  assert.equal((await store.setDeleted(project.id, true)).revision, deleted.revision);
  await assert.rejects(store.update(project.id, current => { current.title = '不可编辑'; return touch(current); }), error => error.status === 410);
  const restarted = new Store(root); await restarted.init();
  assert.equal(restarted.list().length, 0); assert.equal(restarted.get(project.id, true).deletedAt, deleted.deletedAt);
  const restored = await restarted.setDeleted(project.id, false);
  assert.equal(restored.deletedAt, null); assert.equal(restored.title, project.title);
  assert.equal(restarted.list().length, 1); assert.deepEqual(restarted.state.jobs, [job]);
  assert.equal(await readFile(path.join(root, 'assets/material.png'), 'utf8'), 'keep');
});

test('项目删除/恢复 API 有鉴权，普通列表隐藏已删除工程并拒绝继续编辑或生成', async t => {
  const { app, base, send, project } = await studio(t);
  await app.store.saveSettings({ apiKey: 'fake-local-only' });
  assert.equal((await fetch(`${base}/api/projects/${project.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await send(`/api/projects/${project.id}`, 'DELETE', undefined, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await send(`/api/projects/${project.id}`, 'DELETE')).status, 200);
  assert.deepEqual(await (await send('/api/projects')).json(), []);
  assert.equal((await (await send('/api/projects?includeDeleted=1')).json()).length, 1);
  const bootstrap = await (await send('/api/bootstrap')).json();
  assert.equal(bootstrap.projects.length, 0); assert.equal(bootstrap.deletedProjects[0].id, project.id);
  assert.equal((await send(`/api/projects/${project.id}`)).status, 410);
  assert.equal((await send(`/api/projects/${project.id}?includeDeleted=1`)).status, 200);
  for (const [suffix, method, input] of [['', 'PATCH', { revision: project.revision, title: '不应复活' }], ['/plan', 'POST', {}], ['/batches', 'POST', {}], ['/jobs', 'POST', {}], ['/compose', 'POST', {}]]) {
    assert.equal((await send(`/api/projects/${project.id}${suffix}`, method, input)).status, 410, suffix);
  }
  const upload = await fetch(`${base}/api/projects/${project.id}/assets`, { method: 'POST', headers: { 'X-Studio-Token': bootstrap.token, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(64) });
  assert.equal(upload.status, 410);
  assert.equal((await fetch(`${base}/api/projects/${project.id}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await send(`/api/projects/${project.id}/restore`, 'POST', {})).status, 200);
  assert.equal((await send(`/api/projects/${project.id}`)).status, 200);
  assert.equal((await (await send('/api/projects')).json()).length, 1);
});

test('软删除期间继续保存已受理的视频，恢复后能访问结果且不会重复提交', async t => {
  let submissions = 0, polls = 0;
  const bytes = Buffer.alloc(64); bytes.write('ftyp', 4);
  const { app, send, project, root, base } = await studio(t, {
    submit: async () => { submissions++; throw new Error('no paid submission'); },
    poll: async () => { polls++; return { state: 'completed', taskId: 'accepted-id', url: 'https://test.invalid/already-generated.mp4' }; },
    download: async (_url, filename) => { await writeFile(filename, bytes); return bytes.length; },
  });
  const job = { id: 'existing-job', projectId: project.id, sceneId: '', state: 'running', providerTaskId: 'accepted-id', createdAt: new Date().toISOString(), model: 'fake-model', duration: 5, resolution: '720p' };
  await app.store.mutate(state => { state.jobs.push(job); });
  await send(`/api/projects/${project.id}`, 'DELETE');
  assert.equal((await send(`/api/projects/${project.id}/permanent`, 'DELETE')).status, 409);
  await app.jobs.refresh(job);
  assert.equal(submissions, 0); assert.equal(polls, 1);
  assert.equal(app.store.state.jobs[0].state, 'done');
  const deleted = app.store.get(project.id, true);
  assert.ok(deleted.deletedAt); assert.equal(deleted.assets.length, 1);
  assert.deepEqual(await readFile(path.join(root, 'assets', deleted.assets[0].file)), bytes);
  await send(`/api/projects/${project.id}/restore`, 'POST', {});
  const restored = await (await send(`/api/projects/${project.id}`)).json();
  assert.equal(restored.assets[0].id, deleted.assets[0].id);
  const media = await fetch(`${base}/api/assets/${restored.assets[0].id}`);
  assert.equal(media.status, 200); assert.deepEqual(Buffer.from(await media.arrayBuffer()), bytes);
});

test('彻底删除清除项目专用文件与任务，保留其他项目、共享文件和本机配置', async t => {
  const { app, send, project, root } = await studio(t);
  const other = createProject({ title: '保留的项目' });
  const assets = [{ id: 'one', file: 'exclusive.mp4' }, { id: 'shared', file: 'shared.png' }, { id: 'deleted', file: 'previously-deleted.png', deletedAt: new Date().toISOString() }];
  await app.store.update(project.id, current => { current.assets = assets; current.exports = [{ id: 'export', state: 'done', file: 'finished.mp4' }]; return touch(current); });
  other.assets.push({ id: 'other-shared', file: 'shared.png' });
  await app.store.mutate(state => { state.projects.push(other); state.jobs.push({ id: 'terminal', projectId: project.id, state: 'done' }, { id: 'other-job', projectId: other.id, state: 'failed' }); });
  for (const file of ['exclusive.mp4', 'shared.png', 'previously-deleted.png']) await writeFile(path.join(root, 'assets', file), file);
  await writeFile(path.join(root, 'exports/finished.mp4'), 'finished');
  assert.equal((await send(`/api/projects/${project.id}/permanent`, 'DELETE')).status, 409);
  await send(`/api/projects/${project.id}`, 'DELETE');
  const purge = await send(`/api/projects/${project.id}/permanent`, 'DELETE');
  assert.equal(purge.status, 200); assert.equal((await purge.json()).cleanupPending, 0);
  assert.equal((await send(`/api/projects/${project.id}?includeDeleted=1`)).status, 404);
  assert.equal((await send(`/api/projects/${project.id}/restore`, 'POST', {})).status, 404);
  assert.equal(app.store.list(true).length, 1); assert.equal(app.store.list()[0].id, other.id);
  assert.deepEqual(app.store.state.jobs.map(job => job.id), ['other-job']);
  for (const file of ['exclusive.mp4', 'previously-deleted.png']) await expectGone(path.join(root, 'assets', file));
  await expectGone(path.join(root, 'exports/finished.mp4'));
  assert.equal(await readFile(path.join(root, 'assets/shared.png'), 'utf8'), 'shared.png');
  assert.ok(await readFile(path.join(root, 'connection.private.json'), 'utf8'));
  const restarted = new Store(root); await restarted.init();
  assert.throws(() => restarted.get(project.id, true), error => error.status === 404);
});

test('彻底删除阻止所有未完成或需核对的任务、未结束的后台回调和合成', async t => {
  const { app, send, project } = await studio(t);
  await send(`/api/projects/${project.id}`, 'DELETE');
  for (const stateName of ['preparing', 'waiting', 'submitting', 'queued', 'running', 'downloading', 'download_pending', 'uncertain', 'attention']) {
    await app.store.mutate(state => { state.jobs = [{ id: 'pending', projectId: project.id, state: stateName, deletedAt: 'hidden-record' }]; });
    assert.equal((await send(`/api/projects/${project.id}/permanent`, 'DELETE')).status, 409, stateName);
    assert.ok(app.store.get(project.id, true));
  }
  await app.store.mutate(state => { state.jobs[0].state = 'done'; });
  app.jobs.busy.add('pending');
  assert.equal((await send(`/api/projects/${project.id}/permanent`, 'DELETE')).status, 409);
  app.jobs.busy.clear();
  await app.store.update(project.id, current => { current.exports.push({ id: 'busy-export', state: 'running' }); return touch(current); }, true);
  assert.equal((await send(`/api/projects/${project.id}/permanent`, 'DELETE')).status, 409);
  await app.store.update(project.id, current => { current.exports[0].state = 'failed'; return touch(current); }, true);
  assert.equal((await send(`/api/projects/${project.id}/permanent`, 'DELETE')).status, 200);
});

test('文件清理重启可重试，拒绝路径越界且不删除其他项目使用的文件', async t => {
  const root = await temporaryRoot(t), store = new Store(root); await store.init();
  await writeFile(path.join(root, 'outside.txt'), 'must stay');
  await writeFile(path.join(root, 'assets/orphan.png'), 'delete after restart');
  await writeFile(path.join(root, 'assets/shared.png'), 'keep shared');
  await mkdir(path.join(root, 'assets/occupied.png'));
  const project = createProject(); project.assets.push({ id: 'shared', file: 'shared.png' });
  await store.mutate(state => {
    state.projects.push(project);
    state.pendingFileDeletes = [
      { directory: 'assets', file: 'orphan.png' }, { directory: 'assets', file: 'shared.png' },
      { directory: 'assets', file: '../outside.txt' }, { directory: 'assets', file: '..\\outside.txt' },
      { directory: '../', file: 'outside.txt' }, { directory: 'assets', file: 'occupied.png' },
    ];
  });
  const restarted = new Store(root); await restarted.init();
  await expectGone(path.join(root, 'assets/orphan.png'));
  assert.equal(await readFile(path.join(root, 'outside.txt'), 'utf8'), 'must stay');
  assert.equal(await readFile(path.join(root, 'assets/shared.png'), 'utf8'), 'keep shared');
  assert.deepEqual(restarted.state.pendingFileDeletes, [{ directory: 'assets', file: 'occupied.png' }]);
});
