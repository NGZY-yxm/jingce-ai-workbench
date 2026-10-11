import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { createProject, draftPlan, touch, InputError } from '../lib/workflow.mjs';
import { VideoJobs } from '../lib/jobs.mjs';
import { LEGACY_CONNECTION as DEFAULT_CONNECTION, LEGACY_VIDEO_REQUEST_MODE as VIDEO_REQUEST_MODE, normalizeTask } from '../lib/providers.mjs';
const catalog = [{ name: 'model-a', defaultDuration: 5, defaultResolution: '720p', tiers: [
  { duration: 5, resolution: '720p', price: 1 }, { duration: 15, resolution: '720p', price: 3 },
  { duration: 5, resolution: '480p', price: .5 },
] }];
async function setup(t, integrations) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-job-')), store = new Store(root); await store.init();
  await store.saveSettings({ ...DEFAULT_CONNECTION, videoModel: 'model-a', apiKey: 'test-key' });
  const project = draftPlan(createProject({ brief: { product: '验证主题' } }));
  await store.mutate(state => state.projects.push(project));
  const jobs = new VideoJobs(store, integrations); await jobs.init();
  t.after(async () => { jobs.close(); await store.pending; await rm(root, { recursive: true, force: true }); });
  return { jobs, store, project, input: { sceneId: project.scenes[0].id, duration: 5, requestMode: VIDEO_REQUEST_MODE, operationId: 'operation-one' } };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('异步任务没有进入预期状态');
}

test('旧版表单、不支持的秒数和参考素材不创建任务；报价来自平台目录', async t => {
  let submissions = 0;
  const { jobs, store, project, input } = await setup(t, { submit: async () => {
    submissions++; return { taskId: 'provider-default', state: 'queued' };
  } });
  await assert.rejects(jobs.start(project.id, { ...input, requestMode: undefined }, catalog), /刷新/);
  for (const duration of [7, 31, 5.5]) await assert.rejects(jobs.start(project.id, { ...input, duration }, catalog), /模型参数/);
  await assert.rejects(jobs.start(project.id, { ...input, resolution: '1080p' }, catalog), /模型参数/);
  await store.update(project.id, current => {
    current.assets.push({ id: 'reference', kind: 'image', size: 64, mime: 'image/png', file: 'unused.png' }); return touch(current);
  });
  await assert.rejects(jobs.start(project.id, { ...input, referenceAssetId: 'reference' }, catalog), /参考/);
  await store.update(project.id, current => {
    current.scenes[0].references = [{ assetId: 'reference', kind: 'image', name: '参考图', note: '人物外观' },
      { assetId: '', kind: 'video', name: '待重新上传的视频', note: '运镜' }];
    return touch(current);
  });
  await assert.rejects(jobs.start(project.id, input, catalog), /参考/);
  await store.update(project.id, current => { current.scenes[0].references = []; return touch(current); });
  await assert.rejects(jobs.start(project.id, { ...input, references: [{ kind: 'video', assetId: 'video' }] }, catalog), /参考/);
  assert.equal(store.state.jobs.length, 0); assert.equal(submissions, 0);
  const job = await jobs.start(project.id, { ...input, duration: undefined }, catalog);
  await until(() => store.state.jobs[0]?.state === 'queued' && !jobs.busy.size);
  assert.equal(job.duration, 5); assert.equal(job.resolution, '720p'); assert.equal(job.estimate, 1);
  assert.equal(job.requestMode, VIDEO_REQUEST_MODE); assert.equal(submissions, 1);
});

