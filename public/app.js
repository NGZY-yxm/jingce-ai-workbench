import { videoParameters, videoParameterControls, updateVideoParameter, videoEstimateText, videoPricingNote } from './video-parameters.js';
import { createInfiniteCanvas } from './canvas.js';
import { resolveSceneReferences, syncProjectReferences, referenceLabel, referenceKey, withoutSceneReferenceLinks, detachAssetReferences } from './reference-model.js';
import { referenceRequestIssue, referenceCapabilityText } from './reference-api.js';
import { updatePromptMentions, insertReferenceMention, remapPromptMentions, invalidPromptMentions, createPortablePromptMentionMapper } from './prompt-mentions.js';
import { createReferencePromptEditor } from './prompt-editor.js';
import { isImageGenerationNode, normalizeImageConfig, normalizeImageCount, resolveImageInputs, imageRequestIssue, syncImageCardJobs, imageModelReferenceLimit, imageEstimate, imageEstimateText, IMAGE_REFERENCE_MAX } from './image-parameters.js';
import { buildAiMessages, normalizeAiConfig, parseAiResponse } from './ai-text.js';
import { renderTextMarkdown } from './text-markdown.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const clone = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uid = () => crypto.randomUUID();
const THEME_STORAGE_KEY = 'jingce-theme';
const VIDEO_OPERATION_STORAGE_KEY = 'jingce-pending-video-operations';
const TEXT_HISTORY_STORAGE_KEY = 'jingce-text-chat-history';
function loadVideoOperations() {
  try {
    const entries = JSON.parse(sessionStorage.getItem(VIDEO_OPERATION_STORAGE_KEY) || '[]');
    return new Map(Array.isArray(entries) ? entries.filter(entry => {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') return false;
      const operationId = typeof entry[1] === 'string' ? entry[1] : entry[1]?.operationId;
      return typeof operationId === 'string' && operationId.length > 0 && operationId.length <= 100;
    }) : []);
  } catch { return new Map(); }
}
function setVideoOperation(key, operationId, input) {
  if (operationId) state.videoOperations.set(key, { operationId, input }); else state.videoOperations.delete(key);
  try { sessionStorage.setItem(VIDEO_OPERATION_STORAGE_KEY, JSON.stringify([...state.videoOperations])); } catch { /* 保留本页内的重复提交保护 */ }
}
const THEME_LABELS = { day: '白天主题', night: '夜晚主题' };
function applyTheme(theme, persist = false) {
  const value = theme === 'night' ? 'night' : 'day';
  const root = document.documentElement;
  if (root?.dataset) root.dataset.theme = value;
  const select = $('#theme-select');
  if (select && select.value !== value) select.value = value;
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, value); } catch { /* 浏览器禁用本地存储时仍可切换 */ }
  }
}
function initTheme() {
  // The Liblib-inspired dark workspace is the default; users can still choose day mode.
  let theme = 'night';
  try { theme = localStorage.getItem(THEME_STORAGE_KEY) || document.documentElement?.dataset?.theme || 'night'; } catch {
    theme = document.documentElement?.dataset?.theme || 'night';
  }
  applyTheme(theme);
  $('#theme-select')?.addEventListener('change', event => {
    applyTheme(event.target.value, true);
    toast(`已切换为${THEME_LABELS[event.target.value] || THEME_LABELS.day}。`);
  });
}
initTheme();
const state = { token: '', projects: [], deletedProjects: [], project: null, saved: null, settings: {}, catalog: [], imageCatalog: [], imageCatalogError: '', textCatalog: [], textCatalogError: '', kinds: {}, tools: {},
  jobs: [], imageJobs: [], imageReferenceIds: [], textMessages: [], textError: '', textBusy: false, showDeletedJobs: false, showDeletedImageJobs: false, showDeletedAssets: false, view: 'canvas', dirty: new Set(), versions: {}, saveTask: null, saveTimer: null, saveError: null,
  pollBusy: false, switching: false, submitting: new Set(), aiBusy: new Set(), imageOperations: new Map(), videoOperations: loadVideoOperations() };
let resultDetailsSelection = null, selectedChatText = '';
const fields = ['title', 'brief', 'graph', 'scenes'];
const jobLabels = { preparing: '上传素材中', waiting: '等待提交', submitting: '提交中', queued: '平台排队中', running: '生成中', downloading: '保存中', download_pending: '待下载',
  done: '已完成', failed: '未完成', uncertain: '需核对平台', attention: '需手动查询' };
