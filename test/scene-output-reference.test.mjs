import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProject, normalizeScenes, updateProject, exportProject, importProject, setAssetDeleted, draftPlan, touch } from '../lib/workflow.mjs';
import { createStudio } from '../server.mjs';
import { submitVideo, LEGACY_VIDEO_REQUEST_MODE as VIDEO_REQUEST_MODE } from '../lib/providers.mjs';
import { invalidPromptMentions } from '../public/prompt-mentions.js';

function fixture() {
  const project = createProject({ brief: { product: '分镜参考测试' } });
  project.scenes = normalizeScenes([{ id: 'one', title: '来源分镜', videoAssetId: 'private-first' },
    { id: 'two', title: '目标分镜', videoPrompt: '延续@视频1的动作' }, { id: 'three', title: '其他分镜' }]);
  project.assets = [
    { id: 'private-first', kind: 'video', name: '来源候选一.mp4', source: 'model', sceneId: 'one' },
    { id: 'private-second', kind: 'video', name: '来源候选二.mp4', source: 'model', sceneId: 'one' },
    { id: 'private-other', kind: 'video', name: '其他分镜.mp4', source: 'model', sceneId: 'three' },
  ];
  project.graph = { cardSizeVersion: 1, nodes: ['one', 'two', 'three'].map(id => ({ id: 'card-' + id, kind: 'video', sceneId: id, width: 320, height: 260 })), links: [] };
  return project;
}
function outputLink(to = 'card-two', assetId = 'private-first') {
  return { id: 'output-' + to, from: 'card-one', to, reference: { assetId, kind: 'video', name: '来源候选一.mp4' } };
}

test('分镜输出快照在 graph-only 和 graph/scenes 保存中保留 @ 身份；更换选片不改变输出参考', () => {
  const project = fixture();
  let saved = updateProject(project, { revision: project.revision, graph: { ...project.graph, links: [outputLink()] } });
  assert.deepEqual(saved.scenes[1].references.map(ref => [ref.nodeId, ref.assetId, ref.kind]), [['card-one', 'private-first', 'video']]);
  saved.scenes[1].videoPrompt = '延续@视频1的动作';
  saved.scenes[0].videoAssetId = 'private-second';
  saved.scenes[1].references[0].note = '延续动作';
  saved = updateProject(saved, { revision: saved.revision, graph: saved.graph, scenes: saved.scenes });
  assert.equal(saved.scenes[1].references[0].assetId, 'private-first'); assert.equal(saved.scenes[1].references[0].note, '延续动作');
  assert.equal(saved.graph.links[0].reference.assetId, 'private-first');
  assert.equal(saved.scenes[1].promptMentions[0].key, 'node:card-one'); assert.equal(saved.scenes[1].promptMentions[0].missing, false);
  assert.throws(() => updateProject(saved, { revision: saved.revision, graph: { ...saved.graph, links: [outputLink('card-two', 'private-other')] } }), /来源视频生成项/);
  assert.throws(() => updateProject(saved, { revision: saved.revision, graph: { ...saved.graph, links: [{ ...outputLink(), reference: { assetId: 'missing', kind: 'video' } }] } }), /不存在/);
  assert.throws(() => updateProject(saved, { revision: saved.revision, graph: { ...saved.graph, links: [{ ...outputLink(), reference: { assetId: 'private-first', kind: 'image' } }] } }), /类型/);
  const spoofed = structuredClone(saved.scenes); spoofed[1].references[0].assetId = 'private-second';
  assert.throws(() => updateProject(saved, { revision: saved.revision, scenes: spoofed }), /连线/);
});

test('分镜输出导入导出清空本机结果和链接，保留连线占位及用途并阻止失效引用生成', () => {
  const project = fixture();
  const saved = updateProject(project, { revision: project.revision, graph: { ...project.graph, links: [outputLink()] } });
  saved.scenes[1].references[0].note = '延续动作'; saved.scenes[1].references[0].publicUrl = 'https://media.example.org/result.mp4?signature=private';
  const document = exportProject(saved);
  assert.doesNotMatch(JSON.stringify(document), /private-first|private-second|signature=private|publicUrl/);
  assert.deepEqual(document.project.graph.links[0].reference, { assetId: '', kind: 'video', name: '来源候选一.mp4' });
  const imported = importProject(document);
  assert.equal(imported.scenes[1].references[0].nodeId, 'card-one'); assert.equal(imported.scenes[1].references[0].assetId, '');
  assert.equal(imported.scenes[1].references[0].note, '延续动作'); assert.match(imported.scenes[1].videoPrompt, /已断开/);
  assert.equal(invalidPromptMentions(imported.scenes[1], imported.scenes[1].references).length, 1);
  const resaved = updateProject(imported, { revision: imported.revision, graph: imported.graph });
  assert.deepEqual(resaved.graph.links, imported.graph.links); assert.deepEqual(resaved.scenes[1].references, imported.scenes[1].references);
});

