import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { Store } from '../lib/store.mjs';
import { CosStorage, cosAuthorization, publicStorageSettings, storageConfigForTests, validateStorageConfig } from '../lib/storage.mjs';
import { buildVideoRequest, VIDEO_REQUEST_MODE } from '../lib/providers.mjs';

test('COS 配置脱敏、地域桶名校验和固定时间签名', () => {
  const config = storageConfigForTests();
  const publicConfig = publicStorageSettings(config);
  assert.deepEqual(publicConfig, {
    bucket: 'jingce-example-1250000000', region: 'ap-guangzhou', prefix: 'jingce', enabled: true,
    expiresHours: 72, hasCredentials: true, ready: true,
    message: '只在点击生成时上传选中的图片、视频和音频参考。',
  });
  assert.equal('secretId' in publicConfig, false);
  assert.equal('secretKey' in publicConfig, false);
  assert.doesNotThrow(() => validateStorageConfig(config));
  assert.throws(() => validateStorageConfig({ ...config, bucket: 'jingce-assets' }), /存储桶名称格式/);
  assert.throws(() => validateStorageConfig({ ...config, region: 'COS广州' }), /地域格式/);
  const input = { secretId: 'AKIDEXAMPLE', secretKey: 'secret-key', method: 'PUT', pathname: '/jingce/a%20b.png',
    headers: { Host: 'jingce-example-1250000000.cos.ap-guangzhou.myqcloud.com', 'Content-Type': 'image/png', 'Content-Length': '3' },
    query: { uploadId: 'a b' }, now: 1700000000, expires: 900 };
  const first = cosAuthorization(input);
  assert.equal(first, cosAuthorization(input));
  assert.match(first, /q-sign-algorithm=sha1/);
  assert.match(first, /q-sign-time=1699999999;1700000899/);
  assert.match(first, /q-header-list=content-length;content-type;host/);
  assert.match(first, /q-url-param-list=uploadid/);
  assert.doesNotMatch(first, /secret-key/);
});

test('COS 同一素材的并发上传共享请求，随后命中对象大小检查', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-storage-'));
  const store = new Store(root); await store.init();
  const asset = { id: 'asset-1', kind: 'image', file: 'asset-1.png', mime: 'image/png' };
  await writeFile(path.join(root, 'assets', asset.file), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
  const objects = new Map(), calls = [];
  const requestImpl = (url, options, callback) => {
    const request = new PassThrough();
    const pathname = new URL(url).pathname.slice(1);
    calls.push({ method: options.method, pathname });
    process.nextTick(() => {
      const response = Readable.from([]);
      response.headers = {};
      if (options.method === 'HEAD') {
        response.statusCode = objects.has(pathname) ? 200 : 404;
        if (objects.has(pathname)) response.headers['content-length'] = String(objects.get(pathname));
      } else if (options.method === 'PUT') {
        response.statusCode = 200; objects.set(pathname, Number(options.headers['Content-Length']));
      } else if (options.method === 'DELETE') {
        response.statusCode = 204; objects.delete(pathname);
      } else response.statusCode = 200;
      callback(response);
    });
    return request;
  };
  const storage = new CosStorage(root, store, { requestImpl, lookup: async () => [{ address: '93.184.216.34', family: 4 }], now: () => 1700000000 });
  await storage.saveSettings(storageConfigForTests());
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const [first, second] = await Promise.all([storage.ensureUploaded(asset), storage.ensureUploaded(asset)]);
  assert.equal(first, second);
  assert.equal(calls.filter(call => call.method === 'HEAD').length, 1);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
  assert.match(first, /^https:\/\/jingce-example-1250000000\.cos\.ap-guangzhou\.myqcloud\.com\/jingce\/assets\/asset-1\//);
  await storage.ensureUploaded(asset);
  assert.equal(calls.filter(call => call.method === 'HEAD').length, 2);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
});

for (const [extension, mime, bytes] of [
  ['.mp3', 'audio/mpeg', Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00original-mp3')],
  ['.wav', 'audio/wav', Buffer.from('RIFF\x18\x00\x00\x00WAVEfmt original-wav')],
]) {
  test(`COS ${extension} 音频原文件上传、签名复用及新版 content 提交`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-audio-storage-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new Store(root); await store.init();
    const asset = { id: 'voice', kind: 'audio', file: 'voice' + extension, mime, name: '音色参考' + extension };
    await writeFile(path.join(root, 'assets', asset.file), bytes);
    store.state.projects.push({ id: 'audio-project', assets: [asset] });
    const objects = new Map(), calls = [];
    const requestImpl = (url, options, callback) => {
      const request = new PassThrough(), chunks = [], key = new URL(url).pathname.slice(1);
      calls.push({ method: options.method, key, headers: options.headers });
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        const response = Readable.from([]); response.headers = {};
        if (options.method === 'HEAD') {
          response.statusCode = objects.has(key) ? 200 : 404;
          if (objects.has(key)) response.headers['content-length'] = String(objects.get(key).length);
        } else {
          assert.equal(options.method, 'PUT'); objects.set(key, Buffer.concat(chunks)); response.statusCode = 200;
        }
        callback(response);
      });
      return request;
    };
    const storage = new CosStorage(root, store, { requestImpl,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }], now: () => 1700000000 });
    await storage.saveSettings(storageConfigForTests({ prefix: 'friends/audio' }));
    const original = { assetId: asset.id, kind: 'audio', name: asset.name, role: 'reference_audio', refId: 'ref-voice', note: '保持音色' };
    const job = { projectId: 'audio-project', references: [original], requestMode: VIDEO_REQUEST_MODE,
      model: 'seedance-2.0-fast-933-720P（次）', duration: 5, resolution: '720p', ratio: '16:9', prompt: '参考@音频1。' };
    const prepared = await storage.prepareReferences(job);
    assert.deepEqual(job.references, [original]); assert.equal(original.publicUrl, undefined);
    const { publicUrl, ...metadata } = prepared[0]; assert.deepEqual(metadata, original);
    const put = calls.find(call => call.method === 'PUT');
    assert.ok(put.key.startsWith('friends/audio/assets/voice/')); assert.ok(put.key.endsWith(extension));
    assert.equal(put.headers['Content-Type'], mime);
    assert.equal(put.headers['Content-Length'], String(bytes.length));
    assert.equal(put.headers['Content-MD5'], createHash('md5').update(bytes).digest('base64'));
    assert.deepEqual(objects.get(put.key), bytes);
    assert.match(put.headers.Authorization, /q-header-list=content-length;content-md5;content-type;host/);
    const url = new URL(publicUrl); assert.equal(url.protocol, 'https:');
    assert.equal(url.pathname, '/' + put.key);
    assert.equal(url.searchParams.get('q-sign-time'), '1699999999;1700259199');
    assert.doesNotMatch(publicUrl, /test-secret/);
    const again = await storage.prepareReferences(job); assert.deepEqual(again, prepared);
    assert.deepEqual(calls.map(call => call.method), ['HEAD', 'PUT', 'HEAD']);
    const body = buildVideoRequest({ ...job, references: prepared });
    assert.deepEqual(body.content[1], { type: 'audio_url', audio_url: { url: publicUrl }, role: 'reference_audio', name: '音频1' });
    assert.match(body.content[0].text, /@音频1/);
  });
}
