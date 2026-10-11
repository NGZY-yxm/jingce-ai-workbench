import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { r2Request, r2SignedUrl } from '../lib/r2.mjs';
import { CosStorage, publicStorageSettings, storageConfigForTests, validateStorageConfig } from '../lib/storage.mjs';
import { Store } from '../lib/store.mjs';

const config = storageConfigForTests({ provider: 'r2', bucket: 'test-bucket',
  endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  secretId: 'test-access', secretKey: 'test-secret' });

test('R2 signing matches AWS botocore header and presigned GET reference', () => {
  const signed = r2Request(config, 'PUT', 'jingce/space 中.png',
    { 'Content-Length': '3', 'Content-Type': 'image/png', 'Content-MD5': 'kAFQmDzST7DWlj99KOF/cg==' }, 1700000000);
  assert.match(signed.headers.Authorization, /Signature=65e3611e7eb2221355a7809b8b7474cba48a64bcb9c368c1200aeac0b91a6b85$/);
  const url = new URL(r2SignedUrl(config, 'jingce/space 中.png', 1700000000));
  assert.equal(url.searchParams.get('X-Amz-Signature'), 'f958e26bb8a82146a8773302d65f73bdc576d2cd6591f75be90da3b9f1c29a11');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '259200');
  assert.equal(url.pathname, '/test-bucket/jingce/space%20%E4%B8%AD.png');
});

test('R2 config rejects arbitrary endpoints and never exposes secret credentials', () => {
  assert.doesNotThrow(() => validateStorageConfig(config));
  assert.throws(() => validateStorageConfig({ ...config, endpoint: 'https://localhost' }), /Endpoint/);
  assert.equal(publicStorageSettings(config).ready, true);
  assert.equal(publicStorageSettings({ ...config, endpoint: '' }).ready, false);
  assert.equal(JSON.stringify(publicStorageSettings(config)).includes('test-secret'), false);
  assert.equal('secretId' in publicStorageSettings(config), false);
});

test('R2 selected asset concurrent uploads share one HEAD and PUT and retain content', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-r2-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root); await store.init();
  const asset = { id: 'a1', kind: 'image', file: 'a1.png', mime: 'image/png' };
  const bytes = Buffer.from('test-media-bytes');
  await writeFile(path.join(root, 'assets', asset.file), bytes);
  const objects = new Map(), calls = [];
  const requestImpl = (url, options, callback) => {
    const req = new PassThrough(), chunks = [], key = new URL(url).pathname;
    calls.push(options.method);
    assert.match(options.headers.Authorization, /^AWS4-HMAC-SHA256 /);
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const response = Readable.from([]); response.headers = {};
      if (options.method === 'HEAD') {
        response.statusCode = objects.has(key) ? 200 : 404;
        if (objects.has(key)) response.headers['content-length'] = objects.get(key).length;
      } else { objects.set(key, Buffer.concat(chunks)); response.statusCode = 200; }
      callback(response);
    });
    return req;
  };
  const storage = new CosStorage(root, store, { requestImpl,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }], now: () => 1700000000 });
  await storage.saveSettings(config);
  const [one, two] = await Promise.all([storage.ensureUploaded(asset), storage.ensureUploaded(asset)]);
  assert.equal(one, two); assert.deepEqual(calls, ['HEAD', 'PUT']);
  assert.deepEqual([...objects.values()][0], bytes);
  await storage.ensureUploaded(asset); assert.deepEqual(calls, ['HEAD', 'PUT', 'HEAD']);
  await storage.saveSettings({ secretId: '', secretKey: '' });
  assert.equal((await storage.settings()).secretKey, 'test-secret');
});
