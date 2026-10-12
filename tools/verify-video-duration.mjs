import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStudio } from '../server.mjs';
import { catalogForVideoModelIds, buildVideoRequest, DEFAULT_CONNECTION, VIDEO_REQUEST_MODE } from '../lib/providers.mjs';
import { CARD_SIZE_VERSION } from '../public/canvas-layout.js';

const ids = ['seedance-2.0-933-720P（秒）', 'seedance-2.0-fast-933-720P（次）',
  'seedance-2.0-mini-903-720P（次）', 'minimax-h3-933-2K（次）'];
const catalog = catalogForVideoModelIds(ids);
const expected = Number(process.argv[2] || 15);
const output = path.resolve(process.argv[3] || 'deliveries/video-duration-20261011');
const root = await mkdtemp(path.join(tmpdir(), 'jingce-duration-check-'));
const requests = [], errors = [], browserRequests = [];
const report = { expectedDuration: expected, checks: [], mockProviderRequests: [], realGenerationRequests: 0, screenshots: [] };
const checkpoint = name => { report.checks.push(name); console.log('PASS ' + name); };
const forbiddenFetcher = async () => { report.realGenerationRequests++; throw new Error('Real provider calls are forbidden.'); };
let browser, app;
try {
  await mkdir(output, { recursive: true });
  app = await createStudio({ root, catalog, imageCatalog: [], textCatalog: [], tools: { ready: false },
    videoFetcher: forbiddenFetcher, textFetcher: forbiddenFetcher,
    integrations: { submit: async (_connection, job) => {
      const body = buildVideoRequest(job);
      requests.push({ model: body.model, duration: body.duration, resolution: body.resolution, ratio: body.ratio });
      return { taskId: 'mock-duration-' + requests.length, state: 'queued', providerStatus: 'queued', progress: 0 };
    }, poll: async () => ({ state: 'running', providerStatus: 'running', progress: 1 }) },
  });
  await app.store.saveSettings({ ...DEFAULT_CONNECTION, apiKey: 'offline-duration-test-key' });
  const url = await app.start(0);
  const bootstrap = await (await fetch(url + '/api/bootstrap')).json();
  const send = async (route, method, body) => {
    const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token },
      body: JSON.stringify(body) });
    assert.ok(response.ok, 'Local fixture operation failed: ' + response.status);
    return response.json();
  };
  let project = await send('/api/projects', 'POST', { title: '时长提交回归验证' });
  project = await send('/api/projects/' + project.id, 'PATCH', { revision: project.revision,
    scenes: [{ id: 'clip', title: '15 秒参数验证', videoPrompt: '原创人物沿海边行走。', videoModel: ids[0],
      generationDuration: 15, generationCount: 1, duration: 5, ratio: '16:9', resolution: '720p', references: [] }],
    graph: { cardSizeVersion: CARD_SIZE_VERSION, nodes: [{ id: 'shot', kind: 'video', label: '15 秒参数验证',
      sceneId: 'clip', x: 30, y: 30, width: 340, height: 320 }], links: [], groups: [], viewport: { x: 0, y: 0, zoom: 1 } },
  });
  if (!process.env.JINGCE_PLAYWRIGHT_MODULE) {
    throw new Error('请将 JINGCE_PLAYWRIGHT_MODULE 设置为 Playwright index.mjs 的绝对路径。');
  }
  const { chromium } = await import(pathToFileURL(path.resolve(process.env.JINGCE_PLAYWRIGHT_MODULE)).href);
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  page.setDefaultTimeout(9000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(url)) browserRequests.push(request.url()); });
  await page.addInitScript(id => localStorage.setItem('jingce-active-project', id), project.id);
  await page.goto(url);
  await page.locator('#canvas-tab').click();
  await page.locator('.canvas-node[data-node-id="shot"]').waitFor();
  await page.locator('#videos-tab').click();
  const card = page.locator('[data-scene-id="clip"]');
  assert.equal(await card.locator('[data-scene-field="generationDuration"]').inputValue(), '15');
  await card.locator('[data-scene-field="videoModel"]').selectOption(ids[2]);
  assert.equal(await card.locator('[data-scene-field="generationDuration"]').inputValue(), String(expected));
  await card.locator('[data-scene-action="generate"]').click();
  await page.waitForFunction(() => document.querySelector('#job-list').textContent.includes('mock-duration-1'));
  assert.equal(requests[0].duration, expected);
  checkpoint('视频页从标准版切到 Mini，显示秒数与模型请求一致');

  await card.locator('[data-scene-field="generationDuration"]').selectOption('15');
  await page.locator('#canvas-tab').click();
  const canvasCard = page.locator('.canvas-node[data-node-id="shot"]');
  await canvasCard.hover();
  await canvasCard.locator('[data-shot-field="videoModel"]').selectOption(ids[1]);
  assert.equal(await canvasCard.locator('[data-shot-field="generationDuration"]').inputValue(), String(expected));
  await canvasCard.locator('[data-card-action="generate"]').click();
  for (let i = 0; i < 100 && requests.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].duration, expected);
  checkpoint('创作画布从 Mini 切到 Fast，显示秒数与模型请求一致');
  await page.screenshot({ path: path.join(output, 'canvas-duration.png'), fullPage: true });
  report.screenshots.push('canvas-duration.png');

  await page.locator('#videos-tab').click();
  const saved = await (await fetch(url + '/api/projects/' + project.id)).json();
  assert.equal(saved.scenes[0].generationDuration, expected === 5 ? 0 : expected);
  const jobs = await (await fetch(url + '/api/projects/' + project.id + '/jobs')).json();
  assert.ok(jobs.every(job => job.duration === expected));
  await page.screenshot({ path: path.join(output, 'video-duration.png'), fullPage: true });
  report.screenshots.push('video-duration.png');
  assert.equal(report.realGenerationRequests, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(browserRequests, []);
  report.mockProviderRequests = requests;
  report.browserJavaScriptErrors = errors;
  report.status = 'passed';
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