test('非默认时长按对应档位报价、单次提交并持久化，模型变更不误提交', async t => {
  let submitted, submissions = 0;
  const { jobs, store, project, input } = await setup(t, { submit: async (_settings, job) => {
    submissions++; submitted = structuredClone(job);
    return { taskId: 'provider-15-seconds', state: 'queued' };
  } });
  await assert.rejects(jobs.start(project.id, { ...input, model: 'previous-model', duration: 15 }, catalog), /模型已变更/);
  assert.equal(store.state.jobs.length, 0); assert.equal(submissions, 0);
  const clipDuration = project.scenes[0].duration;
  await store.update(project.id, current => { current.scenes[0].generationDuration = 15; return touch(current); });
  const job = await jobs.start(project.id, { ...input, model: 'model-a', duration: 15 }, catalog);
  await until(() => store.state.jobs[0]?.state === 'queued' && !jobs.busy.size);
  assert.equal(job.duration, 15); assert.equal(job.estimate, 3); assert.equal(submitted.duration, 15);
  assert.equal(submitted.resolution, '720p'); assert.equal(submissions, 1);
  const duplicate = await jobs.start(project.id, { ...input, duration: 15 }, catalog);
  assert.equal(duplicate.id, job.id); assert.equal(submissions, 1);
  const recovered = new Store(store.root); await recovered.init();
  assert.equal(recovered.state.jobs[0].duration, 15); assert.equal(recovered.state.jobs[0].estimate, 3);
  assert.equal(recovered.get(project.id).scenes[0].generationDuration, 15);
  assert.equal(recovered.get(project.id).scenes[0].duration, clipDuration);
});

test('提交断线后不自动重发，同镜头及同 operationId 去重', async t => {
  let submissions = 0;
  const { jobs, store, project, input } = await setup(t, { submit: async () => { submissions++; throw new Error('network interrupted'); } });
  const first = await jobs.start(project.id, input, catalog);
  await until(() => store.state.jobs[0]?.state === 'uncertain' && !jobs.busy.size);
  await jobs.tick(); const duplicate = await jobs.start(project.id, { ...input, operationId: input.operationId }, catalog);
  assert.equal(duplicate.id, first.id); assert.equal(submissions, 1); assert.equal(duplicate.state, 'uncertain');
  await assert.rejects(jobs.retryLookup(first.id), /未获得/);
});

test('明确拒绝标记失败；进程恢复保留不确定提交及中断合成', async t => {
  const { jobs, store, project, input } = await setup(t, { submit: async () => { throw new InputError('拒绝', 401); } });
  await jobs.start(project.id, input, catalog); await until(() => store.state.jobs[0]?.state === 'failed' && !jobs.busy.size);
  jobs.close();
  await store.mutate(state => { state.jobs[0].state = 'submitting'; state.projects[0].exports.push({ id: 'old', state: 'running' }); });
  const recovered = new VideoJobs(store); await recovered.init(); recovered.close();
  assert.equal(store.state.jobs[0].state, 'uncertain'); assert.equal(store.get(project.id).exports[0].state, 'failed');
});

test('视频完成后入库；期间修改提示词时保留用户选片，公开任务不含签名地址', async t => {
  let submissions = 0;
  const { jobs, store, project, input } = await setup(t, {
    submit: async () => { submissions++; return { taskId: 'provider-1', state: 'queued', progress: null }; },
    poll: async () => ({ taskId: 'provider-1', state: 'completed', progress: 100, url: 'https://cdn.example.org/result?signature=private' }),
    download: async (_url, destination) => { const bytes = Buffer.alloc(64); bytes.write('ftyp', 4, 'ascii'); await writeFile(destination, bytes); return bytes.length; },
  });
  const job = await jobs.start(project.id, input, catalog);
  await until(() => store.state.jobs[0]?.state === 'queued' && !jobs.busy.size);
  const duplicate = await jobs.start(project.id, input, catalog); assert.equal(duplicate.id, job.id);
  await store.update(project.id, current => { current.scenes[0].videoPrompt = '用户的新提示词'; return touch(current); });
  await jobs.refresh(store.state.jobs[0]);
  const result = store.get(project.id);
  assert.equal(result.assets.length, 1); assert.equal(result.scenes[0].videoAssetId, '');
  assert.equal(jobs.list(project.id)[0].state, 'done'); assert.equal(submissions, 1);
  assert.doesNotMatch(JSON.stringify(jobs.list(project.id)), /signature|resultUrl|test-key/);
});

