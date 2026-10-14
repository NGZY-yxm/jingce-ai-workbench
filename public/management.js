const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const amount = value => value === null || value === undefined ? '未提供' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
const quoteAmount = (min, max) => min == null ? '未提供' : max != null && max !== min ? `${amount(min)}–${amount(max)}` : amount(min);
const types = { video: '视频', image: '图片', text: '文字', speech: '配音', voice: '音色', previs: '预演' };
const states = { waiting: '等待中', preparing: '准备中', submitting: '提交中', queued: '排队中', running: '执行中', done: '已完成', failed: '失败', error: '失败', uncertain: '待核对', download_pending: '待下载', save_pending: '待保存', cancelled: '已取消', canceled: '已取消', saving: '保存中', downloading: '下载中', rendering: '渲染中', building: '构建中', encoding: '编码中', verifying: '检查中', uploading: '上传中', creating: '创建中', resolved: '已处理', 'waiting-local': '等待本机' };
const actions = { 'auth.login': '登录成功', 'auth.register': '注册账号', 'profile.update': '修改个人资料', 'password.change': '修改共享密码', 'password.reset': '找回共享密码', 'sessions.revoke': '退出其他设备', 'user.update': '调整用户权限或状态', 'user.sessions.revoke': '撤销用户会话', 'settings.update': '更新网站参数', 'storage.update': '更新云存储', 'storage.test': '测试云存储', 'announcement.draft': '保存公告草稿', 'announcement.published': '发布公告', 'announcement.archived': '下架公告' };
const btn = (label, attrs = '') => `<button type="button" class="portal-button" ${attrs}>${label}</button>`;
const badge = state => `<span class="portal-badge ${['failed', 'error'].includes(state) ? 'bad' : ['uncertain', 'download_pending', 'save_pending'].includes(state) ? 'warn' : ''}">${escape(states[state] || state)}</span>`;
const empty = text => `<div class="portal-empty">${escape(text)}</div>`;
const table = (headers, rows) => rows.length ? `<div class="portal-table-wrap"><table class="portal-table"><thead><tr>${headers.map(text => `<th>${text}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : empty('暂无记录，开始创作后会在这里显示。');
const field = (label, name, value = '', type = 'text', extra = '') => `<label>${label}<input name="${name}" type="${type}" value="${escape(value)}" ${extra}></label>`;
const check = (label, name, checked) => `<label class="portal-check"><input name="${name}" type="checkbox" ${checked ? 'checked' : ''}>${label}</label>`;
async function request(url, method = 'GET', body) {
  const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { if (response.status === 401 && globalThis.__jingceUserId) location.replace('/'); throw new Error(data.error || '请求未完成，请重试。'); }
  return data;
}

