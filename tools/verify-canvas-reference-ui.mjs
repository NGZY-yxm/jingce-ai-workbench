// Run with JINGCE_PLAYWRIGHT_MODULE pointing to an installed Playwright package.
// Uses an isolated project and never submits generation requests.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../server.mjs';
import { CARD_SIZE_VERSION } from '../public/canvas-layout.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.JINGCE_PLAYWRIGHT_MODULE || 'playwright');
const output = fileURLToPath(new URL('../deliveries/canvas-reference-ui/', import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), 'jingce-reference-ui-'));
await mkdir(output, { recursive: true });
const errors = [], submissions = [];
let studio, browser;
const noProvider = async () => { throw new Error('Visual verification must not use a provider'); };
try {
  studio = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [],
    integrations: { submit: noProvider, poll: noProvider, download: noProvider },
    imageIntegrations: { submitImage: noProvider, downloadImage: noProvider }, textFetcher: noProvider });
  const url = await studio.start(0);
  const bootstrap = await (await fetch(url + '/api/bootstrap')).json();
  const api = async (route, method, body) => {
    const response = await fetch(url + route, { method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token }, body: JSON.stringify(body) });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  };
  let project = await api('/api/projects', 'POST', { title: '画布视觉核对', brief: { product: '本地演示' } });
  const node = (id, kind, x, y, extra = {}) => ({ id, kind, label: id, x, y, width: 320, height: 260, ...extra });
  const scene = { id: 'visual-video-scene', title: '视频示例', videoPrompt: '镜头缓慢推近，保持主体清晰。', duration: 5, references: [] };
  project = await api('/api/projects/' + project.id, 'PATCH', { revision: project.revision,
    scenes: [scene], graph: { cardSizeVersion: CARD_SIZE_VERSION, groups: [], links: [],
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [
        node('text-card', 'text', 180, 60, { label: '文字便签', note: '先写下创作方向。' }),
        node('ai-card', 'ai', 590, 60, { label: 'AI 创作', aiConfig: { instruction: '把想法整理为提示词' } }),
        node('image-card', 'image', 1000, 60, { label: '新的生图', role: 'image-generation', imageConfig: { prompt: '柔和的光线，安静的街景' } }),
        node('video-card', 'video', 385, 435, { label: '视频示例', sceneId: scene.id }),
        node('speech-card', 'audio', 795, 435, { label: '新的语音', role: 'speech-generation', speechConfig: { text: '欢迎来到这座雨夜书店。' } }),
      ] } });

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && /\/(?:jobs|image-jobs|speech-jobs|batches|image-batches|text-chat)$/.test(new URL(request.url()).pathname)) submissions.push(request.url());
  });
  await page.addInitScript(id => {
    localStorage.setItem('jingce-active-project', id);
    localStorage.setItem('jingce-theme', 'night');
  }, project.id);
  await page.goto(url);
  await page.locator('#canvas-tab').click();
  await page.locator('#expand-canvas').click();
  await page.waitForSelector('[data-node-id="speech-card"]');
  await page.locator('#close-canvas-text').click();
  await page.locator('#fit-canvas').click();
  const cards = ['text-card', 'ai-card', 'image-card', 'video-card', 'speech-card'];
  const take = async name => { await page.waitForTimeout(180); await page.screenshot({ path: path.join(output, `${name}.png`) }); };
  const hiddenDetails = async id => page.locator(`[data-node-id="${id}"] .canvas-hover-details`)
    .evaluate(element => ({ visibility: getComputedStyle(element).visibility, opacity: getComputedStyle(element).opacity }));
  for (const theme of ['night', 'day']) {
    if (theme === 'day') {
      await page.locator('#expand-canvas').click();
      await page.locator('#theme-select').selectOption('day');
      await page.locator('#expand-canvas').click();
      if (await page.locator('#creative-canvas').evaluate(element => element.classList.contains('canvas-chat-open'))) await page.locator('#close-canvas-text').click();
    }
    assert.equal(await page.locator('#creative-canvas').evaluate(element => getComputedStyle(element).backgroundColor),
      theme === 'night' ? 'rgb(13, 14, 16)' : 'rgb(244, 246, 248)');
    for (const id of cards) {
      const card = page.locator(`[data-node-id="${id}"]`);
      assert.equal(await card.locator('.canvas-node-header').count(), 0, `${id}: header removed`);
      assert.equal(await card.locator('.canvas-cover .canvas-frosted-placeholder').count(), 1, `${id}: shared default cover`);
      assert.equal(await card.locator('.canvas-cover :is(p,small,textarea)').count(), 0, `${id}: no small text or content preview on default cover`);
      assert.equal(await card.locator('.canvas-frosted-placeholder strong').evaluate(element => getComputedStyle(element).fontSize), '22px', `${id}: consistent readable name`);
      assert.equal(await card.locator('.canvas-frosted-placeholder').evaluate(element => getComputedStyle(element).backdropFilter), 'blur(20px) saturate(0.7)', `${id}: frosted cover`);

      assert.equal(await card.locator('.canvas-port').evaluateAll(elements => elements.every(element => !element.textContent.trim() && getComputedStyle(element, '::before').content === 'none' && getComputedStyle(element, '::after').content === 'none')), true, `${id}: no plus sign`);
      await card.locator('.canvas-cover-drag').hover();
      assert.deepEqual(await hiddenDetails(id), { visibility: 'hidden', opacity: '0' }, `${id}: hover must not reveal details`);
      await card.locator('.canvas-cover-drag').click();
      assert.equal(await card.getAttribute('aria-expanded'), 'true', `${id}: click opens details`);
      await page.waitForFunction(id => getComputedStyle(document.querySelector(`[data-node-id="${id}"] .canvas-hover-details`)).opacity === '1', id);
      await page.mouse.move(1550, 250);
      assert.equal(await card.locator('.canvas-hover-details').evaluate(element => getComputedStyle(element).visibility), 'visible', `${id}: details stay open after pointer leaves`);
      if (id === 'speech-card') {
        assert.equal(await card.locator('[data-speech-field="text"]').inputValue(), '欢迎来到这座雨夜书店。');
        assert.equal(await card.locator('.speech-card-generate').isDisabled(), true);
        assert.equal(await card.locator('.speech-card-result').count(), 0);
      }
      if (id === 'image-card') assert.equal(await card.locator('[data-image-field="prompt"]').inputValue(), '柔和的光线，安静的街景');
      if (id === 'video-card') assert.equal(await card.locator('[data-shot-field="videoPrompt"]').inputValue(), scene.videoPrompt);
      await take(`${theme}-${id}`);
      await card.locator('[data-card-action="close-details"]').click();
      assert.equal(await card.getAttribute('aria-expanded'), 'false');
      await page.waitForFunction(id => getComputedStyle(document.querySelector(`[data-node-id="${id}"] .canvas-hover-details`)).opacity === '0', id);
    }
    await take(`${theme}-all-cards`);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(submissions, []);
  const live = await context.newPage();
  live.on('pageerror', error => errors.push(error.message));
  const liveResponse = await live.goto('http://127.0.0.1:18971/');
  assert.equal(liveResponse.status(), 200);
  assert.equal(await live.locator('link[href="/canvas-reference-ui.css"]').count(), 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', themes: ['night', 'day'], cards, screenshots: output,
    livePort: 18971, browserErrors: errors, generationSubmissions: submissions.length }, null, 2));
} finally {
  if (browser) await browser.close();
  if (studio) await studio.close();
}
