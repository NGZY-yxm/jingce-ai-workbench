import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStudio } from '../server.mjs';
import { createProject } from '../lib/workflow.mjs';

const { chromium } = await import(process.env.JINGCE_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.JINGCE_PLAYWRIGHT_MODULE).href : 'playwright');
const output = path.resolve(process.argv[2] || 'outputs/connection-center-qa-20261012');
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-connection-center-browser-'));
const models = { image: 'gpt-image-2.5-flare', text: 'language-first', video: 'seedance-2.0-fast-933-720P（次）' };
const calls = [], browserErrors = [], generationRequests = [];
let releaseSlow, slowStarted;
const slowStart = new Promise(resolve => { slowStarted = resolve; });
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
const fetcher = kind => async (url, options = {}) => {
  const key = options.headers?.Authorization?.replace(/^Bearer /, '') || options.headers?.['x-goog-api-key'] || '';
  calls.push({ kind, url, method: options.method || 'GET' });
  assert.equal(options.method || 'GET', 'GET', 'Verification must never submit generation');
  if (key === 'delayed-text-secret') {
    slowStarted(); await new Promise(resolve => { releaseSlow = resolve; });
    return reply({ data: [{ id: 'delayed-text-model' }] });
  }
  if (key === 'invalid-text-secret') return reply({ error: { message: 'invalid invalid-text-secret' } }, 401);
  if (url.endsWith('/model-plaza')) return reply({ data: { groups: [{ models: [{ name: models.image, pricing: { billing_mode: 'image' } }] }] } });
  if (url.includes('/v1beta/')) return reply({ models: [{ name: 'models/gemini-3-pro-image-preview' }] });
  return reply({ data: [{ id: models[kind] }] });
};
const app = await createStudio({ root, tools: { ready: false }, textCatalog: [],
  imageFetcher: fetcher('image'), textFetcher: fetcher('text'), videoFetcher: fetcher('video') });