export function initManagement() {
  let user, scope = 'account', tab = 'overview', revision = 0, pageNum = 1, filters = {}, noticeCache = [], busy = false;
  const sidebar = document.querySelector('.sidebar-bottom');
  const links = document.createElement('div');
  links.className = 'portal-sidebar-links';
  links.innerHTML = `<button class="nav-button portal-nav-entry" id="personal-center">个人中心 <span>账号与任务</span></button><button class="nav-button portal-nav-entry" id="notice-center">公告中心 <span id="notice-count"></span></button><button class="nav-button portal-nav-entry" id="admin-center" hidden>管理后台 <span>ADMIN</span></button>`;
  sidebar.prepend(links);
  document.querySelector('#connections-center-button').textContent = '模型连接 · API';
  const license = document.querySelector('.license-note small'); if (license) license.textContent = '工程和密钥按账号保存在服务器';
  const localDot = document.querySelector('.local-dot'); if (localDot) localDot.textContent = '云端';
  const dialog = document.createElement('dialog'); dialog.id = 'management-dialog'; dialog.className = 'portal-dialog'; dialog.setAttribute('aria-labelledby', 'portal-title');
  dialog.innerHTML = `<header class="portal-header"><div><div class="portal-eyebrow">MIRAFRAME · WORKSPACE</div><h2 id="portal-title">个人中心</h2></div><button type="button" class="portal-close" data-close aria-label="关闭管理面板">关闭 ✕</button></header><div class="portal-layout"><nav class="portal-nav" aria-label="管理导航"></nav><main class="portal-main"><div class="portal-feedback" role="status" aria-live="polite"></div><div class="portal-content"></div></main></div>`;
  document.body.append(dialog);
  const detail = document.createElement('dialog'); detail.id = 'management-detail'; detail.className = 'portal-dialog portal-detail'; document.body.append(detail);
  const content = dialog.querySelector('.portal-content'), feedback = dialog.querySelector('.portal-feedback');
  const message = (value, error = false) => { feedback.textContent = value; feedback.classList.toggle('error', error); };
  const params = () => new URLSearchParams({ ...filters, page: String(pageNum), pageSize: '20' });
  const pagination = data => `<div class="portal-pagination"><span>共 ${data.total} 条 · 第 ${data.page} / ${Math.max(1, Math.ceil(data.total / data.pageSize))} 页</span>${btn('上一页', `data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}`)}${btn('下一页', `data-page="${data.page + 1}" ${data.page * data.pageSize >= data.total ? 'disabled' : ''}`)}</div>`;
  const tabs = () => scope === 'admin' ? { overview: '运营概览', users: '用户管理', tasks: '全站任务', announcements: '公告管理', settings: '网站参数', capabilities: '模型能力', storage: '云存储', audit: '操作日志' }
    : { overview: '我的概览', tasks: '任务中心', ledger: '费用与用量', notices: '公告消息', profile: '个人资料', security: '账号安全', activity: '登录与操作记录' };
  function navigation() {
    dialog.dataset.scope = scope;
    dialog.dataset.tab = tab;
    dialog.querySelector('#portal-title').textContent = scope === 'admin' ? '管理后台' : '个人中心';
    dialog.querySelector('.portal-nav').innerHTML = Object.entries(tabs()).map(([key, label]) => `<button type="button" data-tab="${key}" aria-selected="${tab === key}">${label}</button>`).join('');
  }
  async function unread() {
    if (!user) return;
    const notices = await request('/api/notices'); const count = notices.filter(n => !n.read).length;
    document.querySelector('#notice-count').textContent = count ? `${count} 条未读` : '全部已读';
  }
  function open(nextScope, nextTab = 'overview') {
    scope = nextScope; tab = nextTab; filters = {}; pageNum = 1; navigation();
    if (!dialog.open) dialog.showModal(); load();
  }
  document.querySelector('#personal-center').onclick = () => open('account');
  document.querySelector('#notice-center').onclick = () => open('account', 'notices');
  document.querySelector('#admin-center').onclick = () => open('admin');
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { revision++; if (detail.open) detail.close(); });
  const formStart = name => `<form class="portal-form" data-form="${name}">`;
  const saveButton = text => `<div class="portal-actions"><button class="portal-button primary" type="submit">${text}</button></div></form>`;
  function taskFilters() {
    return `<form class="portal-filters" data-form="filters"><input name="q" type="search" aria-label="搜索任务" placeholder="搜索工程、模型、任务编号" value="${escape(filters.q || '')}"><select name="type" aria-label="任务类型"><option value="">全部类型</option>${Object.entries(types).map(([key, text]) => `<option value="${key}" ${filters.type === key ? 'selected' : ''}>${text}</option>`).join('')}</select><select name="status" aria-label="任务状态">${[['', '全部状态'], ['active', '处理中'], ['done', '已完成'], ['failed', '失败'], ['error', '文字请求失败'], ['attention', '待核对 / 待保存']].map(([key, text]) => `<option value="${key}" ${filters.status === key ? 'selected' : ''}>${text}</option>`).join('')}</select><input name="from" type="date" aria-label="开始日期" value="${escape(filters.from || '')}"><input name="to" type="date" aria-label="结束日期" value="${escape(filters.to || '')}"><button type="submit" class="portal-button">筛选</button>${btn('重置', 'data-reset-filters')}</form>`;
  }
  function taskRows(data, ledger) {
    return table(ledger ? ['时间 / 类型', '工程 / 模型', '状态', '预估费用', '实际扣费', '用量', ''] : ['任务 / 创建时间', '工程 / 模型', '类型', '状态', ''], data.items.map(t => `<tr><td>${ledger ? escape(date(t.createdAt)) + '<small>' + (types[t.type] || t.type) + '</small>' : escape(t.id.slice(0, 8)) + `<small>${escape(date(t.createdAt))}</small>`}</td><td>${escape(t.projectTitle || '未关联工程')}<small>${escape(t.model || '—')}${scope === 'admin' ? ` · 用户 ${t.userId}` : ''}</small></td>${ledger ? '' : `<td>${escape(types[t.type] || t.type)}</td>`}<td>${badge(t.state)}</td>${ledger ? `<td>${quoteAmount(t.estimate, t.estimateMax)}<small>${escape(t.currency)}</small></td><td>${amount(t.actualCost)}</td><td>${t.usageTokens !== null ? `${amount(t.usageTokens)} tokens` : t.usageCharacters !== null ? `${amount(t.usageCharacters)} 字符` : '—'}</td>` : ''}<td>${scope === 'account' ? btn('详情', `data-task="${escape(t.id)}" data-type="${escape(t.type)}"`) : ''}</td></tr>`));
  }
  async function renderView() {
    if (tab === 'overview') {
      const s = await request(`/api/${scope}/summary`);
      const cards = scope === 'admin' ? [['用户总数', s.users], ['工程总数', s.projects], ['处理中', s.active], ['待核对', s.attention]] : [['全部任务', s.total], ['已完成', s.done], ['处理中', s.active], ['失败 / 待核对', s.failed + s.attention]];
      return `<div class="portal-identity"><span class="portal-avatar">${escape((user.nickname || user.username).slice(0, 1))}</span><div><h3>${scope === 'admin' ? '创作平台运行概况' : `你好，${escape(user.nickname || user.username)}`}</h3><small>${escape(user.email)}</small></div></div><p class="portal-subtitle">${scope === 'admin' ? '账号权限与停用状态仅影响幻帧。' : '集中查看创作进度、用量和账号安全。'}</p><div class="portal-cards">${cards.map(([label, value]) => `<div class="portal-stat"><small>${label}</small><strong>${amount(value)}</strong></div>`).join('')}</div><section class="portal-panel"><h4>用量概览</h4><p class="portal-help">${s.projects} 个工程 · ${amount(s.assetBytes / 1024 / 1024)} MB 素材（已记录文件大小）</p><p class="portal-help">文字 ${amount(s.usageTokens)} tokens · 配音 ${amount(s.usageCharacters)} 字符</p><p class="portal-help">${s.estimates.length ? s.estimates.map(e => `${quoteAmount(e.amount, e.amountMax)} ${escape(e.currency)}`).join(' / ') : '暂无可用报价'} · 历史任务预估费用合计</p></section><section class="portal-panel"><h4>快捷入口</h4><div class="portal-actions">${btn('查看任务', 'data-tab="tasks"')}${scope === 'admin' ? btn('发布公告', 'data-tab="announcements"') + btn('管理用户', 'data-tab="users"') : btn('修改密码', 'data-tab="security"') + btn('查看公告', 'data-tab="notices"')}</div></section>`;
    }
    if (tab === 'tasks' || tab === 'ledger') {
      const data = await request(`/api/${scope}/tasks?${params()}`), ledger = tab === 'ledger';
      return `<h3>${ledger ? '费用与用量流水' : '任务中心'}</h3><p class="portal-subtitle">${ledger ? '预估费用来自任务创建时的报价，包含失败和已删除的历史任务。实际扣费以模型服务商账单为准；未返回的金额显示“未提供”。不同单位分别展示。' : '跨工程汇总任务，每 15 秒更新。待核对的任务请先核对服务商记录，避免重复生成。'}</p><div class="portal-actions">${btn('刷新', 'data-refresh')}${scope === 'account' ? btn('导出筛选结果 CSV', 'data-export') : ''}</div>${taskFilters()}${taskRows(data, ledger)}${pagination(data)}`;
    }
    if (tab === 'profile') {
      const profile = await request('/api/account/profile');
      return `<h3>个人资料</h3><p class="portal-subtitle">显示名称仅在幻帧生效。登录邮箱与 Pictora 共用。</p>${formStart('profile')}${field('显示名称', 'nickname', profile.nickname, 'text', 'required minlength="2" maxlength="40"')}${field('登录邮箱', 'email', profile.email, 'email', 'disabled')}${field('注册用户名', 'username', profile.username, 'text', 'disabled')}<p class="portal-help">本站建档：${date(profile.joined_at)}<br>最近活动：${date(profile.last_seen)}</p>${saveButton('保存资料')}`;
    }
    if (tab === 'security') {
      const sessions = await request('/api/account/sessions');
      return `<h3>账号安全</h3><p class="portal-subtitle">修改密码后，Pictora 与幻帧使用同一个新密码。所有幻帧登录会话将退出，需要重新登录。</p><section class="portal-panel">${formStart('password')}${field('当前密码', 'currentPassword', '', 'password', 'required autocomplete="current-password"')}${field('新密码', 'newPassword', '', 'password', 'required minlength="8" autocomplete="new-password"')}${field('确认新密码', 'confirmPassword', '', 'password', 'required minlength="8" autocomplete="new-password"')}${saveButton('更新共享密码')}</section><section class="portal-panel"><h4>登录设备</h4><p class="portal-subtitle">以下为本站会话，设备信息由浏览器提供。</p>${table(['设备', '最近活动', '到期时间', '操作'], sessions.map(s => `<tr><td title="${escape(s.agent)}">${escape(s.agent.slice(0, 60))}<small>${escape(s.client)} ${s.current ? '· 当前设备' : ''}</small></td><td>${date(s.lastSeenAt)}</td><td>${date(s.expiresAt)}</td><td>${s.current ? '当前设备' : btn('退出', `data-revoke="${escape(s.id)}"`)}</td></tr>`))}<div class="portal-actions" style="margin-top:16px">${btn('退出其他所有设备', 'data-revoke="all"')}</div></section>`;
    }
    if (tab === 'notices') {
      const notices = await request('/api/notices');
      return `<h3>公告消息</h3><p class="portal-subtitle">了解服务更新、维护通知和使用提示。</p>${notices.length ? notices.map(n => `<article class="portal-notice"><header><h4>${n.pinned ? '📌 ' : ''}${escape(n.title)}</h4>${n.read ? '<span class="portal-badge">已读</span>' : btn('标记已读', `data-read="${n.id}"`)}</header><p>${escape(n.content)}</p><small>${date(n.updatedAt)}${n.expiresAt ? ` · 截止 ${date(n.expiresAt)}` : ''}</small></article>`).join('') : empty('暂无公告。')}`;
    }
    if (tab === 'users') {
      const data = await request('/api/admin/users?' + params());
      return `<h3>用户管理</h3><p class="portal-subtitle">共享邮箱账号，本项目独立授权。停用只影响幻帧，不会删除工程，也不会停用 Pictora。</p><form data-form="filters" class="portal-filters"><input name="q" type="search" aria-label="搜索用户" placeholder="邮箱、显示名称或用户 ID" value="${escape(filters.q || '')}"><button class="portal-button" type="submit">搜索</button></form>${table(['用户', '角色 / 状态', '工程 / 最近活动', '操作'], data.items.map(u => `<tr><td>${escape(u.nickname)}<small>${escape(u.email)} · #${u.id}</small></td><td>${u.role === 'admin' ? '管理员' : '用户'}<small>${u.status === 'disabled' ? '已停用' : '正常'}</small></td><td>${u.project_count} 个工程<small>${date(u.last_seen)}</small></td><td>${u.id === user.id ? '当前账号' : `<div class="portal-actions">${btn(u.status === 'active' ? '停用' : '启用', `data-user="${u.id}" data-status="${u.status === 'active' ? 'disabled' : 'active'}"`)}${btn(u.role === 'admin' ? '设为用户' : '设为管理员', `data-user="${u.id}" data-role="${u.role === 'admin' ? 'user' : 'admin'}"`)}${btn('退出会话', `data-user-sessions="${u.id}"`)}</div>`}</td></tr>`))}${pagination(data)}`;
    }
    if (tab === 'announcements') {
      noticeCache = await request('/api/admin/announcements');
      return `<h3>公告管理</h3><p class="portal-subtitle">支持草稿、发布、置顶、截止时间和下架。修改已发布公告后，用户会重新看到未读提示。</p>${btn('＋ 新建公告', 'data-edit-notice="new"')}${noticeCache.map(n => `<article class="portal-notice"><header><h4>${n.pinned ? '📌 ' : ''}${escape(n.title)}</h4>${btn('编辑', `data-edit-notice="${n.id}"`)}</header><p>${escape(n.content.slice(0, 180))}</p><small>${({ draft: '草稿', published: '已发布', archived: '已下架' })[n.status]} · ${date(n.updatedAt)}</small></article>`).join('')}`;
    }
    if (tab === 'settings') {
      const s = await request('/api/admin/settings');
      return `<h3>网站参数</h3><p class="portal-subtitle">保存后立即生效。维护期间普通用户可以查看已有记录和管理账号，暂停提交创作与修改工程。</p>${formStart('settings')}${field('网站名称', 'siteName', s.siteName, 'text', 'required maxlength="60"')}<label>联系支持 / 使用说明<textarea name="supportText" maxlength="1000">${escape(s.supportText)}</textarea></label>${field('每位用户的有效工程数量上限', 'maxProjects', s.maxProjects, 'number', 'required min="1" max="10000"')}${check('开放新用户注册', 'registrationEnabled', s.registrationEnabled)}${check('开启维护模式', 'maintenance', s.maintenance)}<label>维护提示<textarea name="maintenanceMessage" maxlength="500">${escape(s.maintenanceMessage)}</textarea></label>${saveButton('保存网站参数')}`;
    }
    if (tab === 'capabilities' && scope === 'admin') {
      return `<h3>模型能力</h3><p class="portal-subtitle">逐个设置视频模型允许选择的分辨率、图片模型允许选择的画质，并查看参考素材限制及平台同步信息。</p><section class="portal-panel"><h4>视频模型</h4><p class="portal-help">设置每个模型的可选分辨率，例如仅开放 720P，或同时开放 720P 和 1080P；分别配置对应的生成时长。</p><div class="portal-actions">${btn('管理视频模型能力', 'data-model-capability="video"')}</div></section><section class="portal-panel"><h4>图片模型</h4><p class="portal-help">管理画面比例、画质及参考图片数量等能力设置。</p><div class="portal-actions">${btn('管理图片模型能力', 'data-model-capability="image"')}</div></section><p class="portal-help">设置用于当前登录账号的模型连接。保存后立即更新生成页面与画布的选项，自动同步平台数据时会保留手动配置的分辨率和画质。</p>`;
    }
    if (tab === 'storage') {
      const s = await request('/api/admin/storage');
      return `<h3>统一云存储</h3><p class="portal-subtitle">沿用当前服务器配置，供所有用户准备生成参考素材。新上传的对象按账号划分目录。密钥不回显，留空保留原值。</p>${formStart('storage')}<label>提供商<select name="provider"><option value="r2" ${s.provider === 'r2' ? 'selected' : ''}>Cloudflare R2</option><option value="cos" ${s.provider !== 'r2' ? 'selected' : ''}>腾讯云 COS</option></select></label>${field('存储桶 Bucket', 'bucket', s.bucket, 'text', 'required')}${field('R2 S3 Endpoint（COS 可留空）', 'endpoint', s.endpoint || '', 'url')}${field('地域（R2 使用 auto）', 'region', s.region)}${field('对象目录前缀', 'prefix', s.prefix)}<div class="portal-grid">${field('Access Key ID / Secret ID', 'secretId', '', 'password', 'autocomplete="off"')}${field('Secret Access Key / Secret Key', 'secretKey', '', 'password', 'autocomplete="off"')}</div>${field('临时链接有效期（小时）', 'expiresHours', s.expiresHours, 'number', 'required min="1" max="168"')}${check('启用自动上传参考素材', 'enabled', s.enabled)}<p class="portal-help">${s.ready ? '当前配置已就绪' : '当前配置尚未完整'} · ${s.hasCredentials ? '已保存密钥' : '未保存密钥'}</p><div class="portal-actions"><button class="portal-button primary" type="submit">保存配置</button>${btn('测试已保存配置', 'data-test-storage')}</div></form>`;
    }
    if (tab === 'audit' || tab === 'activity') {
      const data = await request((tab === 'audit' ? '/api/admin/audit?' : '/api/account/activity?') + params());
      return `<h3>${tab === 'audit' ? '管理操作日志' : '登录与操作记录'}</h3><p class="portal-subtitle">记录登录、账号安全、权限、公告和参数变更。不会记录密码、验证码或 API 密钥。</p>${table(['时间', '操作', '账号', '对象'], data.items.map(a => `<tr><td>${date(a.created_at)}</td><td>${escape(actions[a.action] || a.action)}</td><td>#${a.actor}</td><td>${escape(a.target || '—')}</td></tr>`))}${pagination(data)}`;
    }
    return '';
  }
  async function load(silent = false) {
    const version = ++revision;
    if (!silent) { message(''); content.innerHTML = empty('正在加载…'); }
    try { const html = await renderView(); if (version === revision && dialog.open) content.innerHTML = html; }
    catch (error) { if (version === revision) { if (!silent) content.innerHTML = empty('加载失败，可点击当前导航重试。'); message(error.message, true); } }
  }
  async function perform(operation) {
    if (busy) return; busy = true; message('');
    try { await operation(); } catch (error) { message(error.message, true); const info = detail.querySelector('[role=status]'); if (info) info.textContent = error.message; }
    finally { busy = false; }
  }
  dialog.addEventListener('click', event => {
    const target = event.target.closest('button'); if (!target || target.disabled) return;
    if (target.dataset.tab) { tab = target.dataset.tab; filters = {}; pageNum = 1; navigation(); load(); }
    else if (target.dataset.page) { pageNum = Number(target.dataset.page); load(); }
    else if (target.hasAttribute('data-refresh')) load();
    else if (target.hasAttribute('data-export')) perform(async () => {
      target.disabled = true;
      try {
        const response = await fetch('/api/account/tasks/export?' + params(), { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) { const error = await response.json(); throw new Error(error.error || '导出失败。'); }
        const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
        link.href = url; link.download = 'miraframe-tasks.csv'; document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000); message('导出文件已生成。');
      } finally { target.disabled = false; }
    });
    else if (target.hasAttribute('data-reset-filters')) { filters = {}; pageNum = 1; load(); }
    else if (target.dataset.task) perform(async () => {
      const t = await request(`/api/account/task?id=${encodeURIComponent(target.dataset.task)}&type=${target.dataset.type}`);
      detail.innerHTML = `<div class="portal-actions" style="justify-content:space-between"><h3>任务详情</h3>${btn('关闭', 'data-detail-close')}</div><dl>${[['任务编号', t.id], ['工程', t.projectTitle || '未关联'], ['类型', types[t.type]], ['模型', t.model], ['状态', states[t.state] || t.state], ['预估费用', `${quoteAmount(t.estimate, t.estimateMax)} ${t.currency}`], ['实际扣费', amount(t.actualCost)], ['上游编号', t.providerTaskId || '未返回'], ['历史记录', t.deleted ? '结果已删除，流水保留' : '保留中']].map(([label, value]) => `<dt>${label}</dt><dd>${escape(value)}</dd>`).join('')}</dl><h4>状态时间线</h4><ol class="portal-timeline">${t.events.map(e => `<li>${date(e.created_at)} · ${escape(states[e.state] || e.state)}</li>`).join('')}</ol><p class="portal-help">实际扣费请在对应模型服务商核对。</p>`;
      detail.showModal();
    });
    else if (target.dataset.read) perform(async () => { await request(`/api/notices/${target.dataset.read}/read`, 'POST', {}); await load(); await unread(); });
    else if (target.hasAttribute('data-revoke')) perform(async () => { await request('/api/account/sessions', 'DELETE', { id: target.dataset.revoke === 'all' ? '' : target.dataset.revoke }); await load(); message('其他登录会话已退出。'); });
    else if (target.dataset.user) perform(async () => {
      if (!confirm(`确认${target.textContent}该用户？此操作只影响幻帧。`)) return;
      await request(`/api/admin/users/${target.dataset.user}`, 'PUT', target.dataset.role ? { role: target.dataset.role } : { status: target.dataset.status }); await load(); message('用户权限已更新。');
    });
    else if (target.dataset.userSessions) perform(async () => { if (!confirm('确认退出该用户的所有幻帧登录会话？')) return; await request(`/api/admin/users/${target.dataset.userSessions}/sessions`, 'DELETE', {}); message('用户登录会话已撤销。'); });
    else if (target.hasAttribute('data-test-storage')) perform(async () => { target.disabled = true; message('正在测试上传、读取与清理…'); try { message((await request('/api/admin/storage/test', 'POST', {})).message); } finally { target.disabled = false; } });
    else if (target.dataset.editNotice) {
      const n = noticeCache.find(n => n.id === target.dataset.editNotice) || {};
      detail.innerHTML = `<div class="portal-actions" style="justify-content:space-between"><h3>${n.id ? '编辑公告' : '新建公告'}</h3>${btn('关闭', 'data-detail-close')}</div>${formStart('announcement')}<input name="id" type="hidden" value="${escape(n.id || '')}">${field('公告标题', 'title', n.title || '', 'text', 'required maxlength="120"')}<label>公告内容<textarea name="content" required maxlength="10000">${escape(n.content || '')}</textarea></label><label>发布状态<select name="status">${[['draft', '草稿'], ['published', '发布'], ['archived', '下架']].map(([value, text]) => `<option value="${value}" ${n.status === value ? 'selected' : ''}>${text}</option>`).join('')}</select></label>${check('置顶公告', 'pinned', n.pinned)}${field('截止时间（可选）', 'expiresAt', n.expiresAt ? new Date(new Date(n.expiresAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '', 'datetime-local')}<p role="status" class="portal-feedback"></p>${saveButton('保存公告')}`;
      detail.showModal();
    }
  });
  detail.addEventListener('click', event => { if (event.target.closest('[data-detail-close]')) detail.close(); });
  async function submit(event) {
    const form = event.target.closest('form[data-form]'); if (!form) return; event.preventDefault();
    const data = Object.fromEntries(new FormData(form)), kind = form.dataset.form;
    if (kind === 'filters') { filters = data; pageNum = 1; await load(); return; }
    await perform(async () => {
      const button = form.querySelector('[type=submit]'); button.disabled = true;
      try {
        if (kind === 'profile') { const p = await request('/api/account/profile', 'PUT', { nickname: data.nickname }); user.nickname = p.nickname; await load(); message('个人资料已保存。'); }
        if (kind === 'password') {
          if (data.newPassword !== data.confirmPassword) throw new Error('两次输入的新密码不一致。');
          await request('/api/account/password', 'POST', { currentPassword: data.currentPassword, newPassword: data.newPassword });
          sessionStorage.setItem('jingce-auth-notice', '密码已更新，Pictora 与幻帧均使用新密码，请重新登录。'); location.replace('/');
        }
        if (kind === 'settings') { await request('/api/admin/settings', 'PUT', { ...data, maxProjects: Number(data.maxProjects), registrationEnabled: form.elements.registrationEnabled.checked, maintenance: form.elements.maintenance.checked }); await load(); await loadSite(); message('网站参数已保存并生效。'); }
        if (kind === 'storage') { await request('/api/admin/storage', 'PUT', { ...data, expiresHours: Number(data.expiresHours), enabled: form.elements.enabled.checked }); await load(); message('统一云存储配置已保存。'); }
        if (kind === 'announcement') {
          const id = data.id; delete data.id;
          await request('/api/admin/announcements' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', { ...data, expiresAt: data.expiresAt ? new Date(data.expiresAt).toISOString() : '', pinned: form.elements.pinned.checked });
          detail.close(); await load(); await unread(); message('公告已保存。');
        }
      } finally { button.disabled = false; }
    });
  }
  dialog.addEventListener('submit', submit); detail.addEventListener('submit', submit);
  setInterval(() => { if (user) unread().catch(() => {}); if (dialog.open && !detail.open && !busy && ['overview', 'tasks'].includes(tab) && !dialog.querySelector('.portal-filters')?.contains(document.activeElement)) load(true); }, 15000);

  // Password recovery is available before login and shares the same password policy as account settings.
  const resetButton = document.createElement('button'); resetButton.type = 'button'; resetButton.className = 'text-button'; resetButton.textContent = '忘记密码？'; resetButton.id = 'forgot-password';
  document.querySelector('#login-form').append(resetButton);
  const recovery = document.createElement('dialog'); recovery.id = 'password-recovery'; recovery.className = 'portal-dialog portal-detail';
  recovery.innerHTML = `<div class="portal-actions" style="justify-content:space-between"><h3>找回密码</h3>${btn('关闭', 'data-recovery-close')}</div><p class="portal-subtitle">验证邮箱后设置新密码。Pictora 与幻帧的密码会同时更新。</p><form class="portal-form">${field('注册邮箱', 'email', '', 'email', 'required autocomplete="email"')}<div class="portal-actions">${btn('发送验证码', 'id="reset-code"')}</div>${field('邮箱验证码', 'verificationCode', '', 'text', 'required pattern="[0-9]{6}" inputmode="numeric" maxlength="6"')}${field('新密码', 'newPassword', '', 'password', 'required minlength="8" autocomplete="new-password"')}${field('确认新密码', 'confirmPassword', '', 'password', 'required minlength="8" autocomplete="new-password"')}<p role="status" class="portal-feedback"></p><button type="submit" class="portal-button primary">重置共享密码</button></form>`;
  document.body.append(recovery); resetButton.onclick = () => recovery.showModal(); recovery.querySelector('[data-recovery-close]').onclick = () => recovery.close();
  const resetForm = recovery.querySelector('form'), resetInfo = recovery.querySelector('[role=status]');
  recovery.querySelector('#reset-code').onclick = async event => {
    const button = event.currentTarget; if (!resetForm.elements.email.reportValidity()) return; button.disabled = true;
    try { const result = await request('/api/auth/reset-code', 'POST', { email: resetForm.elements.email.value }); resetInfo.textContent = result.message; let seconds = 60; button.textContent = `${seconds} 秒后重试`; const timer = setInterval(() => { seconds--; button.textContent = seconds ? `${seconds} 秒后重试` : '发送验证码'; if (!seconds) { clearInterval(timer); button.disabled = false; } }, 1000); }
    catch (error) { resetInfo.textContent = error.message; button.disabled = false; }
  };
  resetForm.onsubmit = async event => {
    event.preventDefault(); const button = resetForm.querySelector('[type=submit]'); button.disabled = true;
    try { const data = Object.fromEntries(new FormData(resetForm)); if (data.newPassword !== data.confirmPassword) throw new Error('两次输入的新密码不一致。'); const result = await request('/api/auth/reset-password', 'POST', data); resetForm.reset(); recovery.close(); document.querySelector('#auth-message').textContent = result.message; }
    catch (error) { resetInfo.textContent = error.message; } finally { button.disabled = false; }
  };
  async function loadSite() {
    const site = await request('/api/site'); document.title = site.siteName + ' · AI 创作工作台';
    document.querySelector('[data-auth-tab=register]').hidden = !site.registrationEnabled;
    if (!site.registrationEnabled) document.querySelector('[data-auth-tab=login]').click();
    let note = document.querySelector('#portal-site-note'); if (!note) { note = document.createElement('p'); note.id = 'portal-site-note'; note.className = 'portal-site-note'; document.querySelector('.auth-card').append(note); }
    note.textContent = [site.maintenance ? site.maintenanceMessage : '', site.supportText].filter(Boolean).join('\n');
  }
  loadSite().catch(() => {});
  try { const notice = sessionStorage.getItem('jingce-auth-notice'); if (notice) { document.querySelector('#auth-message').textContent = notice; sessionStorage.removeItem('jingce-auth-notice'); } } catch {}
  return { setUser(value) { user = value; document.querySelector('#admin-center').hidden = !value.isAdmin; unread().catch(() => {}); } };
}
