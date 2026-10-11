import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoCatalogSync } from '../lib/video-catalog-sync.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const iso = milliseconds => new Date(milliseconds).toISOString();
const connection = { apiKey: 'private-test-key', baseUrl: 'https://video.example.test' };

test('固定注入的模型目录不读取连接、不加载平台、不启动定时器', async t => {
  let intervals = 0;
  t.mock.method(globalThis, 'setInterval', () => { intervals += 1; });
  const catalog = [{ name: 'injected-model' }];
  const sync = createVideoCatalogSync({ initialCatalog: catalog,
    readSettings: () => { throw new Error('should not read'); },
    load: () => { throw new Error('should not load'); },
  });
  sync.start();
  assert.deepEqual((await sync.refresh({ force: true })).catalog, catalog);
  assert.equal(sync.snapshot().catalogSyncedAt, null);
  assert.equal(intervals, 0);
  sync.close();
});

test('成功同步使用缓存，满一分钟或手动刷新才重新读取模型，状态不包含密钥', async () => {
  let time = 0;
  let reads = 0;
  let loads = 0;
  const sync = createVideoCatalogSync({ now: () => time,
    readSettings: async () => { reads += 1; return connection; },
    load: async settings => { assert.deepEqual(settings, connection); return [{ name: `model-${++loads}` }]; },
  });
  assert.equal((await sync.refresh()).catalog[0].name, 'model-1');
  assert.equal(sync.snapshot().catalogSyncedAt, iso(0));
  time = 59999;
  await sync.refresh();
  assert.equal(loads, 1);
  assert.equal(reads, 2);
  time = 60000;
  await sync.refresh();
  assert.equal(loads, 2);
  assert.equal(sync.snapshot().catalogCheckedAt, iso(time));
  time += 1;
  await sync.refresh({ force: true });
  assert.equal(loads, 3);
  assert.equal(sync.snapshot().catalogSyncedAt, iso(time));
  assert.equal(sync.snapshot().catalogSyncIntervalMs, 60000);
  assert.ok(!JSON.stringify(sync.snapshot()).includes(connection.apiKey));
  sync.close();
});

test('失去密钥立即清空旧目录，保存新密钥立即加载且无密钥状态给出提示', async () => {
  let settings = connection;
  let loads = 0;
  const sync = createVideoCatalogSync({ readSettings: async () => settings,
    load: async () => [{ name: `model-${++loads}` }], now: () => 10,
  });
  await sync.refresh();
  settings = { ...connection, apiKey: '' };
  const empty = await sync.refresh();
  assert.deepEqual(empty.catalog, []);
  assert.match(empty.catalogError, /保存视频 API Key/);
  assert.equal(empty.catalogSyncedAt, null);
  assert.equal(loads, 1);
  settings = { ...connection, apiKey: 'replacement-key' };
  assert.equal((await sync.refresh()).catalog[0].name, 'model-2');
  sync.close();
});

test('平台失败清空可提交目录、保留上次成功时间，并节流失败重试', async () => {
  let time = 100;
  let failure = false;
  let loads = 0;
  const sync = createVideoCatalogSync({ readSettings: async () => connection, now: () => time,
    load: async () => { loads += 1; if (failure) throw new Error(connection.apiKey); return [{ name: 'priced-model' }]; },
  });
  await sync.refresh();
  failure = true;
  time = 200;
  const failed = await sync.refresh({ force: true });
  assert.deepEqual(failed.catalog, []);
  assert.match(failed.catalogError, /读取失败/);
  assert.ok(!failed.catalogError.includes(connection.apiKey));
  assert.equal(failed.catalogSyncedAt, iso(100));
  assert.equal(failed.catalogCheckedAt, iso(200));
  time = 60199;
  await sync.refresh();
  assert.equal(loads, 2);
  time = 60200;
  await sync.refresh();
  assert.equal(loads, 3);
  sync.close();
});

