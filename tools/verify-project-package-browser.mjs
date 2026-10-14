import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createStudio } from '../server.mjs';
import { updateProject } from '../lib/workflow.mjs';
const require = createRequire(import.meta.url);
const runtime = process.env.JINGCE_WORKSPACE_MODULES || path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules');
const { chromium } = require(path.join(runtime, 'playwright'));
const sharp = require(path.join(runtime, 'sharp'));
const root = await mkdtemp(path.join(os.tmpdir(), 'miraframe-sharing-browser-')), output = path.resolve('outputs/project-package-qa');
await mkdir(output, { recursive: true });
const db = new DatabaseSync(path.join(root, 'users.db'));
db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT UNIQUE, password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, email_verified_at TEXT, last_login_at TEXT, last_activity_at TEXT)');
for (const name of ['creator', 'friend']) db.prepare('INSERT INTO users(username,email,password_hash) VALUES(?,?,?)').run(name, `${name}@example.test`, await bcrypt.hash('fixture-password', 4));
db.close();
const origin = 'https://package.example.test', errors = [], generationRequests = [], checks = [];
const png = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#244551' } }).composite([{ input: Buffer.from('<svg width="640" height="360"><rect x="180" y="85" width="280" height="210" rx="12" fill="#ddb96e"/><rect x="205" y="120" width="230" height="100" fill="#30413c"/><text x="320" y="178" fill="#ffe5ad" text-anchor="middle" font-size="34" font-family="sans-serif">BOOK SHOP</text></svg>') }]).png().toBuffer();
let app, browser;
try {
  const unexpected = async () => { throw new Error('Browser sharing tests never submit generation'); };
  app = await createStudio({ root, multiUser: true, publicOrigin: origin, catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false },
    auth: { databasePath: path.join(root, 'users.db') }, thumbnails: { render: async (source, target) => sharp(source).resize(512, 512, { fit: 'inside' }).png().toFile(target) }, integrations: { submit: unexpected, poll: unexpected }, imageIntegrations: { submitImage: unexpected } });
  const url = await app.start(0);
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  async function login(name) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await context.route(origin + '/**', async route => {
      const uri = new URL(route.request().url()), headers = await route.request().allHeaders(); headers.host = new URL(origin).host;
      const response = await route.fetch({ url: url + uri.pathname + uri.search, headers }); await route.fulfill({ response });
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST' && /\/(jobs|batches|image-jobs|image-batches|text-chat|speech-jobs)(?:\?|$)/.test(new URL(request.url()).pathname)) generationRequests.push(request.url()); });
    await page.goto(origin);
    await page.waitForFunction(() => typeof document.querySelector('#login-form').onsubmit === 'function');
    await page.locator('#login-form [name=email]').fill(name + '@example.test');
    await page.locator('#login-form [name=password]').fill('fixture-password');
    await page.locator('#login-form [type=submit]').click();
    await page.locator('.workspace').waitFor({ state: 'visible' });
    return page;
  }
  const creator = await login('creator');
  const send = (page, route, method = 'GET', body) => page.evaluate(async ({ route, method, body }) => {
    const boot = await (await fetch('/api/bootstrap')).json();
    const response = await fetch(route, { method, headers: { 'Content-Type': 'application/json', 'X-Studio-Token': boot.token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
  }, { route, method, body });
  const skill = (await send(creator, '/api/skills/import', 'POST', { files: [{ path: 'SKILL.md', content: '---\nname: 书店镜头规则\ndescription: 帮助朋友继续编辑\n---\n保持暖色灯光，主体外观一致。' }] }))[0];
  let project = await send(creator, '/api/projects', 'POST', { title: '书店短片 · 朋友共享工程' });
  const current = app.contexts.get(1);
  const asset = { id: randomUUID(), name: '书店画面参考.png', file: randomUUID() + '.png', kind: 'image', mime: 'image/png', source: 'upload', size: png.length, createdAt: project.createdAt };
  await writeFile(path.join(current.store.root, 'assets', asset.file), png);
  const requestId = randomUUID();
  await writeFile(path.join(current.store.root, 'text-results', requestId + '.json'), JSON.stringify({ projectId: project.id, images: [{ name: 'AI 书店参考图', source: 'data:image/png;base64,' + png.toString('base64') }] }));
  project = await current.store.update(project.id, previous => {
    previous.assets.push(asset);
    return updateProject(previous, { revision: previous.revision, graph: { nodes: [
      { id: 'shared-note', kind: 'text', label: '创作想法', note: '一个人在雨夜走进书店。', x: 50, y: 80 },
      { id: 'reference', kind: 'image', label: '画面参考', assetId: asset.id, x: 470, y: 80 },
      { id: 'ai-card', kind: 'ai', label: '下一镜头草稿', x: 50, y: 630, aiConfig: { instruction: '继续完善书店镜头', output: '让暖色灯光照亮人物，缓慢推进。', status: 'done', skillId: skill.id,
        images: [{ requestId, index: 0, name: 'AI 书店参考图' }] } },
    ], links: [{ id: 'idea-link', from: 'shared-note', to: 'ai-card' }], groups: [{ id: 'opening', label: '开场素材', nodeIds: ['shared-note', 'reference'], color: '#567987' }], viewport: { x: 0, y: 0, zoom: 0.75 } } });
  });
  await creator.reload();
  await creator.locator(`[data-open-project="${project.id}"]`).click();
  await creator.locator('#export-project-package').waitFor({ state: 'visible' });
  await creator.locator('[data-node-id="shared-note"] .canvas-cover-drag').click();
  const edit = creator.locator('[data-node-id="shared-note"] [data-node-field="note"]');
  await edit.fill('朋友接着编辑：人物推门进入书店，雨滴落在门口。');
  const downloadEvent = creator.waitForEvent('download');
  await creator.locator('#export-project-package').click();
  const download = await downloadEvent, archivePath = path.join(output, download.suggestedFilename());
  assert.match(download.suggestedFilename(), /\.miraframe\.zip$/); await download.saveAs(archivePath);
  checks.push('真实点击导出，未保存文字先保存，下载一个含素材的工程包');
  const friend = await login('friend');
  assert.equal((await send(friend, '/api/projects')).length, 0);
  const inaccessible = await friend.evaluate(async id => (await fetch('/api/projects/' + id)).status, project.id); assert.equal(inaccessible, 404);
  const fileChooserEvent = friend.waitForEvent('filechooser'); await friend.locator('#overview-import').click();
  const chooser = await fileChooserEvent; await chooser.setFiles(archivePath);
  await friend.locator('#toast').filter({ hasText: '工程已导入' }).waitFor({ state: 'visible' });
  const imported = (await send(friend, '/api/projects'))[0];
  assert.notEqual(imported.id, project.id); assert.equal(imported.assets.length, 2);
  assert.equal(imported.graph.nodes.find(node => node.id === 'shared-note').note, '朋友接着编辑：人物推门进入书店，雨滴落在门口。');
  assert.deepEqual(imported.graph.groups, project.graph.groups); assert.deepEqual(imported.graph.viewport, project.graph.viewport);
  const preview = imported.graph.nodes.find(node => node.id === 'ai-card').aiConfig.images[0]; assert.notEqual(preview.requestId, requestId);
  const ai = imported.graph.nodes.find(node => node.id === 'ai-card'); assert.notEqual(ai.aiConfig.skillId, skill.id);
  assert.equal((await send(friend, '/api/skills/' + ai.aiConfig.skillId)).name, '书店镜头规则');
  const imageStatus = await friend.evaluate(async preview => { const response = await fetch(preview.previewUrl); return { status: response.status, size: (await response.arrayBuffer()).byteLength }; }, preview);
  assert.equal(imageStatus.status, 200); assert.equal(imageStatus.size, png.length);
  await friend.waitForFunction(() => { const img = document.querySelector('[data-node-id="reference"] .canvas-cover img'); return img?.complete && img.naturalWidth > 0; });
  await friend.locator('[data-node-id="ai-card"] .canvas-cover-drag').click();
  assert.equal(await friend.locator('[data-node-id="ai-card"] [data-ai-field="skillId"]').inputValue(), ai.aiConfig.skillId);
  await friend.locator('[data-node-id="ai-card"] .chat-image-preview').scrollIntoViewIfNeeded();
  await friend.waitForFunction(() => { const img = document.querySelector('[data-node-id="ai-card"] .chat-image-preview img'); return img?.complete && img.naturalWidth > 0; });
  checks.push('第二个登录账号导入新工程，卡片、分组、连线、文字、技能和 AI 回复图片恢复');
  const initialCount = imported.assets.length;
  await friend.reload(); await friend.locator('#export-project-package').waitFor({ state: 'visible' });
  assert.equal((await send(friend, '/api/projects/' + imported.id)).assets.length, initialCount);
  await friend.waitForFunction(() => { const img = document.querySelector('[data-node-id="reference"] .canvas-cover img'); return img?.complete && img.naturalWidth > 0; });
  const dayShot = path.join(output, 'friend-imported-day.png');
  await friend.locator('#theme-select').selectOption('day'); await friend.screenshot({ path: dayShot, fullPage: true });
  await friend.locator('#theme-select').selectOption('night'); await friend.screenshot({ path: path.join(output, 'friend-imported-night.png'), fullPage: true });
  await friend.setViewportSize({ width: 900, height: 800 });
  await friend.screenshot({ path: path.join(output, 'friend-imported-narrow.png'), fullPage: true });
  for (const id of ['canvas-import-project', 'export-project-package', 'expand-canvas']) {
    const box = await friend.locator('#' + id).boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= 900, 'Button remains visible: ' + id);
  }
  await friend.setViewportSize({ width: 1440, height: 1000 });
  await friend.locator('[data-node-id="shared-note"] .canvas-cover-drag').click();
  const friendEdit = friend.locator('[data-node-id="shared-note"] [data-node-field="note"]');
  await friendEdit.fill('朋友已继续修改的新镜头。'); await friendEdit.blur();
  await friend.locator('#save-state').filter({ hasText: '已保存' }).waitFor();
  assert.equal((await send(creator, '/api/projects/' + project.id)).graph.nodes.find(node => node.id === 'shared-note').note, '朋友接着编辑：人物推门进入书店，雨滴落在门口。');
  checks.push('刷新后继续编辑，源工程不受影响，白天/夜晚/窄屏按钮可见');
  const repeatChooser = friend.waitForEvent('filechooser'); await friend.locator('#canvas-import-project').click(); await (await repeatChooser).setFiles(archivePath);
  await friend.waitForFunction(async () => (await (await fetch('/api/projects')).json()).length === 2);
  assert.equal((await send(creator, '/api/projects')).length, 1);
  checks.push('重复导入创建独立副本，不覆盖朋友已修改的工程');
  assert.deepEqual(generationRequests, []); assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks, browser: browser.version(), pageErrors: errors, generationRequests, archivePath }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, output }, null, 2));
} catch (error) {
  await writeFile(path.join(output, 'failure.txt'), String(error.stack)); throw error;
} finally {
  if (browser) await browser.close(); if (app) await app.close();
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('miraframe-sharing-browser-')) throw new Error('Unexpected temporary directory');
  await rm(root, { recursive: true, force: true });
}
