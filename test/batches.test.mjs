import test from 'node:test';
import { createSkillLibrary } from '../public/skills.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Store } from '../lib/store.mjs';
import { VideoJobs } from '../lib/jobs.mjs';
import { createProject, draftPlan, touch, exportProject, importProject } from '../lib/workflow.mjs';
import { LEGACY_CONNECTION as DEFAULT_CONNECTION, LEGACY_VIDEO_REQUEST_MODE as VIDEO_REQUEST_MODE, submitVideo, UncertainSubmission } from '../lib/providers.mjs';
import { compositionClips } from '../lib/compose.mjs';
import { createStudio } from '../server.mjs';
import { videoParameters, videoParameterControls, updateVideoParameter, videoEstimateText, videoPricingNote } from '../public/video-parameters.js';
import { resolveSceneReferences, syncProjectReferences, referenceLabel, referenceKey } from '../public/reference-model.js';
import { updatePromptMentions, insertReferenceMention, remapPromptMentions, invalidPromptMentions } from '../public/prompt-mentions.js';
import { createReferencePromptEditor } from '../public/prompt-editor.js';
import { referenceRequestIssue, referenceCapabilityText, referenceConstraintIssue, referencePreparationModel, referenceCapabilities } from '../public/reference-api.js';

const catalog = [{ name: 'model-a', defaultDuration: 5, defaultResolution: '720p',
  tiers: [{ duration: 5, resolution: '720p', price: 1.1 }] }];
async function until(predicate) {
  for (let i = 0; i < 250; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('批量任务未进入预期状态');
}
async function download(_url, destination) {
  const bytes = Buffer.alloc(128); bytes.write('ftyp', 4, 'ascii');
  await writeFile(destination, bytes); return bytes.length;
}
async function setup(t, submitOverride) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-batch-'));
  let store = new Store(root); await store.init();
  await store.saveSettings({ ...DEFAULT_CONNECTION, videoModel: 'model-a', apiKey: 'batch-test-key' });
  const project = draftPlan(createProject({ brief: { product: '候选视频检查' } }));
  await store.mutate(state => state.projects.push(project));
  const posts = [], complete = new Set(); let peak = 0;
  const integrations = {
    submit: async (settings, job, image) => {
      peak = Math.max(peak, store.state.jobs.filter(j => ['submitting', 'queued', 'running', 'downloading'].includes(j.state)).length);
      if (submitOverride) {
        posts.push({ id: job.id }); return submitOverride(job);
      }
      return submitVideo(settings, job, image, async (_url, options) => {
        posts.push({ id: job.id, body: JSON.parse(options.body) });
        return new Response(JSON.stringify({ task_id: job.id, status: 'queued' }));
      });
    },
    poll: async (_settings, id) => ({ taskId: id, state: complete.has(id) ? 'completed' : 'running',
      url: complete.has(id) ? 'https://cdn.example.invalid/result.mp4' : '', progress: complete.has(id) ? 100 : 50 }),
    download,
  };
  let jobs = new VideoJobs(store, integrations); await jobs.init();
  t.after(async () => { jobs.close(); await jobs.dispatchTask; await store.pending; await rm(root, { recursive: true, force: true }); });
  return { get jobs() { return jobs; }, get store() { return store; }, project, posts, complete, get peak() { return peak; },
    input: { sceneId: project.scenes[0].id, count: 5, duration: 5, model: 'model-a', requestMode: VIDEO_REQUEST_MODE, operationId: 'batch-once' },
    async restart() {
      jobs.close(); await jobs.dispatchTask; await store.pending;
      store = new Store(root); await store.init(); jobs = new VideoJobs(store, integrations); await jobs.init();
    } };
}

