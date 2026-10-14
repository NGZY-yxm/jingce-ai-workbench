import { defaultPrevisSpec, parsePrevisSpec, previsDimensions } from './previs-spec.js';
import { parsePrevisRevision, previsChanges, previsEditorSignature, previsRevisionMessages } from './previs-revision.js';

const helperUrl = 'http://127.0.0.1:18973';
const activeStates = new Set(['waiting-local', 'queued', 'building', 'rendering', 'encoding', 'verifying', 'saving']);
const labels = { 'waiting-local': '等待本机助手', queued: '排队中', building: '建立白模', rendering: '渲染中', encoding: '合成 MP4', verifying: '检查输出', saving: '保存到网站', done: '已完成', failed: '未完成', cancelled: '已取消' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export function createPrevisWorkflow({ document, api, getState, flush, toast, onProjectUpdate, onUseVideo, onPlaceAsset }) {
  const $ = selector => document.querySelector(selector);
  const storage = globalThis.localStorage;
  const scopedStorageKey = key => globalThis.__jingceUserId ? `jingce-user:${globalThis.__jingceUserId}:${key}` : key;
  const origin = globalThis.location?.origin || 'http://127.0.0.1';
  const localPage = ['127.0.0.1', 'localhost', '[::1]'].includes(globalThis.location?.hostname || '127.0.0.1');
  let projectId = '', jobs = [], tools = null, loading = false, busy = false, sceneVersion = 0, helperToken = '', jobMarkup = '';
  let chatHistory = [], chatVersions = [], chatProposal = null, chatSource = null, sceneEstablished = false;
  const draftCache = new Map(), pendingChatRequests = new Set();
  const saving = new Set();
  function loadHelperToken() { try { helperToken = storage?.getItem(scopedStorageKey('jingce-blender-helper-token')) || ''; } catch { /* The current page can still pair. */ } }
  const useHelper = () => !localPage || Boolean($('#previs-use-helper')?.checked);
  const message = (text = '', error = false) => { const element = $('#previs-message'); if (element) { element.textContent = text; element.classList.toggle('error', error); } };
  const chatMessage = (text = '', error = false) => { const element = $('#previs-chat-status'); if (element) { element.textContent = text; element.classList.toggle('error', error); } };
  const jsonValue = () => $('#previs-spec').value;
  const preferences = () => ({ duration: Number($('#previs-duration').value), fps: Number($('#previs-fps').value),
    ratio: $('#previs-ratio').value, resolution: Number($('#previs-resolution').value) });
  const editorSignature = () => previsEditorSignature(jsonValue(), $('#previs-story').value, preferences());
  function currentValidationError() {
    try { parsePrevisSpec(jsonValue()); return ''; } catch (error) { return error.message; }
  }
  const lastAssistant = () => chatHistory.findLast(item => item.role === 'assistant');
  function storedDraft(id) {
    if (draftCache.has(id)) return draftCache.get(id);
    let value; try { value = JSON.parse(storage?.getItem(scopedStorageKey('jingce-previs-draft:' + id)) || 'null'); } catch {}
    value = value && typeof value === 'object' ? value : {};
    draftCache.set(id, value); return value;
  }
  function persistDraft(id, value) {
    if (!id) return;
    draftCache.set(id, value);
    try { storage?.setItem(scopedStorageKey('jingce-previs-draft:' + id), JSON.stringify(value)); } catch { /* The current page keeps its draft. */ }
  }
  function saveDraft() {
    if (!projectId) return;
    persistDraft(projectId, { story: $('#previs-story').value, json: jsonValue(), chatInput: $('#previs-chat-input').value,
      chatHistory: chatHistory.slice(-24), chatVersions: chatVersions.slice(-20), chatProposal, chatSource, sceneEstablished, preferences: preferences() });
  }
  function restoreDraft() {
    const draft = storedDraft(projectId);
    $('#previs-story').value = draft?.story || '';
    $('#previs-spec').value = typeof draft.json === 'string' ? draft.json : JSON.stringify(defaultPrevisSpec(), null, 2);
    $('#previs-chat-input').value = draft?.chatInput || '';
    sceneEstablished = draft.sceneEstablished ?? Boolean(draft.story?.trim() || draft.chatSource || draft.chatVersions?.length
      || (draft.json && previsEditorSignature(draft.json) !== previsEditorSignature(JSON.stringify(defaultPrevisSpec()))));
    for (const [key, value] of Object.entries(draft.preferences || { duration: 8, fps: 24, ratio: '16:9', resolution: 360 })) {
      if ($('#previs-' + key)) $('#previs-' + key).value = String(value);
    }
    chatHistory = Array.isArray(draft?.chatHistory) ? draft.chatHistory.slice(-24).filter(item => item && ['user', 'assistant', 'context'].includes(item.role) && typeof item.content === 'string') : [];
    for (const item of chatHistory) if (item.pending && !pendingChatRequests.has(item.requestId)) {
      delete item.pending; item.failed = true;
      if (!$('#previs-chat-input').value) $('#previs-chat-input').value = item.content;
    }
    chatVersions = Array.isArray(draft?.chatVersions) ? draft.chatVersions.slice(-20).filter(item => item && typeof item.json === 'string') : [];
    chatProposal = draft?.chatProposal && typeof draft.chatProposal.json === 'string' && typeof draft.chatProposal.signature === 'string' ? draft.chatProposal : null;
    chatSource = draft?.chatSource && typeof draft.chatSource.name === 'string' ? draft.chatSource : null;
    sceneVersion++; summary(false);
    // Existing browser drafts used a signature without render preferences.
    if (chatProposal?.signature === previsEditorSignature(jsonValue(), $('#previs-story').value)) chatProposal.signature = editorSignature();
    renderChat();
  }
  function saveVersion(label) {
    const json = jsonValue(), story = $('#previs-story').value;
    const previous = chatVersions.at(-1);
    if (previous?.json === json && previous.story === story && previous.sceneEstablished === sceneEstablished
      && JSON.stringify(previous.preferences) === JSON.stringify(preferences())) { previous.label = label; previous.at = new Date().toISOString(); return; }
    chatVersions.push({ id: crypto.randomUUID(), label, at: new Date().toISOString(), json, story, sceneEstablished, preferences: preferences() });
    chatVersions = chatVersions.slice(-20);
  }
  function chatContext(text) {
    chatHistory.push({ role: 'context', content: text }); chatHistory = chatHistory.slice(-24);
  }
  function renderChatControls() {
    $('#previs-chat-send').disabled = busy || !$('#previs-chat-input').value.trim();
    $('#previs-chat-clear').disabled = busy || (!chatHistory.length && !chatProposal);
    $('#previs-chat-repair').disabled = busy || (!currentValidationError() && !lastAssistant()?.raw);
    $('#previs-chat-apply').disabled = busy || !chatProposal || chatProposal.signature !== editorSignature();
    $('#previs-chat-discard').disabled = busy || !chatProposal;
    $('#previs-version-restore').disabled = busy || !chatVersions.length;
  }
  function renderChat() {
    const source = $('#previs-chat-source');
    source.textContent = chatSource ? `当前修改起点：${chatSource.name}（预演任务 ${chatSource.id.slice(0, 8)}）`
      : sceneEstablished ? `当前场景：${$('#previs-summary').textContent.split(' · ')[0] || '场景编辑框'}。可继续修改，也可选择右侧预演结果。`
      : '从一句故事开始：描述人物、空间与镜头，助手会在这里整理场景。';
    const host = $('#previs-chat-history');
    host.innerHTML = chatHistory.length ? chatHistory.map(item => item.role === 'context'
      ? `<p class="previs-chat-empty">${escape(item.content)}</p>`
      : `<div class="previs-chat-message ${item.role}${item.failed ? ' failed' : ''}"><strong>${item.role === 'user' ? '你' : '导演助手'}</strong><br>${escape(item.content)}${item.raw ? `<details class="previs-chat-raw"><summary>查看未通过检查的原始回复</summary><pre>${escape(item.raw)}</pre></details>` : ''}${item.failed ? '<small>未收到本次回复，不会自动重新发送。</small>' : item.pending ? '<small>等待语言模型回复…</small>' : ''}</div>`).join('')
      : '<p class="previs-chat-empty">直接讲一个故事，让助手整理人物、道具和镜头。之后可继续讨论、修改预演或修复场景 JSON。</p>';
    host.scrollTop = host.scrollHeight;
    const proposal = $('#previs-chat-proposal'); proposal.hidden = !chatProposal;
    if (chatProposal) {
      let changes = [];
      try { changes = previsChanges(parsePrevisSpec(chatProposal.baseJson), parsePrevisSpec(chatProposal.json)); }
      catch { changes = [sceneEstablished ? '当前编辑尚未通过检查；这份方案已通过检查，可应用以修复场景。' : '已整理新故事的场景方案，请检查人物、空间和镜头后应用。']; }
      $('#previs-chat-changes').innerHTML = changes.map(change => `<li>${escape(change)}</li>`).join('');
      $('#previs-chat-proposal-json').textContent = chatProposal.json;
      const stale = chatProposal.signature !== editorSignature();
      $('#previs-chat-proposal-note').textContent = stale
        ? '发送这轮意见后，场景或故事已经改变。为了保留你的新编辑，当前方案不能直接应用；请继续发送修改意见。'
        : '这只是待确认方案。应用后可检查场景，再手动开始新预演；已有预演结果不受影响。';
    }
    const select = $('#previs-version-select'), selected = select.value;
    select.innerHTML = chatVersions.slice().reverse().map(item => `<option value="${escape(item.id)}">${escape(new Date(item.at).toLocaleString('zh-CN'))} · ${escape(item.label)}</option>`).join('');
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
    $('#previs-versions').hidden = !chatVersions.length;
    renderChatControls();
  }
  async function revise() {
    const id = getState().project?.id, model = $('#previs-text-model').value;
    const feedback = $('#previs-chat-input').value.trim();
    if (!id) throw new Error('请先新建或选择一个工程。');
    if (!feedback) throw new Error('请先输入故事、问题或修改要求。');
    if (!model || !getState().settings.text?.hasKey) throw new Error('请先在模型连接中配置可用的语言模型。');
    // A broken editor is valid input for a repair conversation, never a send blocker.
    if (!sceneEstablished && !$('#previs-story').value.trim()) $('#previs-story').value = feedback;
    const story = $('#previs-story').value, editorJson = jsonValue(), sourceName = chatSource?.name || '当前场景';
    const signature = editorSignature();
    const useProposal = chatProposal?.signature === signature;
    const baseJson = editorJson;
    const requestId = crypto.randomUUID();
    const messages = previsRevisionMessages({ story, sceneJson: useProposal ? chatProposal.json : editorJson, editorJson,
      history: chatHistory, feedback, preferences: preferences(), isNewScene: !sceneEstablished && !useProposal,
      source: useProposal ? '上一轮待确认方案（尚未应用）' : chatSource ? `${chatSource.name}（原预演任务 ${chatSource.id}）` : '当前场景编辑框' });
    chatHistory.push({ role: 'user', content: feedback, requestId, pending: true }); chatHistory = chatHistory.slice(-24);
    $('#previs-chat-input').value = ''; chatMessage('正在请语言模型整理故事、分析场景与本轮要求…');
    saveDraft(); renderChat(); pendingChatRequests.add(requestId);
    try {
      const response = await api('/api/text-chat', 'POST', { model, projectId: id, messages });
      const result = parsePrevisRevision(response.content);
      if (id === projectId) saveDraft();
      const draft = storedDraft(id), history = Array.isArray(draft.chatHistory) ? draft.chatHistory : [];
      const sent = history.find(item => item.requestId === requestId);
      if (sent) { delete sent.pending; delete sent.failed; }
      history.push({ role: 'assistant', content: result.reply.slice(0, 20000),
        ...(result.error ? { raw: result.raw, validationError: result.error } : {}) });
      if (result.error) {
        history.push({ role: 'context', content: result.error });
        draft.chatProposal = null;
      }
      draft.chatHistory = history.slice(-24);
      if (result.spec) draft.chatProposal = { json: JSON.stringify(result.spec, null, 2), baseJson,
        signature, source: sourceName, requestId };
      persistDraft(id, draft);
      if (id === projectId) {
        chatHistory = draft.chatHistory; chatProposal = draft.chatProposal || null; renderChat();
        chatMessage(result.error || (result.spec ? '场景方案已生成。查看后点击“应用到场景编辑框”，也可以继续聊天完善方案。' : '已收到回复。可以继续讨论或提出下一轮修改。'), Boolean(result.error));
      }
    } catch (error) {
      if (id === projectId) saveDraft();
      const draft = storedDraft(id), sent = draft.chatHistory?.find(item => item.requestId === requestId);
      if (sent) { delete sent.pending; sent.failed = true; }
      if (!draft.chatInput) draft.chatInput = feedback;
      persistDraft(id, draft);
      if (id === projectId) {
        chatHistory = draft.chatHistory || chatHistory;
        if (!$('#previs-chat-input').value.trim()) $('#previs-chat-input').value = draft.chatInput;
        renderChat(); chatMessage(error.message, true);
      }
      throw error;
    } finally { pendingChatRequests.delete(requestId); }
  }
  function summary(showError = true) {
    try {
      const spec = parsePrevisSpec(jsonValue()), dims = previsDimensions(spec);
      $('#previs-validation-status').textContent = '';
      $('#previs-validation-status').classList.remove('error');
      $('#previs-summary').textContent = `${spec.name} · ${spec.duration} 秒 · ${spec.fps} fps · ${dims.width}×${dims.height} · ${spec.actors.length} 个主体 · ${spec.objects.length} 个道具 · ${spec.duration * spec.fps} 帧`;
      for (const [key, value] of Object.entries({ duration: spec.duration, fps: spec.fps, ratio: spec.ratio, resolution: spec.resolution })) if ($('#previs-' + key)) $('#previs-' + key).value = String(value);
      if (showError) message('场景检查通过。确认路线和构图后，可开始本机预演。'); return spec;
    } catch (error) {
      $('#previs-summary').textContent = '场景配置需要修改';
      $('#previs-validation-status').textContent = `检查错误：${error.message} 可在上方聊天中继续沟通修复。`;
      $('#previs-validation-status').classList.add('error');
      if (showError) { message(error.message, true); throw error; }
    }
  }
  async function helper(route, method = 'GET', body, raw = false) {
    let response;
    try { response = await fetch(helperUrl + route, { method, mode: 'cors', headers: { 'X-Jingce-Helper-Token': helperToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(raw ? 10 * 60 * 1000 : 15000) }); }
    catch { throw new Error('无法连接本机 幻帧blender助手。请启动助手，并允许浏览器访问本地网络，然后点击“连接本机助手”。'); }
    if (!response.ok) { const value = await response.json().catch(() => ({})); if (response.status === 403) { helperToken = ''; try { storage?.removeItem(scopedStorageKey('jingce-blender-helper-token')); } catch {} } throw new Error(value.error || '本机助手操作未完成。'); }
    return raw ? response : response.json();
  }
  function renderTools() {
    $('#previs-helper-panel').hidden = !useHelper(); $('#previs-direct-tools').hidden = useHelper();
    const status = $('#previs-tool-status');
    status.textContent = tools ? `${tools.blender.version || 'Blender 未连接'} · ${tools.blender.message} ${tools.ffmpeg.message}`
      : useHelper() ? '下载并启动本机助手，首次连接时授权当前幻帧 MiraFrame网站。' : '点击“检测工具”确认本机 Blender 和 MP4 编码工具。';
    $('#previs-start').disabled = busy || !tools?.ready;
    $('#previs-load-example').disabled = busy;
    $('#previs-connect').disabled = busy;
    renderChatControls();
    const picker = $('#previs-text-model'), selected = picker.value || getState().settings.text?.textModel;
    picker.innerHTML = (getState().textCatalog || []).map(model => `<option value="${escape(model.name)}">${escape(model.name)}</option>`).join('') || '<option value="">请配置语言模型</option>';
    if ([...picker.options].some(option => option.value === selected)) picker.value = selected;
  }
  async function checkTools() {
    tools = useHelper() ? await helper('/api/previs/tools?refresh=1') : await api('/api/previs/tools?refresh=1');
    if (!useHelper()) {
      $('#previs-blender-path').value = tools.settings?.blenderPath || tools.blender.path || '';
      $('#previs-ffmpeg-path').value = tools.settings?.ffmpegPath || tools.ffmpeg.path || '';
      $('#previs-engine').value = tools.settings?.engine || 'auto';
    }
    renderTools(); return tools;
  }
  async function connect() {
    const request = crypto.randomUUID();
    if (helperToken) {
      try { await checkTools(); message('本机助手已连接，可以开始渲染。'); return; } catch {}
    }
    try {
      const probe = await fetch(`${helperUrl}/api/bridge/session?request=${request}`, { mode: 'cors', signal: AbortSignal.timeout(2500) });
      if (!probe.ok) throw new Error();
    } catch {
      message('助手尚未启动。已安装的用户请双击桌面的“幻帧blender助手”，等待几秒后再次连接；首次使用请下载助手并运行“安装助手.cmd”。浏览器若询问本地网络访问，请允许。', true);
      return;
    }
    const popup = globalThis.open(`${helperUrl}/?origin=${encodeURIComponent(origin)}&request=${request}`, 'jingce-blender-helper');
    if (!popup) throw new Error('浏览器阻止了授权窗口，请允许此网站弹出窗口后再次连接。');
    message('已打开本机助手。点击“允许此网站使用 Blender 预演”后返回此页；浏览器如询问本地网络访问，请允许。');
    const end = Date.now() + 120000;
    while (Date.now() < end) {
      let response;
      try { response = await fetch(`${helperUrl}/api/bridge/session?request=${request}`, { mode: 'cors', signal: AbortSignal.timeout(4000) }); }
      catch { throw new Error('本机助手尚未运行。下载后解压，双击“启动幻帧blender助手.cmd”，再重新连接。'); }
      if (!response.ok) throw new Error('助手拒绝了连接，请在助手窗口检查网站地址。');
      const result = await response.json();
      if (result.state === 'connected') {
        helperToken = result.token; try { storage?.setItem(scopedStorageKey('jingce-blender-helper-token'), helperToken); } catch {}
        await checkTools(); message('本机助手已连接，可以在幻帧 MiraFrame网站开始预演。'); return;
      }
      if (popup?.closed) throw new Error('助手窗口已关闭，请重新连接并授权。');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('连接等待已结束，未取得授权。点击“连接本机助手”重试。');
  }
  async function work(operation) {
    if (busy) return; busy = true; renderTools();
    try { await operation(); } catch (error) { message(error.message, true); toast(error.message, true); }
    finally { busy = false; renderTools(); }
  }
  async function start() {
    const id = getState().project?.id; if (!id) throw new Error('请先新建或选择一个工程。');
    const spec = summary(); saveDraft(); await flush();
    if (id !== getState().project?.id) throw new Error('工程已切换，请在当前工程重新预演。');
    let operationId;
    try { operationId = storage?.getItem(scopedStorageKey('jingce-previs-operation:' + id)); } catch {}
    operationId ||= crypto.randomUUID();
    try { storage?.setItem(scopedStorageKey('jingce-previs-operation:' + id), operationId); } catch {}
    // Retrying a lost response returns the original stored specification and task.
    const job = await api(`/api/projects/${id}/previs-jobs`, 'POST', { spec, operationId, mode: useHelper() ? 'helper' : 'server' });
    try { storage?.removeItem(scopedStorageKey('jingce-previs-operation:' + id)); } catch {}
    if (job.mode === 'helper' && !['done', 'failed', 'cancelled'].includes(job.state)) await beginLocal(job);
    message('预演任务已保存。完成后会生成 MP4、Blender 工程、关键帧和俯视路线图。');
    await refresh();
  }
  async function beginLocal(job) {
    if (!helperToken) throw new Error('预演任务已保存，等待连接本机助手；连接后会继续原任务。');
    const local = await helper('/api/previs/jobs', 'POST', { projectId: job.projectId, projectTitle: getState().project?.title || job.spec.name,
      spec: job.spec, operationId: job.id });
    return api(`/api/previs-jobs/${job.id}/sync`, 'POST', { ...local, localJobId: local.id });
  }
  async function saveLocal(job, local) {
    if (saving.has(job.id)) return;
    saving.add(job.id);
    try {
      for (const artifact of local.artifacts.filter(item => !['spec', 'prompt'].includes(item.key))) {
        const response = await helper(`/api/previs/jobs/${local.id}/artifacts/${artifact.key}`, 'GET', undefined, true);
        const blob = await response.blob();
        const saved = await fetch(`/api/previs-jobs/${job.id}/artifacts/${artifact.key}`, { method: 'POST', headers: { 'X-Studio-Token': getState().token, 'Content-Type': 'application/octet-stream' }, body: blob });
        if (!saved.ok) throw new Error((await saved.json()).error || '预演文件未能保存到网站。');
      }
      await api(`/api/previs-jobs/${job.id}/complete`, 'POST', { report: local.report });
      await onProjectUpdate(await api(`/api/projects/${job.projectId}`));
      if (job.projectId === getState().project?.id) toast('Blender 预演已完成，MP4 和关键帧已保存到网站素材库。');
    } finally { saving.delete(job.id); }
  }
  async function followLocal(job) {
    if (!helperToken) return;
    if (!job.localJobId) { await beginLocal(job); return; }
    const local = await helper(`/api/previs/jobs/${job.localJobId}`);
    await api(`/api/previs-jobs/${job.id}/sync`, 'POST', { ...local, localJobId: local.id });
    if (local.state === 'done') await saveLocal(job, local);
  }
  async function refresh() {
    const id = getState().project?.id; if (!id || loading) return;
    loading = true;
    try {
      let incoming = await api(`/api/projects/${id}/previs-jobs`);
      for (const job of incoming.filter(item => item.mode === 'helper' && activeStates.has(item.state))) {
        try { await followLocal(job); }
        catch (error) { if (id === getState().project?.id) message(error.message + ' 原预演任务和本机结果均保留，连接恢复后会继续保存。', true); }
      }
      if (incoming.some(item => item.mode === 'helper' && activeStates.has(item.state))) incoming = await api(`/api/projects/${id}/previs-jobs`);
      if (id !== getState().project?.id) return;
      const completed = incoming.some(job => job.state === 'done' && !jobs.some(item => item.id === job.id && item.state === 'done'));
      jobs = incoming; renderJobs();
      if (completed) await onProjectUpdate(await api(`/api/projects/${id}`));
    } finally { loading = false; }
  }
  function renderJobs(force = false) {
    const host = $('#previs-job-list'); if (!host) return;
    const markup = jobs.filter(job => !getState().project?.assets.some(asset => asset.id === job.videoAssetId && asset.deletedAt)).map(job => {
      const done = job.state === 'done', route = `/api/previs-jobs/${job.id}`;
      return `<article class="previs-job" data-previs-job="${job.id}"><div class="previs-job-heading"><strong>${escape(job.spec.name)}</strong><span class="previs-state ${done ? 'done' : ''}">${escape(labels[job.state] || job.state)}</span></div><p>${escape(job.message)}</p>${!done ? `<progress value="${Number(job.progress) || 0}" max="1" aria-label="预演进度"></progress>` : ''}
        ${done ? `<button type="button" class="previs-video-preview" data-previs-preview-video="${job.id}" aria-label="播放${escape(job.spec.name)}预演"><img src="${route}/artifacts/video?thumbnail=1" alt="${escape(job.spec.name)}预演缩略图" loading="lazy"><span aria-hidden="true">▶</span></button><p class="previs-meta">${job.report.duration} 秒 · ${job.report.width}×${job.report.height} · ${job.report.fps} fps · 已完整解码 ${job.report.decodedFrames} 帧</p>` : ''}
        <div class="previs-job-actions">${done ? `<a class="button" href="${route}/artifacts/video?download=1">下载 MP4</a><button type="button" class="button project-danger" data-previs-action="delete" data-job-id="${job.id}">删除白模视频</button><a class="button" href="${route}/artifacts/blend?download=1">下载 Blender 工程</a><button type="button" class="button" data-previs-action="place" data-job-id="${job.id}">放到画布</button><button type="button" class="primary" data-previs-action="reference" data-job-id="${job.id}">用于视频参考</button>` : activeStates.has(job.state) ? `<button type="button" class="button" data-previs-action="cancel" data-job-id="${job.id}">取消预演</button>` : `<button type="button" class="button" data-previs-action="retry" data-job-id="${job.id}">重试原预演</button>`}
        <button type="button" class="button" data-previs-action="discuss" data-job-id="${job.id}">对话修改</button><button type="button" class="button" data-previs-action="edit" data-job-id="${job.id}">复制场景继续编辑</button>${done ? `<button type="button" class="button" data-previs-action="open" data-job-id="${job.id}">在 Blender 中打开</button>` : ''}</div>
        <details><summary>配置与输出文件</summary><div class="previs-artifact-links">${job.artifacts.filter(item => done || ['spec', 'prompt'].includes(item.key)).map(item => `<a href="${route}/artifacts/${item.key}?download=1">${escape(item.name)}</a>`).join('')}</div>${done ? `<a class="previs-overview-preview" href="${route}/artifacts/overview" target="_blank" rel="noopener" aria-label="放大查看俯视路线图"><img src="${route}/artifacts/overview?thumbnail=1" alt="俯视路线图" loading="lazy"></a>` : ''}</details></article>`;
    }).join('') || '<p class="previs-empty">暂无预演任务。先整理场景，再确认并开始预演。</p>';
    if (markup === jobMarkup) return;
    if (!force && [...host.querySelectorAll('video')].some(video => !video.paused && !video.ended)) return;
    jobMarkup = markup; host.innerHTML = markup;
  }
  function render() {
    const id = getState().project?.id || '';
    if (id !== projectId) { saveDraft(); projectId = id; jobs = []; jobMarkup = ''; restoreDraft(); message(); chatMessage(); renderJobs(true); }
    renderTools();
  }
  $('#previs-spec')?.addEventListener('input', () => { sceneEstablished = true; sceneVersion++; saveDraft(); summary(false); renderChat(); });
  $('#previs-story')?.addEventListener('input', () => { saveDraft(); renderChat(); });
  $('#previs-chat-input')?.addEventListener('input', () => { saveDraft(); renderChatControls(); });
  $('#previs-load-example')?.addEventListener('click', () => { saveVersion('载入示例前'); chatProposal = null; chatSource = null;
    $('#previs-spec').value = JSON.stringify(defaultPrevisSpec(), null, 2); sceneEstablished = true; sceneVersion++; summary(); saveDraft(); renderChat(); message('已载入庭院示例，可替换为街道、室内或其他故事。'); });
  $('#previs-validate')?.addEventListener('click', () => work(async () => {
    try {
      const spec = summary(); await api('/api/previs/validate', 'POST', { spec });
      $('#previs-spec').value = JSON.stringify(spec, null, 2); sceneEstablished = true; saveDraft(); renderChat();
    } catch (error) {
      chatContext('当前场景检查未通过：' + error.message);
      saveDraft(); renderChat(); chatMessage('场景检查未通过。可直接发送修复要求，原始 JSON 与检查错误会一起发给助手。', true);
      throw error;
    }
  }));
  for (const key of ['duration', 'fps', 'ratio', 'resolution']) $('#previs-' + key)?.addEventListener('change', () => {
    try {
      const spec = parsePrevisSpec(jsonValue()), duration = Number($('#previs-duration').value), scale = duration / spec.duration;
      spec.duration = duration; spec.fps = Number($('#previs-fps').value); spec.ratio = $('#previs-ratio').value; spec.resolution = Number($('#previs-resolution').value);
      for (const item of [...spec.actors, spec.camera]) for (const point of item.keys) point.time = Number((point.time * scale).toFixed(6));
      for (const beat of spec.beats) beat.time = Number((beat.time * scale).toFixed(6));
      $('#previs-spec').value = JSON.stringify(spec, null, 2); sceneVersion++; saveDraft(); summary(); renderChat();
    } catch (error) { sceneVersion++; saveDraft(); summary(false); renderChat(); message(error.message, true); }
  });
  $('#previs-chat-repair')?.addEventListener('click', () => {
    if (busy) return;
    const request = currentValidationError() ? '请修复当前场景 JSON 的检查错误，保留已有故事、人物和镜头意图，给出完整可用的场景。'
      : '请根据上一轮原始回复和检查错误修复场景方案，给出完整可用的场景。';
    const input = $('#previs-chat-input');
    input.value = input.value.trim() ? input.value.trim() + '\n' + request : request;
    saveDraft(); renderChatControls(); input.focus();
    chatMessage('修复要求已填入聊天框。可补充想法后点击“发送”。');
  });
  $('#previs-chat-form')?.addEventListener('submit', event => { event.preventDefault(); work(revise); });
  $('#previs-chat-clear')?.addEventListener('click', () => { if (busy) return; chatHistory = []; chatProposal = null;
    saveDraft(); renderChat(); chatMessage('本工程的故事与预演对话已清空。场景和版本记录仍保留。'); });
  $('#previs-chat-discard')?.addEventListener('click', () => { if (busy) return; chatProposal = null;
    saveDraft(); renderChat(); chatMessage('已放弃待应用方案。当前场景没有改变。'); });
  $('#previs-chat-apply')?.addEventListener('click', () => work(async () => {
    if (!chatProposal || chatProposal.signature !== editorSignature())
      throw new Error('场景或故事已改变，请继续说明修改要求，生成与当前编辑一致的新方案。');
    const next = parsePrevisSpec(chatProposal.json);
    saveVersion('应用对话修改前');
    $('#previs-spec').value = JSON.stringify(next, null, 2); sceneEstablished = true; sceneVersion++; chatProposal = null;
    chatContext('已将上一轮修订方案应用到场景编辑框。之后请以编辑框中的配置为准。');
    summary(); saveDraft(); renderChat(); chatMessage('场景方案已应用。可继续聊天修改，确认后再手动开始本机预演。');
    message('场景修改已应用。请检查路线与构图，再手动开始新的本机预演。');
  }));
  $('#previs-version-restore')?.addEventListener('click', () => work(async () => {
    const version = chatVersions.find(item => item.id === $('#previs-version-select').value);
    if (!version) throw new Error('请选择要恢复的场景版本。');
    saveVersion('恢复旧版本前'); $('#previs-story').value = version.story || '';
    $('#previs-spec').value = version.json; sceneEstablished = version.sceneEstablished ?? true; sceneVersion++; chatProposal = null; chatSource = null;
    for (const [key, value] of Object.entries(version.preferences || {})) if ($('#previs-' + key)) $('#previs-' + key).value = String(value);
    chatContext(`已恢复场景版本：${version.label}。之后请以恢复的场景为准。`);
    summary(false); saveDraft(); renderChat(); message('已恢复场景版本。请检查配置后继续修改或预演。');
  }));
  $('#previs-start')?.addEventListener('click', () => work(start));
  $('#previs-connect')?.addEventListener('click', () => work(connect));
  $('#previs-check-tools')?.addEventListener('click', () => work(checkTools));
  $('#previs-open-helper')?.addEventListener('click', () => work(async () => {
    await checkTools(); globalThis.open(helperUrl, 'jingce-blender-helper');
  }));
  $('#previs-use-helper').checked = !localPage; $('#previs-use-helper').disabled = !localPage;
  $('#previs-use-helper')?.addEventListener('change', () => { tools = null; renderTools(); if (!useHelper() || helperToken) work(checkTools); });
  $('#previs-tools-form')?.addEventListener('submit', event => { event.preventDefault(); work(async () => {
    tools = await api('/api/previs/settings', 'PUT', { blenderPath: $('#previs-blender-path').value.trim(), ffmpegPath: $('#previs-ffmpeg-path').value.trim(), engine: $('#previs-engine').value }); renderTools();
  }); });
  $('#previs-job-list')?.addEventListener('click', event => {
    const preview = event.target.closest('[data-previs-preview-video]');
    if (preview) {
      const video = document.createElement('video');
      video.controls = true; video.playsInline = true; video.preload = 'none';
      video.setAttribute('aria-label', `${preview.getAttribute('aria-label') || '预演'}播放器`);
      video.src = `/api/previs-jobs/${encodeURIComponent(preview.dataset.previsPreviewVideo)}/artifacts/video`;
      preview.replaceWith(video); video.focus(); video.play().catch(() => {}); return;
    }
    const button = event.target.closest('[data-previs-action]'); if (!button) return;
    work(async () => {
      const job = jobs.find(item => item.id === button.dataset.jobId); if (!job) throw new Error('预演任务已更新，请刷新。');
      const action = button.dataset.previsAction;
      if (action === 'delete') {
        const id = getState().project?.id;
        const asset = getState().project?.assets.find(item => item.id === job.videoAssetId && !item.deletedAt);
        if (!asset || job.state !== 'done') throw new Error('视频不可用，请刷新后再试。');
        if (!globalThis.confirm('删除这段白模视频？视频会移到已删除素材，可在素材库恢复。相关画布引用会断开，原预演任务与工程文件保留。')) return;
        await flush();
        const project = await api(`/api/projects/${id}/assets/${asset.id}`, 'DELETE');
        await onProjectUpdate(project); renderJobs(true);
        toast('白模视频已删除，可在素材库的已删除素材中恢复。'); return;
      }
      if (action === 'edit' || action === 'discuss') {
        saveVersion(`切换到“${job.spec.name}”预演前`);
        $('#previs-spec').value = JSON.stringify(job.spec, null, 2); sceneEstablished = true; sceneVersion++; chatProposal = null;
        chatSource = { id: job.id, name: job.spec.name };
        chatContext(`已将“${job.spec.name}”预演的场景复制为当前修改起点。预演视频不会自动发送给语言模型，请描述具体时间段和画面问题。`);
        summary(); saveDraft(); renderChat();
        if (action === 'discuss') { $('#previs-chat-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#previs-chat-input').focus(); }
        else $('#previs-spec-details').open = true;
        return;
      }
      if (action === 'place') { await onPlaceAsset(job.videoAssetId); return; }
      if (action === 'reference') { await onUseVideo(job); return; }
      if (job.mode === 'helper' && job.localJobId && ['open', 'cancel', 'retry'].includes(action)) {
        const local = action === 'retry' ? await helper(`/api/previs/jobs/${job.localJobId}`) : null;
        // A cancelled website upload can reuse a completed local render.
        if (local?.state !== 'done') await helper(`/api/previs/jobs/${job.localJobId}/${action}`, 'POST', {});
      }
      if (action !== 'open' || job.mode !== 'helper') await api(`/api/previs-jobs/${job.id}/${action}`, 'POST', {});
      await refresh();
    });
  });
  return { render, refresh, checkTools, hasActive: () => jobs.some(job => activeStates.has(job.state)),
    async activate() { if (!helperToken) loadHelperToken(); render(); if (!tools && (!useHelper() || helperToken)) await checkTools().catch(error => message(error.message, true)); await refresh(); } };
}