test('下载失败只重试下载；不重新提交视频生成', async t => {
  let submissions = 0, downloads = 0;
  const { jobs, store, project, input } = await setup(t, {
    submit: async () => { submissions++; return { taskId: 'provider-2', state: 'completed', url: 'https://cdn.example.org/v.mp4' }; },
    download: async (_url, destination) => { downloads++; if (downloads === 1) throw new Error('download interrupted'); const bytes = Buffer.alloc(64); bytes.write('ftyp', 4, 'ascii'); await writeFile(destination, bytes); return bytes.length; },
  });
  await jobs.start(project.id, input, catalog); await until(() => store.state.jobs[0]?.state === 'download_pending' && !jobs.busy.size);
  await jobs.refresh(store.state.jobs[0]); assert.equal(submissions, 1); assert.equal(downloads, 2);
  assert.equal(store.state.jobs[0].state, 'done'); assert.ok(store.get(project.id).scenes[0].videoAssetId);
});

test('已受理的慢任务超过一小时继续查询，包装结果完成后保存视频，不重新生成', async t => {
  let submissions = 0, polls = 0;
  const { jobs, store, project, input } = await setup(t, {
    submit: async () => { submissions++; return { taskId: 'gateway-slow', state: 'queued', progress: null }; },
    poll: async () => {
      polls++;
      return normalizeTask({ data: { task_id: 'gateway-slow', status: polls === 1 ? 'IN_PROGRESS' : 'SUCCESS',
        progress: polls === 1 ? '50%' : '100%', start_time: 1791184835,
        data: { id: 'upstream-slow', status: polls === 1 ? 'in_progress' : 'completed',
          result_urls: polls === 1 ? [] : ['https://cdn.example.org/result.mp4'] },
      } });
    },
    download: async (_url, destination) => { const bytes = Buffer.alloc(64); bytes.write('ftyp', 4, 'ascii'); await writeFile(destination, bytes); return bytes.length; },
  });
  await jobs.start(project.id, input, catalog);
  await until(() => store.state.jobs[0]?.state === 'queued' && !jobs.busy.size);
  await store.mutate(state => {
    state.jobs[0].createdAt = new Date(Date.now() - 2 * 3600000).toISOString();
    state.jobs[0].nextPollAt = new Date(Date.now() - 1).toISOString();
  });
  await jobs.tick(); await until(() => polls === 1 && !jobs.busy.size);
  const running = jobs.list(project.id)[0];
  assert.equal(running.state, 'running'); assert.equal(running.progress, 50);
  assert.equal(running.providerTaskId, 'gateway-slow'); assert.equal(running.providerStatus, 'IN_PROGRESS');
  assert.ok(Number.isFinite(Date.parse(running.lastCheckedAt)));
  await jobs.refresh(store.state.jobs[0]);
  assert.equal(jobs.list(project.id)[0].state, 'done'); assert.equal(store.get(project.id).assets.length, 1);
  assert.equal(polls, 2); assert.equal(submissions, 1); assert.equal(store.state.jobs.length, 1);
});