const blockingStates = new Set(['waiting', 'preparing', 'submitting', 'queued', 'running', 'downloading', 'download_pending', 'uncertain', 'attention']);
function setCanvasTextDocked(docked) {
  const card = $('#text-chat-card'), home = $('#text-chat-home'), dock = $('#canvas-text-host');
  if (!card || !home || !dock) return;
  const parent = docked ? dock : home;
  if (card.parentElement !== parent) {
    clearTextSelectionActions();
    if (docked) parent.append(card);
    else parent.insertBefore(card, home.querySelector('.text-context-card'));
  }
  if (!$('#text-chat-messages').childElementCount) renderTextChat();
}
const canvas = createInfiniteCanvas({ getState: () => state, mark, flush, toast, setView, parameters, modelForScene, referencesFor,
  generateScene, generateImageCard, retryImageCard, refreshImageJobs, createScene, selectAsset, selectImageCandidate, uploadFiles, previewAsset,
  aiInputs: aiInputsForNode, runAiNode, isAiBusy: nodeId => state.aiBusy.has(nodeId), setTextChatDocked: setCanvasTextDocked });

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
async function api(url, method = 'GET', body) {
  const headers = { 'X-Studio-Token': state.token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try { response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' }); }
  catch { throw new ApiError('工作台连接中断。请检查启动窗口是否仍在运行。', 0); }
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error || '操作未完成。', response.status);
  return data;
}
let toastTimer;
function toast(message, error = false) {
  $('#toast').textContent = message; $('#toast').className = `visible${error ? ' error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').className = '', error ? 8000 : 4500);
}
function saveLabel(label, error = false) {
  $('#save-state').textContent = label; $('#save-state').classList.toggle('error', error);
}
let projectListRevision = 0;
function rememberProject(project) {
  projectListRevision++;
  state.projects = state.projects.filter(item => item.id !== project.id);
  state.deletedProjects = state.deletedProjects.filter(item => item.id !== project.id);
  (project.deletedAt ? state.deletedProjects : state.projects).push(clone(project));
  state.projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  state.deletedProjects.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}
function setProject(project) {
  canvas.setExpanded?.(false);
  closeResultDetails();
  state.project = clone(project); state.saved = clone(project); state.jobs = []; state.imageJobs = []; state.showDeletedJobs = false; state.showDeletedImageJobs = false; state.showDeletedAssets = false;
  state.dirty.clear(); state.saveError = null;
  state.versions = {};
  state.textMessages = project && typeof loadTextHistory === 'function' ? loadTextHistory(project.id) : [];
  state.textError = '';
  state.textBusy = false;
  renderTextChat();
  if (project) { rememberProject(project); localStorage.setItem('jingce-active-project', project.id); }
  else localStorage.removeItem('jingce-active-project');
  $('#image-page-form')?.reset();
  if ($('#image-page-quality')) $('#image-page-quality').value = 'auto';
  state.imageReferenceIds = [];
  if ($('#image-page-message')) $('#image-page-message').textContent = '';
  if ($('#result-filter')) $('#result-filter').value = 'all';
  if ($('#result-sort')) $('#result-sort').value = 'newest';
  canvas.reset(); renderAll(); saveLabel(project ? '已保存到本机' : '请选择或新建工程');
}
function loadTextHistory(projectId) {
  if (!projectId) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(`${TEXT_HISTORY_STORAGE_KEY}:${projectId}`) || '[]');
    return Array.isArray(raw) ? raw.filter(item => item && ['user', 'assistant'].includes(item.role)
      && typeof item.content === 'string' && item.content.trim()).slice(-24) : [];
  } catch { return []; }
}
function saveTextHistory() {
  const projectId = state.project?.id;
  if (!projectId) return;
  try { localStorage.setItem(`${TEXT_HISTORY_STORAGE_KEY}:${projectId}`, JSON.stringify(state.textMessages.slice(-24))); }
  catch { /* 对话仍保留在当前页面 */ }
}

function mark(field) {
  state.dirty.add(field); state.versions[field] = (state.versions[field] || 0) + 1;
  state.saveError = null; saveLabel('正在编辑…'); clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => flush().catch(() => {}), 550);
}

// Merge remote task updates without replacing unsaved text. Conflicting edits stay local.
function merge(base, local, remote) {
  if (same(local, base)) return clone(remote);
  if (same(remote, base) || same(local, remote)) return clone(local);
  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)
      && [...base, ...local, ...remote].every(item => item && typeof item.id === 'string')) {
    const baseIds = base.map(item => item.id), localIds = local.map(item => item.id), remoteIds = remote.map(item => item.id);
    if (!same(baseIds, localIds) && !same(baseIds, remoteIds) && !same(localIds, remoteIds)) throw new Error('conflict');
    const ids = same(baseIds, localIds) ? remoteIds : localIds;
    return ids.map(id => merge(base.find(item => item.id === id), local.find(item => item.id === id), remote.find(item => item.id === id)));
  }
  if (base && local && remote && !Array.isArray(base) && typeof base === 'object'
      && typeof local === 'object' && typeof remote === 'object') {
    const result = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
      result[key] = key === 'order' ? local[key] : merge(base[key], local[key], remote[key]);
    }
    return result;
  }
  throw new Error('conflict');
}
async function flush() {
  clearTimeout(state.saveTimer);
  if (state.saveTask) { await state.saveTask; if (state.dirty.size) return flush(); return; }
  if (!state.dirty.size || !state.project) return;
  state.saveTask = (async () => {
    while (state.dirty.size) {
      const id = state.project.id, changed = [...state.dirty], versions = { ...state.versions };
      const baseline = clone(state.saved);
      const patch = Object.fromEntries(changed.map(field => [field, clone(state.project[field])]));
      patch.revision = state.project.revision; state.dirty.clear(); saveLabel('保存中…');
      try {
        let project;
        try { project = await api(`/api/projects/${id}`, 'PATCH', patch); }
        catch (error) {
          if (error.status !== 409) throw error;
          const latest = await api(`/api/projects/${id}`);
          try { for (const field of changed) patch[field] = merge(baseline[field], patch[field], latest[field]); }
          catch { throw new ApiError('其他窗口修改了相同内容。你的编辑仍在此页，点击保存提示可下载备份并重新加载。', 409); }
          patch.revision = latest.revision;
          project = await api(`/api/projects/${id}`, 'PATCH', patch);
        }
        state.saved = clone(project);
        for (const field of fields) if ((state.versions[field] || 0) === (versions[field] || 0)) state.project[field] = clone(project[field]);
        state.project.revision = project.revision; state.project.updatedAt = project.updatedAt;
        state.project.assets = project.assets; state.project.exports = project.exports; state.project.planSource = project.planSource;
        rememberProject(project); renderProjects(); renderCounts();
        saveLabel(state.dirty.size ? '继续保存…' : '已保存到本机');
      } catch (error) {
        changed.forEach(field => state.dirty.add(field)); state.saveError = error;
        saveLabel('未保存 · 点击处理', true); toast(error.message, true); throw error;
      }
    }
  })();
  try { await state.saveTask; } finally { state.saveTask = null; }
}
async function action(button, task) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try { await task(); } catch (error) { toast(error.message || '操作未完成。', true); }
  finally { if (button?.isConnected) button.disabled = false; }
}
function downloadJson(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function localExport() {
  const { title, brief, graph, scenes, planSource } = state.project;
  const referencedScenes = scenes.map(scene => ({ ...scene, references: referencesFor(scene) }));
  const portableMention = createPortablePromptMentionMapper(referencedScenes);
  const exportGraph = clone(graph);
  exportGraph.nodes = exportGraph.nodes.map(node => ({ ...node, assetId: '',
    assetName: String(state.project.assets.find(asset => asset.id === node.assetId)?.name || node.assetName || '').slice(0, 120),
    ...(node.role === 'image-generation' ? {imageJobId:'',imageJobIds:[],selectedAssetId:'',status:'pending'} : {}) }));
  exportGraph.links = exportGraph.links.map(link => link.reference ? { ...link, reference: { assetId: '', kind: link.reference.kind,
    name: state.project.assets.find(asset => asset.id === link.reference.assetId)?.name || link.reference.name || '' } } : link);
  return { format: 'jingce-project', schemaVersion: 1, project: { title, brief, graph: exportGraph,
    scenes: referencedScenes.map(scene => ({ ...scene, videoAssetId: '', referenceAssetId: '',
      promptMentions: (scene.promptMentions || []).map(mention => ({ ...portableMention(mention, scene.references), missing: true })),
      references: scene.references.map(({ publicUrl, ...reference }) => ({ ...reference, assetId: '',
        name: state.project.assets.find(asset => asset.id === reference.assetId)?.name || reference.name || '' })) })), planSource } };
}
async function exportCurrent() {
  await flush();
  const anchor = document.createElement('a'); anchor.href = `/api/projects/${state.project.id}/export`;
  anchor.download = `${state.project.title}.json`; anchor.click();
}
async function withProjectChange(task) {
  if (state.switching) return;
  state.switching = true; projectListRevision++; $('.workspace').inert = true; renderProjects();
  try { canvas.finishEditing(); await flush(); return await task(); }
  finally { state.switching = false; $('.workspace').inert = false; renderProjects(); }
}
async function switchProject(id) {
  if (id === state.project?.id) return;
  try { await withProjectChange(async () => { setProject(await api(`/api/projects/${id}`)); await refreshJobs(); await refreshImageJobs(); }); }
  catch (error) { toast(error.message, true); }
}
async function refreshProjectList() {
  const requestRevision = ++projectListRevision;
  const projects = await api('/api/projects?includeDeleted=1');
  if (requestRevision !== projectListRevision) return;
  state.projects = projects.filter(project => !project.deletedAt);
  state.deletedProjects = projects.filter(project => project.deletedAt).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  renderProjects();
}
async function selectAvailableProject() {
  for (const project of [...state.projects]) {
    try { setProject(await api(`/api/projects/${project.id}`)); await refreshJobs(); return; }
    catch (error) {
      if (![404, 410].includes(error.status)) throw error;
      state.projects = state.projects.filter(item => item.id !== project.id);
    }
  }
  setProject(null);
}
async function deleteProject(id) {
  await withProjectChange(async () => {
    const project = await api(`/api/projects/${id}`, 'DELETE'); rememberProject(project);
    const active = state.project?.id === id;
    if (active) setProject(null);
    await refreshProjectList();
    if (active) await selectAvailableProject();
    toast('工程已移到“已删除工程”，可恢复；已有生成任务会继续处理。');
  });
}
async function restoreProject(id) {
  await withProjectChange(async () => {
    const project = await api(`/api/projects/${id}/restore`, 'POST', {}); rememberProject(project);
    if (!state.project) { setProject(project); await refreshJobs(); await refreshImageJobs(); }
    toast('视频工程已恢复。');
  });
}
function renderProjects() {
  const disabled = state.switching ? ' disabled' : '';
  for (const id of ['new-project', 'import-project', 'open-deleted-projects']) $(`#${id}`).disabled = state.switching;
  $('#project-list').innerHTML = state.projects.length ? state.projects.map(project => `<div class="project-row${project.id === state.project?.id ? ' active' : ''}"><button class="project-item${project.id === state.project?.id ? ' active' : ''}" data-project-id="${escapeHtml(project.id)}" title="${escapeHtml(project.title)}"${disabled}><span class="project-icon">▧</span><span>${escapeHtml(project.title)}</span></button><button class="delete-project" data-delete-project="${escapeHtml(project.id)}" title="删除工程：${escapeHtml(project.title)}" aria-label="删除工程：${escapeHtml(project.title)}"${disabled}>删除</button></div>`).join('') : '<p class="project-list-empty">还没有视频工程</p>';
  $('#deleted-project-count').textContent = state.deletedProjects.length ? `（${state.deletedProjects.length}）` : '';
  renderDeletedProjects();
}
function renderDeletedProjects() {
  const disabled = state.switching ? ' disabled' : '';
  $('#deleted-project-list').innerHTML = state.deletedProjects.length ? state.deletedProjects.map(project => `<div class="deleted-project-row"><div class="deleted-project-info"><strong title="${escapeHtml(project.title)}">${escapeHtml(project.title)}</strong><small>${project.scenes.length} 个视频生成项 · ${project.assets.length} 份素材 · ${escapeHtml(new Date(project.deletedAt).toLocaleString('zh-CN'))} 删除</small></div><div class="deleted-project-actions"><button class="button" data-restore-project="${escapeHtml(project.id)}"${disabled}>恢复</button><button class="button project-danger" data-permanent-project="${escapeHtml(project.id)}"${disabled}>彻底删除</button></div></div>`).join('') : '<p class="project-trash-empty">暂无已删除工程</p>';
}
let permanentProjectId = '';
function confirmPermanentDelete(id) {
  const project = state.deletedProjects.find(item => item.id === id);
  if (!project) return;
  permanentProjectId = id;
  $('#permanent-project-name').textContent = project.title;
  $('#permanent-project-error').hidden = true;
  $('#permanent-project-dialog').showModal();
}
async function permanentlyDeleteProject() {
  const id = permanentProjectId;
  if (!id) return;
  try {
    await withProjectChange(async () => {
      const result = await api(`/api/projects/${id}/permanent`, 'DELETE');
      projectListRevision++;
      state.deletedProjects = state.deletedProjects.filter(project => project.id !== id);
      $('#permanent-project-dialog').close(); permanentProjectId = '';
      renderProjects();
      toast(result.cleanupPending ? '工程已彻底删除；有文件正在被占用，重启工作台后会继续清理。' : '工程及其本机素材、生成记录和成片已彻底删除。');
    });
  } catch (error) {
    $('#permanent-project-error').textContent = error.message;
    $('#permanent-project-error').hidden = false;
  }
}
async function recoverUnavailableProject(id, error) {
  if (state.project?.id !== id || state.switching) return;
  if (state.dirty.size || state.saveTask) {
    state.saveError = error; saveLabel('工程已删除 · 点击备份', true);
    return;
  }
  await withProjectChange(async () => {
    setProject(null); await refreshProjectList(); await selectAvailableProject();
    toast('此工程已在其他窗口删除，可从“已删除工程”恢复。');
  });
}
function activeAssets() { return (state.project?.assets || []).filter(asset => !asset.deletedAt); }
function generatedAssets() {
  return activeAssets().filter(asset => asset.source === 'model' && ['image', 'video'].includes(asset.kind));
}
function renderCounts() {
  $('#scene-count').textContent = state.project?.scenes.length || 0; $('#asset-count').textContent = activeAssets().length;
  $('#image-generation-count').textContent = state.imageJobs.filter(job => !job.deletedAt).length;
  $('#result-count').textContent = generatedAssets().length;
}
function renderBrief() {
  $('#project-title').value = state.project.title;
  for (const [key, value] of Object.entries(state.project.brief)) {
    const control = $('#brief-form').elements.namedItem(key); if (control) control.value = value;
  }
}
function setView(view) {
  view = ({ scenes: 'videos', delivery: 'results' })[view] || view;
  if (!['canvas', 'assets', 'images', 'videos', 'results', 'text'].includes(view)) view = 'canvas';
  if (view !== state.view) clearTextSelectionActions();
  if (state.view === 'canvas' && view !== 'canvas') { canvas.finishEditing(); canvas.setExpanded?.(false); }
  if (view !== 'results') closeResultDetails();
  state.view = view;
  if (!state.project) return;
  $$('.view').forEach(element => element.classList.toggle('hidden', element.id !== `${view}-view`));
  $$('.tab').forEach(button => { const active = button.dataset.view === view; button.classList.toggle('active', active); button.setAttribute('aria-selected', active); });
  if (view === 'canvas') { canvas.activate(); renderCanvas(); }
  if (view === 'assets') renderAssets();
  if (view === 'images') { renderImageGeneration(); renderImageJobs(); }
  if (view === 'videos') { renderScenes(); renderJobs(); }
  if (view === 'results') { renderResults(); }
  if (view === 'text') { renderTextChat(); }
}
function renderAll() {
  $('.workspace').classList.toggle('no-project', !state.project);
  $('#empty-workspace').hidden = Boolean(state.project);
  renderProjects(); renderCounts(); renderSettingsStatus();
  if (state.project) { renderBrief(); setView(state.view); }
}

function renderCanvas() { canvas.render(); }
function fitCanvas() { canvas.fit(); }

function selectedModel() { return state.catalog.find(model => model.name === state.settings.videoModel); }
function modelForScene(scene) { return scene?.videoModel ? state.catalog.find(model => model.name === scene.videoModel) : state.catalog.find(model => model.name === state.settings.videoModel) || state.catalog[0]; }
function parameters(scene) { return videoParameters(modelForScene(scene), { ...scene, projectRatio: state.project?.brief?.ratio || '' }, state.settings.generationCountMax || 5); }
const options = (items, selected) => items.map(item => `<option value="${escapeHtml(item.value)}"${item.value === selected ? ' selected' : ''}${item.disabled ? ' disabled' : ''}>${escapeHtml(item.label)}</option>`).join('');
function referencesFor(scene) { return resolveSceneReferences(state.project, scene); }
function referenceIssueFor(scene) { return referenceRequestIssue(modelForScene(scene), referencesFor(scene), { allowLocalUpload: Boolean(state.settings.storage?.ready) }); }
function aiInputsForNode(nodeId) {
  const project = state.project;
  if (!project) return [];
  const nodes = new Map(project.graph.nodes.map(node => [node.id, node]));
  const assets = new Map(project.assets.filter(asset => !asset.deletedAt).map(asset => [asset.id, asset]));
  const inputs = [];
  for (const link of project.graph.links.filter(link => link.to === nodeId)) {
    const source = nodes.get(link.from);
    if (!source) continue;
    let value = '';
    if (source.kind === 'ai') value = normalizeAiConfig(source.aiConfig).output || source.note || '';
    else if (source.kind === 'text') value = source.note || '';
    else if (source.kind === 'brief') value = textContextText();
    else if (source.kind === 'video' && source.sceneId) value = project.scenes.find(scene => scene.id === source.sceneId)?.videoPrompt || '';
    else if (source.kind === 'image' && source.role === 'image-generation') value = source.imageConfig?.prompt || '';
    else if (source.assetId) value = `素材名称：${assets.get(source.assetId)?.name || source.assetName || '未命名素材'}`;
    else value = source.note || '';
    if (value.trim()) inputs.push({ label: source.label || source.kind, text: value.trim() });
  }
  return inputs;
}
async function runAiNode(nodeId) {
  const projectId = state.project?.id, node = state.project?.graph.nodes.find(item => item.id === nodeId);
  if (!projectId || !node || node.kind !== 'ai') throw new Error('找不到这个 AI 创作卡。');
  if (state.aiBusy.has(nodeId)) throw new Error('这个 AI 创作卡正在生成，请稍候。');
  const config = normalizeAiConfig(node.aiConfig);
  const model = config.model || state.settings.text?.textModel || state.textCatalog?.[0]?.name || '';
  if (!state.settings.text?.hasKey) throw new Error('请先在左侧“语言模型”中保存 API Key。');
  if (!model) throw new Error('请先刷新语言模型目录并选择一个模型。');
  const messages = buildAiMessages({ mode: config.mode, instruction: config.instruction, inputs: aiInputsForNode(nodeId) });
  state.aiBusy.add(nodeId);
  node.aiConfig = normalizeAiConfig({ ...config, model, status: 'running', error: '' });
  mark('graph'); canvas.render();
  let completed = false;
  try {
    const result = await api('/api/text-chat', 'POST', { model, messages });
    if (projectId !== state.project?.id) throw new Error('工程已切换，本次 AI 结果未写入其他工程。');
    const current = state.project.graph.nodes.find(item => item.id === nodeId);
    if (!current) throw new Error('AI 创作卡已被移除，本次结果未保存。');
    const parsed = parseAiResponse(config.mode, result.content);
    if (!parsed.output.trim()) throw new Error('语言模型没有返回可用文字。');
    current.aiConfig = normalizeAiConfig({ ...config, model: result.model || model, status: 'done', error: '', output: parsed.output, scenes: parsed.scenes, updatedAt: new Date().toISOString() });
    current.note = parsed.output.slice(0, 2000);
    completed = true;
    mark('graph'); await flush();
    return parsed;
  } catch (error) {
    if (!completed && projectId === state.project?.id) {
      const current = state.project.graph.nodes.find(item => item.id === nodeId);
      if (current) { current.aiConfig = normalizeAiConfig({ ...config, model, status: 'error', error: error.message }); mark('graph'); }
    }
    throw error;
  } finally {
    state.aiBusy.delete(nodeId); canvas.render();
  }
}
function editableReferences(scene) {
  scene.references = referencesFor(scene); scene.referenceAssetId = '';
  return scene.references;
}
function changeReferences(operation) {
  const project = state.project, before = { graph: clone(project.graph), scenes: clone(project.scenes) };
  const previous = new Map(project.scenes.map(scene => [scene.id, referencesFor(scene)]));
  try {
    operation(); syncProjectReferences(project);
    for (const scene of project.scenes) {
      const mapped = remapPromptMentions(scene.videoPrompt || '', scene.promptMentions || [], previous.get(scene.id) || [], scene.references);
      scene.videoPrompt = mapped.prompt; scene.promptMentions = mapped.mentions;
    }
    mark('scenes'); if (!same(before.graph, project.graph)) mark('graph');
    renderScenes(); canvas.render(); return true;
  } catch (error) {
    project.graph = before.graph; project.scenes = before.scenes;
    renderScenes(); canvas.render(); toast(error.message, true); return false;
  }
}
function localConcurrencyNote() {
  const limit = state.settings.maxConcurrentTasks;
  return Number.isFinite(limit) && limit > 0
    ? `工作台最多同时处理 ${limit} 个，其余自动排队。`
    : '工作台不限制本地同时提交，平台会按自身队列或限流处理。';
}
function sceneGenerationNote(active, p, references, invalid, referenceIssue) {
  return active?.deletedAt ? '这个视频生成项的任务记录已删除，任务跟踪仍保留。可在下方已删除记录中恢复查看。' : active?.state === 'uncertain' ? '提交结果不确定，请先核对平台记录，随后在任务区补填编号。' : !state.settings.hasKey ? '先在左下角“模型连接”中保存 API Key。' : invalid.length ? invalid[0].message : referenceIssue ? referenceIssue : references.length ? (state.settings.storage?.ready ? '生成时会自动上传已选的本机参考素材，生成任务提交前不会要求你手填链接。' : '将提交上方参考素材链接、用途和视频提示词；也可以先配置素材云存储自动上传。') : `一次生成 ${p.count} 个视频，${localConcurrencyNote()} 完成后在候选区预览并选用。`;
}
function refreshSceneGenerate(card, scene) {
  const p = parameters(scene), active = state.jobs.find(job => job.sceneId === scene.id && blockingStates.has(job.state));
  const refs = referencesFor(scene), invalid = invalidPromptMentions(scene, refs), referenceIssue = referenceIssueFor(scene), button = card.querySelector('[data-scene-action="generate"]');
  const pending = state.videoOperations.has(state.project.id + ':' + scene.id);
  if (button) { button.disabled = Boolean(state.submitting.has(scene.id) || !pending && (!state.settings.hasKey || !p.tier || referenceIssue || invalid.length));
    button.textContent = state.submitting.has(scene.id) ? '提交中…' : pending ? '核对上次提交 ↗' : invalid.length ? '请修正素材引用' : referenceIssue ? '请完善参考设置'
      : `${state.jobs.some(job => job.sceneId === scene.id) || scene.videoAssetId ? '再次生成' : '生成'} ${p.count} 个${p.count > 1 ? '候选' : ''}视频 ↗`; }
  const generationNote = card.querySelector('[data-generation-note]');
  if (generationNote) generationNote.textContent = sceneGenerationNote(active, p, refs, invalid, referenceIssue);
  const refNote = card.querySelector('[data-reference-validation]');
  if (refNote) refNote.textContent = referenceIssue || referenceCapabilityText(modelForScene(scene));
  const note = card.querySelector('[data-prompt-validation]'); if (note) { note.hidden = !invalid.length; note.textContent = invalid[0]?.message || ''; }
}
async function generateScene(sceneId) {
  const projectId = state.project.id;
  let scene = state.project.scenes.find(item => item.id === sceneId);
  if (!scene) throw new Error('这个视频生成项已移除，请刷新画布。');
  if (state.submitting.has(sceneId)) throw new Error('这个视频生成项正在提交，请稍候。');
  const key = projectId + ':' + sceneId, pending = state.videoOperations.get(key);
  const pendingOperation = typeof pending === 'string' ? pending : pending?.operationId;
  let started = false;
  state.submitting.add(sceneId); renderScenes(); canvas.render();
  try {
    if (pendingOperation) {
      const records = await api(`/api/projects/${projectId}/jobs?includeDeleted=1`);
      if (projectId !== state.project?.id) throw new Error('工程已切换，请返回原工程核对任务。');
      state.jobs = records;
      const existing = records.filter(job => job.operationId === pendingOperation);
      if (existing.length) {
        setVideoOperation(key, null);
        toast('已找到上次提交的视频任务，继续跟踪原任务结果。');
        return { batchId: existing[0].batchId, count: existing.length, jobs: existing };
      }
    }
    await flush();
    if (projectId !== state.project?.id) throw new Error('工程已切换，请返回原工程再生成。');
    scene = state.project.scenes.find(item => item.id === sceneId);
    if (!scene) throw new Error('这个视频生成项已移除，请刷新画布。');
    const references = referencesFor(scene), issues = invalidPromptMentions(scene, references);
    if (issues.length) throw new Error(issues[0].message);
    const referenceIssue = referenceIssueFor(scene);
    if (referenceIssue) throw new Error(referenceIssue);
    const p = parameters(scene), operationId = pendingOperation || uid();
    const input = pending?.input || { sceneId, model: p.model?.name, duration: p.duration, count: p.count,
      requestMode: p.model?.requestMode || state.settings.videoRequestMode, ratio: scene.ratio || undefined, resolution: scene.resolution || undefined,
      referenceAssetId: scene.referenceAssetId, operationId };
    setVideoOperation(key, operationId, input); started = true;
    const batch = await api(`/api/projects/${projectId}/batches`, 'POST', input);
    setVideoOperation(key, null);
    if (projectId === state.project?.id) {
      const ids = new Set(batch.jobs.map(job => job.id));
      state.jobs = [...batch.jobs, ...state.jobs.filter(job => !ids.has(job.id))];
    }
    toast(`已记录 ${batch.count} 个候选视频，可在任务记录中查看进度。`);
    return batch;
  } catch (error) {
    if (started && (!error.status || error.status >= 500 || error.status === 408)) {
      throw new ApiError('提交确认暂未收到。再次点击会先核对原任务，避免重复提交。', error.status || 0);
    }
    if (started && !pendingOperation) setVideoOperation(key, null);
    throw error;
  } finally { state.submitting.delete(sceneId); renderScenes(); renderJobs(); canvas.render(); }
}
function createScene(prompt = '', title = '新的视频') {
  if (state.project.scenes.length >= 30) throw new Error('最多支持 30 个视频片段。');
  const scene = { id: uid(), order: state.project.scenes.length + 1, title: String(title || '新的视频').slice(0, 120), duration: 5,
    visual: '', narration: '', imagePrompt: '', videoPrompt: String(prompt || '').slice(0, 4000),
    videoAssetId: '', referenceAssetId: '', references: [], promptMentions: [], generationDuration: 0, generationCount: 1, videoModel: '', ratio: '', resolution: '' };
  state.project.scenes.push(scene); mark('scenes'); renderCounts();
  return scene;
}
async function selectAsset(sceneId, assetId) {
  const scene = state.project.scenes.find(item => item.id === sceneId);
  const asset = activeAssets().find(item => item.id === assetId && item.kind === 'video');
  if (!scene || !asset) throw new Error('请选择本工程中已经保存的视频素材。');
  scene.videoAssetId = asset.id; mark('scenes'); await flush();
  renderScenes(); canvas.render(); toast('已设为当前结果。');
}
async function selectImageCandidate(nodeId, assetId) {
  const node = state.project?.graph.nodes.find(item => item.id === nodeId);
  const asset = activeAssets().find(item => item.id === assetId && item.kind === 'image' && item.source === 'model' && item.nodeId === nodeId);
  if (!node || !isImageGenerationNode(node) || !asset) throw new Error('请选择这张生图卡片已经保存的候选图片。');
  node.selectedAssetId = asset.id;
  node.assetId = asset.id;
  node.assetName = asset.name;
  node.status = 'done';
  mark('graph');
  await flush();
  canvas.render();
  toast('已设为最终素材。');
}
function placeAssetOnCanvas(assetId) {
  const asset = activeAssets().find(item => item.id === assetId);
  if (!asset || !['image', 'video', 'audio'].includes(asset.kind)) throw new Error('请选择已经保存的图片、视频或声音素材。');
  setView('canvas');
  const existing = state.project.graph.nodes.find(node => !node.sceneId && node.assetId === asset.id);
  const node = canvas.addAsset(asset);
  toast(existing ? '这个素材已经在画布上，可从素材卡右侧端口连接到其他视频生成项。' : '已放到无限画布，请从素材卡右侧端口拖到目标视频生成项。');
  return node;
}

function renderReferences(scene, references) {
  const assets = activeAssets().filter(asset => ['image','video','audio'].includes(asset.kind));
  const available = assets.filter(asset => !references.some(reference => reference.assetId === asset.id));
  const limit = state.settings.referencePreparationLimit || 10, imageCount = references.filter(reference => reference.kind === 'image').length;
  return `<section class="reference-preparation" aria-label="视频参考素材准备">
    <div class="reference-summary"><strong>本视频卡片参考素材</strong><span>${imageCount} 张图片 · ${references.filter(reference => reference.kind === 'video').length} 段视频 · ${references.filter(reference => reference.kind === 'audio').length} 份音频</span></div>
    <p class="reference-status">${state.settings.storage?.ready ? '已开启自动上传：点击生成时只上传本视频卡片选中的图片、视频和音频，并生成临时 HTTPS 链接。' : '图片、视频和音频需填写公网 HTTPS 原文件链接；也可以在左下角“素材云存储”中开启自动上传。'}</p><p class="reference-status" data-reference-validation>${escapeHtml(referenceIssueFor(scene) || referenceCapabilityText(modelForScene(scene)))}</p>
    <label>从素材库添加（最多 ${limit} 份）<select data-reference-picker${references.length >= limit || !available.length ? ' disabled' : ''}>${options([{ value:'',label:references.length >= limit ? '已达到本地准备数量上限' : available.length ? '选择图片、视频或音频添加…' : '请先到素材库上传图片、视频或音频' },...available.map(asset=>({value:asset.id,label:`${{image:'图片',video:'视频',audio:'音频'}[asset.kind]} · ${asset.name}`}))],'')}</select></label>
    <div class="reference-list">${references.map((reference,index)=>{
      const asset=assets.find(asset=>asset.id===reference.assetId),label=referenceLabel(references,index),linked=Boolean(reference.nodeId);
      const preview=asset ? reference.kind==='image' ? `<img loading="lazy" src="/api/assets/${encodeURIComponent(asset.id)}" alt="${escapeHtml(label)}参考素材">` : `<${reference.kind === 'audio' ? 'audio' : 'video'} controls preload="none" src="/api/assets/${encodeURIComponent(asset.id)}" aria-label="${escapeHtml(label)}参考素材"></${reference.kind === 'audio' ? 'audio' : 'video'}>` : '';
      const replacement=!asset ? `<label class="reference-relink">${escapeHtml(reference.name||label)} · 待补选素材<select data-reference-relink="${index}">${options([{value:'',label:'上传后在这里重新选择素材'},...available.filter(item=>item.kind===reference.kind).map(item=>({value:item.id,label:item.name}))],'')}</select></label>` : '';
      return `<div class="reference-item"><div class="reference-heading"><button type="button" class="reference-insert" data-reference-action="insert" data-reference-index="${index}" title="插入到视频提示词"${asset?'':' disabled'}>@${escapeHtml(label)}</button><span title="${escapeHtml(asset?.name||reference.name||'待补选素材')}">${escapeHtml(asset?.name||reference.name||'待补选素材')}</span><div class="reference-actions"><button type="button" data-reference-action="up" data-reference-index="${index}" aria-label="上移${escapeHtml(label)}"${linked||index===0||references[index-1]?.nodeId?' disabled':''}>↑</button><button type="button" data-reference-action="down" data-reference-index="${index}" aria-label="下移${escapeHtml(label)}"${linked||index===references.length-1||references[index+1]?.nodeId?' disabled':''}>↓</button><button type="button" data-reference-action="remove" data-reference-index="${index}" aria-label="${linked?'断开':'移除'}${escapeHtml(label)}" title="${linked?'断开画布连接':'移除本视频卡片参考'}">×</button></div></div><small class="reference-origin">${linked?'来自画布连线 · 顺序由连接时间决定':'从素材库添加'}</small>${preview}${replacement}${reference.kind === 'image' && modelForScene(scene)?.referenceSupport?.protocol === 'content-v3' ? `<label>图片用途<select data-reference-role="${index}" aria-label="${escapeHtml(label)}图片用途">${options([{value:'reference_image',label:'通用参考图片'},{value:'first_frame',label:'首帧'},{value:'last_frame',label:'尾帧'}],reference.role === 'end_frame' ? 'last_frame' : reference.role || 'reference_image')}</select></label>` : ''}<details class="reference-manual-url"${reference.publicUrl ? ' open' : ''}><summary>手动填写公网链接（可选）</summary><label>平台可访问的素材链接<input type="url" data-reference-url="${index}" aria-label="${escapeHtml(label)}公网素材链接" maxlength="4096" placeholder="https://你的素材域名/原文件" value="${escapeHtml(reference.publicUrl || '')}"></label></details><label>参考用途<textarea data-reference-note="${index}" aria-label="${escapeHtml(label)}参考用途" rows="2" maxlength="1200" placeholder="例如：人物外观、场景、动作或画面运动">${escapeHtml(reference.note)}</textarea></label></div>`;
    }).join('')}</div>
    ${references.length?`<p class="honest-note">输入 @ 选择素材，或点击编号插入；参考用途会一起发送。${state.settings.storage?.ready ? '自动上传只针对本视频卡片选中的参考，临时链接会随任务保存。' : '链接必须无需登录即可读取原文件；本机文件不会自动上传到外网。'}</p>`:''}
  </section>`;
}
function renderCandidates(scene, videos) {
  const generated = videos.filter(asset => asset.sceneId === scene.id && asset.source === 'model');
  const items = state.jobs.filter(job => job.sceneId === scene.id && !job.deletedAt
    && !state.project.assets.some(asset => asset.id === job.assetId && asset.deletedAt))
    .map(job => ({ job, asset: generated.find(asset => asset.id === job.assetId) }));
  const attached = new Set(items.map(item => item.asset?.id));
  items.push(...generated.filter(asset => !attached.has(asset.id)).map(asset => ({ asset, job: null })));
  if (!items.length) return '';
  items.sort((a, b) => String(b.job?.createdAt || b.asset.createdAt).localeCompare(String(a.job?.createdAt || a.asset.createdAt))
    || (a.job?.variantIndex || a.asset?.variantIndex || 1) - (b.job?.variantIndex || b.asset?.variantIndex || 1));
  return `<section class="scene-candidates" aria-label="${escapeHtml(scene.title)}的候选视频"><div class="candidate-heading"><h3>候选视频</h3><span>${generated.length} 个已保存 · 预览后选择当前结果</span></div><div class="candidate-grid">${items.map(({ asset, job }) => {
    const count = job?.variantCount || asset?.variantCount || 1, index = job?.variantIndex || asset?.variantIndex || 1;
    const selected = asset && scene.videoAssetId === asset.id;
    const label = count > 1 ? `候选 ${index}/${count}` : '生成视频';
    const duration = job?.duration || asset?.duration;
    return `<article class="candidate-card${selected ? ' selected' : ''}">
      ${asset ? `<video controls preload="none" src="/api/assets/${encodeURIComponent(asset.id)}" aria-label="${escapeHtml(label)}预览"></video>` : `<div class="candidate-placeholder"><strong>${escapeHtml(jobLabels[job.state] || job.state)}</strong><p>${escapeHtml(job.message)}</p></div>`}
      <div class="candidate-info"><strong>${escapeHtml(label)}${duration ? ` · ${duration} 秒` : ''}</strong><small>${escapeHtml(new Date(job?.createdAt || asset.createdAt).toLocaleString('zh-CN'))}</small>
      ${asset ? `<div class="candidate-actions"><button type="button" class="${selected ? 'button' : 'primary'} full" data-scene-action="select-candidate" data-asset-id="${escapeHtml(asset.id)}"${selected ? ' disabled' : ''}>${selected ? '✓ 当前结果' : '设为当前结果'}</button><button type="button" class="button full" data-scene-action="place-asset" data-asset-id="${escapeHtml(asset.id)}">放到画布作为参考</button></div><a class="candidate-download" href="/api/assets/${encodeURIComponent(asset.id)}?download=1" download>下载视频</a>` : `<small>${escapeHtml(job.model)}</small>`}</div></article>`;
  }).join('')}</div></section>`;
}
function renderScenes() {
  if (!state.project) return;
  const project = state.project;
  $('#plan-note').textContent = '每个视频独立设置提示词、参考素材和模型参数。输入 @ 可引用连接到本视频卡片的素材。';
  if (!project.scenes.length) {
    $('#scene-list').innerHTML = '<div class="empty-state"><strong>从第一个视频开始创作。</strong>点击“新增视频生成项”开始；也可以在画布中添加视频卡片。每一项都能独立选择模型和生成参数。</div>'; return;
  }
  const images = activeAssets().filter(asset => asset.kind === 'image'), videos = activeAssets().filter(asset => asset.kind === 'video');
  $('#scene-list').innerHTML = project.scenes.map((scene, index) => {
    const p = parameters(scene), active = state.jobs.find(job => job.sceneId === scene.id && blockingStates.has(job.state));
    const references = referencesFor(scene);
    const video = videos.find(asset => asset.id === scene.videoAssetId), image = images.find(asset => asset.id === scene.imageAssetId) || images.find(asset => references.some(reference => reference.assetId === asset.id));
    const invalid = invalidPromptMentions(scene,references);
    const referenceIssue = referenceIssueFor(scene);
    const pending = state.videoOperations.has(project.id + ':' + scene.id);
    const disabled = state.submitting.has(scene.id) || !pending && (!state.settings.hasKey || !p.tier || referenceIssue || invalid.length);
    const cost = videoEstimateText(p);
    const controls = videoParameterControls(p, state.catalog, state.settings.generationCountMax || 5, state.submitting.has(scene.id), scene.videoModel || state.settings.videoModel);
    return `<article class="scene-card" data-scene-id="${escapeHtml(scene.id)}"><div class="scene-heading"><span class="scene-number">${String(index + 1).padStart(2, '0')}</span><input data-scene-field="title" aria-label="视频生成项 ${index + 1} 标题" value="${escapeHtml(scene.title)}" maxlength="120"><div class="scene-actions"><button data-scene-action="up" title="上移视频生成项"${index === 0 ? ' disabled' : ''}>↑</button><button data-scene-action="down" title="下移视频生成项"${index === project.scenes.length - 1 ? ' disabled' : ''}>↓</button><button data-scene-action="remove" title="删除视频生成项">×</button></div></div>
      <div class="video-generation-layout"><div class="video-generation-main"><div class="scene-prompts reference-prompt-editor"><label>视频提示词 <span class="prompt-at-hint">输入 @ 选择参考素材</span><textarea data-scene-field="videoPrompt" data-reference-prompt rows="6" maxlength="4000" aria-label="视频生成项 ${index + 1} 视频提示词" placeholder="直接描述画面、人物动作、镜头运动与风格">${escapeHtml(scene.videoPrompt)}</textarea></label><div class="reference-mention-menu" role="listbox" aria-label="本视频卡片参考素材" hidden></div><p class="honest-note prompt-validation" data-prompt-validation${invalid.length ? '' : ' hidden'}>${escapeHtml(invalid[0]?.message || '')}</p></div>
        <details class="video-reference-settings"${references.length ? ' open' : ''}><summary>参考素材 <span>${references.length ? `已选择 ${references.length} 份` : '可选 · 添加图片、视频或音频'}</span></summary>${renderReferences(scene, references)}</details></div>
      <aside class="video-generation-preview"><div class="scene-preview">${video ? `<video controls preload="metadata" playsinline src="/api/assets/${encodeURIComponent(video.id)}"></video>` : image ? `<img src="/api/assets/${encodeURIComponent(image.id)}" alt="已选参考图片">` : '<span>生成后在这里预览视频</span>'}</div><p class="honest-note">${video ? '当前视频结果，可下载或连接到其他视频卡片作为参考。' : image ? '已选参考图 · 视频生成后可在这里预览。' : '每次生成的结果都会保存在“生成结果”中。'}</p></aside></div>
      <div class="video-generation-controls">${Object.entries(controls).map(([field, config]) => `<label${field === 'videoModel' ? ' class="video-model-control"' : ''}>${config.label}<select data-scene-field="${field}"${config.disabled ? ' disabled' : ''}>${options(config.options, config.value)}</select></label>`).join('')}</div>
      <div class="video-generation-footer"><div class="cost-line"><strong>${escapeHtml(cost)}</strong><small>${escapeHtml(videoPricingNote(p))}</small></div><button class="primary" data-scene-action="generate"${disabled ? ' disabled' : ''}>${state.submitting.has(scene.id) ? '提交中…' : pending ? '核对上次提交 ↗' : invalid.length ? '请修正素材引用' : referenceIssue ? '请完善参考设置' : `${state.jobs.some(job => job.sceneId === scene.id) || video ? '再次生成' : '生成'} ${p.count} 个视频 ↗`}</button></div>
      <p class="honest-note" data-generation-note>${escapeHtml(sceneGenerationNote(active, p, references, invalid, referenceIssue))}</p>${renderCandidates(scene, videos)}</article>`;
  }).join('');
}
$('#scene-list').addEventListener('input', event => {
  if (event.target.dataset.referenceUrl !== undefined) {
    const card = event.target.closest('.scene-card');
    const scene = state.project.scenes.find(scene => scene.id === card.dataset.sceneId);
    const reference = editableReferences(scene)[Number(event.target.dataset.referenceUrl)];
    if (reference) { reference.publicUrl = event.target.value; mark('scenes'); refreshSceneGenerate(card, scene); }
    return;
  }
  if (event.target.dataset.referenceNote !== undefined) {
    const scene = state.project.scenes.find(scene => scene.id === event.target.closest('.scene-card').dataset.sceneId);
    const reference = editableReferences(scene)[Number(event.target.dataset.referenceNote)];
    if (reference) { reference.note = event.target.value; mark('scenes'); }
    return;
  }
  const field = event.target.dataset.sceneField; if (!field || event.target.tagName === 'SELECT') return;
  const scene = state.project.scenes.find(scene => scene.id === event.target.closest('.scene-card').dataset.sceneId);
  if (field === 'duration') {
    if (!event.target.validity.valid || !event.target.value) return;
    scene[field] = Number(event.target.value);
  } else {
    if (field === 'videoPrompt') scene.promptMentions = updatePromptMentions(scene.videoPrompt || '',event.target.value,scene.promptMentions || [],referencesFor(scene),scenePromptEditor.takeEdit?.(event.target,scene.videoPrompt || '',event.target.value));
    scene[field] = event.target.value;
  }
  mark('scenes'); if (field === 'videoPrompt') refreshSceneGenerate(event.target.closest('.scene-card'),scene);
});
$('#scene-list').addEventListener('change', event => {
  if (event.target.dataset.referenceRole !== undefined) {
    const card = event.target.closest('.scene-card'), scene = state.project.scenes.find(item => item.id === card.dataset.sceneId);
    const reference = editableReferences(scene)[Number(event.target.dataset.referenceRole)];
    if (reference?.kind === 'image') { reference.role = event.target.value; mark('scenes'); refreshSceneGenerate(card, scene); canvas.render(); }
    return;
  }
  if (event.target.matches('[data-reference-picker],[data-reference-relink]')) {
    const scene = state.project.scenes.find(scene => scene.id === event.target.closest('.scene-card').dataset.sceneId);
    const references = referencesFor(scene), asset = activeAssets().find(asset => asset.id === event.target.value);
    if (!asset || !['image', 'video', 'audio'].includes(asset.kind) || references.some(reference => reference.assetId === asset.id)) return;
    const index = event.target.dataset.referenceRelink, reference = index === undefined ? null : references[Number(index)];
    if (index !== undefined && (!reference || reference.kind !== asset.kind)) return;
    if (!reference && references.length >= (state.settings.referencePreparationLimit || 10)) return toast('每个视频生成项最多准备 10 份参考素材。', true);
    changeReferences(() => {
      const items = editableReferences(scene);
      if (reference?.nodeId) {
        const node = state.project.graph.nodes.find(node => node.id === reference.nodeId);
        if (!node) throw new Error('来源素材卡片已移除。');
        node.assetId = asset.id; node.assetName = asset.name;
        for (const item of items) if (item.nodeId === node.id) delete item.publicUrl;
      } else if (reference) { items[Number(index)].assetId = asset.id; items[Number(index)].name = asset.name; delete items[Number(index)].publicUrl; }
      else items.push({ refId: uid(), assetId: asset.id, kind: asset.kind, name: asset.name, note: '' });
    });
    return;
  }
  const field = event.target.dataset.sceneField; if (!field || event.target.tagName !== 'SELECT') return;
  const scene = state.project.scenes.find(scene => scene.id === event.target.closest('.scene-card').dataset.sceneId);
  if (!scene || state.submitting.has(scene.id)) return;
  const model = modelForScene(field === 'videoModel' ? { videoModel: event.target.value } : scene);
  if (!updateVideoParameter(scene, field, event.target.value, model)) return;
  mark('scenes'); renderScenes(); canvas.render();
});
$('#scene-list').addEventListener('click', event => {
  const referenceButton = event.target.closest('[data-reference-action]');
  if (referenceButton) {
    if (referenceButton.disabled) return;
    const card = referenceButton.closest('.scene-card'), scene = state.project.scenes.find(scene => scene.id === card.dataset.sceneId);
    const references = referencesFor(scene), index = Number(referenceButton.dataset.referenceIndex), reference = references[index];
    if (!reference) return;
    const operation = referenceButton.dataset.referenceAction;
    if (operation === 'insert') { scenePromptEditor.insert(card.querySelector('[data-reference-prompt]'),reference); return; }
    changeReferences(() => {
      const items = editableReferences(scene);
      if (operation === 'remove' && reference.nodeId) {
        state.project.graph.links = withoutSceneReferenceLinks(state.project.graph, scene.id, reference.nodeId);
      } else if (operation === 'remove') items.splice(index,1);
      else {
        const other = index + (operation === 'up' ? -1 : 1);
        if (reference.nodeId || !items[other] || items[other].nodeId) return;
        [items[index],items[other]] = [items[other],items[index]];
      }
    });
    return;
  }
  const button = event.target.closest('[data-scene-action]'); if (!button || button.disabled) return;
  const id = button.closest('.scene-card').dataset.sceneId, index = state.project.scenes.findIndex(scene => scene.id === id);
  const scene = state.project.scenes[index], operation = button.dataset.sceneAction;
  if (operation === 'select-candidate') {
    const asset = state.project.assets.find(asset => asset.id === button.dataset.assetId
      && asset.kind === 'video' && asset.sceneId === id);
    if (!asset) return toast('这个候选视频尚未保存，请稍后刷新。', true);
    action(button, () => selectAsset(id, asset.id));
    return;
  }
  if (operation === 'place-asset') {
    const asset = state.project.assets.find(asset => asset.id === button.dataset.assetId
      && ['image', 'video'].includes(asset.kind));
    if (!asset) return toast('这个生成结果尚未保存，请稍后刷新。', true);
    action(button, () => placeAssetOnCanvas(asset.id));
    return;
  }
  if (operation === 'generate-image') { openImageDialog(id); return; }
  if (operation === 'generate') { action(button, () => generateScene(id)); return; }
  if (operation === 'remove') {
    state.project.scenes.splice(index, 1);
    const detached = new Set();
    for (const node of state.project.graph.nodes) if (node.sceneId === id) { node.sceneId = ''; detached.add(node.id); }
    state.project.graph.links = state.project.graph.links.filter(link => !link.reference || !detached.has(link.from) && !detached.has(link.to));
    if (detached.size) mark('graph');
  }
  else { const other = index + (operation === 'up' ? -1 : 1); [state.project.scenes[index], state.project.scenes[other]] = [state.project.scenes[other], scene]; }
  state.project.scenes.forEach((scene, index) => scene.order = index + 1); mark('scenes'); renderScenes(); renderCounts(); canvas.render();
});
const scenePromptEditor = createReferencePromptEditor({ container: $('#scene-list'),
  getReferences: control => {
    const scene = state.project?.scenes.find(scene => scene.id === control.closest('.scene-card')?.dataset.sceneId);
    return scene ? referencesFor(scene) : [];
  },
  onInsert: (control,reference,range) => {
    const card = control.closest('.scene-card'), scene = state.project?.scenes.find(scene => scene.id === card?.dataset.sceneId);
    if (!scene) return false;
    try {
      const inserted = insertReferenceMention(scene.videoPrompt || '',scene.promptMentions || [],range,reference,referencesFor(scene));
      scene.videoPrompt = inserted.prompt; scene.promptMentions = inserted.mentions; control.value = inserted.prompt;
      control.setSelectionRange(inserted.caret,inserted.caret); mark('scenes'); refreshSceneGenerate(card,scene); return true;
    } catch (error) { toast(error.message,true); return false; }
  }
});
$('#add-scene').onclick = () => {
  try { const scene = createScene(); renderScenes(); canvas.syncScenes({ sceneIds: [scene.id] }); canvas.render(); $('#scene-list .scene-card:last-child input').focus(); }
  catch (error) { toast(error.message, true); }
};
function renderJobs() {
  if (!state.project) return;
  const deleted = state.jobs.filter(job => job.deletedAt);
  if (!deleted.length) state.showDeletedJobs = false;
  const toggle = $('#toggle-deleted-jobs');
  toggle.hidden = !deleted.length;
  toggle.textContent = state.showDeletedJobs ? '返回任务列表' : `已删除记录 (${deleted.length})`;
  toggle.setAttribute('aria-pressed', String(state.showDeletedJobs));
  const hiddenActive = deleted.filter(job => blockingStates.has(job.state)).length;
  const note = $('#job-history-note');
  note.hidden = !state.showDeletedJobs && !hiddenActive;
  note.textContent = state.showDeletedJobs ? '删除只清理任务列表，可随时恢复。后台仍会查询进行中的任务，生成视频仍保存到素材库。'
    : `有 ${hiddenActive} 条待处理记录已删除，后台仍保留任务跟踪。可在“已删除记录”中恢复查看。`;
  const records = state.jobs.filter(job => state.showDeletedJobs ? job.deletedAt : !job.deletedAt);
  $('#job-list').innerHTML = records.length ? records.map(job => {
    const scene = state.project.scenes.find(scene => scene.id === job.sceneId);
    const retry = job.state !== 'done' && job.state !== 'submitting' && (job.providerTaskId || ['uncertain', 'download_pending'].includes(job.state));
    const rejectedParameters = job.state === 'failed' && !job.providerTaskId && job.message.includes('unsupported video field');
    const message = rejectedParameters ? `平台拒绝了旧版提交参数，未返回任务编号。请刷新页面后按默认规格测试纯文字视频。原始错误：${job.message}` : job.message;
    const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(job.createdAt)) / 60000));
    const timing = [blockingStates.has(job.state) && Number.isFinite(elapsed) ? `已等待 ${elapsed} 分钟` : '',
      job.providerStartedAt ? `平台开始：${new Date(job.providerStartedAt).toLocaleString('zh-CN')}` : '',
      job.lastCheckedAt ? `最近同步：${new Date(job.lastCheckedAt).toLocaleTimeString('zh-CN')}` : '',
      job.providerStatus ? `平台状态：${job.providerStatus}` : ''].filter(Boolean).join(' · ');
    return `<article class="job-row" data-job-id="${escapeHtml(job.id)}"><span class="job-mark ${escapeHtml(job.state)}"></span><div class="job-main"><strong>${escapeHtml(scene?.title || '已移除的视频生成项')} · ${escapeHtml(job.model)}</strong><p>${escapeHtml(message)}${job.providerTaskId ? `<br>平台任务编号：${escapeHtml(job.providerTaskId)}` : ''}</p><p>${escapeHtml(new Date(job.createdAt).toLocaleString('zh-CN'))} · ${job.duration} 秒 / ${escapeHtml(job.resolution)} · ${Number.isFinite(job.estimate) ? `提交时报价 ${escapeHtml(job.estimate)} 余额单位` : '费用以平台账单为准'}${job.requestMode ? job.referenceCount ? ` · ${escapeHtml(job.ratio || '工程比例')} · ${job.referenceCount} 份参考素材` : ' · 平台默认比例' : ''}</p>${timing ? `<p>${escapeHtml(timing)}${job.progress != null ? ' · 进度由平台报告' : ''}</p>` : ''}${job.deletedAt ? `<p>删除于 ${escapeHtml(new Date(job.deletedAt).toLocaleString('zh-CN'))}</p>` : ''}</div><span class="job-label">${escapeHtml(rejectedParameters ? '平台未受理' : jobLabels[job.state] || job.state)}${job.progress != null ? ` ${job.progress}%` : ''}</span><div class="job-actions">${job.state === 'done' && job.assetId ? `<a class="button" href="/api/assets/${encodeURIComponent(job.assetId)}?download=1" download>下载视频</a>` : ''}${retry ? `<button class="button" data-query-job="${escapeHtml(job.id)}">${job.state === 'download_pending' ? '重试下载' : job.providerTaskId ? '重新查询' : job.state === 'uncertain' ? '补填编号' : '重试下载'}</button>` : ''}${job.deletedAt ? `<button class="button" data-restore-job="${escapeHtml(job.id)}">恢复记录</button>` : `<button class="button delete-job" data-delete-job="${escapeHtml(job.id)}" title="移到已删除记录，保留视频和任务跟踪">删除记录</button>`}</div></article>`;
  }).join('') : '<div class="empty-state" style="padding:25px">暂无生成任务记录。提交后的进度和结果会显示在这里。</div>';
}
const imageJobLabels = { waiting: '排队中', preparing: '准备参考图', submitting: '生成中', uncertain: '需核对平台', download_pending: '待保存', saving: '保存中', done: '已完成', failed: '失败' };
function imageJobMatchesOperation(job, operationId) { return job.operationId === operationId || job.batchOperationId === operationId; }
function imageSubmissionJobs(result) {
  const jobs = Array.isArray(result?.jobs) ? result.jobs : [result];
  if (!jobs.length || jobs.some(job => !job || typeof job.id !== 'string' || !job.id)) throw new ApiError('图片任务返回不完整，请先刷新任务记录核对原请求。', 502);
  return jobs;
}
function adoptImageSubmission(jobs) {
  const ids = new Set(jobs.map(job => job.id));
  state.imageJobs = [...jobs, ...state.imageJobs.filter(job => !ids.has(job.id))];
}
function imageModelRecords() {
  const catalog = Array.isArray(state.imageCatalog) ? state.imageCatalog : [];
  const selected = state.settings.image?.imageModel || '';
  const records = catalog.length ? catalog : (selected ? [{ name: selected, description: '当前默认图片模型' }] : []);
  return records;
}
function renderImageModelOptions() {
  const records = imageModelRecords();
  const selected = state.settings.image?.imageModel || records[0]?.name || '';
  const html = records.length ? records.map(model => `<option value="${escapeHtml(model.name)}">${escapeHtml(model.name)}${model.description ? ` · ${escapeHtml(model.description)}` : ''}</option>`).join('') : '<option value="">请先读取图片模型目录</option>';
  for (const id of ['image-model', 'image-settings-model', 'image-page-model']) {
    const control = $(`#${id}`); if (!control) continue;
    const previous = id === 'image-settings-model' ? selected : control.value || selected;
    control.innerHTML = html;
    const preferred = records.some(model => model.name === previous) ? previous : selected;
    if ([...control.options].some(option => option.value === preferred)) control.value = preferred;
  }
}
function imagePageReferences() {
  return state.imageReferenceIds.map(id => {
    const asset = activeAssets().find(item => item.id === id && item.kind === 'image');
    return {assetId:asset?.id || '', kind:'image', name:asset?.name || '参考图片不可用', requestedAssetId:id};
  });
}
function imagePageIssue() {
  const references = imagePageReferences();
  if (references.some(reference => !reference.assetId)) return '已选参考图已被删除或不可用，请先移除或重新选择。';
  if (!references.length) return '';
  return imageRequestIssue({prompt:$('#image-page-prompt').value,model:$('#image-page-model').value},{references,textInputs:[]});
}
function renderImageReferences() {
  const picker = $('#image-page-reference-picker'), list = $('#image-page-references');
  if (!picker || !list) return;
  const images = activeAssets().filter(asset => asset.kind === 'image');
  const model = $('#image-page-model')?.value || state.settings.image?.imageModel;
  const limit = imageModelReferenceLimit(model) || state.settings.image?.referenceCountMax || IMAGE_REFERENCE_MAX;
  const available = images.filter(asset => !state.imageReferenceIds.includes(asset.id));
  picker.innerHTML = options([{value:'',label:available.length ? '选择已上传或已生成的图片…' : '没有可添加的图片，请先上传'},...available.map(asset=>({value:asset.id,label:(asset.source === 'model' ? '已生成 · ' : '已上传 · ') + asset.name}))],'');
  picker.disabled = state.imageReferenceIds.length >= limit || !available.length;
  list.innerHTML = state.imageReferenceIds.length ? imagePageReferences().map((reference,index) => `<div class="image-reference-card${reference.assetId ? '' : ' unavailable'}">${reference.assetId ? `<button type="button" class="image-reference-thumb" data-preview-asset="${escapeHtml(reference.assetId)}" aria-label="预览参考图片 ${index+1}"><img loading="lazy" src="/api/assets/${encodeURIComponent(reference.assetId)}" alt="${escapeHtml(reference.name)}"></button>` : '<div class="image-reference-thumb">图片不可用</div>'}<div class="image-reference-info"><strong>参考图片 ${index+1}</strong><span title="${escapeHtml(reference.name)}">${escapeHtml(reference.name)}</span></div><button type="button" class="button" data-remove-image-reference="${escapeHtml(reference.requestedAssetId)}" aria-label="移除参考图片 ${index+1}">×</button></div>`).join('') : '<p class="image-reference-empty">未选择参考图，将根据提示词生成图片。</p>';
  const issue = imagePageIssue(), note = $('#image-page-reference-note');
  if (note) { note.textContent = issue || (state.imageReferenceIds.length ? `已选择 ${state.imageReferenceIds.length} 张参考图，按添加顺序发送。选择图片和编辑提示词不会提交生成。` : '上传图片或选择已生成图片作为参考，继续创作新图。'); note.classList.toggle('error',Boolean(issue)); }
}
function addImagePageReference(assetId, switchToImages = false) {
  const asset = activeAssets().find(item => item.id === assetId && item.kind === 'image');
  if (!asset) throw new ApiError('请选择当前工程中可用的图片。',400);
  const model = $('#image-page-model')?.value || state.settings.image?.imageModel;
  const limit = imageModelReferenceLimit(model) || state.settings.image?.referenceCountMax || IMAGE_REFERENCE_MAX;
  if (!state.imageReferenceIds.includes(assetId)) {
    if (state.imageReferenceIds.length >= limit) throw new ApiError(`最多选择 ${limit} 张参考图片。`,400);
    state.imageReferenceIds.push(assetId);
  }
  if (switchToImages) setView('images'); else renderImageGeneration();
}
function renderImageGeneration() {
  renderImageModelOptions(); renderImageReferences();
  const note = $('#image-page-note'), ready = Boolean(state.settings.image?.hasKey);
  const count = Number($('#image-page-count')?.value || 1), issue = imagePageIssue();
  const modelName = $('#image-page-model')?.value || state.settings.image?.imageModel || '';
  const model = imageModelRecords().find(item => item.name === modelName);
  const quality = $('#image-page-quality')?.value || 'auto';
  const estimate = imageEstimate(model, { model: modelName, quality, count });
  const estimateLine = $('#image-page-cost');
  if (estimateLine) {
    estimateLine.textContent = imageEstimateText(estimate);
    estimateLine.classList.toggle('unavailable', estimate.totalMin == null);
    estimateLine.setAttribute('aria-label', estimateLine.textContent);
  }
  note.textContent = ready ? `本次生成 ${count} 张图片，每张单独提交并由平台计费。结果会保存到素材库和“生成结果”。` : '请先在左下角“生图连接”中保存 API Key，再选择图片模型。';
  note.classList.toggle('error', !ready);
  const submit = $('#image-page-form [type=submit]');
  if (submit) submit.disabled = !ready || !$('#image-page-model').value || Boolean(issue) || state.submitting.has('image-page-form');
}

