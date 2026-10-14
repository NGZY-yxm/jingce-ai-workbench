import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { AuthStore } from '../lib/auth.mjs';
import { createStudio } from '../server.mjs';

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'jingce-auth-'));
  const databasePath = path.join(temporary, 'users.db');
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
    email TEXT UNIQUE, password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0,
    email_verified_at TEXT, last_login_at TEXT, last_activity_at TEXT);`);
  const passwordHash = await bcrypt.hash('existing-password', 4);
  db.prepare('INSERT INTO users(username,email,password_hash) VALUES (?,?,?)').run('existing', 'existing@example.com', passwordHash);
  const codes = new Map();
  return { temporary, root: path.join(temporary, 'runtime'), db, databasePath, codes,
    cleanup: async () => { db.close(); await rm(temporary, { recursive: true, force: true }); },
    auth: { databasePath, legacyEmail: 'existing@example.com', sendCode: async (email, code) => codes.set(email, code) } };
}

test('共享用户表：原密码登录、验证码注册、独立会话及密码更新失效', async t => {
  const f = await fixture(t);
  let auth = new AuthStore(f.root, f.auth); await auth.init();
  t.after(async () => { auth.close(); await f.cleanup(); });
  const logged = await auth.login(' EXISTING@example.com ', 'existing-password', 'test-client');
  assert.equal(logged.user.id, 1);
  assert.equal(logged.user.email, 'existing@example.com');
  assert.match(auth.cookie(logged.token), /HttpOnly; SameSite=Lax; Secure/);
  assert.doesNotMatch(await readFile(auth.file, 'utf8'), new RegExp(logged.token));
  const requestWith = token => ({ headers: { cookie: `jingce_session=${token}` } });
  assert.equal((await auth.current(requestWith(logged.token))).userId, 1);
  await assert.rejects(auth.login('existing@example.com', 'bad-password', 'test-client'), { status: 401 });
  await assert.rejects(auth.verificationCode('existing@example.com', 'test-client'), { status: 409 });
  await auth.verificationCode('new@example.com', 'test-client');
  await assert.rejects(auth.verificationCode('new@example.com', 'test-client'), { status: 429 });
  const input = { username: 'new-user', email: 'new@example.com', password: 'a-new-password', verificationCode: f.codes.get('new@example.com') };
  await assert.rejects(auth.register({ ...input, verificationCode: 'invalid' }), { status: 400 });
  const created = await auth.register(input);
  const row = f.db.prepare('SELECT * FROM users WHERE email=?').get('new@example.com');
  assert.ok(await bcrypt.compare(input.password, row.password_hash));
  assert.ok(row.email_verified_at);
  assert.equal(row.is_admin, 0);
  assert.equal(created.user.id, row.id);
  await assert.rejects(auth.register(input), { status: 409 });
  await auth.verificationCode('another@example.com', 'test-client');
  await assert.rejects(auth.register({ ...input, email: 'another@example.com', username: 'existing',
    verificationCode: f.codes.get('another@example.com') }), { status: 409 });
  auth.close(); auth = new AuthStore(f.root, f.auth); await auth.init();
  assert.equal((await auth.current(requestWith(logged.token))).userId, 1);
  f.db.prepare('UPDATE users SET password_hash=? WHERE id=1').run(await bcrypt.hash('changed-password', 4));
  assert.equal(await auth.current(requestWith(logged.token)), null);
  await auth.logout(requestWith(created.token));
  assert.equal(await auth.current(requestWith(created.token)), null);
});

test('认证首屏默认隐藏工作台并允许退出登录返回登录页', async t => {
  const f = await fixture(t);
  const app = await createStudio({ root: f.root, multiUser: true, publicOrigin: 'https://studio.example.com', auth: f.auth, catalog: [], imageCatalog: [], tools: { ready: false } });
  const url = await app.start(0);
  t.after(async () => { await app.close(); await f.cleanup(); });
  const page = await (await fetch(url + '/')).text();
  assert.match(page, /data-auth-gateway=\"1\"/);
  assert.match(page, /<aside class=\"sidebar\" hidden>/);
  assert.match(page, /<main class=\"workspace\" hidden>/);
});

test('HTTP 账户隔离：旧工程归属、注册账户空工作区、禁止跨账号读取及退出', async t => {
  const f = await fixture(t);
  const common = { catalog: [], imageCatalog: [], tools: { ready: false } };
  const legacy = await createStudio({ root: f.root, ...common });
  const legacyUrl = await legacy.start(0);
  const bootstrap = await (await fetch(legacyUrl + '/api/bootstrap')).json();
  const oldProject = await (await fetch(legacyUrl + '/api/projects', { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token }, body: JSON.stringify({ title: 'legacy-owned-project' }) })).json();
  await legacy.close();
  const app = await createStudio({ root: f.root, multiUser: true, publicOrigin: 'https://studio.example.com', auth: f.auth, ...common });
  const url = await app.start(0);
  t.after(async () => { await app.close(); await f.cleanup(); });
  const send = (route, method = 'GET', body, cookie = '', extra = {}) => fetch(url + route, { method, headers: {
    'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await send('/api/bootstrap')).status, 401);
  assert.equal((await send('/api/projects/' + oldProject.id)).status, 401);
  const page = await send('/');
  assert.match(await page.text(), /data-auth-gateway="1"/);
  assert.ok(page.headers.get('content-security-policy'));
  assert.equal((await send('/api/auth/login', 'POST', { email: 'existing@example.com', password: 'existing-password' }, '', { Origin: 'https://attacker.invalid' })).status, 403);
  const login = await send('/api/auth/login', 'POST', { email: 'existing@example.com', password: 'existing-password' });
  assert.equal(login.status, 200);
  const publicLogin = await send('/api/auth/login', 'POST', { email: 'existing@example.com', password: 'existing-password' }, '',
    { Host: 'studio.example.com', Origin: 'https://studio.example.com' });
  assert.equal(publicLogin.status, 200);
  const ownerCookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await send('/api/auth/me', 'GET', undefined, ownerCookie)).json()).id, 1);
  const ownerBootstrap = await (await send('/api/bootstrap', 'GET', undefined, ownerCookie)).json();
  assert.deepEqual(ownerBootstrap.projects.map(p => p.id), [oldProject.id]);
  assert.ok(await readFile(path.join(f.root, 'users', '1', 'projects.json')));
  assert.ok(await readFile(path.join(f.root, 'projects.json'))); // Rollback copy remains intact.
  assert.equal((await send('/api/auth/verification-code', 'POST', { email: 'new@example.com' })).status, 200);
  const registration = await send('/api/auth/register', 'POST', { username: 'new-user', email: 'new@example.com', password: 'new-user-password', verificationCode: f.codes.get('new@example.com') });
  assert.equal(registration.status, 201);
  const otherCookie = registration.headers.get('set-cookie').split(';')[0];
  assert.deepEqual((await (await send('/api/bootstrap', 'GET', undefined, otherCookie)).json()).projects, []);
  assert.equal((await send('/api/projects/' + oldProject.id, 'GET', undefined, otherCookie)).status, 404);
  assert.equal((await send('/api/projects/' + oldProject.id, 'PATCH', { revision: oldProject.revision, title: 'stolen' }, otherCookie)).status, 404);
  const otherProject = await (await send('/api/projects', 'POST', { title: 'new-account-project' }, otherCookie)).json();
  assert.equal((await send('/api/projects/' + otherProject.id, 'GET', undefined, ownerCookie)).status, 404);
  const publicStatus = await new Promise((resolve, reject) => {
    const req = request(url + '/api/previs/tools', { headers: { Host: 'studio.example.com', Cookie: ownerCookie } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(publicStatus, 403);
  assert.equal((await send('/api/previs/settings', 'PUT', {}, ownerCookie, { Origin: 'https://studio.example.com' })).status, 403);
  f.db.prepare('UPDATE users SET email=? WHERE id=1').run('renamed@example.com');
  const renamedLogin = await send('/api/auth/login', 'POST', { email: 'renamed@example.com', password: 'existing-password' });
  const renamedCookie = renamedLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await send('/api/bootstrap', 'GET', undefined, renamedCookie)).json()).projects[0].id, oldProject.id);
  assert.equal((await send('/api/shutdown', 'POST', {}, ownerCookie)).status, 404);
  assert.equal((await send('/api/auth/logout', 'POST', {}, otherCookie)).status, 204);
  assert.equal((await send('/api/bootstrap', 'GET', undefined, otherCookie)).status, 401);
});
