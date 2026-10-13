import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, stat, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputError } from './workflow.mjs';
import { createWindowsThumbnail } from './windows-thumbnail.mjs';

const execute = promisify(execFile);
export const THUMBNAIL_EDGE = 512;
const programRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export class MediaThumbnails {
  constructor(root, options = {}) {
    this.root = path.join(root, 'media-thumbnails');
    const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const bundled = [root, path.join(programRoot, 'runtime')].map(directory => path.join(directory, 'tools', 'ffmpeg', 'bin', executable)).find(existsSync);
    this.ffmpeg = options.ffmpeg || process.env.JINGCE_FFMPEG || bundled || 'ffmpeg';
    this.windowsFallback = options.windowsFallback ?? process.platform === 'win32';
    this.render = options.render || ((source, destination) => this.convert(source, destination));
    this.pending = new Map(); this.failed = new Map(); this.active = 0; this.queue = [];
  }
  async get(source, kind) {
    if (!['image', 'video'].includes(kind)) throw new InputError('此素材没有图片或视频缩略图。');
    const info = await stat(source);
    const key = createHash('sha256').update(`v1:${source}:${info.size}:${info.mtimeMs}`).digest('hex');
    const filename = path.join(this.root, key + '.png');
    try { if ((await stat(filename)).size) return { filename, mime: 'image/png' }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (this.failed.get(key) > Date.now()) return null;
    this.failed.delete(key);
    if (!this.pending.has(key)) {
      const action = this.generate(source, filename).then(() => ({ filename, mime: 'image/png' }), () => {
        this.failed.set(key, Date.now() + 30000);
        if (this.failed.size > 128) this.failed.delete(this.failed.keys().next().value);
        return null;
      }).finally(() => this.pending.delete(key));
      this.pending.set(key, action);
    }
    return this.pending.get(key);
  }
  async generate(source, filename) {
    // Coalesce repeated requests and limit decoders while galleries load many assets.
    if (this.active >= 2) await new Promise(resolve => this.queue.push(resolve));
    else this.active++;
    const temporary = filename + '.' + randomUUID() + '.png';
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await this.render(source, temporary);
      if (!(await stat(temporary)).size) throw new Error('Empty thumbnail');
      await rename(temporary, filename);
    } finally {
      await unlink(temporary).catch(() => {});
      const next = this.queue.shift();
      if (next) next(); else this.active--;
    }
  }
  async convert(source, destination) {
    try {
      await execute(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1',
        '-protocol_whitelist', 'file,pipe', '-i', source, '-map', '0:v:0', '-frames:v', '1', '-an', '-sn',
        '-vf', `scale=w='min(${THUMBNAIL_EDGE},iw)':h='min(${THUMBNAIL_EDGE},ih)':force_original_aspect_ratio=decrease`,
        '-c:v', 'png', '-compression_level', '6', '-threads', '1', destination],
      { windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024 });
    } catch (error) {
      if (!this.windowsFallback) throw error;
      await createWindowsThumbnail(source, destination, THUMBNAIL_EDGE);
    }
  }
}

export const THUMBNAIL_PLACEHOLDER = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="320" viewBox="0 0 512 320"><rect width="512" height="320" fill="#18202b"/><g fill="#a8b0c0" font-family="sans-serif" text-anchor="middle"><text x="256" y="148" font-size="20">缩略图暂不可用</text><text x="256" y="182" font-size="16">点击预览查看原文件</text></g></svg>');
