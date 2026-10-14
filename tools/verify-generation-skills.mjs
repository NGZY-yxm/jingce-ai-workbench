import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server.mjs';
import { catalogForVideoModelIds, DEFAULT_CONNECTION } from '../lib/video-v3.mjs';
import { DEFAULT_IMAGE_CONNECTION } from '../lib/image-provider.mjs';
import { videoModelFixture } from '../test/fixtures/video-models.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.JINGCE_PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve(process.argv[2] || 'outputs/generation-skills-browser');
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-generation-skills-browser-'));
const imageModel = 'gpt-image-2.5-flare', videoModel = 'seedance-2.0-fast-933-720P（次）';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const report = { checks: [], imageRequests: [], videoRequests: [], browserErrors: [], externalRequests: [] };
let app, browser;
const until = async read => {
  for (let i = 0; i < 150; i++) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error('Browser verification timed out');
};
try {
  const catalog = catalogForVideoModelIds([videoModelFixture(videoModel)]);
  app = await createStudio({ root, catalog, imageCatalog: [{ name: imageModel }], textCatalog: [], tools: { ready: false },
    imageIntegrations: { submitImage: async (_settings, request) => {
      report.imageRequests.push({ prompt: request.prompt }); return { kind: 'base64', data: png, mime: 'image/png' };
    } },
    integrations: { submit: async (_settings, job) => {
      report.videoRequests.push({ prompt: job.prompt, skillId: job.skillId }); return { taskId: 'mock-' + job.id, state: 'queued' };
    }, poll: async () => ({ state: 'queued' }) },
  });
  await app.store.saveSettings({ ...DEFAULT_CONNECTION, apiKey: 'browser-fixture-video-key', videoModel });
  await app.store.saveImageSettings({ ...DEFAULT_IMAGE_CONNECTION, apiKey: 'browser-fixture-image-key', imageModel });
  const url = await app.start(0);
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json', 'X-Studio-Token': app.token },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
  };
  const [film] = await api('/api/skills/import', 'POST', { files: [
    { path: 'film/SKILL.md', content: '---\nname: 电影广告\ndescription: 统一人物外观、光线和镜头风格。\n---\n\n柔和侧光，保持人物外观一致。' },
    { path: 'film/references/style.md', content: '低饱和暖色，镜头缓慢推进。' },
  ] });
  const [paint] = await api('/api/skills/import', 'POST', { files: [{ path: 'SKILL.md', content: '---\nname: 水彩插画\ndescription: 清透水彩画面。\n---\n\n使用柔和水彩笔触，保留纸张纹理。' }] });
  let project = await api('/api/projects', 'POST', { title: '图片与视频技能演示' });
  project = await api(`/api/projects/${project.id}`, 'PATCH', { revision: project.revision,
    scenes: [{ id: 'clip', title: '窗边的故事', videoPrompt: '原创人物走向窗边，窗外是雨后的城市。', imagePrompt: '窗边人物参考图',
      videoModel, generationDuration: 5, generationCount: 1, ratio: '16:9', resolution: '720p' }],
    graph: { nodes: [
      { id: 'image-card', kind: 'image', role: 'image-generation', label: '人物参考图', x: 100, y: 80, imageConfig: { model: imageModel, prompt: '原创人物坐在窗边。' } },
      { id: 'video-card', kind: 'video', label: '窗边的故事', x: 660, y: 80, sceneId: 'clip' },
    ], links: [], viewport: { x: 0, y: 0, zoom: 1 } },
  });
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== url) { report.externalRequests.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.browserErrors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#save-state')?.textContent.includes('已保存'));
  await page.locator('#images-tab').click();
  await page.locator('#image-page-prompt').fill('原创人物坐在窗边，窗外是雨后的城市。');
  await page.locator('#image-page-skill').selectOption(film.id);
  assert.match(await page.locator('#image-page-skill-note').innerText(), /1 份文字参考资料/);
  await page.evaluate(() => document.querySelector('#toast')?.classList.remove('visible'));
  await page.screenshot({ path: path.join(output, '01-image-skills-desktop.png'), fullPage: true });
  await page.reload();
  await page.locator('#images-tab').click();
  assert.equal(await page.locator('#image-page-skill').inputValue(), film.id);
  report.checks.push('Image page remembers the selected skill after reload');
  await page.locator('#image-page-prompt').fill('原创人物坐在窗边，窗外是雨后的城市。');
  await page.locator('#image-page-form button[type=submit]').click();
  await until(() => report.imageRequests.length === 1);
  assert.match(report.imageRequests[0].prompt, /柔和侧光/); assert.match(report.imageRequests[0].prompt, /低饱和暖色/);
  await until(async () => (await api(`/api/projects/${project.id}/image-jobs`)).every(job => job.state === 'done'));
  report.checks.push('Image page submits selected skill rules and references through the mock image interface');
  await page.locator('#videos-tab').click();
  const scene = page.locator('[data-scene-id="clip"]');
  await scene.locator('[data-scene-field=videoSkillId]').selectOption(film.id);
  await until(async () => (await api(`/api/projects/${project.id}`)).scenes[0].videoSkillId === film.id);
  await page.evaluate(() => document.querySelector('#toast')?.classList.remove('visible'));
  await page.screenshot({ path: path.join(output, '02-video-skills-desktop.png'), fullPage: true });
  await scene.locator('[data-scene-action=generate]').click();
  await until(() => report.videoRequests.length === 1);
  assert.match(report.videoRequests[0].prompt, /低饱和暖色/);
  report.checks.push('Video page saves selected skill and submits its rules to the mock video interface');
  await page.locator('#canvas-tab').click();
  const imageCard = page.locator('[data-node-id="image-card"]');
  await imageCard.locator('.canvas-cover').click();
  await imageCard.locator('[data-image-field=skillId]').selectOption(paint.id);
  await until(async () => (await api(`/api/projects/${project.id}`)).graph.nodes.find(node => node.id === 'image-card').imageConfig.skillId === paint.id);
  await page.evaluate(() => document.querySelector('#toast')?.classList.remove('visible'));
  await page.screenshot({ path: path.join(output, '03-canvas-image-skills.png'), fullPage: true });
  const videoCard = page.locator('[data-node-id="video-card"]');
  await videoCard.locator('.canvas-cover').click();
  assert.equal(await videoCard.locator('[data-shot-field=videoSkillId]').inputValue(), film.id);
  await videoCard.locator('[data-shot-field=videoSkillId]').selectOption(paint.id);
  await until(async () => (await api(`/api/projects/${project.id}`)).scenes[0].videoSkillId === paint.id);
  await page.evaluate(() => document.querySelector('#toast')?.classList.remove('visible'));
  await page.screenshot({ path: path.join(output, '04-canvas-video-skills.png'), fullPage: true });
  report.checks.push('Canvas image and video cards persist skills and share the saved video selection with the video page');
  await page.reload();
  await page.locator('#videos-tab').click();
  assert.equal(await scene.locator('[data-scene-field=videoSkillId]').inputValue(), paint.id);
  report.checks.push('Video skill selection survives browser reload');
  await scene.locator('[data-generation-manage-skills]').click();
  await page.locator('#skills-view').waitFor({ state: 'visible' });
  await page.locator(`[data-skill-id="${paint.id}"]`).click();
  await page.locator('#skill-delete').click();
  await until(async () => !(await api('/api/skills')).some(skill => skill.id === paint.id));
  await page.locator('#videos-tab').click();
  assert.match(await scene.locator('[data-scene-field=videoSkillId] option:checked').innerText(), /已删除/);
  assert.equal(await scene.locator('[data-scene-action=generate]').isDisabled(), true);
  assert.match(await scene.locator('.generation-skill-note').innerText(), /已删除/);
  await scene.locator('[data-scene-field=videoSkillId]').selectOption('');
  assert.equal(await scene.locator('[data-scene-action=generate]').isDisabled(), false);
  report.checks.push('Deleting a selected skill refreshes the generation controls and blocks new generation until reselected');
  // Exercise the shared legacy dialog control without triggering generation.
  await page.evaluate(() => document.querySelector('#image-dialog').showModal());
  await page.locator('#image-dialog[open]').waitFor();
  await page.locator('#image-skill').selectOption(film.id);
  assert.match(await page.locator('#image-skill-note').innerText(), /文字规则/);
  await page.locator('#cancel-image').click();
  report.checks.push('Legacy image dialog shares the skill library and supports selection');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#images-tab').click();
  await page.evaluate(() => document.querySelector('#toast')?.classList.remove('visible'));
  await page.screenshot({ path: path.join(output, '05-image-skills-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#videos-tab').click();
  await scene.locator('[data-scene-field=videoSkillId]').selectOption(film.id);
  await page.evaluate(() => document.querySelector('#toast')?.classList.remove('visible'));
  await page.screenshot({ path: path.join(output, '06-video-skills-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  report.checks.push('Image and video skill controls fit a 390px mobile viewport');
  assert.equal(report.imageRequests.length, 1); assert.equal(report.videoRequests.length, 1);
  assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.externalRequests, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('jingce-generation-skills-browser-')) throw Error('Invalid fixture cleanup target');
  await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
}
