import { InputError } from './workflow.mjs';
import { pageOf, toCsv } from './management.mjs';

// These handlers run after the gateway's host/origin/session checks and before any per-user application.
export async function managementRequest({ request, response, url, session, management: m, auth, storage, json, requestJson }) {
  const route = url.pathname, method = request.method, userId = Number(session.userId);
  const admin = route.startsWith('/api/admin/');
  if (!admin && !route.startsWith('/api/account/') && !route.startsWith('/api/notices')) return false;
  if (admin && !session.isAdmin) throw new InputError('需要本站管理员权限。', 403);
  const input = async () => requestJson(request, 64 * 1024);
  const ok = value => { json(response, value); return true; };
  const client = request.headers['x-real-ip'] || request.socket.remoteAddress;
  if (route === '/api/account/profile' && method === 'GET') return ok(m.member(userId));
  if (route === '/api/account/profile' && method === 'PUT') return ok(m.profile(userId, await input()));
  if (route === '/api/account/password' && method === 'POST') {
    await auth.changePassword(session, await input(), client); response.setHeader('Set-Cookie', auth.clearCookie());
    return ok({ message: '密码已更新，请重新登录。Pictora 同样使用此新密码。' });
  }
  if (route === '/api/account/sessions' && method === 'GET') return ok(auth.sessionList(session));
  if (route === '/api/account/sessions' && method === 'DELETE') {
    const body = await input(); const id = body.id || '';
    if (id && !auth.sessionList(session).some(item => item.id === id && !item.current)) throw new InputError('请选择其他有效会话。');
    await auth.revokeSessions(userId, session.token, id); m.audit(userId, 'sessions.revoke', id || 'others'); return ok({ ok: true });
  }
  if (route === '/api/account/activity' && method === 'GET') return ok(pageOf(m.auditList(userId), url.searchParams));
  if (['/api/account/summary', '/api/admin/summary'].includes(route) && method === 'GET') return ok(m.summary(admin ? null : userId));
  if (['/api/account/tasks', '/api/admin/tasks'].includes(route) && method === 'GET') return ok(pageOf(m.tasks(admin ? null : userId, url.searchParams), url.searchParams));
  if (route === '/api/account/tasks/export' && method === 'GET') {
    const rows = m.tasks(userId, url.searchParams);
    if (rows.length > 10000) throw new InputError('一次最多导出 10000 条，请缩小日期范围。');
    response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="miraframe-tasks.csv"', 'Cache-Control': 'no-store' });
    response.end(toCsv(rows)); return true;
  }
  if (route === '/api/account/task' && method === 'GET') {
    const task = m.tasks(userId).find(item => item.id === url.searchParams.get('id') && item.type === url.searchParams.get('type'));
    if (!task) throw new InputError('任务不存在。', 404);
    const events = m.db.prepare('SELECT state,created_at FROM task_events WHERE user_id=? AND task_id=? AND type=? ORDER BY id').all(userId, task.id, task.type);
    return ok({ ...task, events });
  }
  if (route === '/api/notices' && method === 'GET') return ok(m.notices(userId));
  const noticeRead = /^\/api\/notices\/([\w-]+)\/read$/.exec(route);
  if (noticeRead && method === 'POST') { await input(); m.readNotice(userId, noticeRead[1]); return ok({ ok: true }); }
  if (route === '/api/admin/users' && method === 'GET') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    // Shared identities are listed, but role and suspension are stored only in this application's database.
    for (const user of auth.db.prepare('SELECT id,email,username FROM users WHERE email IS NOT NULL').all()) m.ensureMember(user);
    const rows = m.db.prepare('SELECT * FROM members ORDER BY joined_at DESC').all().filter(item => !q || [item.email, item.nickname, String(item.id)].some(value => value.toLowerCase().includes(q)));
    return ok(pageOf(rows, url.searchParams));
  }
  const userRoute = /^\/api\/admin\/users\/(\d+)(?:\/(sessions))?$/.exec(route);
  if (userRoute && method === 'PUT' && !userRoute[2]) {
    const updated = m.updateMember(userId, Number(userRoute[1]), await input());
    if (updated.status === 'disabled') await auth.revokeSessions(updated.id);
    return ok(updated);
  }
  if (userRoute?.[2] === 'sessions' && method === 'DELETE') {
    await input(); if (!m.member(userRoute[1])) throw new InputError('用户不存在。', 404);
    if (Number(userRoute[1]) === userId) throw new InputError('请在个人中心管理自己的登录设备。');
    await auth.revokeSessions(userRoute[1]); m.audit(userId, 'user.sessions.revoke', userRoute[1]); return ok({ ok: true });
  }
  if (route === '/api/admin/settings' && method === 'GET') return ok(m.settings);
  if (route === '/api/admin/settings' && method === 'PUT') return ok(m.saveSettings(userId, await input()));
  if (route === '/api/admin/storage' && method === 'GET') return ok(await storage.publicSettings());
  if (route === '/api/admin/storage' && method === 'PUT') {
    await storage.saveSettings(await input()); m.audit(userId, 'storage.update'); return ok(await storage.publicSettings());
  }
  if (route === '/api/admin/storage/test' && method === 'POST') {
    await input(); const result = await storage.testConnection(); m.audit(userId, 'storage.test'); return ok(result);
  }
  if (route === '/api/admin/announcements' && method === 'GET') return ok(m.notices(userId, true));
  if (route === '/api/admin/announcements' && method === 'POST') return ok(m.saveNotice(userId, '', await input()));
  const announcement = /^\/api\/admin\/announcements\/([\w-]+)$/.exec(route);
  if (announcement && method === 'PUT') return ok(m.saveNotice(userId, announcement[1], await input()));
  if (route === '/api/admin/audit' && method === 'GET') return ok(pageOf(m.auditList(), url.searchParams));
  throw new InputError('这个地址不存在。', 404);
}
