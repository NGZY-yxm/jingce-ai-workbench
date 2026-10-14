import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultPrevisSpec, parsePrevisSpec, normalizePrevisSpec, previsDimensions } from '../public/previs-spec.js';
import { PrevisJobs, previsArtifacts } from '../lib/previs.mjs';
import { Store } from '../lib/store.mjs';
import { createProject } from '../lib/workflow.mjs';
import { createStudio } from '../server.mjs';
import { createBlenderHelper } from '../tools/blender-helper.mjs';

const tools = { ready: true, blender: { ready: true, path: 'blender', version: 'Blender test', message: '可用' }, ffmpeg: { ready: true, path: 'ffmpeg', encoder: 'libx264', message: '可用' } };
function tinySpec() {
  const spec = defaultPrevisSpec(); const scale = 1 / spec.duration; spec.duration = 1; spec.fps = 12;
  for (const item of [...spec.actors, spec.camera]) item.keys.forEach(key => key.time *= scale);
  spec.beats.forEach(beat => beat.time *= scale); return normalizePrevisSpec(spec);
}
export async function fixtureRender(folder, spec, _tools, { progress }) {
  const dimensions = previsDimensions(spec), png = Buffer.alloc(32); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(dimensions.width, 16); png.writeUInt32BE(dimensions.height, 20);
  const mp4 = Buffer.alloc(128); mp4.write('ftyp', 4);
  await mkdir(path.join(folder, 'frames'), { recursive: true });
  for (const artifact of previsArtifacts(spec).filter(item => !['spec', 'prompt'].includes(item.key))) await writeFile(path.join(folder, artifact.file), artifact.key === 'blend' ? Buffer.from('BLENDER-test-scene') : artifact.key === 'video' ? mp4 : png);
  await progress('rendering', .6, '固定测试渲染');
  return { ...dimensions, frames: spec.duration * spec.fps, decodedFrames: spec.duration * spec.fps, fps: spec.fps, duration: spec.duration, decodedDuration: spec.duration, verifiedAt: new Date().toISOString() };
}
async function settled(jobs, id) {
  for (let i = 0; i < 200; i++) { const job = jobs.get(id); if (['done', 'failed', 'cancelled'].includes(job.state)) return job; await delay(10); }
  throw new Error('预演测试超时');
}
async function storeFixture(t, render = fixtureRender) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-previs-')); const store = new Store(root); await store.init();
  const project = createProject({ title: '通用预演验证' }); await store.mutate(state => state.projects.push(project));
  const jobs = new PrevisJobs(store, { detectTools: async () => tools, render }); await jobs.init();
  t.after(async () => { await jobs.close(); await rm(root, { recursive: true, force: true }); }); return { root, store, jobs, project };
}

test('场景数据支持多场景，拒绝代码、重复 id、错误数值和同帧关键点', () => {
  const spec = tinySpec(); assert.equal(parsePrevisSpec('```json\n' + JSON.stringify(spec) + '\n```').camera.keys.length, 3);
  const cases = [value => { value.script = 'import os'; }, value => { value.objects[0].id = value.actors[0].id; },
    value => { value.camera.keys[1].time = .001; }, value => { value.camera.keys[0].target = value.camera.keys[0].position; },
    value => { value.objects[0].size[0] = -1; }, value => { value.duration = 31; }, value => { value.actors[0].keys.at(-1).time = .9; }];
  for (const change of cases) { const value = structuredClone(spec); change(value); assert.throws(() => normalizePrevisSpec(value)); }
  const street = structuredClone(spec); street.name = '雨夜街道'; street.world.size = [40, 20]; street.actors[0].shape = 'box';
  assert.equal(normalizePrevisSpec(street).name, '雨夜街道');
});

