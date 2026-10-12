import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStudio } from '../server.mjs';
import { DEFAULT_CONNECTION, VIDEO_REQUEST_MODE, loadCatalog, checkConnection,
  buildVideoRequest } from '../lib/video-v3.mjs';
import { createVideoCatalogSync } from '../lib/video-catalog-sync.mjs';
import { videoModelRecords, inspectVideoModels, selectVideoCatalogModels,
  mergeVideoCatalogs, withVideoCatalogDiagnostics } from '../lib/video-model-discovery.mjs';

const currentIds = [
  'dola-seedance-2.0-903-720P\uFF08\u6B21\uFF09',
  'dola-seedance-2.5-30010-720P\uFF08\u6B21\uFF09',
  'minimax-h3-933-2K\uFF08\u6B21\uFF09',
  'seedance-2.0-933-720P\uFF08\u79D2\uFF09',
  'seedance-2.0-fast-933-720P\uFF08\u6B21\uFF09',
  'seedance-2.0-mini-903-720P\uFF08\u6B21\uFF09',
  'seedance-2.5-301010-1K\uFF08\u79D2\uFF09',
];
const futureId = 'seedance-3.0-fast-999-1080P\uFF08\u6B21\uFF09';
const unknownId = 'other-video-new';
const settings = { ...DEFAULT_CONNECTION, apiKey: 'catalog-test-secret' };
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });
const names = catalog => catalog.map(model => model.name);
const getCatalog = (records, metadata = {}) => loadCatalog(settings, async (url, options) => {
  assert.equal(options.method, undefined, 'Discovery must never submit a paid request');
  return reply(url.endsWith('/v1/models') ? { data: records } : metadata);
});

test('Discovery validates and deduplicates IDs without rewriting case or punctuation', () => {
  const records = videoModelRecords([
    { id: futureId, type: 'model' }, { id: futureId, owned_by: 'provider' },
    null, {}, { id: '' }, ' leading', 'trailing ', 'line\nbreak', 'x'.repeat(161), 3,
  ]);
  assert.deepEqual(records, [{ id: futureId, type: 'model', owned_by: 'provider' }]);
});

test('Current seven generic model records and future compatible families are discovered', async () => {
  const catalog = await getCatalog([...currentIds, futureId, 'dola-seedance-3.1-777-720P'].map(id => ({ id, type: 'model' })));
  assert.deepEqual(names(catalog), [...currentIds, futureId, 'dola-seedance-3.1-777-720P']);
  assert.equal(catalog.catalogDiagnostics.upstreamModelCount, 9);
  assert.equal(catalog.catalogDiagnostics.supportedVideoModelCount, 9);
  assert.equal(catalog.catalogWarning, '');
});

test('Explicit video types are discovered while non-video types and conflicting protocols are excluded', async () => {
  const records = [
    { id: 'typed-new', type: 'VIDEO' }, { id: futureId, type: 'image' },
    ...['text', 'audio', 'chat', 'embedding'].map(type => ({ id: 'seedance-9.0-' + type, type })),
    { id: 'seedance-8.0-other', requestMode: 'different-protocol' },
  ];
  const catalog = await getCatalog(records);
  assert.deepEqual(names(catalog), ['typed-new']);
  assert.deepEqual(catalog.catalogDiagnostics.unsupportedVideoModelIds, ['seedance-8.0-other']);
  assert.equal(catalog.catalogDiagnostics.ignoredModelCount, 5);
  assert.ok(catalog.catalogWarning.includes('seedance-8.0-other'));
});

test('Public metadata marks unknown candidates but cannot grant current-key visibility', async () => {
  const catalog = await getCatalog([{ id: unknownId }, { id: 'new-renderer' }, { id: 'gpt-text', type: 'text' }], {
    data: { groups: [{ models: [
      { name: 'new-renderer', pricing: { billing_mode: 'video' } },
      { name: futureId, pricing: { billing_mode: 'video' } },
    ] }] },
  });
  assert.deepEqual(names(catalog), []);
  assert.deepEqual(catalog.catalogDiagnostics.unsupportedVideoModelIds, [unknownId, 'new-renderer']);
  assert.ok(catalog.catalogWarning.includes(unknownId));
  assert.ok(catalog.catalogWarning.includes('new-renderer'));
  assert.ok(!catalog.catalogWarning.includes(futureId));
});

test('Failure to load optional pricing does not hide dynamic models or invent prices', async () => {
  const catalog = await loadCatalog(settings, async url => {
    if (url.endsWith('/v1/models')) return reply({ data: [{ id: futureId }] });
    throw new Error('Public metadata unavailable');
  });
  assert.deepEqual(names(catalog), [futureId]);
  assert.equal(catalog[0].pricingAvailable, false);
  assert.ok(catalog[0].tiers.every(tier => tier.price === null));
});