function openImageDialog(sceneId = '', prompt = '') {
  if (!state.project) return toast('请先选择一个工程。', true);
  renderImageModelOptions();
  const scene = state.project.scenes.find(item => item.id === sceneId);
  $('#image-scene-id').value = sceneId;
  $('#image-prompt').value = prompt || scene?.imagePrompt || '';
  renderImageDialogCost();
  $('#image-message').textContent = '';
  $('#image-form-note').textContent = state.settings.image?.hasKey
    ? '提交后会产生平台费用。生成结果会自动保存到本工程素材库，不会加入视频候选任务。'
    : '请先在左下角“生图连接”中保存 API Key。';
  if (!state.settings.image?.hasKey) $('#image-form-note').classList.add('error'); else $('#image-form-note').classList.remove('error');
  $('#image-dialog').showModal();
  $('#image-prompt').focus();
}
function renderImageDialogCost() {
  const modelName = $('#image-model')?.value || state.settings.image?.imageModel || '';
  const model = imageModelRecords().find(item => item.name === modelName);
  const count = Number($('#image-count')?.value || 1);
  const quality = $('#image-quality')?.value || 'auto';
  const estimate = imageEstimate(model, { model: modelName, quality, count });
  const line = $('#image-form-cost');
  if (line) {
    line.textContent = imageEstimateText(estimate);
    line.classList.toggle('unavailable', estimate.totalMin == null);
    line.setAttribute('aria-label', line.textContent);
  }
}
function renderImageJobs() {
  if (!state.project) return;
  const deleted = state.imageJobs.filter(job => job.deletedAt);
  if (!deleted.length) state.showDeletedImageJobs = false;
  const toggle = $('#toggle-deleted-image-jobs');
  if (!toggle) return;
  toggle.hidden = !deleted.length;
  toggle.textContent = state.showDeletedImageJobs ? '返回生图任务' : `已删除记录 (${deleted.length})`;
  toggle.setAttribute('aria-pressed', String(state.showDeletedImageJobs));
  const hiddenActive = deleted.filter(job => !['done', 'failed'].includes(job.state)).length;
  const note = $('#image-job-history-note');
  note.hidden = !state.showDeletedImageJobs && !hiddenActive;
  note.textContent = state.showDeletedImageJobs ? '删除只隐藏生图任务记录，可随时恢复；本机素材和已完成图片仍保留。'
    : `有 ${hiddenActive} 条已隐藏的生图任务仍在处理；这里只保留任务跟踪，不会重复提交。`;
  const records = state.imageJobs.filter(job => state.showDeletedImageJobs ? job.deletedAt : !job.deletedAt);
  $('#image-job-list').innerHTML = records.length ? records.map(job => {
    const scene = state.project.scenes.find(item => item.id === job.sceneId);
    const node = state.project.graph.nodes.find(node => node.id === job.nodeId);
    const retry = job.state === 'download_pending';
    const preview = job.state === 'done' && job.assetId ? `<img class="image-job-preview" loading="lazy" src="/api/assets/${encodeURIComponent(job.assetId)}" alt="生成图片">` : '<span class="image-job-preview-placeholder">✦</span>';
    const actions = `${job.state === 'done' && job.assetId ? `<button class="button" data-preview-image-job="${escapeHtml(job.assetId)}">预览</button><a class="button" href="/api/assets/${encodeURIComponent(job.assetId)}?download=1" download>下载图片</a>` : ''}${retry ? `<button class="button" data-retry-image-job="${escapeHtml(job.id)}">重试保存</button>` : ''}${job.deletedAt ? `<button class="button" data-restore-image-job="${escapeHtml(job.id)}">恢复记录</button>` : `<button class="button delete-job" data-delete-image-job="${escapeHtml(job.id)}">删除记录</button>`}`;
    return `<article class="job-row image-job-row"><div class="image-job-thumb">${preview}</div><div class="job-main"><strong>${escapeHtml(node?.label || scene?.title || (job.nodeId ? '已移除的生图卡片' : '通用生图'))} · ${escapeHtml(job.model)}</strong><p class="image-job-prompt">${escapeHtml(job.prompt)}</p><p>${escapeHtml(new Date(job.createdAt).toLocaleString('zh-CN'))}${job.count > 1 ? ` · 候选 ${job.variantIndex || 1} / ${job.count}` : ''}${job.referenceAssetIds?.length ? ` · ${job.referenceAssetIds.length} 张参考图` : ''}${job.message ? ` · ${escapeHtml(job.message)}` : ''}</p>${job.deletedAt ? `<p>删除于 ${escapeHtml(new Date(job.deletedAt).toLocaleString('zh-CN'))}</p>` : ''}</div><span class="job-label">${escapeHtml(imageJobLabels[job.state] || job.state)}</span><div class="job-actions">${actions}</div></article>`;
  }).join('') : '<div class="empty-state" style="padding:25px">暂无图片任务。填写上方图片提示词并提交，或在创作画布添加“生图”卡片。</div>';
}
async function generateImageCard(nodeId) {
  if (!state.project) return;
  const projectId=state.project.id, key=projectId+':'+nodeId, busyKey='image:'+nodeId;
  if (state.submitting.has(busyKey)) return;
  state.submitting.add(busyKey);canvas.render();
  let started=false;
  try {
    // A lost HTTP response is recovered with the same operation identifier.
    const pendingOperation=state.imageOperations.get(key);
    if (pendingOperation) {
      await refreshImageJobs();
      if (projectId !== state.project?.id) return;
      if (state.imageJobs.some(job => imageJobMatchesOperation(job,pendingOperation))) {state.imageOperations.delete(key);toast('已找到原生图任务，继续跟踪其结果。');return;}
    }
    await flush();
    if (projectId !== state.project?.id) return;
    const node=state.project.graph.nodes.find(node => node.id===nodeId);
    if (!isImageGenerationNode(node)) throw new Error('生图卡片已移除。');
    const config=normalizeImageConfig(node.imageConfig), issue=imageRequestIssue(config,resolveImageInputs(state.project,node));
    if (issue) throw new Error(issue);
    const operationId=pendingOperation || uid();state.imageOperations.set(key,operationId);started=true;
    const result=await api(`/api/projects/${projectId}/image-jobs`,'POST',{nodeId,expectedConfig:config,count:config.count,operationId});
    const jobs=imageSubmissionJobs(result);
    state.imageOperations.delete(key);
    if (projectId !== state.project?.id) return;
    adoptImageSubmission(jobs);
    adoptRemote(await api(`/api/projects/${projectId}`));
    renderImageJobs();toast(`已提交本卡 ${jobs.length} 张图片的生成任务，结果会保存到素材库和生成结果。`);
  } catch(error) {
    if (started && (!error.status || error.status>=500)) toast('提交确认暂未收到，请刷新任务状态；再次点击会先核对原任务，避免重复提交。',true);
    else {if (started) state.imageOperations.delete(key);toast(error.message,true);}
  } finally {state.submitting.delete(busyKey);canvas.render();}
}
async function retryImageCard(nodeId) {
  const node=state.project?.graph.nodes.find(node => node.id===nodeId);
  const job=state.imageJobs.find(job => job.id===node?.imageJobId);
  if (!job) throw new Error('未找到可重试保存的生图任务，请刷新任务状态。');
  await api(`/api/image-jobs/${job.id}/retry`,'POST',{});await refreshImageJobs();
  toast('正在重试保存图片，不会重新提交生图。');
}
async function refreshImageJobs() {
  if (!state.project) return;
  const id = state.project.id;
  const jobs = await api(`/api/projects/${id}/image-jobs?includeDeleted=1`);
  if (id !== state.project?.id) return;
  const changed = !same(jobs.map(job => [job.id, job.state, job.deletedAt, job.assetId, job.message]), state.imageJobs.map(job => [job.id, job.state, job.deletedAt, job.assetId, job.message]));
  state.imageJobs = jobs;
  for (const [key,operationId] of state.imageOperations) if (key.startsWith(id+':') && jobs.some(job => imageJobMatchesOperation(job,operationId))) state.imageOperations.delete(key);
  renderImageJobs(); renderCounts();
  if (changed) {
    const remote = await api(`/api/projects/${id}`);
    if (id !== state.project?.id) return;
    adoptRemote(remote);
    renderCounts();
    if (state.view === 'assets') renderAssets();
    if (state.view === 'videos' && !$('#scene-list').contains(document.activeElement) && !sceneVideoPlaying()) renderScenes();
    if (state.view === 'results' && !sceneVideoPlaying()) renderResults();
    if (!canvas.busy() && !sceneVideoPlaying()) canvas.render();
  }
}
$('#toggle-deleted-image-jobs').onclick = () => { state.showDeletedImageJobs = !state.showDeletedImageJobs; renderImageJobs(); };
$('#refresh-image-jobs').onclick = () => action($('#refresh-image-jobs'), refreshImageJobs);
$('#image-job-list').addEventListener('click', event => {
  const preview = event.target.closest('[data-preview-image-job]');
  if (preview) {
    const asset = activeAssets().find(item => item.id === preview.dataset.previewImageJob);
    if (asset) previewAsset(asset); else toast('图片素材已移除，请在素材库中恢复后预览。', true);
    return;
  }
  const deleting = event.target.closest('[data-delete-image-job]');
  const restoring = event.target.closest('[data-restore-image-job]');
  if (deleting || restoring) {
    const button = deleting || restoring, id = deleting?.dataset.deleteImageJob || restoring?.dataset.restoreImageJob;
    action(button, async () => { await api(`/api/image-jobs/${id}${deleting ? '' : '/restore'}`, deleting ? 'DELETE' : 'POST', deleting ? undefined : {}); await refreshImageJobs(); toast(deleting ? '生图记录已移到已删除记录，可恢复。' : '生图记录已恢复。'); });
    return;
  }
  const retry = event.target.closest('[data-retry-image-job]');
  if (retry) action(retry, async () => { await api(`/api/image-jobs/${retry.dataset.retryImageJob}/retry`, 'POST', {}); await refreshImageJobs(); toast('正在重试保存图片，不会重新提交生图。'); });
});
$('#toggle-deleted-jobs').onclick = () => { state.showDeletedJobs = !state.showDeletedJobs; renderJobs(); };
$('#job-list').addEventListener('click', event => {
  const recordButton = event.target.closest('[data-delete-job],[data-restore-job]');
  if (recordButton) {
    const deleting = Boolean(recordButton.dataset.deleteJob);
    const id = recordButton.dataset.deleteJob || recordButton.dataset.restoreJob;
    action(recordButton, async () => {
      const job = await api(`/api/jobs/${id}${deleting ? '' : '/restore'}`, deleting ? 'DELETE' : 'POST', deleting ? undefined : {});
      await refreshJobs(); await refreshImageJobs();
      if (!deleting && state.project?.id === job.projectId) { state.showDeletedJobs = false; renderJobs(); }
      toast(deleting ? '记录已移到“已删除记录”，可恢复；视频和任务跟踪保留。' : '任务记录已恢复。');
    });
    return;
  }
  const button = event.target.closest('[data-query-job]'); if (!button) return;
  const job = state.jobs.find(job => job.id === button.dataset.queryJob);
  let taskId = '';
  if (!job.providerTaskId && job.state === 'uncertain') {
    taskId = window.prompt('先打开平台任务记录。若找到这次提交，请粘贴其任务编号。这里只查询结果，不重新生成。')?.trim();
    if (!taskId) return;
  }
  action(button, async () => { await api(`/api/jobs/${job.id}/query`, 'POST', { taskId }); await refreshJobs(); toast(job.state === 'download_pending' ? '正在下载已生成的视频。' : '正在查询已有任务。'); });
});
async function refreshJobs() {
  if (!state.project) return;
  const id = state.project.id, jobs = await api(`/api/projects/${id}/jobs?includeDeleted=1`);
  if (id !== state.project?.id) return;
  const snapshot = job => [job.id, job.state, job.deletedAt, job.assetId, job.message, job.progress];
  const changed = !same(jobs.map(snapshot), state.jobs.map(snapshot));
  state.jobs = jobs; renderJobs();
  if (changed) {
    const remote = await api(`/api/projects/${id}`);
    if (id !== state.project?.id) return;
    adoptRemote(remote);
    if (state.view === 'assets') renderAssets();
    if (state.view === 'videos' && !$('#scene-list').contains(document.activeElement) && !sceneVideoPlaying()) renderScenes();
    if (state.view === 'results' && !sceneVideoPlaying()) { renderResults(); }
    if (!canvas.busy() && !sceneVideoPlaying()) canvas.render();
  }
}
function sceneVideoPlaying() { return $$('#scene-list video, #canvas-view video, #canvas-view audio, #result-list video, #export-list video, #preview-content video, #preview-content audio, #result-details-content video').some(media => !media.paused && !media.ended); }
$('#refresh-jobs').onclick = () => action($('#refresh-jobs'), refreshJobs);

