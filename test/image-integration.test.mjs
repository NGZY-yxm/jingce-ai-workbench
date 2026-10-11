import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server.mjs';
import { normalizeImageResponse, UncertainImageSubmission } from '../lib/image-provider.mjs';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const CATALOG = [{ name: 'test-image', billingMode: 'image', description: '测试图片模型' }];

async function waitFor(read, predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`等待条件超时：${JSON.stringify(value)}`);
}

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-image-http-'));
  let app = await createStudio({ root, catalog: [], imageCatalog: CATALOG, tools: { ready: false, message: '测试工具' }, ...options });
  let url = await app.start(0);
  let bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
  const send = (route, method = 'GET', body) => fetch(url + route, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  async function json(route, method = 'GET', body, status = 200) {
    const response = await send(route, method, body);
    const text = await response.text();
    assert.equal(response.status, status, `${route}: ${text}`);
    return text ? JSON.parse(text) : null;
  }
  const key = 'image-test-private-key';
  const settings = await json('/api/image-settings', 'PUT', { apiKey: key, imageModel: 'test-image' });
  assert.equal(settings.hasKey, true);
  assert.equal(JSON.stringify(settings).includes(key), false);
  const createdProject = await json('/api/projects', 'POST', { title: '生图接口测试', brief: { product: '测试产品' } }, 201);
  const project = await json(`/api/projects/${createdProject.id}/plan`, 'POST', {}, 200);
  const sceneId = project.scenes[0].id;
  t.after(async () => {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, key, project, sceneId, send, json, get app() { return app; }, restart: async () => {
    await app.close();
    app = await createStudio({ root, catalog: [], imageCatalog: CATALOG, tools: { ready: false }, ...options });
    url = await app.start(0);
    bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
  } };
}

test('生图 Base64 结果自动保存为本机图片素材，并按 operationId 去重、支持删除恢复', async t => {
  let submissions = 0;
  const h = await setup(t, { imageIntegrations: {
    submitImage: async (settings, request) => {
      submissions++;
      assert.equal(settings.apiKey, 'image-test-private-key');
      assert.deepEqual(request, { model: 'test-image', prompt: '雨夜书店门口，电影感', n: 1 });
      return { kind: 'base64', data: PNG.toString('base64'), mime: 'image/png' };
    },
  } });
  const created = await h.json(`/api/projects/${h.project.id}/image-jobs`, 'POST', {
    sceneId: h.sceneId, model: 'test-image', prompt: '雨夜书店门口，电影感', operationId: 'same-operation'
  }, 202);
  const done = await waitFor(async () => (await h.json(`/api/projects/${h.project.id}/image-jobs`))[0], job => job.state === 'done');
  assert.equal(done.id, created.id);
  assert.equal(submissions, 1);
  assert.ok(done.assetId);
  const duplicate = await h.json(`/api/projects/${h.project.id}/image-jobs`, 'POST', {
    sceneId: h.sceneId, model: 'test-image', prompt: '雨夜书店门口，电影感', operationId: 'same-operation'
  }, 202);
  assert.equal(duplicate.id, created.id);
  assert.equal(submissions, 1);
  const project = await h.json(`/api/projects/${h.project.id}`);
  const asset = project.assets.find(item => item.id === done.assetId);
  assert.equal(asset.kind, 'image');
  assert.equal(asset.source, 'model');
  assert.equal(asset.mime, 'image/png');
  assert.deepEqual(await readFile(path.join(h.root, 'assets', asset.file)), PNG);
  const deleted = await h.json(`/api/image-jobs/${done.id}`, 'DELETE', undefined, 200);
  assert.ok(deleted.deletedAt);
  assert.deepEqual(await h.json(`/api/projects/${h.project.id}/image-jobs`), []);
  const listedDeleted = await h.json(`/api/projects/${h.project.id}/image-jobs?includeDeleted=1`);
  assert.equal(listedDeleted.length, 1);
  assert.ok(listedDeleted[0].deletedAt);
  const restored = await h.json(`/api/image-jobs/${done.id}/restore`, 'POST', {}, 200);
  assert.equal(restored.deletedAt, null);
  assert.equal((await h.json(`/api/projects/${h.project.id}/image-jobs`)).length, 1);
  const bootstrapText = await (await fetch('http://127.0.0.1:' + h.app.server.address().port + '/api/bootstrap')).text();
  assert.equal(bootstrapText.includes(h.key), false);
});

test('生图保存失败时只重试保存，不重复提交模型请求', async t => {
  let submissions = 0;
  let downloads = 0;
  const h = await setup(t, { imageIntegrations: {
    submitImage: async () => { submissions++; return { kind: 'url', url: 'https://images.example.test/result.png' }; },
    downloadImage: async (_url, destination) => {
      downloads++;
      if (downloads === 1) throw new Error('模拟一次性保存失败');
      await writeFile(destination, PNG, { flag: 'wx' });
      return PNG.length;
    },
  } });
  const created = await h.json(`/api/projects/${h.project.id}/image-jobs`, 'POST', {
    sceneId: h.sceneId, model: 'test-image', prompt: '产品白底图', operationId: 'retry-save'
  }, 202);
  const pending = await waitFor(async () => (await h.json(`/api/projects/${h.project.id}/image-jobs?includeDeleted=1`))[0],
    job => job.state === 'download_pending' && downloads === 1);
  assert.equal(pending.id, created.id);
  assert.equal(submissions, 1);
  assert.equal(downloads, 1);
  await h.json(`/api/image-jobs/${created.id}/retry`, 'POST', {}, 200);
  const done = await waitFor(async () => (await h.json(`/api/projects/${h.project.id}/image-jobs`))[0], job => job.state === 'done');
  assert.equal(done.id, created.id);
  assert.equal(submissions, 1);
  assert.equal(downloads, 2);
});

test('程序重启后不重复提交状态不确定的生图任务', async t => {
  let submissions = 0;
  const h = await setup(t, { imageIntegrations: {
    submitImage: async () => { submissions++; throw new UncertainImageSubmission(); },
  } });
  const created = await h.json(`/api/projects/${h.project.id}/image-jobs`, 'POST', {
    sceneId: h.sceneId, model: 'test-image', prompt: '不确定提交测试', operationId: 'uncertain-once'
  }, 202);
  const uncertain = await waitFor(async () => (await h.json(`/api/projects/${h.project.id}/image-jobs?includeDeleted=1`))[0], job => job.state === 'uncertain');
  assert.equal(uncertain.id, created.id);
  assert.equal(submissions, 1);
  await h.restart();
  const afterRestart = await h.json(`/api/projects/${h.project.id}/image-jobs?includeDeleted=1`);
  assert.equal(afterRestart[0].state, 'uncertain');
  assert.equal(submissions, 1);
});

test('生图响应支持 Base64、Data URI，并拒绝包含 API Key 的结果链接', () => {
  const encoded = PNG.toString('base64');
  assert.deepEqual(normalizeImageResponse({ data: [{ b64_json: `data:image/png;base64,${encoded}` }] }), { kind: 'base64', data: encoded, mime: 'image/png' });
  assert.deepEqual(normalizeImageResponse({ data: [{ url: 'https://images.example.test/result.png' }] }), { kind: 'url', url: 'https://images.example.test/result.png' });
  assert.throws(() => normalizeImageResponse({ data: [{ url: 'https://images.example.test/result.png?token=secret-key' }] }, 'secret-key'), /API Key/);
});