test('五个候选原子记录、总价正确、不受本地并发上限阻塞', async t => {
  const ctx = await setup(t);
  for (const count of [0, 6, 1.5, NaN]) await assert.rejects(ctx.jobs.startBatch(ctx.project.id, { ...ctx.input, count }, catalog), /生成数量/);
  assert.equal(ctx.store.state.jobs.length, 0); assert.equal(ctx.posts.length, 0);
  const [first, repeat] = await Promise.all([
    ctx.jobs.startBatch(ctx.project.id, ctx.input, catalog), ctx.jobs.startBatch(ctx.project.id, ctx.input, catalog),
  ]);
  await until(() => ctx.posts.length === 5 && !ctx.jobs.busy.size);
  assert.equal(first.batchId, repeat.batchId); assert.equal(first.count, 5); assert.equal(first.totalEstimate, 5.5);
  assert.deepEqual(first.jobs.map(job => job.variantIndex), [1, 2, 3, 4, 5]);
  assert.equal(new Set(first.jobs.map(job => job.id)).size, 5);
  assert.equal(ctx.store.state.jobs.filter(job => job.state === 'waiting').length, 0);
  const sameOperation = await ctx.jobs.startBatch(ctx.project.id, ctx.input, catalog);
  assert.equal(sameOperation.batchId, first.batchId); assert.equal(ctx.posts.length, 5);
  for (const job of ctx.store.state.jobs.slice(0, 2)) {
    ctx.complete.add(job.id); await ctx.jobs.refresh(job);
    await until(() => !ctx.jobs.busy.size);
  }
  assert.equal(ctx.posts.length, 5); assert.equal(ctx.peak, 5); assert.equal(new Set(ctx.posts.map(post => post.id)).size, 5);
  for (const post of ctx.posts) assert.deepEqual(post.body, { model: 'model-a', prompt: ctx.project.scenes[0].videoPrompt, duration: 5 });
  assert.equal(ctx.store.get(ctx.project.id).scenes[0].videoAssetId, '');
});

test('重启后已受理候选继续查询而不重新提交', async t => {
  const ctx = await setup(t); await ctx.jobs.startBatch(ctx.project.id, ctx.input, catalog);
  await until(() => ctx.posts.length === 5 && !ctx.jobs.busy.size);
  const acceptedIds = ctx.posts.map(post => post.id);
  await ctx.restart(); await until(() => !ctx.jobs.busy.size);
  assert.equal(ctx.posts.length, 5);
  assert.equal(ctx.store.state.jobs.filter(job => job.state === 'waiting').length, 0);
  ctx.complete.add(acceptedIds[0]); await ctx.jobs.refresh(ctx.store.state.jobs.find(job => job.id === acceptedIds[0]));
  await until(() => !ctx.jobs.busy.size);
  assert.equal(ctx.posts.length, 5);
  assert.equal(ctx.store.state.jobs.length, 5);
});

test('部分候选提交结果不确定时保留编号，不重发该候选', async t => {
  const ctx = await setup(t, async job => {
    if (job.variantIndex === 2) throw new UncertainSubmission();
    return { taskId: job.id, state: 'queued' };
  });
  await ctx.jobs.startBatch(ctx.project.id, ctx.input, catalog);
  await until(() => ctx.posts.length === 5 && !ctx.jobs.busy.size);
  const uncertain = ctx.store.state.jobs.find(job => job.variantIndex === 2);
  assert.equal(uncertain.state, 'uncertain');
  await ctx.jobs.tick(); await until(() => !ctx.jobs.busy.size);
  assert.equal(ctx.posts.filter(post => post.id === uncertain.id).length, 1);
  await ctx.restart(); await until(() => !ctx.jobs.busy.size);
  assert.equal(ctx.posts.length, 5);
  assert.equal(ctx.store.state.jobs.find(job => job.id === uncertain.id).state, 'uncertain');
  const first = ctx.store.state.jobs.find(job => job.variantIndex === 1);
  ctx.complete.add(first.id); await ctx.jobs.refresh(first);
  await until(() => !ctx.jobs.busy.size);
  assert.equal(new Set(ctx.posts.map(post => post.id)).size, 5); assert.equal(ctx.peak, 5);
});

test('显式选中候选后，剩余候选完成不改变选片；选片和数量持久化并用于合成', async t => {
  const ctx = await setup(t);
  await ctx.store.update(ctx.project.id, p => { p.scenes[0].generationCount = 3; return touch(p); });
  await ctx.jobs.startBatch(ctx.project.id, { ...ctx.input, count: 3 }, catalog);
  await until(() => ctx.posts.length === 3 && !ctx.jobs.busy.size);
  const first = ctx.store.state.jobs[0]; ctx.complete.add(first.id); await ctx.jobs.refresh(first);
  const selected = ctx.store.get(ctx.project.id).assets[0];
  await ctx.store.update(ctx.project.id, p => { p.scenes[0].videoAssetId = selected.id; return touch(p); });
  for (const job of ctx.store.state.jobs.slice(1)) { ctx.complete.add(job.id); await ctx.jobs.refresh(job); }
  const project = ctx.store.get(ctx.project.id);
  assert.equal(project.assets.length, 3); assert.equal(project.scenes[0].videoAssetId, selected.id);
  assert.ok(project.assets.every(asset => asset.batchId && asset.variantCount === 3));
  const forCompose = { ...project, scenes: [project.scenes[0]] };
  assert.equal(compositionClips(forCompose)[0].asset.id, selected.id);
  await ctx.restart(); assert.equal(ctx.store.get(ctx.project.id).scenes[0].videoAssetId, selected.id);
  assert.equal(importProject(exportProject(project)).scenes[0].generationCount, 3);
  assert.equal(ctx.posts.length, 3);
});

