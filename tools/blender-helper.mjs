import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Store, atomicJson } from '../lib/store.mjs';
import { createProject, InputError } from '../lib/workflow.mjs';
import { PrevisJobs, detectPrevisTools } from '../lib/previs.mjs';

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (response, value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
async function body(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new InputError('请求过大。', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new InputError('请求需要有效 JSON。'); }
}
function allowedOrigin(value) {
  try { const url = new URL(value); return url.origin === value && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)); }
  catch { return false; }
}
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export async function createBlenderHelper(options = {}) {
  const root = options.root || path.join(directory, 'runtime', 'blender-helper'); await mkdir(root, { recursive: true });
  const store = new Store(root); await store.init(); const previs = new PrevisJobs(store, { detectTools: (_root, settings) => detectPrevisTools(path.join(directory, 'runtime'), settings), ...options.previs }); await previs.init();
  let sessions = await readFile(path.join(root, 'helper-sessions.private.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const uiToken = randomBytes(32).toString('hex'), pending = new Map(); let port = 0, sessionsPending = Promise.resolve();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host)) throw new InputError('助手只接受本机地址。', 403);
      const url = new URL(request.url, `http://127.0.0.1:${port}`), route = url.pathname, origin = request.headers.origin;
      const localOrigin = !origin || [`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin);
      const pairing = route === '/api/bridge/session';
      if (origin && !localOrigin) {
        if (!allowedOrigin(origin) || !pairing && !sessions.some(item => item.origin === origin)) throw new InputError('请先在 幻帧blender助手授权此网站。', 403);
        response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Private-Network', 'true');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Jingce-Helper-Token');
      }
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      if (route === '/' && request.method === 'GET') {
        const id = url.searchParams.get('request'), website = url.searchParams.get('origin');
        if (id && /^[a-zA-Z0-9_-]{20,100}$/.test(id) && allowedOrigin(website) && !pending.has(id)) pending.set(id, { origin: website, createdAt: Date.now() });
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
        response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>幻帧blender助手</title><style>body{font:16px system-ui;margin:40px auto;padding:0 24px;max-width:740px;color:#202c3d;background:#f5f7fa}article{background:white;padding:24px;border-radius:16px;margin:20px 0}button{padding:12px 20px;background:#5964ef;color:white;border:0;border-radius:8px;cursor:pointer}label{display:block;margin:14px 0}input,select{display:block;width:95%;padding:10px;margin-top:8px}p{line-height:1.6;overflow-wrap:anywhere}#status{white-space:pre-wrap}</style><h1>幻帧blender助手</h1><p>保持助手运行，在幻帧 MiraFrame网站完成场景编辑、预演和素材保存。</p><article id="pairing" hidden><h2>连接幻帧 MiraFrame网站</h2><p id="website"></p><button id="approve">允许此网站使用 Blender 预演</button></article><article><h2>本机工具</h2><p id="status">正在检测…</p><form id="tools"><label>Blender 路径<input name="blenderPath" placeholder="留空自动检测已安装的 Blender"></label><label>FFmpeg 路径<input name="ffmpegPath" placeholder="留空自动检测内置编码工具"></label><label>渲染方式<select name="engine"><option value="auto">自动（白模 / CPU 回退）</option><option value="cycles">CPU 渲染</option><option value="workbench">白模引擎</option></select></label><button>保存并检测</button></form></article><article><h2>已授权网站</h2><div id="sites"></div></article><script src="/helper-ui.js"></script></html>`); return;
      }
      if (route === '/helper-ui.js' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        response.end(`const $=s=>document.querySelector(s);let token;const params=new URLSearchParams(location.search);async function api(route,body){const r=await fetch(route,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-Jingce-Helper-Token':token}:{},body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)throw Error(v.error);return v}function tools(value){$('#status').textContent=value.blender.version+'\\n'+value.blender.message+'\\n'+value.ffmpeg.message}async function init(){const data=await api('/api/helper/bootstrap');token=data.token;tools(data.tools);$('#sites').replaceChildren();for(const site of data.sites){const p=document.createElement('p');p.textContent=site.origin;const b=document.createElement('button');b.textContent='断开授权';b.onclick=async()=>{await api('/api/helper/revoke',{origin:site.origin});await init()};p.append(' ',b);$('#sites').append(p)}if(params.get('request')){$('#pairing').hidden=false;$('#website').textContent=params.get('origin')}}$('#approve').onclick=async()=>{try{await api('/api/helper/approve',{request:params.get('request')});$('#pairing').hidden=true;$('#status').textContent='已连接。返回幻帧 MiraFrame网站继续预演。'}catch(e){$('#status').textContent=e.message}};$('#tools').onsubmit=async e=>{e.preventDefault();try{const f=e.target.elements;tools(await api('/api/helper/tools',{blenderPath:f.blenderPath.value,ffmpegPath:f.ffmpegPath.value,engine:f.engine.value}))}catch(e){$('#status').textContent=e.message}};init().catch(e=>$('#status').textContent=e.message);`); return;
      }
      if (pairing && request.method === 'GET') {
        if (!origin || !allowedOrigin(origin)) throw new InputError('需要来自幻帧 MiraFrame网站的连接请求。', 403);
        const id = url.searchParams.get('request'); if (!/^[a-zA-Z0-9_-]{20,100}$/.test(id || '')) throw new InputError('连接请求编号不正确。');
        const item = pending.get(id);
        if (item && item.origin !== origin) throw new InputError('网站与连接请求不匹配。', 403);
        const session = sessions.find(item => item.request === id && item.origin === origin);
        json(response, session ? { state: 'connected', token: session.token } : { state: 'pending' }); return;
      }
      if (route.startsWith('/api/helper/')) {
        if (!localOrigin || request.headers['sec-fetch-site'] === 'cross-site') throw new InputError('请在本机助手页面设置。', 403);
        if (route === '/api/helper/bootstrap' && request.method === 'GET') { json(response, { token: uiToken, tools: await previs.tools(), sites: sessions.map(({ origin }) => ({ origin })) }); return; }
        if (!equal(request.headers['x-jingce-helper-token'], uiToken)) throw new InputError('助手操作令牌失效。', 403);
        if (route === '/api/helper/tools' && request.method === 'POST') { json(response, await previs.saveSettings(await body(request))); return; }
        if (['/api/helper/approve', '/api/helper/revoke'].includes(route) && request.method === 'POST') {
          const input = await body(request);
          const task = sessionsPending.then(async () => {
            let next;
            if (route.endsWith('/approve')) {
              const item = pending.get(input.request); if (!item || Date.now() - item.createdAt > 5 * 60 * 1000) throw new InputError('连接请求已过期，请在网站重新连接。');
              next = [...sessions.filter(session => session.origin !== item.origin), { origin: item.origin, request: input.request, token: randomBytes(32).toString('hex') }];
            } else next = sessions.filter(session => session.origin !== input.origin);
            await atomicJson(path.join(root, 'helper-sessions.private.json'), next); sessions = next;
          }); sessionsPending = task.catch(() => {}); await task; json(response, { ok: true }); return;
        }
      }
      const session = sessions.find(item => item.origin === origin && equal(request.headers['x-jingce-helper-token'], item.token));
      if (!session) throw new InputError('本机助手尚未连接，或此网站授权已断开。', 403);
      if (route === '/api/previs/tools' && request.method === 'GET') { json(response, await previs.tools(url.searchParams.has('refresh'))); return; }
      if (route === '/api/previs/jobs' && request.method === 'POST') {
        const input = await body(request);
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.projectId || '')) throw new InputError('工程编号格式不正确。');
        // Namespaces keep two approved websites with identical project ids separate.
        const localId = (await import('node:crypto')).createHash('sha256').update(origin + '\0' + input.projectId).digest('hex');
        if (!store.state.projects.some(project => project.id === localId)) await store.mutate(state => { const project = createProject({ title: input.projectTitle }); project.id = localId; if (!state.projects.some(item => item.id === localId)) state.projects.push(project); });
        const job = await previs.start(localId, { ...input, mode: 'server' });
        await previs.patch(job.id, { websiteOrigin: origin }); json(response, previs.get(job.id), 202); return;
      }
      const match = /^\/api\/previs\/jobs\/([a-f0-9-]{36})(?:\/(cancel|retry|open|artifacts)(?:\/([a-z0-9-]+))?)?$/.exec(route);
      if (match) {
        const [, id, action, key] = match, job = previs.get(id);
        if (job.websiteOrigin !== origin) throw new InputError('这个预演属于另一个网站。', 403);
        if (!action && request.method === 'GET') { json(response, job); return; }
        if (['cancel', 'retry', 'open'].includes(action) && request.method === 'POST') { await body(request); json(response, await previs[action](id)); return; }
        if (action === 'artifacts' && request.method === 'GET') {
          const artifact = previs.artifact(id, key); const info = await stat(artifact.filename).catch(() => { throw new InputError('输出文件尚未生成。', 404); });
          response.writeHead(200, { 'Content-Type': artifact.mime, 'Content-Length': info.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}` });
          await pipeline(createReadStream(artifact.filename), response); return;
        }
      }
      throw new InputError('助手地址不存在。', 404);
    } catch (error) { if (!response.headersSent) json(response, { error: error instanceof InputError ? error.message : '助手操作未完成。' }, error instanceof InputError ? error.status : 500); }
  });
  return { store, previs, server,
    async start(target = 18973) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(target, '127.0.0.1', resolve); }); port = server.address().port; return `http://127.0.0.1:${port}`; },
    async close() { await previs.close(); await sessionsPending; await store.pending; await new Promise(resolve => server.close(resolve)); },
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createBlenderHelper();
  try {
    const url = await app.start(Number(process.env.JINGCE_BLENDER_HELPER_PORT || 18973)); console.log(`幻帧blender助手已启动：${url}\n保持窗口运行，在幻帧 MiraFrame网站连接并开始预演。`);
    if (process.argv.includes('--open')) { const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, detached: true, stdio: 'ignore' }); child.on('error', () => {}); child.unref(); }
    for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => app.close().then(() => process.exit(0)));
  } catch (error) { console.error(error.code === 'EADDRINUSE' ? '幻帧blender助手已经运行，打开 http://127.0.0.1:18973/ 查看。' : escape(error.message)); process.exitCode = error.code === 'EADDRINUSE' ? 0 : 1; }
}
