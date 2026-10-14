import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import { detectMedia } from './media.mjs';
import { InputError } from './workflow.mjs';
import { selectedProjectSkills, createPackageManifest, restorePackageProject, PACKAGE_MAX_BYTES, PACKAGE_MANIFEST_MAX_BYTES, PACKAGE_MEDIA } from './project-portability.mjs';
import { updateCrc, crc32, zipSize, zipStream, zipEntries, entryStream } from './project-archive.mjs';

async function inspectAsset(root, asset, cachedFilename) {
  if (!cachedFilename && (typeof asset.file !== 'string' || !/^[\w.-]+$/.test(asset.file) || ['.', '..'].includes(asset.file))) throw new InputError('工程素材的本机文件路径不正确。');
  const folder = await realpath(path.join(root, cachedFilename ? 'text-results' : 'assets'));
  let filename;
  try { filename = await realpath(cachedFilename || path.join(folder, asset.file)); }
  catch { throw new InputError(`素材“${asset.name}”的原文件不存在，请恢复文件后再导出。`, 409); }
  if (path.dirname(filename) !== folder) throw new InputError('工程素材指向了素材目录之外的文件。');
  const handle = await open(filename, 'r');
  let info, prefix = Buffer.alloc(32);
  try { info = await handle.stat(); await handle.read(prefix, 0, 32, 0); }
  finally { await handle.close(); }
  const media = detectMedia(prefix);
  if (!info.isFile() || media.kind !== asset.kind || media.mime !== asset.mime || !info.size || info.size > PACKAGE_MEDIA[media.mime].limit) throw new InputError(`素材“${asset.name}”的格式或大小不符合分享要求。`);
  const hash = createHash('sha256'); let crc = 0xffffffff, size = 0;
  for await (const chunk of createReadStream(filename)) { size += chunk.length; crc = updateCrc(crc, chunk); hash.update(chunk); }
  if (size !== info.size) throw new InputError('素材在导出时发生变化，请重试。', 409);
  return { filename, size, crc: (crc ^ 0xffffffff) >>> 0, sha256: hash.digest('hex') };
}

export async function prepareProjectPackage(store, id, { skills: library, chatImages } = {}) {
  const project = store.get(id), cachedFiles = new Map(), aiImages = new Map();
  for (const node of project.graph.nodes) if (node.kind === 'ai' && node.aiConfig?.images?.length) {
    if (!chatImages) throw new InputError('AI 创作卡的图片保存服务不可用，请稍后重试。', 409);
    const references = [];
    for (const image of node.aiConfig.images) {
      const item = await chatImages.item(image.requestId, image.index);
      if (item.projectId !== id) throw new InputError('AI 创作卡的图片不属于当前工程。');
      const existing = project.assets.find(asset => !asset.deletedAt && (asset.chatImageId === `${image.requestId}-${image.index}` || asset.id === item.assetId));
      if (existing) { references.push(existing.id); continue; }
      const cached = await chatImages.cached(image.requestId, image.index), assetId = randomUUID();
      const asset = { id: assetId, file: '', name: cached.name || image.name || 'AI 回复图片', kind: 'image', mime: cached.mime, size: cached.size, source: 'chat', createdAt: project.updatedAt, chatImageId: `${image.requestId}-${image.index}` };
      project.assets.push(asset); cachedFiles.set(assetId, cached.filename); references.push(assetId);
    }
    aiImages.set(node.id, references);
  }
  const usedSkills = library ? selectedProjectSkills(project, library) : [];
  const manifest = createPackageManifest(project, { skills: usedSkills, aiImages }), active = project.assets.filter(asset => !asset.deletedAt);
  const entries = []; let bytes = 0;
  for (let index = 0; index < active.length; index++) {
    const file = await inspectAsset(store.root, active[index], cachedFiles.get(active[index].id)); bytes += file.size;
    if (bytes > PACKAGE_MAX_BYTES) throw new InputError('工程分享包最大支持 1 GB。', 413);
    Object.assign(manifest.project.assets[index], { size: file.size, sha256: file.sha256 });
    entries.push({ name: manifest.project.assets[index].path, ...file });
  }
  const data = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  if (data.length > PACKAGE_MANIFEST_MAX_BYTES) throw new InputError('工程创作内容超过 16 MB 分享限制。', 413);
  entries.unshift({ name: 'project.json', data, size: data.length, crc: crc32(data) });
  const size = zipSize(entries);
  if (size > PACKAGE_MAX_BYTES) throw new InputError('工程分享包最大支持 1 GB。', 413);
  return { size, stream: () => zipStream(entries), name: `${project.title.replace(/[\x00-\x1f<>:"/\\|?*]/g, '_') || '幻帧工程'}.miraframe.zip` };
}