const sizeLabel = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
function renderAssets() {
  if (!state.project) return;
  const deleted = state.project.assets.filter(asset => asset.deletedAt);
  const assets = [...(state.showDeletedAssets ? deleted : activeAssets())].reverse();
  const toggle = $('#toggle-deleted-assets');
  toggle.textContent = state.showDeletedAssets ? '返回素材库' : `已删除素材${deleted.length ? '（' + deleted.length + '）' : ''}`;
  toggle.setAttribute('aria-pressed', String(state.showDeletedAssets));
  $('#asset-history-note').hidden = !state.showDeletedAssets;
  $('#asset-history-note').textContent = '这里的素材已从库中移除，原文件仍保留。恢复后可重新选择或关联；已断开的视频生成项和画布引用不会自动恢复。';
  $('#asset-list').innerHTML = assets.length ? assets.map(asset => `<article class="asset-card" data-asset-id="${escapeHtml(asset.id)}"><button class="asset-thumb ${asset.kind}" data-preview-asset="${escapeHtml(asset.id)}" aria-label="预览 ${escapeHtml(asset.name)}">${asset.kind === 'image' ? `<img loading="lazy" src="/api/assets/${encodeURIComponent(asset.id)}" alt="${escapeHtml(asset.name)}">` : asset.kind === 'video' ? `<video muted preload="metadata" src="/api/assets/${encodeURIComponent(asset.id)}"></video>` : '♫'}</button><div class="asset-details"><h3 title="${escapeHtml(asset.name)}">${escapeHtml(asset.name)}</h3><p>${{ image: '参考图片', video: '视频片段', audio: '声音素材' }[asset.kind]} · ${sizeLabel(asset.size)} · ${asset.source === 'model' ? '模型生成' : '本机上传'}</p>${asset.deletedAt ? `<p>删除于 ${escapeHtml(new Date(asset.deletedAt).toLocaleString('zh-CN'))}</p>` : ''}<div class="asset-actions"><a class="button" download href="/api/assets/${encodeURIComponent(asset.id)}?download">下载原文件 ↧</a>${asset.deletedAt ? `<button class="button" type="button" data-restore-asset="${escapeHtml(asset.id)}">恢复素材</button>` : `${asset.kind === 'image' ? `<button class="button" type="button" data-use-image-reference="${escapeHtml(asset.id)}">以此图生成</button>` : ''}<button class="button" type="button" data-add-to-canvas="${escapeHtml(asset.id)}">${['image', 'video'].includes(asset.kind) ? '作为参考放到画布' : '放到画布'}</button><button class="button delete-asset" type="button" data-delete-asset="${escapeHtml(asset.id)}" title="移到已删除素材，可恢复">删除素材</button>`}</div></div></article>`).join('') : state.showDeletedAssets
    ? '<div class="empty-state" style="grid-column:1/-1"><strong>没有已删除的素材。</strong>删除的素材会出现在这里，可以随时恢复。</div>'
    : '<div class="empty-state" style="grid-column:1/-1"><strong>素材，都放在这里。</strong>上传 PNG、JPG、WebP 参考图，MP4 视频，或 MP3、WAV 音乐。</div>';
}
$('#toggle-deleted-assets').onclick = () => { state.showDeletedAssets = !state.showDeletedAssets; renderAssets(); };
function previewAsset(asset) {
  if (!asset || !['image', 'video', 'audio'].includes(asset.kind)) throw new Error('请选择可预览的素材。');
  $('#preview-title').textContent = asset.name;
  const media = document.createElement({ image: 'img', video: 'video', audio: 'audio' }[asset.kind]);
  media.src = '/api/assets/' + encodeURIComponent(asset.id);
  if (asset.kind === 'image') media.alt = asset.name; else media.controls = true;
  $('#preview-content').replaceChildren(media); $('#preview-dialog').showModal();
}
function closeResultDetails() {
  resultDetailsSelection = null;
  $('#result-details-content').replaceChildren();
  $('#result-details-title').textContent = '';
  if ($('#result-details-dialog').open) $('#result-details-dialog').close();
}
function syncResultDetails() {
  if (!resultDetailsSelection) return false;
  if (state.project?.id !== resultDetailsSelection.projectId || !generatedAssets().some(asset => asset.id === resultDetailsSelection.assetId)) {
    closeResultDetails(); return false;
  }
  return true;
}
function showResultDetails(asset) {
  asset = generatedAssets().find(item => item.id === asset?.id);
  if (!asset) { toast('这个生成结果已移除，请在素材库中恢复后查看。', true); return; }
  const kind = asset.kind === 'image' ? '图片' : '视频';
  const job = (asset.kind === 'image' ? state.imageJobs : state.jobs).find(item => item.assetId === asset.id);
  const source = '/api/assets/' + encodeURIComponent(asset.id);
  const date = Number.isFinite(Date.parse(asset.createdAt)) ? new Date(asset.createdAt).toLocaleString('zh-CN', { hour12: false }) : '';
  const metadata = [['类型', kind], ['模型', job?.model], ['生成时间', date], ['文件大小', Number.isFinite(asset.size) ? sizeLabel(asset.size) : '']].filter(([, value]) => value);
  const media = asset.kind === 'image'
    ? `<img src="${source}" alt="${escapeHtml(asset.name)}">`
    : `<video controls playsinline preload="metadata" src="${source}" aria-label="${escapeHtml(asset.name)}"></video>`;
  $('#result-details-title').textContent = asset.name;
  $('#result-details-content').innerHTML = `<div class="result-details-preview">${media}</div><dl class="result-details-meta">${metadata.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>${job?.prompt ? `<details class="result-details-prompt"><summary>提示词</summary><p>${escapeHtml(job.prompt)}</p></details>` : ''}<div class="result-details-actions"><a class="button" href="${source}?download=1" download>下载${kind}</a><button class="button" type="button" data-add-to-canvas="${escapeHtml(asset.id)}">放到画布</button><button class="button project-danger" type="button" data-delete-asset="${escapeHtml(asset.id)}">删除</button></div>`;
  resultDetailsSelection = { projectId: state.project.id, assetId: asset.id };
  if (!$('#result-details-dialog').open) $('#result-details-dialog').showModal();
}
function handleAssetClick(event) {
  const detailsButton = event.target.closest('[data-result-details]');
  if (detailsButton) { showResultDetails({ id: detailsButton.dataset.resultDetails }); return; }
  const reuseButton = event.target.closest('[data-use-image-reference]');
  if (reuseButton) { try { addImagePageReference(reuseButton.dataset.useImageReference, true); toast('图片已加入参考，填写提示词后可生成新图。'); } catch (error) { toast(error.message, true); } return; }
  const recordButton = event.target.closest('[data-delete-asset],[data-restore-asset]');
  if (recordButton) {
    const deleting = Boolean(recordButton.dataset.deleteAsset);
    const id = recordButton.dataset.deleteAsset || recordButton.dataset.restoreAsset;
    const asset = state.project.assets.find(item => item.id === id), projectId = state.project.id;
    if (!asset) return;
    if (deleting && !window.confirm(`删除“${asset.name}”？\n\n素材会移到“已删除素材”，相关视频选用和画布引用会断开。原文件、任务记录和已提交的平台任务会保留。\n\n可以恢复素材，恢复后需重新选择或关联。`)) return;
    action(recordButton, async () => {
      canvas.finishEditing(); await flush();
      const project = await api(`/api/projects/${projectId}/assets/${id}${deleting ? '' : '/restore'}`, deleting ? 'DELETE' : 'POST', deleting ? undefined : {});
      if (projectId === state.project?.id) {
        const editedDuringRequest = state.dirty.has('graph') || state.dirty.has('scenes');
        adoptRemote(project);
        if (deleting && editedDuringRequest) changeReferences(() => detachAssetReferences(state.project, id));
        if (!deleting) state.showDeletedAssets = false;
        canvas.reset(); renderAssets(); renderResults(); renderImageReferences(); canvas.render();
        if (state.view === 'videos') renderScenes();
      }
      toast(deleting ? '素材已移到“已删除素材”，可恢复。' : '素材已恢复，可重新选择或放到画布。');
    });
    return;
  }
  const canvasButton = event.target.closest('[data-add-to-canvas]');
  if (canvasButton) {
    const asset = activeAssets().find(item => item.id === canvasButton.dataset.addToCanvas);
    if (!asset) return;
    try { placeAssetOnCanvas(asset.id); }
    catch (error) { toast(error.message, true); }
    return;
  }
  const button = event.target.closest('[data-preview-asset]'); if (!button) return;
  const asset = state.project.assets.find(item => item.id === button.dataset.previewAsset);
  if (asset) previewAsset(asset);
}
$('#asset-list').addEventListener('click', handleAssetClick);
$('#result-list').addEventListener('click', handleAssetClick);
$('#result-details-content').addEventListener('click', event => {
  if (!syncResultDetails()) { event.preventDefault(); return; }
  handleAssetClick(event);
});
$('#close-result-details').onclick = closeResultDetails;
$('#result-details-dialog').addEventListener('close', () => {
  if (!$('#result-details-dialog').open) closeResultDetails();
});
$('#result-filter').onchange = () => renderResults();
$('#result-sort')?.addEventListener('change', () => renderResults());
$('#close-preview').onclick = () => $('#preview-dialog').close();
$('#preview-dialog').addEventListener('close', () => $('#preview-content').replaceChildren());
async function uploadFiles(files) {
  await flush(); const projectId = state.project.id, uploaded = [];
  for (const file of [...files]) {
    toast('正在上传：' + file.name);
    const response = await fetch('/api/projects/' + projectId + '/assets', { method: 'POST', headers: {
      'X-Studio-Token': state.token, 'X-File-Name': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream',
    }, body: file });
    const data = await response.json(); if (!response.ok) throw new ApiError(data.error || '上传失败。', response.status);
    uploaded.push(data.asset); if (projectId === state.project?.id) state.showDeletedAssets = false; adoptRemote(data.project); renderAssets(); renderCounts(); canvas.render();
    if (projectId !== state.project?.id) throw new Error('素材已上传到原工程，请返回该工程后继续。');
  }
  toast('已上传 ' + uploaded.length + ' 个素材。');
  return uploaded;
}
$('#upload-assets').onclick = () => $('#asset-input').click();
$('#asset-input').onchange = () => action($('#upload-assets'), async () => {
  try { await uploadFiles($('#asset-input').files); }
  finally { $('#asset-input').value = ''; }
});

