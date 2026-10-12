import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = path.resolve(process.argv[5] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const { createStudio } = await import(pathToFileURL(path.join(workspace, 'server.mjs')));
const { Store } = await import(pathToFileURL(path.join(workspace, 'lib/store.mjs')));
const { createProject, touch } = await import(pathToFileURL(path.join(workspace, 'lib/workflow.mjs')));

const require = createRequire(import.meta.url);
const playwrightPath = process.argv[2] || 'playwright';
const { chromium } = require(playwrightPath);
const sharp = require(path.join(path.dirname(require.resolve(playwrightPath)), '..', 'sharp'));
const output = path.resolve(process.argv[3] || 'outputs/project-galleries-qa');
const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-project-galleries-'));
const checks = [], pageErrors = [], generationRequests = [];
let app, browser, page, paidCalls = 0;
const rejectGeneration = async () => { paidCalls++; throw new Error('Generation is disabled during gallery verification.'); };

try {
  await mkdir(output, { recursive: true });
  const store = new Store(root); await store.init();
  await store.saveImageSettings({ baseUrl: 'https://example.invalid', apiKey: 'gallery-fixture-only', imageModel: 'gpt-image-2' });
  browser = await chromium.launch({ headless: true, executablePath: process.argv[4] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const video = process.env.JINGCE_QA_VIDEO_PATH ? await readFile(process.env.JINGCE_QA_VIDEO_PATH) : Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d'); let frame = 0;
    const paint = () => {
      ctx.fillStyle = '#207b65'; ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#f2c14e'; ctx.fillRect(70 + frame++ * 8, 105, 180, 150);
      ctx.fillStyle = '#fff'; ctx.font = '32px sans-serif'; ctx.fillText('Project video', 310, 290);
    };
    paint();
    const stream = canvas.captureStream(12);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/mp4;codecs=avc1.42001E' }), chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const result = new Promise(resolve => recorder.onstop = async () => resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))));
    recorder.start(100); const timer = setInterval(paint, 80);
    await new Promise(resolve => setTimeout(resolve, 1100));
    recorder.stop(); clearInterval(timer);
    const data = await result;
    stream.getTracks().forEach(track => track.stop());
    return data;
  }));
  assert.ok(video.length > 1000, 'The video fixture should contain encoded frames.');
  const png = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#5b9ad5' } })
    .composite([{ input: await sharp({ create: { width: 180, height: 220, channels: 3, background: '#f1c15f' } }).png().toBuffer(), left: 80, top: 70 }])
    .png().toBuffer();
  const makeAsset = async (id, kind = 'image', source = 'model', createdAt = '2026-10-12T02:00:00Z') => {
    const data = kind === 'video' ? video : png;
    const asset = { id, kind, source, name: `${id === 'b-video' ? '雨夜书店短片' : '工程素材 ' + id}.${kind === 'video' ? 'mp4' : 'png'}`,
      file: id + (kind === 'video' ? '.mp4' : '.png'), mime: kind === 'video' ? 'video/mp4' : 'image/png', size: data.length, createdAt,
      ...(source === 'model' ? { model: kind === 'video' ? 'fixture-video' : 'gpt-image-2' } : {}) };
    await writeFile(path.join(root, 'assets', asset.file), data); return asset;
  };
  const first = createProject({ title: '城市品牌宣传' }); first.id = 'gallery-project-a'; first.updatedAt = '2026-10-12T03:00:00Z';
  const second = createProject({ title: '雨夜书店故事工程与人物动作镜头素材归档' }); second.id = 'gallery-project-b'; second.updatedAt = '2026-10-12T02:00:00Z';
  const empty = createProject({ title: '待拍摄的新工程' }); empty.id = 'gallery-project-empty';
  const deleted = createProject({ title: '已删除工程' }); deleted.id = 'gallery-project-deleted'; deleted.deletedAt = '2026-10-12T04:00:00Z';
  first.assets = [await makeAsset('a-upload', 'image', 'upload'), await makeAsset('a-old', 'image', 'model', '2026-10-12T01:00:00Z'),
    await makeAsset('a-new', 'image', 'model', '2026-10-12T03:00:00Z'), await makeAsset('a-video', 'video')];
  second.assets = [await makeAsset('b-upload', 'image', 'upload'), await makeAsset('b-old', 'image', 'model', '2026-10-12T01:00:00Z'),
    await makeAsset('b-new', 'image', 'model', '2026-10-12T02:00:00Z'), await makeAsset('b-video', 'video')];
  second.assets.push({ ...await makeAsset('b-deleted', 'image', 'upload'), deletedAt: '2026-10-12T04:00:00Z' });
  deleted.assets = [await makeAsset('hidden-project-result')];
  await store.mutate(state => {
    state.projects = [first, second, empty, deleted];
    state.imageJobs = [{ id: 'b-image-job', projectId: second.id, state: 'done', model: 'gpt-image-2',
      assetId: 'b-new', prompt: '雨夜书店，人物站在窗边阅读。', createdAt: '2026-10-12T02:00:00Z', updatedAt: '2026-10-12T02:00:00Z' }];
  });
  app = await createStudio({ root, catalog: [], imageCatalog: [{ name: 'gpt-image-2', imageProtocol: 'gpt' }], textCatalog: [],
    tools: { ready: false }, integrations: { submit: rejectGeneration }, imageIntegrations: { submitImage: rejectGeneration } });
  const url = await app.start(0);
  await page.addInitScript(id => {
    localStorage.setItem('jingce-active-project', id);
    localStorage.setItem('jingce-theme', 'day');
  }, first.id);
  await page.route('**/app.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()) + '\nglobalThis.galleryQa = {state, ensureProject, refreshProjectList, flush};' });
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/projects\/[^/]+\/(?:jobs|image-jobs|batches|image-batches)(?:\?|$)/.test(request.url())) generationRequests.push(request.url());
  });
  await page.goto(url);
  await page.waitForFunction(id => globalThis.galleryQa?.state.saved?.id === id, first.id);
  const activeProject = () => page.evaluate(() => galleryQa.state.project.id);
  const shownIds = selector => page.locator(selector).evaluateAll(nodes => nodes.map(node => node.dataset.assetId));
  const waitForResultThumbnails = () => page.waitForFunction(() => [...document.querySelectorAll('#result-list .result-preview')].every(preview => preview.classList.contains('thumbnail-ready')), null, { timeout: 10000 });
  const assertLayout = async () => {
    const problems = await page.evaluate(() => {
      const issues = [], visible = element => element.getClientRects().length > 0;
      if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('horizontal overflow');
      for (const group of document.querySelectorAll('.project-asset-group,.project-result-group')) {
        if (!visible(group)) continue;
        const grid = group.querySelector('.project-group-grid').getBoundingClientRect();
        if (group.querySelector('.project-group-heading').getBoundingClientRect().bottom > grid.top + 1) issues.push('group heading overlaps cards');
        const cards = [...group.querySelectorAll('.asset-card,.result-card')].map(card => card.getBoundingClientRect());
        if (cards.length > 1 && grid.width >= 456 && (Math.abs(cards[0].top - cards[1].top) > 1 || cards[1].left <= cards[0].left)) issues.push('cards do not flow horizontally');
        for (let i = 0; i < cards.length; i++) {
          if (cards[i].left < grid.left - 1 || cards[i].right > grid.right + 1) issues.push('card exceeds project grid');
          if (!i) continue;
          if (Math.abs(cards[i].top - cards[i - 1].top) <= 1) {
            if (cards[i].left < cards[i - 1].right - 1) issues.push('horizontal cards overlap');
          } else if (cards[i].top < cards[i - 1].bottom - 1 || Math.abs(cards[i].left - cards[0].left) > 1) issues.push('cards do not wrap to a new row');
        }
      }
      for (const card of document.querySelectorAll('.result-card')) {
        if (!visible(card)) continue;
        const title = card.querySelector('.result-title').getBoundingClientRect(), button = card.querySelector('.result-details-button').getBoundingClientRect();
        if (title.right > button.left + 1) issues.push('result title overlaps details button');
      }
      for (const control of document.querySelectorAll('.project-filter select')) {
        if (!visible(control)) continue;
        if (control.getBoundingClientRect().right > innerWidth + 1) issues.push('project filter exceeds viewport');
      }
      return issues;
    });
    assert.deepEqual(problems, []);
  };

  await page.locator('#assets-tab').click();
  assert.equal(await page.locator('.project-asset-group').count(), 2);
  assert.equal(await page.locator('#asset-list .asset-card').count(), 8);
  assert.equal(await page.locator('#asset-project-filter option[value="gallery-project-deleted"]').count(), 0);
  await page.locator('#asset-project-filter').selectOption(second.id);
  assert.equal(await page.locator('#asset-list .asset-card').count(), 4);
  assert.deepEqual(await page.locator('.project-asset-group').evaluateAll(groups => groups.map(group => group.dataset.projectId)), [second.id]);
  const hasBatchControls = await page.locator('#select-all-assets').count() > 0;
  if (hasBatchControls) {
    await page.locator('#select-all-assets').click();
    assert.equal(await page.locator('#asset-list input:checked').count(), 4);
  }
  await page.locator('#asset-project-filter').selectOption(first.id);
  assert.equal(await page.locator('#asset-list input:checked').count(), 0);
  await page.locator('#asset-project-filter').selectOption(empty.id);
  assert.equal(await page.locator('#asset-list .asset-card').count(), 0);
  if (hasBatchControls) assert.equal(await page.locator('#select-all-assets').isDisabled(), true);
  await page.locator('#asset-project-filter').selectOption('all');
  checks.push('assets grouped and filtered by project; selection follows visible items; empty and deleted projects handled');
  await assertLayout();
  await page.screenshot({ path: path.join(output, 'assets-desktop.png'), fullPage: true });

  await page.locator('#results-tab').click();
  assert.equal(await page.locator('.project-result-group').count(), 2);
  assert.equal(await page.locator('#result-list .result-card').count(), 6);
  await waitForResultThumbnails();
  await page.locator('#result-project-filter').selectOption(second.id);
  await page.locator('#result-filter').selectOption('image');
  assert.deepEqual(await shownIds('#result-list .result-card'), ['b-new', 'b-old']);
  await page.locator('#result-sort').selectOption('oldest');
  assert.deepEqual(await shownIds('#result-list .result-card'), ['b-old', 'b-new']);
  await page.locator('#result-filter').selectOption('video');
  assert.deepEqual(await shownIds('#result-list .result-card'), ['b-video']);
  await page.locator('#result-filter').selectOption('all');
  await page.locator('#result-sort').selectOption('newest');
  await page.locator('#result-project-filter').selectOption('all');
  await waitForResultThumbnails();
  checks.push('generated images and videos grouped; project, type and time filters combine; thumbnails render');
  await assertLayout();
  await page.screenshot({ path: path.join(output, 'results-desktop.png'), fullPage: true });

  for (const viewport of [{ width: 1920, height: 1080 }, { width: 768, height: 1024 }, { width: 375, height: 812 }, { width: 320, height: 800 }]) {
    await page.setViewportSize(viewport);
    for (const view of ['assets', 'results']) {
      await page.locator(`#${view}-tab`).click();
      if (view === 'results') await waitForResultThumbnails();
      await assertLayout();
      await page.screenshot({ path: path.join(output, `${view}-${viewport.width}.png`), fullPage: true });
    }
  }
  await page.locator('#theme-select').selectOption('night'); await assertLayout();
  await page.screenshot({ path: path.join(output, 'results-mobile-night.png'), fullPage: true });
  await page.locator('#theme-select').selectOption('day');
  await page.setViewportSize({ width: 1440, height: 1000 });
  checks.push('cards flow left to right and wrap without overlap at 1920, 1440, 768, 375 and 320 pixels, including night theme');

  await page.locator('[data-result-details="b-new"]').click();
  await page.locator('#result-details-content .result-details-prompt').waitFor();
  assert.match(await page.locator('#result-details-content').textContent(), /雨夜书店，人物站在窗边阅读/);
  assert.equal(await activeProject(), first.id);
  await page.screenshot({ path: path.join(output, 'other-project-details.png'), fullPage: true });
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#result-details-content [data-delete-asset="b-new"]').click();
  await page.waitForFunction(() => !document.querySelector('#result-details-dialog').open);
  assert.ok(app.store.get(second.id).assets.find(asset => asset.id === 'b-new').deletedAt);
  assert.equal(await activeProject(), first.id);
  await page.locator('#assets-tab').click();
  await page.locator('#asset-project-filter').selectOption(second.id);
  await page.locator('#toggle-deleted-assets').click();
  await page.locator('[data-preview-asset="b-new"]').click();
  assert.equal(await page.locator('#preview-content img').getAttribute('src'), '/api/assets/b-new');
  await page.locator('#close-preview').click();
  await page.locator('[data-restore-asset="b-new"]').click();
  await page.waitForFunction(() => !galleryQa.state.projects.find(project => project.id === 'gallery-project-b').assets.find(asset => asset.id === 'b-new').deletedAt);
  assert.equal(await activeProject(), first.id);
  checks.push('other-project details include saved prompt; deletion, deleted preview and restoration stay in the owning project');

  await page.locator('[data-add-to-canvas="b-new"]').click();
  await page.waitForFunction(() => galleryQa.state.project.id === 'gallery-project-b' && galleryQa.state.project.graph.nodes.some(node => node.assetId === 'b-new'));
  await page.evaluate(() => galleryQa.flush());
  assert.ok(app.store.get(second.id).graph.nodes.some(node => node.assetId === 'b-new'));
  assert.equal(app.store.get(first.id).graph.nodes.length, 0);
  await page.locator('#assets-tab').click();
  await page.locator('[data-use-image-reference="a-upload"]').click();
  await page.waitForFunction(() => galleryQa.state.project.id === 'gallery-project-a' && galleryQa.state.imageReferenceIds.includes('a-upload'));
  assert.deepEqual(await page.evaluate(() => galleryQa.state.imageReferenceIds), ['a-upload']);
  checks.push('single canvas placement and image reuse switch to the owning project');

  if (hasBatchControls) {
    await page.locator('#assets-tab').click();
    for (const id of ['a-old', 'b-old']) await page.locator(`[data-select-asset="${id}"]`).check();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#batch-delete-assets').click();
    await page.waitForFunction(() => galleryQa.state.assetSelection.size === 0);
    assert.ok(app.store.get(first.id).assets.find(asset => asset.id === 'a-old').deletedAt);
    assert.ok(app.store.get(second.id).assets.find(asset => asset.id === 'b-old').deletedAt);
    assert.equal(await activeProject(), first.id);
    await page.locator('#toggle-deleted-assets').click();
    for (const id of ['a-old', 'b-old']) await page.locator(`[data-select-asset="${id}"]`).check();
    await page.locator('#batch-restore-assets').click();
    await page.waitForFunction(() => !galleryQa.state.showDeletedAssets);
    for (const id of ['a-new', 'b-new', 'b-video']) await page.locator(`[data-select-asset="${id}"]`).check();
    await page.locator('#batch-place-assets').click();
    await page.waitForFunction(() => galleryQa.state.assetSelection.size === 0);
    assert.ok(app.store.get(first.id).graph.nodes.some(node => node.assetId === 'a-new'));
    assert.ok(app.store.get(second.id).graph.nodes.some(node => node.assetId === 'b-video'));
    assert.equal(app.store.get(second.id).graph.nodes.filter(node => node.assetId === 'b-new').length, 1);
    assert.equal(app.store.get(first.id).graph.nodes.some(node => String(node.assetId).startsWith('b-')), false);
    assert.equal(app.store.get(second.id).graph.nodes.some(node => String(node.assetId).startsWith('a-')), false);
    checks.push('batch deletion, restoration and canvas placement apply separately to each owning project');
  }

  await page.evaluate(id => galleryQa.ensureProject(id), first.id);
  await page.locator('#results-tab').click();
  await page.locator('#result-project-filter').selectOption(second.id);
  const fresh = await makeAsset('b-background-result', 'image', 'model', '2026-10-12T05:00:00Z');
  await app.store.update(second.id, project => { project.assets.push(fresh); return touch(project); });
  await page.evaluate(() => galleryQa.refreshProjectList());
  await page.locator('#result-list [data-asset-id="b-background-result"]').waitFor();
  assert.equal(await page.locator('#result-project-filter').inputValue(), second.id);
  checks.push('background results from other projects refresh without switching the active project or resetting the filter');

  assert.equal(paidCalls, 0); assert.deepEqual(generationRequests, []); assert.deepEqual(pageErrors, []);
  await writeFile(path.join(output, 'browser-result.json'), JSON.stringify({ passed: true, workspace, paidCalls, generationRequests, pageErrors, checks }, null, 2));
  console.log(JSON.stringify({ passed: true, paidCalls, pageErrors, checks, output }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  const media = await page?.locator('#result-list img,#result-list video').evaluateAll(elements => elements.map(element => ({
    src: element.currentSrc, readyState: element.readyState, width: element.videoWidth || element.naturalWidth,
    error: element.error?.message, code: element.error?.code,
  }))).catch(() => []);
  console.error(JSON.stringify({ pageErrors, generationRequests, media }));
  throw error;
} finally {
  await browser?.close(); await app?.close();
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('jingce-project-galleries-')) throw new Error('Unexpected test data path.');
  await rm(root, { recursive: true, force: true });
}