test('已有选片时生成单个新候选也保留原选片', async t => {
  const ctx = await setup(t);
  await ctx.store.update(ctx.project.id, p => {
    p.assets.push({ id: 'user-picked', kind: 'video', name: '用户已选视频' });
    p.scenes[0].videoAssetId = 'user-picked'; return touch(p);
  });
  await ctx.jobs.startBatch(ctx.project.id, { ...ctx.input, count: 1 }, catalog);
  await until(() => ctx.posts.length === 1 && !ctx.jobs.busy.size);
  const job = ctx.store.state.jobs[0]; ctx.complete.add(job.id); await ctx.jobs.refresh(job);
  assert.equal(ctx.store.get(ctx.project.id).scenes[0].videoAssetId, 'user-picked');
});

test('HTTP 批量生成、候选下载、选片保存和服务恢复贯通，重复操作不增费', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-batch-http-'));
  let posts = 0;
  const config = { root, catalog, tools: { ready: false }, integrations: {
    submit: async (_settings, job) => { posts++; return { taskId: job.id, state: 'queued' }; },
    poll: async (_settings, id) => ({ taskId: id, state: 'completed', url: 'https://cdn.example.invalid/video.mp4' }), download,
  } };
  let app = await createStudio(config), url = await app.start(0), token;
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  let bootstrap = await (await fetch(url + '/api/bootstrap')).json(); token = bootstrap.token;
  assert.equal(bootstrap.settings.generationCountMax, 5); assert.equal(bootstrap.settings.maxConcurrentTasks, null);
  const send = (route, method, body) => fetch(url + route, { method,
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token }, body: JSON.stringify(body) });
  await send('/api/settings', 'PUT', { apiKey: 'http-batch-test-key', videoModel: 'model-a' });
  let project = await (await send('/api/projects', 'POST', { title: '候选选择' })).json();
  project = await (await send(`/api/projects/${project.id}`, 'PATCH', { revision: project.revision,
    scenes: [{ id: 'clip', videoPrompt: '原创镜头', duration: 5, generationDuration: 5, generationCount: 3 }] })).json();
  const input = { sceneId: 'clip', count: 3, duration: 5, requestMode: VIDEO_REQUEST_MODE, operationId: 'http-batch-once' };
  assert.equal((await send(`/api/projects/${project.id}/batches`, 'POST', { ...input, count: 6 })).status, 400);
  assert.equal(posts, 0);
  const response = await send(`/api/projects/${project.id}/batches`, 'POST', input);
  assert.equal(response.status, 202); const batch = await response.json(); assert.equal(batch.totalEstimate, 3.3);
  await until(() => posts === 3 && !app.jobs.busy.size);
  await Promise.all(app.store.state.jobs.map(job => app.jobs.refresh(job)));
  project = await (await fetch(`${url}/api/projects/${project.id}`)).json();
  assert.equal(project.assets.length, 3); assert.equal(project.scenes[0].videoAssetId, '');
  const selected = project.assets[1]; project.scenes[0].videoAssetId = selected.id;
  project = await (await send(`/api/projects/${project.id}`, 'PATCH', { revision: project.revision, scenes: project.scenes })).json();
  assert.equal(project.scenes[0].videoAssetId, selected.id);
  const partial = await fetch(`${url}/api/assets/${selected.id}`, { headers: { Range: 'bytes=4-7' } });
  assert.equal(partial.status, 206); assert.equal(await partial.text(), 'ftyp');
  const duplicate = await (await send(`/api/projects/${project.id}/batches`, 'POST', input)).json();
  assert.equal(duplicate.batchId, batch.batchId); assert.equal(posts, 3);
  await app.close(); app = await createStudio(config); url = await app.start(0);
  bootstrap = await (await fetch(url + '/api/bootstrap')).json(); token = bootstrap.token;
  const saved = await (await fetch(`${url}/api/projects/${project.id}`)).json();
  assert.equal(saved.scenes[0].videoAssetId, selected.id); assert.equal(saved.scenes[0].generationCount, 3);
  assert.equal(posts, 3);
});