test('相同连接的并发刷新只请求平台一次', async () => {
  const pending = deferred();
  let loads = 0;
  const sync = createVideoCatalogSync({ readSettings: async () => connection,
    load: () => { loads += 1; return pending.promise; },
  });
  const first = sync.refresh();
  const second = sync.refresh({ force: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(loads, 1);
  pending.resolve([{ name: 'shared-model' }]);
  assert.deepEqual((await first).catalog, (await second).catalog);
  sync.close();
});

test('连接地址或密钥改变即失效，旧请求晚到不能覆盖新连接结果', async () => {
  let settings = connection;
  const oldLoad = deferred();
  const newLoad = deferred();
  let loads = 0;
  const sync = createVideoCatalogSync({ readSettings: async () => settings,
    load: () => (++loads === 1 ? [{ name: 'old-cached' }] : loads === 2 ? oldLoad.promise : newLoad.promise),
  });
  await sync.refresh();
  const oldRefresh = sync.refresh({ force: true });
  await Promise.resolve();
  await Promise.resolve();
  settings = { ...connection, baseUrl: 'https://other-video.example.test' };
  const newRefresh = sync.refresh();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(sync.snapshot().catalog, []);
  assert.equal(sync.snapshot().catalogSyncedAt, null);
  newLoad.resolve([{ name: 'new-connection-model' }]);
  await newRefresh;
  oldLoad.resolve([{ name: 'wrong-old-model' }]);
  await oldRefresh;
  assert.equal(sync.snapshot().catalog[0].name, 'new-connection-model');
  sync.close();
});

test('异步读取连接返回顺序颠倒时，旧连接不会替换后来读取的连接', async () => {
  const oldRead = deferred();
  let reads = 0;
  const seen = [];
  const sync = createVideoCatalogSync({
    readSettings: () => ++reads === 1 ? oldRead.promise : Promise.resolve({ ...connection, apiKey: 'new-key' }),
    load: async settings => { seen.push(settings.apiKey); return [{ name: settings.apiKey === 'new-key' ? 'new-model' : 'old-model' }]; },
  });
  const oldRefresh = sync.refresh();
  await sync.refresh();
  oldRead.resolve(connection);
  await oldRefresh;
  assert.deepEqual(seen, ['new-key']);
  assert.equal(sync.snapshot().catalog[0].name, 'new-model');
  sync.close();
});

test('无法读取连接时清空目录并返回可读错误', async () => {
  let failure = false;
  const sync = createVideoCatalogSync({ readSettings: async () => {
    if (failure) throw new Error(connection.apiKey);
    return connection;
  }, load: async () => [{ name: 'current-model' }] });
  await sync.refresh();
  failure = true;
  const result = await sync.refresh();
  assert.deepEqual(result.catalog, []);
  assert.match(result.catalogError, /连接暂时无法读取/);
  assert.ok(!result.catalogError.includes(connection.apiKey));
  sync.close();
});

test('关闭同步器阻止未完成请求写入，并停止后续刷新', async () => {
  const pending = deferred();
  let reads = 0;
  const sync = createVideoCatalogSync({ readSettings: async () => { reads += 1; return connection; },
    load: () => pending.promise,
  });
  const refresh = sync.refresh();
  await Promise.resolve();
  await Promise.resolve();
  sync.close();
  const before = sync.snapshot();
  pending.resolve([{ name: 'late-model' }]);
  await refresh;
  assert.deepEqual(sync.snapshot(), before);
  await sync.refresh({ force: true });
  assert.equal(reads, 1);
});

test('后台定时器可重复启动且只创建一次，关闭会取消定时器', async t => {
  let callback;
  let intervals = 0;
  let unrefs = 0;
  let cancelled = null;
  let loads = 0;
  const handle = { unref: () => { unrefs += 1; } };
  t.mock.method(globalThis, 'setInterval', (next, delay) => {
    assert.equal(delay, 60000);
    callback = next;
    intervals += 1;
    return handle;
  });
  t.mock.method(globalThis, 'clearInterval', timer => { cancelled = timer; });
  const sync = createVideoCatalogSync({ readSettings: async () => connection,
    load: async () => [{ name: `model-${++loads}` }], now: () => 10,
  });
  await sync.refresh();
  assert.equal(sync.start(), sync);
  sync.start();
  assert.equal(intervals, 1);
  assert.equal(unrefs, 1);
  await callback();
  assert.equal(loads, 2);
  sync.close();
  assert.equal(cancelled, handle);
  sync.start();
  await callback();
  assert.equal(intervals, 1);
  assert.equal(loads, 2);
});

test('提交目录与加载它的私有连接成对返回，后续更换密钥不会改写提交快照', async () => {
  let settings = connection;
  const sync = createVideoCatalogSync({ readSettings: async () => settings,
    load: async value => [{ name: value.apiKey === connection.apiKey ? 'original-model' : 'replacement-model' }],
  });
  const submission = await sync.forSubmission();
  assert.deepEqual(submission.settings, connection);
  assert.equal(submission.catalog[0].name, 'original-model');
  settings = { ...connection, apiKey: 'replacement-key' };
  const replacement = await sync.forSubmission();
  assert.equal(replacement.catalog[0].name, 'replacement-model');
  assert.equal(replacement.settings.apiKey, 'replacement-key');
  assert.equal(submission.catalog[0].name, 'original-model');
  assert.equal(submission.settings.apiKey, connection.apiKey);
  assert.doesNotMatch(JSON.stringify(sync.snapshot()), /private-test-key|replacement-key/);
  sync.close();
});