function renderResults() {
  syncResultDetails();
  if (!state.project) return;
  const filter = $('#result-filter').value || 'all', sort = $('#result-sort')?.value || 'newest';
  const timestamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
  const assets = generatedAssets().filter(asset => filter === 'all' || asset.kind === filter).slice().sort((a,b) => {
    const order = timestamp(a.createdAt) - timestamp(b.createdAt);
    return (sort === 'oldest' ? order : -order) || String(a.id).localeCompare(String(b.id));
  });
  $('#result-list').innerHTML = assets.length ? assets.map(asset => {
    const source = '/api/assets/' + encodeURIComponent(asset.id);
    const thumbnail = asset.kind === 'image' ? `<img loading="lazy" src="${source}" alt="${escapeHtml(asset.name)}">` : `<video muted playsinline preload="metadata" src="${source}#t=0.1" aria-label="${escapeHtml(asset.name)}视频缩略图"></video><span class="result-play" aria-hidden="true">▶</span>`;
    return `<article class="result-card" data-asset-id="${escapeHtml(asset.id)}"><button class="result-preview ${asset.kind}" type="button" data-preview-asset="${escapeHtml(asset.id)}" aria-label="预览 ${escapeHtml(asset.name)}"><span class="result-thumbnail-placeholder" aria-hidden="true">${asset.kind === 'image' ? '图片' : '视频'}缩略图加载中</span>${thumbnail}<span class="result-kind">${asset.kind === 'image' ? '图片' : '视频'}</span></button><div class="result-body"><h3 class="result-title" title="${escapeHtml(asset.name)}">${escapeHtml(asset.name)}</h3><button class="button result-details-button" type="button" data-result-details="${escapeHtml(asset.id)}" aria-label="查看 ${escapeHtml(asset.name)} 的详情">详情</button></div></article>`;
  }).join('') : '<div class="empty-state" style="grid-column:1/-1"><strong>还没有' + (filter === 'image' ? '图片' : filter === 'video' ? '视频' : '生成') + '结果。</strong>已保存成功的图片和视频会显示在这里，可预览、下载或放到画布继续创作。生成中的任务请在对应生成页查看。</div>';
  for (const media of $$('#result-list .result-preview img, #result-list .result-preview video')) {
    const preview = media.closest('.result-preview');
    const ready = () => preview.classList.add('thumbnail-ready');
    const failed = () => { preview.classList.add('thumbnail-error'); const placeholder = preview.querySelector('.result-thumbnail-placeholder'); if (placeholder) placeholder.textContent = '缩略图暂不可用 · 点击预览'; };
    media.addEventListener('error', failed, {once:true});
    if (media.tagName === 'IMG') { media.addEventListener('load', ready, {once:true}); if (media.complete && media.naturalWidth) ready(); }
    else { media.addEventListener('loadeddata', ready, {once:true}); if (media.readyState >= 2) ready(); }
  }
}

