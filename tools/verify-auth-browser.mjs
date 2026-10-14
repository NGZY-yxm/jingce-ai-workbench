// Uses a disposable user database and real gateway. No production accounts or providers are touched.
// Set JINGCE_PLAYWRIGHT_MODULE to an installed playwright or playwright-core package.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createStudio } from '../server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.JINGCE_PLAYWRIGHT_MODULE || 'playwright');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'jingce-auth-browser-'));
const databasePath = path.join(temporary, 'users.db');
const db = new DatabaseSync(databasePath);
db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE, password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0,
  email_verified_at TEXT, last_login_at TEXT, last_activity_at TEXT);`);
db.prepare('INSERT INTO users(username,email,password_hash) VALUES (?,?,?)')
  .run('existing', 'existing@example.com', await bcrypt.hash('existing-password', 4));
const origin = 'https://auth-browser.example.test';
const codes = new Map(), errors = [], requests = [];
let app, browser;
const checkpoint = text => console.log('PASS ' + text);
try {
  app = await createStudio({ root: path.join(temporary, 'runtime'), multiUser: true, publicOrigin: origin,
    catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false },
    auth: { databasePath, sendCode: async (email, code) => codes.set(email, code) } });
  const url = await app.start(0);
  browser = await chromium.launch({ headless: true, channel: process.env.JINGCE_BROWSER_CHANNEL || 'msedge' });
  const makeContext = async options => {
    const context = await browser.newContext(options);
    await context.route(origin + '/**', async route => {
      const parsed = new URL(route.request().url());
      requests.push(parsed.pathname + parsed.search);
      const headers = await route.request().allHeaders();
      headers.host = new URL(origin).host;
      const response = await route.fetch({ url: url + parsed.pathname + parsed.search, headers });
      await route.fulfill({ response });
    });
    return context;
  };
  const context = await makeContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  const login = async () => {
    await page.locator('#login-form [name=email]').fill('existing@example.com');
    await page.locator('#login-form [name=password]').fill('existing-password');
    await page.locator('#login-form button[type=submit]').click();
    await page.locator('#auth-screen').waitFor({ state: 'hidden' });
    await page.locator('.workspace').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.body.dataset.view === 'overview');
  };
  const loggedOut = async () => {
    await page.locator('#login-form').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.workspace').isVisible(), false);
    assert.equal(await page.locator('.sidebar').isVisible(), false);
    assert.equal(await page.evaluate(() => fetch('/api/auth/me').then(r => r.status)), 401);
    assert.equal(await page.evaluate(() => fetch('/api/bootstrap').then(r => r.status)), 401);
  };
  await page.goto(origin); await loggedOut();
  await page.waitForFunction(() => typeof document.querySelector('#login-form').onsubmit === 'function');
  checkpoint('anonymous entry shows login only; backend returns 401');
  assert.ok(requests.filter(p => /\.(?:js|css)(?:\?|$)/.test(p)).every(p => /\?v=[a-f0-9]{16}$/.test(p)));
  checkpoint('entry scripts, styles and transitive modules all use a content version');
  await page.locator('#login-form [name=email]').fill('existing@example.com');
  await page.locator('#login-form [name=password]').fill('wrong-password');
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('#auth-message.error').waitFor();
  assert.equal(await page.locator('.workspace').isVisible(), false);
  checkpoint('invalid credentials stay on login');
  await login(); await page.reload();
  await page.locator('.workspace').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => fetch('/api/auth/me').then(r => r.status)), 200);
  checkpoint('existing shared user logs in and reload restores the session');
  await page.route('**/api/auth/logout', route => route.fulfill({ status: 503, json: { error: 'test outage' } }));
  await page.locator('#logout-button').waitFor({ state: 'visible' });
  await page.locator('#logout-button').click();
  await page.locator('#toast.error.visible').waitFor();
  assert.equal(await page.locator('#logout-button').isEnabled(), true);
  await page.unroute('**/api/auth/logout');
  checkpoint('failed logout displays an error and permits retry');
  await page.locator('#logout-button').click(); await loggedOut(); await page.reload(); await loggedOut();
  assert.equal((await context.cookies()).some(cookie => cookie.name === 'jingce_session'), false);
  checkpoint('logout revokes session, clears cookie and returns to login after reload');
  await page.locator('[data-auth-tab=register]').click();
  await page.locator('#register-form [name=username]').fill('new-user');
  await page.locator('#register-form [name=email]').fill('new@example.com');
  await page.locator('#send-code').click();
  await page.waitForFunction(() => document.querySelector('#auth-message').textContent.includes('验证码已发送'));
  await page.locator('#register-form [name=verificationCode]').fill(codes.get('new@example.com'));
  await page.locator('#register-form [name=password]').fill('new-user-password');
  await page.locator('#register-form button[type=submit]').click();
  await page.locator('.workspace').waitFor({ state: 'visible' });
  assert.deepEqual(await page.evaluate(() => fetch('/api/bootstrap').then(r => r.json()).then(r => r.projects)), []);
  checkpoint('registration enters an isolated empty workspace');
  await context.clearCookies(); await page.reload(); await loggedOut();
  checkpoint('expired session returns to login');
  const disabledContext = await makeContext({ javaScriptEnabled: false });
  const disabledPage = await disabledContext.newPage(); await disabledPage.goto(origin);
  assert.equal(await disabledPage.locator('#auth-screen').isVisible(), true);
  assert.equal(await disabledPage.locator('.workspace').isVisible(), false);
  assert.equal(await disabledPage.locator('.sidebar').isVisible(), false);
  checkpoint('scripts disabled: login remains visible and workspace stays hidden');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('outputs', { recursive: true });
  await page.screenshot({ path: 'outputs/auth-login-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.screenshot({ path: 'outputs/auth-login-desktop.png', fullPage: true });
  assert.deepEqual(errors, []);
  checkpoint('mobile layout fits viewport; no browser runtime errors');
} finally {
  await browser?.close(); await app?.close(); db.close();
  await rm(temporary, { recursive: true, force: true });
}
