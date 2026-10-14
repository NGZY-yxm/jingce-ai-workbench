import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, readdir, stat, rename, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Store, atomicJson, publicSettings } from './lib/store.mjs';
import { createProject, updateProject, setAssetDeleted, draftPlan, importProject, exportProject, screenplay, InputError, touch, kinds } from './lib/workflow.mjs';
import { loadCatalog, checkConnection, DEFAULT_CONNECTION, PLATFORM, videoBaseUrl, submitVideo, pollVideo } from './lib/providers.mjs';
import { VideoJobs } from './lib/jobs.mjs';
import { ImageJobs } from './lib/image-jobs.mjs';
import { loadImageCatalog, loadImageCapabilityRecords, imageCatalogOrFallback, checkImageConnection, DEFAULT_IMAGE_CONNECTION, IMAGE_PLATFORM } from './lib/image-provider.mjs';
import { loadTextCatalog, checkTextConnection, chatText, normalizeTextMessages, DEFAULT_TEXT_CONNECTION, TEXT_PLATFORM } from './lib/text-provider.mjs';
import { detectMedia } from './lib/media.mjs';
import { CosStorage, publicStorageSettings } from './lib/storage.mjs';
import { createVideoCatalogSync } from './lib/video-catalog-sync.mjs';
import { selectVideoCatalogModels, mergeVideoCatalogs } from './lib/video-model-discovery.mjs';
import { readCapabilitySettings, saveCapabilitySettings, effectiveModelCatalog, validateCapabilityEdit, normalizeFamilyName, normalizeFamilySupplement } from './lib/model-capabilities.mjs';
import { validateNewModelLinks } from './public/model-link-rules.js';
import { declaredCapabilities } from './public/model-capabilities.js';
import { toolStatus, compositionClips, compositionAudio, compose } from './lib/compose.mjs';
import { SkillLibrary, previewSkills } from './lib/skills.mjs';
import { ChatImages } from './lib/chat-images.mjs';
import { PrevisJobs, validatePrevisSpec } from './lib/previs.mjs';
import { blenderHelperPackage } from './lib/previs-helper-package.mjs';
import { MediaThumbnails, THUMBNAIL_PLACEHOLDER } from './lib/media-thumbnails.mjs';
import { SpeechJobs, publicSpeechJob } from './lib/speech-jobs.mjs';
import { VoiceJobs, publicVoiceJob } from './lib/voice-jobs.mjs';
import { VOICE_RECORDING_LIMIT } from './public/voice-parameters.js';
import { normalizeSpeechSettings, publicSpeechSettings, listSpeechVoices } from './lib/speech-provider.mjs';
import { SPEECH_MODELS } from './public/speech-parameters.js';
import { AuthStore, migrateLegacyWorkspace, SESSION_COOKIE } from './lib/auth.mjs';
import { ManagementStore } from './lib/management.mjs';
import { managementRequest } from './lib/management-http.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
const json = (response, body, status = 200) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
};
async function requestJson(request, maxBytes = 2 * 1024 * 1024) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw new InputError('请求需要使用 JSON 格式。');
  let bytes = 0; const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length; if (Number.isFinite(maxBytes) && bytes > maxBytes) throw new InputError(`请求内容超过 ${Math.round(maxBytes / 1024 / 1024)} MB。`, 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new InputError('JSON 格式不正确。'); }
}

async function serveMedia(request, response, filename, mime, name) {
  const info = await stat(filename);
  const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=60' };
  if (name) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range || '');
  let start = 0; let end = info.size - 1;
  if (request.headers.range) {
    if (!match || !info.size) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return; }
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!suffix) { response.writeHead(416); response.end(); return; }
      start = Math.max(0, info.size - suffix);
    } else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end; }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
      response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return;
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1);
  response.writeHead(match ? 206 : 200, headers);
  if (request.method === 'HEAD' || !info.size) { response.end(); return; }
  await pipeline(createReadStream(filename, { start, end }), response);
}

async function upload(request, store, projectId) {
  store.get(projectId);
  if (Number(request.headers['content-length']) > 300 * 1024 * 1024) throw new InputError('媒体文件最大支持 300 MB。', 413);
  const id = randomUUID(); const temporary = path.join(store.root, 'assets', `${id}.upload`);
  let prefix = Buffer.alloc(0); let bytes = 0; let media; let destination;
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    if (prefix.length < 32) prefix = Buffer.concat([prefix, chunk.subarray(0, 32 - prefix.length)]);
    bytes += chunk.length;
    try {
      if (!media && prefix.length >= 32) media = detectMedia(prefix);
      const limit = media?.kind === 'image' ? 20 * 1024 * 1024 : media?.kind === 'audio' ? 100 * 1024 * 1024 : 300 * 1024 * 1024;
      if (bytes > limit) throw new InputError('图片最大 20 MB、音频最大 100 MB、视频最大 300 MB。', 413);
      callback(null, chunk);
    } catch (error) { callback(error); }
  } });
  try {
    await pipeline(request, meter, createWriteStream(temporary, { flags: 'wx' }));
    media ||= detectMedia(prefix);
    const file = `${id}${media.extension}`;
    destination = path.join(store.root, 'assets', file);
    await rename(temporary, destination);
    let name;
    try { name = decodeURIComponent(request.headers['x-file-name'] || '上传素材').slice(0, 200); }
    catch { name = '上传素材'; }
    const asset = { id, name, file, ...media, size: bytes, createdAt: new Date().toISOString(), source: 'upload' };
    const project = await store.update(projectId, current => {
      current.assets.push(asset);
      for (const node of current.graph.nodes.filter(node => node.kind === media.kind)) node.status = 'uploaded';
      return touch(current);
    });
    return { asset, project };
  } catch (error) {
    await unlink(temporary).catch(() => {});
    if (destination) await unlink(destination).catch(() => {});
    throw error;
  }
}