test('删除正在查询的记录后仍去重、保存视频和选片；重启后可恢复记录', async t => {
  let submissions = 0, resolvePoll;
  const { jobs, store, project, input } = await setup(t, {
    submit: async () => { submissions++; return { taskId: 'provider-hidden', state: 'queued', progress: null }; },
    poll: async () => new Promise(resolve => { resolvePoll = resolve; }),
    download: async (_url, destination) => { const bytes = Buffer.alloc(64); bytes.write('ftyp', 4, 'ascii'); await writeFile(destination, bytes); return bytes.length; },
  });
  const original = await jobs.start(project.id, input, catalog);
  await until(() => store.state.jobs[0]?.state === 'queued' && !jobs.busy.size);
  const pending = jobs.refresh(store.state.jobs[0]);
  await until(() => Boolean(resolvePoll));
  await jobs.setDeleted(original.id, true);
  assert.equal(jobs.list(project.id).length, 0);
  const duplicate = await jobs.start(project.id, { ...input, operationId: input.operationId }, catalog);
  assert.equal(duplicate.id, original.id); assert.ok(duplicate.deletedAt); assert.equal(submissions, 1);
  resolvePoll({ taskId: 'provider-hidden', state: 'completed', progress: 100, url: 'https://cdn.example.org/result?signature=private' });
  await pending;
  assert.equal(jobs.list(project.id).length, 0);
  assert.equal(jobs.list(project.id, true)[0].state, 'done');
  const current = store.get(project.id), asset = current.assets[0];
  assert.equal(current.scenes[0].videoAssetId, asset.id); assert.equal(asset.jobId, original.id);
  assert.equal((await readFile(path.join(store.root, 'assets', asset.file))).length, 64);
  jobs.close();
  const recoveredStore = new Store(store.root); await recoveredStore.init();
  const recoveredJobs = new VideoJobs(recoveredStore); await recoveredJobs.init(); recoveredJobs.close();
  assert.equal(recoveredJobs.list(project.id).length, 0);
  assert.equal(recoveredJobs.list(project.id, true)[0].id, original.id);
  await recoveredJobs.setDeleted(original.id, false);
  assert.equal(recoveredJobs.list(project.id)[0].state, 'done');
  assert.equal(recoveredStore.get(project.id).scenes[0].videoAssetId, asset.id);
  assert.doesNotMatch(JSON.stringify(recoveredJobs.list(project.id, true)), /signature|resultUrl|test-key/);
});


test('未同步的旧工程仍从画布读取参考素材，不能绕过混合生成检查入队', async t => {
  let submissions = 0;
  const { jobs, store, project, input } = await setup(t, { submit: async () => { submissions++; return { taskId: 'unexpected', state: 'queued' }; } });
  await store.update(project.id, current => {
    current.assets.push({ id: 'linked-reference', kind: 'image', name: '人物.png' });
    current.scenes[0].references = [];
    current.graph = { nodes: [{ id: 'picture', kind: 'image', assetId: 'linked-reference' },
      { id: 'scene-video', kind: 'video', sceneId: current.scenes[0].id }], links: [{ id: 'reference-link', from: 'picture', to: 'scene-video' }] };
    return touch(current);
  });
  await assert.rejects(jobs.startBatch(project.id, { ...input, count: 3, references: [] }, catalog), /参考/);
  assert.equal(store.state.jobs.length, 0); assert.equal(submissions, 0);
});

test('未知、未绑定、断开及格式错误的 @ 素材引用在入队前拒绝', async t => {
  let submissions = 0;
  const { jobs, store, project, input } = await setup(t, { submit: async () => { submissions++; return { taskId: 'unexpected', state: 'queued' }; } });
  const cases = [
    { videoPrompt: '@图片2的人物', promptMentions: [], pattern: /没有对应/ },
    { videoPrompt: '@视频1的动作', promptMentions: [], pattern: /没有对应/ },
    { videoPrompt: '@图片1（已断开）的人物', promptMentions: [{ start: 0, end: 9, key: 'node:removed-picture', assetId: 'missing' }], pattern: /断开/ },
    { videoPrompt: '@图片1的人物', promptMentions: [{ start: 0, end: 4, key: 'node:removed-picture', assetId: 'missing' }], pattern: /断开/ },
    { videoPrompt: '@图片1的人物', promptMentions: [{ start: 0, end: 99, key: 'node:removed-picture' }], pattern: /位置/ },
  ];
  for (const item of cases) {
    await store.update(project.id, current => { Object.assign(current.scenes[0], { videoPrompt: item.videoPrompt, promptMentions: item.promptMentions, references: [] }); return touch(current); });
    await assert.rejects(jobs.startBatch(project.id, { ...input, count: 2 }, catalog), item.pattern);
    assert.equal(store.state.jobs.length, 0); assert.equal(submissions, 0);
  }
});