test('重复提交返回原任务和规格，输出只登记一次，预演文件随工程彻底删除', async t => {
  const { jobs, store, project, root } = await storeFixture(t); const spec = tinySpec();
  const [first, again] = await Promise.all([jobs.start(project.id, { operationId: 'same-op', spec }), jobs.start(project.id, { operationId: 'same-op', spec })]);
  assert.equal(first.id, again.id); const done = await settled(jobs, first.id); assert.equal(done.state, 'done', done.message);
  const repeated = await jobs.start(project.id, { operationId: 'same-op', spec: { ...spec, name: '修改不影响原任务' } });
  assert.equal(repeated.spec.name, spec.name);
  const count = store.get(project.id).assets.length; assert.ok(count >= 5); assert.equal(store.get(project.id).assets.find(item => item.kind === 'video').source, 'previs');
  await jobs.publish(done.id, done.report); assert.equal(store.get(project.id).assets.length, count);
  await store.setDeleted(project.id, true); await store.permanentlyDelete(project.id);
  assert.equal(store.state.previsJobs.length, 0); await assert.rejects(stat(jobs.folder(done.id)), { code: 'ENOENT' });
  assert.equal((await readFile(path.join(root, 'projects.json'), 'utf8')).includes(done.id), false);
});

test('失败重试保留编号与参数，串行任务可取消且阻止提前彻底删除', async t => {
  let attempts = 0;
  const { jobs, store, project } = await storeFixture(t, async (...args) => { if (++attempts === 1) throw new Error('受控渲染失败'); return fixtureRender(...args); });
  const job = await jobs.start(project.id, { operationId: 'retry-op', spec: tinySpec() }); assert.equal((await settled(jobs, job.id)).state, 'failed');
  await delay(10); const retried = await jobs.retry(job.id); assert.equal(retried.id, job.id); assert.equal(retried.attempts, 2); assert.equal((await settled(jobs, job.id)).state, 'done');
  const external = await jobs.start(project.id, { mode: 'helper', operationId: 'external-op', spec: tinySpec() });
  await store.setDeleted(project.id, true); await assert.rejects(store.permanentlyDelete(project.id), /Blender 预演/);
  await jobs.cancel(external.id); await store.permanentlyDelete(project.id);
});

test('外部预演验证报告和文件必须匹配规格，保留并恢复助手任务', async t => {
  const { jobs, store, project } = await storeFixture(t); const spec = tinySpec();
  const job = await jobs.start(project.id, { mode: 'helper', operationId: 'helper-op', spec });
  const localJobId = randomUUID(); const report = await fixtureRender(jobs.folder(job.id), spec, tools, { progress: async () => {} });
  await jobs.syncExternal(job.id, { localJobId, state: 'done', progress: 1, report });
  await assert.rejects(jobs.publish(job.id, { ...report, decodedFrames: 1 }), /验证报告/);
  const restart = new PrevisJobs(store, { detectTools: async () => tools }); await restart.init(); assert.equal(restart.get(job.id).state, 'saving');
  const done = await jobs.publish(job.id, report); assert.equal(done.state, 'done'); assert.equal(done.localJobId, localJobId);
});

test('取消渲染后迟到的进度不能恢复任务或登记输出', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { jobs, store, project } = await storeFixture(t, async (...args) => {
    const report = await fixtureRender(...args); await gate;
    await args[3].progress('rendering', .9, '取消后迟到的进度'); return report;
  });
  try {
    const job = await jobs.start(project.id, { operationId: 'cancel-render', spec: tinySpec() });
    for (let attempt = 0; attempt < 100 && jobs.get(job.id).state !== 'rendering'; attempt++) await delay(10);
    assert.equal(jobs.get(job.id).state, 'rendering');
    await jobs.cancel(job.id); release();
    for (let attempt = 0; attempt < 100 && jobs.busy.has(job.id); attempt++) await delay(10);
    assert.equal(jobs.get(job.id).state, 'cancelled'); assert.equal(store.get(project.id).assets.length, 0);
    await assert.rejects(jobs.publish(job.id, {}), /取消/);
  } finally { release(); }
});

test('取消网站保存后可使用同一本机完成结果恢复，禁止直接发布已取消任务', async t => {
  const { jobs, store, project } = await storeFixture(t), spec = tinySpec();
  const job = await jobs.start(project.id, { mode: 'helper', operationId: 'cancel-upload', spec });
  const localJobId = randomUUID(), report = await fixtureRender(jobs.folder(job.id), spec, tools, { progress: async () => {} });
  await jobs.syncExternal(job.id, { localJobId, state: 'done', report }); await jobs.cancel(job.id);
  await assert.rejects(jobs.publish(job.id, report), /取消/); assert.equal(store.get(project.id).assets.length, 0);
  await jobs.retry(job.id); await jobs.syncExternal(job.id, { localJobId, state: 'done', report });
  assert.equal((await jobs.publish(job.id, report)).state, 'done'); assert.equal(jobs.get(job.id).localJobId, localJobId);
});

