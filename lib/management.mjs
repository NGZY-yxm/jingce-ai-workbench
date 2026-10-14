import path from 'node:path';
import { mkdir, chmod } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { InputError } from './workflow.mjs';

const DEFAULTS = { siteName: '幻帧 MiraFrame', supportText: '', registrationEnabled: true,
  maintenance: false, maintenanceMessage: '网站正在维护，请稍后再试。', maxProjects: 100 };
const TERMINAL = new Set(['done', 'failed', 'error', 'cancelled', 'canceled', 'resolved']);
const ATTENTION = new Set(['uncertain', 'download_pending', 'save_pending']);
const now = () => new Date().toISOString();
const string = (value, max = 200) => String(value ?? '').trim().slice(0, max);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const parse = row => row ? JSON.parse(row.payload) : null;
export function pageOf(rows, query) {
  const pageSize = Math.max(1, Math.min(100, Math.trunc(Number(query.get('pageSize'))) || 20));
  const page = Math.max(1, Math.min(Math.max(1, Math.ceil(rows.length / pageSize)), Math.trunc(Number(query.get('page'))) || 1));
  return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
}
export function toCsv(rows) {
  const fields = ['id', 'type', 'projectTitle', 'model', 'state', 'createdAt', 'updatedAt', 'estimate', 'estimateMax', 'currency', 'actualCost', 'usageTokens', 'usageCharacters'];
  const cell = value => '"' + String(value ?? '').replace(/^[=+\-@\t\r]/, "'$&").replaceAll('"', '""') + '"';
  return '\uFEFF' + [fields.map(cell).join(','), ...rows.map(row => fields.map(field => cell(row[field])).join(','))].join('\r\n');
}

