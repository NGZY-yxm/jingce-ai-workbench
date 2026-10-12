import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createStudio } from '../server.mjs';
import { createProject } from '../lib/workflow.mjs';

const require = createRequire(path.join(process.env.JINGCE_BROWSER_MODULES || process.cwd(), 'package.json'));
const { chromium } = require('playwright');
const sharp = require('sharp');
const Zip = require('jszip');
const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-skills-browser-'));
const output = path.resolve(process.argv[2] || 'outputs/skills-images-verification');
await mkdir(output, { recursive: true });
const picture = await sharp({ create: { width: 960, height: 640, channels: 3, background: '#e3e8e4' } }).composite([
  { input: await sharp({ create: { width: 300, height: 430, channels: 3, background: '#ca575d' } }).png().toBuffer(), left: 100, top: 100 },
  { input: await sharp({ create: { width: 350, height: 260, channels: 3, background: '#3e8178' } }).png().toBuffer(), left: 450, top: 220 },
]).png().toBuffer();
const source = 'data:image/png;base64,' + picture.toString('base64');
const requests = [], errors = [];
const app = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [{ name: 'test-text-image' }], tools: { ready: false },
  textFetcher: async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    const last = request.messages.at(-1).content;
    const content = last.includes('长输入末尾') ? '完整回复'.repeat(9000) + '长回复末尾'
      : last.includes('只返回图片') ? [{ type: 'image_url', image_url: { url: source }, name: '纯图片结果' }]
      : [{ type: 'text', text: '分镜参考图\n\n| 镜头 | 时长 |\n|---|---:|\n| 开场 | 5 秒 |' },
        { type: 'image_url', image_url: { url: source }, name: '分镜参考图' }];
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } });
  } });