function renderSettingsStatus() {
  $('#connection-button').classList.toggle('connected', Boolean(state.settings.hasKey));
  const image = state.settings.image || {};
  $('#image-connection-button')?.classList.toggle('connected', Boolean(image.hasKey));
  const imageDot = $('#image-connection-dot'); if (imageDot) imageDot.title = image.hasKey ? '生图令牌已保存' : '尚未配置生图令牌';
  const text = state.settings.text || {};
  $('#text-connection-button')?.classList.toggle('connected', Boolean(text.hasKey));
  const textDot = $('#text-connection-dot'); if (textDot) textDot.title = text.hasKey ? '语言模型令牌已保存' : '尚未配置语言模型令牌';
  const storage = state.settings.storage || {};
  $('#storage-button')?.classList.toggle('connected', Boolean(storage.ready));
  const dot = $('#storage-dot'); if (dot) dot.title = storage.ready ? '自动上传已就绪' : '尚未配置自动上传';
}
function renderStorageSettings() {
  const storage = state.settings.storage || {};
  $('#storage-provider').value = storage.provider || 'cos';
  $('#storage-endpoint').value = storage.endpoint || '';
  updateStorageProvider();
  $('#storage-bucket').value = storage.bucket || '';
  $('#storage-region').value = storage.region || 'ap-guangzhou';
  $('#storage-prefix').value = storage.prefix || 'jingce';
  $('#storage-expires').value = String(storage.expiresHours || 72);
  $('#storage-enabled').checked = Boolean(storage.enabled);
  $('#storage-key-state').textContent = storage.hasCredentials ? '已保存云存储密钥，留空可保留。密钥仅保存在服务器。' : '尚未保存云存储密钥。';
  $('#storage-message').textContent = storage.message || '';
  $('#storage-message').classList.toggle('error', Boolean(storage.enabled && !storage.ready));
}
function updateStorageProvider() {
  const r2 = $('#storage-provider').value === 'r2';
  $('#storage-endpoint-label').hidden = !r2;
  $('#storage-endpoint').required = r2;
  $('#storage-region-label').hidden = r2;
  $('#storage-region').required = !r2;
}
$('#storage-provider').onchange = updateStorageProvider;
$('#storage-button').onclick = () => { renderStorageSettings(); $('#storage-dialog').showModal(); };
$('#close-storage').onclick = () => $('#storage-dialog').close();
$('#storage-form').onsubmit = event => { event.preventDefault(); action($('#storage-form [type=submit]'), async () => {
  const form = $('#storage-form');
  state.settings.storage = await api('/api/storage/settings', 'PUT', { provider: form.elements.provider.value, endpoint: form.elements.endpoint.value, bucket: form.elements.bucket.value, region: form.elements.provider.value === 'r2' ? 'auto' : form.elements.region.value,
    prefix: form.elements.prefix.value, expiresHours: Number(form.elements.expires.value), enabled: form.elements.enabled.checked,
    secretId: form.elements.secretId.value, secretKey: form.elements.secretKey.value });
  form.elements.secretId.value = ''; form.elements.secretKey.value = ''; renderSettingsStatus(); renderStorageSettings(); renderScenes(); canvas.render();
  toast(state.settings.storage.ready ? '素材云存储已就绪，生成时会自动上传选中的参考。' : '素材云存储设置已保存，请补齐密钥后再启用。');
}); };
$('#storage-test').onclick = () => action($('#storage-test'), async () => {
  const form = $('#storage-form');
  {
    state.settings.storage = await api('/api/storage/settings', 'PUT', { provider: form.elements.provider.value, endpoint: form.elements.endpoint.value, bucket: form.elements.bucket.value, region: form.elements.provider.value === 'r2' ? 'auto' : form.elements.region.value,
      prefix: form.elements.prefix.value, expiresHours: Number(form.elements.expires.value), enabled: true,
      secretId: form.elements.secretId.value, secretKey: form.elements.secretKey.value });
    form.elements.secretId.value = ''; form.elements.secretKey.value = '';
  }
  const result = await api('/api/storage/test', 'POST', {}); renderSettingsStatus(); renderStorageSettings(); $('#storage-message').classList.remove('error'); $('#storage-message').textContent = result.message;
});

