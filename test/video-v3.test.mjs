import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { Store } from '../lib/store.mjs';
import { VideoJobs } from '../lib/jobs.mjs';
import { createProject, updateProject, touch, exportProject, importProject } from '../lib/workflow.mjs';
import { createStudio } from '../server.mjs';
import { PLATFORM, DEFAULT_CONNECTION, VIDEO_REQUEST_MODE, LEGACY_PLATFORM, LEGACY_CONNECTION,
  LEGACY_VIDEO_REQUEST_MODE, videoBaseUrl, catalogForVideoModelIds, buildVideoRequest,
  normalizeVideoV3Task, loadCatalog, checkConnection, submitVideo, pollVideo, UncertainSubmission } from '../lib/providers.mjs';
import { downloadPublicVideo } from '../lib/media.mjs';
import { videoParameters, videoParameterControls, videoEstimateText, videoPricingNote } from '../public/video-parameters.js';
import { resolveSceneReferences, referenceLabel } from '../public/reference-model.js';
import { insertReferenceMention, remapPromptMentions, invalidPromptMentions } from '../public/prompt-mentions.js';

const ids = ['seedance-2.0-933-720P（秒）', 'seedance-2.0-fast-933-720P（次）',
  'seedance-2.0-mini-903-720P（次）', 'seedance-2.5-301010-1K（秒）', 'minimax-h3-933-2K（次）'];
const catalog = catalogForVideoModelIds(ids);
const settings = { ...DEFAULT_CONNECTION, apiKey: 'v3-original-test-secret' };
const job = { model: ids[1], duration: 5, resolution: '720p', ratio: '16:9',
  prompt: '原创人物坐在窗边，拿起苹果。', requestMode: VIDEO_REQUEST_MODE };
const reply = (data, status = 200, headers = {}) => new Response(JSON.stringify(data),
  { status, headers: { 'Content-Type': 'application/json', ...headers } });
const references = [
  { assetId: 'photo', kind: 'image', publicUrl: 'https://media.example.org/photo.png?signature=a%2Fb', note: '人物外观' },
  { assetId: 'motion', kind: 'video', publicUrl: 'https://media.example.org/motion.mp4', note: '镜头运动' },
  { assetId: 'voice', kind: 'audio', publicUrl: 'https://media.example.org/voice.mp3', note: '声音参考' },
];
const mp4 = () => { const bytes = Buffer.alloc(128); bytes.write('ftyp', 4, 'ascii'); return bytes; };
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('新版视频任务未进入预期状态');
}
async function setup(t, fetcher) {
  const root = await mkdtemp(path.join(tmpdir(), 'jingce-video-v3-')), store = new Store(root);
  await store.init(); await store.saveSettings(settings);
  const project = createProject({ title: '新版视频协议验证' });
  project.scenes = [{ id: 'clip', title: '镜头一', videoPrompt: job.prompt, references: [],
    generationDuration: 5, duration: 5, generationCount: 1, videoAssetId: '' }];
  await store.mutate(state => state.projects.push(project));
  let jobs = new VideoJobs(store, { submit: (connection, current) => submitVideo(connection, current, undefined, fetcher),
    poll: (connection, id) => pollVideo(connection, id, fetcher),
    download: async (_url, destination) => { await writeFile(destination, mp4()); return 128; } });
  await jobs.init();
  t.after(async () => { jobs.close(); await store.pending; await rm(root, { recursive: true, force: true }); });
  return { root, store, project, get jobs() { return jobs; },
    input: { sceneId: 'clip', model: ids[0], duration: 5, resolution: '720p', ratio: '16:9',
      requestMode: VIDEO_REQUEST_MODE, operationId: 'original-operation' },
    async restart() {
      jobs.close(); await store.pending;
      jobs = new VideoJobs(store, { submit: (connection, current) => submitVideo(connection, current, undefined, fetcher),
        poll: (connection, id) => pollVideo(connection, id, fetcher) });
      await jobs.init();
    } };
}