// Place a save ahead of generation in the real Store queue, without sleep-based timing.
async function startBehindSave(store, projectId, update, start) {
  let release, entered, enqueued;
  const gate = new Promise(resolve => { release = resolve; });
  const saveEntered = new Promise(resolve => { entered = resolve; });
  const startEnqueued = new Promise(resolve => { enqueued = resolve; });
  const originalMutate = store.mutate;
  const saving = store.update(projectId, async current => {
    entered(); await gate; return update(current);
  });
  await saveEntered;
  store.mutate = function(operation) {
    const pending = originalMutate.call(this, operation); enqueued(); return pending;
  };
  try {
    const outcome = start().then(value => ({ value }), error => ({ error }));
    assert.equal(await Promise.race([startEnqueued.then(() => true), outcome.then(() => false)]), true,
      'generation must validate inside the store transaction');
    release(); await saving;
    return await outcome;
  } finally {
    release(); store.mutate = originalMutate; await saving;
  }
}

test('连线保存尚未提交时生成排在其后，使用最新参考而不创建收费纯文字任务', async t => {
  let submissions = 0;
  const { jobs, store, project, input } = await setup(t, { submit: async () => {
    submissions++; return { taskId: 'unexpected', state: 'queued' };
  } });
  const outcome = await startBehindSave(store, project.id, current => {
    current.assets.push({ id: 'pending-reference', kind: 'image', name: '人物.png' });
    current.graph = { nodes: [{ id: 'material', kind: 'image', assetId: 'pending-reference' },
      { id: 'scene-video', kind: 'video', sceneId: current.scenes[0].id }],
      links: [{ id: 'new-link', from: 'material', to: 'scene-video' }] };
    current.scenes[0].references = []; return touch(current);
  }, () => jobs.startBatch(project.id, { ...input, count: 3, references: [] }, catalog));
  assert.ok(outcome.error instanceof InputError); assert.match(outcome.error.message, /参考/);
  assert.equal(store.get(project.id).graph.links.length, 1);
  assert.equal(store.state.jobs.length, 0); assert.equal(submissions, 0);
});

test('前置保存新增的无效 @ 引用在同一入队事务内拒绝，单视频入口也不误提交', async t => {
  let submissions = 0;
  const { jobs, store, project, input } = await setup(t, { submit: async () => {
    submissions++; return { taskId: 'unexpected', state: 'queued' };
  } });
  const outcome = await startBehindSave(store, project.id, current => {
    current.scenes[0].videoPrompt = '@图片1的人物'; current.scenes[0].promptMentions = [];
    return touch(current);
  }, () => jobs.start(project.id, input, catalog));
  assert.ok(outcome.error instanceof InputError); assert.match(outcome.error.message, /没有对应/);
  assert.equal(store.state.jobs.length, 0); assert.equal(submissions, 0);
});

test('入队快照使用前置保存后的提示词、默认候选数、画幅及选片，报价与重复操作保持不变', async t => {
  let submissions = 0;
  const { jobs, store, project, input } = await setup(t, { submit: async () => {
    submissions++; return { taskId: 'unexpected', state: 'queued' };
  } });
  jobs.close();
  const outcome = await startBehindSave(store, project.id, current => {
    current.scenes[0].videoPrompt = '最新保存的人物行走提示词'; current.scenes[0].generationCount = 2;
    current.scenes[0].videoAssetId = 'existing-selection'; current.brief.ratio = '16:9'; return touch(current);
  }, () => jobs.startBatch(project.id, { ...input, duration: 15 }, catalog));
  assert.equal(outcome.error, undefined); assert.equal(outcome.value.count, 2);
  assert.equal(outcome.value.totalEstimate, 6);
  for (const job of store.state.jobs) {
    assert.equal(job.prompt, '最新保存的人物行走提示词'); assert.equal(job.ratio, '16:9');
    assert.equal(job.selectionAtStart, 'existing-selection'); assert.equal(job.duration, 15);
    assert.equal(job.estimate, 3); assert.equal(job.state, 'waiting');
  }
  const duplicate = await jobs.startBatch(project.id, { ...input, duration: 15, count: 5 }, catalog);
  assert.deepEqual(duplicate.jobs.map(job => job.id), outcome.value.jobs.map(job => job.id));
  assert.equal(store.state.jobs.length, 2); assert.equal(submissions, 0);
});