function renderSettings() {
  $('#key-state').textContent = state.settings.hasKey ? '已保存密钥。此处不回显，留空可保留原密钥。' : '尚未保存 API Key。请在平台官网创建令牌后在此填写。';
  $('#settings-form [name=apiKey]').value = ''; $('#connection-message').textContent = state.catalogError || state.settings.message || '';
  $('#connection-message').classList.toggle('error', Boolean(state.catalogError));
  const catalogNote = $('#model-catalog-note');
  if (catalogNote) catalogNote.textContent = state.catalog.length
    ? `已读取 ${state.catalog.length} 个视频模型。请到“视频生成”或画布视频卡片详情中，为每个视频生成项选择模型、画面比例、时长和画质。`
    : '模型目录尚未读取。保存连接后，点击“刷新模型目录”，再到视频生成项中选择模型和画质。';
}
function renderImageSettings() {
  const image = state.settings.image || {};
  $('#image-key-state').textContent = image.hasKey
    ? '已保存生图令牌。此处不回显，留空可保留原令牌。'
    : '尚未保存生图 API Key。请在 sub.beibeihai.xyz 创建令牌后在此填写。';
  $('#image-settings-form [name=apiKey]').value = '';
  renderImageModelOptions();
  const message = $('#image-connection-message');
  message.textContent = state.imageCatalogError || '';
  message.classList.toggle('error', Boolean(state.imageCatalogError));
  const note = $('#image-model-catalog-note');
  if (note) note.textContent = state.imageCatalog.length
    ? `已读取 ${state.imageCatalog.length} 个图片模型。提交生图会产生平台费用，结果保存后才会进入本机素材库。`
    : '图片模型目录尚未读取；当前可使用已核对的默认模型，建议先刷新目录。';
}
function textModelRecords() {
  const catalog = Array.isArray(state.textCatalog) ? state.textCatalog : [];
  const selected = state.settings.text?.textModel || '';
  return catalog.length ? catalog : (selected ? [{ name: selected, owner: '当前配置' }] : []);
}
function renderTextModelOptions() {
  const records = textModelRecords();
  const selected = state.settings.text?.textModel || records[0]?.name || '';
  const html = records.length
    ? records.map(model => `<option value="${escapeHtml(model.name)}">${escapeHtml(model.name)}${model.owner ? ` · ${escapeHtml(model.owner)}` : ''}</option>`).join('')
    : '<option value="">请先读取语言模型目录</option>';
  for (const id of ['text-settings-model', 'text-chat-model']) {
    const control = $(`#${id}`); if (!control) continue;
    const previous = id === 'text-settings-model' ? selected : control.value || selected;
    control.innerHTML = html;
    const preferred = records.some(model => model.name === previous) ? previous : selected;
    if ([...control.options].some(option => option.value === preferred)) control.value = preferred;
  }
}
function renderTextSettings() {
  const text = state.settings.text || {};
  $('#text-key-state').textContent = text.hasKey
    ? '已保存语言模型 API Key。此处不回显，留空可保留原密钥。'
    : '尚未保存语言模型 API Key。请先在平台创建文本模型令牌。';
  $('#text-settings-form [name=apiKey]').value = '';
  renderTextModelOptions();
  const message = $('#text-connection-message');
  message.textContent = state.textCatalogError || '';
  message.classList.toggle('error', Boolean(state.textCatalogError));
  const note = $('#text-model-catalog-note');
  if (note) note.textContent = state.textCatalog.length
    ? `已读取 ${state.textCatalog.length} 个可用模型。模型能力和输出限制以当前密钥实际响应为准。`
    : '语言模型目录尚未读取；保存 API Key 后点击“刷新语言模型”。';
}
function textContextText() {
  const project = state.project;
  const brief = project?.brief || {};
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  const lines = [
    `工程名称：${project?.title || '未命名工程'}`,
    `视频主题 / 主体：${brief.product || '未填写'}`,
    `视频类型：${brief.type || '未填写'}`,
    `画面比例：${brief.ratio || '未填写'}`,
    `故事内容 / 画面要点：${brief.benefits || '未填写'}`,
    `画面风格：${brief.tone || '未填写'}`,
    `目标时长：${brief.duration || '未填写'} 秒`,
    `面向观众：${brief.audience || '未填写'}`,
    `结尾内容：${brief.cta || '未填写'}`,
  ];
  if (scenes.length) lines.push(`当前已有视频生成项：${scenes.length} 个`);
  return lines.join('\n');
}
function textContextPrompt() {
  return `请基于下面这份镜策工程需求，帮助我继续创作。请先指出需求中最需要补充的信息，再给出可以直接执行的建议。\n\n${textContextText()}`;
}
function renderTextChat() {
  const messages = $('#text-chat-messages');
  if (!messages) return;
  clearTextSelectionActions();
  renderTextModelOptions();
  messages.innerHTML = state.textMessages.length
    ? state.textMessages.map(message => `<article class="text-chat-message ${message.role}"><div class="text-chat-message-label">${message.role === 'assistant' ? '语言模型' : '我'}</div><div class="text-chat-message-content${message.role === 'assistant' ? ' text-markdown' : ''}">${message.role === 'assistant' ? renderTextMarkdown(message.content) : escapeHtml(message.content).replace(/\n/g, '<br>')}</div></article>`).join('')
    : '<div class="text-chat-empty"><strong>从一句创作问题开始。</strong><p>例如：把当前故事拆成 5 个镜头，分别写出人物、动作、运镜和光线。</p></div>';
  messages.scrollTop = messages.scrollHeight;
  const model = $('#text-chat-model')?.value || '';
  const ready = Boolean(state.settings.text?.hasKey && model);
  const status = $('#text-chat-status');
  if (status) status.textContent = state.textBusy ? '正在等待模型回复…' : model ? `当前模型：${model}` : '尚未选择模型';
  const note = $('#text-chat-note');
  if (note) {
    note.textContent = state.textError || (ready
      ? '对话会保存在当前浏览器的本机存储中；发送前可以继续编辑消息。'
      : '先在左侧“语言模型”中保存 API Key，并刷新模型目录。');
    note.classList.toggle('error', Boolean(state.textError));
  }
  const submit = $('#text-chat-form [type=submit]');
  if (submit) submit.disabled = state.textBusy || !ready;
  const context = $('#text-context-summary');
  if (context) context.textContent = state.project ? `当前工程“${state.project.title}”包含 ${state.project.scenes?.length || 0} 个视频生成项。点击下方按钮可把完整创作需求填入对话。` : '请先选择一个工程。';
  const useContext = $('#text-use-context');
  if (useContext) useContext.disabled = !state.project || state.textBusy;
}
function clearTextSelectionActions() {
  selectedChatText = '';
  const actions = $('#text-selection-actions');
  if (actions) actions.hidden = true;
}
function updateTextSelectionActions() {
  const actions = $('#text-selection-actions'), selection = document.getSelection?.();
  if (!actions || !selection || selection.isCollapsed || !selection.rangeCount) return clearTextSelectionActions();
  const contentFor = node => {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    const content = element?.closest?.('.text-chat-message-content');
    return content?.closest?.('.text-chat-message.assistant') ? content : null;
  };
  const content = contentFor(selection.anchorNode);
  if (!content || content !== contentFor(selection.focusNode)) return clearTextSelectionActions();
  const value = selection.toString().trim();
  if (!value) return clearTextSelectionActions();
  selectedChatText = value;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  const width = actions.offsetWidth || 190, height = actions.offsetHeight || 42;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left));
  const top = rect.top >= height + 12 ? rect.top - height - 8 : Math.min(window.innerHeight - height - 8, rect.bottom + 8);
  actions.style.left = left + 'px'; actions.style.top = Math.max(8, top) + 'px';
  actions.hidden = false;
}
document.addEventListener('selectionchange', updateTextSelectionActions);
$('#text-chat-messages')?.addEventListener('scroll', clearTextSelectionActions);
window.addEventListener('resize', clearTextSelectionActions);
function createSelectionDraft(kind) {
  const prompt = selectedChatText.trim();
  if (!prompt || !state.project) return;
  const bounded = prompt.slice(0, 4000);
  if (state.view !== 'canvas') setView('canvas');
  const created = kind === 'image' ? canvas.addPromptImage?.(bounded) : canvas.addPromptVideo?.(bounded);
  if (!created) return;
  clearTextSelectionActions();
  document.getSelection?.()?.removeAllRanges?.();
  toast(prompt.length > 4000 ? '已创建草稿卡；所选内容超过 4000 字，提示词已截取到卡片上限。' : '已创建可编辑草稿卡，请检查提示词后再决定是否生成。');
}
$('#text-selection-actions')?.addEventListener('pointerdown', event => {
  if (event.pointerType === 'mouse' && event.target.closest('[data-selection-draft]')) event.preventDefault();
});
$('#text-selection-actions')?.addEventListener('click', event => {
  const button = event.target.closest('[data-selection-draft]');
  if (button && !button.disabled) createSelectionDraft(button.dataset.selectionDraft);
});
async function sendTextChat() {
  const input = $('#text-chat-input');
  const content = input.value.trim();
  const model = $('#text-chat-model')?.value || '';
  if (!state.settings.text?.hasKey) throw new ApiError('请先在“语言模型”中保存 API Key。', 400);
  if (!model) throw new ApiError('请先刷新语言模型目录并选择模型。', 400);
  if (!content) throw new ApiError('请输入要发送给语言模型的内容。', 400);
  state.textError = '';
  state.textMessages.push({ role: 'user', content });
  input.value = '';
  saveTextHistory();
  state.textBusy = true;
  renderTextChat();
  try {
    const result = await api('/api/text-chat', 'POST', { model, messages: state.textMessages });
    state.textMessages.push({ role: 'assistant', content: result.content });
    saveTextHistory();
  } catch (error) {
    state.textError = error.message;
    throw error;
  } finally {
    state.textBusy = false;
    renderTextChat();
  }
}

$('#text-connection-button').onclick = () => { renderTextSettings(); $('#text-settings-dialog').showModal(); };
$('#close-text-settings').onclick = () => $('#text-settings-dialog').close();
async function saveTextSettings() {
  const form = $('#text-settings-form');
  state.settings.text = await api('/api/text-settings', 'PUT', { apiKey: form.elements.apiKey.value, textModel: form.elements.textModel.value });
  form.elements.apiKey.value = '';
  renderSettingsStatus(); renderTextSettings(); renderTextChat();
}
$('#text-settings-form').onsubmit = event => {
  event.preventDefault(); action($('#text-settings-form [type=submit]'), async () => {
    await saveTextSettings(); $('#text-settings-dialog').close(); renderTextChat();
    toast('语言模型连接已保存到本机。');
  });
};
$('#refresh-text-models').onclick = () => action($('#refresh-text-models'), async () => {
  const draftKey = $('#text-settings-form [name=apiKey]').value;
  try {
    if (draftKey.trim()) await saveTextSettings();
    state.textCatalog = await api('/api/text-models/refresh', 'POST', {}); state.textCatalogError = '';
    renderTextSettings(); $('#text-settings-form [name=apiKey]').value = draftKey;
    $('#text-connection-message').textContent = `已读取 ${state.textCatalog.length} 个语言模型。`;
    renderTextChat();
  } catch (error) {
    $('#text-connection-message').classList.add('error'); $('#text-connection-message').textContent = error.message;
    throw error;
  }
});
$('#check-text-connection').onclick = () => action($('#check-text-connection'), async () => {
  try {
    await saveTextSettings(); const result = await api('/api/text-settings/check', 'POST', {});
    $('#text-connection-message').classList.remove('error'); $('#text-connection-message').textContent = result.message;
  } catch (error) {
    $('#text-connection-message').classList.add('error'); $('#text-connection-message').textContent = error.message;
  }
});
$('#text-chat-model')?.addEventListener('change', renderTextChat);
$('#text-clear')?.addEventListener('click', () => {
  state.textMessages = []; state.textError = ''; saveTextHistory(); renderTextChat();
});
$('#canvas-text-clear')?.addEventListener('click', () => $('#text-clear').click());
$('#text-use-context')?.addEventListener('click', () => {
  const input = $('#text-chat-input'); if (!input || !state.project) return;
  input.value = textContextPrompt(); input.focus();
});
$('#text-chat-form')?.addEventListener('submit', event => {
  event.preventDefault(); action($('#text-chat-form [type=submit]'), sendTextChat);
});

