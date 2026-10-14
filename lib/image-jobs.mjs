import { mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { InputError, touch } from './workflow.mjs';
import { detectMedia, downloadPublicImage } from './media.mjs';
import { submitImage, UncertainImageSubmission } from './image-provider.mjs';
import { atomicJson } from './store.mjs';
import { imageEstimate } from '../public/image-parameters.js';

import { normalizeImageConfig, isImageGenerationNode, resolveImageInputs, buildImagePrompt, imageRequestIssue, IMAGE_ACTIVE_STATES, syncImageCardJobs, normalizeImageCount, IMAGE_REFERENCE_MAX, IMAGE_REFERENCE_FILE_LIMIT, IMAGE_REFERENCE_TOTAL_LIMIT } from '../public/image-parameters.js';

const IMAGE_RESULT_LIMIT = 20 * 1024 * 1024;
const IMAGE_MAX_CONCURRENT_TASKS = 3;

export const publicImageJob = job => ({
  id: job.id, kind: 'image', projectId: job.projectId, sceneId: job.sceneId || '', nodeId: job.nodeId || '', model: job.model,
  config: job.config || null, batchId: job.batchId || '', count: job.count || 1, variantIndex: job.variantIndex || 1,
  batchOperationId: job.batchOperationId || job.operationId || '',
  referenceAssetIds: (job.references || []).map(reference => reference.assetId),
  prompt: job.prompt, state: job.state, deletedAt: job.deletedAt || null,
  message: job.message || '', createdAt: job.createdAt, updatedAt: job.updatedAt,
  lastCheckedAt: job.lastCheckedAt || null, assetId: job.assetId || '', operationId: job.operationId || '',
});

export class ImageJobs {
  constructor(store, integrations = {}) {
    this.store = store;
    this.submit = integrations.submitImage || submitImage;
    this.downloadImage = integrations.downloadImage || downloadPublicImage;
    this.busy = new Set();
    this.preparedReferences = new Map();
    this.closed = false;
    this.resultRoot = path.join(store.root, 'image-results');
  }

  async init() {
    await mkdir(this.resultRoot, { recursive: true, mode: 0o700 });
    await this.store.mutate(state => {
      state.imageJobs ||= [];
      for (const job of state.imageJobs) {
        if (job.state === 'submitting') {
          job.state = 'uncertain';
          job.message = '程序在生图提交期间关闭。请先核对平台记录，避免重复收费。';
        } else if (job.state === 'preparing') {
          job.state = 'waiting';
          job.message = '参考文件准备被中断，正在继续准备；尚未提交生图。';
        } else if (job.state === 'saving') {
          job.state = 'download_pending';
          job.message = '上次保存图片被中断，可重试保存；不会重新提交生图。';
        }
      }
      for (const project of state.projects) syncImageCardJobs(project, state.imageJobs);
    });
    this.timer = setInterval(() => this.tick().catch(() => {}), 10000);
    this.timer.unref();
    await this.tick();
  }

  close() { this.closed = true; clearInterval(this.timer); }

  list(projectId, includeDeleted = false) {
    return (this.store.state.imageJobs || [])
      .filter(job => job.projectId === projectId && (includeDeleted || !job.deletedAt))
      .map(publicImageJob).reverse();
  }

  async setDeleted(id, deleted) {
    const job = await this.store.mutate(state => {
      const current = (state.imageJobs || []).find(item => item.id === id);
      if (!current) throw new InputError('找不到这个生图任务。', 404);
      current.deletedAt = deleted ? current.deletedAt || new Date().toISOString() : null;
      current.updatedAt = new Date().toISOString();
      return current;
    });
    return publicImageJob(job);
  }

  async start(projectId, input = {}, catalog = []) {
    const batch = await this.startBatch(projectId, input, catalog);
    return batch.count === 1 ? batch.jobs[0] : batch;
  }

  async startBatch(projectId, input = {}, catalog = []) {
    const operationId = String(input.operationId || '').trim();
    if (!operationId || operationId.length > 120) throw new InputError('生图操作编号不正确。');
    let requestedCount;
    try {
      if (input.count != null || input.config?.count != null) requestedCount = normalizeImageCount(input.count ?? input.config.count);
    } catch (error) { throw new InputError(error.message); }
    let settings = await this.store.connectionFor('image', input.model || input.config?.model, await this.store.imageSettings());
    let created = false, prepared = [];
    // The entire operation, references and count are checked before any paid call.
    const batch = await this.store.mutate(async state => {
      state.imageJobs ||= [];
      const existing = state.imageJobs.filter(job => job.projectId === projectId && (job.operationId === operationId || job.batchOperationId === operationId));
      if (existing.length) {
        const count = existing[0].count || existing.length;
        if (requestedCount != null && requestedCount !== count) throw new InputError('此操作编号已提交 ' + count + ' 张图片；不能通过重试改变张数或补交候选。',409);
        return {batchId:existing[0].batchId || existing[0].id, operationId, count, jobs:existing.sort((a,b) => (a.variantIndex || 1) - (b.variantIndex || 1))};
      }
      if (!settings.apiKey) throw new InputError('先在“生图连接”中保存 API Key，再生成图片。');
      const project = state.projects.find(project => project.id === projectId && !project.deletedAt);
      if (!project) throw new InputError('工程不存在或已删除。',404);
      const nodeId = String(input.nodeId || '').trim();
      const node = (project.graph?.nodes || []).find(node => node.id === nodeId);
      if (nodeId && !isImageGenerationNode(node)) throw new InputError('生图卡片不存在，请刷新页面后重试。');
      if (nodeId && state.imageJobs.some(job => job.projectId === projectId && job.nodeId === nodeId && IMAGE_ACTIVE_STATES.has(job.state))) {
        throw new InputError('此卡片已有生图任务在处理或需核对，请先查看原任务，避免重复收费。',409);
      }
      let config, prompt, references, count;
      try {
        const rawConfig = {...input.config};
        if (input.model !== undefined) rawConfig.model = input.model;
        if (input.prompt !== undefined) rawConfig.prompt = input.prompt;
        config = normalizeImageConfig(node ? node.imageConfig : rawConfig, settings.imageModel);
        if (node && input.expectedConfig && JSON.stringify(normalizeImageConfig(input.expectedConfig,settings.imageModel)) !== JSON.stringify(config)) {
          throw new InputError('生图卡片设置已变化，请刷新后再提交。',409);
        }
        count = requestedCount ?? config.count;
        config = {...config, count};
        const inputs = node ? resolveImageInputs(project,node) : {references:[], textInputs:[]};
        if (input.references != null && !Array.isArray(input.references)) throw new InputError('图片参考格式不正确。');
        if (input.referenceAssetIds != null && !Array.isArray(input.referenceAssetIds)) throw new InputError('参考图片编号列表格式不正确。');
        const supplied = [...(input.references || []), ...(input.referenceAssetIds || []).map(assetId => {
          if (typeof assetId !== 'string' || !assetId.trim() || assetId.length > 100) throw new InputError('有参考图片编号无效，请重新选择图片。');
          return {assetId:assetId.trim(), kind:'image'};
        })];
        // Invalid references remain visible to validation instead of being filtered.
        inputs.references.push(...supplied);
        const issue = imageRequestIssue(config,inputs,catalog?.find(model=>model.name===config.model));
        if (issue) throw new InputError(issue);
        const seen = new Set();
        references = inputs.references.filter(reference => !seen.has(reference.assetId) && seen.add(reference.assetId)).map(reference => {
          const asset = project.assets.find(asset => asset.id === reference.assetId && !asset.deletedAt);
          if (!asset || asset.kind !== 'image') throw new InputError('参考图片不存在、已删除或不属于当前工程，请重新选择。');
          return {assetId:asset.id, kind:'image', name:asset.name || '参考图片'};
        });
        prompt = buildImagePrompt(config,inputs.textInputs);
      } catch (error) { throw error instanceof InputError ? error : new InputError(error.message); }
      const sceneId = node ? '' : String(input.sceneId || '').trim();
      if (sceneId && !project.scenes.some(scene => scene.id === sceneId)) throw new InputError('关联的视频生成项不存在，请刷新页面后重试。');
      const selected = config.model;
      settings = await this.store.connectionFor('image', selected, settings);
      if (!settings.apiKey) throw new InputError('所选模型的 API 令牌尚未配置。');
      if (!selected) throw new InputError('请选择生图模型。');
      if (Array.isArray(catalog) && catalog.length && !catalog.some(model => model.name === selected)) throw new InputError('所选生图模型不在当前公开模型目录中，请先刷新模型目录。');
      // Read all actual files once for this batch before recording/submitting it.
      prepared = await this.readReferences(project,references);
      const now = new Date().toISOString(), batchId = randomUUID(), jobs = [];
      const quote = imageEstimate(catalog?.find(model => model.name === selected), { ...config, count: 1 });
      for (let variantIndex = 1; variantIndex <= count; variantIndex++) {
        const job = {id:randomUUID(), kind:'image', projectId, sceneId, nodeId, config, model:selected, prompt, references,
          modelCapabilities:structuredClone(catalog?.find(model=>model.name===selected)?.capabilities),
          operationId, batchOperationId:operationId, batchId, count, variantIndex,
          estimate: quote.totalMin, estimateMax: quote.totalMax, priceUnit: quote.unit, pricingCurrency: quote.unit === '人民币￥/张' ? 'CNY' : '',
          state:'waiting', message:'图片任务已排队；每个候选单独提交，原操作不会重复收费。',
          createdAt:now, updatedAt:now, assetId:'', lastCheckedAt:null};
        await this.store.saveVideoTaskSettings(job.id, settings);
        job.connectionSnapshot = true;
        state.imageJobs.push(job); jobs.push(job);
      }
      if (node) { node.imageJobId=jobs.at(-1).id; node.imageJobIds=jobs.map(job => job.id); node.status='pending'; touch(project); }
      created = true;
      return {batchId,operationId,count,jobs};
    });
    if (created) {
      this.preparedReferences.set(batch.batchId,prepared);
      void this.tick(false).catch(() => {});
    }
    return {...batch, jobs:batch.jobs.map(publicImageJob)};
  }

  async readReferences(project, references = []) {
    if (!Array.isArray(references) || references.length > IMAGE_REFERENCE_MAX) throw new InputError('参考图片数量或格式不正确。');
    if (!references.length) return [];
    const assetRoot = await realpath(path.join(this.store.root,'assets'));
    let total = 0;
    const files = [];
    for (const reference of references) {
      const asset = project.assets.find(asset => asset.id === reference.assetId && !asset.deletedAt && asset.kind === 'image');
      if (!asset || typeof asset.file !== 'string' || !asset.file || path.basename(asset.file) !== asset.file) {
        throw new InputError('参考图片文件不可用，请重新上传或选择图片。');
      }
      let file, info, bytes;
      try {
        file = await realpath(path.join(assetRoot,asset.file));
        const relative = path.relative(assetRoot,file);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new InputError('参考图片文件位置不正确。');
        info = await stat(file);
        if (!info.isFile() || !info.size || info.size > IMAGE_REFERENCE_FILE_LIMIT) throw new InputError('参考图片缺失，或单张大小超过 20 MiB。');
        total += info.size;
        if (total > IMAGE_REFERENCE_TOTAL_LIMIT) throw new InputError('参考图片总大小超过 64 MiB，请减少图片。');
        bytes = await readFile(file);
      } catch (error) {
        throw error instanceof InputError ? error : new InputError('参考图片文件无法读取，请重新上传或选择图片。');
      }
      if (!bytes.byteLength || bytes.byteLength > IMAGE_REFERENCE_FILE_LIMIT) throw new InputError('参考图片文件大小超过 20 MiB。');
      const media = detectMedia(bytes.subarray(0,32));
      if (media.kind !== 'image') throw new InputError('参考图片应为 PNG、JPEG 或 WebP 文件。');
      files.push({assetId:asset.id, name:asset.name || 'reference', mime:media.mime, data:bytes});
    }
    return files;
  }

  resultFile(id) { return path.join(this.resultRoot, `${id}.json`); }

  async process(id) {
    if (this.busy.has(id) || this.closed) return;
    const job = (this.store.state.imageJobs || []).find(item => item.id === id);
    if (!job || !['waiting','preparing'].includes(job.state)) return;
    this.busy.add(id);
    let submitted = false, resultReceived = false;
    try {
      await this.patch(id,{state:'preparing',message:'正在核对并读取参考图片；尚未提交收费请求。'});
      const settings = job.connectionSnapshot ? await this.store.videoTaskSettings(job) : await this.store.connectionFor('image', job.model, await this.store.imageSettings());
      if (!settings.apiKey) throw new InputError('生图 API Key 尚未配置，图片任务未提交。');
      let references = this.preparedReferences.get(job.batchId);
      if (!references) references = await this.readReferences(this.store.get(job.projectId),job.references || []);
      const request = {model:job.model,prompt:job.prompt,n:1};
      if (job.modelCapabilities) request.modelCapabilities=job.modelCapabilities;
      if (job.config && (job.config.ratio !== 'auto' || job.config.quality !== 'auto' || job.config.style !== 'auto')) {
        request.config = job.config;
      }
      if (references.length) request.references = references;
      await this.patch(id,{state:'submitting',message:'正在提交第 ' + (job.variantIndex || 1) + '/' + (job.count || 1) + ' 张图片；平台返回前不会重复提交。'});
      submitted = true;
      const result = await this.submit(settings,request);
      resultReceived = true;
      await atomicJson(this.resultFile(job.id),result,0o600);
      await this.patch(job.id,{state:'download_pending',message:'图片已生成，正在保存到本机素材库。',lastCheckedAt:new Date().toISOString()});
      await this.save(job.id);
    } catch (error) {
      const uncertain = error instanceof UncertainImageSubmission || resultReceived || submitted && !(error instanceof InputError);
      const message = error instanceof UncertainImageSubmission ? error.message : error instanceof InputError ? error.message
        : uncertain ? '生图提交或结果保存中断，请先核对平台记录，避免重复收费。' : '参考准备失败；尚未提交生图请求。';
      await this.patch(id,{state:uncertain ? 'uncertain' : 'failed',message,lastCheckedAt:new Date().toISOString()});
    } finally {
      this.busy.delete(id);
      if (!(this.store.state.imageJobs || []).some(item => item.batchId === job.batchId && ['waiting','preparing','submitting'].includes(item.state))) {
        this.preparedReferences.delete(job.batchId);
      }
      if (!this.closed) void this.tick(false).catch(() => {});
    }
  }

  async patch(id, patch) {
    return this.store.mutate(state => {
      const job = (state.imageJobs || []).find(item => item.id === id);
      if (!job) throw new InputError('找不到这个生图任务。', 404);
      Object.assign(job, patch, { updatedAt: new Date().toISOString() });
      const project = state.projects.find(project => project.id === job.projectId);
      if (project) {
        const before = JSON.stringify(project.graph.nodes);
        syncImageCardJobs(project,state.imageJobs);
        if (before !== JSON.stringify(project.graph.nodes)) touch(project);
      }
      return job;
    });
  }

  async readResult(id) {
    try { return JSON.parse(await readFile(this.resultFile(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async save(id) {
    const job = (this.store.state.imageJobs || []).find(item => item.id === id);
    if (!job || job.state === 'done' || this.busy.has(`${id}:save`)) return;
    const result = await this.readResult(id);
    if (!result) {
      await this.patch(id, { state: 'download_pending', message: '已生成但本机暂未找到图片结果，可稍后重试保存。' });
      return;
    }
    this.busy.add(`${id}:save`);
    await this.patch(id, { state: 'saving', message: '正在保存并检查图片文件。' });
    const temporary = path.join(this.store.root, 'assets', `${randomUUID()}.image`);
    let file = '';
    try {
      let size;
      if (result.kind === 'base64') {
        const data = Buffer.from(String(result.data || '').replace(/\s+/g, ''), 'base64');
        if (!data.length || data.length > IMAGE_RESULT_LIMIT) throw new InputError('生图结果超过 20 MB 或为空。', 502);
        await writeFile(temporary, data, { flag: 'wx' }); size = data.length;
      } else if (result.kind === 'url') {
        size = await this.downloadImage(result.url, temporary);
      } else throw new InputError('生图结果格式不正确，无法保存。', 502);
      const handle = await import('node:fs/promises').then(fs => fs.open(temporary, 'r'));
      const prefix = Buffer.alloc(32);
      try { await handle.read(prefix, 0, 32, 0); } finally { await handle.close(); }
      const media = detectMedia(prefix);
      if (media.kind !== 'image') throw new InputError('平台返回的结果不是 PNG、JPEG 或 WebP 图片。', 502);
      const assetId = randomUUID(); file = `${assetId}${media.extension}`;
      await import('node:fs/promises').then(fs => fs.rename(temporary, path.join(this.store.root, 'assets', file)));
      await this.store.mutate(state => {
        const current = (state.imageJobs || []).find(item => item.id === id);
        const project = state.projects.find(item => item.id === job.projectId);
        if (!current || !project) throw new InputError('工程或图片生成任务已经不存在。', 404);
        const scene = project.scenes.find(item => item.id === current.sceneId);
        const asset = { id: assetId, name: `生成图片 · ${current.model}`, file, kind: 'image', mime: media.mime, size,
          createdAt: new Date().toISOString(), source: 'model', batchId:current.batchId || '', variantIndex:current.variantIndex || 1, sceneId: current.sceneId || '', nodeId:current.nodeId || '', jobId: current.id, model: current.model };
        project.assets.push(asset);
        if (scene && !scene.imageAssetId && scene.imagePrompt === current.prompt) scene.imageAssetId = assetId;

        Object.assign(current, { state: 'done', message: '图片已保存到本机素材库。', assetId, updatedAt: new Date().toISOString() });
        syncImageCardJobs(project,state.imageJobs);
        touch(project);
      });
      await unlink(this.resultFile(id)).catch(() => {});
    } catch (error) {
      await unlink(temporary).catch(() => {});
      if (file) await unlink(path.join(this.store.root,'assets',file)).catch(() => {});
      await this.patch(id, { state: 'download_pending', message: error instanceof InputError ? error.message : '图片保存失败，可重试保存，不会重新生成。' });
    } finally { this.busy.delete(`${id}:save`); }
  }

  async retry(id) {
    const job = (this.store.state.imageJobs || []).find(item => item.id === id);
    if (!job) throw new InputError('找不到这个生图任务。', 404);
    if (job.state === 'done') return publicImageJob(job);
    if (job.state === 'uncertain') throw new InputError('这次生图提交结果无法确认，请先核对平台记录；这里不会重复提交。');
    if (!(await this.readResult(id))) throw new InputError('本机没有可重试保存的图片结果。');
    await this.patch(id, { state: 'download_pending' });
    void this.save(id).catch(() => {});
    return publicImageJob(this.store.state.imageJobs.find(item => item.id === id));
  }

  async tick(saveResults = true) {
    for (const job of [...(this.store.state.imageJobs || [])]) {
      if (saveResults && job.state === 'download_pending' && !this.busy.has(job.id)) void this.save(job.id).catch(() => {});
      const active = [...this.busy].filter(id => !id.endsWith(':save')).length;
      if (job.state === 'waiting' && active < IMAGE_MAX_CONCURRENT_TASKS && !this.closed) void this.process(job.id).catch(() => {});
    }
  }
}

