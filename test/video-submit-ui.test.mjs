import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createProject } from '../lib/workflow.mjs';
import { LEGACY_VIDEO_REQUEST_MODE as VIDEO_REQUEST_MODE } from '../lib/providers.mjs';
import { videoParameters, videoParameterControls, updateVideoParameter, videoEstimateText, videoPricingNote } from '../public/video-parameters.js';
import { resolveSceneReferences, syncProjectReferences, referenceLabel, referenceKey } from '../public/reference-model.js';
import { referenceRequestIssue, referenceCapabilityText } from '../public/reference-api.js';
import { updatePromptMentions, insertReferenceMention, remapPromptMentions, invalidPromptMentions } from '../public/prompt-mentions.js';
import { createReferencePromptEditor } from '../public/prompt-editor.js';

const catalog = [{ name: 'model-a', defaultDuration: 5, defaultResolution: '720p',
  tiers: [5, 15].map(duration => ({ duration, resolution: '720p', price: duration / 5 })) }];
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
async function page(fetcher, storage = new Map()) {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      innerHTML: '', textContent: '', value: '', style: { setProperty() {} },
      classList: { toggle() {}, add() {}, remove() {} }, contains: () => false,
      addEventListener() {}, setAttribute() {}, querySelector: () => null,
    });
    return elements.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: element, querySelectorAll: () => [], addEventListener() {} }, window: { addEventListener() {} },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout: () => 1, clearTimeout() {}, crypto: { randomUUID }, structuredClone, console,
    videoParameters, videoParameterControls, updateVideoParameter, videoEstimateText, videoPricingNote,
    resolveSceneReferences, syncProjectReferences, referenceLabel, referenceKey, referenceRequestIssue, referenceCapabilityText,
    updatePromptMentions, insertReferenceMention, remapPromptMentions, invalidPromptMentions, createReferencePromptEditor,
    createInfiniteCanvas: () => ({ render() {}, fit() {}, activate() {}, reset() {}, busy: () => false }), fetch: fetcher,
  });
  const script = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
    .replace(/^import[^\n]*\n/gm, '').replace(/\ninit\(\);\s*$/, '\n');
  vm.runInContext(script + '\nglobalThis.harness={state,generateScene,renderScenes};', context);
  const project = createProject(); project.id = 'video-project';
  project.scenes = [{ id: 'clip', title: '视频', videoPrompt: '原创人物行走', references: [],
    duration: 5, generationDuration: 5, generationCount: 1 }];
  const { state, generateScene, renderScenes } = context.harness;
  state.project = project; state.saved = structuredClone(project); state.catalog = catalog;
  state.settings = { hasKey: true, videoModel: 'model-a', generationCountMax: 5, videoRequestMode: VIDEO_REQUEST_MODE };
  return { state, generateScene, renderScenes, element };
}
const recordedBatch = input => ({ batchId: input.operationId, count: input.count,
  jobs: [{ id: input.operationId, batchId: input.operationId, sceneId: input.sceneId, operationId: input.operationId,
    variantCount: input.count, model: input.model, duration: input.duration, state: 'queued', createdAt: new Date().toISOString() }] });

test('视频提交确认丢失后刷新页面先找原任务，已删除记录也不重复创建，明确再次生成才用新编号', async () => {
  const storage = new Map(), posts = []; let batch, loseResponse = true;
  const fetcher = async (url, options) => {
    if (options.method === 'POST') {
      const input = JSON.parse(options.body); posts.push(input); batch = recordedBatch(input);
      if (loseResponse) { loseResponse = false; throw new Error('response lost after enqueue'); }
      return response(batch, 202);
    }
    assert.match(url, /jobs\?includeDeleted=1$/); return response(batch.jobs.map(job => ({ ...job, deletedAt: new Date().toISOString() })));
  };
  const first = await page(fetcher, storage);
  await assert.rejects(first.generateScene('clip'), /先核对原任务/);
  assert.equal(first.state.submitting.size, 0);
  assert.equal(first.state.videoOperations.size, 1);
  assert.match(first.element('#scene-list').innerHTML, /核对上次提交/);
  const reloaded = await page(fetcher, storage);
  // Recovering an accepted request remains possible after parameters/prompt change.
  reloaded.state.project.scenes[0].videoPrompt = '@图片99';
  const recovered = await reloaded.generateScene('clip');
  assert.equal(recovered.batchId, batch.batchId); assert.equal(posts.length, 1);
  assert.equal(reloaded.state.videoOperations.size, 0);
  reloaded.state.project.scenes[0].videoPrompt = '新的原创视频';
  await reloaded.generateScene('clip');
  assert.equal(posts.length, 2); assert.notEqual(posts[0].operationId, posts[1].operationId);
});

test('视频提交未入队且响应丢失时，刷新后的重试复用原编号及原秒数和数量', async () => {
  const storage = new Map();
  const posts = []; let loseResponse = true;
  const fetcher = async (url, options) => {
    if (options.method === 'GET') { assert.match(url, /includeDeleted=1/); return response([]); }
    const input = JSON.parse(options.body); posts.push(input);
    if (loseResponse) { loseResponse = false; throw new Error('request lost'); }
    return response(recordedBatch(input), 202);
  };
  const current = await page(fetcher, storage);
  await assert.rejects(current.generateScene('clip'), /先核对原任务/);
  const reloaded = await page(fetcher, storage);
  reloaded.state.project.scenes[0].generationCount = 5;
  reloaded.state.project.scenes[0].generationDuration = 15;
  await reloaded.generateScene('clip');
  assert.equal(posts.length, 2); assert.equal(posts[0].operationId, posts[1].operationId);
  assert.equal(posts[1].count, 1); assert.equal(posts[1].duration, 5);
  assert.equal(reloaded.state.videoOperations.size, 0);
});

test('原视频任务核对失败时保留操作编号，不发起新的生成', async () => {
  let posts = 0;
  const current = await page(async (_url, options) => {
    if (options.method === 'POST') posts++;
    throw new Error('local service unavailable');
  });
  await assert.rejects(current.generateScene('clip'), /先核对原任务/);
  const operationId = current.state.videoOperations.get('video-project:clip');
  await assert.rejects(current.generateScene('clip'), /连接中断/);
  assert.equal(posts, 1); assert.equal(current.state.videoOperations.get('video-project:clip'), operationId);
});

test('视频入队明确被拒绝后清除待核对编号，修正设置可重新提交', async () => {
  const posts = []; let reject = true;
  const current = await page(async (_url, options) => {
    assert.equal(options.method, 'POST');
    const input = JSON.parse(options.body); posts.push(input);
    if (reject) { reject = false; return response({ error: '模型配置不正确' }, 400); }
    return response(recordedBatch(input), 202);
  });
  await assert.rejects(current.generateScene('clip'), /配置不正确/);
  assert.equal(current.state.videoOperations.size, 0);
  await current.generateScene('clip');
  assert.notEqual(posts[0].operationId, posts[1].operationId);
});

test('画布和视频页同时触发同一视频生成项时，仅发送一个入队请求', async () => {
  let release, entered, posts = 0;
  const gate = new Promise(resolve => { release = resolve; }), posting = new Promise(resolve => { entered = resolve; });
  const current = await page(async (_url, options) => {
    posts++; entered(); await gate; return response(recordedBatch(JSON.parse(options.body)), 202);
  });
  const first = current.generateScene('clip');
  try {
    await posting;
    await assert.rejects(current.generateScene('clip'), /正在提交/);
    assert.equal(posts, 1);
  } finally { release(); await first; }
});
