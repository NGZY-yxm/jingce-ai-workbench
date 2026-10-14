import { mkdir, readFile, writeFile, copyFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson } from './store.mjs';
import { InputError, touch } from './workflow.mjs';
import { detectMedia, downloadPublicImage } from './media.mjs';

export class ChatImages {
  constructor(store, options = {}) {
    this.store = store; this.root = path.join(store.root, 'text-results');
    this.download = options.download || downloadPublicImage; this.pending = new Map();
  }
  async init() { await mkdir(this.root, { recursive: true, mode: 0o700 }); }
  async record(requestId, projectId, images) {
    if (!images.length) return [];
    await atomicJson(path.join(this.root, `${requestId}.json`), { projectId, images });
    return images.map((image, index) => ({ requestId, index, name: String(image.name || '对话图片'),
      previewUrl: `/api/text-images/${requestId}/${index}` }));
  }
  async item(requestId, index) {
    if (!/^[a-f0-9-]{36}$/.test(requestId) || !Number.isSafeInteger(index) || index < 0) throw new InputError('图片编号不正确。');
    let result;
    try { result = JSON.parse(await readFile(path.join(this.root, `${requestId}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw new InputError('找不到这张对话图片。', 404); throw error; }
    const image = result.images[index];
    if (!image) throw new InputError('找不到这张对话图片。', 404);
    return { ...image, projectId: result.projectId };
  }
  async cached(requestId, index) {
    const key = `${requestId}-${index}`;
    if (this.pending.has(key)) return this.pending.get(key);
    const action = this.cache(requestId, index).finally(() => this.pending.delete(key));
    this.pending.set(key, action); return action;
  }
  async cache(requestId, index) {
    const image = await this.item(requestId, index), filename = path.join(this.root, `${requestId}-${index}.image`);
    if (image.assetId) {
      const project = this.store.get(image.projectId, true), asset = project.assets.find(asset => asset.id === image.assetId && asset.kind === 'image');
      if (!asset || !/^[\w.-]+$/.test(asset.file)) throw new InputError('这张工程图片的原文件已不可用。', 404);
      return { ...image, filename: path.join(this.store.root, 'assets', asset.file), kind: asset.kind, mime: asset.mime, extension: path.extname(asset.file), size: asset.size };
    }
    try {
      const bytes = await readFile(filename);
      const media = detectMedia(bytes.subarray(0, 32));
      if (media.kind !== 'image') throw new InputError('回复内容不是支持的图片。', 502);
      return { ...image, filename, ...media, size: bytes.length };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      if (image.source.startsWith('data:')) {
        const encoded = image.source.slice(image.source.indexOf(',') + 1);
        if (encoded.length > 28 * 1024 * 1024) throw new InputError('对话图片超过 20 MB。', 413);
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length > 20 * 1024 * 1024) throw new InputError('对话图片超过 20 MB。', 413);
        await writeFile(temporary, bytes, { flag: 'wx' });
      } else await this.download(image.source, temporary);
      const bytes = await readFile(temporary), media = detectMedia(bytes.subarray(0, 32));
      if (media.kind !== 'image') throw new InputError('回复内容不是 PNG、JPEG 或 WebP 图片。', 502);
      await rename(temporary, filename);
      return { ...image, filename, ...media, size: bytes.length };
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async add(projectId, requestId, index) {
    const project = this.store.get(projectId), item = await this.item(requestId, index);
    if (item.projectId !== projectId) throw new InputError('这张图片属于其他工程，请切换到原工程。', 409);
    const image = await this.cached(requestId, index);
    const imageId = `${requestId}-${index}`;
    const existing = project.assets.find(asset => asset.chatImageId === imageId);
    if (existing) {
      const updated = await this.store.update(projectId, current => { current.assets.find(asset => asset.id === existing.id).deletedAt = null; return touch(current); });
      return { asset: updated.assets.find(asset => asset.id === existing.id), project: updated };
    }
    const assetId = randomUUID(), file = assetId + image.extension, destination = path.join(this.store.root, 'assets', file);
    await copyFile(image.filename, destination);
    let used = false;
    try {
      const updated = await this.store.update(projectId, current => {
        const duplicate = current.assets.find(asset => asset.chatImageId === imageId);
        if (duplicate) { duplicate.deletedAt = null; return touch(current); }
        current.assets.push({ id: assetId, file, name: image.name.slice(0, 190) + image.extension,
          kind: 'image', mime: image.mime, size: (image.size || 0), createdAt: new Date().toISOString(), source: 'chat', chatImageId: imageId });
        return touch(current);
      });
      used = updated.assets.some(asset => asset.id === assetId);
      return { asset: updated.assets.find(asset => asset.chatImageId === imageId), project: updated };
    } finally { if (!used) await unlink(destination).catch(() => {}); }
  }
}