async function extract(filename, entry, destination) {
  const { source, inflate, check } = entryStream(filename, entry);
  try { await pipeline(...[source, inflate, check, ...(Array.isArray(destination) ? destination : [destination])].filter(Boolean)); }
  catch (error) {
    if (['Z_DATA_ERROR', 'Z_BUF_ERROR'].includes(error.code)) throw new InputError('工程 ZIP 压缩数据损坏。');
    throw error;
  }
}

export async function importProjectArchive(request, store, { skills: library } = {}) {
  if (Number(request.headers['content-length']) > PACKAGE_MAX_BYTES) throw new InputError('工程分享包最大支持 1 GB。', 413);
  const base = path.resolve(store.root, 'imports'); await mkdir(base, { recursive: true });
  const staging = await mkdtemp(path.join(base, 'project-')), filename = path.join(staging, 'project.zip');
  const published = [], importedSkillIds = []; let committed = false;
  try {
    let bytes = 0;
    const meter = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length; callback(bytes > PACKAGE_MAX_BYTES ? new InputError('工程分享包最大支持 1 GB。', 413) : null, chunk);
    } });
    await pipeline(request, meter, createWriteStream(filename, { flags: 'wx' }));
    const entries = await zipEntries(filename), manifestEntry = entries.get('project.json');
    if (!manifestEntry || manifestEntry.size > PACKAGE_MANIFEST_MAX_BYTES) throw new InputError('分享包缺少工程清单，或清单超过 16 MB。');
    const chunks = [];
    await extract(filename, manifestEntry, new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } }));
    let manifest;
    try { manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new InputError('分享包中的工程清单不是有效 JSON。'); }
    const { project, assetFiles, skills, previews } = restorePackageProject(manifest);
    const expected = new Set(['project.json', ...assetFiles.map(file => file.path)]);
    if (entries.size !== expected.size || [...entries.keys()].some(name => !expected.has(name))) throw new InputError('分享包包含清单之外的文件，或缺少素材文件。');
    for (let index = 0; index < assetFiles.length; index++) {
      const record = assetFiles[index], entry = entries.get(record.path), original = manifest.project.assets[index];
      if (!entry || entry.size !== record.asset.size || !/^[a-f0-9]{64}$/.test(original.sha256 || '')) throw new InputError(`素材“${record.asset.name}”缺失或校验信息不正确。`);
      let prefix = Buffer.alloc(0); const hash = createHash('sha256');
      const check = new Transform({ transform(chunk, _encoding, callback) {
        if (prefix.length < 32) prefix = Buffer.concat([prefix, chunk.subarray(0, 32 - prefix.length)]);
        hash.update(chunk); callback(null, chunk);
      } });
      const target = path.join(store.root, 'assets', record.asset.file);
      // The destination is generated locally; neither ZIP paths nor imported paths select it.
      const handle = await open(target, 'wx'); published.push(target);
      try { await extract(filename, entry, [check, createWriteStream(target, { fd: handle.fd, autoClose: false })]); }
      finally { await handle.close().catch(error => { if (error.code !== 'EBADF') throw error; }); }
      const media = detectMedia(prefix);
      if (media.kind !== record.asset.kind || media.mime !== record.asset.mime || hash.digest('hex') !== original.sha256) throw new InputError(`素材“${record.asset.name}”的内容校验失败。`);
    }
    for (const preview of previews) {
      const target = path.join(store.root, 'text-results', `${preview.requestId}.json`);
      const handle = await open(target, 'wx'); published.push(target);
      try { await handle.writeFile(JSON.stringify({ projectId: preview.projectId, images: preview.images })); }
      finally { await handle.close(); }
    }
    if (skills.length) {
      if (!library) throw new InputError('技能库暂不可用，未导入工程。', 409);
      await library.mutate(items => { items.push(...skills); });
      importedSkillIds.push(...skills.map(skill => skill.id));
    }
    const result = await store.mutate(state => { state.projects.push(project); return project; });
    committed = true; return result;
  } finally {
    if (!committed) {
      if (importedSkillIds.length) await library.mutate(items => {
        for (let index = items.length - 1; index >= 0; index--) if (importedSkillIds.includes(items[index].id)) items.splice(index, 1);
      });
      for (const target of published) await rm(target, { force: true });
    }
    if (path.dirname(path.resolve(staging)) !== base || !path.basename(staging).startsWith('project-')) throw new Error('工程导入临时目录范围不正确。');
    await rm(staging, { recursive: true, force: true });
  }
}
