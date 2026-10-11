import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../server.mjs';
import { VIDEO_REQUEST_MODE as CURRENT_VIDEO_REQUEST_MODE, LEGACY_VIDEO_REQUEST_MODE as VIDEO_REQUEST_MODE, submitVideo } from '../lib/providers.mjs';

test('本地 HTTP：保护密钥、拒绝跨站修改、保存冲突、上传下载与 Range', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-http-'));
  const app = await createStudio({ root, catalog: [], tools: { ready: false, message: '未安装合成工具' } });
  const url = await app.start(0);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
  const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token };
  const send = (route, method = 'GET', body, extra = {}) => fetch(url + route, { method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await fetch(`${url}/app.js`)).status, 200);
  assert.equal((await fetch(`${url}/video-parameters.js`)).status, 200);
  assert.equal((await fetch(`${url}/style.css`)).status, 200);
  const repeat = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))],
    { windowsHide: true, timeout: 5000, env: { ...process.env, JINGCE_PORT: String(app.server.address().port) } });
  assert.match(repeat.stdout, /已经启动/);
  assert.equal((await fetch(`${url}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await send('/api/projects', 'POST', {}, { Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await send('/api/projects', 'POST', {}, { 'X-Studio-Token': 'é'.repeat(64) })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = request(`${url}/api/bootstrap`, { headers: { Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostStatus, 403);
  await send('/api/settings', 'PUT', { apiKey: 'test-hidden-key', videoModel: 'model-a', resolution: '720p' });
  const publicText = await (await send('/api/bootstrap')).text();
  assert.doesNotMatch(publicText, /test-hidden-key/);
  assert.match(await readFile(path.join(root, 'connection.private.json'), 'utf8'), /test-hidden-key/);
  const storageResponse = await send('/api/storage/settings', 'PUT', { bucket: 'jingce-example-1250000000', region: 'ap-guangzhou',
    prefix: 'jingce', enabled: false, expiresHours: 72, secretId: 'COS-ID-HIDDEN', secretKey: 'COS-KEY-HIDDEN' });
  assert.equal(storageResponse.status, 200);
  assert.doesNotMatch(await storageResponse.text(), /COS-ID-HIDDEN|COS-KEY-HIDDEN/);
  const storageBootstrap = await (await send('/api/bootstrap')).text();
  assert.match(storageBootstrap, /jingce-example-1250000000/);
  assert.doesNotMatch(storageBootstrap, /COS-ID-HIDDEN|COS-KEY-HIDDEN/);
  assert.match(await readFile(path.join(root, 'storage.private.json'), 'utf8'), /COS-ID-HIDDEN|COS-KEY-HIDDEN/);
  for (const route of ['/runtime/connection.private.json', '/runtime/projects.json', '/connection.private.json', '/lib/store.mjs', '/assets/test.mp4', '/%2e%2e/runtime/connection.private.json']) assert.equal((await send(route)).status, 404, route);
  const project = await (await send('/api/projects', 'POST', { title: '验证工程', brief: { product: '雨夜' } })).json();
  assert.equal((await send(`/api/projects/${project.id}`, 'PATCH', { revision: 0, title: 'conflict' })).status, 409);
  const planned = await (await send(`/api/projects/${project.id}/plan`, 'POST', {})).json();
  assert.ok(planned.scenes.length);
  await app.store.mutate(state => {
    state.jobs.push({ id: 'secret-job', projectId: project.id, sceneId: planned.scenes[0].id, state: 'done',
      references: [{ kind: 'image', publicUrl: 'https://cdn.example.org/COS-ID-HIDDEN' }], message: '已保存' });
    const projectRecord = state.projects.find(item => item.id === project.id);
    projectRecord.scenes[0].references = [{ kind: 'image', assetId: '', name: '测试参考', publicUrl: 'https://cdn.example.org/COS-ID-HIDDEN' }];
    return state;
  });
  const publicJobs = await (await send(`/api/projects/${project.id}/jobs`)).text();
  assert.doesNotMatch(publicJobs, /COS-ID-HIDDEN|COS-KEY-HIDDEN/);
  await app.store.mutate(state => { state.jobs = state.jobs.filter(job => job.id !== 'secret-job'); return state; });
  const bytes = Buffer.alloc(128); bytes.write('ftyp', 4, 'ascii');
  const upload = await fetch(`${url}/api/projects/${project.id}/assets`, { method: 'POST', headers: { 'X-Studio-Token': bootstrap.token, 'X-File-Name': encodeURIComponent('片段.mp4') }, body: bytes });
  assert.equal(upload.status, 201); const { asset } = await upload.json();
  const partial = await fetch(`${url}/api/assets/${asset.id}`, { headers: { Range: 'bytes=4-7' } });
  assert.equal(partial.status, 206); assert.equal(await partial.text(), 'ftyp');
  assert.equal(partial.headers.get('content-range'), 'bytes 4-7/128');
  assert.equal((await fetch(`${url}/api/assets/${asset.id}`, { headers: { Range: 'bytes=500-600' } })).status, 416);
  assert.equal((await fetch(`${url}/api/assets/${asset.id}`, { method: 'HEAD' })).headers.get('content-length'), '128');
  const exported = await (await send(`/api/projects/${project.id}/export`)).json();
  assert.equal(exported.project.assets, undefined);
  assert.doesNotMatch(JSON.stringify(exported), /COS-ID-HIDDEN|COS-KEY-HIDDEN/);
  const imported = await send('/api/projects/import', 'POST', exported); assert.equal(imported.status, 201);
  assert.equal((await send(`/api/projects/${project.id}/compose`, 'POST', {})).status, 400);
  const invalid = await fetch(`${url}/api/projects/${project.id}/assets`, { method: 'POST', headers: { 'X-Studio-Token': bootstrap.token }, body: Buffer.from('not a media file') });
  assert.equal(invalid.status, 400);
  await app.store.mutate(state => state.jobs.push({ id: 'job-delete-test', projectId: project.id,
    sceneId: planned.scenes[0].id, state: 'done', providerTaskId: 'provider-kept', assetId: asset.id,
    resultUrl: 'https://cdn.example.org/result?signature=private', message: '已完成' }));
  assert.equal((await fetch(`${url}/api/jobs/job-delete-test`, { method: 'DELETE' })).status, 403);
  assert.equal((await send('/api/jobs/job-delete-test', 'DELETE', undefined, { Origin: 'https://attacker.invalid' })).status, 403);
  const removed = await send('/api/jobs/job-delete-test', 'DELETE'); assert.equal(removed.status, 200);
  const removedText = await removed.text(); assert.doesNotMatch(removedText, /signature|resultUrl|test-hidden-key/);
  assert.equal((await (await send(`/api/projects/${project.id}/jobs`)).json()).length, 0);
  const deleted = await (await send(`/api/projects/${project.id}/jobs?includeDeleted=1`)).json();
  assert.equal(deleted.length, 1); assert.ok(deleted[0].deletedAt); assert.equal(deleted[0].providerTaskId, 'provider-kept');
  assert.equal((await fetch(`${url}/api/assets/${asset.id}`)).status, 200);
  assert.equal((await send('/api/jobs/job-delete-test/restore', 'POST', {})).status, 200);
  assert.equal((await (await send(`/api/projects/${project.id}/jobs`)).json()).length, 1);
  assert.equal((await send('/api/jobs/not-found', 'DELETE')).status, 404);
});

test('HTTP 保存所选秒数、计算对应报价并传给平台，非法档位不提交', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-duration-'));
  let submissions = 0, body;
  const app = await createStudio({ root, tools: { ready: false }, catalog: [
    { name: 'model-a', defaultDuration: 5, defaultResolution: '720p', tiers: [
      { duration: 5, resolution: '720p', price: 1 }, { duration: 15, resolution: '720p', price: 3 },
    ] },
  ], integrations: { submit: (settings, job, image) => submitVideo(settings, job, image, async (_url, options) => {
    submissions++; body = JSON.parse(options.body);
    return new Response(JSON.stringify({ task_id: 'duration-15', status: 'queued' }));
  }) } });
  const url = await app.start(0);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
  assert.equal(bootstrap.settings.videoRequestMode, CURRENT_VIDEO_REQUEST_MODE);
  const send = (route, method, body) => fetch(url + route, { method,
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token }, body: JSON.stringify(body) });
  await send('/api/settings', 'PUT', { apiKey: 'test-duration-key', videoModel: 'model-a' });
  const project = await (await send('/api/projects', 'POST', { title: '选择秒数' })).json();
  const scenes = [{ id: 'scene-duration', duration: 3.5, generationDuration: 15, videoPrompt: '原创长镜头' }];
  const saved = await (await send(`/api/projects/${project.id}`, 'PATCH', { revision: project.revision, scenes })).json();
  assert.equal(saved.scenes[0].generationDuration, 15);
  assert.equal((await send(`/api/projects/${project.id}/jobs`, 'POST', {
    sceneId: 'scene-duration', model: 'model-a', duration: 12, requestMode: VIDEO_REQUEST_MODE,
  })).status, 400);
  assert.equal(submissions, 0);
  const response = await send(`/api/projects/${project.id}/jobs`, 'POST', {
    sceneId: 'scene-duration', model: 'model-a', duration: 15, requestMode: VIDEO_REQUEST_MODE, operationId: 'selected-15',
  });
  assert.equal(response.status, 202); const job = await response.json();
  assert.equal(job.duration, 15); assert.equal(job.estimate, 3);
  for (let i = 0; i < 50 && app.jobs.busy.size; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(submissions, 1); assert.deepEqual(body, { model: 'model-a', prompt: '原创长镜头', duration: 15 });
  assert.equal(app.store.get(project.id).scenes[0].duration, 3.5);
  const persisted = JSON.parse(await readFile(path.join(root, 'projects.json'), 'utf8'));
  assert.equal(persisted.jobs[0].duration, 15); assert.equal(persisted.jobs[0].estimate, 3);
  assert.equal(persisted.projects[0].scenes[0].generationDuration, 15);
});

test('HTTP 多参考准备：两图两视频保存并恢复，省略参考参数也不能误提交收费任务', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-references-'));
  let submissions = 0, app;
  const config = { root, catalog: [{ name: 'model-a', defaultDuration: 5, defaultResolution: '720p',
    tiers: [{ duration: 5, resolution: '720p', price: 1 }] }], tools: { ready: false },
    integrations: { submit: async () => { submissions++; return { taskId: 'must-not-submit', state: 'queued' }; } } };
  t.after(async () => { if (app) await app.close(); await rm(root, { recursive: true, force: true }); });
  app = await createStudio(config); let url = await app.start(0);
  let bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
  const send = (route, method, body) => fetch(url + route, { method, headers: {
    'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token }, body: JSON.stringify(body) });
  await send('/api/settings', 'PUT', { apiKey: 'test-reference-key', videoModel: 'model-a' });
  const project = await (await send('/api/projects', 'POST', { brief: { product: '多参考验证' } })).json();
  let planned = await (await send(`/api/projects/${project.id}/plan`, 'POST', {})).json();
  const references = [];
  for (const [name, kind, note] of [['人物.png', 'image', '人物外观'], ['街景.png', 'image', '场景'],
    ['运镜.mp4', 'video', '缓慢推近'], ['动作.mp4', 'video', '主体动作']]) {
    const bytes = Buffer.alloc(128);
    if (kind === 'image') Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    else bytes.write('ftyp', 4, 'ascii');
    const response = await fetch(`${url}/api/projects/${project.id}/assets`, { method: 'POST',
      headers: { 'X-Studio-Token': bootstrap.token, 'X-File-Name': encodeURIComponent(name) }, body: bytes });
    assert.equal(response.status, 201);
    const result = await response.json(); planned = result.project;
    references.push({ assetId: result.asset.id, kind, name, note });
  }
  planned.scenes[0].references = references;
  const response = await send(`/api/projects/${project.id}`, 'PATCH', { revision: planned.revision, scenes: planned.scenes });
  assert.equal(response.status, 200); const saved = await response.json();
  const savedReferences = saved.scenes[0].references;
  assert.deepEqual(savedReferences.map(({ refId, ...reference }) => reference), references);
  assert.ok(savedReferences.every(reference => typeof reference.refId === 'string' && reference.refId.trim()), '每份参考素材都必须有非空引用 ID');
  assert.equal(new Set(savedReferences.map(reference => reference.refId)).size, references.length, '引用 ID 不得重复');
  const rejected = await send(`/api/projects/${project.id}/jobs`, 'POST', {
    sceneId: saved.scenes[0].id, requestMode: VIDEO_REQUEST_MODE, operationId: 'no-billing' });
  assert.equal(rejected.status, 400); assert.match((await rejected.json()).error, /多参考生成/);
  assert.equal(app.store.state.jobs.length, 0); assert.equal(submissions, 0);
  const exported = await (await fetch(`${url}/api/projects/${project.id}/export`)).json();
  assert.deepEqual(exported.project.scenes[0].references.map(item => item.note), references.map(item => item.note));
  assert.ok(exported.project.scenes[0].references.every(item => !item.assetId));
  assert.deepEqual(exported.project.scenes[0].references.map(item => item.refId), savedReferences.map(item => item.refId));
  await app.close(); app = null;
  app = await createStudio(config); url = await app.start(0);
  bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
  const recovered = await (await fetch(`${url}/api/projects/${project.id}`)).json();
  assert.deepEqual(recovered.scenes[0].references, savedReferences);
  assert.equal(recovered.assets.length, 4); assert.equal(submissions, 0);
  assert.equal(bootstrap.settings.referenceGenerationReady, true);
  assert.equal(bootstrap.settings.referenceUrlRequired, true);
  assert.doesNotMatch(JSON.stringify(bootstrap), /test-reference-key/);
});