await app.store.saveTextSettings({ baseUrl: 'https://sub.beibeihai.xyz/v1', apiKey: 'browser-fixture-key', textModel: 'test-text-image' });
const project = createProject({ title: '技能与图片验证' });
await app.store.mutate(state => { state.projects.push(project); });
const url = await app.start(0);
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', error => errors.push(error.message));
const pauseUntil = async predicate => {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Browser verification timed out');
};
const savedProject = async () => (await fetch(`${url}/api/projects/${project.id}`)).json();
try {
  await page.goto(url); await page.locator('#skills-tab').waitFor();
  await page.waitForFunction(() => document.querySelector('#save-state')?.textContent.includes('已保存'));
  await page.locator('#skills-tab').click();
  const archive = new Zip();
  archive.file('storyboard/SKILL.md', '---\nname: 电影分镜\ndescription: 为广告整理分镜和图片提示词。\nlicense: MIT\n---\n\n先识别主体，再规划镜头。保持角色一致。');
  archive.file('storyboard/references/format.md', '资料标记：每个镜头包含画面、动作、运镜与光线。');
  archive.file('storyboard/scripts/check.py', 'print("external dependency")');
  await page.locator('#skill-file-input').setInputFiles({ name: 'storyboard.zip', mimeType: 'application/zip', buffer: await archive.generateAsync({ type: 'nodebuffer' }) });
  await page.locator('#skill-import-dialog[open]').waitFor();
  assert.match(await page.locator('#skill-import-preview').innerText(), /含外部依赖/);
  await page.locator('#skill-confirm-import').click();
  await page.locator('.skill-row').waitFor();
  const skillId = await page.locator('.skill-row').getAttribute('data-skill-id');
  await page.locator('#skill-name').fill('电影分镜与图片');
  await page.locator('#skill-save').click();
  await pauseUntil(async () => (await (await fetch(url + `/api/skills/${skillId}`)).json()).name === '电影分镜与图片');
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#skill-export').click();
  const skillDownload = await downloadEvent;
  const downloadPath = path.join(output, 'exported-skill.zip');
  await skillDownload.saveAs(downloadPath);
  const exported = await Zip.loadAsync(await (await import('node:fs/promises')).readFile(downloadPath));
  assert.equal(await exported.file('skill/scripts/check.py').async('string'), 'print("external dependency")');
  assert.match(await exported.file('skill/references/format.md').async('string'), /资料标记/);
  await page.screenshot({ path: path.join(output, 'skills-desktop.png'), fullPage: true });
  await page.locator('#text-tab').click();
  await page.locator('#text-chat-skill').selectOption(skillId);
  await page.locator('#text-chat-input').fill('为广告提供分镜和参考图片。');
  await page.locator('#text-chat-form button[type=submit]').click();
  await page.locator('.chat-image-preview img').waitFor();
  await page.waitForFunction(() => document.querySelector('.chat-image-preview img')?.naturalWidth === 960);
  assert.match(requests[0].messages[0].content, /资料标记/);
  assert.equal(await page.locator('.text-markdown table').count(), 1);
  await page.screenshot({ path: path.join(output, 'assistant-image-desktop.png'), fullPage: true });
  await page.locator('[data-chat-image-action=save]').click();
  await pauseUntil(async () => (await savedProject()).assets.length === 1);
  await page.locator('#canvas-tab').click();
  await page.locator('#expand-canvas').click();
  await page.locator('#toggle-canvas-text').click();
  await page.locator('#canvas-text-panel').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#canvas-text-host #text-chat-skill').inputValue(), skillId);
  const image = page.locator('#canvas-text-host .chat-image-preview img');
  await image.dragTo(page.locator('#canvas-viewport'), { targetPosition: { x: 180, y: 220 } });
  await pauseUntil(async () => (await savedProject()).graph.nodes.some(node => node.assetId));
  assert.equal((await savedProject()).assets.length, 1);
  await page.screenshot({ path: path.join(output, 'canvas-image-desktop.png'), fullPage: true });
  await page.locator('#expand-canvas').click();
  await page.locator('.canvas-creation-toolbar [data-canvas-add=ai]').click();
  const card = page.locator('.node-kind-ai');
  await card.locator('[data-ai-field=skillId]').selectOption(skillId);
  const instruction = '长输入'.repeat(5000) + '长输入末尾';
  await card.locator('[data-ai-field=instruction]').fill(instruction);
  assert.equal(await card.locator('[data-ai-field=instruction]').getAttribute('maxlength'), null);
  assert.equal(await card.locator('[data-ai-field=output]').getAttribute('maxlength'), null);
  await card.locator('[data-card-action=ai-run]').click();
  await pauseUntil(async () => (await card.locator('[data-ai-field=output]').inputValue()).endsWith('长回复末尾'));
  await pauseUntil(async () => (await savedProject()).graph.nodes.find(node => node.kind === 'ai')?.aiConfig.output.endsWith('长回复末尾'));
  assert.ok((await card.locator('[data-ai-field=output]').inputValue()).length > 16000);
  assert.match(requests[1].messages.at(-1).content, /长输入末尾/);
  assert.match(requests[1].messages[0].content, /资料标记/);
  await card.locator('[data-ai-field=instruction]').fill('只返回图片');
  await card.locator('[data-card-action=ai-run]').click();
  await card.locator('.chat-image-preview img').waitFor();
  await page.waitForFunction(() => document.querySelector('.node-kind-ai .chat-image-preview img')?.naturalWidth === 960);
  await pauseUntil(async () => (await savedProject()).graph.nodes.find(node => node.kind === 'ai')?.aiConfig.images.length === 1);
  assert.equal((await savedProject()).graph.nodes.find(node => node.kind === 'ai').aiConfig.status, 'done');
  await card.locator('[data-chat-image-action=save]').click();
  await pauseUntil(async () => (await savedProject()).assets.length === 2);
  await card.locator('[data-ai-field=output]').fill('完整回复'.repeat(9000) + '长回复末尾');
  await card.locator('[data-ai-field=output]').blur();
  await pauseUntil(async () => (await savedProject()).graph.nodes.find(node => node.kind === 'ai')?.aiConfig.output.endsWith('长回复末尾'));
  await page.locator('#skills-tab').click(); await page.locator('.skill-row').click();
  await page.locator('#skill-delete').click();
  await pauseUntil(async () => (await (await fetch(url + '/api/skills')).json()).length === 0);
  await page.locator('#skill-restore').click();
  await pauseUntil(async () => (await (await fetch(url + '/api/skills')).json()).length === 1);
  await page.reload(); await page.locator('#text-tab').click();
  assert.equal(await page.locator('#text-chat-skill').inputValue(), skillId);
  await page.waitForFunction(() => document.querySelector('.chat-image-preview img')?.naturalWidth === 960);
  await page.locator('#text-chat-input').fill('再提供一张参考图片。');
  await page.locator('#text-chat-form button[type=submit]').click();
  await pauseUntil(async () => (await page.locator('.chat-image-preview img').count()) === 2);
  await page.locator('[data-chat-image-action=place]').last().click();
  await pauseUntil(async () => (await savedProject()).assets.length === 3);
  await page.locator('#text-tab').click(); await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('#toast')?.hidden || !document.querySelector('#toast')?.classList.contains('visible'));
  await page.screenshot({ path: path.join(output, 'assistant-image-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile document overflows');
  await page.locator('#skills-tab').click(); await page.locator('.skill-row').click();
  await page.screenshot({ path: path.join(output, 'skills-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile skill library overflows');
  assert.equal(requests.length, 4); assert.deepEqual(errors, []);
  const report = { skillId, modelRequests: requests.length, assets: (await savedProject()).assets.length,
    longInstructionCharacters: instruction.length, longOutputCharacters: (await savedProject()).graph.nodes.find(node => node.kind === 'ai').aiConfig.output.length,
    browserErrors: errors, verified: ['ZIP import and export', 'reference loading', 'skill selection in all three entry points', 'image rendering', 'AI card image-only reply', 'material import', 'native image drag', 'canvas insertion', 'long AI text', 'skill delete/restore', 'reload persistence', 'desktop/mobile layout'] };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  console.error(JSON.stringify({ errors, toast: await page.locator('#toast').innerText(), saveState: await page.locator('#save-state').innerText() }));
  throw error;
} finally { await browser.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
