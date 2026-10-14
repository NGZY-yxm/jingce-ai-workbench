// Real browser against a disposable gateway and shared-identity fixture. No production users or providers are touched.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createStudio } from '../server.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.JINGCE_PLAYWRIGHT_MODULE || 'playwright');
const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-management-browser-'));
const db = new DatabaseSync(path.join(root, 'users.db'));
db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT UNIQUE,
  password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, email_verified_at TEXT, last_login_at TEXT, last_activity_at TEXT);`);
for (const name of ['owner', 'member']) db.prepare('INSERT INTO users(username,email,password_hash) VALUES(?,?,?)').run(name, name + '@example.com', await bcrypt.hash('original-password', 4));
await writeFile(path.join(root, 'storage.private.json'), JSON.stringify({ provider: 'r2', bucket: 'test-bucket', endpoint: 'https://' + 'a'.repeat(32) + '.r2.cloudflarestorage.com', enabled: true, region: 'auto', prefix: 'jingce', expiresHours: 72, secretId: 'secret-id', secretKey: 'secret-key' }));
const codes = new Map(), errors = [], origin = 'https://management.example.test';
let app, browser;
const pass = message => console.log('PASS ' + message);
try {
  app = await createStudio({ root, multiUser: true, publicOrigin: origin, catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false },
    auth: { databasePath: path.join(root, 'users.db'), sendCode: async (email, code) => codes.set(email, code) }, management: { adminEmail: 'owner@example.com' } });
  const url = await app.start(0);
  browser = await chromium.launch({ headless: true, channel: process.env.JINGCE_BROWSER_CHANNEL || 'msedge' });
  const makePage = async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route(origin + '/**', async route => {
      const uri = new URL(route.request().url()), headers = await route.request().allHeaders(); headers.host = new URL(origin).host;
      const response = await route.fetch({ url: url + uri.pathname + uri.search, headers }); await route.fulfill({ response });
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
    await page.goto(origin); return page;
  };
  const login = async (page, name, password = 'original-password') => {
    await page.waitForFunction(() => typeof document.querySelector('#login-form').onsubmit === 'function' && document.querySelector('#forgot-password'));
    await page.locator('#login-form [name=email]').fill(name + '@example.com'); await page.locator('#login-form [name=password]').fill(password);
    await page.locator('#login-form [type=submit]').click();
    try { await page.locator('.workspace').waitFor({ state: 'visible' }); }
    catch (error) { console.log('LOGIN DIAGNOSTICS', await page.locator('#auth-message').textContent(), JSON.stringify(errors)); throw error; }
  };
  const navigate = async (page, tab) => { await page.locator(`#management-dialog .portal-nav [data-tab="${tab}"]`).click(); await page.locator('#management-dialog .portal-content h3').first().waitFor(); };
  const member = await makePage(); await login(member, 'member');
  assert.equal(await member.locator('#admin-center').isVisible(), false);
  await member.locator('#connections-center-button').click(); await member.locator('#connections-center').waitFor({ state: 'visible' }); assert.equal(await member.locator('#center-storage-tab').isVisible(), false); await member.keyboard.press('Escape'); await member.locator('#connections-center').waitFor({ state: 'hidden' });
  await member.locator('#personal-center').click(); await member.locator('.portal-stat').first().waitFor();
  await navigate(member, 'profile'); await member.locator('[data-form=profile] [name=nickname]').fill('测试创作者'); await member.locator('[data-form=profile] [type=submit]').click();
  await member.getByText('个人资料已保存。', { exact: true }).waitFor();
  await navigate(member, 'security'); await member.getByText('当前设备', { exact: true }).waitFor();
  pass('empty-workspace personal center, profile, session controls, hidden admin and storage');
  const project = await member.evaluate(() => fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '产品宣传片' }) }).then(r => r.json()));
  await app.contexts.get(2).store.mutate(state => {
    state.jobs.push({ id: 'browser-task', projectId: project.id, model: 'video-model', state: 'done', estimate: 3.5, pricingCurrency: 'CNY', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  await navigate(member, 'tasks'); await member.getByText('video-model', { exact: true }).waitFor(); await member.getByRole('button', { name: '详情', exact: true }).click();
  await member.getByRole('heading', { name: '任务详情', exact: true }).waitFor(); await member.locator('[data-detail-close]').click();
  await navigate(member, 'ledger'); await member.locator('.portal-table td').filter({ hasText: /^3\.5/ }).first().waitFor();
  const downloadPromise = member.waitForEvent('download'); await member.getByRole('button', { name: '导出筛选结果 CSV' }).click();
  const download = await downloadPromise; assert.match(await readFile(await download.path(), 'utf8'), /browser-task/);
  await mkdir('outputs', { recursive: true }); await member.screenshot({ path: 'outputs/personal-center-desktop.png', fullPage: true });
  pass('cross-project task list, timeline, quote ledger and CSV download');
  const admin = await makePage(); await login(admin, 'owner'); await admin.locator('#admin-center').click(); await admin.locator('.portal-stat').first().waitFor();
  await admin.screenshot({ path: 'outputs/admin-overview-desktop.png', fullPage: true });
  for (const tab of ['users', 'tasks', 'settings', 'storage', 'audit']) { await navigate(admin, tab); assert.equal(await admin.locator('.portal-feedback.error').count(), 0); }
  await navigate(admin, 'storage'); assert.equal(await admin.locator('[data-form=storage] [name=secretKey]').inputValue(), '');
  await admin.locator('[data-form=storage] [name=prefix]').fill('shared'); await admin.locator('[data-form=storage] [type=submit]').click(); await admin.getByText('统一云存储配置已保存。', { exact: true }).waitFor();
  await navigate(admin, 'settings'); await admin.locator('[name=siteName]').fill('幻帧测试站'); await admin.locator('[data-form=settings] [type=submit]').click(); await admin.getByText('网站参数已保存并生效。', { exact: true }).waitFor();
  assert.match(await admin.title(), /幻帧测试站/);
  await navigate(admin, 'announcements'); await admin.locator('[data-edit-notice=new]').click();
  const notice = admin.locator('[data-form=announcement]'); await notice.locator('[name=title]').fill('欢迎使用个人中心'); await notice.locator('[name=content]').fill('任务记录与账号安全功能已上线。\n<script>alert(1)</script>'); await notice.locator('[name=status]').selectOption('published'); await notice.locator('[name=pinned]').check(); await notice.locator('[type=submit]').click();
  await admin.getByText('公告已保存。', { exact: true }).waitFor();
  await navigate(member, 'notices'); await member.getByText('欢迎使用个人中心', { exact: false }).waitFor(); await member.locator('[data-read]').click(); await member.getByText('已读', { exact: true }).waitFor();
  assert.equal(await member.locator('.portal-notice script').count(), 0);
  pass('admin navigation, retained storage secret, site parameters, announcement publication, escaping and per-user read state');
  await member.setViewportSize({ width: 390, height: 844 }); await navigate(member, 'security');
  assert.equal(await member.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await member.screenshot({ path: 'outputs/personal-center-mobile.png', fullPage: true });
  const password = member.locator('[data-form=password]'); await password.locator('[name=currentPassword]').fill('original-password'); await password.locator('[name=newPassword]').fill('updated-password'); await password.locator('[name=confirmPassword]').fill('updated-password'); await password.locator('[type=submit]').click();
  await member.locator('#login-form').waitFor({ state: 'visible' }); await login(member, 'member', 'updated-password');
  pass('mobile layout and shared password update returns to login');
  await member.locator('#logout-button').click(); await member.locator('#login-form').waitFor({ state: 'visible' }); await member.locator('#forgot-password').click();
  const recovery = member.locator('#password-recovery'); await recovery.locator('[name=email]').fill('member@example.com'); await recovery.locator('#reset-code').click();
  await recovery.getByText('如果该邮箱已注册，将收到密码重置验证码。', { exact: true }).waitFor();
  await recovery.locator('[name=verificationCode]').fill(codes.get('member@example.com')); await recovery.locator('[name=newPassword]').fill('recovered-password'); await recovery.locator('[name=confirmPassword]').fill('recovered-password'); await recovery.locator('[type=submit]').click(); await recovery.waitFor({ state: 'hidden' }); await login(member, 'member', 'recovered-password');
  await navigate(admin, 'users'); await admin.locator('[data-form=filters] [name=q]').fill('member@example.com'); await admin.locator('[data-form=filters] [type=submit]').click(); await admin.locator('[data-user="2"][data-status=disabled]').click(); await admin.getByText('用户权限已更新。', { exact: true }).waitFor();
  await member.reload(); await member.locator('#login-form').waitFor({ state: 'visible' }); assert.equal(await member.locator('.workspace').isVisible(), false);
  assert.deepEqual(errors, []); pass('password recovery, suspension invalidates session, and no browser runtime errors');
} finally { await browser?.close(); await app?.close(); db.close(); await rm(root, { recursive: true, force: true }); }
