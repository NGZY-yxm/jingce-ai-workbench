import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaThumbnails } from '../lib/media-thumbnails.mjs';
import { createStudio } from '../server.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const dimensions = bytes => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });

test('缩略图生成合并并缓存，源文件变化后重新生成且不超过 512 像素', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-thumbnails-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.media');
  await writeFile(source, Buffer.from('source-v1'));
  let calls = 0;
  const thumbnails = new MediaThumbnails(root, {
    windowsFallback: false,
    render: async (_source, destination) => { calls++; await writeFile(destination, png); },
  });

  const results = await Promise.all(Array.from({ length: 5 }, () => thumbnails.get(source, 'video')));
  assert.equal(calls, 1, '并发请求同一源文件只应转换一次');
  assert.ok(results.every(result => result?.filename === results[0]?.filename));
  assert.deepEqual(dimensions(await readFile(results[0].filename)), { width: 1, height: 1 });
  assert.ok(dimensions(await readFile(results[0].filename)).width <= 512);

  await writeFile(source, Buffer.from('source-v2-with-new-size'));
  const refreshed = await thumbnails.get(source, 'video');
  assert.equal(calls, 2, '源文件大小变化后应使旧缩略图失效');
  assert.notEqual(refreshed.filename, results[0].filename);
});

test('HTTP 缩略图路由优先本地文件，支持视频、导出、HEAD、Range 和失败占位图', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-thumbnail-http-'));
  const originalImage = Buffer.from('local-original-image');
  const originalVideo = Buffer.alloc(128); originalVideo.write('ftyp', 4, 'ascii');
  const originalExport = Buffer.alloc(96); originalExport.write('ftyp', 4, 'ascii');
  const renderCalls = [];
  const app = await createStudio({
    root,
    catalog: [],
    tools: { ready: false, message: '未安装合成工具' },
    thumbnails: {
      windowsFallback: false,
      render: async (source, destination) => {
        renderCalls.push(source);
        if (source.endsWith('broken.bin')) throw new Error('测试缩略图失败');
        await writeFile(destination, png);
      },
    },
  });
  const url = await app.start(0);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
  const project = await (await fetch(`${url}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token },
    body: JSON.stringify({ title: '缩略图路由测试' }),
  })).json();
  await writeFile(path.join(root, 'assets', 'thumb-image.png'), originalImage);
  await writeFile(path.join(root, 'assets', 'thumb-video.mp4'), originalVideo);
  await writeFile(path.join(root, 'assets', 'broken.bin'), Buffer.from('broken-original'));
  await writeFile(path.join(root, 'exports', 'thumb-export.mp4'), originalExport);
  await app.store.update(project.id, current => {
    current.assets.push(
      { id: 'thumb-image', kind: 'image', source: 'upload', name: '原图片.png', file: 'thumb-image.png', mime: 'image/png', size: originalImage.length },
      { id: 'thumb-video', kind: 'video', source: 'model', name: '原视频.mp4', file: 'thumb-video.mp4', mime: 'video/mp4', size: originalVideo.length },
      { id: 'broken', kind: 'image', source: 'upload', name: '损坏素材.bin', file: 'broken.bin', mime: 'application/octet-stream', size: 15 },
    );
    current.exports.push({ id: 'thumb-export', state: 'done', file: 'thumb-export.mp4', createdAt: new Date().toISOString() });
    return current;
  });

  const imageThumb = await fetch(`${url}/api/assets/thumb-image?thumbnail=1`);
  assert.equal(imageThumb.status, 200);
  assert.match(imageThumb.headers.get('content-type') || '', /^image\/png/);
  const imageThumbBytes = Buffer.from(await imageThumb.arrayBuffer());
  assert.deepEqual(dimensions(imageThumbBytes), { width: 1, height: 1 });
  assert.notDeepEqual(imageThumbBytes, originalImage);

  const videoThumb = await fetch(`${url}/api/assets/thumb-video?thumbnail=1`);
  assert.equal(videoThumb.status, 200);
  assert.match(videoThumb.headers.get('content-type') || '', /^image\/png/);
  assert.deepEqual(dimensions(Buffer.from(await videoThumb.arrayBuffer())), { width: 1, height: 1 });

  const head = await fetch(`${url}/api/assets/thumb-video?thumbnail=1`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), png.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const range = await fetch(`${url}/api/assets/thumb-video?thumbnail=1`, { headers: { Range: 'bytes=0-7' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-7/${png.length}`);
  assert.equal((await range.arrayBuffer()).byteLength, 8);

  const original = await fetch(`${url}/api/assets/thumb-video`);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), originalVideo);
  const download = await fetch(`${url}/api/assets/thumb-video?thumbnail=1&download=1`);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), originalVideo, 'download 参数优先返回原视频');
  assert.match(download.headers.get('content-disposition') || '', /attachment/);

  const exportThumb = await fetch(`${url}/api/exports/thumb-export?thumbnail=1`);
  assert.equal(exportThumb.status, 200);
  assert.match(exportThumb.headers.get('content-type') || '', /^image\/png/);
  assert.deepEqual(dimensions(Buffer.from(await exportThumb.arrayBuffer())), { width: 1, height: 1 });
  const failed = await fetch(`${url}/api/assets/broken?thumbnail=1`);
  assert.equal(failed.status, 200);
  assert.match(failed.headers.get('content-type') || '', /^image\/svg\+xml/);
  assert.match(await failed.text(), /缩略图暂不可用/);
  assert.equal(renderCalls.filter(source => source.endsWith('broken.bin')).length, 1);
});
