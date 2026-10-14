import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createStudio } from '../server.mjs';
import { createProject } from '../lib/workflow.mjs';
import { defaultPrevisSpec } from '../public/previs-spec.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.JINGCE_PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(process.argv[2] || 'outputs/previs-projects-browser');
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-previs-projects-browser-'));
const errors = [], creationRequests = [], externalRequests = [];
const detected = { ready: false, blender: { ready: false, message: '浏览器验证无需渲染' }, ffmpeg: { ready: false, message: '' } };
let app, browser, page;
try {
  const unexpected = async () => { throw new Error('Workspace management must not submit generation'); };
  app = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false },
    previs: { detectTools: async () => detected, render: unexpected },
    integrations: { submit: unexpected, poll: unexpected }, imageIntegrations: { submitImage: unexpected } });
  const first = createProject({ title: '城市短片 · 创作工程 A' });
  const other = createProject({ title: '另一支短片 · 创作工程 B' });
  await app.store.mutate(state => state.projects.push(first, other));
  const legacy = await app.previs.start(first.id, { mode: 'helper', operationId: 'legacy-browser', spec: { ...defaultPrevisSpec(), name: '已有开场预演记录' } });
  await app.previs.cancel(legacy.id);
  await app.previs.patch(legacy.id, { previsProjectId: undefined });
  const url = await app.start(0);
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(id => {
    localStorage.setItem('jingce-active-project', id);
    localStorage.setItem('jingce-active-view', 'previs');
  }, first.id);
  page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST') creationRequests.push(new URL(request.url()).pathname);
    if (!request.url().startsWith(url)) externalRequests.push(request.url());
  });
  await page.goto(url);
  await page.locator('#previs-view').waitFor({ state: 'visible' });
  await page.locator(`[data-previs-job="${legacy.id}"]`).waitFor();
  await page.locator('#previs-story-details > summary').click();
  await page.locator('#previs-story').fill('开场：人物走进城市广场。');
  const originalScene = await page.locator('#previs-spec').inputValue();
  await page.locator('#previs-new-project').click();
  await page.locator('#previs-new-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#new-dialog').isVisible(), false);
  await page.locator('#previs-new-title').fill('街道追逐 · 第二套预演');
  await page.locator('#previs-new-submit').click();
  await page.locator('#previs-new-dialog').waitFor({ state: 'hidden' });
  const childId = await page.locator('#previs-project-select').inputValue();
  assert.notEqual(childId, 'default');
  assert.equal(app.store.list().length, 2);
  assert.equal(app.store.get(first.id).previsProjects.length, 2);
  assert.equal(await page.locator('#previs-story').inputValue(), '');
  assert.equal(await page.locator(`[data-previs-job="${legacy.id}"]`).count(), 0);
  await page.locator('#previs-story').fill('追逐：摄影机沿街道跟随人物。');
  const childJob = await app.previs.start(first.id, { mode: 'helper', operationId: 'child-browser', previsProjectId: childId,
    spec: { ...defaultPrevisSpec(), name: '街道追逐预演记录' } });
  await app.previs.cancel(childJob.id);
  await page.reload();
  await page.locator('#previs-view').waitFor({ state: 'visible' });
  await page.locator(`[data-previs-job="${childJob.id}"]`).waitFor();
  assert.equal(await page.locator('#previs-project-select').inputValue(), childId);
  assert.equal(await page.locator('#previs-story').inputValue(), '追逐：摄影机沿街道跟随人物。');
  assert.equal(await page.locator(`[data-previs-job="${legacy.id}"]`).count(), 0);
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
  await page.locator('#previs-project-select').selectOption('default');
  assert.equal(await page.locator('#previs-story').inputValue(), '开场：人物走进城市广场。');
  assert.equal(await page.locator('#previs-spec').inputValue(), originalScene);
  assert.equal(await page.locator(`[data-previs-job="${legacy.id}"]`).count(), 1);
  assert.equal(await page.locator(`[data-previs-job="${childJob.id}"]`).count(), 0);
  await page.locator('#previs-project-select').selectOption(childId);
  await page.locator(`[data-project-id="${other.id}"].project-item`).click();
  await page.waitForFunction(title => document.querySelector('#previs-parent-project').textContent.includes(title), other.title);
  await page.locator('#previs-tab').click();
  assert.equal(await page.locator('#previs-project-select option').count(), 1);
  assert.equal(await page.locator('#previs-story').inputValue(), '');
  await page.locator(`[data-project-id="${first.id}"].project-item`).click();
  await page.waitForFunction(id => document.querySelector('#previs-project-select').value === id, childId);
  await page.locator('#previs-tab').click();
  assert.equal(await page.locator('#previs-story').inputValue(), '追逐：摄影机沿街道跟随人物。');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile viewport must not overflow.');
  await page.locator('#previs-new-project').click();
  await page.screenshot({ path: path.join(output, 'mobile-create-dialog.png'), fullPage: true });
  await page.locator('#previs-new-close').click();
  assert.equal(creationRequests.filter(route => route === '/api/projects').length, 0);
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  const report = { checks: ['new previs workspace stays in current creative project', 'dedicated creation dialog',
    'independent story and scene drafts', 'selection and drafts survive reload', 'legacy jobs remain in first workspace',
    'job history filtered by previs workspace', 'creative project isolation', 'desktop and mobile layout'],
    creativeProjectCount: app.store.list().length, childProjectCount: app.store.get(first.id).previsProjects.length,
    generationRequests: creationRequests.filter(route => /\/(text-chat|jobs|image-jobs|batches|image-batches|speech-jobs|previs-jobs)$/.test(route)),
    externalRequests, browserErrors: errors, browser: browser.version() };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); await app?.close();
  assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), 'jingce-previs-projects-browser-')));
  await rm(root, { recursive: true, force: true });
}
