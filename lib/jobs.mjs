import { randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { InputError, touch, normalizeReferences, REFERENCE_PREPARATION_LIMIT, MAX_GENERATION_COUNT } from './workflow.mjs';
import { submitVideo, pollVideo, buildVideoRequest, VIDEO_REQUEST_MODE, LEGACY_VIDEO_REQUEST_MODE, connectionForVideoJob } from './providers.mjs';
import { resolveSceneReferences } from '../public/reference-model.js';
import { referenceCapabilities, referenceRequestIssue } from '../public/reference-api.js';
import { invalidPromptMentions } from '../public/prompt-mentions.js';
import { downloadPublicVideo, detectMedia, verifyPublicReferenceUrls } from './media.mjs';

export const publicJob = job => ({ id: job.id, projectId: job.projectId, sceneId: job.sceneId,
  operationId: job.operationId || '',
  batchId: job.batchId || job.id, variantIndex: job.variantIndex || 1, variantCount: job.variantCount || 1,
  model: job.model, duration: job.duration, resolution: job.resolution, state: job.state,
  requestMode: job.requestMode || '',
  referenceCount: Array.isArray(job.references) ? job.references.length : 0,
  ratio: job.ratio || '',
  deletedAt: job.deletedAt || null,
  providerStatus: job.providerStatus || '', lastCheckedAt: job.lastCheckedAt || null,
  providerSubmittedAt: job.providerSubmittedAt || null, providerStartedAt: job.providerStartedAt || null,
  providerFinishedAt: job.providerFinishedAt || null,
  errorCode: job.errorCode || '', pollBlocked: Boolean(job.pollBlocked), nextPollAt: job.nextPollAt || null,
  providerHttpStatus: job.providerHttpStatus || null,
  submissionStartedAt: job.submissionStartedAt || null, submissionAttempts: job.submissionAttempts ?? null,
  message: job.message || '', progress: job.progress ?? null, estimate: job.estimate,
  createdAt: job.createdAt, updatedAt: job.updatedAt, providerTaskId: job.providerTaskId || '', assetId: job.assetId || '' });

const batchResult = jobs => {
  const ordered = [...jobs].sort((a, b) => (a.variantIndex || 1) - (b.variantIndex || 1));
  return { batchId: ordered[0].batchId || ordered[0].id, count: ordered.length,
    totalEstimate: ordered.every(job => Number.isFinite(job.estimate))
      ? Number(ordered.reduce((sum, job) => sum + job.estimate, 0).toFixed(6)) : null, jobs: ordered.map(publicJob) };
};

const hasSubmission = job => Boolean(job.providerTaskId || job.submissionStartedAt || job.submissionAttempts > 0);

export class VideoJobs {
  constructor(store, integrations = {}) {
    this.store = store; this.busy = new Set(); this.submitting = new Set(); this.closed = false; this.dispatchTask = null;
    this.submit = integrations.submit || submitVideo;
    this.poll = integrations.poll || pollVideo;
    this.downloadVideo = integrations.download || downloadPublicVideo;
    this.verifyReferences = integrations.verifyReferences || verifyPublicReferenceUrls;
    this.prepareReferences = integrations.prepareReferences || null;
    this.storageSettings = integrations.storageSettings || (async () => ({ ready: false }));
  }
  async init() {
    for (const job of this.store.state.jobs) await this.store.videoTaskSettings(job);
    await this.store.mutate(state => {
      for (const job of state.jobs) {
        if (['waiting', 'preparing', 'submitting'].includes(job.state) && hasSubmission(job)) {
          job.state = job.providerTaskId ? 'queued' : 'uncertain';
          job.message = job.providerTaskId ? '已提交的任务继续查询平台结果，不会重新生成。'
            : '程序在提交期间关闭。请先核对平台任务记录，避免重复收费。';
        } else if (job.state === 'preparing') {
          job.state = 'waiting'; job.message = '程序在素材准备期间关闭，已恢复等待；不会重复提交视频生成。';
        } else if (job.state === 'submitting' && !job.providerTaskId) {
          job.state = 'uncertain'; job.message = '程序在提交期间关闭。请先核对平台任务记录，避免重复收费。';
        } else if (job.state === 'downloading') job.state = 'download_pending';
      }
      for (const project of state.projects) {
        for (const output of project.exports.filter(item => item.state === 'running')) {
          output.state = 'failed'; output.message = '上次合成被关闭中断，可重新合成。'; touch(project);
        }
      }
    });
    this.timer = setInterval(() => this.tick().catch(() => {}), 10000);
    this.timer.unref();
    await this.tick();
  }
  close() { this.closed = true; clearInterval(this.timer); }
  list(projectId, includeDeleted = false) {
    return this.store.state.jobs.filter(job => job.projectId === projectId && (includeDeleted || !job.deletedAt)).map(publicJob).reverse();
  }
  async setDeleted(id, deleted) {
    const job = await this.store.mutate(state => {
      const current = state.jobs.find(item => item.id === id);
      if (!current) throw new InputError('找不到这个生成任务。', 404);
      current.deletedAt = deleted ? current.deletedAt || new Date().toISOString() : null;
      return current;
    });
    // Keep task tracking and submission deduplication independent of list visibility.
    return publicJob(job);
  }
  async patch(id, patch) {
    return this.store.mutate(state => {
      const job = state.jobs.find(item => item.id === id);
      if (!job) throw new InputError('找不到这个生成任务。', 404);
      Object.assign(job, patch, { updatedAt: new Date().toISOString() });
      return job;
    });
  }
  async start(projectId, input, catalog) {
    if (input.count != null && input.count !== 1) throw new InputError('多个候选视频请使用批量生成接口。');
    return (await this.startBatch(projectId, { ...input, count: 1 }, catalog)).jobs[0];
  }
  async startBatch(projectId, input, catalog) {
    const operationId = String(input.operationId || randomUUID()).slice(0, 100);
    const previous = this.store.state.jobs.find(job => job.operationId === operationId && job.projectId === projectId);
    if (previous) return batchResult(previous.batchId ? this.store.state.jobs.filter(job => job.batchId === previous.batchId && job.projectId === projectId) : [previous]);
    const settings = await this.store.settings();
    if (!settings.apiKey) throw new InputError('先在模型连接页保存 API Key，再生成视频。');
    const storage = await this.storageSettings();
    const saved = await this.store.mutate(async state => {
      // Validate and snapshot the project after every preceding save commits.
      // A concurrent reference-link save must never become a paid text-only job.
      const project = state.projects.find(item => item.id === projectId);
      if (!project) throw new InputError('找不到这个工程。', 404);
      if (project.deletedAt) throw new InputError('这个工程已删除，请先恢复后再生成视频。', 410);
      const existing = state.jobs.find(item => item.operationId === operationId && item.projectId === projectId);
      if (existing) return existing.batchId ? state.jobs.filter(item => item.batchId === existing.batchId && item.projectId === projectId) : [existing];
      const scene = project.scenes.find(item => item.id === input.sceneId);
      if (!scene?.videoPrompt?.trim()) throw new InputError('请先写好当前视频生成项的视频提示词。');
      const count = Number(input.count ?? scene.generationCount ?? 1);
      if (!Number.isInteger(count) || count < 1 || count > MAX_GENERATION_COUNT) {
        throw new InputError(`每次生成数量请选择 1–${MAX_GENERATION_COUNT} 个。`);
      }
      const defaultModel = catalog.some(item => item.name === settings.videoModel) ? settings.videoModel : catalog[0]?.name || '';
      const requestedModel = String(input.model || scene.videoModel || defaultModel).slice(0, 120);
      if (input.model && input.model !== requestedModel) throw new InputError('视频模型参数不正确，请刷新工作台后重试。');
      if (input.model && !scene.videoModel && input.model !== defaultModel) throw new InputError('视频模型已变更，请刷新工作台后核对参数。');
      const model = catalog.find(item => item.name === requestedModel);
      if (!model) throw new InputError('当前视频生成项所选模型不在当前密钥的可见模型目录中，请刷新模型并重新选择。');
      const requestMode = model.requestMode || input.requestMode;
      if (model.requestMode && input.requestMode !== model.requestMode) throw new InputError('模型接口已更新，请刷新工作台后重新选择参数。');
      if (![VIDEO_REQUEST_MODE, LEGACY_VIDEO_REQUEST_MODE].includes(requestMode)) throw new InputError('视频接口已更新，请刷新工作台。');
      const rawDuration = input.duration !== undefined && input.duration !== null ? input.duration : scene.generationDuration;
      // A zero generationDuration is the saved “use model default” sentinel;
      // preserve explicit NaN and unsupported values so validation can reject them.
      const duration = rawDuration === undefined || rawDuration === null || rawDuration === 0 && input.duration == null
        ? Number(model.defaultDuration) : Number(rawDuration);
      if (requestMode === VIDEO_REQUEST_MODE && rawDuration !== undefined && rawDuration !== null && typeof rawDuration !== 'number') throw new InputError('新版时长必须为 JSON 整数秒数。');
      const resolution = input.resolution || scene.resolution || model.defaultResolution;
      const tier = model.tiers.find(item => item.duration === duration && item.resolution === resolution);
      if (!tier || !(model.pricingAvailable === false && tier.price === null || Number.isFinite(tier.price) && tier.price >= 0)) throw new InputError('这个时长与画质组合不在模型参数列表中，请调整参数。');
      const requestedRatio = input.ratio || scene.ratio || '';
      if (model.ratios?.length && requestedRatio && !model.ratios.includes(requestedRatio)) {
        throw new InputError('当前模型不支持所选画面比例，请切换模型或比例。');
      }
      // Keep the project ratio when the model publishes it; otherwise use the
      // first catalog ratio so the saved request is always provider-valid.
      const ratio = requestedRatio || (model.ratios?.length
        ? (model.ratios.includes(project.brief.ratio) ? project.brief.ratio : model.ratios[0])
        : project.brief.ratio);
      const includeVideoOptions = Boolean(input.ratio || input.resolution || scene.ratio || scene.resolution);
      // Always derive effective references from the graph, even for old saved scenes.
      const references = resolveSceneReferences(project, scene);
      if (references.length > REFERENCE_PREPARATION_LIMIT) throw new InputError('每个视频生成项最多准备 10 份参考素材。');
      const issues = invalidPromptMentions(scene, references);
      if (issues.length) throw new InputError(issues[0].message);
      // Incoming reference parameters cannot substitute for the saved graph/materials.
      if (input.referenceAssetId || normalizeReferences(input.references).length) {
        throw new InputError('请先将参考素材和公网链接保存到当前视频生成项，再提交生成。');
      }
      const canPrepareReferences = Boolean(this.prepareReferences && storage?.ready && references.some(reference => !reference.publicUrl));
      const referenceIssue = referenceRequestIssue(model, references, { allowLocalUpload: canPrepareReferences });
      if (referenceIssue) throw new InputError('多参考生成：' + referenceIssue);
      for (const reference of references) {
        const asset = project.assets.find(item => !item.deletedAt && item.id === reference.assetId && item.kind === reference.kind);
        if (!asset) throw new InputError('参考素材尚未关联本工程的有效文件，请先补选素材。');
      }
      const now = new Date().toISOString(), batchId = randomUUID();
      const base = { projectId, sceneId: scene.id, prompt: scene.videoPrompt,
        model: model.name, duration, resolution, ratio,
        requestMode, includeVideoOptions,
        providerDefaults: { duration: model.defaultDuration, resolution: model.defaultResolution },
        providerTiers: structuredClone(model.tiers || []),
        references: structuredClone(references), referenceSupport: referenceCapabilities(model),
        providerRatios: structuredClone(model.ratios || []), referenceAssetId: '', state: 'waiting', providerTaskId: '',
        submissionStartedAt: null, submissionAttempts: 0,
        autoPrepareReferences: canPrepareReferences,
        estimate: tier.price, operationId, selectionAtStart: scene.videoAssetId || '',
        createdAt: now, updatedAt: now, progress: null, message: '等待提交到平台。' };
      const batch = Array.from({ length: count }, (_, index) => ({ ...base, id: randomUUID(),
        providerRequestId: randomUUID(), batchId, variantIndex: index + 1, variantCount: count }));
      // Validate the chosen duration, default resolution and form version before billing.
      if (!canPrepareReferences) buildVideoRequest(batch[0]);
       // operationId makes retries of the same UI action idempotent. A new
       // operationId intentionally creates another batch even while an earlier
       // batch for this scene is still running.
      if (references.length && !canPrepareReferences) await this.verifyReferences(references, settings.apiKey);
      const connection = connectionForVideoJob(settings, batch[0]);
      for (const job of batch) {
        job.providerBaseUrl = connection.baseUrl;
        await this.store.saveVideoTaskSettings(job.id, connection);
      }
      state.jobs.push(...batch); return batch;
    });
    await this.dispatch().catch(() => {});
    return batchResult(this.store.state.jobs.filter(job => saved.some(item => item.id === job.id)));
  }
  async dispatch() {
    if (this.closed) return;
    if (this.dispatchTask) return this.dispatchTask;
    const available = job => job.state === 'waiting' && !this.busy.has(job.id) && !hasSubmission(job);
    if (!this.store.state.jobs.some(available)) return;
    this.dispatchTask = (async () => {
      const reserved = await this.store.mutate(state => {
        if (this.closed) return [];
        // Do not impose a local cap. The provider remains responsible for its
        // own queue, rate limit, balance and model concurrency rules.
        // A preparing job already has an upload worker. Startup recovery moves
        // interrupted preparations back to waiting before dispatch can claim them.
        const ready = state.jobs.filter(available);
        for (const job of ready) {
          const needsPreparation = job.autoPrepareReferences && (job.references || []).some(reference => !reference.publicUrl);
          Object.assign(job, { state: needsPreparation ? 'preparing' : 'submitting',
            message: needsPreparation ? '正在上传选中的参考素材，尚未提交视频生成。' : '正在向平台提交。',
            updatedAt: new Date().toISOString() });
        }
        return ready;
      });
      // Each candidate gets one normal provider POST; no undocumented multi-output field.
      for (const job of reserved) {
        const settings = await this.store.videoTaskSettings(job);
        void (job.state === 'preparing' ? this.runPrepare(job, settings) : this.runSubmit(job, settings)).catch(() => {});
      }
    })();
    try { await this.dispatchTask; } finally { this.dispatchTask = null; }
  }
  async runPrepare(job, settings) {
    const current = this.store.state.jobs.find(item => item.id === job.id);
    if (this.closed || this.busy.has(job.id) || current?.state !== 'preparing' || hasSubmission(current)) return;
    this.busy.add(job.id);
    try {
      if (!this.prepareReferences) throw new InputError('素材自动上传功能尚未配置，请先在素材云存储中完成设置。');
      const references = await this.prepareReferences(job, settings);
      buildVideoRequest({ ...job, references });
      await this.verifyReferences(references, settings.apiKey);
      const prepared = await this.store.mutate(state => {
        const current = state.jobs.find(item => item.id === job.id);
        if (this.closed || current?.state !== 'preparing' || hasSubmission(current)) return null;
        Object.assign(current, { references, autoPrepareReferences: false, state: 'submitting',
          message: '素材已准备，正在向平台提交。', updatedAt: new Date().toISOString() });
        return current;
      });
      if (prepared) await this.runSubmit(prepared, settings);
    } catch (error) {
      await this.store.mutate(state => {
        const current = state.jobs.find(item => item.id === job.id);
        if (current?.state === 'preparing' && !hasSubmission(current)) Object.assign(current, {
          state: 'failed', updatedAt: new Date().toISOString(),
          message: `素材上传准备失败，尚未提交视频生成：${error instanceof InputError ? error.message : '请检查 COS 配置和网络后重试。'}` });
      });
    } finally { this.busy.delete(job.id); void this.dispatch().catch(() => {}); }
  }
  async runSubmit(job, settings) {
    const id = job.id, current = this.store.state.jobs.find(item => item.id === id);
    if (this.closed || this.submitting.has(id) || current?.state !== 'submitting' || hasSubmission(current)) return;
    this.submitting.add(id);
    const ownsBusy = !this.busy.has(id); this.busy.add(id);
    let claimed = false;
    try {
      // Persist the claim before making a billable request. The Store transaction
      // serializes duplicate callers, and the marker survives failures and restarts.
      job = await this.store.mutate(state => {
        const current = state.jobs.find(item => item.id === id);
        if (this.closed || current?.state !== 'submitting' || hasSubmission(current)) return null;
        const now = new Date().toISOString();
        Object.assign(current, { submissionStartedAt: now, submissionAttempts: 1, updatedAt: now });
        return current;
      });
      if (!job) return;
      claimed = true;
      const result = await this.submit(settings, job);
      if (!result.taskId && !result.url) {
        await this.patch(job.id, { state: 'uncertain', message: '平台没有返回任务编号，请核对平台记录后再决定是否重试。' });
        return;
      }
      await this.accept(job, result);
    } catch (error) {
      if (!claimed) throw error;
      const knownFailure = error instanceof InputError;
      await this.patch(job.id, { state: knownFailure ? 'failed' : 'uncertain',
        errorCode: error.code || '', providerHttpStatus: error.providerHttpStatus || null,
        message: knownFailure || error?.name === 'UncertainSubmission' || error?.code?.startsWith('SUBMISSION_') ? error.message
          : '提交连接中断，是否已创建任务尚不确定。请先检查平台任务记录，不会自动重复提交。' });
    } finally {
      this.submitting.delete(id);
      if (ownsBusy) this.busy.delete(id);
      void this.dispatch().catch(() => {});
    }
  }
  async accept(job, result) {
    const changes = { providerTaskId: result.taskId || job.providerTaskId, progress: result.progress,
      providerStatus: result.providerStatus || '', lastCheckedAt: new Date().toISOString(),
      providerSubmittedAt: result.providerSubmittedAt || job.providerSubmittedAt || null,
      providerStartedAt: result.providerStartedAt || job.providerStartedAt || null,
      providerFinishedAt: result.providerFinishedAt || job.providerFinishedAt || null,
      errorCode: result.errorCode || '', pollBlocked: Boolean(result.pollBlocked), pollFailures: 0,
      nextPollAt: new Date(Date.now() + 10000).toISOString(),
      state: result.state, message: result.message || ({ queued: '平台排队中。', running: '平台生成中。', failed: '平台返回任务失败。' }[result.state] || '正在确认平台状态。') };
    if (result.state === 'completed') {
      changes.state = 'download_pending'; changes.resultUrl = result.url;
      changes.message = result.url ? '生成完成，准备保存视频。' : '平台报告完成，但尚未返回视频地址。';
    } else if (result.state === 'unknown') {
      changes.state = result.taskId || job.providerTaskId ? 'queued' : 'uncertain';
      changes.message = '平台状态尚未识别，等待下一次查询。';
    }
    const updated = await this.patch(job.id, changes);
    if (updated.state === 'download_pending' && updated.resultUrl) await this.download(updated);
  }
  async tick() {
    await this.dispatch();
    for (const job of [...this.store.state.jobs]) {
      if (this.busy.has(job.id) || !['queued', 'running', 'download_pending', 'attention'].includes(job.state)) continue;
      if (job.pollBlocked || job.nextPollAt && Date.parse(job.nextPollAt) > Date.now()) continue;
      if (job.state === 'attention' && !job.providerTaskId && !job.resultUrl) continue;
      if (Date.now() - Date.parse(job.createdAt) > 3600000 && !job.providerTaskId && !job.resultUrl) {
        await this.patch(job.id, { state: 'attention', message: '任务超过一小时，请在平台核对结果后手动查询；不会再次提交生成。' }); continue;
      }
      void this.refresh(job).catch(() => {});
    }
  }
  async refresh(job) {
    if (this.busy.has(job.id)) return;
    this.busy.add(job.id);
    try {
      if (job.state === 'download_pending' && job.resultUrl) await this.download(job);
      else if (job.providerTaskId) await this.accept(job, await this.poll(await this.store.videoTaskSettings(job), job.providerTaskId));
    } catch (error) {
      if (error?.code === 'task_not_exist' || error?.code === 'task_not_found' || error?.providerHttpStatus === 404) {
        await this.patch(job.id, { state: 'attention', providerStatus: 'TASK_NOT_FOUND',
          pollBlocked: true, errorCode: error.code || 'HTTP_404',
          providerHttpStatus: error.providerHttpStatus || null,
          lastCheckedAt: new Date().toISOString(),
          message: '平台未找到这个任务编号，请在平台核对；不会自动重新提交生成。' });
      } else if (error?.retryable === false || error?.providerHttpStatus >= 400 && error?.providerHttpStatus < 500 && ![408, 429].includes(error.providerHttpStatus)) {
        await this.patch(job.id, { state: 'attention', pollBlocked: true, lastCheckedAt: new Date().toISOString(),
          providerHttpStatus: error.providerHttpStatus || null,
          errorCode: error.code || `HTTP_${error.providerHttpStatus}`, message: (error instanceof InputError ? error.message : '任务查询未获平台许可。') + ' 已暂停自动查询，请核对原密钥和任务；不会重新生成。' });
      } else {
        const failures = (job.pollFailures || 0) + 1;
        const delay = error.retryAfterMs || Math.min(60000, 10000 * 2 ** Math.min(failures, 3));
        await this.patch(job.id, { pollFailures: failures, nextPollAt: new Date(Date.now() + delay).toISOString(),
          providerHttpStatus: error.providerHttpStatus || null, errorCode: error.code || '',
          lastCheckedAt: new Date().toISOString(), message: (error instanceof InputError ? error.message : '本次查询连接失败。') + ` 将在约 ${Math.ceil(delay / 1000)} 秒后继续查询原任务。` });
      }
    } finally { this.busy.delete(job.id); void this.dispatch().catch(() => {}); }
  }
  async download(job) {
    await this.patch(job.id, { state: 'downloading', message: '正在下载并检查视频。' });
    const id = randomUUID();
    const file = `${id}.mp4`; const destination = path.join(this.store.root, 'assets', file);
    try {
      const size = await this.downloadVideo(job.resultUrl, destination);
      const handle = await open(destination, 'r'); const prefix = Buffer.alloc(32);
      try { await handle.read(prefix, 0, 32, 0); } finally { await handle.close(); }
      if (detectMedia(prefix).kind !== 'video') throw new InputError('平台下载结果不是支持的 MP4 文件。', 502);
      await this.store.mutate(state => {
        const current = state.jobs.find(item => item.id === job.id);
        const project = state.projects.find(item => item.id === job.projectId);
        if (!project) throw new InputError('工程已经不存在。', 404);
        const label = job.variantCount > 1 ? ` · 候选 ${job.variantIndex}/${job.variantCount}` : '';
        const asset = { id, name: `生成视频 · ${job.model}${label}`, file, kind: 'video', mime: 'video/mp4', size,
          createdAt: new Date().toISOString(), source: 'model', sceneId: job.sceneId, jobId: job.id,
          batchId: job.batchId || job.id, variantIndex: job.variantIndex || 1, variantCount: job.variantCount || 1,
          duration: job.duration, resolution: job.resolution };
        project.assets.push(asset);
        const scene = project.scenes.find(item => item.id === job.sceneId);
        if (scene && scene.videoPrompt === job.prompt && (job.variantCount || 1) === 1
            && !scene.videoAssetId && !job.selectionAtStart) scene.videoAssetId = id;
        for (const node of project.graph.nodes.filter(node => node.kind === 'video')) node.status = 'done';
        touch(project);
        Object.assign(current, { state: 'done', message: '视频已保存到本机素材库。', assetId: id, resultUrl: '', updatedAt: new Date().toISOString() });
      });
    } catch (error) {
      await unlink(destination).catch(() => {});
      await this.patch(job.id, { state: 'download_pending', message: error instanceof InputError ? error.message : '视频保存失败，将重试下载，不会重新生成。' });
    }
  }
  async retryLookup(id, taskId = '') {
    let job = this.store.state.jobs.find(item => item.id === id);
    if (!job) throw new InputError('找不到这个任务。', 404);
    if (taskId && !job.providerTaskId && job.state === 'uncertain') {
      if (typeof taskId !== 'string' || !/^[\w.-]{1,200}$/.test(taskId)) throw new InputError('平台任务编号格式不正确。');
      job = await this.patch(id, { providerTaskId: taskId });
    }
    if (!job.providerTaskId && !job.resultUrl) throw new InputError('未获得平台任务编号，请先在平台核对；这里不会重复提交生成。');
    if (job.state === 'done') return publicJob(job);
    job = await this.patch(id, { state: job.resultUrl ? 'download_pending' : 'queued', pollBlocked: false, nextPollAt: null, pollFailures: 0 });
    void this.refresh(job).catch(() => {});
    return publicJob(this.store.state.jobs.find(item => item.id === id));
  }
}
