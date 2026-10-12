import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createStudio } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { createProject } from '../lib/workflow.mjs';
import { intersectsRect } from '../public/canvas-geometry.js';

const require = createRequire(import.meta.url);
const playwrightPath = process.argv[2] || 'playwright';
const { chromium } = require(playwrightPath);
const sharp = require(path.join(path.dirname(require.resolve(playwrightPath)), '..', 'sharp'));
const output = path.resolve(process.argv[3] || 'outputs/gallery-multiselect-qa');
const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-gallery-multiselect-'));
const checks = [], pageErrors = [], generationRequests = [], assetRequests = [];
const contents = new Map();
let app, browser, page, paidCalls = 0;
const rejectGeneration = async () => { paidCalls++; throw new Error('Generation disabled for verification.'); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.argv[4] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true });
  const png = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#529aca' } })
    .composite([{ input: await sharp({ create: { width: 180, height: 220, channels: 3, background: '#f1c15f' } }).png().toBuffer(), left: 80, top: 70 }])
    .png().toBuffer();
  const video = process.env.JINGCE_QA_VIDEO_PATH ? await readFile(process.env.JINGCE_QA_VIDEO_PATH) : Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d'); let frame = 0;
    const paint = () => {
      ctx.fillStyle = '#207b65'; ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#f2c14e'; ctx.fillRect(70 + frame++ * 8, 105, 180, 150);
    };
    paint();
    const stream = canvas.captureStream(12), chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/mp4;codecs=avc1.42001E' });
    recorder.ondataavailable = event => chunks.push(event.data);
    const result = new Promise(resolve => recorder.onstop = async () => resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))));
    recorder.start(100); const timer = setInterval(paint, 80);
    await new Promise(resolve => setTimeout(resolve, 900));
    recorder.stop(); clearInterval(timer);
    const bytes = await result; stream.getTracks().forEach(track => track.stop()); return bytes;
  }));
  assert.ok(video.length > 1000);
  const store = new Store(root); await store.init();
  const makeAsset = async (id, kind = 'image', source = 'model') => {
    const data = kind === 'video' ? video : png;
    const file = id + (kind === 'video' ? '.mp4' : '.png');
    await writeFile(path.join(root, 'assets', file), data); contents.set(id, data);
    return { id, kind, source, name: kind === 'image' ? 'reference.png' : 'movie.mp4', file,
      mime: kind === 'image' ? 'image/png' : 'video/mp4', size: data.length, createdAt: '2026-10-12T02:00:00Z' };
  };
  const first = createProject({ title: 'Brand campaign' }); first.id = 'batch-project-a';
  const second = createProject({ title: 'Film references' }); second.id = 'batch-project-b';
  first.assets = [await makeAsset('a-upload', 'image', 'upload'), await makeAsset('a-image'), await makeAsset('a-video', 'video')];
  second.assets = [await makeAsset('b-image'), await makeAsset('b-video', 'video')];
  const placeholder = { id: 'awaiting-relink', kind: 'image', label: 'Awaiting relink', status: 'pending', note: '',
    x: 0, y: 0, width: 320, height: 260, assetId: '', assetName: 'reference.png', sceneId: '' };
  first.graph.nodes = [placeholder];
  await store.mutate(state => { state.projects = [first, second]; });
  app = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false },
    integrations: { submit: rejectGeneration }, imageIntegrations: { submitImage: rejectGeneration } });
  const url = await app.start(0);
  await page.addInitScript(id => localStorage.setItem('jingce-active-project', id), first.id);
  await page.route('**/app.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()) + '\nglobalThis.batchQa = {state, refreshProjectList, isBusy: () => batchBusy};' });
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/projects\/[^/]+\/(?:jobs|image-jobs|batches|image-batches)(?:\?|$)/.test(request.url())) generationRequests.push(request.url());
    if (['DELETE', 'POST'].includes(request.method()) && /\/assets\//.test(request.url())) assetRequests.push({ method: request.method(), url: request.url() });
  });
  await page.goto(url);
  await page.waitForFunction(id => globalThis.batchQa?.state.saved?.id === id, first.id);
  const waitIdle = () => page.waitForFunction(() => !batchQa.isBusy());
  const choose = async (view, ids) => {
    await page.locator(`#${view}-tab`).click();
    for (const id of ids) await page.locator(`[data-select-${view === 'assets' ? 'asset' : 'result'}="${id}"]`).check();
  };
  const verifyDownload = async (view, ids) => {
    const downloadReady = page.waitForEvent('download');
    await page.locator(`#batch-download-${view}`).click();
    const download = await downloadReady;
    assert.equal(await download.failure(), null);
    assert.match(download.suggestedFilename(), new RegExp(`${ids.length}.*\\.zip$`));
    const bytes = await readFile(await download.path());
    const files = await page.evaluate(async data => {
      const archive = await JSZip.loadAsync(Uint8Array.from(data));
      return Promise.all(Object.values(archive.files).filter(file => !file.dir).map(async file => ({
        name: file.name, bytes: Array.from(await file.async('uint8array')),
      })));
    }, Array.from(bytes));
    assert.equal(files.length, ids.length);
    assert.equal(new Set(files.map(file => file.name)).size, ids.length);
    assert.deepEqual(files.map(file => digest(Buffer.from(file.bytes))).sort(), ids.map(id => digest(contents.get(id))).sort());
    assert.deepEqual(files.map(file => file.name).sort(), ids.length === 3 ? ['movie.mp4', 'reference (2).png', 'reference.png'] : ['reference (2).png', 'reference.png']);
    await waitIdle();
    await download.saveAs(path.join(output, `${view}-download.zip`));
  };
  const assertLayout = async () => {
    const issues = await page.evaluate(() => {
      const problems = [], visible = node => node.getClientRects().length > 0;
      if (document.documentElement.scrollWidth > innerWidth + 1) problems.push('horizontal overflow');
      for (const toolbar of document.querySelectorAll('.selection-toolbar')) {
        if (!visible(toolbar)) continue;
        const bounds = toolbar.getBoundingClientRect();
        const controls = [...toolbar.children].filter(visible).map(node => ({ node, bounds: node.getBoundingClientRect() }));
        for (const { node, bounds: box } of controls) {
          if (box.left < bounds.left - 1 || box.right > bounds.right + 1) problems.push('toolbar control outside band');
          if (node.scrollWidth > node.clientWidth + 1) problems.push('toolbar text clipped');
        }
        for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
          const a = controls[i].bounds, b = controls[j].bounds;
          if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) problems.push('toolbar controls overlap');
        }
      }
      for (const label of document.querySelectorAll('.asset-select,.result-select')) {
        if (!visible(label)) continue;
        const box = label.getBoundingClientRect(), parent = label.parentElement.getBoundingClientRect();
        if (box.left < parent.left || box.right > parent.right || box.top < parent.top || box.bottom > parent.bottom) problems.push('checkbox outside card');
      }
      return problems;
    });
    assert.deepEqual(issues, []);
  };

  await page.locator('#images-tab').click(); await page.locator('#image-page-prompt').fill('Preserve this image draft.');
  await page.locator('#text-tab').click(); await page.locator('#text-chat-input').fill('Preserve this chat draft.');
  await choose('assets', ['a-image', 'b-image', 'b-video']);
  assert.equal(await page.locator('#asset-selection-count').textContent(), '\u5df2\u9009 3 \u4e2a\u7d20\u6750');
  assert.equal(await page.locator('#preview-dialog').evaluate(dialog => dialog.open), false);
  await verifyDownload('assets', ['a-image', 'b-image', 'b-video']);
  await choose('results', ['a-image', 'b-image']);
  assert.equal(await page.evaluate(() => batchQa.state.assetSelection.size), 3);
  await verifyDownload('results', ['a-image', 'b-image']);
  checks.push('both galleries download one ZIP with complete original image/video bytes and safe duplicate names; selection stays independent');

  for (const width of [1920, 1440, 375, 320]) {
    await page.setViewportSize({ width, height: width < 700 ? 812 : 1000 });
    for (const view of ['assets', 'results']) {
      await page.locator(`#${view}-tab`).click(); await assertLayout();
      await page.screenshot({ path: path.join(output, `${view}-selected-${width}.png`), fullPage: true });
    }
  }
  await page.locator('#theme-select').selectOption('night'); await assertLayout();
  await page.screenshot({ path: path.join(output, 'results-selected-night-320.png'), fullPage: true });
  await page.locator('#theme-select').selectOption('day');
  await page.setViewportSize({ width: 1440, height: 1000 });
  checks.push('selected toolbar controls and checkboxes fit without overlap at 1920, 1440, 375 and 320 pixels, including night theme');

  await page.locator('#assets-tab').click();
  const requestsBeforeCancel = assetRequests.length;
  page.once('dialog', dialog => dialog.dismiss()); await page.locator('#batch-delete-assets').click();
  assert.equal(assetRequests.length, requestsBeforeCancel);
  assert.equal(await page.locator('#asset-list input:checked').count(), 3);
  let failDelete = true;
  await page.route('**/api/projects/batch-project-b/assets/b-image', async route => {
    if (route.request().method() === 'DELETE' && failDelete) {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary fixture conflict' }) });
    } else await route.continue();
  });
  page.once('dialog', dialog => dialog.accept()); await page.locator('#batch-delete-assets').click(); await waitIdle();
  assert.ok(app.store.get(first.id).assets.find(asset => asset.id === 'a-image').deletedAt);
  assert.ok(app.store.get(second.id).assets.find(asset => asset.id === 'b-video').deletedAt);
  assert.ok(!app.store.get(second.id).assets.find(asset => asset.id === 'b-image').deletedAt);
  assert.deepEqual(await page.evaluate(() => [...batchQa.state.assetSelection]), ['b-image']);
  await page.screenshot({ path: path.join(output, 'delete-partial-failure.png'), fullPage: true });
  failDelete = false;
  page.once('dialog', dialog => dialog.accept()); await page.locator('#batch-delete-assets').click(); await waitIdle();
  assert.equal(await page.evaluate(() => batchQa.state.assetSelection.size), 0);
  await page.locator('#toggle-deleted-assets').click(); await page.locator('#select-all-assets').click();
  assert.equal(await page.locator('#asset-list input:checked').count(), 3);
  await page.locator('#batch-restore-assets').click(); await waitIdle();
  assert.equal(await page.evaluate(() => batchQa.state.showDeletedAssets), false);
  assert.ok(app.store.get(first.id).assets.every(asset => !asset.deletedAt));
  assert.ok(app.store.get(second.id).assets.every(asset => !asset.deletedAt));
  checks.push('cancelled deletion sends no mutation; partial deletion preserves only the failure for retry; batch restoration saves each owning project');

  await choose('assets', ['a-image', 'a-video', 'b-image', 'b-video']);
  await page.locator('#batch-place-assets').click(); await waitIdle();
  assert.equal(await page.evaluate(() => batchQa.state.project.id), first.id);
  assert.equal(await page.evaluate(() => batchQa.state.assetSelection.size), 0);
  assert.equal(await page.locator('#image-page-prompt').inputValue(), 'Preserve this image draft.');
  assert.equal(await page.locator('#text-chat-input').inputValue(), 'Preserve this chat draft.');
  assert.deepEqual(app.store.get(first.id).graph.nodes.find(node => node.id === placeholder.id), placeholder);
  for (const owner of [first, second]) {
    const nodes = app.store.get(owner.id).graph.nodes;
    const expected = owner.id === first.id ? ['a-image', 'a-video'] : ['b-image', 'b-video'];
    assert.deepEqual(nodes.filter(node => node.assetId).map(node => node.assetId).sort(), expected);
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) assert.equal(intersectsRect(nodes[i], nodes[j]), false);
  }
  await choose('results', ['a-image', 'b-image']);
  await page.locator('#batch-place-results').click(); await waitIdle();
  assert.equal(app.store.get(first.id).graph.nodes.filter(node => node.assetId === 'a-image').length, 1);
  assert.equal(app.store.get(second.id).graph.nodes.filter(node => node.assetId === 'b-image').length, 1);
  checks.push('batch placement keeps active project and drafts, preserves relink placeholders, avoids overlapping nodes and skips existing canvas assets');

  await choose('results', ['a-image', 'b-image']);
  await page.locator('#result-filter').selectOption('video');
  assert.equal(await page.locator('#result-list input:checked').count(), 0);
  await page.locator('#select-all-results').click();
  assert.equal(await page.locator('#result-list input:checked').count(), 2);
  page.once('dialog', dialog => dialog.accept()); await page.locator('#batch-delete-results').click(); await waitIdle();
  assert.ok(app.store.get(first.id).assets.find(asset => asset.id === 'a-video').deletedAt);
  assert.ok(app.store.get(second.id).assets.find(asset => asset.id === 'b-video').deletedAt);
  await page.locator('#assets-tab').click(); await page.locator('#toggle-deleted-assets').click();
  await page.locator('#select-all-assets').click(); await page.locator('#batch-restore-assets').click(); await waitIdle();
  await page.reload();
  await page.waitForFunction(id => globalThis.batchQa?.state.saved?.id === id, first.id);
  await page.locator('#assets-tab').click();
  assert.equal(await page.locator('#asset-list .asset-card').count(), 5);
  assert.equal(await page.locator('#asset-list input:checked').count(), 0);
  checks.push('result filters prune hidden selections; result bulk deletion and asset restoration persist after reload');

  assert.equal(paidCalls, 0); assert.deepEqual(generationRequests, []); assert.deepEqual(pageErrors, []);
  const result = { passed: true, paidCalls, generationRequests, pageErrors, checks, output };
  await writeFile(path.join(output, 'browser-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ pageErrors, generationRequests, checks }));
  throw error;
} finally {
  await browser?.close(); await app?.close();
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('jingce-gallery-multiselect-')) throw new Error('Unexpected test data path.');
  await rm(root, { recursive: true, force: true });
}
