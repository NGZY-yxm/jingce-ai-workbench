import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { cp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import { atomicJson } from './store.mjs';

const SESSION_COOKIE = 'jingce_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_COOLDOWN_MS = 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function hash(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function cleanEmail(value) { return String(value || '').trim().toLowerCase(); }
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function cookieValue(request, name) {
  const header = String(request.headers.cookie || '');
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try { return decodeURIComponent(rest.join('=')); } catch { return ''; }
    }
  }
  return '';
}
function clientKey(value) { return String(value || 'unknown').slice(0, 128); }
function validateEmail(value) {
  const email = cleanEmail(value);
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) fail('请输入有效邮箱。');
  return email;
}

export class AuthStore {
  constructor(runtimeRoot, options = {}) {
    this.runtimeRoot = runtimeRoot;
    this.root = path.join(runtimeRoot, 'auth');
    this.file = path.join(this.root, 'sessions.json');
    this.databasePath = options.databasePath || process.env.JINGCE_USER_DATABASE || '';
    this.legacyEmail = cleanEmail(options.legacyEmail || process.env.JINGCE_LEGACY_EMAIL || 'cl550225778@gmail.com');
    this.sendCode = options.sendCode || null;
    this.accounts = options.accounts || null;
    this.smtp = options.smtp || {
      host: process.env.JINGCE_SMTP_HOST,
      port: process.env.JINGCE_SMTP_PORT,
      username: process.env.JINGCE_SMTP_USERNAME,
      password: process.env.JINGCE_SMTP_PASSWORD,
      sender: process.env.JINGCE_SMTP_SENDER,
    };
    this.pending = Promise.resolve();
    this.sessions = {};
    this.codes = new Map();
    this.loginFailures = new Map();
    this.codeRequests = new Map();
    this.globalCodeRequests = [];
    this.db = null;
  }
  async init() {
    if (!this.databasePath || !path.isAbsolute(this.databasePath)) fail('请配置 Pictora 用户数据库的绝对路径 JINGCE_USER_DATABASE。', 503);
    const info = await stat(this.databasePath).catch(() => null);
    if (!info?.isFile() || !info.size) fail('共享用户数据库不可用。', 503);
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    const columns = new Set(this.db.prepare('PRAGMA table_info(users)').all().map(row => row.name));
    if (!['id', 'username', 'email', 'is_admin', 'password_hash'].every(name => columns.has(name))) {
      this.db.close(); this.db = null; fail('共享用户数据库的用户表结构不兼容。', 503);
    }
    this.getUser = this.db.prepare('SELECT id, username, email, is_admin, password_hash FROM users WHERE lower(email) = lower(?)');
    this.getUserById = this.db.prepare('SELECT id, username, email, is_admin, password_hash FROM users WHERE id = ?');
    this.legacyUserId = Number(this.getUser.get(this.legacyEmail)?.id || 0);
    this.insertUser = this.db.prepare('INSERT INTO users (username, email, email_verified_at, is_admin, password_hash) VALUES (?, ?, CURRENT_TIMESTAMP, 0, ?)');
    this.touchUser = this.db.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP, last_activity_at = CURRENT_TIMESTAMP WHERE id = ?");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try { this.sessions = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!this.sessions || typeof this.sessions !== 'object' || Array.isArray(this.sessions)) this.sessions = {};
    await this.prune();
  }
  async prune() {
    const now = Date.now(); let changed = false;
    for (const [key, value] of Object.entries(this.sessions)) {
      if (!value?.expiresAt || value.expiresAt <= now || !value.userId || !value.passwordVersion) {
        delete this.sessions[key]; changed = true;
      }
    }
    if (changed) await this.save();
  }
  async save() {
    const next = structuredClone(this.sessions);
    this.pending = this.pending.catch(() => {}).then(() => atomicJson(this.file, next, 0o600));
    await this.pending;
  }
  rateLimitLogin(email, client) {
    const key = `${email}\0${clientKey(client)}`;
    const recent = (this.loginFailures.get(key) || []).filter(time => time > Date.now() - LOGIN_WINDOW_MS);
    this.loginFailures.set(key, recent);
    if (recent.length >= 5) fail('登录尝试过于频繁，请 15 分钟后重试。', 429);
    return key;
  }
  async login(emailInput, passwordInput, client, agent = '') {
    const email = validateEmail(emailInput);
    const key = this.rateLimitLogin(email, client);
    const user = this.getUser.get(email);
    const password = String(passwordInput || '');
    if (!user || !password || !(await bcrypt.compare(password, user.password_hash))) {
      this.loginFailures.set(key, [...(this.loginFailures.get(key) || []), Date.now()]);
      fail('邮箱或密码错误。', 401);
    }
    this.loginFailures.delete(key);
    if (this.accounts?.access(user).disabled) fail('此账号已被停用，请联系本站管理员。', 403);
    this.touchUser.run(user.id);
    this.accounts?.touch(user.id); this.accounts?.audit(user.id, 'auth.login');
    return this.createSession(user, client, agent);
  }
  async deliverCode(email, code, purpose = 'register') {
    if (this.sendCode) return this.sendCode(email, code, purpose);
    const { host, port, username, password, sender } = this.smtp;
    if (!host || !username || !password || !(sender || username)) fail('邮件服务尚未配置。', 503);
    const transport = nodemailer.createTransport({ host, port: Number(port || 465), secure: Number(port || 465) === 465,
      auth: { user: username, pass: password }, connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 20000 });
    try {
      const label = purpose === 'reset' ? '重置密码' : '注册';
      await transport.sendMail({ from: sender || username, to: email, subject: `幻帧${label}验证码`,
        text: `你的幻帧${label}验证码是：${code}\n\n验证码将在 10 分钟后失效。${purpose === 'reset' ? '重置后，Pictora 与幻帧将使用同一个新密码。' : ''}若不是你本人操作，请忽略此邮件。` });
    } catch { fail('验证码邮件发送失败，请稍后重试。', 502); }
    finally { transport.close(); }
  }
  async verificationCode(emailInput, client) {
    const email = validateEmail(emailInput);
    if (this.getUser.get(email)) fail('该邮箱已注册，请直接登录。', 409);
    const now = Date.now(); const ip = clientKey(client);
    const requests = (this.codeRequests.get(ip) || []).filter(time => time > now - CODE_TTL_MS);
    this.globalCodeRequests = this.globalCodeRequests.filter(time => time > now - CODE_TTL_MS);
    if (requests.length >= 10 || this.globalCodeRequests.length >= 100) fail('请求过于频繁，请稍后重试。', 429);
    const prior = this.codes.get(email);
    if (prior && now - prior.sentAt < CODE_COOLDOWN_MS) fail(`请在 ${Math.ceil((CODE_COOLDOWN_MS - now + prior.sentAt) / 1000)} 秒后重试。`, 429);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    requests.push(now); this.codeRequests.set(ip, requests); this.globalCodeRequests.push(now);
    const pending = { hash: hash(`${salt}:${code}`), salt, sentAt: now, expiresAt: now + CODE_TTL_MS, attempts: 0 };
    this.codes.set(email, pending);
    try { await this.deliverCode(email, code); }
    catch (error) { if (this.codes.get(email) === pending) this.codes.delete(email); throw error; }
    return { message: '验证码已发送', retryAfterSeconds: CODE_COOLDOWN_MS / 1000 };
  }
  async register(input, client = '', agent = '') {
    const email = validateEmail(input?.email);
    const username = String(input?.username || '').trim();
    const password = String(input?.password || '');
    const code = String(input?.verificationCode || '');
    if (username.length < 2 || username.length > 40) fail('用户名需要 2 到 40 个字符。');
    if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) fail('密码需要至少 8 个字符，且不能超过 72 字节。');
    if (!/^\d{6}$/.test(code)) fail('请输入六位验证码。');
    if (this.getUser.get(email)) fail('该邮箱已注册，请直接登录。', 409);
    const pending = this.codes.get(email);
    if (!pending || pending.expiresAt <= Date.now()) fail('验证码错误或已失效。');
    pending.attempts += 1;
    const supplied = Buffer.from(hash(`${pending.salt}:${code}`), 'hex');
    const expected = Buffer.from(pending.hash, 'hex');
    if (!timingSafeEqual(supplied, expected)) {
      if (pending.attempts >= 5) this.codes.delete(email);
      fail('验证码错误或已失效。');
    }
    const passwordHash = await bcrypt.hash(password, 12);
    let userId;
    try { userId = this.insertUser.run(username, email, passwordHash).lastInsertRowid; }
    catch (error) {
      if (error.errcode && (error.errcode & 0xff) === 19) {
        if (this.getUser.get(email)) fail('该邮箱已注册，请直接登录。', 409);
        fail('用户名已被使用。', 409);
      }
      throw error;
    }
    this.codes.delete(email);
    const user = this.getUserById.get(userId);
    this.touchUser.run(user.id);
    this.accounts?.ensureMember(user); this.accounts?.touch(user.id); this.accounts?.audit(user.id, 'auth.register');
    return this.createSession(user, client, agent);
  }
  publicUser(user) {
    const access = this.accounts?.access(user);
    return { id: Number(user.id), username: user.username, email: cleanEmail(user.email),
      nickname: access?.nickname || user.username, isAdmin: access ? access.isAdmin : Boolean(user.is_admin) };
  }
  async createSession(user, client = '', agent = '') {
    const email = cleanEmail(user.email);
    if (!email) fail('账号没有绑定邮箱。', 403);
    const token = randomBytes(32).toString('base64url');
    this.sessions[hash(token)] = { id: randomUUID(), userId: Number(user.id), passwordVersion: hash(user.password_hash),
      client: clientKey(client), agent: String(agent).slice(0, 300), lastSeenAt: Date.now(),
      createdAt: Date.now(), expiresAt: Date.now() + SESSION_MAX_AGE * 1000 };
    await this.save();
    return { token, user: this.publicUser(user) };
  }
  async current(request) {
    const token = cookieValue(request, SESSION_COOKIE);
    if (!token) return null;
    const key = hash(token); const session = this.sessions[key];
    if (!session) return null;
    const user = session.expiresAt > Date.now() ? this.getUserById.get(session.userId) : null;
    if (!user?.email || hash(user.password_hash) !== session.passwordVersion || this.accounts?.access(user).disabled) {
      delete this.sessions[key]; await this.save(); return null;
    }
    if (!session.id) { session.id = randomUUID(); await this.save(); }
    if (!session.lastSeenAt || Date.now() - session.lastSeenAt > 5 * 60 * 1000) {
      session.lastSeenAt = Date.now(); this.accounts?.touch(user.id); await this.save();
    }
    return { token, userId: user.id, ...this.publicUser(user) };
  }
  async logout(request) {
    const token = cookieValue(request, SESSION_COOKIE); const key = token && hash(token);
    if (key && this.sessions[key]) { delete this.sessions[key]; await this.save(); }
  }
  sessionList(session) {
    return Object.entries(this.sessions).filter(([, value]) => value.userId === Number(session.userId) && value.expiresAt > Date.now())
      .map(([key, value]) => ({ id: value.id || '', current: key === hash(session.token), createdAt: value.createdAt,
        lastSeenAt: value.lastSeenAt || value.createdAt, expiresAt: value.expiresAt, client: value.client || '', agent: value.agent || '旧版登录会话' }));
  }
  async revokeSessions(userId, exceptToken = '', sessionId = '') {
    for (const [key, value] of Object.entries(this.sessions)) if (value.userId === Number(userId) && key !== hash(exceptToken) && (!sessionId || value.id === sessionId)) delete this.sessions[key];
    await this.save();
  }
  validatePassword(password) {
    if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) fail('密码需要至少 8 个字符，且不能超过 72 字节。');
  }
  async changePassword(session, input, client) {
    this.validatePassword(input.newPassword);
    const key = this.rateLimitLogin('password:' + session.email, client);
    const user = this.getUserById.get(session.userId);
    if (!user || !(await bcrypt.compare(String(input.currentPassword || ''), user.password_hash))) {
      this.loginFailures.set(key, [...(this.loginFailures.get(key) || []), Date.now()]); fail('当前密码不正确。', 400);
    }
    await this.replacePassword(user, input.newPassword);
    this.loginFailures.delete(key); this.accounts?.audit(user.id, 'password.change');
  }
  async replacePassword(user, password) {
    const replacement = await bcrypt.hash(password, 12);
    const result = this.db.prepare('UPDATE users SET password_hash=? WHERE id=? AND password_hash=?').run(replacement, user.id, user.password_hash);
    if (!result.changes) fail('密码已发生变化，请重新操作。', 409);
    this.codes.delete('reset:' + cleanEmail(user.email));
    await this.revokeSessions(user.id);
  }
  async resetCode(emailInput, client) {
    const email = validateEmail(emailInput), key = 'reset:' + email, time = Date.now();
    const ip = 'reset:' + clientKey(client), recent = (this.codeRequests.get(ip) || []).filter(value => value > time - CODE_TTL_MS);
    this.globalCodeRequests = this.globalCodeRequests.filter(value => value > time - CODE_TTL_MS);
    const prior = this.codes.get(key);
    if (recent.length >= 10 || this.globalCodeRequests.length >= 100 || prior && time - prior.sentAt < CODE_COOLDOWN_MS) fail('请求过于频繁，请稍后重试。', 429);
    this.codeRequests.set(ip, [...recent, time]); this.globalCodeRequests.push(time);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0'), salt = randomBytes(16).toString('hex');
    this.codes.set(key, { hash: hash(`${salt}:${code}`), salt, sentAt: time, expiresAt: time + CODE_TTL_MS, attempts: 0 });
    if (this.getUser.get(email)) {
      try { await this.deliverCode(email, code, 'reset'); }
      catch (error) { this.codes.delete(key); throw error; }
    }
    return { message: '如果该邮箱已注册，将收到密码重置验证码。', retryAfterSeconds: 60 };
  }
  async resetPassword(input) {
    const email = validateEmail(input.email), key = 'reset:' + email, pending = this.codes.get(key);
    this.validatePassword(input.newPassword);
    if (!pending || pending.expiresAt <= Date.now()) fail('验证码错误或已失效。');
    pending.attempts++;
    if (!/^\d{6}$/.test(String(input.verificationCode)) || !timingSafeEqual(Buffer.from(hash(`${pending.salt}:${input.verificationCode}`), 'hex'), Buffer.from(pending.hash, 'hex'))) {
      if (pending.attempts >= 5) this.codes.delete(key); fail('验证码错误或已失效。');
    }
    this.codes.delete(key);
    const user = this.getUser.get(email); if (!user) fail('验证码错误或已失效。');
    await this.replacePassword(user, input.newPassword); this.accounts?.audit(user.id, 'password.reset');
    return { message: '密码已更新，请使用新密码登录。Pictora 同样使用此新密码。' };
  }
  cookie(token) { return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${SESSION_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax; Secure`; }
  clearCookie() { return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure`; }
  userRoot(userId) {
    if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) fail('用户 ID 无效。', 403);
    return path.join(this.runtimeRoot, 'users', String(userId));
  }
  close() { this.db?.close(); this.db = null; }
}

