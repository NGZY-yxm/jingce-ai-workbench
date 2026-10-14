import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, copyFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { atomicJson } from './store.mjs';
import { InputError, touch } from './workflow.mjs';
import { normalizePrevisSpec, previsDimensions } from '../public/previs-spec.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const generator = path.join(directory, '..', 'tools', 'blender-previs.py');
export const PREVIS_ACTIVE = new Set(['queued', 'building', 'rendering', 'encoding', 'verifying', 'saving', 'waiting-local']);
const terminal = new Set(['done', 'failed', 'cancelled']);
const now = () => new Date().toISOString();
const cleanError = error => String(error?.message || error || '预演未完成。').slice(0, 1800);
export function validatePrevisSpec(value) {
  try { return normalizePrevisSpec(value); } catch (error) { throw new InputError(error.message); }
}
export function previsArtifacts(spec) {
  const total = spec.duration * spec.fps;
  const numbers = [...new Set([1, Math.ceil(total / 2), total,
    ...spec.beats.map(beat => Math.min(total, 1 + Math.round(beat.time * spec.fps)))])].sort((a, b) => a - b);
  return [
    { key: 'spec', file: 'scene_spec.json', name: '场景配置.json', mime: 'application/json' },
    { key: 'prompt', file: 'video_prompt.txt', name: '成片提示词.txt', mime: 'text/plain; charset=utf-8' },
    { key: 'blend', file: 'scene.blend', name: `${spec.name}.blend`, mime: 'application/octet-stream' },
    { key: 'overview', file: 'overview.png', name: `${spec.name} · 俯视路线图.png`, mime: 'image/png', kind: 'image' },
    { key: 'video', file: 'previs.mp4', name: `${spec.name} · 预演.mp4`, mime: 'video/mp4', kind: 'video' },
    ...numbers.map(frame => ({ key: `frame-${frame}`, file: `frames/frame_${String(frame).padStart(4, '0')}.png`,
      name: `${spec.name} · ${(Math.max(0, frame - 1) / spec.fps).toFixed(2)}秒.png`, mime: 'image/png', kind: 'image', frame })),
  ];
}
export function previsPrompt(spec) {
  return `一镜到底，无切镜、无转场。以预演视频的空间关系、人物路线、摄影机运动和揭示时机为参考。\n场景：${spec.name}。时长：${spec.duration}秒；比例：${spec.ratio}。\n主体：${spec.actors.map(actor => actor.name).join('、') || '按场景配置'}。\n动作节拍：${spec.beats.map(beat => `${beat.time}秒 ${beat.label}`).join('；')}。\n保持主体外观、行进方向和道具位置连贯。在此补充人物外观、材质、风格和光线要求。预演为几何白模，请将其转换为成片画面。`;
}

