import { open, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { createInflateRaw } from 'node:zlib';
import { InputError } from './workflow.mjs';
import { PACKAGE_MAX_BYTES, PACKAGE_ASSET_MAX_COUNT } from './project-portability.mjs';

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let crc = n;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  crcTable[n] = crc >>> 0;
}
export function updateCrc(crc, buffer) {
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
export const crc32 = buffer => (updateCrc(0xffffffff, buffer) ^ 0xffffffff) >>> 0;

function headers(entry, offset) {
  const name = Buffer.from(entry.name, 'utf8'), local = Buffer.alloc(30), central = Buffer.alloc(46);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt32LE(entry.crc, 14); local.writeUInt32LE(entry.size, 18); local.writeUInt32LE(entry.size, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
  central.writeUInt32LE(entry.crc, 16); central.writeUInt32LE(entry.size, 20); central.writeUInt32LE(entry.size, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
  return { name, local, central };
}
export function zipSize(entries) { return entries.reduce((size, entry) => size + 76 + 2 * Buffer.byteLength(entry.name) + entry.size, 22); }
export function zipStream(entries) {
  return Readable.from((async function* () {
    const index = []; let offset = 0;
    for (const entry of entries) {
      const { name, local, central } = headers(entry, offset);
      yield local; yield name;
      if (entry.data) yield entry.data;
      else {
        let size = 0, crc = 0xffffffff;
        for await (const chunk of createReadStream(entry.filename)) { size += chunk.length; crc = updateCrc(crc, chunk); yield chunk; }
        if (size !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) throw new InputError('导出时素材内容发生变化，请重新导出。', 409);
      }
      index.push(central, name); offset += local.length + name.length + entry.size;
    }
    const directory = Buffer.concat(index), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    yield directory; yield end;
  })());
}
async function readExact(handle, position, size) {
  const bytes = Buffer.alloc(size); let read = 0;
  while (read < size) {
    const result = await handle.read(bytes, read, size - read, position + read);
    if (!result.bytesRead) throw new InputError('工程 ZIP 文件被截断。');
    read += result.bytesRead;
  }
  return bytes;
}

// Read only the index first. Limits apply before decompression or any destination write.
export async function zipEntries(filename) {
  const info = await stat(filename);
  if (info.size < 22 || info.size > PACKAGE_MAX_BYTES) throw new InputError('工程 ZIP 分享包最大支持 1 GB。', 413);
  const handle = await open(filename, 'r');
  try {
    const tailSize = Math.min(info.size, 65557), tail = await readExact(handle, info.size - tailSize, tailSize);
    let endIndex = tail.length - 22;
    while (endIndex >= 0 && (tail.readUInt32LE(endIndex) !== 0x06054b50 || endIndex + 22 + tail.readUInt16LE(endIndex + 20) !== tail.length)) endIndex--;
    if (endIndex < 0) throw new InputError('请选择完整的工程 ZIP 分享包。');
    const end = tail.subarray(endIndex), count = end.readUInt16LE(10), directorySize = end.readUInt32LE(12), directoryStart = end.readUInt32LE(16);
    if (end.readUInt16LE(4) || end.readUInt16LE(6) || count !== end.readUInt16LE(8) || count < 1 || count > PACKAGE_ASSET_MAX_COUNT + 2
        || directorySize > 1024 * 1024 || directoryStart + directorySize !== info.size - tailSize + endIndex) throw new InputError('工程 ZIP 索引不正确或文件数量超过上限。');
    const directory = await readExact(handle, directoryStart, directorySize), entries = new Map(), ranges = [];
    let cursor = 0, total = 0;
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) throw new InputError('工程 ZIP 索引损坏。');
      const header = directory.subarray(cursor), flags = header.readUInt16LE(8), method = header.readUInt16LE(10);
      const nameLength = header.readUInt16LE(28), extra = header.readUInt16LE(30), comment = header.readUInt16LE(32), offset = header.readUInt32LE(42);
      const next = cursor + 46 + nameLength + extra + comment;
      if (next > directory.length || header.readUInt16LE(34) || (flags & ~0x080e) || ![0, 8].includes(method)) throw new InputError('工程 ZIP 不支持加密、多卷或这种压缩格式。');
      const nameBytes = directory.subarray(cursor + 46, cursor + 46 + nameLength), name = nameBytes.toString('utf8');
      const mode = header.readUInt32LE(38) >>> 16, type = mode & 0xf000;
      if (type && ![0x8000, 0x4000].includes(type) || !/^(project\.json|media\/|media\/[\w-]{1,100}\.(png|jpg|webp|mp4|mp3|wav))$/.test(name) || entries.has(name)) throw new InputError('工程 ZIP 包含重复文件、无效路径或链接文件。');
      const compressedSize = header.readUInt32LE(20), size = header.readUInt32LE(24), crc = header.readUInt32LE(16);
      if (name === 'media/' && (size || compressedSize) || method === 0 && size !== compressedSize || offset + 30 > directoryStart) throw new InputError('工程 ZIP 文件大小或目录不正确。');
      const local = await readExact(handle, offset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method) throw new InputError('工程 ZIP 文件头与索引不一致。');
      const localNameLength = local.readUInt16LE(26), localExtraLength = local.readUInt16LE(28), dataStart = offset + 30 + localNameLength + localExtraLength;
      if (localNameLength !== nameLength || dataStart + compressedSize > directoryStart || !(await readExact(handle, offset + 30, localNameLength)).equals(nameBytes)) throw new InputError('工程 ZIP 文件路径或范围不一致。');
      if (!(flags & 8) && (local.readUInt32LE(14) !== crc || local.readUInt32LE(18) !== compressedSize || local.readUInt32LE(22) !== size)) throw new InputError('工程 ZIP 文件校验信息不一致。');
      ranges.push([offset, dataStart + compressedSize]); total += size;
      if (total > PACKAGE_MAX_BYTES) throw new InputError('工程 ZIP 解压内容超过 1 GB。', 413);
      entries.set(name, { name, method, crc, size, compressedSize, dataStart }); cursor = next;
    }
    if (cursor !== directory.length) throw new InputError('工程 ZIP 索引包含无效内容。');
    ranges.sort((a, b) => a[0] - b[0]);
    for (let index = 1; index < ranges.length; index++) if (ranges[index][0] < ranges[index - 1][1]) throw new InputError('工程 ZIP 文件范围重叠。');
    entries.delete('media/');
    return entries;
  } finally { await handle.close(); }
}

export function entryStream(filename, entry) {
  const source = entry.compressedSize ? createReadStream(filename, { start: entry.dataStart, end: entry.dataStart + entry.compressedSize - 1 }) : Readable.from([]);
  let size = 0, crc = 0xffffffff;
  const check = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > entry.size) { callback(new InputError('工程 ZIP 解压文件超过清单大小。', 413)); return; }
      crc = updateCrc(crc, chunk); callback(null, chunk);
    },
    flush(callback) {
      callback(size !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc ? new InputError('工程 ZIP 文件不完整或校验失败。') : null);
    },
  });
  return { source, ...(entry.method === 8 ? { inflate: createInflateRaw() } : {}), check };
}