test('HTTP 提供预演入口、静态模块、下载、Range 和二进制上传，保留原任务', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-previs-http-'));
  await assert.rejects(createStudio({ root, publicOrigin: 'http://example.test' }), /HTTPS/);
  const publicOrigin = 'https://jingce.example.test';
  const thumbnailBytes = Buffer.from('89504e470d0a1a0a', 'hex');
  const app = await createStudio({ root, publicOrigin, catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false },
    previs: { detectTools: async () => tools, render: fixtureRender },
    thumbnails: { render: async (_source, destination) => writeFile(destination, thumbnailBytes) } });
  const url = await app.start(0); t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await (await fetch(url + '/api/bootstrap')).json();
  assert.equal((await fetch(url + '/api/bootstrap', { headers: { Origin: publicOrigin } })).status, 200);
  assert.equal((await fetch(url + '/api/bootstrap', { headers: { Origin: 'https://other.example.test' } })).status, 403);
  assert.equal((await fetch(url + '/api/previs/validate', { method: 'POST', headers: { Origin: publicOrigin, 'X-Studio-Token': bootstrap.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ spec: tinySpec() }) })).status, 200);
  assert.equal((await fetch(url + '/api/previs/tools', { headers: { Origin: publicOrigin } })).status, 403);
  const call = async (route, method = 'GET', body) => { const r = await fetch(url + route, { method, headers: { 'X-Studio-Token': bootstrap.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  for (const route of ['/previs.js', '/previs-spec.js', '/previs-revision.js', '/previs.css']) assert.equal((await fetch(url + route)).status, 200);
  const html = await fetch(url); assert.match(html.headers.get('content-security-policy'), /127\.0\.0\.1:18973/);
  assert.equal((await fetch(url + '/api/previs/helper.zip')).status, 200);
  const project = (await call('/api/projects', 'POST', { title: '预演 HTTP' })).data;
  const websiteStart = await fetch(url + `/api/projects/${project.id}/previs-jobs`, { method: 'POST', headers: { Origin: publicOrigin, 'X-Studio-Token': bootstrap.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: 'website-direct', spec: tinySpec() }) });
  assert.equal(websiteStart.status, 403);
  const job = (await call(`/api/projects/${project.id}/previs-jobs`, 'POST', { operationId: 'http-op', spec: tinySpec() })).data;
  assert.equal((await settled(app.previs, job.id)).state, 'done');
  assert.equal((await call(`/api/projects/${project.id}/previs-jobs`, 'POST', { operationId: 'http-op', spec: tinySpec() })).data.id, job.id);
  for (const key of ['video', 'overview']) {
    const thumb = await fetch(url + `/api/previs-jobs/${job.id}/artifacts/${key}?thumbnail=1`);
    assert.equal(thumb.status, 200); assert.match(thumb.headers.get('content-type'), /^image\/png/);
    assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), thumbnailBytes);
  }
  const video = await fetch(url + `/api/previs-jobs/${job.id}/artifacts/video`, { headers: { Range: 'bytes=4-7' } }); assert.equal(video.status, 206); assert.equal(await video.text(), 'ftyp');
  assert.equal((await fetch(url + `/api/previs-jobs/${job.id}/artifacts/../../projects.json`)).status, 404);
  const external = (await call(`/api/projects/${project.id}/previs-jobs`, 'POST', { mode: 'helper', operationId: 'upload-op', spec: tinySpec() })).data;
  const report = await fixtureRender(app.previs.folder(external.id), external.spec, tools, { progress: async () => {} });
  await call(`/api/previs-jobs/${external.id}/sync`, 'POST', { localJobId: randomUUID(), state: 'done', report });
  const bytes = await readFile(app.previs.artifact(external.id, 'video').filename);
  const upload = await fetch(url + `/api/previs-jobs/${external.id}/artifacts/video`, { method: 'POST', headers: { 'X-Studio-Token': bootstrap.token }, body: bytes }); assert.equal(upload.status, 200);
  assert.equal((await call(`/api/previs-jobs/${external.id}/complete`, 'POST', { report })).data.state, 'done');
});