test('新版模型目录使用当前密钥，仅保留完整模型 ID；所有价格未知而非零元', async () => {
  let requests = 0;
  const result = await loadCatalog({ ...settings, baseUrl: PLATFORM + '/api/v3/' }, async (url, options) => {
    requests++; assert.equal(url, PLATFORM + '/v1/models'); assert.equal(options.method, undefined);
    assert.equal(options.headers.Authorization, 'Bearer ' + settings.apiKey); assert.equal(options.redirect, 'error');
    return reply({ data: [{ id: ids[2], price: 0.1 }, { id: 'grok-video' }, { id: ids[2] }, { id: ids[0] }] });
  });
  assert.deepEqual(result.map(model => model.name), [ids[2], ids[0]]); assert.equal(requests, 1);
  for (const model of result) {
    assert.equal(model.requestMode, VIDEO_REQUEST_MODE); assert.equal(model.pricingAvailable, false);
    assert.ok(model.tiers.every(tier => tier.price === null)); assert.equal(model.referenceSupport.verified, false);
    assert.equal(model.referenceSupport.imageLimit, null);
  }
  assert.equal(result[0].defaultResolution, '480p'); assert.equal(result[0].defaultDuration, 5);
  const check = await checkConnection(settings, async () => reply({ data: [{ id: ids[1] }] }));
  assert.equal(check.selectedModelVisible, false); assert.equal(check.readable, true);
});

test('报价未知的模型仍可选择参数；两个入口均显示待确认费用，旧模型需重新选择', () => {
  const p = videoParameters(catalog[1], { generationDuration: 12, resolution: '1080p', ratio: '9:16', generationCount: 3 });
  assert.equal(p.duration, 12); assert.equal(p.count, 3); assert.equal(p.tier.price, null); assert.equal(p.totalEstimate, null);
  assert.equal(videoEstimateText(p), '费用待平台确认'); assert.match(videoPricingNote(p), /3 个视频任务/);
  assert.doesNotMatch(videoPricingNote(p), /0 元|null|undefined/);
  const old = videoParameterControls(videoParameters(undefined), catalog, 5, false, 'sd-2.0-J2');
  assert.match(old.videoModel.options[0].label, /已不可选/); assert.equal(old.videoModel.disabled, false);
});

test('新版请求为一次 JSON POST，含完整模型名和显式参数，正确规范化版本前缀', async () => {
  let calls = 0;
  const result = await submitVideo({ ...settings, baseUrl: PLATFORM + '/api/v3' }, job, undefined, async (url, options) => {
    calls++; assert.equal(url, PLATFORM + '/api/v3/contents/generations/tasks'); assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json'); assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { model: ids[1], duration: 5, resolution: '720p', ratio: '16:9',
      content: [{ type: 'text', text: job.prompt }] });
    return reply({ id: 'v3-task-001', status: 'queued' });
  });
  assert.equal(calls, 1); assert.equal(result.taskId, 'v3-task-001'); assert.equal(result.state, 'queued');
  for (const base of ['https://other.invalid', PLATFORM + '/api/v3/api/v3', 'http://direct.beibeihai.xyz']) assert.throws(() => videoBaseUrl(base));
});

test('直连视频端点仍可选，并用于模型查询、创建和查询任务', async () => {
  const direct = 'https://direct.beibeihai.xyz';
  const calls = [];
  const directSettings = { ...settings, baseUrl: direct };
  const catalogResult = await loadCatalog(directSettings, async (url, options) => {
    calls.push({ url, method: options.method });
    return reply({ data: [{ id: ids[0] }] });
  });
  assert.equal(catalogResult[0].name, ids[0]);
  await submitVideo(directSettings, job, undefined, async (url, options) => {
    calls.push({ url, method: options.method, requestId: options.headers['X-Request-Id'] });
    return reply({ id: 'direct-task', status: 'queued' });
  });
  await pollVideo(directSettings, 'direct-task', async (url, options) => {
    calls.push({ url, method: options.method });
    return reply({ id: 'direct-task', status: 'completed', content: { video_url: 'https://media.example.org/direct.mp4' } });
  });
  assert.deepEqual(calls.map(call => [call.method || 'GET', call.url]), [
    ['GET', direct + '/v1/models'],
    ['POST', direct + '/api/v3/contents/generations/tasks'],
    ['GET', direct + '/api/v3/contents/generations/tasks/direct-task'],
  ]);
  assert.match(calls[1].requestId, /^[0-9a-f-]{36}$/);
});