test('COS 就绪时先自动准备本机参考，再提交视频生成', async t => {
  let prepared = 0, submissions = 0, submitted;
  const { jobs, store, project, input } = await setup(t, {
    storageSettings: async () => ({ ready: true }),
    prepareReferences: async job => {
      prepared++;
      return job.references.map(reference => ({ ...reference, publicUrl: 'https://cdn.example.org/' + reference.assetId + '.png' }));
    },
    verifyReferences: async () => {},
    submit: async (_settings, job) => { submissions++; submitted = structuredClone(job); return { taskId: 'prepared-task', state: 'queued' }; },
  });
  const referenceCatalog = [{ ...catalog[0], ratios: ['9:16'], referenceSupport: { imageLimit: 2, videoLimit: 0 } }];
  await store.update(project.id, current => {
    current.assets.push({ id: 'local-reference', kind: 'image', name: '人物.png', file: 'local-reference.png', mime: 'image/png', size: 8 });
    current.scenes[0].references = [{ assetId: 'local-reference', kind: 'image', name: '人物.png', note: '人物外观' }];
    return touch(current);
  });
  const batch = await jobs.startBatch(project.id, input, referenceCatalog);
  await until(() => store.state.jobs[0]?.state === 'queued' && !jobs.busy.size);
  assert.equal(batch.jobs[0].id, store.state.jobs[0].id);
  assert.equal(prepared, 1);
  assert.equal(submissions, 1);
  assert.equal(submitted.references[0].publicUrl, 'https://cdn.example.org/local-reference.png');
  assert.equal(store.state.jobs[0].autoPrepareReferences, false);
});

test('单个视频的参考素材等待上传时，多轮调度仍只上传和提交一次', async t => {
  let release;
  const uploading = new Promise(resolve => { release = resolve; });
  let prepared = 0, activePreparations = 0;
  const posts = [];
  const { jobs, store, project, input } = await setup(t, {
    storageSettings: async () => ({ ready: true }),
    prepareReferences: async job => {
      prepared++; activePreparations++;
      try {
        await uploading;
        return job.references.map(reference => ({ ...reference, publicUrl: 'https://cdn.example.org/reference.png' }));
      } finally { activePreparations--; }
    },
    verifyReferences: async () => {},
    submit: async (_settings, job) => {
      const taskId = `provider-${posts.length + 1}`;
      posts.push({ jobId: job.id, taskId });
      return { taskId, state: 'queued' };
    },
    poll: async (_settings, taskId) => ({ taskId, state: 'queued' }),
  });
  const referenceCatalog = [{ ...catalog[0], ratios: ['9:16'], referenceSupport: { imageLimit: 2, videoLimit: 0 } }];
  const workers = [], runPrepare = jobs.runPrepare.bind(jobs);
  jobs.runPrepare = (...args) => {
    const worker = runPrepare(...args); workers.push(worker); return worker;
  };
  await store.update(project.id, current => {
    current.assets.push({ id: 'slow-reference', kind: 'image', name: '人物.png', file: 'reference.png', mime: 'image/png', size: 8 });
    current.scenes[0].references = [{ assetId: 'slow-reference', kind: 'image', name: '人物.png' }];
    return touch(current);
  });
  try {
    await jobs.startBatch(project.id, { ...input, count: 1 }, referenceCatalog);
    await until(() => prepared > 0);
    for (let i = 0; i < 3; i++) await jobs.tick();
    release();
    await Promise.all(workers);
    await until(() => activePreparations === 0 && store.state.jobs[0].state === 'queued' && !jobs.busy.size);
    await store.pending;
    t.diagnostic(JSON.stringify({ localJobs: store.state.jobs.length, prepared, providerPosts: posts.length,
      providerTaskIds: posts.map(post => post.taskId), retainedTaskId: store.state.jobs[0].providerTaskId }));
    assert.equal(prepared, 1, 'already preparing work must not be reserved again');
    assert.equal(posts.length, 1, 'one local candidate must make one provider POST');
    assert.equal(store.state.jobs[0].providerTaskId, posts[0].taskId);
  } finally {
    release(); jobs.close();
    await Promise.allSettled(workers);
    await until(() => activePreparations === 0 && !jobs.busy.size);
    await store.pending;
  }
});