$('#connection-button').onclick = () => { renderSettings(); $('#settings-dialog').showModal(); };
$('#image-connection-button').onclick = () => { renderImageSettings(); $('#image-settings-dialog').showModal(); };
$('#close-settings').onclick = () => $('#settings-dialog').close();
$('#close-image-settings').onclick = () => $('#image-settings-dialog').close();
async function saveSettings() {
  const form = $('#settings-form');
  state.settings = await api('/api/settings', 'PUT', { apiKey: form.elements.apiKey.value });
  form.elements.apiKey.value = ''; const latest = await api('/api/bootstrap'); state.catalog = latest.catalog; state.catalogError = latest.catalogError; renderSettingsStatus(); canvas.render();
  $('#key-state').textContent = state.settings.hasKey ? '密钥已保存在本机，页面不回显。' : '尚未保存密钥。';
}
$('#settings-form').onsubmit = event => {
  event.preventDefault(); action($('#settings-form [type=submit]'), async () => { await saveSettings(); $('#settings-dialog').close(); renderScenes(); toast('模型连接已保存到本机。'); });
};
$('#refresh-models').onclick = () => action($('#refresh-models'), async () => {
  if ($('#settings-form [name=apiKey]').value.trim()) await saveSettings();
  state.catalog = await api('/api/models/refresh', 'POST', {}); state.catalogError = ''; renderSettings();
  $('#connection-message').textContent = `已读取 ${state.catalog.length} 个视频模型。来自当前密钥；报价请联系平台，实际扣费以账单为准。`; renderScenes(); canvas.render();
});
$('#check-connection').onclick = () => action($('#check-connection'), async () => {
  try {
    await saveSettings(); const result = await api('/api/settings/check', 'POST', {});
    $('#connection-message').classList.remove('error'); $('#connection-message').textContent = result.message;
  } catch (error) { $('#connection-message').classList.add('error'); $('#connection-message').textContent = error.message; }
});

async function saveImageSettings() {
  const form = $('#image-settings-form');
  state.settings.image = await api('/api/image-settings', 'PUT', { apiKey: form.elements.apiKey.value, imageModel: form.elements.imageModel.value });
  form.elements.apiKey.value = '';
  renderSettingsStatus(); renderImageSettings(); renderImageGeneration();
}
$('#image-settings-form').onsubmit = event => {
  event.preventDefault(); action($('#image-settings-form [type=submit]'), async () => {
    await saveImageSettings(); $('#image-settings-dialog').close(); renderScenes(); canvas.render();
    toast('生图连接已保存到本机。');
  });
};
$('#refresh-image-models').onclick = () => action($('#refresh-image-models'), async () => {
  const draftKey = $('#image-settings-form [name=apiKey]').value;
  try {
    state.imageCatalog = await api('/api/image-models/refresh', 'POST', {}); state.imageCatalogError = '';
    renderImageSettings(); $('#image-settings-form [name=apiKey]').value = draftKey;
    $('#image-connection-message').textContent = `已读取 ${state.imageCatalog.length} 个图片模型。`;
    renderImageModelOptions();
  } catch (error) {
    $('#image-connection-message').classList.add('error'); $('#image-connection-message').textContent = error.message;
    throw error;
  }
});
$('#check-image-connection').onclick = () => action($('#check-image-connection'), async () => {
  try {
    await saveImageSettings(); const result = await api('/api/image-settings/check', 'POST', {});
    $('#image-connection-message').classList.remove('error'); $('#image-connection-message').textContent = result.message;
  } catch (error) {
    $('#image-connection-message').classList.add('error'); $('#image-connection-message').textContent = error.message;
  }
});
$('#close-image').onclick = () => $('#image-dialog').close();
$('#cancel-image').onclick = () => $('#image-dialog').close();
async function submitImageForm(form, message) {
    const projectId = state.project?.id, sceneId = form.elements.sceneId?.value.trim() || '';
    const prompt = form.elements.prompt.value.trim(), model = form.elements.model.value;
    const count = normalizeImageCount(form.elements.count?.value || 1);
    const quality = form.elements.quality?.value || 'auto';
    const referenceAssetIds = form.id === 'image-page-form' ? [...state.imageReferenceIds] : [];
    if (!projectId) throw new ApiError('请先选择一个工程。', 400);
    if (!state.settings.image?.hasKey) throw new ApiError('请先在“生图连接”中保存 API Key。', 400);
    if (!prompt) throw new ApiError('请输入图片提示词。', 400);
    if (!model) throw new ApiError('请选择图片模型。', 400);
    if (form.id === 'image-page-form') { const issue = imagePageIssue(); if (issue) throw new ApiError(issue,400); }
    const key = projectId + ':form:' + form.id + ':' + sceneId;
    const pendingOperation = state.imageOperations.get(key);
    state.submitting.add(form.id);
    let started = false;
    try {
      if (pendingOperation) {
        await refreshImageJobs();
        if (projectId !== state.project?.id) throw new Error('工程已切换，请返回原工程查看任务。');
        const existing = state.imageJobs.filter(job => imageJobMatchesOperation(job,pendingOperation));
        if (existing.length) {
          state.imageOperations.delete(key);
          message.classList.remove('error'); message.textContent = '已找到原图片任务，正在跟踪其结果。';
          return existing.length === 1 ? existing[0] : {jobs:existing,count:existing.length,batchId:existing[0].batchId};
        }
      }
      await flush();
      if (projectId !== state.project?.id) throw new Error('工程已切换，请返回原工程再生成。');
      const scene = state.project.scenes.find(item => item.id === sceneId);
      if (scene && scene.imagePrompt !== prompt) { scene.imagePrompt = prompt; mark('scenes'); await flush(); }
      if (projectId !== state.project?.id) throw new Error('工程已切换，请返回原工程再生成。');
      const operationId = pendingOperation || uid();
      state.imageOperations.set(key, operationId); started = true;
      const payload = { sceneId, model, prompt, count, referenceAssetIds, operationId };
      if (quality !== 'auto') payload.config = { quality };
      const result = await api(`/api/projects/${projectId}/image-jobs`, 'POST', payload);
      const jobs = imageSubmissionJobs(result);
      state.imageOperations.delete(key);
      if (projectId !== state.project?.id) { toast('图片任务已提交到原工程，可返回该工程查看。'); return result; }
      const uncertain = jobs.some(job => job.state === 'uncertain');
      message.classList.remove('error'); message.textContent = uncertain
        ? '平台返回状态无法确认，请先到平台核对任务；工作台不会自动重复提交。'
        : '已提交 ' + jobs.length + ' 张图片的生成任务。保存成功后会自动出现在素材库和“生成结果”中。';
      adoptImageSubmission(jobs);
      renderImageJobs(); renderCounts();
      if (form.id === 'image-form') $('#image-dialog').close();
      await refreshImageJobs();
      toast(uncertain ? '图片提交状态需到平台核对，未自动重试。' : '已提交 ' + jobs.length + ' 张图片，可在“图片生成”中查看进度。');
      return result;
    } catch (error) {
      const ambiguous = started && (!error.status || error.status >= 500);
      if (started && !ambiguous) state.imageOperations.delete(key);
      if (projectId === state.project?.id) {
        message.classList.add('error'); message.textContent = ambiguous
          ? '提交确认暂未收到，请先刷新任务记录；再次提交会核对原请求，避免重复生成。' : error.message;
      }
      throw error;
    } finally { state.submitting.delete(form.id); }
  }
for (const [formId, messageId] of [['image-form', 'image-message'], ['image-page-form', 'image-page-message']]) {
  const form = $('#' + formId);
  form.onsubmit = event => {
    event.preventDefault();
    action(form.querySelector('[type=submit]'), () => submitImageForm(form, $('#' + messageId)));
  };
}
$('#image-page-model').onchange = () => renderImageGeneration();
$('#image-page-count')?.addEventListener('change', () => renderImageGeneration());
$('#image-page-quality')?.addEventListener('change', () => renderImageGeneration());
$('#image-model')?.addEventListener('change', renderImageDialogCost);
$('#image-count')?.addEventListener('change', renderImageDialogCost);
$('#image-quality')?.addEventListener('change', renderImageDialogCost);
$('#image-page-prompt').addEventListener('input', () => { renderImageReferences(); const submit = $('#image-page-form [type=submit]'); if (submit) submit.disabled = !state.settings.image?.hasKey || !$('#image-page-model').value || Boolean(imagePageIssue()) || state.submitting.has('image-page-form'); });
$('#image-page-reference-picker')?.addEventListener('change', event => { if (!event.target.value) return; try { addImagePageReference(event.target.value); } catch (error) { toast(error.message,true); } });
$('#image-page-references')?.addEventListener('click', event => { const remove = event.target.closest('[data-remove-image-reference]'); if (remove) { state.imageReferenceIds = state.imageReferenceIds.filter(id => id !== remove.dataset.removeImageReference); renderImageGeneration(); } else handleAssetClick(event); });
$('#image-page-reference-upload')?.addEventListener('click', () => $('#image-page-reference-input').click());
$('#image-page-reference-input')?.addEventListener('change', () => action($('#image-page-reference-upload'), async () => { try { const uploaded = await uploadFiles($('#image-page-reference-input').files); for (const asset of uploaded) if (asset.kind === 'image') addImagePageReference(asset.id); } finally { $('#image-page-reference-input').value = ''; } }));

$('#project-list').onclick = event => {
  const deletion = event.target.closest('[data-delete-project]');
  if (deletion) { action(deletion, () => deleteProject(deletion.dataset.deleteProject)); return; }
  const button = event.target.closest('[data-project-id]'); if (button) switchProject(button.dataset.projectId);
};
$('#open-deleted-projects').onclick = () => action($('#open-deleted-projects'), async () => { await refreshProjectList(); $('#deleted-projects-dialog').showModal(); });
$('#close-deleted-projects').onclick = () => $('#deleted-projects-dialog').close();
$('#deleted-project-list').onclick = event => {
  const restore = event.target.closest('[data-restore-project]');
  if (restore) { action(restore, () => restoreProject(restore.dataset.restoreProject)); return; }
  const permanent = event.target.closest('[data-permanent-project]');
  if (permanent) confirmPermanentDelete(permanent.dataset.permanentProject);
};
$('#cancel-permanent-project').onclick = () => $('#permanent-project-dialog').close();
$('#confirm-permanent-project').onclick = () => action($('#confirm-permanent-project'), permanentlyDeleteProject);
$('#empty-new-project').onclick = () => $('#new-project').click();
$('#empty-deleted-projects').onclick = () => $('#open-deleted-projects').click();
$('#rename-project').onclick = () => {
  if (!state.project) return;
  const input = $('#project-title');
  input.readOnly = false; input.focus(); input.select();
};
$('#project-title').oninput = () => {
  if (!state.project) return;
  const title = $('#project-title').value.trim().slice(0, 120);
  if (title && state.project.title !== title) { state.project.title = title; mark('title'); }
};
$('#project-title').onkeydown = event => {
  if (event.key === 'Enter') { event.preventDefault(); event.target.blur(); }
};
$('#project-title').onblur = event => {
  if (!state.project) return;
  const input = event.target, title = input.value.trim().slice(0, 120) || state.project.title || '未命名工程';
  input.readOnly = true;
  if (state.project.title !== title) { state.project.title = title; mark('title'); }
  input.value = title;
};
$('#brief-form').oninput = event => {
  if (!event.target.name || !event.target.validity.valid) return;
  state.project.brief[event.target.name] = event.target.name === 'duration' ? Number(event.target.value) : event.target.value; mark('brief');
};
$('#brief-form').onsubmit = event => {
  event.preventDefault(); action($('#brief-form [type=submit]'), async () => {
    await flush(); const project = await api(`/api/projects/${state.project.id}/plan`, 'POST', {});
    adoptRemote(project); setView('canvas'); canvas.syncScenes(); canvas.render(); toast('视频创作草案已放到画布，使用本地模板，未调用收费模型。');
  });
};
$('#new-project').onclick = () => { $('#new-form').reset(); $('#new-dialog').showModal(); $('#new-form input').focus(); };
$('#close-new').onclick = () => $('#new-dialog').close();
$('#new-form').onsubmit = event => {
  event.preventDefault(); action($('#new-form [type=submit]'), async () => {
    await flush(); setProject(await api('/api/projects', 'POST', { title: $('#new-form input').value }));
    $('#new-dialog').close(); setView('canvas'); fitCanvas(); toast('新工程已创建。');
  });
};
$('#import-project').onclick = () => $('#import-input').click();
$('#import-input').onchange = () => action($('#import-project'), async () => {
  const file = $('#import-input').files[0]; if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new ApiError('工程文件最大支持 2 MB。', 413);
    let input; try { input = JSON.parse(await file.text()); } catch { throw new ApiError('文件内容不是有效的 JSON。', 400); }
    canvas.finishEditing(); await flush(); setProject(await api('/api/projects/import', 'POST', input)); toast('工程已导入。媒体文件需重新上传并选择。');
  } finally { $('#import-input').value = ''; }
});
$('#save-state').onclick = () => {
  if (!state.saveError) return;
  if ([404, 410].includes(state.saveError.status)) {
    downloadJson(localExport(), `${state.project.title}-未保存备份.json`);
    action(null, async () => {
      state.dirty.clear(); state.saveError = null;
      setProject(null); await refreshProjectList(); await selectAvailableProject();
      toast('本地编辑已下载为备份，可从“已删除工程”恢复原工程。');
    });
  } else if (state.saveError.status === 409) {
    downloadJson(localExport(), `${state.project.title}-未保存备份.json`);
    action(null, async () => { setProject(await api(`/api/projects/${state.project.id}`)); toast('本地编辑已下载为备份，现已加载服务器版本。'); });
  } else { state.saveError = null; flush().catch(() => {}); }
};
$$('.tab').forEach(button => button.onclick = () => setView(button.dataset.view));
window.addEventListener('beforeunload', event => { if (state.dirty.size || state.saveTask) { event.preventDefault(); event.returnValue = ''; } });

function adoptRemote(project) {
  if (project.id !== state.project?.id || project.deletedAt) return;
  for (const field of fields) if (!state.dirty.has(field) && !state.saveTask) state.project[field] = clone(project[field]);
  for (const field of ['assets', 'exports', 'updatedAt', 'planSource']) state.project[field] = clone(project[field]);
  if (!state.saveTask) syncImageCardJobs(state.project,state.imageJobs);
  if (!state.saveTask) { state.project.revision = project.revision; state.saved = clone(project); }
  rememberProject(project); renderProjects(); renderCounts();
}
async function poll() {
  if (state.pollBusy || state.switching || document.hidden || sceneVideoPlaying()) return;
  state.pollBusy = true;
  const activeId = state.project?.id;
  try {
    if (!state.dirty.size && !state.saveTask) await refreshProjectList();
    if (!state.project) { if (state.projects.length) await selectAvailableProject(); return; }
    await refreshJobs(); await refreshImageJobs();
    if (state.dirty.size || state.saveTask || state.switching || state.submitting.size || canvas.busy()) return;
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (editing || sceneVideoPlaying()) return;
    const id = state.project.id, project = await api(`/api/projects/${id}`);
    if (id !== state.project?.id || state.dirty.size || state.saveTask || project.revision === state.project.revision) return;
    adoptRemote(project); setView(state.view);
  } catch (error) {
    if ([404, 410].includes(error.status)) await recoverUnavailableProject(activeId, error).catch(() => {});
    // Connection failures leave local edits untouched for the next read.
  }
  finally { state.pollBusy = false; }
}
async function init() {
  try {
    const bootstrap = await api('/api/bootstrap'); Object.assign(state, bootstrap);
    let project = state.projects.find(project => project.id === localStorage.getItem('jingce-active-project')) || state.projects[0];
    setProject(project || null); await refreshJobs(); await refreshImageJobs(); setInterval(poll, 5000);
    if (state.catalogError) toast(state.catalogError, true);
  } catch (error) { toast(error.message, true); saveLabel('工作台未连接', true); }
}
init();