test('网站助手限定回环 Host、站点授权、CORS 和令牌，允许授权 HTTPS 站点渲染', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-helper-'));
  const app = await createBlenderHelper({ root, previs: { detectTools: async () => tools, render: fixtureRender } }); const url = await app.start(0);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const origin = 'https://jingce.example.test', requestId = randomUUID();
  assert.equal((await fetch(url + '/api/previs/tools', { headers: { Origin: origin } })).status, 403);
  await fetch(url + `/?origin=${encodeURIComponent(origin)}&request=${requestId}`);
  const preflight = await fetch(url + `/api/bridge/session?request=${requestId}`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
  const bootstrap = await (await fetch(url + '/api/helper/bootstrap')).json();
  assert.equal((await fetch(url + '/api/helper/bootstrap', { headers: { Origin: origin } })).status, 403);
  await fetch(url + '/api/helper/approve', { method: 'POST', headers: { 'X-Jingce-Helper-Token': bootstrap.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ request: requestId }) });
  const session = await (await fetch(url + `/api/bridge/session?request=${requestId}`, { headers: { Origin: origin } })).json(); assert.equal(session.state, 'connected');
  const headers = { Origin: origin, 'X-Jingce-Helper-Token': session.token, 'Content-Type': 'application/json' };
  const response = await fetch(url + '/api/previs/jobs', { method: 'POST', headers, body: JSON.stringify({ projectId: 'website-project', operationId: 'website-op', spec: tinySpec() }) });
  assert.equal(response.headers.get('access-control-allow-origin'), origin); const job = await response.json(); assert.equal(response.status, 202, JSON.stringify(job));
  assert.equal((await settled(app.previs, job.id)).state, 'done');
  assert.equal((await fetch(url + `/api/previs/jobs/${job.id}/artifacts/video`, { headers })).status, 200);
  assert.equal((await fetch(url + `/api/previs/jobs/${job.id}`, { headers: { ...headers, Origin: 'https://another.example.test' } })).status, 403);
  assert.equal((await fetch(url + '/api/previs/tools', { headers: { ...headers, 'X-Jingce-Helper-Token': 'wrong' } })).status, 403);
  await fetch(url + '/api/helper/revoke', { method: 'POST', headers: { 'X-Jingce-Helper-Token': bootstrap.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ origin }) });
  assert.equal((await fetch(url + '/api/previs/tools', { headers })).status, 403);
});


test('预演子工程持久保存于当前创作工程，任务归属受限且保留旧任务和幂等编号', async t => {
  const { jobs, store, project, root } = await storeFixture(t);
  const other = createProject({ title: '另一创作工程' }); await store.mutate(state => state.projects.push(other));
  const legacy = await jobs.start(project.id, { operationId: 'legacy-child-op', mode: 'helper', spec: tinySpec() });
  await jobs.patch(legacy.id, { previsProjectId: undefined });
  const updated = await jobs.createProject(project.id, { title: '  第二镜头  ' });
  const child = updated.previsProjects.at(-1);
  assert.equal(updated.id, project.id); assert.equal(child.title, '第二镜头');
  assert.equal(store.list().length, 2);
  assert.deepEqual(jobs.projects(other.id), [{ id: 'default', title: '预演工程 1' }]);
  const disk = JSON.parse(await readFile(path.join(root, 'projects.json'), 'utf8'));
  assert.equal(disk.projects.find(item => item.id === project.id).previsProjects.at(-1).id, child.id);
  const first = await jobs.start(project.id, { operationId: 'new-child-op', previsProjectId: child.id, mode: 'helper', spec: tinySpec() });
  assert.equal(first.previsProjectId, child.id);
  const repeated = await jobs.start(project.id, { operationId: 'new-child-op', previsProjectId: child.id, mode: 'helper', spec: { ...tinySpec(), name: '不覆盖原参数' } });
  assert.equal(repeated.id, first.id); assert.equal(repeated.spec.name, first.spec.name);
  assert.equal((await jobs.start(project.id, { operationId: 'legacy-child-op', mode: 'helper', spec: tinySpec() })).id, legacy.id);
  await assert.rejects(jobs.start(project.id, { operationId: 'new-child-op', mode: 'helper', spec: tinySpec() }), /另一个预演工程/);
  await assert.rejects(jobs.start(other.id, { operationId: 'wrong-parent', previsProjectId: child.id, mode: 'helper', spec: tinySpec() }), /当前创作工程/);
  await assert.rejects(jobs.createProject(project.id, { title: ' ' }), /名称/);
});