export class ManagementStore {
  constructor(root, options = {}) {
    this.root = root; this.adminEmail = (options.adminEmail || process.env.JINGCE_ADMIN_EMAIL || 'cl550225778@gmail.com').toLowerCase();
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const filename = path.join(this.root, 'management.sqlite');
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY, email TEXT NOT NULL, username TEXT NOT NULL,
        nickname TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active',
        joined_at TEXT NOT NULL, last_seen TEXT, project_count INTEGER NOT NULL DEFAULT 0, asset_bytes INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notice_reads (user_id INTEGER NOT NULL, notice_id TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(user_id, notice_id));
      CREATE TABLE IF NOT EXISTS tasks (user_id INTEGER NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(user_id,type,id));
      CREATE TABLE IF NOT EXISTS task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, task_id TEXT NOT NULL, type TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_events_owner ON task_events(user_id,id);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, actor INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_actor ON audit(actor,id);`);
    await chmod(filename, 0o600).catch(() => {});
    this.settings = { ...DEFAULTS, ...parse(this.db.prepare('SELECT payload FROM settings WHERE id=1').get()) };
    for (const row of this.db.prepare("SELECT user_id,payload FROM tasks WHERE type='text'").all()) {
      const task = parse(row);
      if (task.state === 'running') this.recordTask(row.user_id, { ...task, state: 'uncertain', message: 'REQUEST_INTERRUPTED', updatedAt: now() });
    }
  }
  ensureMember(user) {
    const email = string(user.email).toLowerCase(), id = Number(user.id);
    const owner = email === this.adminEmail;
    const existing = this.member(id);
    if (existing && existing.email === email && existing.username === user.username && (!owner || existing.role === 'admin' && existing.status === 'active')) return existing;
    this.db.prepare(`INSERT INTO members(id,email,username,nickname,role,status,joined_at) VALUES(?,?,?,?,?,'active',?)
      ON CONFLICT(id) DO UPDATE SET email=excluded.email, username=excluded.username`).run(id, email, user.username, user.username, owner ? 'admin' : 'user', now());
    // The explicitly configured owner is recoverable even after a mistaken role edit.
    if (owner) this.db.prepare("UPDATE members SET role='admin',status='active' WHERE id=?").run(id);
    return this.member(id);
  }
  member(id) { return this.db.prepare('SELECT * FROM members WHERE id=?').get(Number(id)); }
  access(user) { const item = this.ensureMember(user); return { isAdmin: item.role === 'admin', disabled: item.status !== 'active', nickname: item.nickname }; }
  touch(id) { this.db.prepare('UPDATE members SET last_seen=? WHERE id=?').run(now(), Number(id)); }
  audit(actor, action, target = '') { this.db.prepare('INSERT INTO audit(actor,action,target,created_at) VALUES(?,?,?,?)').run(Number(actor), string(action, 80), string(target, 200), now()); }
  auditList(actor = null) { return actor === null ? this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 10000').all()
    : this.db.prepare('SELECT * FROM audit WHERE actor=? ORDER BY id DESC LIMIT 1000').all(Number(actor)); }
  updateMember(actor, id, input) {
    const item = this.member(id); if (!item) throw new InputError('用户不存在。', 404);
    if (id === Number(actor) || item.email === this.adminEmail) throw new InputError('不能修改自己的权限或停用主管理员。', 409);
    if (input.role !== undefined && !['user', 'admin'].includes(input.role)) throw new InputError('角色无效。');
    if (input.status !== undefined && !['active', 'disabled'].includes(input.status)) throw new InputError('账号状态无效。');
    this.db.prepare('UPDATE members SET role=?,status=? WHERE id=?').run(input.role || item.role, input.status || item.status, id);
    this.audit(actor, 'user.update', `${id}: ${input.role || item.role}, ${input.status || item.status}`);
    return this.member(id);
  }
  profile(id, input) {
    const nickname = string(input.nickname, 41);
    if (nickname.length < 2 || nickname.length > 40) throw new InputError('显示名称需要 2 到 40 个字符。');
    this.db.prepare('UPDATE members SET nickname=? WHERE id=?').run(nickname, Number(id));
    this.audit(id, 'profile.update'); return this.member(id);
  }
  saveSettings(actor, input) {
    const next = { ...this.settings };
    for (const field of ['registrationEnabled', 'maintenance']) if (field in input) {
      if (typeof input[field] !== 'boolean') throw new InputError('开关参数无效。'); next[field] = input[field];
    }
    for (const [field, max] of [['siteName', 60], ['supportText', 1000], ['maintenanceMessage', 500]]) if (field in input) next[field] = string(input[field], max);
    if (!next.siteName) throw new InputError('网站名称不能为空。');
    if ('maxProjects' in input) { next.maxProjects = Number(input.maxProjects); if (!Number.isSafeInteger(next.maxProjects) || next.maxProjects < 1 || next.maxProjects > 10000) throw new InputError('工程数量上限需要是 1 到 10000 的整数。'); }
    this.db.prepare('INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(next));
    this.settings = next; this.audit(actor, 'settings.update'); return next;
  }
  notices(userId, admin = false) {
    const reads = new Map(this.db.prepare('SELECT notice_id,version FROM notice_reads WHERE user_id=?').all(Number(userId)).map(row => [row.notice_id, row.version]));
    return this.db.prepare('SELECT payload FROM announcements').all().map(parse)
      .filter(item => admin || (item.status === 'published' && (!item.expiresAt || item.expiresAt > now())))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))
      .map(item => ({ ...item, read: reads.get(item.id) === item.updatedAt }));
  }
  saveNotice(actor, id, input) {
    const prior = id ? parse(this.db.prepare('SELECT payload FROM announcements WHERE id=?').get(id)) : null;
    if (id && !prior) throw new InputError('公告不存在。', 404);
    const title = string(input.title, 121), content = string(input.content, 10001);
    if (!title || title.length > 120 || !content || content.length > 10000) throw new InputError('请填写公告标题（最多 120 字）和内容（最多 10000 字）。');
    if (!['draft', 'published', 'archived'].includes(input.status)) throw new InputError('公告状态无效。');
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && !Number.isFinite(expiresAt.getTime())) throw new InputError('截止时间无效。');
    const item = { id: id || randomUUID(), title, content, status: input.status, pinned: input.pinned === true,
      expiresAt: expiresAt?.toISOString() || '', createdAt: prior?.createdAt || now(), updatedAt: now() };
    this.db.prepare('INSERT INTO announcements VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(item.id, JSON.stringify(item));
    this.audit(actor, 'announcement.' + item.status, item.id); return item;
  }
  readNotice(userId, id) {
    const item = this.notices(userId).find(item => item.id === id); if (!item) throw new InputError('公告不存在。', 404);
    this.db.prepare('INSERT INTO notice_reads VALUES(?,?,?) ON CONFLICT(user_id,notice_id) DO UPDATE SET version=excluded.version').run(Number(userId), id, item.updatedAt);
  }
  recordTask(userId, task) {
    const payload = JSON.stringify(task);
    const prior = parse(this.db.prepare('SELECT payload FROM tasks WHERE user_id=? AND type=? AND id=?').get(userId, task.type, task.id));
    if (prior && JSON.stringify(prior) === payload) return;
    this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?) ON CONFLICT(user_id,type,id) DO UPDATE SET payload=excluded.payload').run(userId, task.id, task.type, payload);
    if (!prior || prior.state !== task.state) this.db.prepare('INSERT INTO task_events(user_id,task_id,type,state,created_at) VALUES(?,?,?,?,?)').run(userId, task.id, task.type, task.state, task.updatedAt || now());
  }
  syncTasks(userId, state) {
    const titles = new Map((state.projects || []).map(project => [project.id, project.title]));
    const deletedProjects = new Set((state.projects || []).filter(project => project.deletedAt).map(project => project.id));
    const seen = new Set();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const projects = (state.projects || []).filter(project => !project.deletedAt);
      const bytes = (state.projects || []).flatMap(project => project.assets || []).reduce((sum, asset) => sum + (number(asset.size) || 0), 0);
      this.db.prepare('UPDATE members SET project_count=?,asset_bytes=? WHERE id=?').run(projects.length, bytes, userId);
      for (const [field, type] of [['jobs', 'video'], ['imageJobs', 'image'], ['speechJobs', 'speech'], ['voiceJobs', 'voice'], ['previsJobs', 'previs']]) {
        for (const job of state[field] || []) { seen.add(`${type}:${job.id}`); this.recordTask(userId, {
          id: job.id, type, projectId: job.projectId || '', projectTitle: titles.get(job.projectId) || '',
          model: string(job.model || job.request?.model || (type === 'previs' ? 'Blender' : '')), state: job.state,
          // Provider error text and request bodies may contain user prompts or credentials. Keep them out of the ledger.
          message: '', createdAt: job.createdAt || '', updatedAt: job.updatedAt || job.createdAt || '',
          estimate: number(job.estimate), estimateMax: number(job.estimateMax ?? job.estimate), currency: job.pricingCurrency || job.priceUnit || '', actualCost: null,
          usageTokens: null, usageCharacters: number(job.usageCharacters), duration: number(job.duration),
          deleted: Boolean(job.deletedAt || deletedProjects.has(job.projectId)), providerTaskId: string(job.providerTaskId || job.traceId), assetId: job.assetId || '' }); }
      }
      for (const row of this.db.prepare('SELECT payload FROM tasks WHERE user_id=? AND type!=?').all(userId, 'text')) {
        const prior = parse(row); if (!seen.has(`${prior.type}:${prior.id}`) && !prior.deleted) this.recordTask(userId, { ...prior, deleted: true });
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recordText(userId, record) {
    this.recordTask(userId, { id: record.requestId, type: 'text', projectId: record.projectId || '', projectTitle: record.projectTitle || '',
      model: record.model, state: record.status, message: record.code || '', createdAt: record.startedAt, updatedAt: record.finishedAt,
      estimate: null, estimateMax: null, currency: '', actualCost: null, usageTokens: number(record.usage?.totalTokens), usageCharacters: null,
      deleted: false, providerTaskId: '', assetId: '' });
  }
  tasks(userId, query = new URLSearchParams()) {
    const rows = userId === null ? this.db.prepare('SELECT user_id,payload FROM tasks').all() : this.db.prepare('SELECT user_id,payload FROM tasks WHERE user_id=?').all(Number(userId));
    const q = string(query.get('q')).toLowerCase(), type = query.get('type'), status = query.get('status');
    const from = query.get('from') || '', to = query.get('to') || '';
    return rows.map(row => ({ ...parse(row), userId: row.user_id })).filter(row =>
      (!q || [row.id, row.model, row.projectTitle, String(row.userId)].some(value => String(value).toLowerCase().includes(q))) &&
      (!type || row.type === type) && (!from || row.createdAt.slice(0, 10) >= from) && (!to || row.createdAt.slice(0, 10) <= to) &&
      (!status || (status === 'active' ? !TERMINAL.has(row.state) && !ATTENTION.has(row.state) : status === 'attention' ? ATTENTION.has(row.state) : row.state === status))
    ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  summary(userId) {
    const tasks = this.tasks(userId), members = userId === null ? this.db.prepare('SELECT * FROM members').all() : [this.member(userId)].filter(Boolean);
    const estimates = new Map();
    for (const task of tasks) if (task.estimate !== null) {
      const prior = estimates.get(task.currency || '未注明单位') || { amount: 0, amountMax: 0 };
      prior.amount += task.estimate; prior.amountMax += task.estimateMax ?? task.estimate; estimates.set(task.currency || '未注明单位', prior);
    }
    return { total: tasks.length, done: tasks.filter(t => t.state === 'done').length,
      failed: tasks.filter(t => ['error', 'failed'].includes(t.state)).length, attention: tasks.filter(t => ATTENTION.has(t.state)).length,
      active: tasks.filter(t => !TERMINAL.has(t.state) && !ATTENTION.has(t.state)).length,
      users: members.length, disabled: members.filter(m => m.status === 'disabled').length,
      projects: members.reduce((sum, m) => sum + m.project_count, 0), assetBytes: members.reduce((sum, m) => sum + m.asset_bytes, 0),
      estimates: [...estimates].map(([currency, value]) => ({ currency, amount: Math.round(value.amount * 1e6) / 1e6, amountMax: Math.round(value.amountMax * 1e6) / 1e6 })),
      usageTokens: tasks.reduce((sum, t) => sum + (t.usageTokens || 0), 0), usageCharacters: tasks.reduce((sum, t) => sum + (t.usageCharacters || 0), 0) };
  }
  close() { this.db?.close(); }
}