for (const count of [2, 5]) test(`${count} 个候选上传期间新增批次和查询结束，仍每个候选只提交一次`, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; }), posts = [], prepared = [];
  const { jobs, store, project, input } = await setup(t, {
    storageSettings: async () => ({ ready: true }),
    prepareReferences: async job => {
      prepared.push(job.id); await gate;
      return job.references.map(reference => ({ ...reference, publicUrl: 'https://cdn.example.org/reference.png' }));
    },
    verifyReferences: async () => {},
    submit: async (_settings, job) => { posts.push(job.id); return { taskId: job.id, state: 'queued' }; },
    poll: async (_settings, taskId) => ({ taskId, state: 'queued' }),
  });
  const workers = [], runPrepare = jobs.runPrepare.bind(jobs);
  jobs.runPrepare = (...args) => { const worker = runPrepare(...args); workers.push(worker); return worker; };
  const referenceCatalog = [{ ...catalog[0], ratios: ['9:16'], referenceSupport: { imageLimit: 2, videoLimit: 0 } }];
  await store.update(project.id, current => {
    current.assets.push({ id: 'slow-reference', kind: 'image', name: '人物.png', file: 'reference.png', mime: 'image/png', size: 8 });
    current.scenes[0].references = [{ assetId: 'slow-reference', kind: 'image', name: '人物.png' }]; return touch(current);
  });
  try {
    const batch = await jobs.startBatch(project.id, { ...input, count }, referenceCatalog);
    await until(() => prepared.length >= count);
    assert.equal(posts.length, 0);
    // The first batch keeps its reference snapshot even after the scene changes.
    await store.update(project.id, current => { current.scenes[0].references = []; return touch(current); });
    const other = await jobs.startBatch(project.id, { ...input, count: 1, operationId: 'explicit-new-batch' }, referenceCatalog);
    await until(() => store.state.jobs.find(job => job.id === other.jobs[0].id)?.state === 'queued');
    await jobs.refresh(store.state.jobs.find(job => job.id === other.jobs[0].id));
    for (let i = 0; i < 3; i++) await jobs.tick();
    release(); await Promise.all(workers);
    await until(() => store.state.jobs.every(job => job.state === 'queued') && !jobs.busy.size);
    assert.equal(prepared.length, count); assert.equal(new Set(prepared).size, count);
    assert.equal(posts.length, count + 1); assert.equal(new Set(posts).size, count + 1);
    assert.ok(batch.jobs.every(job => posts.filter(id => id === job.id).length === 1));
    assert.ok(store.state.jobs.every(job => job.submissionAttempts === 1 && job.providerTaskId === job.id));
  } finally {
    release(); jobs.close(); await Promise.allSettled(workers); await store.pending;
  }
});

test('并发和过期的提交调用共用持久化凭据，只发出一次平台请求且保留原编号', async t => {
  let release, posts = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { jobs, store, project, input } = await setup(t, {
    submit: async (_settings, job) => {
      posts++;
      const disk = JSON.parse(await readFile(path.join(store.root, 'projects.json'), 'utf8'));
      const saved = disk.jobs.find(item => item.id === job.id);
      assert.equal(saved.submissionAttempts, 1);
      assert.ok(saved.submissionStartedAt, 'claim must reach disk before the provider request');
      await gate; return { taskId: 'original-provider-id', state: 'queued' };
    },
  });
  jobs.close();
  const candidate = await jobs.start(project.id, input, catalog);
  await jobs.patch(candidate.id, { state: 'submitting' }); jobs.closed = false;
  const settings = await store.settings();
  // A second worker object has no shared in-memory lock; it must lose the
  // transaction claim as well. This is deliberately not a cross-process test.
  const peer = new VideoJobs(store, { submit: async () => {
    posts++; await gate; return { taskId: 'unexpected-duplicate', state: 'queued' };
  } });
  const workers = Array.from({ length: 4 }, () => jobs.runSubmit(candidate, settings));
  workers.push(peer.runSubmit(candidate, settings));
  try {
    await until(() => posts > 0);
    assert.equal(posts, 1); assert.ok(jobs.busy.has(candidate.id), 'duplicate callers must not release the original worker');
    release(); await Promise.all(workers);
    await jobs.runSubmit(candidate, settings);
    assert.equal(posts, 1);
    assert.equal(store.state.jobs[0].providerTaskId, 'original-provider-id');
    assert.equal(jobs.list(project.id)[0].submissionAttempts, 1);
  } finally { release(); jobs.close(); peer.close(); await Promise.allSettled(workers); await store.pending; }
});