test('页面脚本：数量改变更新总价，预览卡片可显式选片并保存', async () => {
  const elements = new Map(); let savedPatch; const addAssetCalls = [];
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: '', textContent: '', className: '', value: '', listeners: {},
      style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} }, contains: () => false,
      addEventListener(name, fn) {
        const previous = this.listeners[name];
        this.listeners[name] = event => { previous?.(event); return fn(event); };
      }, replaceChildren(...children) { this.children = children; this.innerHTML = ''; },
      querySelector() { return element(selector + ' child'); }, insertAdjacentHTML(_position, html) { this.innerHTML += html; } });
    return elements.get(selector);
  }
  const context = vm.createContext({ createSkillLibrary, document: { body: { dataset: {} }, querySelector: element, querySelectorAll: () => [], addEventListener() {} },
    window: { addEventListener() {} }, videoParameters, videoParameterControls, updateVideoParameter, videoEstimateText, videoPricingNote, structuredClone, console,
    resolveSceneReferences, syncProjectReferences, referenceLabel, referenceKey, referenceRequestIssue, referenceCapabilityText, referenceConstraintIssue, referencePreparationModel, referenceCapabilities,
    updatePromptMentions, insertReferenceMention, remapPromptMentions, invalidPromptMentions, createReferencePromptEditor,
    createInfiniteCanvas: () => ({ render() {}, fit() {}, activate() {}, reset() {}, busy: () => false,
      syncScenes() {}, addAsset(asset) { addAssetCalls.push(asset); }, openBrief() {}, finishEditing() {} }),
    setTimeout: () => 1, clearTimeout() {}, crypto: { randomUUID: () => 'operation-id' },
    fetch: async (_url, options) => {
      savedPatch = JSON.parse(options.body);
      return { ok: true, json: async () => ({ ...context.harness.state.project, revision: 2 }) };
    } });
  const script = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
    .replace(/^import[^\n]*\n/gm, '').replace(/\ninit\(\);\s*$/, '\n');
  vm.runInContext(script + '\nglobalThis.harness={state,renderScenes};', context);
  const { state, renderScenes } = context.harness;
  const project = createProject();
  project.scenes = [{ id: 'clip', title: '选择候选', duration: 5, generationDuration: 5, generationCount: 1,
    videoPrompt: '原创视频', references: [], videoAssetId: '' }];
  project.assets = [1, 2, 3].map(index => ({ id: 'asset-' + index, kind: 'video', source: 'model', sceneId: 'clip',
    createdAt: new Date().toISOString(), variantCount: 3, variantIndex: index, duration: 5, name: '候选 ' + index }));
  state.project = project; state.saved = structuredClone(project); state.catalog = catalog;
  state.settings = { hasKey: true, videoModel: 'model-a', generationCountMax: 5 };
  renderScenes();
  assert.match(element('#scene-list').innerHTML, /data-scene-action=\"place-asset\"/);
  const placeButton = { disabled: false, dataset: { sceneAction: 'place-asset', assetId: 'asset-2' },
    closest: () => ({ dataset: { sceneId: 'clip' } }) };
  element('#scene-list').listeners.click({ target: { closest: selector => selector === '[data-scene-action]' ? placeButton : null } });
  await until(() => addAssetCalls.length === 1);
  assert.equal(addAssetCalls[0].id, 'asset-2');
  element('#scene-list').listeners.change({ target: { tagName: 'SELECT', value: '3', dataset: { sceneField: 'generationCount' },
    matches: () => false, closest: () => ({ dataset: { sceneId: 'clip' } }) } });
  assert.equal(state.project.scenes[0].generationCount, 3);
  assert.match(element('#scene-list').innerHTML, /预计合计 3.3 平台余额单位/);
  assert.equal((element('#scene-list').innerHTML.match(/preload="none"/g) || []).length, 3);
  const button = { disabled: false, dataset: { sceneAction: 'select-candidate', assetId: 'asset-2' },
    closest: () => ({ dataset: { sceneId: 'clip' } }) };
  element('#scene-list').listeners.click({ target: { closest: selector => selector === '[data-scene-action]' ? button : null } });
  await until(() => savedPatch && !state.saveTask);
  assert.equal(savedPatch.scenes[0].videoAssetId, 'asset-2'); assert.equal(savedPatch.scenes[0].generationCount, 3);
  assert.match(element('#scene-list').innerHTML, /✓ 当前结果/);
});