test('删除被引用的生成素材会清理输出边并标明失效引用；重新规划清理旧绑定而保留视频', () => {
  const project = fixture(), saved = updateProject(project, { revision: project.revision, graph: { ...project.graph, links: [outputLink(), outputLink('card-three')] } });
  const deleted = setAssetDeleted(saved, 'private-first', true);
  assert.deepEqual(deleted.graph.links, []); assert.equal(deleted.scenes[1].references.length, 0); assert.match(deleted.scenes[1].videoPrompt, /已断开/);
  assert.equal(deleted.assets.length, saved.assets.length); assert.equal(deleted.assets[0].deletedAt !== undefined, true);
  const planned = draftPlan(saved);
  assert.deepEqual(planned.graph.links, []); assert.deepEqual(planned.assets, saved.assets);
  assert.doesNotThrow(() => updateProject(planned, { revision: planned.revision, graph: planned.graph }));
});

test('复制分镜卡不能绕过同分镜自引用和参考循环校验', () => {
  const project = fixture(); project.graph.nodes.push({ id: 'one-copy', kind: 'video', sceneId: 'one' });
  assert.throws(() => updateProject(project, { revision: project.revision, graph: { ...project.graph, links: [outputLink('one-copy')] } }), /循环/);
  project.scenes[1].videoAssetId = 'private-other';
  const cyclic = [outputLink(), { id: 'back', from: 'card-two', to: 'one-copy', reference: { assetId: 'private-other', kind: 'video', name: '选用视频.mp4' } }];
  assert.throws(() => updateProject(project, { revision: project.revision, graph: { ...project.graph, links: cyclic } }), /循环/);
});

test('本地 HTTP 分镜输出参考：保存重启仍指向原候选，模拟模型提交包含该视频并脱敏导出', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-shot-output-'));
  let app, base, token; const posts = [];
  const model = { name: 'mock-shot-reference', description: '支持9图片3视频', defaultDuration: 5, defaultResolution: '720p', ratios: ['16:9'], tiers: [{ duration: 5, resolution: '720p', price: 1 }] };
  const config = { root, catalog: [model], tools: { ready: false }, integrations: {
    verifyReferences: async refs => { assert.equal(refs[0].assetId, 'private-first'); },
    submit: async (settings, candidate) => submitVideo(settings, candidate, undefined, async (_url, options) => {
      posts.push(JSON.parse(options.body)); return new Response(JSON.stringify({ id: 'mock-pinned-task', status: 'queued' }), { headers: { 'Content-Type': 'application/json' } });
    }),
    poll: async () => ({ state: 'running', progress: 10 }),
  } };
  t.after(async () => {
    if (app) await app.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('jingce-shot-output-'));
    await rm(root, { recursive: true, force: true });
  });
  async function start() {
    app = await createStudio(config); base = await app.start(0);
    token = (await (await fetch(base + '/api/bootstrap')).json()).token;
  }
  async function send(route, method = 'GET', body, expected = 200) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  }
  await start();
  await send('/api/settings', 'PUT', { apiKey: 'mock-no-billing-key', videoModel: model.name });
  let project = await send('/api/projects', 'POST', { brief: { product: '分镜复用测试', ratio: '16:9' } }, 201);
  const data = fixture();
  project = await app.store.update(project.id, existing => touch({ ...existing, scenes: data.scenes, assets: data.assets, graph: data.graph }));
  project = await send('/api/projects/' + project.id, 'PATCH', { revision: project.revision, graph: { ...project.graph, links: [outputLink()] } });
  project.scenes[0].videoAssetId = 'private-second'; project.scenes[1].references[0].note = '延续动作和运镜';
  project.scenes[1].references[0].publicUrl = 'https://media.example.org/original-candidate.mp4?signature=pinned';
  project = await send('/api/projects/' + project.id, 'PATCH', { revision: project.revision, graph: project.graph, scenes: project.scenes });
  const savedId = project.id;
  await app.close(); app = null; await start();
  project = await send('/api/projects/' + savedId);
  assert.equal(project.graph.links[0].reference.assetId, 'private-first'); assert.equal(project.scenes[0].videoAssetId, 'private-second');
  assert.equal(project.scenes[1].references[0].note, '延续动作和运镜');
  const batch = await send('/api/projects/' + savedId + '/batches', 'POST', { sceneId: 'two', model: model.name, duration: 5, count: 1, requestMode: VIDEO_REQUEST_MODE, operationId: 'pinned-output-only' }, 202);
  for (let n = 0; n < 100 && posts.length < 1; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(posts.length, 1); assert.equal(batch.jobs[0].referenceCount, 1);
  assert.deepEqual(posts[0].videos, [{ url: 'https://media.example.org/original-candidate.mp4?signature=pinned', name: '视频1' }]);
  assert.match(posts[0].prompt, /延续@视频1/); assert.doesNotMatch(JSON.stringify(posts[0]), /private-first|private-second|card-one/);
  const exported = await send('/api/projects/' + savedId + '/export');
  assert.doesNotMatch(JSON.stringify(exported), /private-first|private-second|signature=pinned|publicUrl|mock-no-billing-key/);
  const imported = await send('/api/projects/import', 'POST', exported, 201);
  assert.equal(imported.graph.links[0].reference.assetId, ''); assert.equal(imported.scenes[1].references[0].name, '来源候选一.mp4');
  assert.match(imported.scenes[1].videoPrompt, /已断开/);
});
