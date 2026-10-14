import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { createProject } from '../lib/workflow.mjs';
import { waveFixture, until } from '../test/support/speech-fixtures.mjs';

// Local audio fixtures only: this verification never submits a paid generation request.
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || process.env.JINGCE_PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(process.argv[3] || 'outputs/speech-deletion-browser');
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-speech-delete-browser-'));
const errors = [], dialogs = [];
let app, browser, page, acceptDialogs = true, synthesisCalls = 0;
try {
  const store = new Store(root); await store.init();
  await store.saveSpeechSettings({ region: 'domestic', model: 'speech-2.8-hd', apiKey: 'local-deletion-fixture-key' });
  const project = createProject({ title: '配音删除与恢复验证' });
  project.graph.nodes.push({ id: 'audio-card', kind: 'audio', assetId: '', label: '片头旁白', status: 'pending' });
  await store.mutate(state => state.projects.push(project));
  app = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false, message: '本地验证' },
    speechIntegrations: { synthesize: async () => {
      synthesisCalls++;
      return { audio: waveFixture(), mime: 'audio/wav', extension: '.wav', duration: .25, usageCharacters: 8, traceId: 'local-fixture-trace' };
    } } });
  const input = { operationId: 'browser-delete-first', text: '灯光落在书页上，故事从这里开始。', voiceId: 'fixture-voice', model: 'speech-2.8-hd', format: 'wav', name: '片头旁白', nodeId: 'audio-card' };
  const first = await app.speechJobs.start(project.id, input);
  const second = await app.speechJobs.start(project.id, { ...input, operationId: 'browser-retain-second', name: '片尾旁白', nodeId: '' });
  await until(() => app.speechJobs.list(project.id).every(job => job.state === 'done') && !app.speechJobs.busy.size);
  const firstAsset = app.store.get(project.id).assets.find(asset => asset.jobId === first.id);
  const secondAsset = app.store.get(project.id).assets.find(asset => asset.jobId === second.id);
  const url = await app.start(0);
  browser = await chromium.launch({ headless: true, ...(process.argv[4] ? { executablePath: process.argv[4] } : { channel: 'msedge' }) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push({ message: dialog.message(), accepted: acceptDialogs }); await (acceptDialogs ? dialog.accept() : dialog.dismiss()); });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === '已保存到本机');
  await page.locator('#speech-tab').click();
  await page.waitForFunction(() => document.querySelectorAll('#speech-job-list audio').length === 2);
  const deleteFirst = () => page.locator(`[data-speech-delete="${first.id}"]`).click();
  acceptDialogs = false;
  await deleteFirst();
  await page.waitForFunction(id => !document.querySelector(`[data-speech-delete="${id}"]`).disabled, first.id);
  assert.equal(await page.locator('#speech-job-list audio').count(), 2);
  assert.equal(app.speechJobs.get(first.id).deletedAt, null);
  acceptDialogs = true;
  await deleteFirst();
  await page.waitForFunction(() => document.querySelectorAll('#speech-job-list audio').length === 1 && document.querySelector('#speech-toggle-deleted').textContent.includes('（1）'));
  assert.ok(app.speechJobs.get(first.id).deletedAt);
  assert.equal(app.store.get(project.id).graph.nodes[0].assetId, '');
  assert.deepEqual(await readFile(path.join(root, 'assets', firstAsset.file)), waveFixture());
  assert.equal(app.speechJobs.list(project.id).length, 1);
  await page.locator('#speech-toggle-deleted').click();
  await page.waitForSelector(`[data-speech-restore="${first.id}"]`);
  assert.equal(await page.locator('#speech-job-list audio').count(), 0);
  assert.equal(await page.locator('#speech-toggle-deleted').getAttribute('aria-pressed'), 'true');
  await page.locator(`[data-speech-restore="${first.id}"]`).click();
  await page.waitForFunction(() => document.querySelectorAll('#speech-job-list [data-speech-job]').length === 0);
  await page.locator('#speech-toggle-deleted').click();
  await page.waitForFunction(() => document.querySelectorAll('#speech-job-list audio').length === 2);
  assert.equal(app.speechJobs.get(first.id).deletedAt, null);
  assert.equal(app.store.get(project.id).assets.find(asset => asset.id === firstAsset.id).deletedAt, null);
  await deleteFirst();
  await page.waitForFunction(() => document.querySelectorAll('#speech-job-list audio').length === 1 && document.querySelector('#speech-toggle-deleted').textContent.includes('（1）'));
  await page.locator('#speech-toggle-deleted').click();
  await page.waitForSelector(`[data-speech-permanent="${first.id}"]`);
  await page.locator('#theme-select').selectOption('day');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'day');
  await page.waitForFunction(() => !document.querySelector('#toast').classList.contains('visible'));
  await page.locator('.speech-results-panel').screenshot({ animations: 'disabled', path: path.join(output, 'speech-deleted-panel-day.png') });
  await page.locator('#theme-select').selectOption('night');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'night');
  await page.waitForFunction(() => !document.querySelector('#toast').classList.contains('visible'));
  await page.locator('.speech-results-panel').screenshot({ animations: 'disabled', path: path.join(output, 'speech-deleted-panel-night.png') });
  await page.locator('#theme-select').selectOption('day');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(`[data-speech-permanent="${first.id}"]`).scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '手机视图不能横向溢出');
  await page.waitForFunction(() => !document.querySelector('#toast').classList.contains('visible'));
  await page.locator('.speech-results-panel').screenshot({ animations: 'disabled', path: path.join(output, 'speech-deleted-panel-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1080 });
  acceptDialogs = false;
  await page.locator(`[data-speech-permanent="${first.id}"]`).click();
  await page.waitForFunction(id => !document.querySelector(`[data-speech-permanent="${id}"]`).disabled, first.id);
  assert.equal(app.speechJobs.list(project.id, true).length, 2);
  assert.deepEqual(await readFile(path.join(root, 'assets', firstAsset.file)), waveFixture());
  acceptDialogs = true;
  await page.locator(`[data-speech-permanent="${first.id}"]`).click();
  await page.waitForFunction(() => document.querySelectorAll('#speech-job-list [data-speech-job]').length === 0);
  assert.equal(app.speechJobs.list(project.id, true).length, 1);
  assert.equal(app.store.get(project.id).assets.length, 1);
  for (const file of [path.join(root, 'assets', firstAsset.file), app.speechJobs.resultFile(first.id), app.speechJobs.connectionFile(first.id)]) {
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  }
  assert.deepEqual(await readFile(path.join(root, 'assets', secondAsset.file)), waveFixture());
  await assert.rejects(app.speechJobs.start(project.id, input), { status: 410 });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === '已保存到本机');
  await page.locator('#speech-tab').click();
  await page.waitForFunction(() => document.querySelectorAll('#speech-job-list audio').length === 1);
  assert.ok((await page.locator('#speech-toggle-deleted').textContent()).includes('（0）'));
  await page.waitForFunction(() => !document.querySelector('#toast').classList.contains('visible'));
  await page.locator('.speech-results-panel').screenshot({ animations: 'disabled', path: path.join(output, 'speech-retained-panel.png') });
  assert.equal(synthesisCalls, 2);
  assert.deepEqual(errors, []);
  const report = { browser: 'Microsoft Edge', provider: 'local audio fixtures only', synthesisCalls,
    softDelete: true, restore: true, cancelDelete: true, cancelPermanentDelete: true, permanentDelete: true,
    audioFileCleanup: true, resultCacheCleanup: true, connectionSnapshotCleanup: true, otherAudioPreserved: true,
    canvasReferencesDetached: true, reloadPersistence: true, staleOperationBlocked: true,
    desktopDay: true, desktopNight: true, mobileWidth: 390, mobileNoOverflow: true, pageErrors: errors, dialogs };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) await page.screenshot({ animations: 'disabled', path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true });
}
