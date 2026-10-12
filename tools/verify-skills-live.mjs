import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(path.join(process.env.JINGCE_BROWSER_MODULES || process.cwd(), 'package.json'));
const { chromium } = require('playwright');
const url = process.argv[2] || 'http://127.0.0.1:18970';
const output = path.resolve(process.argv[3] || 'outputs/skills-live-verification');
await mkdir(output, { recursive: true });
const bootstrap = await (await fetch(url + '/api/bootstrap')).json();
assert.equal(bootstrap.appId, 'jingce-ad-studio');
assert.ok(Array.isArray(bootstrap.skills));
const modules = {};
for (const route of ['/skills.js', '/skills.css', '/chat-images.js', '/yaml.js', '/jszip.js', '/ai-text.js']) {
  const response = await fetch(url + route); modules[route] = response.status;
  assert.equal(response.status, 200);
}
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], submitted = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (request.method() === 'POST' && /\/(?:text-chat|image-jobs|jobs|batches|image-batches)$/.test(new URL(request.url()).pathname)) submitted.push(request.url()); });
try {
  await page.goto(url); await page.waitForFunction(() => document.querySelector('#save-state')?.textContent.includes('已保存'));
  await page.locator('#skills-tab').click(); await page.locator('#skills-view').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(output, 'live-skills-desktop.png'), fullPage: true });
  await page.locator('#text-tab').click(); await page.locator('#text-chat-skill').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(output, 'live-assistant-desktop.png'), fullPage: true });
  await page.locator('#canvas-tab').click(); await page.locator('#expand-canvas').click();
  if (!(await page.locator('#canvas-text-panel').isVisible())) await page.locator('#toggle-canvas-text').click();
  await page.locator('#canvas-text-host #text-chat-skill').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(output, 'live-language-model-desktop.png'), fullPage: true });
  await page.locator('#expand-canvas').click();
  await page.locator('#skills-tab').click(); await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'live-skills-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []); assert.deepEqual(submitted, []);
  const report = { url, modules, projectCount: bootstrap.projects.length, skillCount: bootstrap.skills.length, browserErrors: errors, generationRequests: submitted.length };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