test('Dynamic model request uses its authorized full ID and validates the saved parameter tiers', async () => {
  const [model] = await getCatalog([{ id: futureId }]);
  const job = { model: model.name, requestMode: VIDEO_REQUEST_MODE, prompt: 'A static test scene',
    duration: 5, resolution: '720p', ratio: '16:9', providerTiers: model.tiers };
  assert.equal(buildVideoRequest(job).model, futureId);
  assert.throws(() => buildVideoRequest({ ...job, model: ' invalid' }));
  assert.throws(() => buildVideoRequest({ ...job, duration: 6,
    providerTiers: [{ duration: 5, resolution: '720p' }] }));
});

test('Catalog diagnostics, connection results and provider errors never echo credentials', async () => {
  const secret = 'private/key+token';
  const connection = { ...settings, apiKey: secret };
  const records = [{ id: futureId, extra: secret }, { id: unknownId },
    { id: 'new-video-' + secret }, { id: 'new-video-' + encodeURIComponent(secret) }];
  const fetcher = async url => reply(url.endsWith('/v1/models') ? { data: records } : {});
  const catalog = await loadCatalog(connection, fetcher);
  const check = await checkConnection(connection, fetcher);
  const visible = JSON.stringify({ catalog, diagnostics: catalog.catalogDiagnostics, warning: catalog.catalogWarning, check });
  assert.ok(!visible.includes(secret));
  assert.ok(!visible.includes(encodeURIComponent(secret)));
  assert.equal(check.videoModelCount, 1);
  await assert.rejects(loadCatalog(connection, async () => reply({
    error: { code: secret, message: encodeURIComponent(secret) },
  }, 401)), error => !error.message.includes(secret) && !error.message.includes(encodeURIComponent(secret)));
});

test('Model binding preserves diagnostics and merged catalogs do not flag models bound elsewhere', async () => {
  const source = await getCatalog([{ id: currentIds[0] }, { id: futureId }, { id: unknownId }]);
  const first = selectVideoCatalogModels(source, [currentIds[0]]);
  const second = selectVideoCatalogModels(source, [futureId]);
  assert.equal(first.catalogDiagnostics.bindingExcludedModelCount, 1);
  assert.deepEqual(first.catalogDiagnostics.bindingExcludedModelIds, [futureId]);
  assert.ok(first.catalogWarning.includes(unknownId));
  const merged = mergeVideoCatalogs([first, second]);
  assert.deepEqual(names(merged), [currentIds[0], futureId]);
  assert.deepEqual(merged.catalogDiagnostics.unsupportedVideoModelIds, [unknownId]);
  assert.equal(merged.catalogDiagnostics.bindingExcludedModelCount, 0);
  assert.deepEqual(merged.catalogDiagnostics.bindingExcludedModelIds, []);
});

test('Warnings survive sync snapshots, notify once and clear on key removal', async () => {
  let connection = settings;
  const catalog = await getCatalog([{ id: futureId }, { id: unknownId }]);
  const warnings = [];
  const sync = createVideoCatalogSync({ readSettings: async () => connection, load: async () => catalog,
    onWarning: message => warnings.push(message) });
  try {
    const snapshot = await sync.refresh();
    assert.deepEqual(snapshot.catalogDiagnostics, catalog.catalogDiagnostics);
    assert.equal(snapshot.catalogWarning, catalog.catalogWarning);
    await sync.refresh({ force: true });
    assert.deepEqual(warnings, [catalog.catalogWarning]);
    connection = { ...settings, apiKey: '' };
    const cleared = await sync.refresh();
    assert.equal(cleared.catalogWarning, '');
    assert.equal(cleared.catalogDiagnostics, null);
    assert.deepEqual(cleared.catalog, []);
    assert.ok(!JSON.stringify(snapshot).includes(settings.apiKey));
  } finally { sync.close(); }
});

test('Routing changes refresh immediately even when the primary key and cache age are unchanged', async () => {
  let connection = { ...settings, routingVersion: 'first-bindings' };
  let loads = 0;
  const sync = createVideoCatalogSync({ now: () => 0, readSettings: async () => connection,
    load: async () => [{ name: 'routing-' + ++loads }] });
  try {
    await sync.refresh();
    connection = { ...connection, routingVersion: 'new-bindings' };
    const snapshot = await sync.refresh();
    assert.deepEqual(names(snapshot.catalog), ['routing-2']);
    assert.ok(!JSON.stringify(snapshot).includes('new-bindings'));
  } finally { sync.close(); }
});

test('Warning observers cannot break a valid catalog read', async () => {
  const catalog = withVideoCatalogDiagnostics([], inspectVideoModels([{ id: unknownId }]).diagnostics);
  const sync = createVideoCatalogSync({ readSettings: async () => settings, load: async () => catalog,
    onWarning: () => { throw new Error('Observer failed'); } });
  try { assert.equal((await sync.refresh()).catalogError, ''); }
  finally { sync.close(); }
});