test('整数秒数、分辨率、比例、文本及完整模型名不合法时在发送前拒绝', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return reply({ id: 'unexpected', status: 'queued' }); };
  const bad = [
    ...[undefined, null, '5', -1, 0, 5.5, 16, NaN, Infinity].map(duration => ({ duration })),
    ...['1K', '2K', '2048p', '720P'].map(resolution => ({ resolution })),
    { ratio: '21:9' }, { model: 'seedance-2.0-fast' }, { prompt: '  ' }, { requestMode: undefined },
  ];
  for (const changes of bad) await assert.rejects(submitVideo(settings, { ...job, ...changes }, undefined, fetcher));
  assert.equal(calls, 0);
  for (const duration of [1, 15]) assert.equal(buildVideoRequest({ ...job, duration }).duration, duration);
});

test('图片、视频、音频同入 content，按种类编号并保留链接和用途，不带旧字段', () => {
  const payload = buildVideoRequest({ ...job, references });
  assert.deepEqual(payload.content.slice(1), [
    { type: 'image_url', image_url: { url: references[0].publicUrl }, role: 'reference_image', name: '图片1' },
    { type: 'video_url', video_url: { url: references[1].publicUrl }, role: 'reference_video', name: '视频1' },
    { type: 'audio_url', audio_url: { url: references[2].publicUrl }, role: 'reference_audio', name: '音频1' },
  ]);
  assert.match(payload.content[0].text, /@音频1：声音参考/);
  assert.deepEqual(Object.keys(payload).sort(), ['content', 'duration', 'model', 'ratio', 'resolution']);
});

test('首帧和尾帧角色原样提交，任意首尾帧与音频冲突或重复首尾帧在 POST 前拒绝', async () => {
  const first = { ...references[0], role: 'first_frame' }, last = { ...references[0], assetId: 'last', role: 'end_frame' };
  assert.deepEqual(buildVideoRequest({ ...job, references: [first, last] }).content.slice(1).map(item => item.role), ['first_frame', 'end_frame']);
  for (const role of ['first_frame', 'last_frame', 'end_frame']) {
    await assert.rejects(submitVideo(settings, { ...job, references: [{ ...first, role }, references[2]] }, undefined, async () => assert.fail('不应提交')), /不能.*音频/);
  }
  for (const refs of [[first, { ...first, assetId: 'other' }], [last, { ...last, role: 'last_frame', assetId: 'other' }], [{ ...references[2], role: 'first_frame' }]]) {
    assert.throws(() => buildVideoRequest({ ...job, references: refs }), /首帧|尾帧|用途/);
  }
});

test('新版参考仍拒绝本机、内网、Base64 和包含模型密钥的 URL，不降级成纯文本', async () => {
  for (const publicUrl of ['file:///C:/person.png', 'data:image/png;base64,AAAA', 'https://127.0.0.1/photo', 'http://media.example.org/photo',
    'https://media.example.org/photo?key=' + settings.apiKey]) {
    await assert.rejects(submitVideo(settings, { ...job, references: [{ ...references[0], publicUrl }] }, undefined, async () => assert.fail('不应发送 POST')));
  }
});

test('成功严格读取 content.video_url；progress=100、旧结果字段和未识别状态不触发下载', () => {
  assert.equal(normalizeVideoV3Task({ status: 'running', progress: 100 }).state, 'running');
  const success = normalizeVideoV3Task({ id: 'task', status: 'succeeded', content: { video_url: 'https://media.example.org/result.mp4' } });
  assert.equal(success.state, 'completed'); assert.equal(success.url, 'https://media.example.org/result.mp4');
  const completed = normalizeVideoV3Task({ task_id: 'task-2', status: 'completed', content: { video_url: 'https://media.example.org/result-2.mp4' } });
  assert.equal(completed.state, 'completed'); assert.equal(completed.taskId, 'task-2');
  for (const data of [
    { status: 'succeeded', result_urls: ['https://media.example.org/result.mp4'] },
    { status: 'succeeded', content: { video_url: 'https://127.0.0.1/result.mp4' } },
    { status: 'SUCCESS', content: { video_url: 'https://media.example.org/result.mp4' } },
  ]) { const result = normalizeVideoV3Task(data); assert.equal(result.state, 'attention'); assert.equal(result.pollBlocked, true); assert.equal(result.url, ''); }
});