await app.store.mutate(state => {
  const project = createProject({ title: '连接中心验证' });
  project.scenes.push({ id: 'verification-scene', title: '模型选择验证', order: 1, duration: 5, videoPrompt: '', references: [] });
  state.projects.push(project);
});
const url = await app.start(0);
const browser = await chromium.launch({ headless: true, channel: process.env.JINGCE_BROWSER_CHANNEL || 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
page.on('pageerror', error => browserErrors.push(error.message));
page.on('request', request => {
  if (request.method() === 'POST' && /\/(?:text-chat|image-jobs|jobs|batches|image-batches)$/.test(new URL(request.url()).pathname)) generationRequests.push(request.url());
});
const save = async () => {
  await page.locator('#connection-editor [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#connections-center-message').textContent.includes('模型目录已刷新'));
  await page.waitForFunction(() => !document.querySelector('#connection-editor [type=submit]').disabled);
};
try {
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#save-state')?.textContent.includes('已保存'));
  await page.locator('#connections-center-button').click();
  const saved = [];
  for (const kind of ['image', 'text', 'video']) {
    await page.locator('#center-add').click();
    await page.locator('#connection-editor [name=name]').fill(kind + ' 接口验证');
    await page.locator('#connection-editor [name=kind]').selectOption(kind);
    await page.locator('#connection-editor [name=apiKey]').fill(kind + '-browser-secret');
    if (kind === 'video') await page.locator('#connection-editor [name=baseUrl]').selectOption('https://direct.beibeihai.xyz');
    await page.locator('#center-read-models').click();
    await page.waitForFunction(() => document.querySelector('#center-editor-message').textContent.includes('此令牌返回 1 个模型'));
    assert.equal(await page.locator('#connection-editor [name=models] option').count(), 1);
    await page.locator('#center-model-choices input').check();
    assert.equal(await page.locator('#center-model-count').textContent(), '已选 1 个');
    await page.screenshot({ path: path.join(output, kind + '-editor-desktop.png'), fullPage: true });
    await save();
    const bootstrap = await (await fetch(url + '/api/bootstrap')).json();
    const catalog = kind === 'image' ? bootstrap.imageCatalog : kind === 'text' ? bootstrap.textCatalog : bootstrap.catalog;
    assert.ok(catalog.some(model => model.name === models[kind]), kind + ' is immediately available');
    const connections = await (await fetch(url + '/api/connections')).json();
    const connection = connections.find(item => item.kind === kind);
    assert.deepEqual(connection.models, [models[kind]]);
    assert.ok(!JSON.stringify({ bootstrap, connections }).includes('-browser-secret'));
    saved.push({ kind, id: connection.id, model: models[kind] });
  }
  const video = saved.find(item => item.kind === 'video');
  await page.locator('[data-edit-connection="' + video.id + '"]').click();
  await page.waitForFunction(() => document.querySelector('#center-editor-message').textContent.includes('此令牌返回 1 个模型'));
  assert.equal(await page.locator('#connection-editor [name=apiKey]').inputValue(), '');
  assert.equal(await page.locator('#connection-editor [name=baseUrl]').inputValue(), 'https://direct.beibeihai.xyz');
  await page.locator('#center-read-models').click();
  await page.waitForFunction(() => !document.querySelector('#center-read-models').disabled);
  assert.equal(await page.locator('#connection-editor [name=baseUrl]').inputValue(), 'https://direct.beibeihai.xyz');
  await save();
  assert.equal((await app.store.connections()).find(item => item.id === video.id).apiKey, 'video-browser-secret');
  await page.screenshot({ path: path.join(output, 'saved-connections-desktop.png'), fullPage: true });
  await page.locator('#connections-center-close').click();
  await page.locator('#text-tab').click();
  assert.ok(await page.locator('#text-chat-model option').evaluateAll(items => items.some(item => item.value === 'language-first')));
  await page.locator('#videos-tab').click();
  assert.ok(await page.locator('#scene-list [data-scene-field=videoModel] option').evaluateAll(items => items.some(item => item.value.startsWith('seedance-2.0-fast-933'))));
  await page.locator('#connections-center-button').click();
  await page.locator('#center-add').click();
  await page.locator('#connection-editor [name=kind]').selectOption('text');
  await page.locator('#connection-editor [name=apiKey]').fill('invalid-text-secret');
  await page.locator('#center-read-models').click();
  await page.waitForFunction(() => document.querySelector('#center-editor-message').textContent.includes('模型查询失败'));
  assert.ok(!(await page.locator('#center-editor-message').textContent()).includes('invalid-text-secret'));
  const beforeCancel = await readFile(path.join(root, 'connections.private.json'), 'utf8');
  await page.locator('#connection-editor [name=apiKey]').fill('delayed-text-secret');
  await page.locator('#center-read-models').click(); await slowStart;
  await page.locator('#connection-editor [name=kind]').selectOption('video');
  assert.equal(await page.locator('#connection-editor [name=models] option').evaluateAll(items => items.some(item => item.value.includes('language'))), false);
  releaseSlow();
  await page.waitForResponse(response => response.url().endsWith('/api/connections/models') && response.ok());
  assert.equal(await page.locator('#connection-editor [name=models] option').evaluateAll(items => items.some(item => item.value.includes('delayed-text'))), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#connection-editor [name=apiKey]').fill('video-mobile-secret');
  await page.locator('#center-read-models').click();
  await page.waitForFunction(() => document.querySelector('#center-editor-message').textContent.includes('此令牌返回 1 个模型'));
  await page.screenshot({ path: path.join(output, 'video-editor-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.locator('#center-editor-cancel').click();
  assert.equal(await readFile(path.join(root, 'connections.private.json'), 'utf8'), beforeCancel);
  assert.deepEqual(browserErrors, []); assert.deepEqual(generationRequests, []);
  const report = { url, saved, browserErrors, generationRequests: generationRequests.length, upstreamRequests: calls.length,
    upstreamGenerationRequests: calls.filter(call => call.method !== 'GET').length,
    checks: ['首次添加图片语言视频接口', '读取目录前无需保存', '勾选绑定并保存', '创作页面立即可选', '编辑留空保留密钥', '直连地址保留', '错误脱敏', '类型切换丢弃迟到响应', '取消不写配置', '390px 无横向溢出'] };
  await writeFile(path.join(output, 'browser-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  releaseSlow?.(); await browser.close(); await app.close(); await rm(root, { recursive: true, force: true });
}
