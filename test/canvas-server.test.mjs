import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server.mjs';

test('无限画布真实 HTTP：自由布局、绑定校验、服务重启、脱敏工程和私有密钥', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-canvas-http-'));
  const fakeKey = 'canvas-test-private-key';
  let providerCalls = 0;
  const unexpectedProviderCall = async () => { providerCalls++; throw new Error('画布测试不允许模型请求'); };
  const options = { root, catalog: [], tools: { ready: false, message: '测试合成工具' },
    integrations: { submit: unexpectedProviderCall, poll: unexpectedProviderCall, download: unexpectedProviderCall } };
  let app; let url; let token;
  t.after(async () => {
    if (app) await app.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('jingce-canvas-http-'));
    await rm(root, { recursive: true, force: true });
  });
  async function start() {
    app = await createStudio(options); url = await app.start(0);
    const response = await fetch(url + '/api/bootstrap');
    const body = await response.text(); assert.equal(response.status, 200); assert.ok(!body.includes(fakeKey));
    const bootstrap = JSON.parse(body); token = bootstrap.token;
    assert.equal(bootstrap.kinds.text.produces, 'text'); assert.deepEqual(bootstrap.kinds.text.accepts, []);
    return bootstrap;
  }
  const send = (route, method = 'GET', body, extra = {}) => fetch(url + route, {
    method, headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  async function sendJson(route, method = 'GET', body, status = 200) {
    const response = await send(route, method, body); const text = await response.text();
    assert.equal(response.status, status, route + ': ' + text); assert.ok(!text.includes(fakeKey));
    return JSON.parse(text);
  }
  async function upload(projectId, name, bytes) {
    const response = await fetch(url + '/api/projects/' + projectId + '/assets', {
      method: 'POST', headers: { 'X-Studio-Token': token, 'X-File-Name': encodeURIComponent(name) }, body: bytes,
    });
    assert.equal(response.status, 201); return response.json();
  }

  await start();
  for (const route of ['/canvas-layout.js', '/reference-model.js', '/prompt-mentions.js', '/prompt-editor.js']) {
    const response = await send(route); assert.equal(response.status, 200); assert.match(response.headers.get('Content-Type'), /javascript/);
  }
  const settings = await sendJson('/api/settings', 'PUT', { apiKey: fakeKey, videoModel: 'seedance-2.0-fast-933-720P（次）' });
  assert.equal(settings.hasKey, true); assert.equal(settings.apiKey, undefined);
  const privateSettings = JSON.parse(await readFile(path.join(root, 'connection.private.json'), 'utf8'));
  assert.equal(privateSettings.apiKey, fakeKey);
  let project = await sendJson('/api/projects', 'POST', { title: '无限画布验证', brief: { product: '雨夜书店' } }, 201);
  const pngBytes = Buffer.alloc(64); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pngBytes);
  const mp4Bytes = Buffer.alloc(128); mp4Bytes.write('ftyp', 4, 'ascii');
  const wavBytes = Buffer.alloc(64); wavBytes.write('RIFF', 0, 'ascii'); wavBytes.write('WAVE', 8, 'ascii');
  const imageUpload = await upload(project.id, '人物参考.png', pngBytes);
  const videoUpload = await upload(project.id, '候选视频.mp4', mp4Bytes);
  const audioUpload = await upload(project.id, '雨声.wav', wavBytes); project = audioUpload.project;
  const scene = { id: 'canvas-scene-one', title: '雨夜开场', videoPrompt: '@图片1的人物走入雨夜书店，缓慢推镜头', videoAssetId: videoUpload.asset.id,
    references: [{ refId: 'manual-http-person', assetId: imageUpload.asset.id, kind: 'image', note: '保持衣服颜色' }] };
  const graph = { nodes: [
    { id: 'idea', kind: 'text', label: '想法便签', x: -950, y: -460, width: 420, height: 220, note: '用书店暖光和雨夜形成对比', apiKey: fakeKey },
    { id: 'image-card', kind: 'image', x: -500, y: -250, assetId: imageUpload.asset.id, assetName: '忽略外部名称', width: 360, height: 460, url: 'https://example.invalid/private-canvas-signature' },
    { id: 'scene-card', kind: 'video', x: 20, y: 300, assetId: videoUpload.asset.id, sceneId: scene.id, width: 520, height: 480, status: 'done' },
    { id: 'audio-card', kind: 'audio', x: -700, y: 540, assetId: audioUpload.asset.id },
  ], links: [{ id: 'idea-image', from: 'idea', to: 'image-card' }, { id: 'image-scene', from: 'image-card', to: 'scene-card' }],
  groups: [{ id: 'reference-group', label: '雨夜参考素材', nodeIds: ['idea', 'image-card'], apiKey: fakeKey }],
  viewport: { x: 850.25, y: -325.5, zoom: 0.6, apiKey: fakeKey } };
  project = await sendJson('/api/projects/' + project.id, 'PATCH', { revision: project.revision, graph, scenes: [scene] });
  assert.deepEqual(project.graph.viewport, { x: 850.25, y: -325.5, zoom: 0.6 });
  assert.deepEqual(project.graph.groups, [{ id: 'reference-group', label: '雨夜参考素材', nodeIds: ['idea', 'image-card'] }]);
  assert.equal(project.graph.nodes[0].x, -950); assert.equal(project.graph.nodes[0].note, graph.nodes[0].note);
  assert.deepEqual(project.graph.nodes.map(node => node.assetName), ['', '人物参考.png', '候选视频.mp4', '雨声.wav']);
  assert.equal(project.graph.nodes[2].sceneId, scene.id); assert.equal(project.graph.nodes[2].width, 520);
  assert.equal(project.scenes[0].references.length, 1); assert.equal(project.scenes[0].references[0].nodeId, 'image-card');
  assert.equal(project.scenes[0].references[0].refId, 'manual-http-person'); assert.equal(project.scenes[0].references[0].note, '保持衣服颜色');
  assert.equal(project.scenes[0].promptMentions[0].key, 'node:image-card');
  const disconnectedGraph = { ...project.graph, links: project.graph.links.filter(link => link.id !== 'image-scene') };
  project = await sendJson('/api/projects/' + project.id, 'PATCH', { revision: project.revision, graph: disconnectedGraph });
  assert.equal(project.scenes[0].references[0].nodeId, undefined); assert.equal(project.scenes[0].references[0].refId, 'manual-http-person');
  assert.equal(project.scenes[0].promptMentions[0].key, 'ref:manual-http-person');
  project = await sendJson('/api/projects/' + project.id, 'PATCH', { revision: project.revision, graph });
  assert.equal(project.scenes[0].references.length, 1); assert.equal(project.scenes[0].promptMentions[0].key, 'node:image-card');
  const savedGraph = structuredClone(project.graph);
  assert.equal((await send('/api/projects/' + project.id, 'PATCH', { revision: 0, graph })).status, 409);

  const foreign = await sendJson('/api/projects', 'POST', { title: '另一个工程' }, 201);
  const foreignImage = await upload(foreign.id, '其他工程图片.png', pngBytes);
  for (const invalid of [
    { kind: 'image', assetId: foreignImage.asset.id }, { kind: 'image', assetId: audioUpload.asset.id },
    { kind: 'text', assetId: imageUpload.asset.id }, { kind: 'video', sceneId: 'missing-scene' },
    { kind: 'image', sceneId: scene.id },
  ]) {
    const response = await send('/api/projects/' + project.id, 'PATCH', { revision: project.revision,
      graph: { nodes: [{ id: 'invalid', ...invalid }], links: [] } });
    assert.equal(response.status, 400); assert.ok(!(await response.text()).includes(fakeKey));
  }
  assert.deepEqual((await sendJson('/api/projects/' + project.id)).graph, savedGraph);

  const previousToken = token;
  await app.close(); app = null;
  const restartedBootstrap = await start();
  assert.equal(restartedBootstrap.settings.hasKey, true); assert.equal(restartedBootstrap.settings.videoModel, 'seedance-2.0-fast-933-720P（次）');
  assert.notEqual(token, previousToken);
  const restored = await sendJson('/api/projects/' + project.id);
  assert.deepEqual(restored.graph, savedGraph); assert.equal(restored.revision, project.revision);
  assert.deepEqual(restored.scenes, project.scenes); assert.equal(restored.assets.length, 3);
  assert.equal((await send('/api/projects/' + project.id, 'PATCH', { revision: project.revision, graph }, { 'X-Studio-Token': previousToken })).status, 403);

  const document = await sendJson('/api/projects/' + project.id + '/export');
  const exportedText = JSON.stringify(document);
  assert.doesNotMatch(exportedText, /private-canvas-signature|apiKey/);
  for (const asset of restored.assets) { assert.ok(!exportedText.includes(asset.id)); assert.ok(!exportedText.includes(asset.file)); }
  assert.ok(document.project.graph.nodes.every(node => node.assetId === ''));
  assert.equal(document.project.graph.nodes[2].sceneId, scene.id);
  assert.equal(document.project.graph.nodes[2].assetName, '候选视频.mp4');
  assert.equal(document.project.scenes[0].videoAssetId, '');
  assert.deepEqual(document.project.graph.viewport, savedGraph.viewport);
  assert.deepEqual(document.project.graph.groups, savedGraph.groups);
  assert.equal(document.project.assets, undefined);
  document.project.graph.nodes[2].assetId = videoUpload.asset.id;
  document.project.graph.nodes[2].apiKey = fakeKey;
  document.project.assets = restored.assets;
  const imported = await sendJson('/api/projects/import', 'POST', document, 201);
  assert.notEqual(imported.id, restored.id); assert.deepEqual(imported.assets, []);
  assert.ok(imported.graph.nodes.every(node => node.assetId === ''));
  assert.equal(imported.graph.nodes[2].status, 'pending'); assert.equal(imported.graph.nodes[2].sceneId, scene.id);
  assert.equal(imported.graph.nodes[2].assetName, '候选视频.mp4'); assert.deepEqual(imported.graph.viewport, savedGraph.viewport);
  assert.equal(imported.graph.nodes[0].note, savedGraph.nodes[0].note);
  assert.deepEqual(imported.graph.groups, savedGraph.groups);
  assert.equal(imported.scenes[0].references.length, 1); assert.equal(imported.scenes[0].references[0].nodeId, 'image-card');
  assert.equal(imported.scenes[0].references[0].note, '保持衣服颜色'); assert.equal(imported.scenes[0].references[0].refId, 'manual-http-person');
  assert.equal(imported.scenes[0].promptMentions[0].key, 'node:image-card'); assert.equal(imported.scenes[0].promptMentions[0].assetId, undefined);
  assert.match(imported.scenes[0].videoPrompt, /@图片1（已断开）/);
  const importedRead = await sendJson('/api/projects/' + imported.id);
  assert.deepEqual(importedRead.graph, imported.graph);
  const publicState = await sendJson('/api/bootstrap');
  assert.equal(publicState.settings.hasKey, true); assert.equal(publicState.settings.apiKey, undefined);
  for (const route of ['/runtime/connection.private.json', '/connection.private.json', '/runtime/projects.json']) {
    const response = await send(route); assert.equal(response.status, 404); assert.ok(!(await response.text()).includes(fakeKey));
  }
  assert.equal(providerCalls, 0);
});
