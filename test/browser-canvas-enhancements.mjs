// Run manually with JINGCE_PLAYWRIGHT_MODULE pointing to an installed Playwright.
// This uses a temporary studio, fake providers and a clean browser profile.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../server.mjs';
import { CARD_SIZE_VERSION } from '../public/canvas-layout.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.JINGCE_PLAYWRIGHT_MODULE || 'playwright');
const output = fileURLToPath(new URL('../deliveries/', import.meta.url));
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), 'jingce-canvas-enhancements-'));
let providerCalls = 0, browser, app, page;
const unexpectedProviderCall = async () => { providerCalls++; throw new Error('Canvas checks must not call providers'); };
const report = { checks: [], labelSizes: [], width: {}, screenshots: [], providerCalls: 0 };
const errors = [], paidRequests = [];
const checkpoint = name => { report.checks.push(name); console.log('PASS ' + name); };
const screenshot = async name => {
  const filename = 'canvas-enhancements-' + name + '-20261010.png';
  await page.screenshot({ path: path.join(output, filename) }); report.screenshots.push(filename);
};
try {
  app = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [{ name: '本地验证模型' }],
    tools: { ready: false, message: '本地界面验证' },
    integrations: { submit: unexpectedProviderCall, poll: unexpectedProviderCall, download: unexpectedProviderCall },
    imageIntegrations: { submitImage: unexpectedProviderCall, downloadImage: unexpectedProviderCall }, textFetcher: unexpectedProviderCall });
  const url = await app.start(0), bootstrap = await (await fetch(url + '/api/bootstrap')).json();
  const send = async (route, method, body) => {
    const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token }, body: JSON.stringify(body) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  };
  let project = await send('/api/projects', 'POST', { title: '画布功能验证', brief: { product: '雨夜书店' } });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  page = await context.newPage(); page.setDefaultTimeout(7000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() === 'POST' && /\/(?:jobs|image-jobs|batches|image-batches|text-chat)$/.test(new URL(request.url()).pathname)) paidRequests.push(request.url());
  });
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 220;
    const ctx = canvas.getContext('2d'), sky = ctx.createLinearGradient(0, 0, 0, 220);
    sky.addColorStop(0, '#173134'); sky.addColorStop(1, '#324e47'); ctx.fillStyle = sky; ctx.fillRect(0, 0, 320, 220);
    ctx.fillStyle = '#102724'; ctx.fillRect(45, 58, 228, 130); ctx.fillStyle = '#d8b36a'; ctx.fillRect(64, 91, 80, 74); ctx.fillRect(166, 91, 82, 74);
    ctx.fillStyle = '#14241c'; ctx.fillRect(196, 91, 4, 74); ctx.fillRect(64, 126, 80, 4);
    ctx.fillStyle = '#d9e2d2'; ctx.font = '18px sans-serif'; ctx.fillText('雨夜书店', 124, 80);
    ctx.strokeStyle = '#aac7c344'; for (let i = 0; i < 35; i++) { ctx.beginPath(); ctx.moveTo(i * 13, 3); ctx.lineTo(i * 13 - 27, 220); ctx.stroke(); }
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const upload = await fetch(url + '/api/projects/' + project.id + '/assets', { method: 'POST',
    headers: { 'X-Studio-Token': bootstrap.token, 'X-File-Name': encodeURIComponent('雨夜场景.png') }, body: Buffer.from(png, 'base64') });
  assert.equal(upload.status, 201); const uploaded = await upload.json(); project = uploaded.project;
  const scene = { id: 'scene-main', title: '书店开场', videoPrompt: '旅行者走入书店，缓慢推镜头，参考@图片1的构图。', duration: 5, references: [] };
  const makeNode = (id, kind, x, y, extra = {}) => ({ id, kind, label: id, x, y, width: 320, height: 260, ...extra });
  project = await send('/api/projects/' + project.id, 'PATCH', { revision: project.revision, scenes: [scene], graph: {
    cardSizeVersion: CARD_SIZE_VERSION, groups: [], links: [], viewport: { x: 0, y: 0, zoom: 1 }, nodes: [
      makeNode('image-source', 'image', 175, 80, { label: '场景参考', assetId: uploaded.asset.id }),
      makeNode('video-source', 'video', 175, 400, { label: '运镜参考', assetName: '镜头运动参考.mp4' }),
      makeNode('shot-target', 'video', 660, 220, { label: '书店开场', sceneId: scene.id }),
    ],
  } });
  const prompt = '一位穿着深色风衣的旅行者，在细雨中走向街角的旧书店，推开木门后进入温暖的灯光。镜头从街道缓慢推进，保持人物外观一致，呈现电影般的构图、自然的光影与细腻的雨水反射。'.repeat(4);
  const chat = [ { role: 'user', content: '请给我一段可以直接使用的提示词。' },
    { role: 'assistant', content: '## 画面提示词\n\n```text\n' + prompt + '\n人物：深色风衣旅行者\n光线：雨夜冷光与书店暖光\n```\n\n| 镜头 | 时长 |\n| --- | --- |\n| 推门进入 | 5 秒 |' } ];
  await page.addInitScript(({ id, chat }) => {
    localStorage.setItem('jingce-active-project', id); localStorage.setItem('jingce-theme', 'day');
    localStorage.setItem('jingce-text-chat-history:' + id, JSON.stringify(chat));
  }, { id: project.id, chat });
  await page.goto(url); await page.waitForSelector('.canvas-node');
  await page.locator('#rename-project').click(); await page.locator('#project-title').fill('雨夜书店 · 分组创作'); await page.locator('#project-title').press('Enter');
  await page.waitForFunction(() => document.querySelector('#project-list').textContent.includes('雨夜书店 · 分组创作'));
  assert.equal(app.store.get(project.id).title, '雨夜书店 · 分组创作'); checkpoint('project rename saved and list synchronized');
  await page.locator('#expand-canvas').click();
  await page.waitForSelector('#canvas-text-host #text-chat-card');
  await page.locator('#text-chat-input').fill('这里保留未发送的创作想法');
  await page.evaluate(() => { window.originalChatCard = document.querySelector('#text-chat-card'); });
  const width = () => page.locator('#canvas-text-panel').evaluate(element => element.getBoundingClientRect().width);
  const initialWidth = await width(), handle = await page.locator('#canvas-text-resizer').boundingBox();
  await page.mouse.move(handle.x + 3, handle.y + handle.height / 2); await page.mouse.down(); await page.mouse.move(handle.x - 127, handle.y + handle.height / 2, { steps: 8 }); await page.mouse.up();
  const wider = await width(); assert.ok(wider - initialWidth > 120);
  report.width = { initial: initialWidth, adjusted: wider };
  await page.locator('#close-canvas-text').click(); await page.locator('#toggle-canvas-text').click();
  assert.equal(await width(), wider); assert.equal(await page.locator('#text-chat-input').inputValue(), '这里保留未发送的创作想法');
  assert.equal(await page.evaluate(() => window.originalChatCard === document.querySelector('#text-chat-card')), true);
  checkpoint('docked chat moves once and remembers resized width');
  const checkWrap = async () => {
    const sizes = await page.locator('.text-chat-message.assistant pre').evaluate(element => ({
      width: element.clientWidth, scroll: element.scrollWidth, height: element.getBoundingClientRect().height,
      whiteSpace: getComputedStyle(element).whiteSpace,
    }));
    assert.equal(sizes.whiteSpace, 'pre-wrap'); assert.ok(sizes.scroll <= sizes.width + 1); assert.ok(sizes.height > 100); return sizes;
  };
  report.wrappedPrompt = await checkWrap(); checkpoint('long fenced prompt wraps and preserves explicit newlines');
  await page.locator('#expand-canvas').click(); await page.locator('#text-tab').click();
  await checkWrap(); await screenshot('standalone-chat');
  const standalonePrompt = await page.locator('.text-chat-message.assistant pre code').textContent();
  assert.ok(standalonePrompt.includes('\n人物：')); assert.ok(standalonePrompt.includes('\n光线：'));
  checkpoint('standalone language model page also wraps prompts with original line breaks');
  await page.locator('#canvas-tab').click(); await page.locator('#expand-canvas').click();
  await screenshot('wide-chat');
  await page.locator('#close-canvas-text').click();
  const ctrlClick = async (from, to) => {
    for (const id of [from, to]) await page.locator('[data-node-id="' + id + '"]').click({ modifiers: ['Control'], position: { x: 80, y: 80 } });
  };
  await ctrlClick('image-source', 'shot-target'); await ctrlClick('video-source', 'shot-target');
  await page.waitForFunction(() => document.querySelectorAll('.canvas-reference-label').length === 2);
  assert.deepEqual(await page.locator('.canvas-reference-label text').allTextContents(), ['图片1', '视频1']);
  assert.equal(await page.locator('.canvas-link.label-visible').count(), 0, '默认状态不显示连线编号');
  await screenshot('reference-labels-default');
  checkpoint('Ctrl ordered card clicks connect image and video references with quiet default labels');
  const promptControl = page.locator('[data-node-id="shot-target"] .shot-prompt');
  const mentionPoint = await promptControl.evaluate(element => {
    const text = element.value, index = text.indexOf('@图片1') + 3, style = getComputedStyle(element);
    const context = document.createElement('canvas').getContext('2d'); context.font = style.font;
    const lines = text.slice(0, index).split('\n'), line = lines.at(-1);
    return {x:element.getBoundingClientRect().left + parseFloat(style.paddingLeft) + context.measureText(line).width,
      y:element.getBoundingClientRect().top + parseFloat(style.paddingTop) + (lines.length - 1) * parseFloat(style.lineHeight) + parseFloat(style.lineHeight) / 2};
  });
  await page.mouse.move(mentionPoint.x, mentionPoint.y);
  assert.deepEqual(await page.locator('.canvas-link.label-visible text').allTextContents(), ['图片1']);
  await screenshot('reference-prompt-hover');
  checkpoint('hovering an @ reference inside prompt text highlights its source edge');
  const imageReference = page.locator('[data-node-id="shot-target"] .shot-reference-item').first();
  await imageReference.hover();
  assert.deepEqual(await page.locator('.canvas-link.label-visible text').allTextContents(), ['图片1']);
  assert.equal(await page.locator('[data-node-id="image-source"]').evaluate(element => element.classList.contains('reference-highlighted')), true);
  await screenshot('reference-labels-hover');
  await page.locator('[data-node-id="shot-target"] .canvas-reference-locate').first().click();
  assert.equal(await page.locator('[data-node-id="image-source"]').evaluate(element => element.classList.contains('selected')), true);
  assert.equal(await page.locator('.canvas-link.label-visible').count(), 0);
  checkpoint('hovering a card reference reveals its exact edge and locate centers its source');
  checkpoint('Ctrl ordered card clicks connect image and video references');
  await page.locator('#zoom-out').click({ clickCount: 11, delay: 40 });
  const recordLabels = async () => {
    const sizes = await page.locator('.canvas-reference-label').evaluateAll(elements => elements.map(element => {
      const rect = element.querySelector('rect'), text = element.querySelector('text');
      return { label: text.textContent, width: Number(rect.getAttribute('width')), height: Number(rect.getAttribute('height')), font: getComputedStyle(text).fontSize };
    }));
    for (const size of sizes) { assert.equal(size.width, 52); assert.equal(size.height, 22); assert.equal(size.font, '11px'); }
    assert.equal(await page.locator('.canvas-link.label-visible').count(), 0, '编号应在未聚焦时隐藏');
    report.labelSizes.push({ zoom: await page.locator('#zoom-level').textContent(), sizes });
  };
  await recordLabels(); await page.locator('#zoom-level').click(); await recordLabels();
  for (let i = 0; i < 7; i++) await page.locator('#zoom-in').click(); await recordLabels();
  const hoverFirstLink = async expected => {
    await page.locator('.canvas-link-hit').first().hover();
    assert.equal(await page.locator('.canvas-link.label-visible').count(), expected);
    if (expected) {
      const box = await page.locator('.canvas-link.label-visible rect').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return {width:rect.width,height:rect.height,cssTransform:getComputedStyle(element).transform,
          parentTransform:element.parentElement.getAttribute('transform'),zoom:document.querySelector('#zoom-level').textContent};
      });
      assert.ok(Math.abs(box.width - 52) < .1 && Math.abs(box.height - 22) < .1, JSON.stringify(box));
    }
  };
  await hoverFirstLink(1);
  await page.locator('#zoom-level').click();
  await hoverFirstLink(1);
  await page.locator('#zoom-level').click();
  for (let i = 0; i < 11; i++) await page.locator('#zoom-out').click();
  await hoverFirstLink(0);
  checkpoint('reference labels hide by default, show one at a time, and stay compact at usable zoom');
  await page.locator('#zoom-level').click();
  await page.locator('#canvas-viewport').click({ position: { x: 1050, y: 480 } });
  const first = await page.locator('[data-node-id="image-source"]').boundingBox(), target = await page.locator('[data-node-id="shot-target"]').boundingBox();
  await page.mouse.move(first.x - 30, Math.min(first.y, target.y) - 20); await page.mouse.down({ button: 'right' });
  await page.mouse.move(target.x + target.width + 20, target.y + target.height + 20, { steps: 10 }); await page.mouse.up({ button: 'right' });
  await page.locator('#create-canvas-group').click();
  await page.waitForSelector('.canvas-group-header');
  await page.locator('[data-canvas-group-field="label"]').fill('场景与视频'); await page.locator('[data-canvas-group-field="label"]').press('Enter');
  const groupBefore = await page.locator('[data-node-id="image-source"]').boundingBox();
  const grip = await page.locator('.canvas-group-header > span').first().boundingBox();
  await page.mouse.move(grip.x + 5, grip.y + 7); await page.mouse.down(); await page.mouse.move(grip.x + 45, grip.y + 37, { steps: 6 }); await page.mouse.up();
  const groupAfter = await page.locator('[data-node-id="image-source"]').boundingBox();
  assert.ok(Math.abs(groupAfter.x - groupBefore.x - 40) < 2); assert.ok(Math.abs(groupAfter.y - groupBefore.y - 30) < 2);
  await page.locator('#undo-canvas').click(); const undone = await page.locator('[data-node-id="image-source"]').boundingBox(); assert.ok(Math.abs(undone.x - groupBefore.x) < 2);
  await page.locator('#redo-canvas').click();
  await page.waitForFunction(() => document.querySelector('#save-state').textContent.includes('已保存'));
  const savedGroup = app.store.get(project.id).graph.groups[0]; assert.equal(savedGroup.label, '场景与视频'); assert.ok(savedGroup.nodeIds.length >= 2);
  checkpoint('marquee groups, name edits, shared movement and undo persist');
  await screenshot('groups-day');
  await page.locator('#expand-canvas').click(); await page.locator('#theme-select').selectOption('night'); await page.locator('#expand-canvas').click();
  await page.locator('#close-canvas-text').click(); await screenshot('groups-night');
  await page.locator('#expand-canvas').click(); await page.locator('#theme-select').selectOption('day'); await page.locator('#expand-canvas').click();
  await screenshot('fullscreen-day');
  const selectPrompt = async () => {
    await page.locator('.text-chat-message.assistant pre').scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const code = document.querySelector('.text-chat-message.assistant pre code'), range = document.createRange();
      range.selectNodeContents(code); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await page.waitForSelector('#text-selection-actions:not([hidden])');
    return page.evaluate(() => getSelection().toString().trim());
  };
  const imagePrompt = await selectPrompt(); await page.locator('[data-selection-draft="image"]').click();
  assert.equal(await page.locator('[data-image-field="prompt"]').inputValue(), imagePrompt);
  const videoPrompt = await selectPrompt(); await page.locator('[data-selection-draft="video"]').click();
  const videoInputs = page.locator('[data-shot-field="videoPrompt"]');
  assert.ok((await videoInputs.evaluateAll(elements => elements.map(element => element.value))).includes(videoPrompt)); checkpoint('selected reply creates editable image and video cards without generation');
  await page.locator('#expand-canvas').click(); await page.locator('#theme-select').selectOption('night'); await page.locator('#expand-canvas').click();
  await screenshot('fullscreen-night');
  await page.setViewportSize({ width: 820, height: 900 }); await checkWrap(); await screenshot('narrow-chat');
  await page.setViewportSize({ width: 390, height: 844 }); await checkWrap();
  assert.ok(await width() <= 340); await screenshot('mobile-chat'); checkpoint('day night and narrow layouts keep prompts wrapped and controls usable');
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.reload(); await page.waitForSelector('.canvas-group-header');
  assert.equal(await page.locator('[data-canvas-group-field="label"]').inputValue(), '场景与视频');
  await page.locator('#expand-canvas').click(); assert.equal(await width(), wider);
  checkpoint('reloading restores groups and preferred chat width');
  await page.locator('#fit-canvas').click();
  await screenshot('final-preview');
  assert.deepEqual(errors, []); assert.deepEqual(paidRequests, []); assert.equal(providerCalls, 0);
  report.providerCalls = providerCalls; report.paidRequests = paidRequests.length; report.browserErrors = errors;
  report.savedProject = { title: app.store.get(project.id).title, cards: app.store.get(project.id).graph.nodes.length, groups: app.store.get(project.id).graph.groups.length };
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack; report.browserErrors = errors;
  if (page) await screenshot('failure').catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'canvas-enhancements-verification-20261010.json'), JSON.stringify(report, null, 2));
  if (browser) await browser.close(); if (app) await app.close();
}