test('HTTP 200 中 failed/cancelled/expired 即使省略 id 也正常停止，保留并脱敏平台错误', async () => {
  for (const status of ['failed', 'cancelled', 'expired']) {
    const result = await pollVideo(settings, 'original-id', async () => reply({ status,
      error: { code: 'provider_failure', message: 'rejected ' + settings.apiKey } }));
    assert.equal(result.state, 'failed'); assert.equal(result.providerStatus, status); assert.equal(result.taskId, 'original-id');
    assert.equal(result.errorCode, 'provider_failure'); assert.doesNotMatch(JSON.stringify(result), /v3-original-test-secret/);
  }
});

test('查询固定原任务编号，返回冲突编号暂停查询，密钥不进入任务编号或下载地址', async () => {
  const result = await pollVideo(settings, 'original-id', async (url, options) => {
    assert.equal(url, PLATFORM + '/api/v3/contents/generations/tasks/original-id'); assert.equal(options.method, undefined);
    assert.equal(options.headers.Authorization, 'Bearer ' + settings.apiKey);
    return reply({ id: 'different-id', status: 'succeeded', content: { video_url: 'https://media.example.org/result.mp4' } });
  });
  assert.equal(result.taskId, 'original-id'); assert.equal(result.state, 'attention'); assert.equal(result.url, '');
  const hidden = normalizeVideoV3Task({ id: settings.apiKey, status: 'succeeded', content: { video_url: 'https://media.example.org/result?key=' + settings.apiKey } }, settings.apiKey);
  assert.equal(hidden.taskId, ''); assert.equal(hidden.url, ''); assert.doesNotMatch(JSON.stringify(hidden), /v3-original-test-secret/);
});

test('POST 的断线、超时、5xx、重定向、无 id 和非 JSON 均不自动重试', async () => {
  for (const result of [() => { throw new Error(settings.apiKey); }, () => reply({}, 408), () => reply({}, 502),
    () => new Response('', { status: 302 }), () => reply({ status: 'queued' }), () => new Response('not json')]) {
    let calls = 0;
    await assert.rejects(submitVideo(settings, job, undefined, async () => { calls++; return result(); }), error => {
      assert.ok(error instanceof UncertainSubmission); assert.match(error.code, /^SUBMISSION_/);
      assert.doesNotMatch(error.message, /v3-original-test-secret/); return true;
    });
    assert.equal(calls, 1);
  }
  await assert.rejects(submitVideo(settings, job, undefined, async () => reply({ error: { type: 'permission', message: settings.apiKey } }, 403)), error => error.providerHttpStatus === 403 && !error.message.includes(settings.apiKey));
});

test('服务入队不把未知价格当零元，非法参数拒绝，批次操作在目录变更后仍能找回', async t => {
  let posts = 0;
  const ctx = await setup(t, async (_url, options) => { posts++; return reply({ id: 'task-' + posts, status: 'queued' }); });
  for (const duration of ['5', 0, 5.5, 16]) await assert.rejects(ctx.jobs.startBatch(ctx.project.id, { ...ctx.input, duration }, catalog));
  const batch = await ctx.jobs.startBatch(ctx.project.id, { ...ctx.input, count: 2 }, catalog);
  await until(() => posts === 2 && !ctx.jobs.busy.size);
  assert.equal(batch.count, 2); assert.equal(batch.totalEstimate, null); assert.ok(batch.jobs.every(item => item.estimate === null));
  const duplicate = await ctx.jobs.startBatch(ctx.project.id, { ...ctx.input, model: 'now-invisible', count: 5 }, []);
  assert.deepEqual(duplicate.jobs.map(item => item.id), batch.jobs.map(item => item.id)); assert.equal(posts, 2);
});

