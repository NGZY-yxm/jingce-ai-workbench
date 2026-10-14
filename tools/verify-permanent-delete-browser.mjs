import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createStudio } from '../server.mjs';
import { createProject } from '../lib/workflow.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.JINGCE_PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve('outputs/permanent-delete-browser');
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(output, 'fixture-'));
const report = { checks: [], browserErrors: [], externalRequests: [], paidSubmissions: 0 };
let app, browser;
try {
  app = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false },
    integrations: { submit: async () => { report.paidSubmissions++; throw new Error('Unexpected generation'); } },
    imageIntegrations: { submitImage: async () => { report.paidSubmissions++; throw new Error('Unexpected generation'); } } });
  const project = createProject({ title: '彻底删除任务验证' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW1kAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(root, 'assets', 'retained.png'), png);
  project.assets.push({ id: 'retained-image', kind: 'image', file: 'retained.png', mime: 'image/png', size: png.length,
    name: '保留的生成图片', source: 'model', createdAt: new Date().toISOString() });
  await app.store.mutate(state => {
    state.projects.push(project);
    for (const kind of ['video', 'image']) {
      for (const status of ['done', 'failed', 'uncertain', 'running']) {
        state[kind === 'image' ? 'imageJobs' : 'jobs'].push({
          id: kind + '-' + status, projectId: project.id, model: '浏览器验证模型',
          operationId: kind + '-' + status + '-operation', state: status === 'running' && kind === 'image' ? 'saving' : status,
          createdAt: '2026-10-14T00:00:00Z', deletedAt: '2026-10-14T00:01:00Z',
          prompt: '已删除的生成任务，验证所有状态均可彻底删除。', message: '本地验证记录',
          duration: 5, resolution: '720p', pollBlocked: true, assetId: '',
        });
      }
    }
  });
  const url = await app.start(0);
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== url) { report.externalRequests.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => report.browserErrors.push(error.message));
  await page.addInitScript(id => localStorage.setItem('jingce-active-project', id), project.id);
  await page.goto(url);
  for (const kind of ['video', 'image']) {
    const plural = kind === 'image' ? 'images' : 'videos';
    const list = page.locator(kind === 'image' ? '#image-job-list' : '#job-list');
    const attr = kind === 'image' ? 'data-permanent-image-job' : 'data-permanent-job';
    const toggle = page.locator(kind === 'image' ? '#toggle-deleted-image-jobs' : '#toggle-deleted-jobs');
    await page.locator(`[data-view="${plural}"]`).first().click();
    await toggle.waitFor({ state: 'visible' });
    await toggle.click();
    assert.equal(await list.locator(`[${attr}]`).count(), 4);
    for (const button of await list.locator(`[${attr}]`).all()) assert.equal(await button.isEnabled(), true);
    await page.screenshot({ path: path.join(output, kind + '-deleted-records.png'), fullPage: true });
    report.checks.push(kind + ': completed, failed, uncertain and active records all provide enabled permanent deletion');
    page.once('dialog', dialog => dialog.dismiss());
    await list.locator(`[${attr}="${kind}-uncertain"]`).click();
    assert.equal(await list.locator(`[${attr}]`).count(), 4);
    report.checks.push(kind + ': cancelling leaves the record intact');
    for (const status of ['uncertain', 'done', 'failed', 'running']) {
      page.once('dialog', dialog => dialog.accept());
      await list.locator(`[${attr}="${kind}-${status}"]`).click();
      await list.locator(`[${attr}="${kind}-${status}"]`).waitFor({ state: 'detached' });
    }
    await toggle.waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(output, kind + '-after-deletion.png'), fullPage: true });
    assert.deepEqual((kind === 'image' ? app.imageJobs : app.jobs).list(project.id, true), []);
    const collection = kind === 'image' ? 'imageJobs' : 'jobs';
    assert.equal(app.store.state[collection].length, 1, 'active work remains tracked privately');
    await app.store.mutate(state => { state[collection][0].state = 'done'; });
    await (kind === 'image' ? app.imageJobs : app.jobs).tick();
    assert.equal(app.store.state[collection].length, 0);
    report.checks.push(kind + ': confirmed deletions disappear and active work cleans itself once settled');
  }
  await page.reload();
  await page.locator('[data-view="images"]').first().click();
  await page.locator('#refresh-image-jobs').click();
  assert.equal(await page.locator('#toggle-deleted-image-jobs').isHidden(), true);
  await page.locator('[data-view="videos"]').first().click();
  await page.locator('#refresh-jobs').click();
  assert.equal(await page.locator('#toggle-deleted-jobs').isHidden(), true);
  assert.equal(app.store.get(project.id).assets.length, 1);
  assert.deepEqual(await readFile(path.join(root, 'assets', 'retained.png')), png);
  assert.equal(report.paidSubmissions, 0);
  assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(report.browserErrors, []);
  report.checks.push('reload preserves deletion; generated media retained; zero generation requests, external requests or browser errors');
  report.success = true;
} catch (error) { report.success = false; report.error = error.stack; process.exitCode = 1; }
finally {
  if (browser) await browser.close();
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