test('重启恢复遗留等待或准备状态时，有过提交凭据的任务只核对而不再生成', async t => {
  let posts = 0, lookups = 0;
  const { jobs, store, project, input } = await setup(t); jobs.close();
  await store.mutate(state => {
    const now = new Date().toISOString();
    for (const status of ['waiting', 'preparing', 'submitting']) state.jobs.push({
      id: `attempted-${status}`, projectId: project.id, sceneId: input.sceneId, state: status,
      submissionAttempts: 1, submissionStartedAt: now, createdAt: now, updatedAt: now, providerTaskId: '',
    });
    state.jobs.push({ id: 'accepted-preparing', projectId: project.id, sceneId: input.sceneId, state: 'preparing',
      providerTaskId: 'known-task', createdAt: now, updatedAt: now });
  });
  const disk = new Store(store.root); await disk.init();
  const restarted = new VideoJobs(disk, {
    submit: async () => { posts++; return { taskId: 'must-not-resend', state: 'queued' }; },
    poll: async (_settings, taskId) => { lookups++; return { taskId, state: 'queued' }; },
  });
  try {
    await restarted.init(); await until(() => !restarted.busy.size);
    for (let i = 0; i < 2; i++) await restarted.tick();
    await until(() => !restarted.busy.size);
    assert.ok(disk.state.jobs.filter(job => job.id.startsWith('attempted-')).every(job => job.state === 'uncertain' && job.submissionAttempts === 1));
    assert.equal(disk.state.jobs.find(job => job.id === 'accepted-preparing').state, 'queued');
    assert.ok(lookups > 0); assert.equal(posts, 0);
  } finally { restarted.close(); await until(() => !restarted.busy.size); await disk.pending; }
});

test('参考素材自动准备失败时不调用视频平台提交', async t => {
  let submissions = 0;
  const { jobs, store, project, input } = await setup(t, {
    storageSettings: async () => ({ ready: true }),
    prepareReferences: async () => { throw new InputError('COS 模拟上传失败'); },
    verifyReferences: async () => {},
    submit: async () => { submissions++; return { taskId: 'must-not-submit', state: 'queued' }; },
  });
  const referenceCatalog = [{ ...catalog[0], ratios: ['9:16'], referenceSupport: { imageLimit: 2, videoLimit: 0 } }];
  await store.update(project.id, current => {
    current.assets.push({ id: 'local-reference', kind: 'image', name: '人物.png', file: 'local-reference.png', mime: 'image/png', size: 8 });
    current.scenes[0].references = [{ assetId: 'local-reference', kind: 'image', name: '人物.png' }];
    return touch(current);
  });
  await jobs.startBatch(project.id, input, referenceCatalog);
  await until(() => store.state.jobs[0]?.state === 'failed' && !jobs.busy.size);
  assert.equal(submissions, 0);
  assert.match(store.state.jobs[0].message, /尚未提交视频生成/);
});

test('程序在素材准备阶段关闭后恢复等待且不自动重发', async t => {
  const { jobs, store, project, input } = await setup(t);
  jobs.close();
  await store.mutate(state => {
    state.jobs.push({ id: 'preparing-restart', projectId: project.id, sceneId: input.sceneId, state: 'preparing',
      autoPrepareReferences: true, references: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const restarted = new VideoJobs(store); restarted.close(); await restarted.init();
  t.after(() => restarted.close());
  const recovered = store.state.jobs.find(job => job.id === 'preparing-restart');
  assert.equal(recovered.state, 'waiting');
  assert.match(recovered.message, /素材准备期间关闭/);
});