test('创建失败不确定时保存时间、原参数、错误和操作编号；重复操作及重启不再 POST', async t => {
  let posts = 0;
  const ctx = await setup(t, async () => { posts++; return reply({}, 502); });
  const first = await ctx.jobs.start(ctx.project.id, ctx.input, catalog);
  await until(() => ctx.store.state.jobs[0].state === 'uncertain' && !ctx.jobs.busy.size);
  const record = ctx.store.state.jobs[0];
  assert.equal(record.submissionAttempts, 1); assert.equal(record.duration, 5); assert.equal(record.model, ids[0]);
  assert.equal(record.errorCode, 'SUBMISSION_HTTP_502'); assert.equal(record.providerHttpStatus, 502);
  assert.ok(Date.parse(record.submissionStartedAt)); assert.equal(record.operationId, ctx.input.operationId);
  await ctx.jobs.tick(); await ctx.restart();
  assert.equal((await ctx.jobs.start(ctx.project.id, ctx.input, [])).id, first.id); assert.equal(posts, 1);
  await assert.rejects(ctx.jobs.retryLookup(first.id), /未获得平台任务编号/);
});

test('更换默认密钥和重启后 GET 仍使用创建时的密钥与地址，10 秒前不自动轮询', async t => {
  const calls = [];
  const ctx = await setup(t, async (url, options) => {
    calls.push({ url, method: options.method || 'GET', auth: options.headers.Authorization });
    return reply({ id: 'pinned-task', status: options.method === 'POST' ? 'queued' : 'running', progress: 100 });
  });
  const first = await ctx.jobs.start(ctx.project.id, ctx.input, catalog);
  await until(() => !ctx.jobs.busy.size && ctx.store.state.jobs[0].state === 'queued');
  await ctx.store.saveSettings({ ...settings, apiKey: 'new-default-key' });
  await ctx.jobs.tick(); await ctx.restart(); assert.equal(calls.length, 1);
  await ctx.jobs.retryLookup(first.id); await until(() => calls.length === 2 && !ctx.jobs.busy.size);
  assert.equal(calls[1].auth, 'Bearer ' + settings.apiKey); assert.match(calls[1].url, /^https:\/\/sub\.beibeihai\.xyz\/api\/v3\//);
  assert.equal(calls.filter(item => item.method === 'POST').length, 1);
  const stateText = await readFile(path.join(ctx.root, 'projects.json'), 'utf8');
  assert.doesNotMatch(stateText, /v3-original-test-secret|new-default-key/);
  assert.equal((await ctx.store.videoTaskSettings(ctx.store.state.jobs[0])).apiKey, settings.apiKey);
});

test('旧服务迁移保留历史任务的原密钥与旧端点，新默认连接使用文档 sub 端点', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'jingce-video-migration-')), store = new Store(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  await store.init(); await store.saveSettings({ ...LEGACY_CONNECTION, apiKey: 'legacy-original-key' });
  await store.mutate(state => state.jobs.push({ id: 'legacy-job', requestMode: LEGACY_VIDEO_REQUEST_MODE,
    providerTaskId: 'legacy-task', state: 'attention', pollBlocked: true }));
  await store.migrateVideoSettings(); await store.saveSettings({ ...DEFAULT_CONNECTION, apiKey: 'new-default-key' });
  const connection = await store.videoTaskSettings(store.state.jobs[0]);
  assert.equal(connection.apiKey, 'legacy-original-key'); assert.equal(connection.baseUrl, LEGACY_PLATFORM);
  const result = await pollVideo(connection, 'legacy-task', async (url, options) => {
    assert.equal(url, LEGACY_PLATFORM + '/v1/video/generations/legacy-task'); assert.equal(options.headers.Authorization, 'Bearer legacy-original-key');
    return reply({ task_id: 'legacy-task', status: 'processing', progress: 55 });
  });
  assert.equal(result.state, 'running'); assert.equal((await store.settings()).baseUrl, PLATFORM);
});