export async function migrateLegacyWorkspace(auth, userRoot) {
  const legacy = auth.runtimeRoot;
  try { await readFile(path.join(legacy, 'projects.json')); }
  catch { await mkdir(userRoot, { recursive: true, mode: 0o700 }); return; }
  try { await readFile(path.join(userRoot, 'projects.json')); return; } catch {}
  const names = ['projects.json', 'connections.private.json', 'connection.private.json', 'image-connection.private.json', 'text-connection.private.json', 'speech-connection.private.json', 'storage.private.json', 'model-capabilities.json', 'previs-settings.json', 'text-last-request.json', 'skills.json',
    'assets', 'exports', 'image-results', 'video-task-connections', 'previs', 'speech-results', 'speech-task-connections', 'skills', 'text-results', 'voice-recordings', 'voice-results', 'voice-task-connections', 'media-thumbnails'];
  const parent = path.dirname(userRoot);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = path.join(parent, `.${path.basename(userRoot)}-migration-${randomUUID()}`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    for (const name of names) {
      await cp(path.join(legacy, name), path.join(staging, name), { recursive: true, force: false }).catch(error => {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      });
    }
    let existing = false;
    try { await stat(userRoot); existing = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!existing) { await rename(staging, userRoot); return; }
    const previous = `${userRoot}.partial-${Date.now()}`;
    await rename(userRoot, previous);
    try { await rename(staging, userRoot); }
    catch (error) { await rename(previous, userRoot).catch(() => {}); throw error; }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

export { SESSION_COOKIE };
