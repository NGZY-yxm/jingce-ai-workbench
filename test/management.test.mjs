import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { createStudio } from '../server.mjs';
import { CosStorage } from '../lib/storage.mjs';
import { toCsv } from '../lib/management.mjs';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-management-'));
  const databasePath = path.join(root, 'shared.db'), db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT UNIQUE,
    password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, email_verified_at TEXT, last_login_at TEXT, last_activity_at TEXT);`);
  const hash = await bcrypt.hash('original-password', 4);
  for (const [name, sharedAdmin] of [['owner', 0], ['member', 1], ['other', 0]]) db.prepare('INSERT INTO users(username,email,password_hash,is_admin) VALUES(?,?,?,?)').run(name, name + '@example.com', hash, sharedAdmin);
  const codes = new Map();
  const options = { root, multiUser: true, publicOrigin: 'https://example.test', catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false },
    management: { adminEmail: 'owner@example.com' }, auth: { databasePath, legacyEmail: 'owner@example.com', sendCode: async (email, code, purpose) => codes.set(email + ':' + purpose, code) }, ...overrides };
  let app = await createStudio(options), url = await app.start(0);
  const send = (route, method = 'GET', body, cookie = '', headers = {}) => fetch(url + route, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const login = async (name, password = 'original-password') => {
    const response = await send('/api/auth/login', 'POST', { email: name + '@example.com', password });
    assert.equal(response.status, 200, await response.clone().text()); return { cookie: response.headers.get('set-cookie').split(';')[0], user: await response.json() };
  };
  t.after(async () => { await app.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, db, codes, send, login, get app() { return app; }, async restart() { await app.close(); app = await createStudio(options); url = await app.start(0); } };
}

test('本站管理员独立授权，停用和会话撤销不修改共享用户权限', async t => {
  const f = await fixture(t), admin = await f.login('owner'), member = await f.login('member');
  assert.equal(admin.user.isAdmin, true); assert.equal(member.user.isAdmin, false);
  for (const route of ['/api/admin/users', '/api/admin/settings', '/api/admin/storage', '/api/admin/audit']) {
    assert.equal((await f.send(route)).status, 401); assert.equal((await f.send(route, 'GET', undefined, member.cookie)).status, 403);
  }
  assert.equal((await f.send('/api/admin/users/1', 'PUT', { status: 'disabled' }, admin.cookie)).status, 409);
  assert.equal((await f.send('/api/admin/users/2', 'PUT', { status: 'disabled' }, admin.cookie)).status, 200);
  assert.equal((await f.send('/api/auth/me', 'GET', undefined, member.cookie)).status, 401);
  assert.equal((await f.send('/api/auth/login', 'POST', { email: 'member@example.com', password: 'original-password' })).status, 403);
  assert.equal(f.db.prepare('SELECT is_admin FROM users WHERE id=2').get().is_admin, 1);
  assert.equal((await f.send('/api/admin/users/2', 'PUT', { status: 'active', role: 'admin' }, admin.cookie)).status, 200);
  const promoted = await f.login('member'); assert.equal(promoted.user.isAdmin, true);
  await f.send('/api/admin/users/2', 'PUT', { role: 'user' }, admin.cookie);
  assert.equal((await f.send('/api/admin/users', 'GET', undefined, promoted.cookie)).status, 403);
  await f.send('/api/admin/users/2/sessions', 'DELETE', {}, admin.cookie);
  assert.equal((await f.send('/api/auth/me', 'GET', undefined, promoted.cookie)).status, 401);
  assert.equal((await f.send('/api/admin/settings', 'PUT', { siteName: 'evil' }, admin.cookie, { Origin: 'https://evil.test' })).status, 403);
});

test('全站存储沿用统一配置、密钥不回显、普通用户无法覆盖、对象路径按账号隔离', async t => {
  const f = await fixture(t), admin = await f.login('owner'), member = await f.login('member');
  const config = { provider: 'r2', bucket: 'test-bucket', endpoint: 'https://' + 'a'.repeat(32) + '.r2.cloudflarestorage.com', prefix: 'existing', enabled: true, expiresHours: 72, secretId: 'storage-secret-id', secretKey: 'storage-secret-value' };
  const save = await f.send('/api/admin/storage', 'PUT', config, admin.cookie); assert.equal(save.status, 200);
  assert.doesNotMatch(await save.text(), /storage-secret/);
  const bootstrap = await (await f.send('/api/bootstrap', 'GET', undefined, member.cookie)).json();
  assert.deepEqual(bootstrap.settings.storage, { managed: true, enabled: true, ready: true });
  assert.doesNotMatch(JSON.stringify(bootstrap), /test-bucket|storage-secret|cloudflarestorage/);
  for (const route of ['/api/storage/settings', '/api/storage/test', '/api/admin/storage']) assert.equal((await f.send(route, 'PUT', config, member.cookie)).status, 403);
  await f.send('/api/admin/storage', 'PUT', { prefix: 'updated', secretId: '', secretKey: '' }, admin.cookie);
  const saved = JSON.parse(await readFile(path.join(f.root, 'storage.private.json'), 'utf8')); assert.equal(saved.secretKey, config.secretKey);
  const storage = new CosStorage(path.join(f.root, 'users', '2'), null, { configRoot: f.root, namespace: 'users/2' });
  assert.match(storage.keyFor(await storage.settings(), { id: 'asset', file: 'asset.png' }, 'hash'), /^updated\/users\/2\/assets\//);
});

test('公告草稿与过期公告不公开，已读状态独立，重新发布与重启保持状态', async t => {
  const f = await fixture(t), admin = await f.login('owner'), member = await f.login('member'), other = await f.login('other');
  const draft = { title: '维护 <script>', content: 'plain text', status: 'draft', pinned: true };
  const created = await (await f.send('/api/admin/announcements', 'POST', draft, admin.cookie)).json();
  assert.deepEqual(await (await f.send('/api/notices', 'GET', undefined, member.cookie)).json(), []);
  await f.send('/api/admin/announcements/' + created.id, 'PUT', { ...draft, status: 'published' }, admin.cookie);
  assert.equal((await (await f.send('/api/notices', 'GET', undefined, member.cookie)).json())[0].read, false);
  await f.send('/api/notices/' + created.id + '/read', 'POST', {}, member.cookie);
  assert.equal((await (await f.send('/api/notices', 'GET', undefined, other.cookie)).json())[0].read, false);
  await f.restart();
  assert.equal((await (await f.send('/api/notices', 'GET', undefined, member.cookie)).json())[0].read, true);
  await f.send('/api/admin/announcements/' + created.id, 'PUT', { ...draft, status: 'published', content: 'updated' }, admin.cookie);
  assert.equal((await (await f.send('/api/notices', 'GET', undefined, member.cookie)).json())[0].read, false);
  await f.send('/api/admin/announcements/' + created.id, 'PUT', { ...draft, status: 'published', expiresAt: '2000-01-01' }, admin.cookie);
  assert.deepEqual(await (await f.send('/api/notices', 'GET', undefined, member.cookie)).json(), []);
});

test('任务流水独立授权、保留删除历史、幂等事件、不同费用单位分组、CSV 防公式注入', async t => {
  const f = await fixture(t), member = await f.login('member'), other = await f.login('other');
  const state = { projects: [{ id: 'project', title: '=unsafe', assets: [{ size: 400 }] }], jobs: [{ id: 'video-a', projectId: 'project', model: 'test', state: 'waiting', estimate: 3, pricingCurrency: 'USD', createdAt: '2026-01-01T00:00:00Z', message: 'secret-api-key' }], imageJobs: [{ id: 'image-a', state: 'done', estimate: 2, estimateMax: 4, priceUnit: 'CNY', createdAt: '2026-01-02T00:00:00Z' }] };
  f.app.management.syncTasks(2, state); f.app.management.syncTasks(2, state);
  assert.equal(f.app.management.db.prepare('SELECT count(*) AS total FROM task_events').get().total, 2);
  state.jobs[0].state = 'done'; state.jobs[0].updatedAt = '2026-01-03T00:00:00Z'; f.app.management.syncTasks(2, state);
  const list = await (await f.send('/api/account/tasks?userId=2', 'GET', undefined, other.cookie)).json(); assert.equal(list.total, 0);
  assert.equal((await f.send('/api/account/task?id=video-a&type=video', 'GET', undefined, other.cookie)).status, 404);
  const details = await (await f.send('/api/account/task?id=video-a&type=video', 'GET', undefined, member.cookie)).json(); assert.equal(details.events.length, 2);
  assert.doesNotMatch(JSON.stringify(details), /secret-api-key/);
  f.app.management.syncTasks(2, { projects: [], jobs: [], imageJobs: [] });
  const summary = await (await f.send('/api/account/summary', 'GET', undefined, member.cookie)).json();
  assert.equal(summary.total, 2); assert.equal(summary.estimates.length, 2); assert.equal(summary.estimates.find(x => x.currency === 'CNY').amountMax, 4);
  const csv = await (await f.send('/api/account/tasks/export', 'GET', undefined, member.cookie)).text(); assert.match(csv, /'=unsafe/); assert.doesNotMatch(csv, /secret-api-key/);
  assert.match(toCsv([{ model: '+FORMULA', projectTitle: '@FORMULA' }]), /'\+FORMULA/);
  const filtered = await (await f.send('/api/account/tasks?type=video&from=2026-01-01&to=2026-01-01', 'GET', undefined, member.cookie)).json(); assert.equal(filtered.total, 1);
  await f.restart(); assert.equal(f.app.management.tasks(2).length, 2);
});

test('密码校验、共享密码修改、其他会话撤销与验证码找回', async t => {
  const f = await fixture(t), first = await f.login('member'), second = await f.login('member'), other = await f.login('other');
  const profile = await f.send('/api/account/profile', 'PUT', { nickname: '本站名称', role: 'admin' }, first.cookie); assert.equal(profile.status, 200);
  assert.equal(f.db.prepare('SELECT username FROM users WHERE id=2').get().username, 'member'); assert.equal(f.app.management.member(2).role, 'user');
  await f.send('/api/account/sessions', 'DELETE', {}, first.cookie);
  assert.equal((await f.send('/api/auth/me', 'GET', undefined, second.cookie)).status, 401);
  assert.equal((await f.send('/api/auth/me', 'GET', undefined, first.cookie)).status, 200);
  assert.equal((await f.send('/api/auth/me', 'GET', undefined, other.cookie)).status, 200);
  assert.equal((await f.send('/api/account/password', 'POST', { currentPassword: 'wrong', newPassword: 'replacement-password' }, first.cookie)).status, 400);
  assert.equal((await f.send('/api/account/password', 'POST', { currentPassword: 'original-password', newPassword: 'short' }, first.cookie)).status, 400);
  assert.equal((await f.send('/api/account/password', 'POST', { currentPassword: 'original-password', newPassword: 'replacement-password' }, first.cookie)).status, 200);
  assert.equal((await f.send('/api/auth/me', 'GET', undefined, first.cookie)).status, 401);
  assert.ok(await bcrypt.compare('replacement-password', f.db.prepare('SELECT password_hash FROM users WHERE id=2').get().password_hash));
  const login = await f.login('member', 'replacement-password');
  const recovery = await f.send('/api/auth/reset-code', 'POST', { email: 'member@example.com' }); assert.equal(recovery.status, 200);
  assert.equal((await f.send('/api/auth/reset-code', 'POST', { email: 'member@example.com' })).status, 429);
  const unknown = await f.send('/api/auth/reset-code', 'POST', { email: 'missing@example.com' }); assert.deepEqual(await recovery.json(), await unknown.json());
  const code = f.codes.get('member@example.com:reset');
  assert.equal((await f.send('/api/auth/reset-password', 'POST', { email: 'member@example.com', verificationCode: 'bad', newPassword: 'reset-password' })).status, 400);
  assert.equal((await f.send('/api/auth/reset-password', 'POST', { email: 'member@example.com', verificationCode: code, newPassword: 'reset-password' })).status, 200);
  assert.equal((await f.send('/api/auth/reset-password', 'POST', { email: 'member@example.com', verificationCode: code, newPassword: 'reset-again-password' })).status, 400);
  assert.equal((await f.send('/api/auth/me', 'GET', undefined, login.cookie)).status, 401);
  await f.login('member', 'reset-password');
  const activity = f.app.management.auditList(2); assert.ok(activity.some(x => x.action === 'password.reset'));
  assert.doesNotMatch(JSON.stringify(activity), /original-password|replacement-password|reset-password/);
});

test('注册开关、维护模式和工程配额在后端生效，包括并发创建', async t => {
  const f = await fixture(t), admin = await f.login('owner'), member = await f.login('member');
  await f.send('/api/admin/settings', 'PUT', { registrationEnabled: false, maintenance: true, maxProjects: 1, siteName: '测试站点' }, admin.cookie);
  assert.equal((await f.send('/api/auth/verification-code', 'POST', { email: 'new@example.com' })).status, 403);
  assert.equal((await f.send('/api/auth/register', 'POST', {})).status, 403);
  assert.equal((await f.send('/api/projects', 'POST', { title: 'blocked' }, member.cookie)).status, 503);
  assert.equal((await f.send('/api/account/profile', 'GET', undefined, member.cookie)).status, 200);
  assert.equal((await f.send('/api/projects', 'POST', { title: 'admin' }, admin.cookie)).status, 201);
  await f.send('/api/admin/settings', 'PUT', { maintenance: false }, admin.cookie);
  const requests = await Promise.all([f.send('/api/projects', 'POST', { title: 'one' }, member.cookie), f.send('/api/projects', 'POST', { title: 'two' }, member.cookie)]);
  assert.deepEqual(requests.map(r => r.status).sort(), [201, 409]);
  const settings = await (await f.send('/api/site')).json(); assert.equal(settings.siteName, '测试站点');
  await f.restart(); assert.equal(f.app.management.settings.maxProjects, 1);
});

test('文字任务持久化真实 token 用量且不存提示词、回复或密钥', async t => {
  const f = await fixture(t, { textFetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'private answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } }), { headers: { 'Content-Type': 'application/json' } }) });
  const member = await f.login('member');
  await f.send('/api/text-settings', 'PUT', { apiKey: 'private-text-key', textModel: 'test-model' }, member.cookie);
  const response = await f.send('/api/text-chat', 'POST', { model: 'test-model', messages: [{ role: 'user', content: 'private prompt' }] }, member.cookie); assert.equal(response.status, 200);
  const data = await (await f.send('/api/account/tasks?type=text', 'GET', undefined, member.cookie)).json(); assert.equal(data.total, 1);
  assert.equal(data.items[0].state, 'done'); assert.equal(data.items[0].usageTokens, 12); assert.equal(data.items[0].actualCost, null);
  assert.doesNotMatch(JSON.stringify(data), /private prompt|private answer|private-text-key/);
});

test('新图片任务冻结每张报价区间，批量候选不会重复计算整批价格', async t => {
  const f = await fixture(t, { imageCatalog: [{ name: 'image-model', priceUnit: '人民币￥/张', intervals: [{ label: '1K', prices: [2, 4] }] }] });
  const member = await f.login('member');
  const project = await (await f.send('/api/projects', 'POST', { title: 'quote-project' }, member.cookie)).json();
  await f.send('/api/image-settings', 'PUT', { apiKey: 'fake-key', imageModel: 'image-model' }, member.cookie);
  // Prevent dispatch: this test checks recorded quotes, never submits provider work.
  f.app.contexts.get(2).imageJobs.close();
  const response = await f.send(`/api/projects/${project.id}/image-jobs`, 'POST', { operationId: 'quote-batch', model: 'image-model', prompt: 'test', count: 2, config: { quality: '1k' } }, member.cookie);
  assert.equal(response.status, 202, await response.clone().text());
  const summary = f.app.management.summary(2); assert.equal(summary.total, 2);
  assert.deepEqual(summary.estimates, [{ currency: 'CNY', amount: 4, amountMax: 8 }]);
});
