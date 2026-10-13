import { mkdir, readFile, writeFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { InputError } from './workflow.mjs';
import { atomicJson } from './store.mjs';
import { normalizeSpeechSettings, listSpeechVoices, SpeechProviderError, SPEECH_AUDIO_LIMIT } from './speech-provider.mjs';
import { SPEECH_MODELS } from '../public/speech-parameters.js';
import { normalizeVoiceRequest } from '../public/voice-parameters.js';
import { inspectVoiceRecording } from './voice-recordings.mjs';
import { uploadCloneRecording, createCustomVoice, downloadVoicePreview } from './voice-provider.mjs';
import { detectMedia } from './media.mjs';

const operationId = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(value)) throw new InputError('请提供有效的音色操作编号。'); return value; };
const accountKey = settings => createHash('sha256').update(`${settings.region}\0${settings.apiKey}`).digest('hex');
const publicRecording = recording => ({ id: recording.id, name: recording.name, size: recording.size, duration: recording.duration, mime: recording.mime,
  previewUrl: `/api/voice-recordings/${recording.id}` });
export const publicVoiceJob = job => ({ id: job.id, operationId: job.operationId, request: job.request, connectionId: job.connectionId, region: job.region,
  state: job.state, message: job.message, createdAt: job.createdAt, updatedAt: job.updatedAt, voiceId: job.voiceId || '',
  previewState: job.previewState || 'none', previewMessage: job.previewMessage || '', previewUrl: job.previewFile ? `/api/voice-jobs/${job.id}/preview` : '',
  traceId: job.traceId || '', providerCode: job.providerCode ?? null });

