import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A small uncompressed ZIP writer avoids a server dependency and copies only source.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export async function blenderHelperPackage() {
  const sources = [
    ['tools/blender-helper.mjs', 'tools/blender-helper.mjs'], ['tools/blender-previs.py', 'tools/blender-previs.py'],
    ['tools/blender-helper/start.cmd', '启动幻帧blender助手.cmd'], ['tools/blender-helper/install.ps1', 'tools/blender-helper/install.ps1'],
    ['tools/blender-helper/setup.cmd', '安装助手.cmd'], ['tools/blender-helper/setup.ps1', 'tools/blender-helper/setup.ps1'],
    ['docs/Blender预演工作流.md', '使用说明.md'], ['package.json', 'package.json'], ['LICENSE', 'LICENSE'], ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ];
  for (const folder of ['lib', 'public']) {
    const entries = await readdir(path.join(root, folder), { withFileTypes: true });
    for (const entry of entries) if (entry.isFile() && (folder === 'lib' ? /\.mjs$/ : /\.js$/).test(entry.name)) sources.push([`${folder}/${entry.name}`, `${folder}/${entry.name}`]);
  }
  const bodies = [], central = []; let offset = 0;
  for (const [source, target] of sources) {
    const data = await readFile(path.join(root, source)), name = Buffer.from('幻帧blender助手/' + target, 'utf8'), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    bodies.push(local, name, data); central.push(entry, name); offset += local.length + name.length + data.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(sources.length, 8); end.writeUInt16LE(sources.length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, index, end]);
}