export async function createStudio(options = {}) {
  if (options.multiUser) return createGateway(options);
  const root = options.root || path.join(directory, 'runtime');
  const publicOrigin = options.publicOrigin ?? process.env.JINGCE_PUBLIC_ORIGIN ?? '';
  if (publicOrigin) {
    let valid = false;
    try { const url = new URL(publicOrigin); valid = url.protocol === 'https:' && url.origin === publicOrigin; } catch { /* Reject malformed configuration. */ }
    if (!valid) throw new InputError('JINGCE_PUBLIC_ORIGIN 需要是完整的 HTTPS 网站来源，不含路径或结尾斜线。');
  }
  const store = new Store(root, { onStateSaved: options.onStateSaved, getProjectLimit: options.getProjectLimit }); await store.init();
  await options.onStateSaved?.(store.state);
  const previs = new PrevisJobs(store, options.previs || {}); await previs.init();
  const skills = new SkillLibrary(root); await skills.init();
  const chatImages = new ChatImages(store, options.chatImages); await chatImages.init();
  const thumbnails = new MediaThumbnails(root, options.thumbnails);
  async function serveThumbnail(request, response, filename, kind) {
    const thumbnail = await thumbnails.get(filename, kind);
    if (thumbnail) { await serveMedia(request, response, thumbnail.filename, thumbnail.mime); return; }
    response.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Thumbnail-Status': 'unavailable', 'Content-Length': THUMBNAIL_PLACEHOLDER.length });
    response.end(request.method === 'HEAD' ? undefined : THUMBNAIL_PLACEHOLDER);
  }
  await store.migrateVideoSettings();
  await store.migrateSpeechSettings();
  const storage = new CosStorage(root, store, options.storage || {});
  let capabilitySettings=await readCapabilitySettings(root), capabilitySave=Promise.resolve();
  let imageCatalog = options.imageCatalog || [];
  let imageCatalogError = '';
  let imageCatalogCheckedAt=0, imageCatalogSyncedAt=null, imageCatalogRequest=null, imageCatalogTimer=null;
  const catalogSyncIntervalMs=Number.isFinite(options.catalogSyncIntervalMs) && options.catalogSyncIntervalMs>0 ? options.catalogSyncIntervalMs : 60000;
  const imageFetcher=options.imageFetcher || fetch;
  const videoModels=()=>effectiveModelCatalog(videoCatalogSync.snapshot().catalog,'video',capabilitySettings);
  const imageModels=()=>effectiveModelCatalog(imageCatalogOrFallback(imageCatalog),'image',capabilitySettings);
  const videoSnapshot=()=>({...videoCatalogSync.snapshot(),catalog:videoModels()});
  const imageSnapshot=()=>({imageCatalog:imageModels(),imageCatalogError,imageCatalogSyncedAt,imageCatalogSyncIntervalMs:catalogSyncIntervalMs,
    imageCatalogCheckedAt:imageCatalogCheckedAt ? new Date(imageCatalogCheckedAt).toISOString() : null});
  async function refreshImageCatalog(force=false) {
    if (options.imageCatalog) return imageSnapshot();
    if (imageCatalogRequest) return imageCatalogRequest;
    if (!force && imageCatalogCheckedAt && Date.now()-imageCatalogCheckedAt<catalogSyncIntervalMs) return imageSnapshot();
    imageCatalogRequest=Promise.resolve().then(async()=> {
      try {
        const publicRead=loadImageCatalog(imageFetcher);
        const connections=(await store.connections()).filter(item=>item.kind==='image');
        const legacy=await store.imageSettings();
        if(legacy.apiKey)connections.push({...legacy,models:null});
        const results=await Promise.allSettled([publicRead,...connections.map(connection=>loadImageCapabilityRecords({...connection,imageModel:connection.imageModel || connection.models?.[0]},imageFetcher))]);
        const catalog=results[0].status==='fulfilled'?results[0].value:imageCatalogOrFallback([]).map(model=>({...model}));
        const authoritative=new Map();
        for(let index=1;index<results.length;index++)if(results[index].status==='fulfilled') {
          const connection=connections[index-1];
          for(const record of results[index].value)if(!connection.models || connection.models.includes(record.name)) {
            if(!authoritative.has(record.name))authoritative.set(record.name,record);
          }
        }
        for(const record of authoritative.values())if(!catalog.some(model=>model.name===record.name) && (record.type==='image' || /image/i.test(record.name)))catalog.push({name:record.name});
        imageCatalog=catalog.map(model=>{
          const record=authoritative.get(model.name),fields=declaredCapabilities(record || {});
          return record?{...model,platformCapabilities:{...model.platformCapabilities,...fields},
            capabilitySource:Object.keys(fields).length ? record.capabilitySource : model.capabilitySource,
            capabilitySyncedAt:new Date().toISOString()}:model;
        });
        imageCatalogError=results[0].status==='rejected'?'图片平台公开数据暂时无法读取，未公开字段使用系统默认；可在模型能力中补充。':'';
        imageCatalogSyncedAt=new Date().toISOString();
      }
      catch { imageCatalog=[];imageCatalogError='图片平台数据暂时无法读取，使用系统默认；可在模型能力中补充设置。'; }
      finally { imageCatalogCheckedAt=Date.now(); }
      return imageSnapshot();
    }).finally(()=>{imageCatalogRequest=null;});
    return imageCatalogRequest;
  }
  let textCatalog = options.textCatalog || [];
  let textCatalogError = '';
  const textFetcher = options.textFetcher || fetch;
  const videoFetcher = options.videoFetcher || fetch;
  function connectionInput(input, previous) {
    const kind = input.kind;
    if (!['video', 'image', 'text', 'speech'].includes(kind)) throw new InputError('请选择接口类型。');
    const baseUrl = kind === 'video' ? videoBaseUrl(input.baseUrl || PLATFORM) : kind === 'speech' ? input.baseUrl || previous?.baseUrl || 'https://api.minimax.cn' : kind === 'image' ? IMAGE_PLATFORM : TEXT_PLATFORM;
    if (kind === 'speech') normalizeSpeechSettings({ baseUrl }, { apiKey: '' });
    if (kind !== 'video' && input.baseUrl && input.baseUrl !== baseUrl) throw new InputError('该接口地址与现有适配协议不匹配。');
    const apiKey = String(input.apiKey || (previous?.kind === kind ? previous.apiKey : '') || '').trim();
    if (!apiKey || apiKey.length > (kind === 'speech' ? 8192 : 1024) || /[\r\n]/.test(apiKey)) throw new InputError('请填写有效 API 令牌。');
    if (kind === 'speech') normalizeSpeechSettings({ baseUrl, apiKey });
    const models = [...new Set((Array.isArray(input.models) ? input.models : []).map(value => String(value).trim()).filter(Boolean))];
    return { kind, baseUrl, apiKey, models };
  }
  async function connectionModels(item) {
    const redact = value => [item.apiKey, encodeURIComponent(item.apiKey)].filter(Boolean)
      .reduce((text, secret) => text.split(secret).join('[已隐藏密钥]'), String(value));
    try {
      if (item.kind === 'speech') {
        const result = await listSpeechVoices(normalizeSpeechSettings({}, item), speechFetcher);
        return { catalog: SPEECH_MODELS.map(name => ({ name })), catalogSource: 'official-docs',
          catalogWarning: '语音模型来自 MiniMax 官方文档，账户模型权限和余额以平台实际生成为准。',
          message: result.message, catalogDiagnostics: null };
      }
      const catalog = item.kind === 'video' ? await loadCatalog(item, videoFetcher)
        : item.kind === 'image' ? (await checkImageConnection({ ...item, imageModel: item.models?.[0] }, imageFetcher)).models
        : await loadTextCatalog(item, textFetcher);
      return JSON.parse(JSON.stringify({ catalog: catalog.filter(model => redact(model.name) === model.name),
        catalogWarning: catalog.catalogWarning || '', catalogDiagnostics: catalog.catalogDiagnostics || null },
      (_key, value) => typeof value === 'string' ? redact(value) : value));
    } catch (error) {
      if (error instanceof InputError) error.message = redact(error.message);
      throw error;
    }
  }
  const readTextCatalog = async () => {
    const items = (await store.connections()).filter(item => item.kind === 'text');
    if (!items.length) return loadTextCatalog(await store.textSettings(), textFetcher);
    const catalogs = await Promise.all(items.map(async item => (await loadTextCatalog(item, textFetcher)).filter(model => item.models.includes(model.name))));
    return [...new Map(catalogs.flat().map(model => [model.name, model])).values()];
  };
  const videoCatalogSync = createVideoCatalogSync({ readSettings: async () => {
      const items = (await store.connections()).filter(item => item.kind === 'video');
      const settings = await store.connectionFor('video', null, await store.settings());
      const routingVersion = createHash('sha256').update(JSON.stringify(items.map(item =>
        ({ id: item.id, baseUrl: item.baseUrl, apiKey: item.apiKey, models: item.models })))).digest('hex');
      return { ...settings, routingVersion, videoConnections: items };
    }, onWarning: message => console.warn('[video-model-catalog] ' + message),
    load: async settings => {
      const connections = settings.videoConnections;
      if (!connections.length) return loadCatalog(settings, videoFetcher);
      const catalogs = await Promise.all(connections.map(async item =>
        selectVideoCatalogModels(await loadCatalog(item, videoFetcher), item.models)));
      return mergeVideoCatalogs(catalogs);
    }, initialCatalog: options.catalog, intervalMs:catalogSyncIntervalMs });
  async function updateCatalogAfterConnectionDeletion(kind) {
    if (kind === 'video') await videoCatalogSync.refresh({ force: true });
    if (kind === 'text') {
      if (!(await store.textSettings()).apiKey) {
        const models = new Set((await store.connections()).filter(item => item.kind === 'text').flatMap(item => item.models));
        textCatalog = textCatalog.filter(model => models.has(model.name));
      }
      textCatalogError = '';
    }
  }
  await videoCatalogSync.refresh();
  await refreshImageCatalog();
  if (!options.textCatalog) {
    const textSettings = await store.textSettings();
    if (textSettings.apiKey || (await store.connections()).some(item => item.kind === 'text')) {
      try { textCatalog = await readTextCatalog(); }
      catch { textCatalogError = '语言模型目录暂时无法读取，可稍后点击“刷新语言模型”。'; }
    }
  }
  imageCatalog = imageCatalogOrFallback(imageCatalog);
  const tools = options.tools || await toolStatus();
  const integrations = { ...(options.integrations || {}),
    submit: options.integrations?.submit || ((settings, job, image) => submitVideo(settings, job, image, videoFetcher)),
    poll: options.integrations?.poll || ((settings, taskId) => pollVideo(settings, taskId, videoFetcher)),
    storageSettings: options.integrations?.storageSettings || (() => storage.publicSettings()),
    prepareReferences: options.integrations?.prepareReferences || ((job) => storage.prepareReferences(job)) };
  const jobs = new VideoJobs(store, integrations); await jobs.init();
  const imageIntegrations = { ...(options.imageIntegrations || {}),
    submitImage: options.imageIntegrations?.submitImage || options.integrations?.submitImage,
    downloadImage: options.imageIntegrations?.downloadImage || options.integrations?.downloadImage };
  const imageJobs = new ImageJobs(store, imageIntegrations); await imageJobs.init();
  const speechFetcher = options.speechFetcher || fetch;
  const speechJobs = new SpeechJobs(store, { ...options.speechIntegrations, fetcher: speechFetcher }); await speechJobs.init();
  const voiceJobs = new VoiceJobs(store, { ...options.voiceIntegrations, fetcher: speechFetcher }); await voiceJobs.init();
  const token = randomBytes(32).toString('hex');
  let currentPort = options.internal ? Number(options.gatewayPort || 18970) : 0;
  const exportBusy = new Set();
  async function submissionCatalog(projectId, input) {
    // A retry of the same operation must still return its saved task when the
    // current model directory is temporarily unavailable or permissions change.
    if (input.operationId && store.state.jobs.some(job => job.projectId === projectId && job.operationId === input.operationId)) {
      return { catalog: videoModels() };
    }
    const snapshot = await videoCatalogSync.forSubmission();
    if (snapshot.catalogError) throw new InputError(snapshot.catalogError, 502);
    return { catalog: effectiveModelCatalog(snapshot.catalog,'video',capabilitySettings), settings: snapshot.settings };
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    try {
      const allowedHosts = new Set([`127.0.0.1:${currentPort}`, `localhost:${currentPort}`, options.gatewayHost].filter(Boolean));
      if (!allowedHosts.has(request.headers.host)) throw new InputError('只接受本机地址访问。', 403);
      const origin = request.headers.origin;
      if ((origin && origin !== publicOrigin && ![...allowedHosts].some(host => origin === `http://${host}`)) || request.headers['sec-fetch-site'] === 'cross-site') {
        throw new InputError('跨站请求已拒绝。', 403);
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        const supplied = String(request.headers['x-studio-token'] || '');
        if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
          throw new InputError('操作令牌失效，请刷新网页。', 403);
        }
      }
      const url = new URL(request.url, `http://127.0.0.1:${currentPort}`);
      const route = url.pathname; const method = request.method;
      const fromPublicSite = Boolean(publicOrigin && origin === publicOrigin);
      if (['/', '/miraframe-logo.png', '/index.html', '/style.css', '/app.js', '/lucide.js', '/ai-text.js', '/skills.js', '/skills.css', '/yaml.js', '/jszip.js', '/chat-images.js', '/text-markdown.js', '/marked.js', '/video-parameters.js', '/image-parameters.js', '/model-capabilities.js', '/model-link-rules.js', '/capability-editor.js', '/canvas.js', '/canvas-geometry.js', '/canvas-layout.js', '/canvas-gravity.js', '/canvas.css', '/canvas-reference-ui.css', '/liblib-theme.css', '/reference-model.js', '/reference-api.js', '/prompt-mentions.js', '/prompt-editor.js', '/previs.js', '/previs-spec.js', '/previs-revision.js', '/previs.css', '/speech.js', '/speech.css', '/speech-parameters.js', '/voice-studio.js', '/voice-parameters.js', '/media-thumbnails.js'].includes(route) && ['GET', 'HEAD'].includes(method)) {
        const filename = path.join(directory, 'public', route === '/' ? 'index.html' : route.slice(1));
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' http://127.0.0.1:18973; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filename)], 'Cache-Control': 'no-cache' });
        response.end(method === 'HEAD' ? undefined : await readFile(filename)); return;
      }
      if (route === '/api/bootstrap' && method === 'GET') {
        await videoCatalogSync.refresh();
        const speechLegacy = await store.speechSettings();
        const speechConnections = (await store.connections()).filter(item => item.kind === 'speech').map(({ apiKey, ...item }) => ({ ...item, hasKey: Boolean(apiKey) }));
        const boundSpeechModels = new Set(speechConnections.flatMap(item => item.models));
        json(response, { appId: 'jingce-ad-studio', token, projects: store.list(), deletedProjects: store.list(true).filter(project => project.deletedAt),
          settings: { ...publicSettings(await store.connectionFor('video', null, await store.settings()), await storage.publicSettings(), await store.connectionFor('image', null, await store.imageSettings()), await store.connectionFor('text', null, await store.textSettings())), speech: publicSpeechSettings(await store.connectionFor('speech', null, speechLegacy)) },
          speechConnections, speechCatalog: !speechConnections.length || speechLegacy.apiKey ? SPEECH_MODELS : SPEECH_MODELS.filter(model => boundSpeechModels.has(model)),
          ...videoSnapshot(), ...imageSnapshot(), textCatalog, textCatalogError, skills: skills.list(), tools, kinds }); return;
      }
      if (route === '/api/skills' && method === 'GET') { json(response, skills.list(url.searchParams.get('includeDeleted') === '1')); return; }
      if (route === '/api/previs/tools' && method === 'GET') {
        if (fromPublicSite) throw new InputError('网站请连接用户电脑上的 幻帧blender助手。', 403);
        json(response, { ...(await previs.tools(url.searchParams.has('refresh'))), settings: previs.settings }); return;
      }
      if (route === '/api/previs/settings' && method === 'PUT') {
        if (fromPublicSite) throw new InputError('网站请在本机助手中配置 Blender。', 403);
        json(response, await previs.saveSettings(await requestJson(request))); return;
      }
      if (route === '/api/previs/validate' && method === 'POST') { json(response, { spec: validatePrevisSpec((await requestJson(request)).spec) }); return; }
      if (route === '/api/previs/helper.zip' && ['GET', 'HEAD'].includes(method)) {
        const zip = await blenderHelperPackage(); response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length,
          'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent('幻帧blender助手.zip') }); response.end(method === 'HEAD' ? undefined : zip); return;
      }
      const previsProjectRoute = /^\/api\/projects\/([\w-]+)\/previs-jobs$/.exec(route);
      if (previsProjectRoute) {
        if (method === 'GET') { store.get(previsProjectRoute[1]); json(response, previs.list(previsProjectRoute[1])); return; }
        if (method === 'POST') {
          const input = await requestJson(request);
          if (fromPublicSite && input.mode !== 'helper') throw new InputError('网站预演需要本机 幻帧blender助手。', 403);
          json(response, await previs.start(previsProjectRoute[1], input), 202); return;
        }
      }
      const previsJobRoute = /^\/api\/previs-jobs\/([a-f0-9-]{36})(?:\/(cancel|retry|open|sync|complete|artifacts)(?:\/([a-z0-9-]+))?)?$/.exec(route);
      if (previsJobRoute) {
        const [, id, action, key] = previsJobRoute;
        if (!action && method === 'GET') { json(response, previs.get(id)); return; }
        if (['cancel', 'retry', 'open'].includes(action) && method === 'POST') {
          await requestJson(request);
          if (fromPublicSite && (action === 'open' || previs.get(id).mode !== 'helper')) throw new InputError('网站预演需要本机 幻帧blender助手。', 403);
          json(response, await previs[action](id)); return;
        }
        if (action === 'sync' && method === 'POST') { json(response, await previs.syncExternal(id, await requestJson(request))); return; }
        if (action === 'complete' && method === 'POST') {
          const job = previs.get(id); if (job.mode !== 'helper' || !['saving', 'done'].includes(job.state)) throw new InputError('预演还没有可以保存的输出。', 409);
          json(response, await previs.publish(id, (await requestJson(request)).report)); return;
        }
        if (action === 'artifacts' && method === 'POST') { json(response, await previs.receiveExternal(id, key, request)); return; }
        if (action === 'artifacts' && ['GET', 'HEAD'].includes(method)) {
          const artifact = previs.artifact(id, key);
          if (!(await stat(artifact.filename).catch(() => null))?.isFile()) throw new InputError('这个预演文件尚未生成。', 404);
          if (url.searchParams.get('thumbnail') === '1' && !url.searchParams.has('download') && artifact.kind) {
            await serveThumbnail(request, response, artifact.filename, artifact.kind); return;
          }
          await serveMedia(request, response, artifact.filename, artifact.mime, url.searchParams.has('download') ? artifact.name : ''); return;
        }
      }
      if (route === '/api/skills/preview' && method === 'POST') { json(response, previewSkills(await requestJson(request, 96 * 1024 * 1024))); return; }
      if (route === '/api/skills/import' && method === 'POST') { json(response, await skills.import(await requestJson(request, 96 * 1024 * 1024)), 201); return; }
      const skillRoute = /^\/api\/skills\/([\w-]+)(?:\/(restore|export))?$/.exec(route);
      if (skillRoute) {
        const [, id, operation] = skillRoute;
        if (operation === 'export' && method === 'GET') {
          const item = skills.get(id, true);
          json(response, { format: 'jingce-skill', skill: item }); return;
        }
        if (!operation && method === 'GET') { json(response, skills.get(id, true)); return; }
        if (!operation && method === 'PUT') { json(response, await skills.update(id, await requestJson(request, 96 * 1024 * 1024))); return; }
        if (!operation && method === 'DELETE') { json(response, await skills.setDeleted(id, true)); return; }
        if (operation === 'restore' && method === 'POST') { await requestJson(request); json(response, await skills.setDeleted(id, false)); return; }
      }
      const textImageRoute = /^\/api\/text-images\/([a-f0-9-]{36})\/(\d+)$/.exec(route);
      if (textImageRoute && ['GET', 'HEAD'].includes(method)) {
        const image = await chatImages.cached(textImageRoute[1], Number(textImageRoute[2]));
        if (url.searchParams.get('thumbnail') === '1' && !url.searchParams.has('download')) {
          await serveThumbnail(request, response, image.filename, 'image'); return;
        }
        await serveMedia(request, response, image.filename, image.mime, url.searchParams.has('download') ? image.name + image.extension : null); return;
      }
      const chatImageImport = /^\/api\/projects\/([\w-]+)\/chat-images$/.exec(route);
      if (chatImageImport && method === 'POST') {
        const input = await requestJson(request);
        json(response, await chatImages.add(chatImageImport[1], input.requestId, input.index)); return;
      }
      if (route === '/api/models' && method === 'GET') { await videoCatalogSync.refresh();json(response,videoSnapshot()); return; }
      if (route === '/api/image-models' && method === 'GET') { json(response,await refreshImageCatalog()); return; }
      if (route === '/api/model-capabilities' && method === 'GET') {
        json(response,{...videoSnapshot(),...imageSnapshot()});return;
      }
      if (route === '/api/model-capabilities/refresh' && method === 'POST') {
        await requestJson(request);
        await Promise.all([videoCatalogSync.refresh({force:true}),refreshImageCatalog(true)]);
        json(response,{...videoSnapshot(),...imageSnapshot()});return;
      }
      const capabilityRoute=/^\/api\/model-capabilities\/(image|video)\/([^/]+)$/.exec(route);
      if (capabilityRoute && ['PUT','DELETE'].includes(method)) {
        const kind=capabilityRoute[1],name=decodeURIComponent(capabilityRoute[2]);
        const input=method==='PUT' ? await requestJson(request) : {};
        const operation=capabilitySave.then(async()=> {
          const model=(kind==='video'?videoModels():imageModels()).find(model=>model.name===name);
          if (!model) throw new InputError('请选择当前目录中的模型。',404);
          const overrides=method==='PUT'?validateCapabilityEdit(model,input.overrides):{};
          const next=structuredClone(capabilitySettings);
          if (Object.keys(overrides).length) Object.defineProperty(next[kind],name,{value:overrides,enumerable:true,configurable:true,writable:true});
          else delete next[kind][name];
          if(method==='PUT' && Object.hasOwn(input,'familySupplement')) {
            if(kind!=='video')throw new InputError('系列时长仅适用于视频模型。');
            const family=normalizeFamilyName(model.capabilityFamily);
            next.families ||= {video:{}};next.families.video ||= {};
            if(input.familySupplement===null)delete next.families.video[family];
            else Object.defineProperty(next.families.video,family,{value:normalizeFamilySupplement(input.familySupplement),enumerable:true,configurable:true,writable:true});
          }
          await saveCapabilitySettings(root,next);capabilitySettings=next;
        });
        capabilitySave=operation.catch(()=>{});await operation;
        json(response,{...videoSnapshot(),...imageSnapshot()});return;
      }
      if (route === '/api/projects' && method === 'GET') { json(response, store.list(url.searchParams.get('includeDeleted') === '1')); return; }
      if (route === '/api/projects' && method === 'POST') {
        const project = createProject(await requestJson(request));
        await store.mutate(state => { state.projects.push(project); return project; }); json(response, project, 201); return;
      }
      if (route === '/api/projects/import' && method === 'POST') {
        const project = importProject(await requestJson(request, Infinity));
        await store.mutate(state => { state.projects.push(project); return project; }); json(response, project, 201); return;
      }
      const speechJobRoute = /^\/api\/speech-jobs\/([\w-]+)(?:\/(save|resolve))?$/.exec(route);
      if (speechJobRoute) {
        const [, id, operation] = speechJobRoute;
        if (!operation && method === 'GET') { json(response, publicSpeechJob(speechJobs.get(id))); return; }
        if (operation === 'save' && method === 'POST') { await requestJson(request); json(response, await speechJobs.retrySave(id), 202); return; }
        if (operation === 'resolve' && method === 'POST') { json(response, await speechJobs.resolve(id, await requestJson(request))); return; }
      }
      const projectRoute = /^\/api\/projects\/([\w-]+)(?:\/(plan|export|screenplay|assets|jobs|image-jobs|speech-jobs|image-batches|batches|compose|restore|permanent))?$/.exec(route);
      if (projectRoute) {
        const [, id, action] = projectRoute;
        if (!action && method === 'GET') { json(response, store.get(id, url.searchParams.get('includeDeleted') === '1')); return; }
        if (!action && method === 'DELETE') { json(response, await store.setDeleted(id, true)); return; }
        if (action === 'restore' && method === 'POST') {
          await requestJson(request); json(response, await store.setDeleted(id, false)); return;
        }
        if (action === 'permanent' && method === 'DELETE') {
          json(response, await store.permanentlyDelete(id, (_project, projectJobs, projectImageJobs) => exportBusy.has(id) || previs.list(id).some(job => previs.busy.has(job.id)) || speechJobs.list(id).some(job => speechJobs.busy.has(job.id)) || projectJobs.some(job => jobs.busy.has(job.id)) || projectImageJobs.some(job => imageJobs.busy.has(job.id)))); return;
        }
        if (!action && method === 'PATCH') {
          const patch = await requestJson(request, Infinity);
          const settings=await store.settings();
          json(response, await store.update(id, project => {
            const next=updateProject(project,patch);
            const issue=validateNewModelLinks(project,next,videoModels(),imageModels(),settings.videoModel);
            if (issue) throw new InputError(issue);
            return next;
          })); return;
        }
        if (action === 'plan' && method === 'POST') { await requestJson(request); json(response, await store.update(id, draftPlan)); return; }
        if (action === 'export' && method === 'GET') {
          response.setHeader('Content-Disposition', `attachment; filename="jingce-${id}.json"`);
          json(response, exportProject(store.get(id))); return;
        }
        if (action === 'screenplay' && method === 'GET') {
          response.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="script-${id}.md"` });
          response.end(screenplay(store.get(id))); return;
        }
        if (action === 'assets' && method === 'POST') { json(response, await upload(request, store, id), 201); return; }
        if (action === 'speech-jobs' && method === 'GET') { store.get(id); json(response, speechJobs.list(id)); return; }
        if (action === 'speech-jobs' && method === 'POST') { json(response, await speechJobs.start(id, await requestJson(request)), 202); return; }
        if (action === 'jobs' && method === 'GET') {
          store.get(id); json(response, jobs.list(id, url.searchParams.get('includeDeleted') === '1')); return;
        }
        if (action === 'jobs' && method === 'POST') {
          const input = await requestJson(request);
          const submission = await submissionCatalog(id, input);
          json(response, await jobs.start(id, input, submission.catalog, submission.settings), 202); return;
        }
        if (action === 'image-jobs' && method === 'GET') {
          store.get(id); json(response, imageJobs.list(id, url.searchParams.get('includeDeleted') === '1')); return;
        }
        if (['image-jobs','image-batches'].includes(action) && method === 'POST') {
          const input=await requestJson(request);
          if (!input.operationId || !store.state.imageJobs.some(job=>job.projectId===id && (job.operationId===input.operationId || job.batchOperationId===input.operationId))) await refreshImageCatalog(true);
          json(response,await imageJobs[action==='image-jobs'?'start':'startBatch'](id,input,imageModels()),202);return;
        }
        if (action === 'batches' && method === 'POST') {
          const input = await requestJson(request);
          const submission = await submissionCatalog(id, input);
          json(response, await jobs.startBatch(id, input, submission.catalog, submission.settings), 202); return;
        }
        if (action === 'compose' && method === 'POST') {
          const input = await requestJson(request); const project = store.get(id);
          if (!tools.ready) throw new InputError(tools.message);
          compositionClips(project); compositionAudio(project, input.audioAssetId || '');
          if (exportBusy.has(id)) throw new InputError('这个工程正在合成，请等本次合成完成。', 409);
          const output = { id: randomUUID(), state: 'running', createdAt: new Date().toISOString(), message: '正在合成视频。' };
          await store.update(id, current => { current.exports.push(output); return touch(current); });
          exportBusy.add(id);
          void compose(project, root, output.id, input.audioAssetId || '').then(async result => {
            await store.update(id, current => {
              Object.assign(current.exports.find(item => item.id === output.id), result, { state: 'done', message: '成片已保存。' });
              for (const node of current.graph.nodes.filter(node => node.kind === 'compose')) node.status = 'done';
              return touch(current);
            }, true);
          }).catch(async error => {
            await store.update(id, current => {
              Object.assign(current.exports.find(item => item.id === output.id), { state: 'failed', message: error instanceof InputError ? error.message : '视频合成失败，请检查媒体文件和 FFmpeg。' });
              return touch(current);
            }, true);
          }).finally(() => exportBusy.delete(id));
          json(response, output, 202); return;
        }
      }
      const projectAssetRoute = /^\/api\/projects\/([\w-]+)\/assets\/([\w-]+)(?:\/(restore))?$/.exec(route);
      if (projectAssetRoute && !projectAssetRoute[3] && method === 'DELETE') {
        json(response, await store.update(projectAssetRoute[1], project => setAssetDeleted(project, projectAssetRoute[2], true))); return;
      }
      if (projectAssetRoute?.[3] === 'restore' && method === 'POST') {
        await requestJson(request);
        json(response, await store.update(projectAssetRoute[1], project => setAssetDeleted(project, projectAssetRoute[2], false))); return;
      }
      const assetRoute = /^\/api\/assets\/([\w-]+)$/.exec(route);
      if (assetRoute && ['GET', 'HEAD'].includes(method)) {
        const asset = store.state.projects.flatMap(project => project.assets).find(item => item.id === assetRoute[1]);
        if (!asset) throw new InputError('找不到这个素材。', 404);
        const extension = path.extname(asset.file);
        const downloadName = asset.name.toLowerCase().endsWith(extension.toLowerCase()) ? asset.name : `${asset.name}${extension}`;
        if (url.searchParams.get('thumbnail') === '1' && !url.searchParams.has('download')) {
          await serveThumbnail(request, response, path.join(root, 'assets', asset.file), asset.kind); return;
        }
        await serveMedia(request, response, path.join(root, 'assets', asset.file), asset.mime, url.searchParams.has('download') ? downloadName : ''); return;
      }
      const exportRoute = /^\/api\/exports\/([\w-]+)$/.exec(route);
      if (exportRoute && ['GET', 'HEAD'].includes(method)) {
        const output = store.state.projects.flatMap(project => project.exports).find(item => item.id === exportRoute[1] && item.state === 'done');
        if (!output) throw new InputError('成片尚未完成或不存在。', 404);
        if (url.searchParams.get('thumbnail') === '1' && !url.searchParams.has('download')) {
          await serveThumbnail(request, response, path.join(root, 'exports', output.file), 'video'); return;
        }
          await serveMedia(request, response, path.join(root, 'exports', output.file), 'video/mp4', url.searchParams.has('download') ? '幻帧 MiraFrame视频成片.mp4' : ''); return;
      }
      const imageRetry = /^\/api\/image-jobs\/([\w-]+)\/retry$/.exec(route);
      if (imageRetry && method === 'POST') { await requestJson(request); json(response, await imageJobs.retry(imageRetry[1])); return; }
      const imageRecord = /^\/api\/image-jobs\/([\w-]+)(?:\/(restore|permanent))?$/.exec(route);
      if (imageRecord && !imageRecord[2] && method === 'DELETE') { json(response, await imageJobs.setDeleted(imageRecord[1], true)); return; }
      if (imageRecord?.[2] === 'permanent' && method === 'DELETE') { json(response, await store.permanentlyDeleteJob(imageRecord[1], 'image', id => imageJobs.busy.has(id))); return; }
      if (imageRecord?.[2] === 'restore' && method === 'POST') { await requestJson(request); json(response, await imageJobs.setDeleted(imageRecord[1], false)); return; }
            const retry = /^\/api\/jobs\/([\w-]+)\/query$/.exec(route);
      if (retry && method === 'POST') { const input = await requestJson(request); json(response, await jobs.retryLookup(retry[1], input.taskId)); return; }
      const jobRecord = /^\/api\/jobs\/([\w-]+)(?:\/(restore|permanent))?$/.exec(route);
      if (jobRecord && !jobRecord[2] && method === 'DELETE') {
        json(response, await jobs.setDeleted(jobRecord[1], true)); return;
      }
      if (jobRecord?.[2] === 'permanent' && method === 'DELETE') { json(response, await store.permanentlyDeleteJob(jobRecord[1], 'video', id => jobs.busy.has(id) || jobs.submitting.has(id))); return; }
      if (jobRecord?.[2] === 'restore' && method === 'POST') {
        await requestJson(request); json(response, await jobs.setDeleted(jobRecord[1], false)); return;
      }
      if (route === '/api/connections' && method === 'GET') {
        json(response, (await store.connections()).map(({ apiKey, ...item }) => ({ ...item, hasKey: Boolean(apiKey) }))); return;
      }
      if (route === '/api/existing-connections' && method === 'GET') {
        // List the actual defaults, without substituting model-bound connections.
        const settings = publicSettings(await store.settings(), null, await store.imageSettings(), await store.textSettings());
        json(response, [
          { kind: 'video', name: '视频连接', baseUrl: settings.baseUrl, models: [], hasKey: settings.hasKey },
          { kind: 'image', name: '图片连接', baseUrl: settings.image.baseUrl, models: [settings.image.imageModel].filter(Boolean), hasKey: settings.image.hasKey },
          { kind: 'text', name: '语言模型连接', baseUrl: settings.text.baseUrl, models: [settings.text.textModel].filter(Boolean), hasKey: settings.text.hasKey },
        ].filter(item => item.hasKey)); return;
      }
      const existingConnectionRoute = /^\/api\/existing-connections\/(video|image|text)$/.exec(route);
      if (existingConnectionRoute && method === 'DELETE') {
        const kind = existingConnectionRoute[1];
        if (kind === 'video') {
          for (const job of store.state.jobs) await store.videoTaskSettings(job);
          await store.saveSettings({ ...DEFAULT_CONNECTION });
        } else if (kind === 'image') await store.saveImageSettings({ ...DEFAULT_IMAGE_CONNECTION });
        else await store.saveTextSettings({ ...DEFAULT_TEXT_CONNECTION });
        await updateCatalogAfterConnectionDeletion(kind);
        json(response, { deleted: true }); return;
      }
      const existingModelsRoute = /^\/api\/existing-connections\/(video|image|text)\/models$/.exec(route);
      if (existingModelsRoute && method === 'GET') {
        const kind = existingModelsRoute[1];
        const catalog = kind === 'video' ? await loadCatalog(await store.settings(), videoFetcher) : kind === 'image' ? (await checkImageConnection(await store.imageSettings(), options.imageFetcher || fetch)).models : await loadTextCatalog(await store.textSettings(), textFetcher);
        json(response, kind === 'video' && url.searchParams.get('diagnostics') === '1'
          ? { catalog, catalogWarning: catalog.catalogWarning, catalogDiagnostics: catalog.catalogDiagnostics } : catalog); return;
      }
      if (route === '/api/connections/models' && method === 'POST') {
        const input = await requestJson(request), items = await store.connections();
        const previous = items.find(item => item.id === input.id);
        if (input.id && !previous) throw new InputError('接口不存在。', 404);
        json(response, await connectionModels(connectionInput(input, previous))); return;
      }
      if (route === '/api/connections' && method === 'PUT') {
        const input = await requestJson(request), items = await store.connections();
        const previous = items.find(item => item.id === input.id);
        const { kind, baseUrl, apiKey, models } = connectionInput(input, previous);
        if (!models.length || models.some(value => value.length > 160) || models.length > 500) throw new InputError('请绑定至少一个模型。');
        if (kind === 'speech' && models.some(model => !SPEECH_MODELS.includes(model))) throw new InputError('请绑定当前已接入的 MiniMax 语音模型。');
        const id = previous?.id || randomUUID();
        if (items.some(item => item.id !== id && item.kind === kind && item.models.some(model => models.includes(model)))) throw new InputError('模型已绑定其他接口，请先修改原接口的模型绑定。', 409);
        const next = { id, name: String(input.name || '新接口').trim().slice(0, 80), kind, baseUrl, models, apiKey };
        for (const job of store.state.jobs) await store.videoTaskSettings(job);
        await store.saveConnections([...items.filter(item => item.id !== id), next]);
        json(response, { ...next, apiKey: undefined, hasKey: true }); return;
      }
      if (route === '/api/connections/refresh' && method === 'POST') {
        const input = await requestJson(request);
        if (input.kind && !['video', 'image', 'text', 'speech'].includes(input.kind)) throw new InputError('请选择接口类型。');
        const issues = [];
        if (!input.kind || input.kind === 'video') {
          const snapshot = await videoCatalogSync.refresh({ force: true });
          if (snapshot.catalogError) issues.push(snapshot.catalogError);
        }
        if (!input.kind || input.kind === 'image') {
          await refreshImageCatalog(true); if (imageCatalogError) issues.push('图片目录刷新失败');
        }
        if (!input.kind || input.kind === 'text') {
          const textConnections = (await store.connections()).some(item => item.kind === 'text');
          if (textConnections || (await store.textSettings()).apiKey) {
            try { textCatalog = await readTextCatalog(); textCatalogError = ''; }
            catch { textCatalogError = '语言模型目录刷新失败，请检查接口后重试。'; issues.push('语言模型目录刷新失败'); }
          } else { textCatalog = []; textCatalogError = ''; }
        }
        json(response, { message: issues.length ? issues.join('；') + '，请检查接口后重试。' : '模型目录已刷新。',
          catalogWarning: videoCatalogSync.snapshot().catalogWarning, catalogDiagnostics: videoCatalogSync.snapshot().catalogDiagnostics }); return;
      }
      const connectionRoute = /^\/api\/connections\/([\w-]+)(?:\/(check|models))?$/.exec(route);
      if (connectionRoute) {
        const items = await store.connections(), item = items.find(item => item.id === connectionRoute[1]);
        if (!item) throw new InputError('接口不存在。', 404);
        if (connectionRoute[2] === 'models' && method === 'GET') {
          const result = await connectionModels(item);
          json(response, url.searchParams.get('diagnostics') === '1' ? result : result.catalog); return;
        }
        if (connectionRoute[2] && method === 'POST') {
          await requestJson(request);
          json(response, item.kind === 'video' ? await checkConnection(item, videoFetcher) : item.kind === 'image' ? await checkImageConnection({ ...item, imageModel: item.models[0] }, imageFetcher) : item.kind === 'speech' ? await listSpeechVoices(normalizeSpeechSettings({}, item), speechFetcher) : await checkTextConnection({ ...item, textModel: item.models[0] }, textFetcher)); return;
        }
        if (!connectionRoute[2] && method === 'DELETE') {
          for (const job of store.state.jobs) await store.videoTaskSettings(job);
          await store.saveConnections(items.filter(value => value.id !== item.id));
          await updateCatalogAfterConnectionDeletion(item.kind);
          json(response, { deleted: true }); return;
        }
      }
      if (route === '/api/image-settings' && method === 'PUT') {
        const input = await requestJson(request); const previous = await store.imageSettings();
        if (input.baseUrl && input.baseUrl !== IMAGE_PLATFORM) throw new InputError('当前生图适配器对应 sub.beibeihai.xyz 平台。');
        const next = { ...DEFAULT_IMAGE_CONNECTION, ...previous, imageModel: String(input.imageModel || previous.imageModel || DEFAULT_IMAGE_CONNECTION.imageModel).slice(0, 120),
          apiKey: input.clearKey ? '' : typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim().slice(0, 1024) : previous.apiKey || '' };
        if (/[\r\n]/.test(next.apiKey)) throw new InputError('生图 API Key 不能包含换行。');
        await store.saveImageSettings(next);
        json(response, publicSettings(await store.settings(), await storage.publicSettings(), next).image); return;
      }
      if (route === '/api/image-settings/check' && method === 'POST') { await requestJson(request); json(response, await checkImageConnection(await store.imageSettings())); return; }
      if (route === '/api/image-models/refresh' && method === 'POST') {
        await requestJson(request);await refreshImageCatalog(true);json(response,imageModels());return;
      }
      if (route === '/api/voice-recordings' && method === 'POST') {
        if (Number(request.headers['content-length']) > VOICE_RECORDING_LIMIT) throw new InputError('复刻录音最大支持 20 MB。', 413);
        let name;
        try { name = decodeURIComponent(request.headers['x-file-name'] || ''); } catch { throw new InputError('录音文件名格式不正确。'); }
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > VOICE_RECORDING_LIMIT) throw new InputError('复刻录音最大支持 20 MB。', 413); chunks.push(chunk); }
        json(response, await voiceJobs.upload(url.searchParams.get('model'), { name, operationId: url.searchParams.get('operationId') }, Buffer.concat(chunks)), 201); return;
      }
      const voiceRecordingRoute = /^\/api\/voice-recordings\/([\w-]+)$/.exec(route);
      if (voiceRecordingRoute && ['GET', 'HEAD'].includes(method)) {
        const media = voiceJobs.recordingMedia(voiceRecordingRoute[1]); await serveMedia(request, response, media.filename, media.mime); return;
      }
      if (route === '/api/voice-jobs' && method === 'GET') { json(response, await voiceJobs.list(url.searchParams.get('model'))); return; }
      if (route === '/api/voice-jobs' && method === 'POST') { json(response, await voiceJobs.start(await requestJson(request)), 202); return; }
      const voiceJobRoute = /^\/api\/voice-jobs\/([\w-]+)(?:\/(save|preview|reconcile|resolve))?$/.exec(route);
      if (voiceJobRoute) {
        const [, id, operation] = voiceJobRoute;
        if (!operation && method === 'GET') { json(response, publicVoiceJob(voiceJobs.get(id))); return; }
        if (operation === 'preview' && ['GET', 'HEAD'].includes(method)) {
          const media = voiceJobs.previewMedia(id); await serveMedia(request, response, media.filename, media.mime, url.searchParams.has('download') ? media.name : undefined); return;
        }
        if (method === 'POST') {
          const input = await requestJson(request);
          if (operation === 'save') { json(response, await voiceJobs.retrySave(id), 202); return; }
          if (operation === 'preview') { json(response, await voiceJobs.retryPreview(id), 202); return; }
          if (operation === 'reconcile') { json(response, await voiceJobs.reconcile(id)); return; }
          if (operation === 'resolve') { json(response, await voiceJobs.resolve(id, input)); return; }
        }
      }
      if (route === '/api/speech-voices' && method === 'POST') {
        const input = await requestJson(request);
        if (input.model && !SPEECH_MODELS.includes(input.model)) throw new InputError('请选择已接入的语音模型。');
        const settings = await store.connectionFor('speech', input.model || null, await store.speechSettings());
        const result = await listSpeechVoices(normalizeSpeechSettings({}, settings), speechFetcher);
        const local = await voiceJobs.localVoices(input.model || null);
        const merged = new Map(result.voices.map(voice => [voice.id, voice]));
        for (const voice of local) merged.set(voice.id, { ...merged.get(voice.id), ...voice });
        json(response, { ...result, voices: [...merged.values()] }); return;
      }
      if (route === '/api/text-settings' && method === 'PUT') {
        const input = await requestJson(request); const previous = await store.textSettings();
        if (input.baseUrl && input.baseUrl !== TEXT_PLATFORM) throw new InputError('当前语言模型适配器对应 sub.beibeihai.xyz/v1。');
        const next = { ...DEFAULT_TEXT_CONNECTION, ...previous,
          textModel: String(input.textModel ?? previous.textModel ?? '').trim().slice(0, 160),
          apiKey: input.clearKey ? '' : typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim().slice(0, 1024) : previous.apiKey || '' };
        if (/[\r\n]/.test(next.apiKey)) throw new InputError('语言模型 API Key 不能包含换行。');
        await store.saveTextSettings(next);
        json(response, publicSettings(await store.settings(), await storage.publicSettings(), await store.imageSettings(), next).text); return;
      }
      if (route === '/api/text-settings/check' && method === 'POST') { await requestJson(request); json(response, await checkTextConnection(await store.textSettings(), textFetcher)); return; }
      if (route === '/api/text-models/refresh' && method === 'POST') {
        await requestJson(request); textCatalog = await readTextCatalog(); textCatalogError = ''; json(response, textCatalog); return;
      }
      if (route === '/api/text-chat' && method === 'POST') {
        const input = await requestJson(request, Infinity), settings = await store.connectionFor('text', input.model, await store.textSettings());
        if (input.projectId) store.get(input.projectId);
        if (input.skillId) input.messages = skills.apply(normalizeTextMessages(input.messages), input.skillId);
        const started = Date.now(), requestId = randomUUID();
        const rawModel = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : settings.textModel || '';
        const model = rawModel.split(settings.apiKey || '\0').join('[已隐藏密钥]')
          .split(settings.apiKey ? encodeURIComponent(settings.apiKey) : '\0').join('[已隐藏密钥]').slice(0, 160);
        const record = async outcome => {
          const ledger = { requestId, projectId: input.projectId || '', projectTitle: input.projectId ? store.get(input.projectId, true).title : '',
            model, startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), ...outcome };
          await options.onTextRecord?.(ledger);
          // Keep metadata only; never persist prompts, replies, headers or keys.
          await atomicJson(path.join(root, 'text-last-request.json'), {
            requestId, model, stream: false, startedAt: new Date(started).toISOString(),
            finishedAt: new Date().toISOString(), elapsedMs: Date.now() - started, ...outcome,
          }).catch(() => {});
        };
        await record({ status: 'running' });
        try {
          const result = await chatText(settings, input, textFetcher);
          const images = await chatImages.record(requestId, input.projectId || '', result.images);
          await record({ status: 'done', httpStatus: 200, code: '', finishReason: result.finishReason, answerLength: result.content.length, imageCount: images.length, usage: result.usage });
          json(response, { ...result, images, requestId });
        } catch (error) {
          const status = error instanceof InputError ? error.status : 500;
          const code = error instanceof InputError ? error.code || 'TEXT_REQUEST_REJECTED' : 'TEXT_INTERNAL_ERROR';
          await record({ status: 'error', httpStatus: status, providerStatus: error.providerStatus || null, code });
          const message = error instanceof InputError ? error.message : '语言模型请求发生内部异常，未收到可用结果。';
          json(response, { error: `${message}（请求编号：${requestId.slice(0, 8)}）`, code, requestId }, status);
        }
        return;
      }
      if (route === '/api/settings' && method === 'PUT') {
        const input = await requestJson(request); const previous = await store.settings();
        if (input.baseUrl) videoBaseUrl(input.baseUrl);
        const next = { ...DEFAULT_CONNECTION, ...previous,
          baseUrl: videoBaseUrl(input.baseUrl || previous.baseUrl || PLATFORM), docsUrl: DEFAULT_CONNECTION.docsUrl,
          videoModel: String(input.videoModel || previous.videoModel || DEFAULT_CONNECTION.videoModel).slice(0, 120),
          resolution: String(input.resolution || previous.resolution || '720p'),
          apiKey: input.clearKey ? '' : typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim().slice(0, 1024) : previous.apiKey || '' };
        if (/[\r\n]/.test(next.apiKey)) throw new InputError('API Key 不能包含换行。');
        // Pin every existing task to its original credentials before replacing
        // the default key. Runtime-private records never enter bootstrap/export.
        for (const job of store.state.jobs) await store.videoTaskSettings(job);
        await store.saveSettings(next);
        if (next.apiKey !== previous.apiKey || next.baseUrl !== previous.baseUrl) await videoCatalogSync.refresh({ force: true });
        json(response, publicSettings(next, await storage.publicSettings(), await store.imageSettings(), await store.textSettings())); return;
      }
      if (route === '/api/settings/check' && method === 'POST') { await requestJson(request); json(response, await checkConnection(await store.settings(), videoFetcher)); return; }
      if (route === '/api/storage/settings' && method === 'PUT') {
        const saved = await storage.saveSettings(await requestJson(request));
        json(response, publicStorageSettings(saved)); return;
      }
      if (route === '/api/storage/test' && method === 'POST') {
        await requestJson(request); json(response, await storage.testConnection()); return;
      }
      if (route === '/api/models/refresh' && method === 'POST') {
        await requestJson(request);
        const snapshot = await videoCatalogSync.refresh({ force: true });
        if (snapshot.catalogError) throw new InputError(snapshot.catalogError, 502);
        json(response, videoModels()); return;
      }
      if (route === '/api/shutdown' && method === 'POST') {
        await requestJson(request); json(response, { ok: true });
        setTimeout(async () => { clearInterval(imageCatalogTimer);videoCatalogSync.close(); jobs.close(); imageJobs.close(); await previs.close(); await speechJobs.close(); await voiceJobs.close(); server.close(); }, 100); return;
      }
      throw new InputError('这个地址不存在。', 404);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      json(response, { error: error instanceof InputError ? error.message : '操作未完成，请重试。' }, error instanceof InputError ? error.status : 500);
    }
  });
  server.requestTimeout = 20 * 60 * 1000; // Larger previews may upload over a slower home connection.
  return { store, jobs, imageJobs, previs, speechJobs, voiceJobs, server, token,
    async start(port = 18970) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      currentPort = server.address().port;
      videoCatalogSync.start();
      if (!options.imageCatalog) { imageCatalogTimer=setInterval(()=>refreshImageCatalog(true),catalogSyncIntervalMs);imageCatalogTimer.unref?.(); }
      return `http://127.0.0.1:${currentPort}`;
    },
    async close() { clearInterval(imageCatalogTimer);videoCatalogSync.close(); jobs.close(); imageJobs.close(); await previs.close(); await speechJobs.close(); await voiceJobs.close(); await capabilitySave;await skills.pending;await store.pending; await new Promise(resolve => server.close(resolve)); },
  };
}

const STATIC_ROUTES = new Set(['/', '/miraframe-logo.png', '/index.html', '/style.css', '/app.js', '/lucide.js', '/ai-text.js', '/skills.js', '/skills.css', '/yaml.js', '/jszip.js', '/chat-images.js', '/text-markdown.js', '/marked.js', '/video-parameters.js', '/image-parameters.js', '/model-capabilities.js', '/model-link-rules.js', '/capability-editor.js', '/canvas.js', '/canvas-geometry.js', '/canvas-layout.js', '/canvas-gravity.js', '/canvas.css', '/canvas-reference-ui.css', '/liblib-theme.css', '/reference-model.js', '/reference-api.js', '/prompt-mentions.js', '/prompt-editor.js', '/previs.js', '/previs-spec.js', '/previs-revision.js', '/previs.css', '/speech.js', '/speech.css', '/speech-parameters.js', '/voice-studio.js', '/voice-parameters.js', '/media-thumbnails.js']);

async function createGateway(options = {}) {
  STATIC_ROUTES.add('/management.js'); STATIC_ROUTES.add('/management.css');
  // Version the entire module graph together so cached modules cannot bypass a new login flow.
  const assetHash = createHash('sha256');
  const assetNames = (await readdir(path.join(directory, 'public'))).filter(name => /\.(?:js|css)$/.test(name)).sort();
  for (const name of assetNames) assetHash.update(name).update(await readFile(path.join(directory, 'public', name)));
  const assetVersion = assetHash.digest('hex').slice(0, 16);
  const runtimeRoot = options.root || path.join(directory, 'runtime');
  const management = new ManagementStore(runtimeRoot, options.management);
  await management.init();
  const auth = new AuthStore(runtimeRoot, { ...options.auth, accounts: management });
  await auth.init();
  for (const user of auth.db.prepare('SELECT id,email,username FROM users WHERE email IS NOT NULL').all()) management.ensureMember(user);
  // Import existing task metadata without opening providers or resubmitting jobs.
  for (const entry of await readdir(path.join(runtimeRoot, 'users')).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (!/^\d+$/.test(entry) || !management.member(Number(entry))) continue;
    const saved = await readFile(path.join(runtimeRoot, 'users', entry, 'projects.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (saved) management.syncTasks(Number(entry), JSON.parse(saved));
  }
  const globalStorage = new CosStorage(runtimeRoot, null);
  const contexts = new Map();
  const contextPromises = new Map();
  const publicOrigin = options.publicOrigin ?? process.env.JINGCE_PUBLIC_ORIGIN ?? '';
  const gatewayHost = options.gatewayHost || `127.0.0.1:${options.gatewayPort || process.env.JINGCE_PORT || 18970}`;
  if (publicOrigin) {
    let valid = false;
    try { const parsed = new URL(publicOrigin); valid = parsed.protocol === 'https:' && parsed.origin === publicOrigin; } catch { /* Reject malformed configuration. */ }
    if (!valid) throw new InputError('JINGCE_PUBLIC_ORIGIN 需要是完整的 HTTPS 网站来源，不含路径或结尾斜线。');
  }
  let currentPort = 0;
  const publicHost = publicOrigin ? new URL(publicOrigin).host : '';
  async function contextFor(session) {
    const userId = Number(session.userId);
    if (contexts.has(userId)) return contexts.get(userId);
    if (!contextPromises.has(userId)) contextPromises.set(userId, (async () => {
      const userRoot = auth.userRoot(userId);
      if (userId === auth.legacyUserId || (!auth.legacyUserId && session.email === auth.legacyEmail)) await migrateLegacyWorkspace(auth, userRoot);
      const app = await createStudio({ ...options, multiUser: false, root: userRoot, internal: true, gatewayHost, gatewayPort: currentPort, publicOrigin,
        storage: { ...options.storage, configRoot: runtimeRoot, namespace: `users/${userId}` },
        getProjectLimit: () => management.settings.maxProjects,
        onStateSaved: state => management.syncTasks(userId, state), onTextRecord: record => management.recordText(userId, record) });
      contexts.set(userId, app);
      contextPromises.delete(userId);
      return app;
    })().catch(error => { contextPromises.delete(userId); throw error; }));
    return contextPromises.get(userId);
  }
  function setCookie(response, value) { response.setHeader('Set-Cookie', value); }
  async function serveStatic(request, response, route) {
    const filename = path.join(directory, 'public', route === '/' ? 'index.html' : route.slice(1));
    try { await stat(filename); } catch { json(response, { error: '资源不存在。' }, 404); return; }
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' http://127.0.0.1:18973; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    if (request.method === 'HEAD') { response.end(); return; }
    let body = await readFile(filename);
    if (route === '/' || route === '/index.html') {
      body = Buffer.from(body.toString('utf8')
        .replace('<body>', '<body data-auth-gateway="1">')
        .replace('</head>', '<link rel="stylesheet" href="/management.css"></head>')
        .replace('id="auth-screen" class="auth-screen" hidden', 'id="auth-screen" class="auth-screen"')
        .replace('<aside class="sidebar">', '<aside class="sidebar" hidden>')
        .replace('<main class="workspace">', '<main class="workspace" hidden>')
        .replace(/((?:src|href)="\/[^"?]+\.(?:js|css))"/g, `$1?v=${assetVersion}"`));
    } else if (route.endsWith('.js')) {
      body = Buffer.from(body.toString('utf8').replace(/(\bfrom\s*['"]|\bimport\s*(?:\(\s*)?['"])(\.\/[^'"?]+\.js)(['"])/g,
        `$1$2?v=${assetVersion}$3`));
    }
    response.end(body);
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    try {
      const url = new URL(request.url, `http://${gatewayHost}`); const route = url.pathname; const method = request.method;
      if (STATIC_ROUTES.has(route) && ['GET', 'HEAD'].includes(method)) { await serveStatic(request, response, route); return; }
      if (route === '/api/shutdown') { json(response, { error: '这个地址不存在。' }, 404); return; }
      const host = String(request.headers.host || '');
      const allowedHosts = new Set([gatewayHost, publicHost, `127.0.0.1:${currentPort}`, `localhost:${currentPort}`].filter(value => value && !value.endsWith(':0')));
      if (!allowedHosts.has(host)) { json(response, { error: '只接受本站地址访问。' }, 403); return; }
      const origin = String(request.headers.origin || '');
      if ((origin && origin !== publicOrigin) || request.headers['sec-fetch-site'] === 'cross-site') { json(response, { error: '请求来源不被允许。' }, 403); return; }
      if (route === '/api/site' && method === 'GET') { json(response, { siteName: management.settings.siteName, supportText: management.settings.supportText,
        registrationEnabled: management.settings.registrationEnabled, maintenance: management.settings.maintenance, maintenanceMessage: management.settings.maintenanceMessage }); return; }
      if (route === '/api/auth/reset-code' && method === 'POST') { json(response, await auth.resetCode((await requestJson(request)).email, request.headers['x-real-ip'] || request.socket.remoteAddress)); return; }
      if (route === '/api/auth/reset-password' && method === 'POST') { json(response, await auth.resetPassword(await requestJson(request))); return; }
      if (route === '/api/auth/me' && method === 'GET') {
        const session = await auth.current(request); if (!session) { json(response, { error: '请先登录。' }, 401); return; }
        json(response, { id: Number(session.userId), username: session.username, nickname: session.nickname, email: session.email, isAdmin: Boolean(session.isAdmin) }); return;
      }
      if (route === '/api/auth/login' && method === 'POST') {
        const input = await requestJson(request); const result = await auth.login(input.email, input.password, request.headers['x-real-ip'] || request.socket.remoteAddress, request.headers['user-agent']); setCookie(response, auth.cookie(result.token)); json(response, result.user); return;
      }
      if (['/api/auth/verification-code', '/api/auth/register'].includes(route) && !management.settings.registrationEnabled) throw new InputError('本站暂时关闭新用户注册，已有账号可正常登录。', 403);
      if (route === '/api/auth/verification-code' && method === 'POST') { json(response, await auth.verificationCode((await requestJson(request)).email, request.headers['x-real-ip'] || request.socket.remoteAddress)); return; }
      if (route === '/api/auth/register' && method === 'POST') {
        const input = await requestJson(request); const result = await auth.register(input, request.headers['x-real-ip'] || request.socket.remoteAddress, request.headers['user-agent']); setCookie(response, auth.cookie(result.token)); json(response, result.user, 201); return;
      }
      if (route === '/api/auth/logout' && method === 'POST') { await auth.logout(request); setCookie(response, auth.clearCookie()); response.writeHead(204); response.end(); return; }
      const session = await auth.current(request);
      if (!session) { json(response, { error: '请先登录。' }, 401); return; }
      if (await managementRequest({ request, response, url, session, management, auth, storage: globalStorage, json, requestJson })) return;
      if (route.startsWith('/api/storage/')) throw new InputError('云存储由管理员统一配置。', 403);
      if (!session.isAdmin && management.settings.maintenance && !['GET', 'HEAD'].includes(method)) throw new InputError(management.settings.maintenanceMessage || '网站正在维护，请稍后再试。', 503);
      const app = await contextFor(session);
      if (method === 'POST' && ['/api/projects', '/api/projects/import'].includes(route) && app.store.list().length >= management.settings.maxProjects) throw new InputError('已达到工程数量上限，请整理已有工程或联系管理员。', 409);
      request.headers.host = gatewayHost;
      if (!origin && host === publicHost) request.headers.origin = publicOrigin;
      request.headers['x-studio-token'] = app.token;
      app.server.emit('request', request, response);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      json(response, { error: error.status ? error.message : '操作未完成，请重试。' }, error.status || 500);
    }
  });
  server.requestTimeout = 20 * 60 * 1000;
  return { server, auth, contexts, management,
    async start(port = 18970) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); currentPort = server.address().port; return `http://127.0.0.1:${currentPort}`; },
    async close() { for (const app of contexts.values()) await app.close(); await new Promise(resolve => server.close(resolve)); auth.close(); management.close(); },
  };
}

function openBrowser(url) {
  const child = process.platform === 'win32'
    ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore', detached: true })
    : spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {}); child.unref();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.JINGCE_PORT || 18970);
    const runtimeRoot = path.join(directory, 'runtime');
    if (process.env.JINGCE_MULTI_USER === '1') {
      const app = await createStudio({ root: runtimeRoot, multiUser: true, publicOrigin: process.env.JINGCE_PUBLIC_ORIGIN || 'https://dream.beibeihai.xyz' });
      const url = await app.start(port);
      process.once('SIGINT', () => app.close().then(() => process.exit(0)));
      process.once('SIGTERM', () => app.close().then(() => process.exit(0)));
      console.log(`\n幻帧 MiraFrame AI 视频工作台已启动：${url}\n多用户认证已启用。`);
      if (process.argv.includes('--open')) openBrowser(url);
    } else {
    const { readOwnedSession, startSharedStudio } = await import('./tools/share/start-studio.mjs');
    const ownedSession = await readOwnedSession({ runtimeRoot });
    if (ownedSession) {
      console.log(`工作台已经启动：${ownedSession.url}`);
      if (process.argv.includes('--open')) openBrowser(ownedSession.url);
    } else {
    const started = await startSharedStudio({ runtimeRoot, preferredPort: port, studioFactory: createStudio });
    if (!started.reused) {
      await atomicJson(path.join(started.app.store.root, 'server.json'), { port: started.port, appId: 'jingce-ad-studio' });
      process.once('SIGINT', () => started.close().then(() => process.exit(0)));
      process.once('SIGTERM', () => started.close().then(() => process.exit(0)));
    }
    console.log(`\n${started.reused ? '工作台已经启动' : '幻帧 MiraFrame AI 视频工作台已启动'}：${started.url}\n只在本机运行。关闭此窗口可以停止服务。\n`);
    if (process.argv.includes('--open')) openBrowser(started.url);
    }
    }
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? '端口已占用：如果工作台已经启动，请打开 http://127.0.0.1:18970 。' : '启动失败，请检查 runtime 数据目录及 Node.js 安装。');
    process.exitCode = 1;
  }
}