test('GET 遇到 429 遵循 Retry-After，网络及 5xx 递增退避；不新增 POST', async t => {
  let posts = 0, polls = 0;
  const ctx = await setup(t, async (_url, options) => {
    if (options.method === 'POST') { posts++; return reply({ id: 'retry-task', status: 'queued' }); }
    polls++;
    if (polls === 1) return reply({ error: { type: 'rate_limit', message: 'later' } }, 429, { 'Retry-After': '45' });
    if (polls === 2) return reply({ error: { code: 'gateway', message: 'later' } }, 503);
    throw new Error('network');
  });
  const first = await ctx.jobs.start(ctx.project.id, ctx.input, catalog); await until(() => !ctx.jobs.busy.size);
  await ctx.jobs.refresh(ctx.store.state.jobs[0]);
  let record = ctx.store.state.jobs[0]; assert.equal(record.state, 'queued'); assert.equal(record.pollBlocked, false);
  assert.ok(Date.parse(record.nextPollAt) - Date.now() > 44000); assert.equal(record.pollFailures, 1);
  await ctx.jobs.tick(); assert.equal(polls, 1);
  await ctx.jobs.refresh(record); record = ctx.store.state.jobs[0];
  assert.equal(record.pollFailures, 2); assert.ok(Date.parse(record.nextPollAt) - Date.now() > 39000);
  await ctx.jobs.refresh(record); record = ctx.store.state.jobs[0];
  assert.equal(record.pollFailures, 3); assert.ok(Date.parse(record.nextPollAt) - Date.now() > 59000);
  assert.equal(record.providerTaskId, 'retry-task'); assert.equal(record.id, first.id); assert.equal(posts, 1);
});

for (const status of [401, 403, 404]) test(`GET ${status} 暂停自动查询，手动查询仅恢复原任务`, async t => {
  let posts = 0, polls = 0, recover = false;
  const ctx = await setup(t, async (_url, options) => {
    if (options.method === 'POST') { posts++; return reply({ id: 'blocked-task', status: 'queued' }); }
    polls++; return recover ? reply({ id: 'blocked-task', status: 'running' }) : reply({ error: { code: 'lookup_' + status, message: 'blocked' } }, status);
  });
  const first = await ctx.jobs.start(ctx.project.id, ctx.input, catalog); await until(() => !ctx.jobs.busy.size);
  await ctx.jobs.refresh(ctx.store.state.jobs[0]); assert.equal(ctx.store.state.jobs[0].state, 'attention');
  assert.equal(ctx.store.state.jobs[0].pollBlocked, true); assert.equal(ctx.store.state.jobs[0].providerTaskId, 'blocked-task');
  assert.equal(ctx.store.state.jobs[0].providerHttpStatus, status);
  await ctx.jobs.tick(); await ctx.restart(); assert.equal(polls, 1);
  recover = true; await ctx.jobs.retryLookup(first.id); await until(() => polls === 2 && !ctx.jobs.busy.size);
  assert.equal(ctx.store.state.jobs[0].state, 'running'); assert.equal(posts, 1);
});

test('音频引用及首尾帧用途经过保存、导出、导入和重编号保留，素材身份不漂移', () => {
  let project = createProject(); project.assets = references.map(ref => ({ id: ref.assetId, kind: ref.kind, name: ref.kind }));
  project = updateProject(project, { revision: 1, scenes: [{ id: 'clip', videoPrompt: '', references: [
    { ...references[0], role: 'first_frame' }, references[2], references[1],
  ] }] });
  let scene = project.scenes[0], refs = resolveSceneReferences(project, scene);
  assert.equal(refs[0].role, 'first_frame'); assert.equal(referenceLabel(refs, 1), '音频1');
  const inserted = insertReferenceMention(scene.videoPrompt, [], { start: 0, end: 0 }, refs[1], refs);
  scene.videoPrompt = inserted.prompt; scene.promptMentions = inserted.mentions;
  const reordered = [{ ...references[2], assetId: 'audio-other' }, ...refs];
  const remapped = remapPromptMentions(scene.videoPrompt, scene.promptMentions, refs, reordered);
  assert.match(remapped.prompt, /@音频2/);
  assert.equal(remapped.mentions[0].assetId, references[2].assetId);
  assert.equal(invalidPromptMentions({ videoPrompt: remapped.prompt, promptMentions: remapped.mentions }, reordered).length, 0);
  const exported = exportProject(project), restored = importProject(exported);
  assert.equal(restored.scenes[0].references[0].role, 'first_frame'); assert.equal(restored.scenes[0].references[1].kind, 'audio');
  assert.doesNotMatch(JSON.stringify(exported), /signature=|media\.example|v3-original-test-secret/);
  assert.equal(invalidPromptMentions(scene, refs).length, 0);
});

