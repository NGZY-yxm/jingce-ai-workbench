import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat, rename, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Store, atomicJson, publicSettings } from './lib/store.mjs';
import { createProject, updateProject, setAssetDeleted, draftPlan, importProject, exportProject, screenplay, InputError, touch, kinds } from './lib/workflow.mjs';
import { loadCatalog, checkConnection, DEFAULT_CONNECTION, PLATFORM, videoBaseUrl, submitVideo, pollVideo } from './lib/providers.mjs';
import { VideoJobs } from './lib/jobs.mjs';
import { ImageJobs } from './lib/image-jobs.mjs';
import { loadImageCatalog, imageCatalogOrFallback, checkImageConnection, DEFAULT_IMAGE_CONNECTION, IMAGE_PLATFORM } from './lib/image-provider.mjs';
import { loadTextCatalog, checkTextConnection, chatText, DEFAULT_TEXT_CONNECTION, TEXT_PLATFORM } from './lib/text-provider.mjs';
import { detectMedia } from './lib/media.mjs';
import { CosStorage, publicStorageSettings } from './lib/storage.mjs';
import { toolStatus, compositionClips, compositionAudio, compose } from './lib/compose.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const json = (response, body, status = 200) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
};
async function requestJson(request) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw new InputError('请求需要使用 JSON 格式。');
  let bytes = 0; const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new InputError('请求内容超过 2 MB。', 413);
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
  const root = options.root || path.join(directory, 'runtime');
  const store = new Store(root); await store.init();
  await store.migrateVideoSettings();
  const storage = new CosStorage(root, store, options.storage || {});
  let catalog = options.catalog || [];
  let catalogError = '';
  let imageCatalog = options.imageCatalog || [];
  let imageCatalogError = '';
  let textCatalog = options.textCatalog || [];
  let textCatalogError = '';
  const textFetcher = options.textFetcher || fetch;
  const videoFetcher = options.videoFetcher || fetch;
  if (!options.catalog) {
    if (!(await store.settings()).apiKey) catalogError = '请先保存视频 API Key，再读取当前密钥的模型目录。';
    else try { catalog = await loadCatalog(await store.settings(), videoFetcher); } catch { catalogError = '当前密钥的模型目录暂时无法读取，可在模型连接中检查密钥并刷新。'; }
  }
  if (!options.imageCatalog) {
    try { imageCatalog = await loadImageCatalog(); } catch { imageCatalogError = '图片模型目录暂时无法读取，将使用已核对的默认模型；可稍后刷新。'; }
  }
  if (!options.textCatalog) {
    const textSettings = await store.textSettings();
    if (textSettings.apiKey) {
      try { textCatalog = await loadTextCatalog(textSettings, textFetcher); }
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
  const token = randomBytes(32).toString('hex');
  let currentPort = 0;
  const exportBusy = new Set();
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    try {
      const allowedHosts = new Set([`127.0.0.1:${currentPort}`, `localhost:${currentPort}`]);
      if (!allowedHosts.has(request.headers.host)) throw new InputError('只接受本机地址访问。', 403);
      const origin = request.headers.origin;
      if ((origin && ![...allowedHosts].some(host => origin === `http://${host}`)) || request.headers['sec-fetch-site'] === 'cross-site') {
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
      if (['/', '/index.html', '/style.css', '/app.js', '/ai-text.js', '/text-markdown.js', '/marked.js', '/video-parameters.js', '/image-parameters.js', '/canvas.js', '/canvas-geometry.js', '/canvas-layout.js', '/canvas.css', '/liblib-theme.css', '/reference-model.js', '/reference-api.js', '/prompt-mentions.js', '/prompt-editor.js'].includes(route) && ['GET', 'HEAD'].includes(method)) {
        const filename = path.join(directory, 'public', route === '/' ? 'index.html' : route.slice(1));
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filename)], 'Cache-Control': 'no-cache' });
        response.end(method === 'HEAD' ? undefined : await readFile(filename)); return;
      }
      if (route === '/api/bootstrap' && method === 'GET') {
        json(response, { appId: 'jingce-ad-studio', token, projects: store.list(), deletedProjects: store.list(true).filter(project => project.deletedAt),
          settings: publicSettings(await store.settings(), await storage.publicSettings(), await store.imageSettings(), await store.textSettings()), catalog, catalogError, imageCatalog, imageCatalogError, textCatalog, textCatalogError, tools, kinds }); return;
      }
      if (route === '/api/projects' && method === 'GET') { json(response, store.list(url.searchParams.get('includeDeleted') === '1')); return; }
      if (route === '/api/projects' && method === 'POST') {
        const project = createProject(await requestJson(request));
        await store.mutate(state => { state.projects.push(project); return project; }); json(response, project, 201); return;
      }
      if (route === '/api/projects/import' && method === 'POST') {
        const project = importProject(await requestJson(request));
        await store.mutate(state => { state.projects.push(project); return project; }); json(response, project, 201); return;
      }
      const projectRoute = /^\/api\/projects\/([\w-]+)(?:\/(plan|export|screenplay|assets|jobs|image-jobs|image-batches|batches|compose|restore|permanent))?$/.exec(route);
      if (projectRoute) {
        const [, id, action] = projectRoute;
        if (!action && method === 'GET') { json(response, store.get(id, url.searchParams.get('includeDeleted') === '1')); return; }
        if (!action && method === 'DELETE') { json(response, await store.setDeleted(id, true)); return; }
        if (action === 'restore' && method === 'POST') {
          await requestJson(request); json(response, await store.setDeleted(id, false)); return;
        }
        if (action === 'permanent' && method === 'DELETE') {
          json(response, await store.permanentlyDelete(id, (_project, projectJobs, projectImageJobs) => exportBusy.has(id) || projectJobs.some(job => jobs.busy.has(job.id)) || projectImageJobs.some(job => imageJobs.busy.has(job.id)))); return;
        }
        if (!action && method === 'PATCH') {
          const patch = await requestJson(request);
          json(response, await store.update(id, project => updateProject(project, patch))); return;
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
        if (action === 'jobs' && method === 'GET') {
          store.get(id); json(response, jobs.list(id, url.searchParams.get('includeDeleted') === '1')); return;
        }
        if (action === 'jobs' && method === 'POST') { json(response, await jobs.start(id, await requestJson(request), catalog), 202); return; }
        if (action === 'image-jobs' && method === 'GET') {
          store.get(id); json(response, imageJobs.list(id, url.searchParams.get('includeDeleted') === '1')); return;
        }
        if (action === 'image-jobs' && method === 'POST') { json(response, await imageJobs.start(id, await requestJson(request), imageCatalog), 202); return; }
        if (action === 'image-batches' && method === 'POST') { json(response, await imageJobs.startBatch(id, await requestJson(request), imageCatalog), 202); return; }
        if (action === 'batches' && method === 'POST') { json(response, await jobs.startBatch(id, await requestJson(request), catalog), 202); return; }
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
        await serveMedia(request, response, path.join(root, 'assets', asset.file), asset.mime, url.searchParams.has('download') ? downloadName : ''); return;
      }
      const exportRoute = /^\/api\/exports\/([\w-]+)$/.exec(route);
      if (exportRoute && ['GET', 'HEAD'].includes(method)) {
        const output = store.state.projects.flatMap(project => project.exports).find(item => item.id === exportRoute[1] && item.state === 'done');
        if (!output) throw new InputError('成片尚未完成或不存在。', 404);
          await serveMedia(request, response, path.join(root, 'exports', output.file), 'video/mp4', url.searchParams.has('download') ? '镜策视频成片.mp4' : ''); return;
      }
      const imageRetry = /^\/api\/image-jobs\/([\w-]+)\/retry$/.exec(route);
      if (imageRetry && method === 'POST') { await requestJson(request); json(response, await imageJobs.retry(imageRetry[1])); return; }
      const imageRecord = /^\/api\/image-jobs\/([\w-]+)(?:\/(restore))?$/.exec(route);
      if (imageRecord && !imageRecord[2] && method === 'DELETE') { json(response, await imageJobs.setDeleted(imageRecord[1], true)); return; }
      if (imageRecord?.[2] === 'restore' && method === 'POST') { await requestJson(request); json(response, await imageJobs.setDeleted(imageRecord[1], false)); return; }
            const retry = /^\/api\/jobs\/([\w-]+)\/query$/.exec(route);
      if (retry && method === 'POST') { const input = await requestJson(request); json(response, await jobs.retryLookup(retry[1], input.taskId)); return; }
      const jobRecord = /^\/api\/jobs\/([\w-]+)(?:\/(restore))?$/.exec(route);
      if (jobRecord && !jobRecord[2] && method === 'DELETE') {
        json(response, await jobs.setDeleted(jobRecord[1], true)); return;
      }
      if (jobRecord?.[2] === 'restore' && method === 'POST') {
        await requestJson(request); json(response, await jobs.setDeleted(jobRecord[1], false)); return;
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
        await requestJson(request); imageCatalog = await loadImageCatalog(); imageCatalogError = ''; json(response, imageCatalog); return;
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
        await requestJson(request); textCatalog = await loadTextCatalog(await store.textSettings(), textFetcher); textCatalogError = ''; json(response, textCatalog); return;
      }
      if (route === '/api/text-chat' && method === 'POST') {
        const input = await requestJson(request), settings = await store.textSettings();
        const started = Date.now(), requestId = randomUUID();
        const rawModel = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : settings.textModel || '';
        const model = rawModel.split(settings.apiKey || '\0').join('[已隐藏密钥]')
          .split(settings.apiKey ? encodeURIComponent(settings.apiKey) : '\0').join('[已隐藏密钥]').slice(0, 160);
        const record = async outcome => {
          // Keep metadata only; never persist prompts, replies, headers or keys.
          await atomicJson(path.join(root, 'text-last-request.json'), {
            requestId, model, stream: false, startedAt: new Date(started).toISOString(),
            finishedAt: new Date().toISOString(), elapsedMs: Date.now() - started, ...outcome,
          }).catch(() => {});
        };
        try {
          const result = await chatText(settings, input, textFetcher);
          await record({ status: 'done', httpStatus: 200, code: '', finishReason: result.finishReason, answerLength: result.content.length });
          json(response, { ...result, requestId });
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
        if (next.apiKey !== previous.apiKey && !options.catalog) {
          catalog = []; catalogError = '';
          if (!next.apiKey) catalogError = '请先保存视频 API Key，再读取当前密钥的模型目录。';
          else try { catalog = await loadCatalog(next, videoFetcher); } catch { catalogError = '新密钥的模型目录未读取成功，请检查连接后刷新模型。'; }
        }
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
        await requestJson(request); catalog = []; catalogError = '';
        try { catalog = await loadCatalog(await store.settings(), videoFetcher); }
        catch (error) { catalogError = '当前密钥的模型目录读取失败，请检查密钥或稍后刷新。'; throw error; }
        json(response, catalog); return;
      }
      if (route === '/api/shutdown' && method === 'POST') {
        await requestJson(request); json(response, { ok: true });
        setTimeout(() => { jobs.close(); imageJobs.close(); server.close(); }, 100); return;
      }
      throw new InputError('这个地址不存在。', 404);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      json(response, { error: error instanceof InputError ? error.message : '操作未完成，请重试。' }, error instanceof InputError ? error.status : 500);
    }
  });
  server.requestTimeout = 300000;
  return { store, jobs, imageJobs, server,
    async start(port = 18970) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      currentPort = server.address().port;
      return `http://127.0.0.1:${currentPort}`;
    },
    async close() { jobs.close(); imageJobs.close(); await store.pending; await new Promise(resolve => server.close(resolve)); },
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
    const existingUrl = `http://127.0.0.1:${port}`;
    let alreadyRunning = false;
    try {
      const response = await fetch(`${existingUrl}/api/bootstrap`, { signal: AbortSignal.timeout(1000) });
      alreadyRunning = response.ok && (await response.json()).appId === 'jingce-ad-studio';
    } catch { /* Nothing is listening yet. */ }
    if (alreadyRunning) {
      console.log(`工作台已经启动：${existingUrl}`);
      if (process.argv.includes('--open')) openBrowser(existingUrl);
    } else {
    const app = await createStudio();
    const url = await app.start(port);
    await atomicJson(path.join(app.store.root, 'server.json'), { port: app.server.address().port, appId: 'jingce-ad-studio' });
    console.log(`\n镜策 AI 视频工作台已启动：${url}\n只在本机运行。关闭此窗口可以停止服务。\n`);
    if (process.argv.includes('--open')) openBrowser(url);
    process.on('SIGINT', () => app.close().then(() => process.exit(0)));
    process.on('SIGTERM', () => app.close().then(() => process.exit(0)));
    }
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? '端口已占用：如果工作台已经启动，请打开 http://127.0.0.1:18970 。' : '启动失败，请检查 runtime 数据目录及 Node.js 安装。');
    process.exitCode = 1;
  }
}
