import { createVoiceStudio } from './voice-studio.js';
import { SPEECH_MODELS, SPEECH_EMOTIONS, SPEECH_TEXT_LIMIT, speechCharacterCount, speechEmotionSupported, normalizeSpeechRequest, estimateSpeechCost } from './speech-parameters.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const labels = { waiting: '等待提交', submitting: '生成中', saving: '保存中', save_pending: '待保存', done: '已完成', failed: '未完成', uncertain: '需核对平台' };
const activeStates = ['waiting', 'submitting', 'saving'];
const storageKey = (type, id) => `jingce-speech-${type}:${id}`;
const scopedStorageKey = key => globalThis.__jingceUserId ? `jingce-user:${globalThis.__jingceUserId}:${key}` : key;
function readLocal(type, id) { try { return JSON.parse(localStorage.getItem(scopedStorageKey(storageKey(type, id))) || 'null'); } catch { return null; } }
function writeLocal(type, id, value) { try { const key = scopedStorageKey(storageKey(type, id)); if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); } catch {} }

export function createSpeechWorkspace(bridge) {
  const $ = selector => document.querySelector(selector), form = $('#speech-form');
  const state = bridge.getState;
  let projectId = '', jobs = [], voices = [], pending = null, target = { nodeId: '', sceneId: '' }, submitBusy = false, refreshBusy = false;
  const fields = ['model', 'text', 'voiceId', 'speed', 'vol', 'pitch', 'emotion', 'format', 'name'];
  const message = (text, error = false, selector = '#speech-message') => { $(selector).textContent = text; $(selector).classList.toggle('error', error); };
  const report = error => { message(error.message, true); bridge.toast(error.message, true); };
  let voiceAccount = '';
  const voiceStudio = createVoiceStudio({ ...bridge, getModel: () => form.elements.model.value, getConnection: selectedConnection,
    onVoices: (created, model) => {
      if (model !== form.elements.model.value) return;
      const merged = new Map(voices.map(voice => [voice.id, voice]));
      for (const voice of created) merged.set(voice.id, { ...merged.get(voice.id), ...voice });
      voices = [...merged.values()]; renderVoices(); bridge.onVoicesChanged?.(voices);
    },
    onUse: voice => { if (!voices.some(item => item.id === voice.id)) voices.push(voice); form.elements.voiceId.value = voice.id; renderVoices(); persist(); updateControls(); bridge.onVoicesChanged?.(voices); },
  });
  $('#speech-new-voice').onclick = () => voiceStudio.open();


  function draft() {
    return Object.fromEntries(fields.map(field => [field, ['speed', 'vol', 'pitch'].includes(field) ? Number(form.elements[field].value) : form.elements[field].value]));
  }
  function persist() { if (projectId) writeLocal('draft', projectId, { ...draft(), ...target }); }
  function emotions() {
    const selected = form.elements.emotion.value;
    form.elements.emotion.innerHTML = SPEECH_EMOTIONS.map(([value, label]) => `<option value="${value}"${speechEmotionSupported(form.elements.model.value, value) ? '' : ' disabled'}>${label}</option>`).join('');
    form.elements.emotion.value = speechEmotionSupported(form.elements.model.value, selected) ? selected : '';
  }
  function updateControls() {
    const count = speechCharacterCount(form.elements.text.value);
    $('#speech-character-count').textContent = `${count.toLocaleString()} / ${SPEECH_TEXT_LIMIT} 字符`;
    $('#speech-character-count').classList.toggle('error', count > SPEECH_TEXT_LIMIT);
    $('#speech-submit').disabled = submitBusy || Boolean(pending) || !state().project || !selectedConnection().hasKey;
    $('#speech-submit').textContent = submitBusy ? '正在提交…' : '生成配音（可能收费）';
    $('#speech-pending').hidden = !pending;
    $('#speech-recover-submit').disabled = submitBusy;
    $('#speech-target').textContent = target.nodeId ? '结果关联声音卡片' : target.sceneId ? '结果关联所选视频生成项' : '';
    $('#speech-clear-target').hidden = !target.nodeId && !target.sceneId;
    const estimate = estimateSpeechCost(form.elements.text.value, form.elements.model.value, selectedConnection().region || 'domestic');
    $('#speech-cost').textContent = estimate ? `预计基础配音费 ¥${estimate.amount.toFixed(4)} · ${estimate.characters.toLocaleString()} 个计费字符` : '国际接口价格请查看官方价格页';
  }
  function selectedConnection() {
    const model = form.elements.model.value;
    const connection = (state().speechConnections || []).find(item => item.models.includes(model));
    if (!connection) return { hasKey: false, region: 'domestic' };
    return { ...connection, region: connection.baseUrl === 'https://api.minimax.io' ? 'international' : 'domestic' };
  }
  function renderModelChoices() {
    const selected = form.elements.model.value, models = state().speechCatalog || SPEECH_MODELS;
    form.elements.model.innerHTML = models.map(model => `<option>${escapeHtml(model)}</option>`).join('');
    if (selected && !models.includes(selected)) form.elements.model.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(selected)}" disabled>${escapeHtml(selected)} · 尚未绑定</option>`);
    if (selected) form.elements.model.value = selected;
  }
  function renderConnection() {
    const settings = selectedConnection();
    const account = `${settings.id || ''}:${settings.region}`;
    if (voiceAccount !== account) { voiceAccount = account; voices = []; renderVoices(); bridge.onVoicesChanged?.(voices); }
    $('#speech-connection-status').textContent = settings.hasKey ? `${settings.name || 'MiniMax'} · ${settings.region === 'international' ? '国际' : '国内'}接口` : '所选语音模型未连接 · 在连接中心绑定接口';
    $('#speech-connection-status').parentElement.classList.toggle('connected', Boolean(settings.hasKey));
    $('#speech-pricing').href = settings.region === 'international' ? 'https://platform.minimax.io/docs/guides/pricing-paygo' : 'https://platform.minimaxi.com/docs/guides/pricing-paygo';
  }
  function renderVoices() {
    const selected = form.elements.voiceId.value;
    $('#speech-voice-picker').innerHTML = '<option value="">手动填写 Voice ID</option>' + voices.map(voice => `<option value="${escapeHtml(voice.id)}">${escapeHtml(voice.name)}${voice.type === 'system' ? '' : voice.type === 'cloned' ? ' · 复刻音色' : ' · 设计音色'}</option>`).join('');
    $('#speech-voice-picker').value = voices.some(voice => voice.id === selected) ? selected : '';
    const voice = voices.find(item => item.id === selected);
    $('#speech-voice-description').textContent = voice ? `${voice.description || voice.id}${voice.type === 'system' ? '' : '；首次使用可能产生额外费用，请核对平台价格。'}`
      : '可读取账户音色，也可手动填写已有音色 ID。默认 ID 来自官方示例。';
  }
  function renderNarrations() {
    const selected = $('#speech-scene-picker').value;
    $('#speech-scene-picker').innerHTML = '<option value="all">全部视频生成项的旁白</option>' + (state().project?.scenes || []).map(scene => `<option value="${escapeHtml(scene.id)}">${escapeHtml(scene.title || '未命名视频')}</option>`).join('');
    if (selected === 'all' || state().project?.scenes.some(scene => scene.id === selected)) $('#speech-scene-picker').value = selected;
  }
  function jobMarkup(job) {
    const asset = state().project?.assets.find(item => item.id === job.assetId && !item.deletedAt), r = job.request;
    return `<div class="speech-job-header"><strong>${escapeHtml(r.name)}</strong><span class="speech-job-state">${labels[job.state] || job.state}</span></div>
      <p class="speech-job-message">${escapeHtml(job.message)}</p>
      ${asset ? `<audio controls preload="none" src="/api/assets/${encodeURIComponent(asset.id)}" aria-label="试听${escapeHtml(asset.name)}"></audio><div class="speech-job-actions"><button type="button" data-speech-place="${escapeHtml(job.id)}">放到画布 ↗</button><a href="/api/assets/${encodeURIComponent(asset.id)}?download=1" download>下载 ${r.format.toUpperCase()} ↓</a><button type="button" class="project-danger" data-speech-delete="${escapeHtml(job.id)}">删除语音</button></div>` : job.state === 'done' ? '<p class="speech-job-message">素材已删除，可在素材库中恢复。</p>' : ''}
      ${job.state === 'save_pending' ? `<div class="speech-job-actions"><button type="button" data-speech-save="${escapeHtml(job.id)}">重试保存已有音频</button></div>` : ''}
      ${job.state === 'uncertain' ? `<div class="speech-job-actions"><button type="button" data-speech-resolve="${escapeHtml(job.id)}">已核对平台，结束记录</button></div>` : ''}
      <details><summary>文案与任务详情</summary><dl><dt>模型</dt><dd>${escapeHtml(r.model)}</dd><dt>音色</dt><dd>${escapeHtml(r.voiceId)}</dd><dt>参数</dt><dd>语速 ${r.speed} · 音量 ${r.vol} · 音调 ${r.pitch} · ${escapeHtml(SPEECH_EMOTIONS.find(([id]) => id === r.emotion)?.[1] || '自动')}</dd><dt>提交时间</dt><dd>${escapeHtml(new Date(job.createdAt).toLocaleString('zh-CN'))}</dd>${job.duration !== null ? `<dt>时长</dt><dd>${Number(job.duration).toFixed(2)} 秒</dd>` : ''}${job.usageCharacters !== null ? `<dt>计费字符</dt><dd>${job.usageCharacters}（平台返回）</dd>` : ''}${job.traceId ? `<dt>平台追踪号</dt><dd>${escapeHtml(job.traceId)}</dd>` : ''}<dt>任务编号</dt><dd>${escapeHtml(job.id)}</dd></dl><p>${escapeHtml(r.text)}</p></details>`;
  }
  function renderJobs() {
    const list = $('#speech-job-list'), existing = new Map([...list.querySelectorAll('[data-speech-job]')].map(card => [card.dataset.speechJob, card]));
    const visibleJobs = jobs.filter(job => !state().project?.assets.some(asset => asset.id === job.assetId && asset.deletedAt));
    const active = visibleJobs.filter(job => activeStates.includes(job.state)).length;
    $('#speech-job-count').textContent = `${visibleJobs.length} 个任务${active ? ` · ${active} 个处理中` : ''}`;
    list.querySelector('.speech-empty')?.remove();
    visibleJobs.forEach((job, index) => {
      let card = existing.get(job.id);
      if (!card) { card = document.createElement('article'); card.className = 'speech-job'; card.dataset.speechJob = job.id; }
      const content = jobMarkup(job);
      if (card._speechContent !== content) { card.innerHTML = content; card._speechContent = content; }
      card.dataset.state = job.state;
      if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
      existing.delete(job.id);
    });
    existing.forEach(card => card.remove());
    if (!visibleJobs.length) list.innerHTML = '<div class="speech-empty"><strong>第一段配音，从这里开始</strong>填写文案并提交，音频会保存到工程素材库。<br>可以连续提交多个任务。</div>';
    bridge.onJobsChanged?.(jobs);
  }
  function render() {
    renderModelChoices(); renderConnection();
    const id = state().project?.id || '';
    if (id !== projectId) {
      projectId = id; jobs = []; pending = id ? readLocal('pending', id) : null;
      const saved = id ? readLocal('draft', id) : null;
      form.reset();
      form.elements.model.innerHTML = (state().speechCatalog || SPEECH_MODELS).map(model => `<option>${escapeHtml(model)}</option>`).join('');
      form.elements.model.value = state().speechCatalog?.[0] || SPEECH_MODELS[0];
      emotions();
      if (saved) {
        for (const field of fields) if (saved[field] !== undefined) form.elements[field].value = saved[field];
        emotions(); target = { nodeId: saved.nodeId || '', sceneId: saved.sceneId || '' };
      } else target = { nodeId: '', sceneId: '' };
      message(''); $('#speech-job-list').replaceChildren(); renderVoices();
      if (id) refresh().catch(report);
    }
    renderModelChoices(); renderConnection(); renderNarrations(); renderJobs(); updateControls();
  }
  async function refresh() {
    const id = state().project?.id;
    if (!id || refreshBusy) return;
    if (id !== projectId) { render(); return; }
    refreshBusy = true;
    try {
      const next = await bridge.api(`/api/projects/${id}/speech-jobs`);
      if (id !== state().project?.id) return;
      jobs = next;
      if (pending && jobs.some(job => job.operationId === pending.operationId)) { pending = null; writeLocal('pending', id, null); message('已找回上次提交的配音任务，可以继续生成。'); }
      if (jobs.some(job => job.state === 'done' && !state().project.assets.some(asset => asset.id === job.assetId))) {
        const project = await bridge.api(`/api/projects/${id}`);
        if (id === state().project?.id) bridge.adoptRemote(project);
      }
      renderJobs(); updateControls();
      await voiceStudio.refresh();
    } finally { refreshBusy = false; }
  }
  async function submit(request, id) {
    submitBusy = true; updateControls();
    try {
      await bridge.flush();
      const result = await bridge.api(`/api/projects/${id}/speech-jobs`, 'POST', request);
      writeLocal('pending', id, null);
      if (id === projectId) { pending = null; jobs = [result, ...jobs.filter(job => job.id !== result.id)]; message('任务已接收，可以继续提交下一段配音。'); renderJobs(); }
      refresh().catch(() => {});
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && error.status !== 409) {
        writeLocal('pending', id, null); if (id === projectId) pending = null;
      }
      if (id === projectId) report(error);
    } finally { submitBusy = false; updateControls(); }
  }
  form.onsubmit = async event => {
    event.preventDefault();
    if (submitBusy || pending || !projectId) return;
    let request;
    try { request = { ...normalizeSpeechRequest(draft()), ...target, operationId: crypto.randomUUID() }; }
    catch (error) { report(error); return; }
    const id = projectId; pending = request; writeLocal('pending', id, request); persist(); await submit(request, id);
  };
  $('#speech-submit').addEventListener('click', event => { if (event.detail > 1) event.preventDefault(); });
  $('#speech-recover-submit').onclick = () => { if (pending && !submitBusy) submit(pending, projectId); };
  form.addEventListener('input', event => { if (event.target.name === 'model') emotions(); if (event.target.name === 'voiceId') renderVoices(); updateControls(); persist(); });
  form.addEventListener('change', () => { emotions(); renderConnection(); updateControls(); persist(); });
  $('#speech-voice-picker').onchange = () => { if ($('#speech-voice-picker').value) form.elements.voiceId.value = $('#speech-voice-picker').value; renderVoices(); persist(); };
  $('#speech-clear-target').onclick = () => { target = { nodeId: '', sceneId: '' }; persist(); updateControls(); };
  $('#speech-import-narration').onclick = () => {
    const selected = $('#speech-scene-picker').value;
    const scenes = (state().project?.scenes || []).filter(scene => selected === 'all' || scene.id === selected);
    const text = scenes.map(scene => scene.narration || '').filter(text => text.trim()).join('\n\n');
    if (!text) { report(new Error('所选视频生成项还没有旁白，请先填写旁白或直接输入配音文案。')); return; }
    if (form.elements.text.value.trim() && !window.confirm('用工程旁白替换当前配音文案？')) return;
    form.elements.text.value = text; target = { nodeId: '', sceneId: selected === 'all' ? '' : selected }; persist(); updateControls(); message('旁白已填入，可以修改后再生成配音。');
  };
  async function loadVoices(model = form.elements.model.value) {
    const result = await bridge.api('/api/speech-voices', 'POST', { model });
    voices = result.voices; renderVoices(); bridge.onVoicesChanged?.(voices); return result;
  }
  $('#speech-refresh-voices').onclick = async () => {
    const button = $('#speech-refresh-voices'); if (button.disabled) return;
    if (!selectedConnection().hasKey) { openSettings(); return; }
    button.disabled = true;
    try { message((await loadVoices()).message); } catch (error) { report(error); } finally { button.disabled = false; }
  };
  function openSettings() {
    bridge.openConnections();
  }
  $('#speech-refresh-jobs').onclick = () => refresh().catch(report);
  $('#speech-job-list').onclick = async event => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    const id = button.dataset.speechPlace || button.dataset.speechSave || button.dataset.speechResolve || button.dataset.speechDelete;
    const job = jobs.find(item => item.id === id); if (!job) return;
    button.disabled = true;
    try {
      if (button.dataset.speechDelete) {
        const projectId = state().project?.id;
        const asset = state().project?.assets.find(item => item.id === job.assetId && !item.deletedAt);
        if (!asset || job.state !== 'done') throw new Error('语音不可用，请刷新后再试。');
        if (!window.confirm('删除这段语音？语音会移到已删除素材，可在素材库恢复。相关画布引用会断开，原任务记录保留，不会再次生成或收费。')) return;
        await bridge.flush();
        const project = await bridge.api(`/api/projects/${projectId}/assets/${asset.id}`, 'DELETE');
        if (projectId === state().project?.id) bridge.adoptRemote(project);
        renderJobs(); bridge.toast('语音已删除，可在素材库的已删除素材中恢复。');
      }
      if (button.dataset.speechPlace) {
        const asset = state().project.assets.find(item => item.id === job.assetId && !item.deletedAt);
        if (asset) { bridge.setView('canvas'); bridge.addAsset(asset); bridge.toast('配音已放到画布，可连接到视频或合成卡片。'); }
      }
      if (button.dataset.speechSave) { await bridge.api(`/api/speech-jobs/${id}/save`, 'POST', {}); await refresh(); }
      if (button.dataset.speechResolve && window.confirm('请先在 MiniMax 核对本次请求和扣费记录。确认已核对后，结束这条本地任务？这不会再次生成配音。')) { await bridge.api(`/api/speech-jobs/${id}/resolve`, 'POST', { confirmed: true }); await refresh(); }
    } catch (error) { report(error); } finally { if (button.isConnected) button.disabled = false; }
  };
  function open(text = '', association = {}) {
    bridge.setView('speech'); render();
    if (text) {
      if (form.elements.text.value.trim() && form.elements.text.value !== text && !window.confirm('用所选文字替换当前配音文案？')) return;
      form.elements.text.value = text;
    }
    target = { nodeId: association.nodeId || '', sceneId: association.sceneId || '' };
    persist(); updateControls(); form.elements.text.focus();
  }
  async function submitFromCanvas(nodeId, value) {
    render();
    if (submitBusy || !projectId) return bridge.toast('配音任务正在提交，请稍后再试。', true);
    if (pending) {
      if (pending.nodeId !== nodeId) return bridge.toast('另一张卡片的配音提交尚未确认，请先到语音生成页核对。', true);
      await refresh();
      if (pending) await submit(pending, projectId);
      return;
    }
    let request;
    try {
      request = { ...normalizeSpeechRequest(value), nodeId, operationId: crypto.randomUUID() };
    } catch (error) { bridge.toast(error.message, true); return; }
    const previousDraft = draft(), previousTarget = { ...target };
    for (const field of fields) if (request[field] !== undefined) form.elements[field].value = request[field];
    emotions(); target = { nodeId, sceneId: '' }; updateControls();
    const id = projectId; pending = request; writeLocal('pending', id, request);
    try { await submit(request, id); }
    finally {
      for (const field of fields) form.elements[field].value = previousDraft[field];
      emotions(); target = previousTarget; persist(); updateControls();
    }
  }
  async function reconcileFromCanvas() {
    const id = projectId;
    await refresh();
    if (id) {
      const project = await bridge.api(`/api/projects/${id}`);
      if (id === state().project?.id) bridge.adoptRemote(project);
    }
  }
  return { render, refresh, open, openSettings, loadVoices, submitFromCanvas, reconcileFromCanvas,
    pendingForNode: nodeId => pending?.nodeId === nodeId };
}
