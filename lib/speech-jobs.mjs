import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { InputError, touch, setAssetDeleted } from './workflow.mjs';
import { atomicJson } from './store.mjs';
import { detectMedia } from './media.mjs';
import { synthesizeSpeech, normalizeSpeechSettings, SpeechProviderError, SPEECH_AUDIO_LIMIT } from './speech-provider.mjs';
import { normalizeSpeechRequest } from '../public/speech-parameters.js';

export const publicSpeechJob = job => ({ id: job.id, kind: 'speech', projectId: job.projectId, operationId: job.operationId,
  request: job.request, nodeId: job.nodeId, sceneId: job.sceneId, state: job.state, message: job.message,
  createdAt: job.createdAt, updatedAt: job.updatedAt, deletedAt: job.deletedAt || null, assetId: job.state === 'done' ? job.assetId : '',
  traceId: job.traceId || '', providerCode: job.providerCode ?? null, duration: job.duration ?? null, usageCharacters: job.usageCharacters ?? null });

function speechJobDeletedAt(job, project) {
  const asset = project?.assets.find(item => item.id === job.assetId);
  return asset ? asset.deletedAt || null : job.deletedAt || null;
}

export class SpeechJobs {
  constructor(store, options = {}) {
    this.store = store; this.fetcher = options.fetcher || fetch;
    this.synthesize = options.synthesize || ((settings, request) => synthesizeSpeech(settings, request, this.fetcher));
    this.busy = new Set(); this.tasks = new Set(); this.received = new Map(); this.closed = false;
    this.resultRoot = path.join(store.root, 'speech-results');
    this.connectionRoot = path.join(store.root, 'speech-task-connections');
  }
  resultFile(id) { return path.join(this.resultRoot, `${id}.json`); }
  connectionFile(id) { return path.join(this.connectionRoot, `${id}.private.json`); }
  async init() {
    await mkdir(this.resultRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.connectionRoot, { recursive: true, mode: 0o700 });
    await this.store.mutate(async state => {
      state.speechJobs ||= [];
      for (const job of state.speechJobs) {
        if (!['submitting', 'saving', 'save_pending'].includes(job.state)) continue;
        let saved = false;
        try { saved = (await stat(this.resultFile(job.id))).isFile(); } catch {}
        job.state = saved ? 'save_pending' : 'uncertain';
        job.message = saved ? '上次本地保存被中断，已有配音结果可继续保存。' : '程序在配音提交或结果保存期间关闭，请先核对 MiniMax 记录；不会自动再次生成。';
        job.updatedAt = new Date().toISOString();
      }
    });
    this.timer = setInterval(() => this.tick(), 2000); this.timer.unref(); this.tick();
  }
  list(projectId, includeDeleted = false) {
    const project = this.store.state.projects.find(item => item.id === projectId);
    return (this.store.state.speechJobs || []).filter(job => job.projectId === projectId)
      .map(job => publicSpeechJob({ ...job, deletedAt: speechJobDeletedAt(job, project) }))
      .filter(job => includeDeleted || !job.deletedAt).reverse();
  }
  get(id) {
    const job = (this.store.state.speechJobs || []).find(item => item.id === id);
    if (!job) throw new InputError('找不到这个配音任务。', 404);
    const project = this.store.state.projects.find(item => item.id === job.projectId);
    return structuredClone({ ...job, deletedAt: speechJobDeletedAt(job, project) });
  }
  async setDeleted(id, deleted) {
    return this.store.mutate(state => {
      const job = state.speechJobs.find(item => item.id === id);
      if (!job) throw new InputError('找不到这个配音任务。', 404);
      const index = state.projects.findIndex(item => item.id === job.projectId), project = state.projects[index];
      if (!project) throw new InputError('找不到这个配音任务的工程。', 404);
      if (project.deletedAt) throw new InputError('这个工程已删除，请先恢复工程再管理配音。', 410);
      if (!['done', 'failed'].includes(job.state) || this.busy.has(id)) {
        throw new InputError('配音仍在生成、保存或需要核对，请处理完任务后再删除或恢复。', 409);
      }
      const asset = project.assets.find(item => item.id === job.assetId);
      if (asset) state.projects[index] = setAssetDeleted(project, asset.id, deleted);
      job.deletedAt = deleted ? speechJobDeletedAt(job, state.projects[index]) || new Date().toISOString() : null;
      job.updatedAt = new Date().toISOString();
      return publicSpeechJob(job);
    });
  }
  async permanentlyDelete(id) {
    const result = await this.store.permanentlyDeleteSpeechJob(id, jobId => this.busy.has(jobId));
    this.received.delete(id);
    return result;
  }
  async patch(id, patch) {
    return this.store.mutate(state => {
      const job = state.speechJobs.find(item => item.id === id);
      if (!job) throw new InputError('找不到这个配音任务。', 404);
      Object.assign(job, patch, { updatedAt: new Date().toISOString() }); return job;
    });
  }
  async start(projectId, input) {
    if (this.closed) throw new InputError('工作台正在关闭，请稍后再提交。', 503);
    let request;
    try { request = normalizeSpeechRequest(input); } catch (error) { throw new InputError(error.message); }
    if (typeof input.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.operationId)) throw new InputError('请提供有效的配音操作编号。');
    const nodeId = input.nodeId || '', sceneId = input.sceneId || '';
    if (typeof nodeId !== 'string' || typeof sceneId !== 'string' || nodeId.length > 100 || sceneId.length > 100) throw new InputError('配音关联编号不正确。');
    const job = await this.store.mutate(async state => {
      this.store.assertGenerationOperationAvailable('speech', projectId, input.operationId, state);
      const previous = state.speechJobs.find(item => item.operationId === input.operationId);
      if (previous) {
        if (previous.projectId !== projectId || previous.nodeId !== nodeId || previous.sceneId !== sceneId || JSON.stringify(previous.request) !== JSON.stringify(request)) throw new InputError('这个操作编号已用于其他配音参数，请核对原任务。', 409);
        return previous;
      }
      const project = state.projects.find(item => item.id === projectId);
      if (!project || project.deletedAt) throw new InputError('工程不存在或已删除，请先恢复工程。', project ? 410 : 404);
      if (nodeId && !project.graph.nodes.some(node => node.id === nodeId && node.kind === 'audio')) throw new InputError('关联的声音卡片已移除，请重新选择。');
      if (sceneId && !project.scenes.some(scene => scene.id === sceneId)) throw new InputError('关联的视频生成项已移除，请重新选择。');
      const settings = normalizeSpeechSettings({}, await this.store.connectionFor('speech', request.model, await this.store.speechSettings()));
      if (!settings.apiKey) throw new InputError('请先在连接中心添加语音接口，保存 API Key 并绑定所选语音模型。');
      const now = new Date().toISOString();
      const next = { id: randomUUID(), assetId: randomUUID(), projectId, operationId: input.operationId, request, nodeId, sceneId,
        state: 'waiting', message: '已接收配音任务，等待提交 MiniMax。', createdAt: now, updatedAt: now };
      // Freeze credentials privately so queued work keeps the connection chosen at submission.
      await atomicJson(this.connectionFile(next.id), settings);
      state.speechJobs.push(next); return next;
    });
    this.tick(); return publicSpeechJob(this.get(job.id));
  }
  run(operation) {
    const task = operation().catch(() => {}).finally(() => { this.tasks.delete(task); this.tick(); });
    this.tasks.add(task);
  }
  tick() {
    if (this.closed) return;
    for (const job of this.store.state.speechJobs || []) {
      if (this.busy.size >= 3) break;
      if (job.state === 'waiting' && !this.busy.has(job.id)) this.run(() => this.process(job.id));
    }
  }
  async process(id) {
    if (this.closed || this.busy.has(id)) return;
    this.busy.add(id); let submitted = false, received = false;
    try {
      const job = this.get(id);
      if (job.state !== 'waiting') return;
      const settings = normalizeSpeechSettings({}, JSON.parse(await readFile(this.connectionFile(id), 'utf8')));
      await this.patch(id, { state: 'submitting', message: 'MiniMax 正在生成配音，可以继续提交其他任务。' });
      submitted = true;
      const result = await this.synthesize(settings, job.request);
      received = true; this.received.set(id, result);
      await atomicJson(this.resultFile(id), { ...result, audio: result.audio.toString('base64') });
      await this.patch(id, { state: 'save_pending', message: '音频已返回，正在保存到本机素材库。', traceId: result.traceId,
        duration: result.duration, usageCharacters: result.usageCharacters });
      await this.save(id);
    } catch (error) {
      const uncertain = !received && (error instanceof SpeechProviderError ? error.uncertain : submitted);
      await this.patch(id, { state: received ? 'save_pending' : uncertain ? 'uncertain' : 'failed',
        message: received ? '配音已返回，本地保存未完成。可重试保存已有音频；当前会话不会再次调用生成接口。'
          : error instanceof InputError ? error.message : uncertain ? '配音连接或结果读取中断，请先核对 MiniMax 记录。' : '本地配音任务准备失败，尚未提交生成请求。',
        traceId: error.traceId || this.received.get(id)?.traceId || '', providerCode: error.providerCode ?? null }).catch(() => {});
    } finally { this.busy.delete(id); }
  }
  async save(id) {
    const job = this.get(id);
    if (job.state === 'done') return publicSpeechJob(job);
    let result = this.received.get(id);
    if (!result) {
      const stored = JSON.parse(await readFile(this.resultFile(id), 'utf8'));
      if (typeof stored.audio !== 'string' || stored.audio.length > Math.ceil(SPEECH_AUDIO_LIMIT / 3) * 4) throw new Error('invalid stored audio');
      result = { ...stored, audio: Buffer.from(stored.audio, 'base64') };
    }
    const media = detectMedia(result.audio.subarray(0, 32));
    if (media.kind !== 'audio' || media.extension !== `.${job.request.format}` || !result.audio.length || result.audio.length > SPEECH_AUDIO_LIMIT) throw new Error('invalid stored audio');
    await this.patch(id, { state: 'saving', message: '正在保存配音到本机素材库。' });
    const file = `${job.assetId}${media.extension}`, filename = path.join(this.store.root, 'assets', file), temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, result.audio, { mode: 0o600 }); await rename(temporary, filename);
    await this.store.mutate(state => {
      const current = state.speechJobs.find(item => item.id === id), project = state.projects.find(item => item.id === job.projectId);
      if (!current || !project) throw new Error('speech project missing');
      if (!project.assets.some(asset => asset.id === job.assetId)) {
        project.assets.push({ id: job.assetId, kind: 'audio', name: job.request.name, mime: media.mime, file, size: result.audio.length,
          duration: result.duration, createdAt: new Date().toISOString(), source: 'model', model: job.request.model, jobId: id, sceneId: job.sceneId,
          speech: { ...job.request, traceId: result.traceId, usageCharacters: result.usageCharacters } });
        const node = project.graph.nodes.find(item => item.id === job.nodeId && item.kind === 'audio');
        if (node && (!node.assetId || node.role === 'speech-generation')) { node.assetId = job.assetId; node.assetName = job.request.name; node.status = 'done'; }
        touch(project);
      }
      Object.assign(current, { state: 'done', message: '配音已保存，可试听、下载或放到画布。', updatedAt: new Date().toISOString(),
        duration: result.duration, traceId: result.traceId, usageCharacters: result.usageCharacters });
    });
    this.received.delete(id); return publicSpeechJob(this.get(id));
  }
  async retrySave(id) {
    const job = this.get(id);
    if (job.state === 'done') return publicSpeechJob(job);
    if (this.busy.has(id)) return publicSpeechJob(job);
    if (job.state !== 'save_pending') throw new InputError('这个任务没有可重试保存的配音结果。', 409);
    this.busy.add(id);
    this.run(async () => {
      try { await this.save(id); }
      catch { await this.patch(id, { state: 'save_pending', message: '本地保存仍未完成，请检查磁盘空间和目录权限后重试保存。' }).catch(() => {}); }
      finally { this.busy.delete(id); }
    });
    return publicSpeechJob(job);
  }
  async resolve(id, input) {
    const job = this.get(id);
    if (job.state !== 'uncertain' || input?.confirmed !== true || this.busy.has(id)) throw new InputError('请先核对 MiniMax 记录，再结束这条待核对任务。', 409);
    return publicSpeechJob(await this.patch(id, { state: 'failed', message: '已由用户核对平台记录并结束本地任务。没有再次提交生成。' }));
  }
  async close() { this.closed = true; clearInterval(this.timer); await Promise.allSettled([...this.tasks]); }
}