// Arguments are always passed as an array. No shell and no imported skill scripts.
export function runPrevisProcess(executable, args, { signal, onLine = () => {}, timeout = 45 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new InputError('预演已取消。', 409)); return; }
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '', stdoutPending = '', stderrPending = '', expired = false;
    const abort = () => child.kill();
    const timer = setTimeout(() => { expired = true; child.kill(); }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    function lines(chunk, stderr) {
      const value = chunk.toString('utf8'); tail = (tail + value).slice(-65536);
      let pending = (stderr ? stderrPending : stdoutPending) + value;
      const rows = pending.split(/[\r\n]+/); pending = rows.pop().slice(-16000);
      for (const row of rows) if (row) onLine(row);
      if (stderr) stderrPending = pending; else stdoutPending = pending;
    }
    child.stdout.on('data', chunk => lines(chunk, false)); child.stderr.on('data', chunk => lines(chunk, true));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', error => { cleanup(); reject(new InputError(`无法启动 ${path.basename(executable)}：${error.code || error.message}。请检查工具路径。`)); });
    child.once('close', code => {
      cleanup(); for (const row of [stdoutPending, stderrPending]) if (row) onLine(row);
      if (signal?.aborted) reject(new InputError('预演已取消。', 409));
      else if (expired) reject(new InputError('渲染超时，已停止进程。可降低分辨率或时长后重新预演。'));
      else if (code !== 0) reject(new InputError(`${path.basename(executable)} 未正常完成（${code}）。${tail.slice(-1600)}`));
      else resolve(tail);
    });
  });
}
function toolPath(value, tool) {
  if (!value) return '';
  if (typeof value !== 'string' || value.length > 1000 || /[\0\r\n]/.test(value)) throw new InputError('工具路径格式不正确。');
  const normalized = value.trim();
  if (!new RegExp(`^${tool}(?:[-_.a-z0-9]*)?(?:\\.exe)?$`, 'i').test(path.basename(normalized))) throw new InputError(`请选择 ${tool} 可执行文件。`);
  return normalized;
}
async function existing(filename) { try { return (await stat(filename)).isFile(); } catch { return false; } }
async function findBlender(root) {
  const local = path.join(root, 'tools', 'blender', process.platform === 'win32' ? 'blender.exe' : 'blender');
  if (await existing(local)) return local;
  if (process.platform === 'win32') {
    for (const parent of [process.env.PROGRAMFILES, 'C:\\Program Files', 'D:\\Program Files'].filter(Boolean)) {
      const folder = path.join(parent, 'Blender Foundation');
      const entries = await readdir(folder).catch(() => []);
      for (const entry of entries.sort().reverse()) {
        const filename = path.join(folder, entry, 'blender.exe'); if (await existing(filename)) return filename;
      }
    }
  }
  return 'blender';
}
async function findFfmpeg(root) {
  const native = path.join(root, 'tools', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (await existing(native)) return native;
  const binaries = path.join(root, 'tools', 'video-python', 'imageio_ffmpeg', 'binaries');
  for (const name of (await readdir(binaries).catch(() => [])).sort()) if (/^ffmpeg.*\.exe$/i.test(name)) return path.join(binaries, name);
  return 'ffmpeg';
}
export async function detectPrevisTools(root, settings = {}, execute = runPrevisProcess) {
  const blenderPath = toolPath(settings.blenderPath || process.env.JINGCE_BLENDER, 'blender') || await findBlender(root);
  const ffmpegPath = toolPath(settings.ffmpegPath || process.env.JINGCE_FFMPEG, 'ffmpeg') || await findFfmpeg(root);
  const results = await Promise.allSettled([
    execute(blenderPath, ['--version'], { timeout: 7000 }),
    execute(ffmpegPath, ['-hide_banner', '-encoders'], { timeout: 7000 }),
  ]);
  const blender = { path: blenderPath, ready: results[0].status === 'fulfilled',
    version: results[0].status === 'fulfilled' ? /^Blender[^\r\n]*/m.exec(results[0].value)?.[0] || 'Blender' : '',
    message: results[0].status === 'fulfilled' ? 'Blender 可用。' : '未检测到 Blender，请安装或选择 blender.exe。' };
  const encoder = results[1].status === 'fulfilled' ? /\blibx264\b/.test(results[1].value) ? 'libx264' : /\blibopenh264\b/.test(results[1].value) ? 'libopenh264' : '' : '';
  const ffmpeg = { path: ffmpegPath, ready: Boolean(encoder), encoder,
    message: encoder ? 'H.264 编码工具可用。' : '未检测到支持 H.264 的 FFmpeg，请配置 FFmpeg 路径。' };
  return { ready: blender.ready && ffmpeg.ready, blender, ffmpeg, checkedAt: now() };
}
function imageDimensions(buffer) {
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new InputError('预演图片不是有效 PNG。');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
export async function validatePrevisOutputs(folder, spec, { includeFrames = false } = {}) {
  const dimensions = previsDimensions(spec);
  for (const artifact of previsArtifacts(spec).filter(item => !['spec', 'prompt'].includes(item.key))) {
    const data = await readFile(path.join(folder, artifact.file));
    if (!data.length) throw new InputError(`${artifact.name} 为空。`);
    if (artifact.key === 'blend' && data.subarray(0, 7).toString() !== 'BLENDER') throw new InputError('Blender 工程未正常保存。');
    if (artifact.key === 'video' && (data.length < 32 || data.subarray(4, 8).toString() !== 'ftyp')) throw new InputError('MP4 未正常生成。');
    if (artifact.kind === 'image' && JSON.stringify(imageDimensions(data)) !== JSON.stringify(dimensions)) throw new InputError('预演图片尺寸与场景配置不一致。');
  }
  if (includeFrames) {
    const total = spec.duration * spec.fps;
    const actual = (await readdir(path.join(folder, 'frames'))).filter(name => /^frame_\d{4}\.png$/.test(name));
    if (actual.length !== total) throw new InputError(`PNG 序列帧数不正确：需要 ${total}，实际 ${actual.length}。`);
    for (let frame = 1; frame <= total; frame++) {
      const data = await readFile(path.join(folder, 'frames', `frame_${String(frame).padStart(4, '0')}.png`));
      if (JSON.stringify(imageDimensions(data)) !== JSON.stringify(dimensions)) throw new InputError(`第 ${frame} 帧损坏或尺寸不一致。`);
    }
  }
  return dimensions;
}
export async function renderPrevis(folder, spec, tools, { signal, progress = () => {}, execute = runPrevisProcess, engine = 'auto' } = {}) {
  const total = spec.duration * spec.fps;
  const render = async mode => {
    await progress('building', 0.02, `正在建立场景与摄影机路线（${mode === 'cycles' ? 'CPU 渲染' : '白模渲染'}）。`);
    await execute(tools.blender.path, ['--background', '--factory-startup', '--python-exit-code', '1', '--threads', '2', '--python', generator, '--',
      '--spec', path.join(folder, 'scene_spec.json'), '--output', folder, '--engine', mode], { signal, onLine: line => {
        if (!line.startsWith('JINGCE_PREVIS ')) return;
        try {
          const event = JSON.parse(line.slice(14));
          if (event.stage === 'built') progress('rendering', 0.06, '白模工程已保存，正在渲染。');
          if (event.stage === 'frame') progress('rendering', 0.06 + 0.75 * event.frame / total, `正在渲染 ${event.frame}/${total} 帧。`);
        } catch { /* Ordinary Blender output is diagnostic data. */ }
      } });
  };
  let usedEngine = engine === 'cycles' ? 'cycles' : 'workbench';
  try { await render(usedEngine); }
  catch (error) {
    if (signal?.aborted || engine !== 'auto' || !/OpenGL|GPU|graphics|EGL|Vulkan|Workbench|EXCEPTION_ACCESS_VIOLATION|access violation/i.test(error.message)) throw error;
    usedEngine = 'cycles'; await progress('building', 0.03, '白模引擎未完成，改用 CPU 渲染。'); await render(usedEngine);
  }
  // PNG count and dimensions are checked again after encoding alongside the MP4.
  await progress('encoding', .82, '正在合成 H.264 MP4。');
  await execute(tools.ffmpeg.path, ['-hide_banner', '-y', '-framerate', String(spec.fps), '-start_number', '1', '-i', path.join(folder, 'frames', 'frame_%04d.png'),
    '-frames:v', String(total), '-c:v', tools.ffmpeg.encoder, '-threads', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', path.join(folder, 'previs.mp4')], { signal });
  await progress('verifying', .93, '正在检查图片序列并完整解码 MP4。');
  const dimensions = await validatePrevisOutputs(folder, spec, { includeFrames: true });
  let decoded = 0, microseconds = 0;
  await execute(tools.ffmpeg.path, ['-hide_banner', '-v', 'error', '-xerror', '-i', path.join(folder, 'previs.mp4'), '-map', '0:v:0',
    '-an', '-progress', 'pipe:1', '-f', 'null', '-'], { signal, onLine: line => {
      if (/^frame=/.test(line)) decoded = Number(line.slice(6));
      if (/^out_time_us=/.test(line)) microseconds = Number(line.slice(12));
    } });
  if (decoded !== total || Math.abs(microseconds / 1000000 - spec.duration) > 1 / spec.fps + .01) throw new InputError(`MP4 解码验证不通过：${decoded}/${total} 帧，时长 ${microseconds / 1000000} 秒。`);
  return { ...dimensions, frames: total, fps: spec.fps, duration: spec.duration, decodedFrames: decoded, decodedDuration: microseconds / 1000000, engine: usedEngine, verifiedAt: now() };
}

export class PrevisJobs {
  constructor(store, options = {}) {
    this.store = store; this.options = options; this.busy = new Map(); this.tasks = new Set(); this.closed = false;
    this.toolsCache = null; this.toolsRead = null; this.settings = {}; this.settingsPending = Promise.resolve();
  }
  async init() {
    await mkdir(path.join(this.store.root, 'previs'), { recursive: true });
    this.settings = await readFile(path.join(this.store.root, 'previs-settings.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
    await this.store.mutate(state => {
      state.previsJobs ||= [];
      for (const job of state.previsJobs) if (job.mode !== 'helper' && PREVIS_ACTIVE.has(job.state)) {
        Object.assign(job, { state: 'failed', message: '工作台在任务完成前停止；已保留工程与帧序列，可重试本次预演。', interrupted: true, updatedAt: now() });
      }
    });
  }
  folder(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new InputError('预演编号不正确。');
    return path.join(this.store.root, 'previs', id);
  }
  get(id) {
    const job = (this.store.state.previsJobs || []).find(item => item.id === id);
    if (!job) throw new InputError('找不到这个预演任务。', 404);
    return structuredClone(job);
  }
  list(projectId) { return structuredClone((this.store.state.previsJobs || []).filter(item => item.projectId === projectId).reverse()); }
  projects(projectId) {
    const project = this.store.get(projectId);
    return structuredClone(project.previsProjects?.length ? project.previsProjects : [{ id: 'default', title: '预演工程 1' }]);
  }
  async createProject(projectId, input) {
    const title = typeof input?.title === 'string' ? input.title.trim() : '';
    if (!title || title.length > 120) throw new InputError('请填写 1–120 字的预演工程名称。');
    return this.store.update(projectId, project => {
      if (!project.previsProjects?.length) project.previsProjects = [{ id: 'default', title: '预演工程 1' }];
      project.previsProjects.push({ id: randomUUID(), title, createdAt: now() });
      return touch(project);
    });
  }
  async tools(force = false) {
    if (this.toolsRead) return this.toolsRead;
    if (!force && this.toolsCache && Date.now() - this.toolsCache.time < 15000) return this.toolsCache.value;
    this.toolsRead = (this.options.detectTools || detectPrevisTools)(this.store.root, this.settings).then(value => { this.toolsCache = { time: Date.now(), value }; return value; }).finally(() => { this.toolsRead = null; });
    return this.toolsRead;
  }
  async saveSettings(input) {
    const operation = this.settingsPending.then(async () => {
      const next = { blenderPath: toolPath(input.blenderPath, 'blender'), ffmpegPath: toolPath(input.ffmpegPath, 'ffmpeg'),
        engine: ['auto', 'workbench', 'cycles'].includes(input.engine) ? input.engine : 'auto' };
      await atomicJson(path.join(this.store.root, 'previs-settings.json'), next); this.settings = next; this.toolsCache = null;
      return { ...(await this.tools(true)), settings: next };
    }); this.settingsPending = operation.catch(() => {}); return operation;
  }
  async patch(id, values) {
    return this.store.mutate(state => {
      const job = (state.previsJobs || []).find(item => item.id === id);
      if (!job) throw new InputError('预演记录已移除。', 404);
      Object.assign(job, values, { updatedAt: now() }); return job;
    });
  }
  async prepare(job) {
    const folder = this.folder(job.id); await mkdir(path.join(folder, 'frames'), { recursive: true });
    await atomicJson(path.join(folder, 'scene_spec.json'), job.spec);
    await writeFile(path.join(folder, 'video_prompt.txt'), previsPrompt(job.spec), 'utf8');
  }
  async start(projectId, input) {
    this.store.get(projectId);
    if (!input || typeof input.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.operationId)) throw new InputError('请提供有效的预演操作编号。');
    const previsProjectId = input.previsProjectId ?? 'default';
    if (!this.projects(projectId).some(project => project.id === previsProjectId)) throw new InputError('找不到当前创作工程中的这个预演工程。', 404);
    const original = item => {
      if ((item.previsProjectId || 'default') !== previsProjectId) throw new InputError('此操作编号已用于另一个预演工程，请继续原预演任务。', 409);
      return item;
    };
    const found = (this.store.state.previsJobs || []).find(item => item.projectId === projectId && item.operationId === input.operationId);
    if (found) return this.get(original(found).id);
    const spec = validatePrevisSpec(input.spec), external = input.mode === 'helper';
    if (!external) { const tools = await this.tools(); if (!tools.ready) throw new InputError(`${tools.blender.message} ${tools.ffmpeg.message}`); }
    const job = await this.store.mutate(state => {
      const existing = (state.previsJobs ||= []).find(item => item.projectId === projectId && item.operationId === input.operationId);
      if (existing) return original(existing);
      const project = state.projects.find(item => item.id === projectId && !item.deletedAt);
      if (!project) throw new InputError('工程已删除，请恢复后再预演。', 410);
      if (state.previsJobs.filter(item => item.mode !== 'helper' && PREVIS_ACTIVE.has(item.state)).length >= 5 && !external) throw new InputError('本机已有 5 个预演任务，请等队列完成。', 409);
      const job = { id: randomUUID(), operationId: input.operationId, projectId, previsProjectId, spec, mode: external ? 'helper' : 'server',
        state: external ? 'waiting-local' : 'queued', progress: 0, message: external ? '等待本机 Blender 助手。' : '已排队；本机每次渲染一个任务。',
        createdAt: now(), updatedAt: now(), attempts: 1, assets: [], artifacts: previsArtifacts(spec) };
      state.previsJobs.push(job); touch(project); return job;
    });
    await this.prepare(job); this.pump(); return job;
  }
  pump() {
    if (this.closed || this.busy.size) return;
    const job = (this.store.state.previsJobs || []).find(item => item.state === 'queued' && item.mode !== 'helper');
    if (!job) return;
    const controller = new AbortController(); this.busy.set(job.id, controller);
    const task = this.run(job, controller.signal).catch(error => console.error('[previs]', cleanError(error))).finally(() => {
      this.busy.delete(job.id); this.tasks.delete(task); this.pump();
    }); this.tasks.add(task);
  }
  async run(job, signal) {
    let progressPending = Promise.resolve(), lastProgress = 0;
    const progress = (state, value, message) => {
      if (signal.aborted) return progressPending;
      if (state === 'rendering' && Date.now() - lastProgress < 700 && value < .8) return progressPending;
      lastProgress = Date.now();
      progressPending = progressPending.then(() => signal.aborted ? undefined : this.patch(job.id, { state, progress: value, message }));
      progressPending.catch(() => {}); return progressPending;
    };
    try {
      const tools = await this.tools(); if (!tools.ready) throw new InputError('Blender 或 FFmpeg 当前不可用，请检查工具设置。');
      await this.prepare(job);
      const report = await (this.options.render || renderPrevis)(this.folder(job.id), job.spec, tools, { signal, progress, engine: this.settings.engine || 'auto' });
      await progressPending; if (signal.aborted) throw new InputError('预演已取消。', 409);
      await progress('saving', .98, '正在保存预演素材。');
      await this.publish(job.id, report);
    } catch (error) {
      await progressPending.catch(() => {});
      await this.patch(job.id, { state: signal.aborted ? 'cancelled' : 'failed', message: cleanError(error), finishedAt: now() });
    }
  }
  async publish(id, report) {
    const job = this.get(id); if (job.state === 'done') return job;
    if (job.state !== 'saving') throw new InputError('预演尚未完成，或已取消；输出仍保留。', 409);
    const dimensions = await validatePrevisOutputs(this.folder(id), job.spec);
    const total = job.spec.duration * job.spec.fps;
    if (!report || report.decodedFrames !== total || report.frames !== total || report.fps !== job.spec.fps || report.duration !== job.spec.duration
      || report.width !== dimensions.width || report.height !== dimensions.height || Math.abs(report.decodedDuration - job.spec.duration) > 1 / job.spec.fps + .01 || !Number.isFinite(report.decodedDuration)) {
      throw new InputError('本机验证报告与场景规格不一致，请重新完成 MP4 导出验证。');
    }
    const assets = [];
    for (const artifact of previsArtifacts(job.spec).filter(item => item.kind)) {
      const assetId = `${id}-${artifact.key}`, file = assetId + (artifact.kind === 'video' ? '.mp4' : '.png');
      await copyFile(path.join(this.folder(id), artifact.file), path.join(this.store.root, 'assets', file));
      assets.push({ id: assetId, name: artifact.name, file, mime: artifact.mime, kind: artifact.kind, size: (await stat(path.join(this.store.root, 'assets', file))).size,
        ...dimensions, ...(artifact.kind === 'video' ? { duration: job.spec.duration, fps: job.spec.fps } : {}), source: 'previs', previsJobId: id, createdAt: now() });
    }
    return this.store.mutate(state => {
      const current = state.previsJobs.find(item => item.id === id), project = state.projects.find(item => item.id === current?.projectId);
      if (!current || !project) throw new InputError('预演工程已移除。', 404);
      if (current.state === 'done') return current;
      if (current.state !== 'saving') throw new InputError('预演已取消，输出仍保留。', 409);
      for (const asset of assets) if (!project.assets.some(item => item.id === asset.id)) project.assets.push(asset);
      Object.assign(current, { state: 'done', progress: 1, report, assets: assets.map(item => item.id), videoAssetId: assets.find(item => item.kind === 'video').id,
        message: '预演 MP4、关键帧和路线图已保存到素材库。', finishedAt: now(), updatedAt: now() });
      touch(project); return current;
    });
  }
  async cancel(id) {
    const job = this.get(id);
    if (terminal.has(job.state)) return job;
    this.busy.get(id)?.abort();
    const result = await this.patch(id, { state: 'cancelled', message: '已取消，保留已生成的工程与帧。', finishedAt: now() }); this.pump(); return result;
  }
  async retry(id) {
    const job = this.get(id); this.store.get(job.projectId);
    if (!['failed', 'cancelled'].includes(job.state) || this.busy.has(id)) throw new InputError('请先等当前预演停止，再重试。', 409);
    const result = await this.patch(id, { state: job.mode === 'helper' ? 'waiting-local' : 'queued', progress: 0, message: '正在重试原场景配置。', attempts: job.attempts + 1, interrupted: false });
    this.pump(); return result;
  }
  async syncExternal(id, input) {
    const job = this.get(id);
    if (job.mode !== 'helper') throw new InputError('该任务由工作台本机执行。');
    if (terminal.has(job.state)) return job;
    if (input.localJobId === undefined && input.id !== undefined) input = { ...input, localJobId: input.id };
    if (typeof input.localJobId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.localJobId) || job.localJobId && job.localJobId !== input.localJobId) throw new InputError('本机预演编号不匹配。');
    if (![...PREVIS_ACTIVE, 'done', 'failed', 'cancelled'].includes(input.state)) throw new InputError('本机预演状态不正确。');
    return this.patch(id, { localJobId: input.localJobId, state: input.state === 'done' ? 'saving' : input.state,
      progress: Math.max(0, Math.min(.98, Number(input.progress) || 0)), message: String(input.message || '').slice(0, 1800), ...(input.report ? { report: input.report } : {}) });
  }
  artifact(id, key) {
    const job = this.get(id), artifact = previsArtifacts(job.spec).find(item => item.key === key);
    if (!artifact) throw new InputError('找不到这个预演文件。', 404);
    return { ...artifact, filename: path.join(this.folder(id), artifact.file) };
  }
  async receiveExternal(id, key, request) {
    const job = this.get(id);
    if (job.mode !== 'helper' || job.state !== 'saving') throw new InputError('请先完成本机预演，再保存输出。', 409);
    if (['spec', 'prompt'].includes(key)) throw new InputError('场景配置由原任务保存，不能替换。');
    const artifact = this.artifact(id, key), temporary = artifact.filename + '.' + randomUUID() + '.upload';
    const { createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    const { Transform } = await import('node:stream');
    const max = artifact.kind === 'video' || key === 'blend' ? 300 * 1024 * 1024 : 20 * 1024 * 1024;
    let bytes = 0;
    const meter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; callback(bytes > max ? new InputError('预演输出文件超过大小限制。', 413) : null, chunk); } });
    try { await pipeline(request, meter, createWriteStream(temporary, { flags: 'wx' })); await rename(temporary, artifact.filename); return { key, size: bytes }; }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async open(id) {
    const job = this.get(id); if (job.mode === 'helper') throw new InputError('请通过本机助手打开 Blender 工程。');
    const artifact = this.artifact(id, 'blend'); if (!await existing(artifact.filename)) throw new InputError('Blender 工程尚未生成。');
    const tools = await this.tools(); if (!tools.blender.ready) throw new InputError(tools.blender.message);
    const child = spawn(tools.blender.path, [artifact.filename], { detached: true, windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref(); return { opened: true };
  }
  async close() { this.closed = true; for (const controller of this.busy.values()) controller.abort(); await Promise.allSettled([...this.tasks]); await this.settingsPending; }
}