test('HTTP 新版完整链路：当前密钥目录、混合参考、单次 POST、原密钥 GET、无鉴权下载、素材入库及脱敏导出', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'jingce-video-v3-http-')), calls = [], downloads = [];
  const originalGet = https.get;
  https.get = (url, options, callback) => {
    downloads.push({ url: String(url), headers: options.headers });
    const stream = Readable.from([mp4()]); stream.statusCode = 200; stream.headers = { 'content-length': '128' };
    const request = new EventEmitter(); request.destroy = error => request.emit('error', error);
    queueMicrotask(() => callback(stream)); return request;
  };
  let app;
  t.after(async () => { if (app) await app.close(); https.get = originalGet; await rm(root, { recursive: true, force: true }); });
  const videoFetcher = async (url, options) => {
    calls.push({ url, method: options.method || 'GET', auth: options.headers.Authorization, body: options.body && JSON.parse(options.body) });
    if (url.endsWith('/v1/models')) return reply({ data: [{ id: options.headers.Authorization.includes('new-http-key') ? ids[2] : ids[1] }] });
    if (options.method === 'POST') return reply({ id: 'http-v3-task', status: 'queued' });
    return reply({ id: 'http-v3-task', status: 'succeeded', content: { video_url: 'https://8.8.8.8/result.mp4' } });
  };
  app = await createStudio({ root, videoFetcher, imageCatalog: [], textCatalog: [], tools: { ready: false },
    integrations: { download: downloadPublicVideo, verifyReferences: async refs => assert.equal(refs.length, 3) } });
  const url = await app.start(0);
  let bootstrap = await (await fetch(url + '/api/bootstrap')).json();
  assert.equal(bootstrap.catalog.length, 0); assert.equal(calls.length, 0);
  const send = async (route, method, body) => {
    const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token }, body: JSON.stringify(body) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  };
  await send('/api/settings', 'PUT', { apiKey: 'http-v3-private-key', baseUrl: PLATFORM + '/api/v3/', videoModel: ids[1] });
  bootstrap = await (await fetch(url + '/api/bootstrap')).json(); assert.deepEqual(bootstrap.catalog.map(model => model.name), [ids[1]]);
  let project = await send('/api/projects', 'POST', { title: '多媒体新版贯通验证' });
  const refs = [];
  for (const [kind, name] of [['image', '人物.png'], ['video', '运镜.mp4'], ['audio', '音色.mp3']]) {
    const bytes = Buffer.alloc(128);
    if (kind === 'image') Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    else if (kind === 'audio') bytes.write('ID3', 0, 'ascii'); else bytes.write('ftyp', 4, 'ascii');
    const uploaded = await fetch(url + '/api/projects/' + project.id + '/assets', { method: 'POST',
      headers: { 'X-Studio-Token': bootstrap.token, 'X-File-Name': encodeURIComponent(name) }, body: bytes });
    assert.equal(uploaded.status, 201); const value = await uploaded.json(); project = value.project;
    refs.push({ assetId: value.asset.id, kind, publicUrl: 'https://media.example.org/' + kind, note: '用途 ' + kind });
  }
  project = await send('/api/projects/' + project.id, 'PATCH', { revision: project.revision,
    scenes: [{ id: 'http-clip', videoPrompt: '参考@图片1人物和@视频1运镜，参考@音频1声音。', references: refs, duration: 5 }] });
  const input = { sceneId: 'http-clip', model: ids[1], duration: 5, resolution: '720p', ratio: '16:9',
    requestMode: VIDEO_REQUEST_MODE, operationId: 'http-original-operation' };
  const first = await send('/api/projects/' + project.id + '/jobs', 'POST', input);
  await until(() => app.store.state.jobs[0]?.state === 'queued' && !app.jobs.busy.size);
  await send('/api/settings', 'PUT', { apiKey: 'new-http-key', videoModel: ids[2] });
  bootstrap = await (await fetch(url + '/api/bootstrap')).json(); assert.deepEqual(bootstrap.catalog.map(model => model.name), [ids[2]]);
  const duplicate = await send('/api/projects/' + project.id + '/jobs', 'POST', input);
  assert.equal(duplicate.id, first.id);
  await app.jobs.retryLookup(first.id); await until(() => app.store.state.jobs[0].state === 'done' && !app.jobs.busy.size);
  const posts = calls.filter(call => call.method === 'POST'); assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body.content.slice(1).map(item => item.type), ['image_url', 'video_url', 'audio_url']);
  assert.ok(calls.filter(call => /\/tasks\//.test(call.url)).every(call => call.auth === 'Bearer http-v3-private-key'));
  assert.equal(downloads.length, 1); assert.equal(downloads[0].headers.Authorization, undefined);
  assert.doesNotMatch(JSON.stringify(downloads), /http-v3-private-key|new-http-key/);
  project = await (await fetch(url + '/api/projects/' + project.id)).json(); assert.equal(project.assets.length, 4);
  assert.equal(project.assets[3].kind, 'video'); assert.equal(project.scenes[0].videoAssetId, project.assets[3].id);
  const partial = await fetch(url + '/api/assets/' + project.assets[3].id, { headers: { Range: 'bytes=4-7' } });
  assert.equal(partial.status, 206); assert.equal(await partial.text(), 'ftyp');
  const exported = await (await fetch(url + '/api/projects/' + project.id + '/export')).text();
  const publicJobs = await (await fetch(url + '/api/projects/' + project.id + '/jobs')).text();
  const publicBootstrap = await (await fetch(url + '/api/bootstrap')).text();
  const state = await readFile(path.join(root, 'projects.json'), 'utf8');
  for (const body of [exported, publicJobs, publicBootstrap, state]) assert.doesNotMatch(body, /http-v3-private-key|new-http-key|Bearer /);
  assert.equal((await fetch(url + '/video-task-connections/' + first.id + '.private.json')).status, 404);
  assert.equal(first.estimate, null);
});