export class VoiceJobs {
  constructor(store, options = {}) {
    this.store = store; this.fetcher = options.fetcher || fetch;
    this.uploadProvider = options.uploadRecording || ((settings, bytes, recording) => uploadCloneRecording(settings, bytes, recording, this.fetcher));
    this.createProvider = options.createVoice || ((settings, request, fileId) => createCustomVoice(settings, request, fileId, this.fetcher));
    this.downloadPreview = options.downloadPreview || (url => downloadVoicePreview(url, this.fetcher));
    this.busy = new Set(); this.tasks = new Set(); this.received = new Map(); this.closed = false;
    this.recordingRoot = path.join(store.root, 'voice-recordings'); this.resultRoot = path.join(store.root, 'voice-results'); this.connectionRoot = path.join(store.root, 'voice-task-connections');
  }
  resultFile(id) { return path.join(this.resultRoot, `${id}.private.json`); }
  connectionFile(id) { return path.join(this.connectionRoot, `${id}.private.json`); }
  async settings(model) {
    if (model && !SPEECH_MODELS.includes(model)) throw new InputError('请选择已接入的 MiniMax 语音模型。');
    const raw = await this.store.connectionFor('speech', model || null, await this.store.speechSettings());
    const settings = normalizeSpeechSettings({}, raw);
    if (!settings.apiKey) throw new InputError('请先在连接中心绑定语音模型并保存 MiniMax API Key。');
    return { ...settings, connectionId: raw.id || 'legacy' };
  }
  async init() {
    await Promise.all([this.recordingRoot, this.resultRoot, this.connectionRoot].map(root => mkdir(root, { recursive: true, mode: 0o700 })));
    await this.store.mutate(async state => {
      state.voiceJobs ||= []; state.voiceRecordings ||= [];
      for (const job of state.voiceJobs) {
        if (job.state === 'uploading') { job.state = 'waiting'; job.message = '录音上传被中断，继续准备原音色任务。'; }
        else if (['creating', 'saving', 'save_pending'].includes(job.state)) {
          const saved = await stat(this.resultFile(job.id)).then(info => info.isFile()).catch(() => false);
          job.state = saved ? 'save_pending' : 'uncertain';
          job.message = saved ? '音色已返回，可继续保存已有结果。' : '音色创建期间程序被关闭，请先核对平台；不会自动再次创建。';
        }
      }
    });
    this.timer = setInterval(() => this.tick(), 2000); this.timer.unref(); this.tick();
  }
  async list(model) {
    const settings = await this.settings(model), identity = accountKey(settings);
    return (this.store.state.voiceJobs || []).filter(job => job.accountKey === identity).map(publicVoiceJob).reverse();
  }
  async localVoices(model) {
    const jobs = await this.list(model);
    return jobs.filter(job => job.state === 'done' && job.voiceId).map(job => ({ id: job.voiceId, name: job.request.name,
      type: job.request.kind === 'clone' ? 'cloned' : 'designed', description: '在镜策创建的音色；未首次正式合成的临时音色可能在 7 天后被平台删除。' }));
  }
  get(id) {
    const job = (this.store.state.voiceJobs || []).find(item => item.id === id);
    if (!job) throw new InputError('找不到这个音色任务。', 404);
    return structuredClone(job);
  }
  async patch(id, patch) {
    return this.store.mutate(state => { const job = state.voiceJobs.find(item => item.id === id); if (!job) throw new InputError('找不到这个音色任务。', 404);
      Object.assign(job, patch, { updatedAt: new Date().toISOString() }); return job; });
  }
  recording(id) {
    const recording = (this.store.state.voiceRecordings || []).find(item => item.id === id);
    if (!recording) throw new InputError('找不到这段复刻录音，请重新上传。', 404);
    return structuredClone(recording);
  }
  recordingMedia(id) { const recording = this.recording(id); return { filename: path.join(this.recordingRoot, recording.file), mime: recording.mime }; }
  async upload(model, input, bytes) {
    if (this.closed) throw new InputError('工作台正在关闭。', 503);
    const op = operationId(input.operationId), name = String(input.name || '').slice(0, 200), media = inspectVoiceRecording(bytes, name);
    const settings = await this.settings(model), identity = accountKey(settings), digest = createHash('sha256').update(bytes).digest('hex');
    return this.store.mutate(async state => {
      const previous = state.voiceRecordings.find(item => item.operationId === op);
      if (previous) {
        if (previous.accountKey !== identity || previous.digest !== digest || previous.name !== name) throw new InputError('该上传编号已用于其他录音。', 409);
        return publicRecording(previous);
      }
      const id = randomUUID(), file = `${id}${media.extension}`, temporary = path.join(this.recordingRoot, `${id}.tmp`);
      await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, path.join(this.recordingRoot, file));
      const recording = { id, operationId: op, name, file, ...media, size: bytes.length, digest, accountKey: identity, createdAt: new Date().toISOString() };
      state.voiceRecordings.push(recording); return publicRecording(recording);
    });
  }
  async start(input) {
    if (this.closed) throw new InputError('工作台正在关闭，请稍后再提交。', 503);
    let request; try { request = normalizeVoiceRequest(input); } catch (error) { throw new InputError(error.message); }
    if (!SPEECH_MODELS.includes(request.model)) throw new InputError('请选择已接入的 MiniMax 语音模型。');
    const op = operationId(input.operationId);
    // Replaying an acknowledged operation returns its frozen task even after the connection changes.
    const job = await this.store.mutate(async state => {
      const previous = state.voiceJobs.find(item => item.operationId === op);
      if (previous) { if (JSON.stringify(previous.request) !== JSON.stringify(request)) throw new InputError('该操作编号已用于其他音色参数，请核对原任务。', 409); return previous; }
      const settings = await this.settings(request.model), identity = accountKey(settings);
      if (state.voiceJobs.some(item => item.accountKey === identity && item.request.voiceId === request.voiceId && item.state !== 'failed')) throw new InputError('该 Voice ID 已在镜策创建或提交，请使用新 ID，或检查原任务。', 409);
      if (request.kind === 'clone') {
        const recording = state.voiceRecordings.find(item => item.id === request.recordingId);
        if (!recording || recording.accountKey !== identity) throw new InputError('录音与当前 MiniMax 账户不匹配，请在当前连接下重新上传。');
      }
      const now = new Date().toISOString(), id = randomUUID();
      await atomicJson(this.connectionFile(id), settings);
      const next = { id, operationId: op, request, accountKey: identity, connectionId: settings.connectionId, region: settings.region,
        state: 'waiting', message: '已接收音色任务，可以继续新建其他音色。', createdAt: now, updatedAt: now };
      state.voiceJobs.push(next); return next;
    });
    this.tick(); return publicVoiceJob(job);
  }
  run(operation) { const task = operation().catch(() => {}).finally(() => { this.tasks.delete(task); this.tick(); }); this.tasks.add(task); }
  tick() {
    if (this.closed) return;
    for (const job of this.store.state.voiceJobs || []) {
      if (this.busy.size >= 2) break;
      if (job.state === 'waiting' && !this.busy.has(job.id)) this.run(() => this.process(job.id));
    }
  }
  async process(id) {
    if (this.closed || this.busy.has(id)) return;
    this.busy.add(id); let creationStarted = false, received = false;
    try {
      const job = this.get(id), settings = JSON.parse(await readFile(this.connectionFile(id), 'utf8'));
      if (job.state !== 'waiting') return;
      let fileId = '';
      if (job.request.kind === 'clone') {
        const recording = this.recording(job.request.recordingId); fileId = recording.providerFileId || '';
        if (!fileId) {
          await this.patch(id, { state: 'uploading', message: '正在上传录音到当前 MiniMax 账户。' });
          const bytes = await readFile(path.join(this.recordingRoot, recording.file)); inspectVoiceRecording(bytes, recording.name);
          if (createHash('sha256').update(bytes).digest('hex') !== recording.digest) throw new InputError('本地录音已改变，请重新上传。');
          fileId = await this.uploadProvider(settings, bytes, recording);
          await this.store.mutate(state => { state.voiceRecordings.find(item => item.id === recording.id).providerFileId = fileId; });
        }
      }
      await this.patch(id, { state: 'creating', message: 'MiniMax 正在创建音色，可以继续提交其他音色任务。' });
      creationStarted = true;
      const result = await this.createProvider(settings, job.request, fileId); received = true; this.received.set(id, result);
      await atomicJson(this.resultFile(id), result);
      await this.patch(id, { state: 'save_pending', message: '音色已返回，正在保存 Voice ID 与试听结果。', voiceId: result.voiceId, traceId: result.traceId });
      await this.save(id);
    } catch (error) {
      const uncertain = !received && (error instanceof SpeechProviderError ? error.uncertain : creationStarted);
      await this.patch(id, { state: received ? 'save_pending' : uncertain ? 'uncertain' : 'failed',
        message: received ? '音色已创建，本地保存未完成；重试保存已有结果不会再次创建。' : error instanceof InputError ? error.message : uncertain ? '创建响应中断，请先核对平台音色。' : '录音上传或本地准备失败，尚未创建音色。',
        voiceId: this.received.get(id)?.voiceId || '', traceId: error.traceId || this.received.get(id)?.traceId || '', providerCode: error.providerCode ?? null }).catch(() => {});
    } finally { this.busy.delete(id); }
  }
  async result(id) { return this.received.get(id) || JSON.parse(await readFile(this.resultFile(id), 'utf8')); }
  async storePreview(id, preview) {
    if (!preview || typeof preview.audio !== 'string' || preview.audio.length > Math.ceil(SPEECH_AUDIO_LIMIT / 3) * 4) throw new Error('invalid preview');
    const bytes = Buffer.from(preview.audio, 'base64'), media = detectMedia(bytes.subarray(0, 32));
    if (media.kind !== 'audio' || !bytes.length || bytes.length > SPEECH_AUDIO_LIMIT) throw new Error('invalid preview');
    const file = `${id}${media.extension}`, temporary = path.join(this.resultRoot, `${id}.${randomUUID()}.tmp`);
    try { await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, path.join(this.resultRoot, file)); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    return { previewFile: file, previewMime: media.mime, previewState: 'ready', previewMessage: '' };
  }
  async save(id) {
    const result = await this.result(id);
    if (!result.voiceId) throw new Error('missing voice ID');
    await atomicJson(this.resultFile(id), result);
    await this.patch(id, { state: 'saving', voiceId: result.voiceId, traceId: result.traceId, message: '正在保存音色与试听结果。' });
    let preview = { previewState: 'none', previewMessage: result.previewMessage || '' };
    if (result.preview || result.previewUrl) {
      try { preview = await this.storePreview(id, result.preview || await this.downloadPreview(result.previewUrl)); }
      catch { preview = { previewState: 'pending', previewMessage: '音色与 Voice ID 已保存，试听音频保存未完成。可以重试保存试听，不会再次创建音色。' }; }
    }
    const saved = await this.patch(id, { state: 'done', ...preview, message: '音色已保存，可选择用于配音。' });
    this.received.delete(id); return publicVoiceJob(saved);
  }
  async retrySave(id) {
    const job = this.get(id);
    if (job.state === 'done' || this.busy.has(id)) return publicVoiceJob(job);
    if (job.state !== 'save_pending') throw new InputError('这个任务没有已返回的音色结果。', 409);
    this.busy.add(id); this.run(async () => { try { await this.save(id); } catch { await this.patch(id, { state: 'save_pending', message: '本地保存仍未完成，请检查磁盘空间与目录权限。' }).catch(() => {}); } finally { this.busy.delete(id); } });
    return publicVoiceJob(job);
  }
  previewMedia(id) {
    const job = this.get(id);
    if (!job.previewFile) throw new InputError('该音色还没有保存试听音频。', 404);
    return { filename: path.join(this.resultRoot, job.previewFile), mime: job.previewMime, name: `${job.request.name}${path.extname(job.previewFile)}` };
  }
  async retryPreview(id) {
    const job = this.get(id);
    if (job.state !== 'done' || job.previewState !== 'pending') throw new InputError('这个任务无需重试保存试听。', 409);
    if (this.busy.has(id)) return publicVoiceJob(job);
    this.busy.add(id); this.run(async () => { try { await this.save(id); } catch { await this.patch(id, { state: 'done', previewState: 'pending', previewMessage: '试听保存仍未完成，可稍后重试。' }).catch(() => {}); } finally { this.busy.delete(id); } });
    return publicVoiceJob(job);
  }
  async reconcile(id) {
    const job = this.get(id);
    if (job.state !== 'uncertain' || this.busy.has(id)) return publicVoiceJob(job);
    this.busy.add(id);
    try {
      const settings = JSON.parse(await readFile(this.connectionFile(id), 'utf8')), { voices } = await listSpeechVoices(settings, this.fetcher);
      const voice = voices.find(item => item.id === job.request.voiceId && item.type === (job.request.kind === 'clone' ? 'cloned' : 'designed'));
      if (!voice) return publicVoiceJob(await this.patch(id, { message: '平台列表暂未查到这个音色，仍保留待核对状态；请核对 MiniMax 记录，不会自动再次创建。' }));
      const result = { voiceId: voice.id, traceId: job.traceId || '', preview: null, previewUrl: '', previewMessage: '已从平台找回 Voice ID，原试听未返回。可选择此音色正式生成配音。' };
      this.received.set(id, result); await atomicJson(this.resultFile(id), result);
      await this.patch(id, { state: 'save_pending', voiceId: voice.id }); return await this.save(id);
    } finally { this.busy.delete(id); }
  }
  async resolve(id, input) {
    const job = this.get(id);
    if (job.state !== 'uncertain' || input?.confirmed !== true || this.busy.has(id)) throw new InputError('请先核对 MiniMax 音色及账单，再结束这条任务。', 409);
    return publicVoiceJob(await this.patch(id, { state: 'failed', message: '已由用户核对平台记录并结束本地任务，没有再次创建音色。' }));
  }
  async close() { this.closed = true; clearInterval(this.timer); await Promise.allSettled([...this.tasks]); }
}