async function studio(t, videoFetcher) {
  const root = await mkdtemp(path.join(tmpdir(), 'jingce-model-discovery-'));
  const app = await createStudio({ root, imageCatalog: [], textCatalog: [], tools: { ready: false }, videoFetcher });
  const url = await app.start(0);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await (await fetch(url + '/api/bootstrap')).json();
  const send = async (route, method = 'GET', body) => {
    const response = await fetch(url + route, { method, headers: {
      'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token,
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, 200, route);
    return response.json();
  };
  return { app, send };
}

test('HTTP bootstrap and refresh follow upstream additions, renames and removals without code changes', async t => {
  let ids = [currentIds[0]];
  const { app, send } = await studio(t, async (url, options) => {
    assert.equal(options.method, undefined);
    return reply(url.endsWith('/v1/models') ? { data: ids.map(id => ({ id, type: 'model' })) } : {});
  });
  await app.store.saveSettings(settings);
  assert.deepEqual(names((await send('/api/bootstrap')).catalog), ids);
  ids = [futureId, unknownId];
  assert.deepEqual(names(await send('/api/models/refresh', 'POST', {})), [futureId]);
  const snapshot = await send('/api/models');
  assert.deepEqual(names(snapshot.catalog), [futureId]);
  assert.equal(snapshot.catalogDiagnostics.upstreamModelCount, 2);
  assert.ok(snapshot.catalogWarning.includes(unknownId));
  const detailed = await send('/api/existing-connections/video/models?diagnostics=1');
  assert.equal(detailed.catalogWarning, snapshot.catalogWarning);
  assert.deepEqual(names(detailed.catalog), [futureId]);
  assert.deepEqual(names(await send('/api/existing-connections/video/models')), [futureId]);
  ids = [];
  await send('/api/models/refresh', 'POST', {});
  const removed = await send('/api/bootstrap');
  assert.deepEqual(removed.catalog, []);
  assert.equal(removed.catalogWarning, '');
  assert.equal(removed.catalogDiagnostics.upstreamModelCount, 0);
});

test('Multiple keys preserve routing and reveal new unbound models until explicitly bound', async t => {
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  const keyA = 'bound-catalog-secret-A', keyB = 'bound-catalog-secret-B';
  const { send } = await studio(t, async (url, options) => {
    assert.equal(options.method, undefined);
    if (!url.endsWith('/v1/models')) return reply({});
    const ids = options.headers.Authorization === 'Bearer ' + keyA
      ? [currentIds[0], futureId, unknownId] : [currentIds[1], futureId];
    return reply({ data: ids.map(id => ({ id, type: 'model' })) });
  });
  const a = await send('/api/connections', 'PUT', { name: 'Video A', kind: 'video',
    apiKey: keyA, models: [currentIds[0]] });
  const b = await send('/api/connections', 'PUT', { name: 'Video B', kind: 'video',
    apiKey: keyB, models: [currentIds[1]] });
  const before = await send('/api/models');
  assert.deepEqual(names(before.catalog), [currentIds[0], currentIds[1]]);
  assert.equal(before.catalogDiagnostics.bindingExcludedModelCount, 1);
  assert.deepEqual(before.catalogDiagnostics.bindingExcludedModelIds, [futureId]);
  const details = await send('/api/connections/' + a.id + '/models?diagnostics=1');
  assert.deepEqual(names(details.catalog), [currentIds[0], futureId]);
  assert.ok(details.catalogWarning.includes(unknownId));
  await send('/api/connections', 'PUT', { id: b.id, name: 'Video B', kind: 'video',
    models: [currentIds[1], futureId] });
  const after = await send('/api/models');
  assert.deepEqual(names(after.catalog), [currentIds[0], currentIds[1], futureId]);
  assert.equal(after.catalogDiagnostics.bindingExcludedModelCount, 0);
  assert.ok(after.catalogWarning.includes(unknownId));
  const publicOutput = JSON.stringify({ before, after, details, warnings });
  assert.ok(!publicOutput.includes(keyA));
  assert.ok(!publicOutput.includes(keyB));
});

test('Connection center reports model-read failures instead of a successful refresh', async t => {
  const { app, send } = await studio(t, async () => reply({ error: { message: settings.apiKey } }, 401));
  await app.store.saveSettings(settings);
  const refreshed = await send('/api/connections/refresh', 'POST', {});
  const snapshot = await send('/api/models');
  assert.ok(snapshot.catalogError);
  assert.ok(refreshed.message.includes(snapshot.catalogError));
  assert.equal(snapshot.catalogDiagnostics, null);
  assert.ok(!JSON.stringify({ refreshed, snapshot }).includes(settings.apiKey));
});