test('目录刷新或新密钥查询失败后不沿用旧权限目录，原任务仍保留原连接', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'jingce-video-directory-'));
  let fail = false, app;
  t.after(async () => { if (app) await app.close(); await rm(root, { recursive: true, force: true }); });
  app = await createStudio({ root, imageCatalog: [], textCatalog: [], tools: { ready: false }, videoFetcher: async () => {
    if (fail) return reply({ error: { code: 'unauthorized', message: 'bad key' } }, 401);
    return reply({ data: [{ id: ids[0] }] });
  } });
  const url = await app.start(0), bootstrap = await (await fetch(url + '/api/bootstrap')).json();
  const send = body => fetch(url + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token }, body: JSON.stringify(body) });
  assert.equal((await send({ apiKey: 'first-key' })).status, 200);
  assert.equal((await (await fetch(url + '/api/bootstrap')).json()).catalog.length, 1);
  fail = true; assert.equal((await send({ apiKey: 'second-key' })).status, 200);
  const current = await (await fetch(url + '/api/bootstrap')).json(); assert.equal(current.catalog.length, 0); assert.match(current.catalogError, /未读取成功/);
});

test('彻底删除已结束工程时同时清理对应的服务器私有任务密钥快照', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'jingce-video-private-cleanup-')), store = new Store(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  await store.init(); const project = createProject();
  await store.mutate(state => { state.projects.push(project); state.jobs.push({ id: 'finished-job', projectId: project.id, state: 'done' }); });
  await store.saveVideoTaskSettings('finished-job', settings);
  await store.setDeleted(project.id, true); await store.permanentlyDelete(project.id);
  await assert.rejects(readFile(store.videoTaskConnectionFile('finished-job')), error => error.code === 'ENOENT');
  assert.equal(store.state.jobs.length, 0);
});
