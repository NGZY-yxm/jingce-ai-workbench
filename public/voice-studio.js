import { VOICE_RECORDING_LIMIT, VOICE_PREVIEW_LIMITS, normalizeVoiceRequest, newVoiceId, estimateVoicePreviewCost } from './voice-parameters.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const labels = { waiting: '等待提交', uploading: '上传中', creating: '创建中', saving: '保存中', save_pending: '待保存', done: '已创建', uncertain: '需核对平台', failed: '未完成' };
const storageKey = (type, scope) => `jingce-voice-${type}:${scope}`;
const scopedStorageKey = key => globalThis.__jingceUserId ? `jingce-user:${globalThis.__jingceUserId}:${key}` : key;
function readLocal(type, scope) { try { return JSON.parse(localStorage.getItem(scopedStorageKey(storageKey(type, scope))) || 'null'); } catch { return null; } }
function writeLocal(type, scope, value) { try { const key = scopedStorageKey(storageKey(type, scope)); if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); } catch {} }

export function createVoiceStudio(bridge) {
  const $ = selector => document.querySelector(selector), dialog = $('#voice-studio'), form = $('#voice-create-form');
  let scope = '', model = '', kind = 'clone', recording = null, jobs = [], pending = null, uploadBusy = false, submitBusy = false, refreshBusy = false;
  const fields = ['name', 'voiceId', 'prompt', 'previewText', 'noiseReduction', 'volumeNormalization'];
  const connection = bridge.getConnection;
  function message(text, error = false) { $('#voice-create-message').textContent = text; $('#voice-create-message').classList.toggle('error', error); }
  const report = error => { message(error.message, true); bridge.toast(error.message, true); };
  function values() { return Object.fromEntries(fields.map(key => [key, form.elements[key].type === 'checkbox' ? form.elements[key].checked : form.elements[key].value])); }
  function persist() { if (scope) writeLocal('draft', scope, { ...values(), kind, recording, model }); }
  function drawRecording() {
    const player = $('#voice-recording-player'); player.hidden = !recording;
    if (recording) { if (player.getAttribute('src') !== recording.previewUrl) player.src = recording.previewUrl; $('#voice-recording-info').textContent = `${recording.name} · ${recording.duration.toFixed(2)} 秒 · ${(recording.size / 1024 / 1024).toFixed(2)} MB · 已保存到本机`; }
    else { player.removeAttribute('src'); $('#voice-recording-info').textContent = ''; }
    $('#voice-recording-info').classList.remove('error');
  }
  function controls() {
    const settings = connection(), domestic = settings.region !== 'international';
    $('#voice-create-submit').disabled = submitBusy || uploadBusy || Boolean(pending) || !settings.hasKey;
    $('#voice-create-submit').textContent = submitBusy ? '正在提交…' : kind === 'clone' ? '创建复刻音色' : '创建设计音色';
    $('#voice-recording-file').disabled = uploadBusy || submitBusy || Boolean(pending);
    $('#voice-new-id').disabled = submitBusy || Boolean(pending);
    $('#voice-create-pending').hidden = !pending; $('#voice-create-recover').disabled = submitBusy;
    const estimate = estimateVoicePreviewCost(form.elements.previewText.value, kind, model, domestic ? 'domestic' : 'international');
    $('#voice-create-cost').textContent = kind === 'clone' && !form.elements.previewText.value.trim() ? '本次仅创建音色，不生成试听音频。'
      : estimate ? `预计试听配音费 ¥${estimate.amount.toFixed(4)} · ${estimate.characters} 个计费字符` : '试听按平台实际字符用量计费，金额以官方价格及账单为准。';
    $('#voice-create-fee').textContent = domestic ? '创建不立即收取音色费；首次用于正式配音另按官方刊例价 ¥9.90 / 音色收费，实际扣费以账户账单为准。' : '音色费在首次用于正式配音时收取，试听另按字符计费；国际价格请查看当前连接的官方价格页。';
  }
  function setKind(value) {
    kind = value; $('#voice-clone-fields').hidden = kind !== 'clone'; $('#voice-design-fields').hidden = kind !== 'design';
    form.elements.prompt.required = kind === 'design'; form.elements.previewText.required = kind === 'design'; form.elements.previewText.maxLength = VOICE_PREVIEW_LIMITS[kind];
    for (const button of dialog.querySelectorAll('[data-voice-kind]')) button.setAttribute('aria-selected', String(button.dataset.voiceKind === kind));
    $('#voice-method-caption').textContent = kind === 'clone' ? '用自己的录音复刻声音，MiniMax 账户需完成个人或企业认证。选择文件只保存到本机，点击创建后才上传 MiniMax。' : '描述年龄感、音色、语气和口音，无需录音即可设计新的声音。';
    controls(); persist();
  }
  function syncScope() {
    const settings = connection(), next = `${settings.id || 'legacy'}:${settings.region || 'domestic'}`;
    model = bridge.getModel();
    $('#voice-studio-connection').textContent = `${settings.name || 'MiniMax'} · ${settings.region === 'international' ? '国际' : '国内'}接口 · 正式配音模型 ${model}`;
    if (next !== scope) {
      scope = next; jobs = []; pending = readLocal('pending', scope); recording = null; form.reset();
      const saved = readLocal('draft', scope);
      for (const key of fields) if (saved?.[key] !== undefined) { if (form.elements[key].type === 'checkbox') form.elements[key].checked = saved[key]; else form.elements[key].value = saved[key]; }
      recording = saved?.recording || null;
      if (!form.elements.voiceId.value) form.elements.voiceId.value = newVoiceId();
      kind = ['clone', 'design'].includes(saved?.kind) ? saved.kind : 'clone';
      $('#voice-job-list').replaceChildren(); drawRecording(); message('');
    }
    setKind(kind);
  }
  function createdVoices() { return jobs.filter(job => job.state === 'done' && job.voiceId).map(job => ({ id: job.voiceId, name: job.request.name,
    type: job.request.kind === 'clone' ? 'cloned' : 'designed', description: '在幻帧 MiraFrame创建的自定义音色；首次正式使用可能收取音色费。' })); }
  function markup(job) {
    return `<div class="speech-job-header"><strong>${escapeHtml(job.request.name)}</strong><span class="speech-job-state">${labels[job.state] || escapeHtml(job.state)}</span></div>
      <p class="speech-job-message">${escapeHtml(job.message)}</p><p class="voice-job-id">${escapeHtml(job.voiceId || job.request.voiceId)}</p>
      ${job.previewUrl ? `<audio controls preload="none" src="${escapeHtml(job.previewUrl)}" aria-label="试听${escapeHtml(job.request.name)}"></audio>` : ''}
      ${job.previewMessage ? `<p class="speech-job-message">${escapeHtml(job.previewMessage)}</p>` : ''}
      <div class="speech-job-actions">${job.state === 'done' && job.voiceId ? `<button type="button" data-voice-use="${escapeHtml(job.id)}">使用此音色</button><button type="button" data-voice-copy="${escapeHtml(job.id)}">复制 ID</button>` : ''}
      ${job.previewUrl ? `<a href="${escapeHtml(job.previewUrl)}?download=1" download>下载试听 ↓</a>` : ''}
      ${job.state === 'save_pending' ? `<button type="button" data-voice-save="${escapeHtml(job.id)}">重试保存已有结果</button>` : ''}
      ${job.state === 'done' && job.previewState === 'pending' ? `<button type="button" data-voice-preview="${escapeHtml(job.id)}">重试保存试听</button>` : ''}
      ${job.state === 'uncertain' ? `<button type="button" data-voice-reconcile="${escapeHtml(job.id)}">核对平台音色</button><button type="button" data-voice-resolve="${escapeHtml(job.id)}">已核对，结束记录</button>` : ''}</div>
      <details><summary>创建详情</summary><dl><dt>创建方式</dt><dd>${job.request.kind === 'clone' ? '上传录音复刻' : '文字设计'}</dd><dt>创建时间</dt><dd>${escapeHtml(new Date(job.createdAt).toLocaleString('zh-CN'))}</dd><dt>任务编号</dt><dd>${escapeHtml(job.id)}</dd>${job.traceId ? `<dt>平台追踪号</dt><dd>${escapeHtml(job.traceId)}</dd>` : ''}</dl>${job.request.prompt ? `<p>${escapeHtml(job.request.prompt)}</p>` : ''}<p>${escapeHtml(job.request.previewText || '未生成试听')}</p></details>`;
  }
  function drawJobs() {
    const list = $('#voice-job-list'), existing = new Map([...list.querySelectorAll('[data-voice-job]')].map(card => [card.dataset.voiceJob, card]));
    list.querySelector('.speech-empty')?.remove();
    $('#voice-job-count').textContent = `${jobs.length} 个任务 · ${jobs.filter(job => job.state === 'done').length} 个已创建`;
    for (const [index, job] of jobs.entries()) {
      let card = existing.get(job.id); if (!card) { card = document.createElement('article'); card.className = 'speech-job'; card.dataset.voiceJob = job.id; }
      const key = JSON.stringify(job);
      if (card.dataset.renderKey !== key) { card.innerHTML = markup(job); card.dataset.renderKey = key; card.dataset.state = job.state; }
      if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null); existing.delete(job.id);
    }
    for (const card of existing.values()) card.remove();
    if (!jobs.length) list.innerHTML = '<div class="speech-empty"><strong>保存属于你的声音</strong>音色创建后会显示在这里。<br>可连续提交多个创建任务。</div>';
    bridge.onVoices(createdVoices(), model);
  }
  async function refresh() {
    if (refreshBusy || !connection().hasKey) return;
    syncScope(); const previousScope = scope, selectedModel = model;
    refreshBusy = true;
    try {
      const next = await bridge.api(`/api/voice-jobs?model=${encodeURIComponent(selectedModel)}`);
      if (scope !== previousScope || bridge.getModel() !== selectedModel) return;
      jobs = next;
      if (pending && jobs.some(job => job.operationId === pending.operationId)) {
        const previousId = pending.voiceId; pending = null; writeLocal('pending', scope, null);
        if (form.elements.voiceId.value === previousId) form.elements.voiceId.value = newVoiceId();
        message('已找回原音色任务，可以继续创建。'); persist();
      }
      drawJobs(); controls();
    } finally { refreshBusy = false; }
  }
  async function submit(request, previousScope = scope) {
    submitBusy = true; controls();
    try {
      const job = await bridge.api('/api/voice-jobs', 'POST', request); writeLocal('pending', previousScope, null);
      if (scope !== previousScope) return;
      pending = null; jobs = [job, ...jobs.filter(item => item.id !== job.id)];
      if (form.elements.voiceId.value === request.voiceId) form.elements.voiceId.value = newVoiceId();
      message('任务已接收，可以继续创建下一个音色；完成后点击“使用此音色”。'); persist(); drawJobs();
      refresh().catch(() => {});
    } catch (error) {
      if (error.status >= 400 && error.status < 500) { writeLocal('pending', previousScope, null); if (scope === previousScope) pending = null; }
      if (scope === previousScope) report(error);
    } finally { submitBusy = false; controls(); }
  }
  form.onsubmit = async event => {
    event.preventDefault(); if (submitBusy || uploadBusy || pending) return;
    let request; try { request = { ...normalizeVoiceRequest({ ...values(), kind, model, recordingId: recording?.id || '' }), operationId: crypto.randomUUID() }; }
    catch (error) { report(error); return; }
    pending = request; writeLocal('pending', scope, request); persist(); await submit(request);
  };
  $('#voice-create-submit').addEventListener('click', event => { if (event.detail > 1) event.preventDefault(); });
  form.addEventListener('input', () => { persist(); controls(); });
  for (const button of dialog.querySelectorAll('[data-voice-kind]')) button.onclick = () => { if (!submitBusy && !pending) setKind(button.dataset.voiceKind); };
  $('#voice-new-id').onclick = () => { form.elements.voiceId.value = newVoiceId(); persist(); };
  $('#voice-recording-file').onchange = async () => {
    const file = $('#voice-recording-file').files[0]; if (!file || uploadBusy || submitBusy || pending) return;
    if (!/\.(mp3|m4a|wav)$/i.test(file.name) || !file.size || file.size > VOICE_RECORDING_LIMIT) { report(new Error('请选择不超过 20 MB 的 MP3、M4A 或 WAV 录音。')); $('#voice-recording-file').value = ''; return; }
    const previousScope = scope, selectedModel = model; uploadBusy = true; recording = null; drawRecording(); persist(); controls();
    $('#voice-recording-info').textContent = '正在保存录音并校验时长…';
    try {
      const response = await fetch(`/api/voice-recordings?model=${encodeURIComponent(selectedModel)}&operationId=${crypto.randomUUID()}`, {
        method: 'POST', headers: { 'X-Studio-Token': bridge.getState().token, 'X-File-Name': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' }, body: file });
      const result = await response.json();
      if (!response.ok) { const error = new Error(result.error || '录音上传未完成。'); error.status = response.status; throw error; }
      if (previousScope === scope) { recording = result; drawRecording(); persist(); message('录音已保存到本机，点击创建后才上传 MiniMax。'); }
    } catch (error) { if (previousScope === scope) { $('#voice-recording-info').textContent = error.message; $('#voice-recording-info').classList.add('error'); report(error); } }
    finally { uploadBusy = false; controls(); }
  };
  $('#voice-create-recover').onclick = async () => { if (!pending || submitBusy) return; try { await refresh(); if (pending) await submit(pending); } catch (error) { report(error); } };
  $('#voice-refresh-jobs').onclick = () => refresh().catch(report);
  $('#voice-job-list').onclick = async event => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    const [action, id] = Object.entries(button.dataset).find(([key]) => key.startsWith('voice')) || []; if (!id) return;
    const job = jobs.find(item => item.id === id); if (!job) return;
    button.disabled = true;
    try {
      if (action === 'voiceUse') { bridge.onUse({ id: job.voiceId, name: job.request.name, type: job.request.kind === 'clone' ? 'cloned' : 'designed' }); dialog.close(); bridge.toast('已选用新音色，填写配音文案后即可生成。'); return; }
      if (action === 'voiceCopy') { await navigator.clipboard.writeText(job.voiceId); bridge.toast('Voice ID 已复制。'); return; }
      if (action === 'voiceResolve' && !window.confirm('请先在 MiniMax 核对这个 Voice ID 和账单。确认已核对后结束此本地记录？这不会再次创建音色。')) return;
      const operation = { voiceSave: 'save', voicePreview: 'preview', voiceReconcile: 'reconcile', voiceResolve: 'resolve' }[action];
      if (operation) { await bridge.api(`/api/voice-jobs/${id}/${operation}`, 'POST', operation === 'resolve' ? { confirmed: true } : {}); await refresh(); }
    } catch (error) { report(error); } finally { if (button.isConnected) button.disabled = false; }
  };
  dialog.addEventListener('close', () => { for (const audio of dialog.querySelectorAll('audio')) audio.pause(); });
  $('#voice-studio-close').onclick = () => dialog.close();
  function open() { if (!connection().hasKey) { bridge.openConnections(); return; } syncScope(); drawJobs(); dialog.showModal(); refresh().catch(report); }
  setInterval(() => { if (dialog.open) refresh().catch(report); }, 2000);
  return { open, refresh };
}
