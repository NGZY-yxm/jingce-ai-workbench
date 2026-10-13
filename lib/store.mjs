import { IMAGE_GENERATION_COUNT_MAX, IMAGE_REFERENCE_MAX, IMAGE_REFERENCE_MODELS, IMAGE_REFERENCE_FILE_LIMIT, IMAGE_REFERENCE_TOTAL_LIMIT } from '../public/image-parameters.js';
import { mkdir, readFile, writeFile, rename, chmod, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { syncImageCardJobs } from '../public/image-parameters.js';
import { InputError, touch, REFERENCE_PREPARATION_LIMIT, MAX_GENERATION_COUNT, MAX_CONCURRENT_TASKS } from './workflow.mjs';
import { VIDEO_REQUEST_MODE, VIDEO_DOCS_URL, DEFAULT_CONNECTION, PLATFORM, LEGACY_PLATFORM, LEGACY_VIDEO_REQUEST_MODE, videoBaseUrl, catalogForVideoModelIds } from './providers.mjs';
import { IMAGE_PLATFORM, IMAGE_DOCS_URL, DEFAULT_IMAGE_CONNECTION } from './image-provider.mjs';
import { TEXT_PLATFORM, TEXT_DOCS_URL, DEFAULT_TEXT_CONNECTION } from './text-provider.mjs';
import { DEFAULT_SPEECH_CONNECTION, SPEECH_ENDPOINTS } from './speech-provider.mjs';
import { SPEECH_MODELS } from '../public/speech-parameters.js';

export class Store {
  constructor(root) { this.root = root; this.pending = Promise.resolve(); this.state = { projects: [], jobs: [], imageJobs: [] }; }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.root, 'assets'), { recursive: true });
    await mkdir(path.join(this.root, 'exports'), { recursive: true });
    try { this.state = JSON.parse(await readFile(path.join(this.root, 'projects.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('工程数据无法读取，请保留 runtime 目录后检查文件。'); }
    if (!Array.isArray(this.state.projects)) throw new Error('工程数据格式不正确。');
    this.state.jobs ||= [];
    this.state.imageJobs ||= [];
    this.state.previsJobs ||= [];
    this.state.speechJobs ||= [];
    this.state.voiceJobs ||= [];
    this.state.voiceRecordings ||= [];
    this.state.pendingFileDeletes ||= [];
    await mkdir(path.join(this.root, 'image-results'), { recursive: true, mode: 0o700 });
    if (this.state.pendingFileDeletes.length) await this.cleanupDeletedFiles();
  }

  list(includeDeleted = false) {
    return structuredClone(this.state.projects.filter(project => includeDeleted || !project.deletedAt))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  get(id, includeDeleted = false) {
    const project = this.state.projects.find(item => item.id === id);
    if (!project) throw new InputError('找不到这个工程。', 404);
    if (project.deletedAt && !includeDeleted) throw new InputError('这个工程已删除，请在“已删除工程”中恢复。', 410);
    return structuredClone(project);
  }

  async mutate(operation) {
    const action = this.pending.then(async () => {
      const next = structuredClone(this.state);
      const result = await operation(next);
      await atomicJson(path.join(this.root, 'projects.json'), next);
      this.state = next;
      return structuredClone(result);
    });
    this.pending = action.catch(() => {});
    return action;
  }

  async update(id, operation, includeDeleted = false) {
    return this.mutate(async state => {
      const index = state.projects.findIndex(project => project.id === id);
      if (index < 0) throw new InputError('找不到这个工程。', 404);
      if (state.projects[index].deletedAt && !includeDeleted) throw new InputError('这个工程已删除，请先恢复后再编辑。', 410);
      state.projects[index] = await operation(state.projects[index]);
      syncImageCardJobs(state.projects[index], state.imageJobs);
      return state.projects[index];
    });
  }

  async setDeleted(id, deleted) {
    return this.mutate(state => {
      const project = state.projects.find(item => item.id === id);
      if (!project) throw new InputError('找不到这个工程。', 404);
      if (Boolean(project.deletedAt) !== deleted) {
        project.deletedAt = deleted ? new Date().toISOString() : null;
        touch(project);
      }
      return project;
    });
  }

  async permanentlyDelete(id, isBusy = () => false) {
    await this.mutate(state => {
      const project = state.projects.find(item => item.id === id);
      if (!project) throw new InputError('找不到这个工程。', 404);
      if (!project.deletedAt) throw new InputError('请先将工程移到“已删除工程”，再彻底删除。', 409);
      const jobs = state.jobs.filter(job => job.projectId === id);
      const imageJobs = (state.imageJobs || []).filter(job => job.projectId === id);
      const previsJobs = (state.previsJobs || []).filter(job => job.projectId === id);
      if (previsJobs.some(job => !['done', 'failed', 'cancelled'].includes(job.state))) throw new InputError('工程还有未完成的 Blender 预演，请先完成或取消，再彻底删除。', 409);
      const speechJobs = (state.speechJobs || []).filter(job => job.projectId === id);
      if (jobs.some(job => !['done', 'failed'].includes(job.state)) || imageJobs.some(job => !['done', 'failed'].includes(job.state)) || speechJobs.some(job => !['done', 'failed'].includes(job.state)) || project.exports.some(output => output.state === 'running') || isBusy(project, jobs, imageJobs)) {
        throw new InputError('工程还有生成、下载、合成或需核对的任务。请先恢复工程，处理完任务后再彻底删除。', 409);
      }
      state.projects = state.projects.filter(item => item.id !== id);
      state.previsJobs = (state.previsJobs || []).filter(job => job.projectId !== id);
      for (const job of previsJobs) if (/^[a-f0-9-]{36}$/.test(job.id)) state.pendingFileDeletes.push({ directory: 'previs', file: job.id });
      for (const job of jobs) {
        state.pendingFileDeletes.push({ directory: 'video-task-connections', file: `${job.id}.private.json` });
      }
      state.jobs = state.jobs.filter(job => job.projectId !== id);
      for (const job of speechJobs) {
        state.pendingFileDeletes.push({ directory: 'speech-results', file: `${job.id}.json` });
        state.pendingFileDeletes.push({ directory: 'speech-task-connections', file: `${job.id}.private.json` });
      }
      state.speechJobs = (state.speechJobs || []).filter(job => job.projectId !== id);
      state.imageJobs = (state.imageJobs || []).filter(job => {
        if (job.projectId === id) state.pendingFileDeletes ||= [];
        if (job.projectId === id && !state.pendingFileDeletes.some(item => item.directory === 'image-results' && item.file === `${job.id}.json`)) {
          state.pendingFileDeletes.push({ directory: 'image-results', file: `${job.id}.json` });
        }
        return job.projectId !== id;
      });
      state.pendingFileDeletes ||= [];
      for (const [directory, records] of [['assets', project.assets], ['exports', project.exports]]) {
        for (const record of records) {
          if (!managedFile(this.root, directory, record.file)) continue;
          if (!state.pendingFileDeletes.some(item => item.directory === directory && item.file === record.file)) {
            state.pendingFileDeletes.push({ directory, file: record.file });
          }
        }
      }
    });
    // Commit removal before unlinking. A crash or open media file can be retried at startup.
    const pending = await this.cleanupDeletedFiles().catch(() => this.state.pendingFileDeletes.length);
    return { id, cleanupPending: pending };
  }

  async permanentlyDeleteJob(id, kind, isBusy = () => false) {
    const collection = kind === 'image' ? 'imageJobs' : 'jobs';
    await this.mutate(state => {
      const job = (state[collection] || []).find(item => item.id === id);
      if (!job) throw new InputError('找不到这个生成任务。', 404);
      if (!job.deletedAt) throw new InputError('请先删除任务记录，再彻底删除。', 409);
      if (!['done', 'failed'].includes(job.state) || isBusy(id)) {
        throw new InputError('任务仍在生成、下载或需要核对，请先处理完再彻底删除。', 409);
      }
      state[collection] = state[collection].filter(item => item.id !== id);
      state.pendingFileDeletes ||= [];
      state.pendingFileDeletes.push({ directory: kind === 'image' ? 'image-results' : 'video-task-connections', file: `${id}${kind === 'image' ? '.json' : '.private.json'}` });
      if (kind === 'image') {
        const project = state.projects.find(item => item.id === job.projectId);
        if (project) { syncImageCardJobs(project, state.imageJobs); touch(project); }
      }
    });
    const pending = await this.cleanupDeletedFiles().catch(() => this.state.pendingFileDeletes.length);
    return { id, cleanupPending: pending };
  }

  async cleanupDeletedFiles() {
    return this.mutate(async state => {
      const pending = [];
      for (const item of state.pendingFileDeletes || []) {
        const filename = managedFile(this.root, item.directory, item.file);
        if (!filename) continue;
        const field = item.directory === 'assets' ? 'assets' : 'exports';
        if (item.directory === 'previs') {
          if ((state.previsJobs || []).some(job => job.id === item.file)) continue;
        } else if (item.directory === 'video-task-connections') {
          if (state.jobs.some(job => `${job.id}.private.json` === item.file)) continue;
        } else if (item.directory === 'image-results') {
          if ((state.imageJobs || []).some(job => `${job.id}.json` === item.file)) continue;
        } else if (['speech-results', 'speech-task-connections'].includes(item.directory)) {
          if ((state.speechJobs || []).some(job => `${job.id}${item.directory === 'speech-results' ? '.json' : '.private.json'}` === item.file)) continue;
        } else if (state.projects.some(project => project[field].some(record => record.file === item.file))) continue;
        try { if (item.directory === 'previs') await rm(filename, { recursive: true, force: true }); else await unlink(filename); }
        catch (error) { if (error.code !== 'ENOENT') pending.push(item); }
      }
      state.pendingFileDeletes = pending;
      return pending.length;
    });
  }

  async connections() {
    try { return JSON.parse(await readFile(path.join(this.root, 'connections.private.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async saveConnections(items) { await atomicJson(path.join(this.root, 'connections.private.json'), items, 0o600); }
  async connectionFor(kind, model, fallback) {
    const items = (await this.connections()).filter(item => item.kind === kind);
    const match = model ? items.find(item => item.models.includes(model)) : items[0];
    if (model && items.length && !match && !fallback.apiKey) throw new InputError('所选模型尚未绑定 API，请在连接中心绑定模型。');
    return match && (model || !fallback.apiKey) ? { ...fallback, ...match, connectionId: match.id } : fallback;
  }
  async settings() {
    try { return JSON.parse(await readFile(path.join(this.root, 'connection.private.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  async saveSettings(settings) { await atomicJson(path.join(this.root, 'connection.private.json'), settings, 0o600); }
  videoTaskConnectionFile(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new InputError('视频任务编号格式不正确。');
    return path.join(this.root, 'video-task-connections', id + '.private.json');
  }
  async saveVideoTaskSettings(id, settings) {
    const filename = this.videoTaskConnectionFile(id);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    try { return JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const connection = { baseUrl: settings.baseUrl, apiKey: settings.apiKey || '' };
    await atomicJson(filename, connection, 0o600);
    return connection;
  }
  async videoTaskSettings(job) {
    try { return JSON.parse(await readFile(this.videoTaskConnectionFile(job.id), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Snapshot existing records before any subsequent settings change.
      const settings = await this.settings();
      return this.saveVideoTaskSettings(job.id, { ...settings,
        baseUrl: job.providerBaseUrl || (job.requestMode === LEGACY_VIDEO_REQUEST_MODE ? LEGACY_PLATFORM : settings.baseUrl) });
    }
  }
  async migrateVideoSettings() {
    const previous = await this.settings();
    if (previous.baseUrl === LEGACY_PLATFORM) {
      for (const job of this.state.jobs) await this.saveVideoTaskSettings(job.id, previous);
      if (this.state.jobs.length) await this.mutate(state => {
        for (const job of state.jobs) {
          job.requestMode ||= LEGACY_VIDEO_REQUEST_MODE;
          job.providerBaseUrl ||= LEGACY_PLATFORM;
        }
      });
    }
    const next = { ...DEFAULT_CONNECTION, ...previous, platform: DEFAULT_CONNECTION.platform,
      baseUrl: videoBaseUrl(previous.baseUrl === LEGACY_PLATFORM ? PLATFORM : previous.baseUrl || PLATFORM),
      docsUrl: VIDEO_DOCS_URL };
    if (!catalogForVideoModelIds([next.videoModel]).length) next.videoModel = DEFAULT_CONNECTION.videoModel;
    await this.saveSettings(next);
  }
  async imageSettings() {
    try { return { ...DEFAULT_IMAGE_CONNECTION, ...JSON.parse(await readFile(path.join(this.root, 'image-connection.private.json'), 'utf8')) }; }
    catch (error) { if (error.code === 'ENOENT') return { ...DEFAULT_IMAGE_CONNECTION }; throw error; }
  }
  async saveImageSettings(settings) { await atomicJson(path.join(this.root, 'image-connection.private.json'), settings, 0o600); }
  async textSettings() {
    try { return { ...DEFAULT_TEXT_CONNECTION, ...JSON.parse(await readFile(path.join(this.root, 'text-connection.private.json'), 'utf8')) }; }
    catch (error) { if (error.code === 'ENOENT') return { ...DEFAULT_TEXT_CONNECTION }; throw error; }
  }
  async saveTextSettings(settings) { await atomicJson(path.join(this.root, 'text-connection.private.json'), settings, 0o600); }
  async speechSettings() {
    try { return { ...DEFAULT_SPEECH_CONNECTION, ...JSON.parse(await readFile(path.join(this.root, 'speech-connection.private.json'), 'utf8')) }; }
    catch (error) { if (error.code === 'ENOENT') return { ...DEFAULT_SPEECH_CONNECTION }; throw error; }
  }
  async saveSpeechSettings(settings) { await atomicJson(path.join(this.root, 'speech-connection.private.json'), settings, 0o600); }
  async migrateSpeechSettings() {
    const settings = await this.speechSettings();
    if (!settings.apiKey) return;
    const connections = await this.connections();
    const bound = new Set(connections.filter(item => item.kind === 'speech').flatMap(item => item.models));
    const models = SPEECH_MODELS.filter(model => !bound.has(model));
    if (models.length) await this.saveConnections([...connections, { id: randomUUID(), name: 'MiniMax 语音', kind: 'speech',
      baseUrl: SPEECH_ENDPOINTS[settings.region || 'domestic'], models, apiKey: settings.apiKey }]);
    await this.saveSpeechSettings({ ...settings, apiKey: '' });
  }
}

function managedFile(root, directory, file) {
  if (!['assets', 'exports', 'image-results', 'video-task-connections', 'previs', 'speech-results', 'speech-task-connections'].includes(directory) || typeof file !== 'string' || !file || /[\\/:\0]/.test(file)) return null;
  if (directory === 'previs' && !/^[a-f0-9-]{36}$/.test(file)) return null;
  const parent = path.resolve(root, directory), filename = path.resolve(parent, file);
  return path.dirname(filename) === parent ? filename : null;
}

export async function atomicJson(filename, data, mode = 0o600) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', mode });
  // Windows can briefly hold the destination while another reader closes it.
  // Retry transient rename errors without weakening the atomic replacement.
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await rename(temporary, filename); lastError = null; break; }
    catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code) || attempt === 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  if (lastError) throw lastError;
  await chmod(filename, mode);
}

export function publicSettings(settings, storage = null, imageSettings = {}, textSettings = {}) {
  const storageReady = Boolean(storage?.ready);
  return { platform: settings.platform || '', docsUrl: VIDEO_DOCS_URL, baseUrl: settings.baseUrl || '',
    textModel: settings.textModel || '', imageModel: settings.imageModel || '', videoModel: settings.videoModel || '',
    resolution: settings.resolution || '720p', hasKey: Boolean(settings.apiKey), adapterReady: true,
    videoRequestMode: VIDEO_REQUEST_MODE,
    generationCountMax: MAX_GENERATION_COUNT, maxConcurrentTasks: MAX_CONCURRENT_TASKS,
    referenceGenerationReady: true, referenceUrlRequired: !storageReady, referencePreparationLimit: REFERENCE_PREPARATION_LIMIT,
    storage: storage || { ready: false, enabled: false, bucket: '', region: 'ap-guangzhou', prefix: 'jingce', expiresHours: 72, hasCredentials: false },
    image: { platform: imageSettings.platform || DEFAULT_IMAGE_CONNECTION.platform, baseUrl: imageSettings.baseUrl || IMAGE_PLATFORM,
      docsUrl: imageSettings.docsUrl || IMAGE_DOCS_URL, imageModel: imageSettings.imageModel || DEFAULT_IMAGE_CONNECTION.imageModel,
      hasKey: Boolean(imageSettings.apiKey), adapterReady: true, generationCountMax:IMAGE_GENERATION_COUNT_MAX, maxConcurrentTasks:3,
      referenceGenerationReady:true, referenceUpload:true, referenceModelNames:IMAGE_REFERENCE_MODELS, referenceCountMax:IMAGE_REFERENCE_MAX,
      referenceFileLimit:IMAGE_REFERENCE_FILE_LIMIT, referenceTotalLimit:IMAGE_REFERENCE_TOTAL_LIMIT },
    text: { platform: textSettings.platform || DEFAULT_TEXT_CONNECTION.platform, baseUrl: textSettings.baseUrl || TEXT_PLATFORM,
      docsUrl: textSettings.docsUrl || TEXT_DOCS_URL, textModel: textSettings.textModel || '',
      hasKey: Boolean(textSettings.apiKey), adapterReady: true },
    message: '新版视频可选择 1–15 秒和 1–5 个候选；' + (storageReady
      ? '本机参考素材会在生成时自动上传并生成临时 HTTPS 链接。'
      : '图片、视频和音频参考需填写公网 HTTPS 素材链接。')
      + '参数和素材能力由具体模型决定；报价请联系平台，实际扣费以平台账单为准。' };
}
