import { normalizeViewport, screenToWorld, worldToScreen, zoomAt, selectionBounds,
  fitViewport, intersectsRect, connectionPath, WORLD_LIMIT } from './canvas-geometry.js';
import { CARD_WIDTH, CARD_HEIGHT, normalizeCardSizes } from './canvas-layout.js';
import { canvasLinkReference, sceneReferenceCycle, resolveSceneReferences, syncProjectReferences, referenceLabel, referenceKey, withoutSceneReferenceLinks } from './reference-model.js';
import { updatePromptMentions, insertReferenceMention, remapPromptMentions, invalidPromptMentions } from './prompt-mentions.js';
import { createReferencePromptEditor } from './prompt-editor.js';
import { referenceRequestIssue } from './reference-api.js';
import { modelLinkIssue } from './model-link-rules.js';
import { capabilitySummary } from './model-capabilities.js';
import { videoParameterControls, updateVideoParameter, videoEstimateText, videoPricingNote } from './video-parameters.js';
import { IMAGE_RATIOS, IMAGE_QUALITIES, IMAGE_STYLES, IMAGE_CONTROL_NOTE, IMAGE_GENERATION_COUNT_MAX, IMAGE_ACTIVE_STATES, isImageGenerationNode, normalizeImageConfig, resolveImageInputs, imageRequestIssue, syncImageCardJobs, imageModelReferenceLimit, imageEstimate, imageEstimateText } from './image-parameters.js';
import { AI_MODES, normalizeAiConfig } from './ai-text.js';
import { SPEECH_MODELS, SPEECH_EMOTIONS, SPEECH_TEXT_LIMIT, speechCharacterCount, speechEmotionSupported, normalizeSpeechDraft, estimateSpeechCost, isSpeechGenerationNode } from './speech-parameters.js';
import { assetThumbnailUrl } from './media-thumbnails.js';
import { generationSkillControl, generationSkillIssue, generationSkillNote } from './skills.js';

const clone = value => structuredClone(value);
const uid = () => crypto.randomUUID();
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const coordinate = value => Math.round(clamp(value, -WORLD_LIMIT, WORLD_LIMIT));

function clearCanvasSpace(graph, point, width, height) {
  const position = { x: coordinate(point.x), y: coordinate(point.y) };
  for (let attempt = 0; attempt <= graph.nodes.length; attempt++) {
    const area = { x: position.x - 30, y: position.y - 30, width: width + 60, height: height + 60 };
    const blockers = graph.nodes.filter(node => intersectsRect(area, node));
    if (!blockers.length) return position;
    const nextY = coordinate(Math.max(...blockers.map(node => node.y + node.height + 70)));
    if (nextY > position.y) position.y = nextY;
    else {
      position.x = coordinate(Math.min(...blockers.map(node => node.x)) - width - 70);
      position.y = coordinate(point.y);
    }
  }
  return position;
}

export function createAssetCanvasNode(asset, graph, point = { x: 0, y: 0 }) {
  return { id: uid(), kind: asset.kind, label: asset.name.slice(0, 80),
    ...clearCanvasSpace(graph, point, CARD_WIDTH, CARD_HEIGHT), width: CARD_WIDTH, height: CARD_HEIGHT,
    status: 'uploaded', note: '', assetId: asset.id, sceneId: '', assetName: asset.name };
}

const interactive = target => Boolean(target?.closest('input,textarea,select,button,a,video,audio,[contenteditable="true"]'));
const editing = target => Boolean(target?.closest('input:not([readonly]),textarea,select,[contenteditable="true"]'));
const playing = element => [...element.querySelectorAll('video,audio')].some(media => !media.paused && !media.ended);
const VIDEO_PIXEL_MIN = 407696;
const VIDEO_PIXEL_MAX = 8295044;
export const imagePixelIssue = ({ width, height } = {}) => {
  const pixels = Number(width) * Number(height);
  if (!Number.isFinite(pixels) || pixels <= 0) return '';
  if (pixels < VIDEO_PIXEL_MIN || pixels > VIDEO_PIXEL_MAX) return `素材像素数为 ${pixels.toLocaleString('zh-CN')}（${width}×${height}），必须介于 ${VIDEO_PIXEL_MIN.toLocaleString('zh-CN')} 和 ${VIDEO_PIXEL_MAX.toLocaleString('zh-CN')} 之间。`;
  return '';
};
const readImageDimensions = asset => new Promise(resolve => {
  if (typeof Image === 'undefined') return resolve({});
  const image = new Image();
  image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
  image.onerror = () => resolve({});
  image.src = `/api/assets/${encodeURIComponent(asset.id)}`;
});
const labels = { preparing: '上传素材中', waiting: '等待提交', submitting: '提交中', queued: '平台排队中', running: '生成中', downloading: '保存中', saving: '保存图片中',
  download_pending: '待下载', done: '已完成', failed: '未完成', uncertain: '需核对平台', attention: '需手动查询' };
const activeStates = new Set(['waiting', 'preparing', 'submitting', 'queued', 'running', 'downloading', 'saving', 'download_pending', 'uncertain', 'attention']);
const speechLabels = { waiting: '等待提交', submitting: '生成中', saving: '保存中', save_pending: '待保存', done: '已完成', failed: '未完成', uncertain: '需核对平台' };
const activeSpeechStates = new Set(['waiting', 'submitting', 'saving', 'save_pending', 'uncertain']);
const info = {
  text: ['Ｔ', '记录想法，或把提示词准备成视频卡片。', '创建视频卡片', 'canvas'],
  ai: ['✦', '把上游文字整理成脚本、分镜或可直接使用的生成提示词。', '运行 AI 创作', 'text'],
  brief: ['◎', '确定主题、故事和画面风格。', '编辑创作需求', 'canvas'],
  script: ['≡', '把创作方向整理成视频文案和生成项。', '编辑视频文案', 'videos'],
  storyboard: ['▦', '调整视频内容、次序和生成参数。', '查看视频生成项', 'videos'],
  image: ['▧', '放置图片，让构图和场景更直观。', '选择图片素材', 'assets'],
  video: ['▷', '添加视频卡片，编辑提示词并生成候选视频。', '关联视频卡片', 'videos'],
  audio: ['♫', '连接文字生成配音，或从素材库选择音乐、对白和氛围声。', '生成配音', 'speech'],
  compose: ['▧', '查看已经生成的图片与视频，预览、下载或继续创作。', '生成结果', 'results'],
};

export function canvasLinkAppearance(link, { selection = new Set(), selectedLink = '', focusedLink = '', zoom = 1, hideLabels = false } = {}) {
  const selected = link.id === selectedLink;
  const highlighted = link.id === focusedLink || selected;
  const related = highlighted || selection.has(link.from) || selection.has(link.to);
  const hasFocus = selection.size > 0 || Boolean(selectedLink || focusedLink);
  return { selected, highlighted, related, dimmed: hasFocus && !related,
    labelVisible: !hideLabels && zoom >= 0.65 && link.id === (focusedLink || selectedLink) };
}

// Check type compatibility and direction before changing the saved graph.
export function validateCanvasLink(graph, kinds, from, to) {
  const source = graph.nodes.find(node => node.id === from), target = graph.nodes.find(node => node.id === to);
  if (!source || !target || from === to) return '请选择两个不同的卡片。';
  if (graph.links.length >= 160) return '画布最多支持 160 条连接。';
  if (graph.links.some(link => link.from === from && link.to === to)) return '这两个卡片已经连接。';
  if (!kinds[target.kind]?.accepts.includes(kinds[source.kind]?.produces)) return '这两个卡片的输入、输出类型不匹配。';
  if (sceneReferenceCycle(graph, from, to)) return '视频参考会形成循环，不能连接到自身或循环引用的视频生成项。';
  const stack = [to], seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (id === from) return '连接会形成循环，请保留单向创作流程。';
    if (seen.has(id)) continue;
    seen.add(id); stack.push(...graph.links.filter(link => link.from === id).map(link => link.to));
  }
  return '';
}

export function createInfiniteCanvas(bridge) {
  const $ = selector => document.querySelector(selector);
  const viewport = $('#canvas-viewport'), space = $('#canvas-space'), groupsLayer = $('#canvas-groups'), nodesLayer = $('#nodes');
  const connections = $('#connections'), marquee = $('#canvas-marquee'), minimap = $('#canvas-minimap');
  const root = $('#creative-canvas'), assetsPanel = $('#canvas-assets-panel'), briefPanel = $('#canvas-brief');
  const contextMenu = $('#canvas-context-menu');
  const overview = $('#canvas-overview'), overviewToggle = $('#toggle-canvas-overview');
  const overviewKey = 'jingce.canvas.overviewCollapsed';
  let overviewCollapsed = true;
  try { overviewCollapsed = window.localStorage?.getItem(overviewKey) !== 'false'; } catch {}
  function updateOverview() {
    overview?.classList.toggle('collapsed', overviewCollapsed);
    overviewToggle?.setAttribute('aria-expanded', String(!overviewCollapsed));
    overviewToggle?.setAttribute('aria-controls', 'canvas-minimap');
    const label = overviewCollapsed ? '展开小地图' : '收起小地图';
    overviewToggle?.setAttribute('aria-label', label);
    overviewToggle?.setAttribute('title', label);
  }
  updateOverview();
  overviewToggle?.addEventListener('click', () => {
    overviewCollapsed = !overviewCollapsed;
    updateOverview();
    try { window.localStorage?.setItem(overviewKey, String(overviewCollapsed)); } catch {}
  });
  let projectId = '', selection = new Set(), selectedLink = '', connectionFrom = '', connectionTargetId = '', tool = 'select', spaceDown = false;
  let interaction = null, hoverPoint = null, contextPoint = null, insertionIndex = 0, suppressClick = false, suppressContextMenuUntil = 0;
  let undo = [], redo = [], editBefore = null, relinkNodeId = '', panelPoint = null, minimapBounds = null;
  let activeCoverCard = null;
  const speechSubmitting = new Set();
  let hoveredLink = '', hoveredReference = null, focusedReference = null, promptReference = null;
  const cards = new Map(), groupFrames = new Map(), signatures = new Map(), referenceSignatures = new WeakMap();
  const state = () => bridge.getState();
  const project = () => state().project;
  const graph = () => project().graph;
  const visible = () => state().view === 'canvas' && !$('#canvas-view').classList.contains('hidden');
  const snapshot = () => clone({ nodes: graph().nodes, links: graph().links, groups: graph().groups || [],
    sceneTitles: Object.fromEntries(project().scenes.map(scene => [scene.id, scene.title])),
    sceneReferences: Object.fromEntries(project().scenes.map(scene => [scene.id, clone(scene.references || [])])) });
  const localPoint = event => { const rect = viewport.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  const center = () => screenToWorld({ x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }, graph().viewport);
  const report = error => bridge.toast(error.message || '画布操作未完成。', true);

  function closeCoverDetails() {
    if (!activeCoverCard) return;
    activeCoverCard.classList.remove('details-open');
    activeCoverCard.setAttribute('aria-expanded', 'false');
    settleCoverControls(activeCoverCard);
    activeCoverCard = null;
  }
  function showCoverDetails(card) {
    if (!card?.classList?.contains('cover-card')) return;
    if (activeCoverCard && activeCoverCard !== card) closeCoverDetails();
    activeCoverCard = card;
    card.classList.add('details-open');
    card.setAttribute('aria-expanded', 'true');
    positionCoverDetails(card);
  }

  function reset() {
    closeCoverDetails();
    projectId = project()?.id || ''; selection.clear(); selectedLink = ''; connectionFrom = ''; connectionTargetId = '';
    undo = []; redo = []; editBefore = null; interaction = null; insertionIndex = 0; relinkNodeId = ''; suppressContextMenuUntil = 0;
    cards.clear(); groupFrames.clear(); signatures.clear(); groupsLayer.replaceChildren(); nodesLayer.replaceChildren(); contextMenu.hidden = true; marquee.hidden = true;
    hoverPoint = null; contextPoint = null; panelPoint = null;
    hoveredLink = ''; hoveredReference = null; focusedReference = null; promptReference = null;
    normalizeGraphMetadata();
    try { if (project()) syncReferences(); } catch (error) { report(error); }
    updateTools();
  }
  function normalizeGraphMetadata() {
    if (!project()) return;
    if (!Array.isArray(graph().groups)) graph().groups = [];
    graph().viewport = normalizeViewport(graph().viewport);
    // Preserve positions while unifying every existing card's cover size once.
    if (normalizeCardSizes(graph())) bridge.mark('graph');
  }
  function groupBounds(group) {
    const members = graph().nodes.filter(node => group.nodeIds.includes(node.id));
    if (members.length < 2) return null;
    const left = Math.min(...members.map(node => node.x)), top = Math.min(...members.map(node => node.y));
    const right = Math.max(...members.map(node => node.x + node.width)), bottom = Math.max(...members.map(node => node.y + node.height));
    return { left: left - 22, top: top - 45, width: right - left + 44, height: bottom - top + 67 };
  }
  function renderGroups() {
    const headers = [];
    const valid = new Set((graph().groups || []).map(group => group.id));
    for (const [id, frame] of groupFrames) if (!valid.has(id)) { frame.remove(); groupFrames.delete(id); }
    for (const group of graph().groups || []) {
      const bounds = groupBounds(group);
      if (!bounds) continue;
      let frame = groupFrames.get(group.id);
      if (!frame) {
        frame = document.createElement('div'); frame.className = 'canvas-group'; frame.dataset.canvasGroupId = group.id;
        groupFrames.set(group.id, frame); groupsLayer.append(frame);
      }
      Object.assign(frame.style, { left: bounds.left + 'px', top: bounds.top + 'px', width: bounds.width + 'px', height: bounds.height + 'px' });
      // Reserve a full title row and move colliding rows upward in world coordinates.
      const header = { x: bounds.left, y: bounds.top - 48, width: 340, height: 40 };
      while (headers.some(other => header.x < other.x + other.width + 8 && header.x + header.width + 8 > other.x
        && header.y < other.y + other.height + 8 && header.y + header.height + 8 > other.y)) header.y -= 48;
      headers.push(header);
      frame.style.setProperty('--group-header-offset', `${bounds.top - header.y - header.height}px`);
      frame.style.setProperty('--group-color', /^#[0-9a-f]{6}$/i.test(group.color || '') ? group.color : '#a9560b');
      const template = '<div class="canvas-group-frame"></div><div class="canvas-group-header" data-canvas-group-drag data-group-id="' + escapeHtml(group.id) + '"><span title="拖动此处整体移动分组">⠿</span>'
        + '<input data-canvas-group-field="label" data-group-id="' + escapeHtml(group.id) + '" aria-label="分组名称" maxlength="80" value="' + escapeHtml(group.label) + '">'
        + '<button type="button" data-group-action="dissolve" data-group-id="' + escapeHtml(group.id) + '" title="撤销分组，保留卡片和连线" aria-label="撤销分组">撤销分组</button>'
        + '<input class="canvas-group-color" type="color" data-canvas-group-field="color" data-group-id="' + escapeHtml(group.id) + '" aria-label="分组背景颜色" title="更改分组背景颜色" value="' + escapeHtml(/^#[0-9a-f]{6}$/i.test(group.color || '') ? group.color : '#a9560b') + '">'
        + '<span>' + group.nodeIds.length + ' 项</span></div>';
      if (frame.innerHTML !== template && !frame.contains(document.activeElement)) frame.innerHTML = template;
    }
  }
  function commit(before) {
    const after = snapshot();
    if (!before || JSON.stringify(before) === JSON.stringify(after)) return;
    const titleIds = Object.keys(before.sceneTitles || {}).filter(id =>
      Object.hasOwn(after.sceneTitles, id) && before.sceneTitles[id] !== after.sceneTitles[id]);
    const referenceIds = project().scenes.filter(scene => JSON.stringify(before.sceneReferences?.[scene.id] || []) !== JSON.stringify(after.sceneReferences?.[scene.id] || [])).map(scene => scene.id);
    undo.push({ document: before, titleIds, referenceIds });
    if (undo.length > 40) undo.shift(); redo = []; updateTools();
  }
  function syncReferences(markChanges = true) {
    const original = project(), before = new Map(original.scenes.map(scene => [scene.id, clone(scene.references || [])]));
    const draft = { ...original, scenes: clone(original.scenes) };
    syncProjectReferences(draft); let changed = false;
    for (const scene of draft.scenes) {
      const previous = before.get(scene.id), result = remapPromptMentions(scene.videoPrompt || '',scene.promptMentions || [],previous,scene.references);
      scene.videoPrompt=result.prompt;scene.promptMentions=result.mentions;
      const existing=original.scenes.find(item=>item.id===scene.id);
      if (JSON.stringify(existing.references||[])!==JSON.stringify(scene.references)||existing.referenceAssetId||existing.videoPrompt!==scene.videoPrompt||JSON.stringify(existing.promptMentions||[])!==JSON.stringify(scene.promptMentions)) changed=true;
    }
    for (const scene of draft.scenes) {
      const existing=original.scenes.find(item=>item.id===scene.id);
      existing.references=scene.references;existing.referenceAssetId='';existing.videoPrompt=scene.videoPrompt;existing.promptMentions=scene.promptMentions;
    }
    if (changed && markChanges) bridge.mark('scenes');
  }
  function changeGraph(operation) {
    finishEditing(); const before=snapshot(), backup={ graph:clone(graph()),scenes:clone(project().scenes) };
    try { operation();syncReferences();commit(before);bridge.mark('graph');render();return true; }
    catch (error) { project().graph=backup.graph;project().scenes=backup.scenes;connectionFrom='';selectedLink='';render({force:true});report(error);return false; }
  }
  function sameReferenceMaterial(left, right) {
    if (left.kind !== right.kind) return false;
    if (left.assetId || right.assetId) return Boolean(left.assetId) && left.assetId === right.assetId;
    return Boolean(referenceKey(left)) && referenceKey(left) === referenceKey(right);
  }
  function restoreReferenceMetadata(scene, savedReferences, previousNodes) {
    const current = clone(scene.references || []), saved = clone(savedReferences || []);
    const nodes = new Map(graph().nodes.map(node => [node.id, node]));
    const inventory = new Map(resolveSceneReferences(project(), { ...scene, references: [], referenceAssetId: '' })
      .map(reference => [reference.nodeId, reference]));
    const restored = saved.filter(reference => reference.nodeId && inventory.get(reference.nodeId)?.kind === reference.kind)
      .map(reference => ({ ...reference, assetId: inventory.get(reference.nodeId).assetId }));
    const references = [];
    for (const reference of current) {
      const node = nodes.get(reference.nodeId);
      const displaced = reference.nodeId && node
        && (!inventory.has(reference.nodeId) || !sameReferenceMaterial(inventory.get(reference.nodeId), reference));
      if (!displaced) { references.push(reference); continue; }
      // A replaced linked asset may return to a manual item only if it was manual
      // in the restored snapshot. A supplemented placeholder must stay empty.
      const manual = saved.find(item => !item.nodeId && item.refId === reference.refId
        && sameReferenceMaterial(item, reference));
      if (manual) { const { nodeId, ...detached } = reference; references.push(detached); }
    }
    for (const reference of restored) {
      // Preserve edits made after a representative card was removed, but do not
      // transfer another asset's purpose to a restored placeholder or image.
      const matching = current.filter(item => sameReferenceMaterial(item, reference));
      const latest = matching.find(item => referenceKey(item) === referenceKey(reference))
        || matching.find(item => reference.refId && item.refId === reference.refId) || matching[0];
      const metadata = { ...reference, note: latest ? latest.note : reference.note };
      if (latest) {
        if (latest.publicUrl) metadata.publicUrl = latest.publicUrl; else delete metadata.publicUrl;
        if (latest.role) metadata.role = latest.role; else delete metadata.role;
      }
      if (latest?.refId) metadata.refId = latest.refId;
      const index = references.findIndex(item => referenceKey(item) === referenceKey(reference));
      if (index < 0) references.push(metadata); else references[index] = metadata;
    }
    scene.references = references;
    scene.promptMentions = (scene.promptMentions || []).map(mention => {
      const reference = restored.find(item => referenceKey(item) === mention.key
        && previousNodes.has(item.nodeId)
        && (previousNodes.get(item.nodeId).assetId || '') !== (nodes.get(item.nodeId).assetId || ''));
      if (!reference) return mention;
      // Undo only the material identity; offsets and later prompt edits remain.
      const { assetId, refId, ...identity } = mention;
      return { ...identity, ...(reference.assetId ? { assetId: reference.assetId } : {}),
        ...(reference.refId ? { refId: reference.refId } : {}) };
    });
  }
  function restore(document, titleIds = [], referenceIds = []) {
    const scenes = new Set(project().scenes.map(scene => scene.id)), assets = new Set(project().assets.filter(asset => !asset.deletedAt).map(asset => asset.id));
    const previousNodes = new Map(graph().nodes.map(node => [node.id, node]));
    const previousScenes = JSON.stringify(project().scenes);
    graph().nodes = clone(document.nodes).map(node => ({ ...node,
      sceneId: scenes.has(node.sceneId) ? node.sceneId : '', assetId: assets.has(node.assetId) ? node.assetId : '',
      ...(isImageGenerationNode(node) && previousNodes.has(node.id)
        ? { selectedAssetId: previousNodes.get(node.id).selectedAssetId || '' } : {}) }));
    graph().groups = clone(document.groups || []);
    syncImageCardJobs(project(),state().imageJobs || []);
    const missingNodes = new Set(document.nodes.filter(node => node.assetId && !assets.has(node.assetId)).map(node => node.id));
    graph().links = clone(document.links).filter(link => !missingNodes.has(link.from)
      && (!link.reference?.assetId || assets.has(link.reference.assetId))); selection.clear(); selectedLink = ''; connectionFrom = '';
    for (const id of titleIds) {
      const scene = project().scenes.find(item => item.id === id), title = document.sceneTitles?.[id];
      if (scene && typeof title === 'string' && scene.title !== title) scene.title = title;
    }
    for (const id of referenceIds) {
      const scene = project().scenes.find(item => item.id === id);
      if (scene) restoreReferenceMetadata(scene, document.sceneReferences?.[id]?.filter(reference => !reference.assetId || assets.has(reference.assetId)), previousNodes);
    }
    // History owns one atomic dirty mark after all prompt remapping succeeds.
    syncReferences(false);
    if (previousScenes !== JSON.stringify(project().scenes)) bridge.mark('scenes');
    bridge.mark('graph'); render({ force: true });
  }
  function history(direction) {
    if (!project() || interaction) return;
    finishEditing(); const source = direction === 'undo' ? undo : redo, destination = direction === 'undo' ? redo : undo;
    if (!source.length) return;
    const entry = source[source.length - 1], inverse = { document:snapshot(),titleIds:entry.titleIds,referenceIds:entry.referenceIds };
    const backup = { graph:clone(graph()),scenes:clone(project().scenes) };
    try { restore(entry.document,entry.titleIds,entry.referenceIds);source.pop();destination.push(inverse);updateTools(); }
    catch (error) { project().graph=backup.graph;project().scenes=backup.scenes;render({force:true});report(error); }
  }
  function finishEditing() {
    if (editBefore) { commit(editBefore); editBefore = null; }
  }
  function updateTools() {
    $('#undo-canvas').disabled = !undo.length; $('#redo-canvas').disabled = !redo.length;
    document.querySelectorAll('[data-canvas-tool]').forEach(button => {
      const active = button.dataset.canvasTool === tool;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    });
    viewport.classList.toggle('hand-tool', tool === 'hand' || spaceDown);
    viewport.classList.toggle('marquee-tool', tool === 'marquee' && !spaceDown);
    viewport.classList.toggle('is-panning', interaction?.mode === 'pan');
    viewport.classList.toggle('selecting', interaction?.mode === 'marquee');
    viewport.classList.toggle('connecting', Boolean(connectionFrom));
    const count = selection.size, active = Boolean(count || selectedLink || connectionFrom);
    const selectionTools = $('#canvas-selection-tools');
    selectionTools.hidden = !active;
    $('#selection-note').textContent = connectionFrom ? (connectionTargetId ? '已吸附，松开即可连接；Esc 取消' : '靠近目标卡片自动吸附，或点击左端口；Esc 取消') : selectedLink ? '已选中连接' : `已选择 ${count} 张卡片`;
    $('#duplicate-selection').disabled = !count;
    $('#remove-selection').disabled = !count && !selectedLink;
    $('#create-canvas-group').disabled = count < 2;
    for (const [id, card] of cards) {
      card.classList.toggle('selected', selection.has(id)); card.setAttribute('aria-selected', String(selection.has(id)));
    }
    updateLinkFocus();
  }
  function setViewport(value, save = true) {
    graph().viewport = normalizeViewport(value); applyViewport(); if (save) bridge.mark('graph');
  }
  function applyViewport() {
    if (!project()) return;
    const view = normalizeViewport(graph().viewport);
    space.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    const dotOpacity = clamp((view.zoom - .35) / .65, 0, 1).toFixed(3);
    viewport.style.setProperty('--canvas-dot-size', `${Math.max(24, 24 * view.zoom)}px`);
    viewport.style.setProperty('--canvas-dot-opacity', dotOpacity);
    viewport.dataset.gridVisibility = Number(dotOpacity) > 0 ? 'visible' : 'hidden';
    viewport.style.setProperty('--canvas-dot-x', `${view.x}px`); viewport.style.setProperty('--canvas-dot-y', `${view.y}px`);
    $('#zoom-level').textContent = `${Math.round(view.zoom * 100)}%`; drawLinks(); drawMinimap();
    if (activeCoverCard) positionCoverDetails(activeCoverCard);
  }
  function fit() {
    if (!project() || !visible() || !viewport.clientWidth) return;
    setViewport(fitViewport(graph().nodes, { width: viewport.clientWidth, height: viewport.clientHeight }, 82));
  }
  function zoom(factor, anchor) {
    if (!project()) return;
    setViewport(zoomAt(graph().viewport, graph().viewport.zoom * factor,
      anchor || { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }));
  }
  function place(point, width, height) {
    if (point) return { x: coordinate(point.x), y: coordinate(point.y) };
    const p = center(), offset = (insertionIndex++ % 5) * 28;
    return { x: coordinate(p.x - width / 2 + offset), y: coordinate(p.y - height / 2 + offset) };
  }
  function ensureCapacity(count = 1) {
    if (graph().nodes.length + count > 60) { bridge.toast('每个工程最多放置 60 张卡片，请先移除不需要的卡片。', true); return false; }
    return true;
  }
  function clearSpace(point, width, height) {
    return clearCanvasSpace(graph(), point, width, height);
  }
  function baseNode(kind, label, point, width = CARD_WIDTH, height = CARD_HEIGHT) {
    return { id: uid(), kind, label, ...place(point, width, height), width, height, status: 'pending', note: '',
      assetId: '', sceneId: '', assetName: '' };
  }
  function addText(point, note = '') {
    if (!ensureCapacity()) return;
    let node;
    changeGraph(() => { node = baseNode('text', '灵感便签', point); node.note = note;
      graph().nodes.push(node); selection = new Set([node.id]); selectedLink = ''; });
    if (!note) { const card = cards.get(node.id); showCoverDetails(card); card?.querySelector('[data-node-field="note"]')?.focus(); }
    return node;
  }
  function addAi(point, sourceNode = null) {
    if (!ensureCapacity()) return;
    let node;
    changeGraph(() => {
      node = baseNode('ai', 'AI 创作', point || (sourceNode ? clearSpace({ x: sourceNode.x + sourceNode.width + 90, y: sourceNode.y }, CARD_WIDTH, CARD_HEIGHT) : null));
      node.aiConfig = normalizeAiConfig({
        model: state().settings.text?.textModel || state().textCatalog?.[0]?.name || '',
        instruction: sourceNode?.kind === 'text' ? '请把这段内容整理成可以直接用于创作的文字。' : '',
      });
      graph().nodes.push(node);
      if (sourceNode && !validateCanvasLink(graph(), state().kinds, sourceNode.id, node.id)) graph().links.push(proposedLink(sourceNode.id, node.id));
      selection = new Set([node.id]); selectedLink = '';
    });
    const card = cards.get(node?.id); showCoverDetails(card);
    card?.querySelector('[data-ai-field="instruction"]')?.focus({ preventScroll: true });
    return node;
  }
  function addImage(point, sourceNode = null, prompt = '') {
    if (!ensureCapacity()) return;
    let node;
    if (!changeGraph(() => {
      node = baseNode('image','新的生图',point || (sourceNode ? clearSpace({x:sourceNode.x+sourceNode.width+90,y:sourceNode.y},CARD_WIDTH,CARD_HEIGHT) : null));
      node.role = 'image-generation'; node.imageJobId = ''; node.selectedAssetId = '';
      node.imageConfig = normalizeImageConfig({model:state().settings.image?.imageModel || state().imageCatalog?.[0]?.name || '', prompt:String(prompt || '').slice(0,4000)});
      graph().nodes.push(node);
      if (sourceNode && !validateCanvasLink(graph(),state().kinds,sourceNode.id,node.id)) graph().links.push(proposedLink(sourceNode.id,node.id));
      selection = new Set([node.id]);selectedLink='';
    })) return;
    const card = cards.get(node?.id);showCoverDetails(card);
    card?.querySelector('[data-image-field="prompt"]')?.focus({preventScroll:true});
    return node;
  }
  function addSpeech(point, sourceNode = null, text = '') {
    if (!ensureCapacity()) return;
    let node;
    const upstream = sourceNode?.kind === 'ai' ? normalizeAiConfig(sourceNode.aiConfig).output : sourceNode?.note || '';
    if (!changeGraph(() => {
      node = baseNode('audio', '新的语音', point || (sourceNode ? clearSpace({ x: sourceNode.x + sourceNode.width + 90, y: sourceNode.y }, CARD_WIDTH, CARD_HEIGHT) : null));
      node.role = 'speech-generation';
      node.speechConfig = normalizeSpeechDraft({ model: state().speechCatalog?.[0] || SPEECH_MODELS[0], text: String(text || upstream).slice(0, SPEECH_TEXT_LIMIT) });
      graph().nodes.push(node);
      if (sourceNode && !validateCanvasLink(graph(), state().kinds, sourceNode.id, node.id)) graph().links.push(proposedLink(sourceNode.id, node.id));
      selection = new Set([node.id]); selectedLink = '';
    })) return;
    const card = cards.get(node?.id); showCoverDetails(card);
    card?.querySelector('[data-speech-field="text"]')?.focus({ preventScroll: true });
    return node;
  }
  function addShot(point, sourceNode = null, scene = null, prompt = '') {
    if (!ensureCapacity()) return;
    let node;
    try {
      const linkedScene = scene || bridge.createScene(String(prompt || '').slice(0,4000) || (isImageGenerationNode(sourceNode) ? sourceNode.imageConfig?.prompt : sourceNode?.note) || '', sourceNode?.label && sourceNode.kind === 'text' ? sourceNode.label : prompt ? '语言模型草稿' : '新的视频');
      changeGraph(() => {
        node = baseNode('video', linkedScene.title, point || (sourceNode ? clearSpace({ x: sourceNode.x + sourceNode.width + 90, y: sourceNode.y }, CARD_WIDTH, CARD_HEIGHT) : null));
        node.sceneId = linkedScene.id; graph().nodes.push(node);
        if (sourceNode && !validateCanvasLink(graph(), state().kinds, sourceNode.id, node.id)) graph().links.push(proposedLink(sourceNode.id,node.id));
        selection = new Set([node.id]); selectedLink = '';
      });
    } catch (error) { report(error); }
    if (!node || !graph().nodes.some(item => item.id === node.id)) return;
    const card = cards.get(node.id); showCoverDetails(card);
    card?.querySelector('[data-shot-field="videoPrompt"]')?.focus({ preventScroll: true });
    return node;
  }
  function addPromptDraft(kind, prompt) {
    const position = center(), point = clearSpace({ x: position.x - CARD_WIDTH / 2, y: position.y - CARD_HEIGHT / 2 }, CARD_WIDTH, CARD_HEIGHT);
    const node = kind === 'image' ? addImage(point, null, prompt) : addShot(point, null, null, prompt);
    if (!node) return;
    const view = graph().viewport;
    setViewport({ ...view, x: viewport.clientWidth / 2 - (node.x + node.width / 2) * view.zoom,
      y: viewport.clientHeight / 2 - (node.y + node.height / 2) * view.zoom });
    showCoverDetails(cards.get(node.id));
    return node;
  }
  function addAiScenes(sourceNode) {
    const drafts = normalizeAiConfig(sourceNode?.aiConfig).scenes;
    if (!drafts.length) return bridge.toast('请先运行“拆分分镜”，并确认模型返回了结构化分镜。', true);
    if (!ensureCapacity(drafts.length)) return;
    const created = [];
    try {
      changeGraph(() => {
        const start = { x: sourceNode.x + sourceNode.width + 90, y: sourceNode.y };
        drafts.forEach((draft, index) => {
          const scene = bridge.createScene(draft.videoPrompt || draft.description || draft.visual || '', draft.title);
          scene.visual = draft.visual || draft.description || '';
          scene.narration = draft.narration || '';
          scene.imagePrompt = draft.imagePrompt || '';
          scene.duration = draft.duration || scene.duration;
          const node = baseNode('video', scene.title, clearSpace({
            x: start.x + (index % 3) * (CARD_WIDTH + 90),
            y: start.y + Math.floor(index / 3) * (CARD_HEIGHT + 90),
          }, CARD_WIDTH, CARD_HEIGHT));
          node.sceneId = scene.id;
          graph().nodes.push(node);
          if (!validateCanvasLink(graph(), state().kinds, sourceNode.id, node.id)) graph().links.push(proposedLink(sourceNode.id, node.id));
          created.push(node);
        });
        selection = new Set(created.map(node => node.id)); selectedLink = '';
      });
      bridge.toast(`已创建 ${created.length} 个视频镜头草稿，请逐项检查后再生成。`);
    } catch (error) { report(error); }
    return created;
  }
  function addAsset(asset, point, { allowRelink = true, avoidOverlap = false } = {}) {
    if (!project() || !asset || !project().assets.some(item => !item.deletedAt && item.id === asset.id)) return;
    if (allowRelink && relinkNodeId) {
      const target = graph().nodes.find(node => node.id === relinkNodeId);
      if (target && target.kind !== asset.kind) return bridge.toast('请选择与卡片类型相同的素材。', true);
      if (target && target.assetId !== asset.id) {
        const nodes = new Map(graph().nodes.map(node => [node.id, node]));
        const linkedScenes = new Set(graph().links.filter(link => link.from === target.id)
          .map(link => nodes.get(link.to)).filter(node => node?.kind === 'video' && node.sceneId).map(node => node.sceneId));
        const duplicate = project().scenes.some(scene => linkedScenes.has(scene.id)
          && resolveSceneReferences(project(), scene).some(reference => reference.kind === asset.kind
            && reference.assetId === asset.id && reference.nodeId !== target.id));
        if (duplicate) return bridge.toast('该素材已用于当前卡片关联的视频生成项，请选择其他素材。已有参考及提示词引用会保留。', true);
      }
      if (target) {
        changeGraph(() => { target.assetId = asset.id; target.assetName = asset.name; target.status = 'uploaded'; selection = new Set([target.id]); });
        relinkNodeId = ''; assetsPanel.hidden = true; return target;
      }
      relinkNodeId = '';
    }
    const existing = graph().nodes.find(node => !node.sceneId && node.assetId === asset.id);
    if (existing) {
      selection = new Set([existing.id]); selectedLink = ''; assetsPanel.hidden = true; panelPoint = null;
      render(); return existing;
    }
    if (!ensureCapacity()) return;
    let node;
    changeGraph(() => {
      node = avoidOverlap ? createAssetCanvasNode(asset, graph(), place(point, CARD_WIDTH, CARD_HEIGHT))
        : baseNode(asset.kind, asset.name.slice(0, 80), point);
      Object.assign(node, { assetId: asset.id, assetName: asset.name, status: 'uploaded' });
      graph().nodes.push(node); selection = new Set([node.id]); selectedLink = '';
    });
    return node;
  }
  function syncScenes({ sceneIds } = {}) {
    if (!project()) return;
    const requested = Array.isArray(sceneIds) ? new Set(sceneIds) : null;
    const present = new Set(graph().nodes.map(node => node.sceneId));
    const scenes = project().scenes.filter(scene => !present.has(scene.id) && (!requested || requested.has(scene.id)));
    if (!scenes.length) { bridge.toast(project().scenes.length ? '现有视频卡片已经在画布上了。' : '先添加一个视频，或在创作需求中整理视频方案。'); return; }
    if (!ensureCapacity(scenes.length)) return;
    const bounds = selectionBounds(graph().nodes), x = bounds ? bounds.x + bounds.width + 110 : center().x - CARD_WIDTH / 2;
    const y = bounds?.y ?? center().y - CARD_HEIGHT / 2;
    changeGraph(() => {
      const ids = [];
      scenes.forEach((scene, index) => { const node = baseNode('video', scene.title, { x: x + index % 3 * (CARD_WIDTH + 90), y: y + Math.floor(index / 3) * (CARD_HEIGHT + 90) });
        node.sceneId = scene.id; graph().nodes.push(node); ids.push(node.id); });
      selection = new Set(ids); selectedLink = '';
    });
    fit(); bridge.toast(`已放入 ${scenes.length} 张视频卡片，可编辑提示词、时长和生成数量。`);
  }
  function deleteSelection() {
    if (!selection.size && !selectedLink) return;
    changeGraph(() => {
      const ids = new Set(selection); graph().nodes = graph().nodes.filter(node => !ids.has(node.id));
      graph().links = graph().links.filter(link => !ids.has(link.from) && !ids.has(link.to) && link.id !== selectedLink);
      graph().groups = (graph().groups || []).map(group => ({ ...group, nodeIds: group.nodeIds.filter(id => !ids.has(id)) })).filter(group => group.nodeIds.length > 1);
      selection.clear(); selectedLink = ''; connectionFrom = '';
    });
    bridge.toast('已移除画布卡片或连接，素材、视频生成项和任务仍保留。');
  }
  function createGroup() {
    const nodeIds = graph().nodes.filter(node => selection.has(node.id)).map(node => node.id);
    if (nodeIds.length < 2) return bridge.toast('请先框选至少两张卡片，再创建分组。', true);
    if ((graph().groups || []).length >= 60) return bridge.toast('每个画布最多创建 60 个分组。', true);
    const groupId = uid();
    if (!changeGraph(() => {
      graph().groups ||= [];
      graph().groups.push({ id: groupId, label: '新分组', color: '#a9560b', nodeIds });
      selection = new Set(nodeIds); selectedLink = '';
    })) return;
    const members = graph().nodes.filter(node => nodeIds.includes(node.id));
    if (members.length) setViewport(fitViewport(members, { width: viewport.clientWidth, height: viewport.clientHeight }, 110));
    renderGroups();
    const nameInput = groupsLayer.querySelector(`[data-canvas-group-field="label"][data-group-id="${groupId}"]`);
    nameInput?.focus(); nameInput?.select();
    bridge.toast('请输入分组名称，按回车确认并返回选择工具；可用色块更改背景颜色。');
  }
  function dissolveGroup(groupId) {
    if (!(graph().groups || []).some(group => group.id === groupId)) return;
    if (!changeGraph(() => { graph().groups = graph().groups.filter(group => group.id !== groupId); })) return;
    bridge.toast('分组已解散，卡片和生成内容均保留。');
  }
  function duplicateSelection() {
    const selected = graph().nodes.filter(node => selection.has(node.id)); if (!selected.length || !ensureCapacity(selected.length)) return;
    // A duplicated shot shares the scene; creating a new scene is a separate explicit action.
    changeGraph(() => {
      const mapping = new Map(), copies = selected.map(node => { const next = { ...clone(node), id: uid(), x: coordinate(node.x + 48), y: coordinate(node.y + 48) };
        if (isImageGenerationNode(next)) Object.assign(next,{imageJobId:'',imageJobIds:[],selectedAssetId:'',assetId:'',assetName:'',status:'pending'});
        mapping.set(node.id, next.id); return next; });
      const links = graph().links.filter(link => mapping.has(link.from) && mapping.has(link.to))
        .filter(link => !isImageGenerationNode(selected.find(node => node.id === link.from)))
        .map(link => ({ ...clone(link), id: uid(), from: mapping.get(link.from), to: mapping.get(link.to) }));
      graph().nodes.push(...copies); graph().links.push(...links.slice(0, 160 - graph().links.length));
      const copiedGroups = (graph().groups || []).filter(group => group.nodeIds.every(id => mapping.has(id)))
        .map(group => ({ id: uid(), label: group.label + ' 副本', color: group.color, nodeIds: group.nodeIds.map(id => mapping.get(id)) }));
      graph().groups.push(...copiedGroups);
      selection = new Set(copies.map(node => node.id)); selectedLink = '';
    });
    if (selected.some(node => node.sceneId)) bridge.toast('已复制卡片；视频卡片仍关联同一生成项。新建视频请点画布工具栏的“视频”。');
  }
  function arrange() {
    if (!graph().nodes.length) return;
    changeGraph(() => {
      const nodes = graph().nodes, columns = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(nodes.length))));
      const width = Math.max(...nodes.map(node => node.width)) + 90, height = Math.max(...nodes.map(node => node.height)) + 90;
      nodes.forEach((node, index) => { node.x = 80 + index % columns * width; node.y = 60 + Math.floor(index / columns) * height; });
    }); fit();
  }

  function mediaMarkup(asset, className = 'canvas-media', cover = false) {
    const src = `/api/assets/${encodeURIComponent(asset.id)}`;
    if (asset.kind === 'image') return `<img class="${className}" src="${assetThumbnailUrl(asset.id)}" alt="${escapeHtml(asset.name)}" loading="lazy" draggable="false">`;
    if (asset.kind === 'audio') return `<div class="canvas-audio-art">♫</div><audio class="${className}" controls preload="none" src="${src}" aria-label="${escapeHtml(asset.name)}"></audio>`;
    if (cover) return `<video class="${className}" data-cover-video playsinline preload="none" poster="${assetThumbnailUrl(asset.id)}" data-media-src="${src}" aria-label="${escapeHtml(asset.name)}"></video>`;
    return `<img class="${className}" src="${assetThumbnailUrl(asset.id)}" alt="${escapeHtml(asset.name)}视频缩略图" loading="lazy" draggable="false">`;
  }
  function defaultCoverMarkup(kind, title) {
    const iconName = { text: 'Text', ai: 'Sparkles', image: 'Image', video: 'Clapperboard', audio: 'AudioLines',
      brief: 'Compass', script: 'FileText', storyboard: 'LayoutGrid', compose: 'GalleryHorizontal' }[kind] || 'LayoutGrid';
    const icon = bridge.icon?.(iconName) || info[kind]?.[0] || '✦';
    return `<div class="canvas-simple-preview canvas-frosted-placeholder"><span class="canvas-frosted-icon" aria-hidden="true">${icon}</span><strong>${escapeHtml(title)}</strong></div>`;
  }
  function detailHeading(node, kicker, title, hasVideo = false) {
    return `<div class="canvas-detail-heading"><div><span class="canvas-detail-kicker">${escapeHtml(kicker)}</span><input class="canvas-detail-title" data-node-field="label" aria-label="卡片名称" value="${escapeHtml(title)}" maxlength="80" spellcheck="false"></div><div class="canvas-detail-actions">${hasVideo ? '<button type="button" class="canvas-cover-play" data-card-action="play-cover" aria-label="播放视频" title="播放或暂停视频">播放</button>' : ''}<button type="button" class="canvas-detail-remove" data-card-action="remove" aria-label="移除卡片" title="移除画布卡片，保留原素材">移除</button><button type="button" data-card-action="close-details" aria-label="关闭卡片详情" title="关闭详情">×</button></div></div>`;
  }
  function assetMarkup(node) {
    const asset = project().assets.find(item => !item.deletedAt && item.id === node.assetId);
    if (!asset) return `<div class="canvas-missing"><span>${info[node.kind][0]}</span><strong>${escapeHtml(node.assetName || '素材尚未关联')}</strong><p>素材已移除或尚未关联，请重新选择素材。</p><button class="button" data-card-action="relink">选择${{ image: '图片', video: '视频', audio: '声音' }[node.kind]}</button></div>`;
    const cover = ['image', 'video'].includes(asset.kind);
    return `${cover ? `<div class="canvas-cover">${mediaMarkup(asset, 'canvas-media', true)}<div class="canvas-cover-drag" data-cover-drag aria-hidden="true"></div></div><div class="canvas-hover-details" aria-label="${escapeHtml(node.label)}详情">${detailHeading(node, '画布素材', node.label, asset.kind === 'video')}<div class="canvas-details-content">` : mediaMarkup(asset)}<div class="canvas-media-meta"><span>${{ image: '图片', video: '视频', audio: '声音' }[asset.kind]}${asset.duration ? ` · ${Number(asset.duration).toFixed(1)} 秒` : ''}</span><span>${asset.source === 'model' ? '模型生成' : '本机素材'}</span></div>
      <div class="canvas-node-footer"><span class="canvas-reference-hint">${asset.kind === 'audio' ? '可连接到支持音频输入的视频模型；其他模型会忽略音频' : ['image', 'video'].includes(asset.kind) ? '右侧端口可连接到其他视频卡片' : ''}</span><button data-card-action="preview">放大预览 ↗</button><a href="/api/assets/${encodeURIComponent(asset.id)}?download=1" download>下载原文件 ↓</a></div>${cover ? '</div></div>' : ''}`;
  }
  function shotData(scene, node) {
    const rawParameters = bridge.parameters(scene) || {};
    const p = { ...rawParameters,
      ratios: Array.isArray(rawParameters.ratios) ? rawParameters.ratios : [],
      resolutions: Array.isArray(rawParameters.resolutions) ? rawParameters.resolutions : [],
      durations: Array.isArray(rawParameters.durations) ? rawParameters.durations : [],
      count: Number.isInteger(rawParameters.count) && rawParameters.count > 0 ? rawParameters.count : 1,
      ratio: rawParameters.ratio || scene.ratio || '',
      resolution: rawParameters.resolution || scene.resolution || '',
    };
    const jobs = state().jobs.filter(job => job.sceneId === scene.id);
    const active = jobs.find(job => activeStates.has(job.state)), submitting = state().submitting.has(scene.id);
    const assets = project().assets.filter(asset => !asset.deletedAt && asset.kind === 'video' && asset.source === 'model' && asset.sceneId === scene.id);
    const chosen = project().assets.find(asset => !asset.deletedAt && asset.id === scene.videoAssetId && asset.kind === 'video');
    const previewId = cards.get(node.id)?.dataset.previewAsset;
    const preview = assets.find(asset => asset.id === previewId) || chosen || assets.at(-1);
    const references = resolveSceneReferences(project(), scene), invalid = invalidPromptMentions(scene, references);
    const referenceIssue = referenceRequestIssue(p.model, references, { allowLocalUpload: Boolean(state().settings.storage?.ready),assets:project().assets });
    const pending = state().videoOperations?.has(project().id + ':' + scene.id);
    const skillIssue = generationSkillIssue(state().skills, scene.videoSkillId, scene.videoPrompt, 'video');
    const disabled = submitting || !pending && (!state().settings.hasKey || !p.tier || Boolean(referenceIssue) || invalid.length > 0 || Boolean(skillIssue) || !scene.videoPrompt.trim());
    const label = submitting ? '提交中…' : pending ? '核对上次提交 ↗' : p.issue ? '请确认模型参数' : invalid.length ? '请修复提示词引用' : referenceIssue ? '请完善参考设置'
      : `${jobs.length || assets.length ? '再次生成' : '生成'} ${p.count} 个${p.count > 1 ? '候选' : ''}视频 ↗`;
    const estimate = videoEstimateText(p);
    const hint = active ? `${labels[active.state]}${active.progress != null ? ` · ${active.progress}%` : ''} · 在“视频生成”查看任务`
      : !state().settings.hasKey ? '请在连接中心配置视频模型。'
      : p.issue ? p.issue : invalid.length ? '提示词中有已断开或未知的素材引用，请重新连接或删除这些引用。'
      : referenceIssue || skillIssue || '';
    return { p, jobs, active, submitting, assets, chosen, preview, references, invalid, disabled, label, estimate, hint };
  }
  const option = (value, label, current) => `<option value="${escapeHtml(value)}"${String(value) === String(current) ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  function referenceMarkup(scene) {
    const references = resolveSceneReferences(project(), scene);
    return '<section class="shot-references" aria-label="当前视频参考素材"><div class="shot-reference-heading"><strong>已关联素材 · ' + references.length + '</strong><small>点击缩略图插入引用</small></div>'
      + (references.length ? '<div class="shot-reference-list compact-reference-list">' + references.map((reference,index) => {
        const label = referenceLabel(references,index), asset = project().assets.find(item => !item.deletedAt && item.id === reference.assetId);
        const thumb = asset ? ['image', 'video'].includes(asset.kind) ? '<img loading="lazy" draggable="false" src="' + assetThumbnailUrl(asset.id) + '" alt="">' : '<span>♫</span>' : '<span>?</span>';
        const key = escapeHtml(referenceKey(reference)), source = referenceSource(reference);
        const role = reference.role === 'end_frame' ? 'last_frame' : reference.role || 'reference_image';
        const roleControl = reference.kind === 'image' && bridge.parameters(scene)?.model?.referenceSupport?.protocol === 'content-v3'
          ? '<label class="canvas-reference-role"><select data-canvas-reference-role="' + key + '" aria-label="' + label + '图片用途">'
            + [['reference_image', '通用参考图片'], ['first_frame', '首帧'], ['last_frame', '尾帧']].map(([value, label]) => option(value, label, role)).join('') + '</select></label>' : '';
        return '<div class="shot-reference-item" data-canvas-reference-key="' + key + '"><button type="button" class="canvas-reference-insert" data-card-action="insert-reference" data-reference-key="' + key + '" aria-label="插入 @' + label + ' 到提示词" title="插入 @' + label + '：' + escapeHtml(reference.name) + '"' + (asset ? '' : ' disabled') + '><span class="shot-reference-thumb">' + thumb + '</span><span class="reference-number">@' + label + '</span></button>'
          + (source ? '<button type="button" class="canvas-reference-locate" data-card-action="locate-reference" data-reference-key="' + key + '" aria-label="定位' + label + '来源卡片" title="定位' + label + '来源卡片">&#8982;</button>' : '')
          + '<button type="button" data-card-action="' + (reference.nodeId ? 'disconnect-reference' : 'details') + '" data-reference-node="' + escapeHtml(reference.nodeId || '') + '" aria-label="' + (reference.nodeId ? '断开' : '编辑') + label + '" title="' + (reference.nodeId ? '断开连接，保留原文件' : '在视频详情编辑此素材') + '">' + (reference.nodeId ? '×' : '↗') + '</button>' + roleControl + '</div>';
      }).join('') + '</div>' : '<p class="shot-reference-empty">从素材卡连线添加参考，点击缩略图即可插入引用。</p>') + (references.length ? '<button type="button" data-card-action="details">' + (state().settings.storage?.ready ? '查看参考素材 ↗' : '设置素材链接 ↗') + '</button>' : '') + '</section>';
  }
  function shotMarkup(scene, node) {
    const { p, active, submitting, assets, preview, disabled, label, estimate, hint } = shotData(scene, node);
    const controls = videoParameterControls(p, state().catalog || [], state().settings.generationCountMax || 5, submitting, scene.videoModel || state().settings.videoModel);
    return `<div class="canvas-cover shot-preview">${preview ? mediaMarkup(preview, 'canvas-media', true) : defaultCoverMarkup('video', 'AI 视频')}<div class="canvas-cover-drag" data-cover-drag aria-hidden="true"></div></div>
      <div class="canvas-hover-details" aria-label="${escapeHtml(scene.title)}详情">${detailHeading(node, '视频创作', scene.title, Boolean(preview))}<div class="canvas-details-content canvas-composer">
      <label class="reference-prompt-editor"><span class="canvas-prompt-label">视频提示词</span><textarea class="shot-prompt" data-reference-prompt data-shot-field="videoPrompt" aria-label="${escapeHtml(scene.title)}视频提示词" rows="4" maxlength="4000" placeholder="描述主体、动作、场景、运镜和风格…">${escapeHtml(scene.videoPrompt)}</textarea><div class="reference-mention-menu" role="listbox" aria-label="可引用的素材" hidden></div></label>
      ${generationSkillControl(state().skills || [], scene.videoSkillId, { field: 'data-shot-field="videoSkillId"', disabled: submitting, canvas: true, icon: bridge.icon?.('Library') || '' })}
      ${referenceMarkup(scene)}
      <div class="canvas-composer-toolbar"><div class="shot-params canvas-composer-controls">${Object.entries(controls).map(([field, config]) => `<label><span class="canvas-option-label">${config.label}</span><select data-shot-field="${field}" aria-label="${escapeHtml(scene.title)}${config.label}" title="${config.label}"${config.disabled ? ' disabled' : ''}>${config.options.map(item => option(item.value, item.label, config.value)).join('')}</select></label>`).join('')}</div><div class="shot-estimate canvas-composer-cost"><strong>${escapeHtml(estimate)}</strong><small>${escapeHtml(p.model?.name || '')} · ${escapeHtml(videoPricingNote(p))}</small></div><button class="primary shot-generate canvas-composer-submit" data-card-action="generate" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button></div>
      <p class="shot-hint"${active || disabled ? '' : ' hidden'}>${escapeHtml(hint)}</p>
      <details class="canvas-composer-more"><summary>更多设置</summary><button type="button" class="text-button" data-model-capability="video" data-capability-model="${escapeHtml(p.model?.name || '')}">模型能力</button></details>
      ${assets.length ? `<div class="shot-candidates"><div><strong>候选视频 · ${assets.length}</strong><button data-card-action="expand-candidates">展开对比 ↗</button></div><select data-preview-candidate aria-label="${escapeHtml(scene.title)}预览候选视频">${assets.map((asset, index) => option(asset.id, `${asset.variantIndex || index + 1} · ${asset.name}${asset.id === scene.videoAssetId ? ' ✓ 当前结果' : ''}`, preview?.id)).join('')}</select><div class="canvas-node-footer"><button data-card-action="select-candidate" data-asset-id="${escapeHtml(preview?.id || '')}"${preview?.id === scene.videoAssetId ? ' disabled' : ''}>${preview?.id === scene.videoAssetId ? '✓ 当前结果' : '设为当前结果'}</button>${preview ? `<button data-card-action="place-asset" data-asset-id="${escapeHtml(preview.id)}">放到画布</button><a href="/api/assets/${encodeURIComponent(preview.id)}?download=1" download>下载 ↓</a>` : ''}</div></div>` : ''}
      ${preview ? '<div class="canvas-node-footer"><button data-card-action="preview-cover">放大预览 ↗</button></div>' : ''}</div></div>`;
  }

  function imageData(node) {
    const config = normalizeImageConfig(node.imageConfig);
    const models = state().imageCatalog || [], inputs = resolveImageInputs(project(),node);
    const model = models.find(item => item.name === config.model);
    const estimate = imageEstimate(model, config);
    const jobs = (state().imageJobs || []).filter(job => job.nodeId === node.id);
    const latestJob = jobs.find(job => job.id === node.imageJobId) || jobs[0];
    const currentIds = new Set(Array.isArray(node.imageJobIds) && node.imageJobIds.length ? node.imageJobIds : [latestJob?.id].filter(Boolean));
    const job = jobs.find(job => currentIds.has(job.id) && IMAGE_ACTIVE_STATES.has(job.state)) || latestJob;
    const asset = project().assets.find(asset => !asset.deletedAt && asset.kind === 'image' && asset.id === node.assetId);
    const allCandidates = project().assets.filter(item => !item.deletedAt && item.kind === 'image'
      && item.source === 'model' && item.nodeId === node.id);
    const batchAssetIds = new Set(jobs.filter(item => currentIds.has(item.id) && item.assetId).map(item => item.assetId));
    const candidates = (batchAssetIds.size ? allCandidates.filter(item => batchAssetIds.has(item.id)) : allCandidates).slice();
    if (asset && !candidates.some(item => item.id === asset.id)) candidates.push(asset);
    candidates.sort((left,right) => (left.variantIndex || 1) - (right.variantIndex || 1)
      || String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
    const previewId = cards.get(node.id)?.dataset.previewAsset;
    const preview = candidates.find(item => item.id === previewId) || asset || candidates.at(-1) || null;
    const submitting = state().submitting.has('image:'+node.id), active = job && IMAGE_ACTIVE_STATES.has(job.state);
    const issue = imageRequestIssue(config,inputs,model) || generationSkillIssue(state().skills, config.skillId, config.prompt);
    const pending=state().imageOperations?.has(project().id+':'+node.id);
    const modelIssue = !config.model ? '请选择生图模型。' : models.length && !models.some(model => model.name === config.model) ? '所选模型不在当前目录中，请在详情中重新选择。' : '';
    const disabled = submitting || active || !pending && (!state().settings.image?.hasKey || Boolean(issue || modelIssue));
    const label = pending && !submitting ? '核对本次提交 ↗' : submitting ? '提交中…' : job?.state === 'uncertain' ? '请先核对平台记录' : active ? '原任务处理中…' : inputs.references.length ? '参考图片生成 ↗' : asset ? '再次生成图片 ↗' : '生成图片 ↗';
    const hint = active ? job.message : !state().settings.image?.hasKey ? '请在连接中心配置图片模型。'
      : (issue || modelIssue) ? (issue || modelIssue)
      : '';
    return {config,models,model,inputs,job,asset,preview,candidates,submitting,active,disabled,label,hint,estimate};
  }
  const imageOption = (id,label,value) => `<option value="${escapeHtml(id)}"${id === value ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  function imageCover(asset) {
    return `${asset ? mediaMarkup(asset,'canvas-media',true) : defaultCoverMarkup('image', 'AI 生图')}<div class="canvas-cover-drag" data-cover-drag aria-hidden="true"></div>`;
  }
  function imageInputsMarkup(node,inputs) {
    if (!inputs.references.length && !inputs.textInputs.length) return '<div class="image-inputs shot-references"><strong>已关联素材 · 0</strong></div>';
    const items = inputs.references.map((reference,index) => {
      const link = graph().links.find(link => link.to === node.id && link.from === reference.nodeId);
      const key = escapeHtml(referenceKey(reference)), label = referenceLabel(inputs.references,index);
      const asset = project().assets.find(item => !item.deletedAt && item.id === reference.assetId);
      const thumb = asset ? `<img src="${assetThumbnailUrl(asset.id)}" alt="${escapeHtml(asset.name)}" loading="lazy" draggable="false">` : '<span class="image-reference-empty">▧</span>';
      const insert = `<button type="button" class="canvas-reference-insert" data-card-action="insert-reference" data-reference-key="${key}" aria-label="插入 @${label} 到提示词" title="插入 @${label}：${escapeHtml(reference.name)}"${asset && reference.kind === 'image' ? '' : ' disabled'}><span class="shot-reference-thumb">${thumb}</span><span class="reference-number">@${label}</span></button>`;
      return `<div class="image-reference-row" data-canvas-reference-key="${key}" title="${label}：${escapeHtml(reference.name)}">${insert}${referenceSource(reference) ? `<button type="button" class="canvas-reference-locate" data-card-action="locate-reference" data-reference-key="${key}" aria-label="定位${label}来源卡片" title="定位${label}来源卡片">&#8982;</button>` : ''}<button type="button" data-card-action="image-disconnect" data-link-id="${escapeHtml(link?.id || '')}" aria-label="断开${label}" title="断开连接，保留原文件">×</button></div>`;
    }).join('');
    const texts = inputs.textInputs.map(input => `<p class="image-text-input">Ｔ ${escapeHtml(input.name)} · ${escapeHtml(input.text.slice(0,80))}${input.text.length>80?'…':''}</p>`).join('');
    return `<div class="image-inputs shot-references"><div class="shot-reference-heading"><strong>已关联素材 · ${inputs.references.length} 张图片 / ${inputs.textInputs.length} 条文字</strong><small>点击缩略图插入引用</small></div><div class="compact-image-references">${items}</div>${texts}</div>`;
  }
  function imageMarkup(node) {
    const {config,models,model,inputs,job,asset,preview,candidates,submitting,disabled,label,hint,estimate} = imageData(node);
    const missingModel = config.model && !models.some(model => model.name === config.model);
    const selected = Boolean(preview?.id && preview.id === node.selectedAssetId);
    return `<div class="canvas-cover">${imageCover(preview)}</div><div class="canvas-hover-details" aria-label="${escapeHtml(node.label)}详情">${detailHeading(node, '图片创作', node.label)}<div class="canvas-details-content image-details canvas-composer">
      <label class="reference-prompt-editor image-prompt-lead"><span class="canvas-prompt-label">图片提示词</span><textarea data-reference-prompt data-image-field="prompt" aria-label="图片提示词" rows="4" maxlength="4000" placeholder="描述主体、场景、构图、光线和风格…">${escapeHtml(config.prompt)}</textarea><div class="reference-mention-menu" role="listbox" aria-label="可引用的参考图片" hidden></div></label>
      ${generationSkillControl(state().skills || [], config.skillId, { field: 'data-image-field="skillId"', disabled: submitting, canvas: true, icon: bridge.icon?.('Library') || '' })}
      ${imageInputsMarkup(node,inputs)}
      <div class="canvas-composer-toolbar"><div class="shot-fields image-fields canvas-composer-controls">
      <label><span class="canvas-option-label">生图模型</span><select data-image-field="model" aria-label="生图模型" title="生图模型">${!config.model ? imageOption('','请选择生图模型',config.model):''}${missingModel ? imageOption(config.model,config.model,config.model):''}${models.map(model => imageOption(model.name,model.name,config.model)).join('')}</select></label>
      <label><span class="canvas-option-label">比例</span><select data-image-field="ratio" aria-label="生图比例" title="比例">${IMAGE_RATIOS.filter(([id])=>!model?.capabilities || model.capabilities.ratios.includes(id)).map(([id,label]) => imageOption(id,label,config.ratio)).join('')}</select></label>
      <label><span class="canvas-option-label">画质</span><select data-image-field="quality" aria-label="生图画质" title="画质">${IMAGE_QUALITIES.filter(([id])=>!model?.capabilities || model.capabilities.qualities.includes(id)).map(([id,label]) => imageOption(id,label,config.quality)).join('')}</select></label>
      <label><span class="canvas-option-label">张数</span><select data-image-field="count" aria-label="生图生成张数" title="张数">${Array.from({length:IMAGE_GENERATION_COUNT_MAX},(_,index) => imageOption(index+1,(index+1)+' 张',config.count)).join('')}</select></label>
      </div><div class="shot-estimate image-estimate canvas-composer-cost"><strong>${escapeHtml(imageEstimateText(estimate))}</strong><small>最终扣费以平台为准</small></div><button class="primary image-generate canvas-composer-submit" data-card-action="image-generate" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button></div>
      <p class="shot-hint image-submit-hint"${disabled ? '' : ' hidden'}>${escapeHtml(hint)}</p>
      <details class="canvas-composer-more"><summary>更多设置</summary><label>风格<select data-image-field="style" aria-label="生图风格">${IMAGE_STYLES.map(([id,label]) => imageOption(id,label,config.style)).join('')}</select></label><button type="button" class="text-button" data-model-capability="image" data-capability-model="${escapeHtml(config.model)}">模型能力</button></details>
      <button class="text-button image-refresh" data-card-action="image-refresh"${job ? '' : ' hidden'}>刷新任务状态</button>
      <div class="image-job-status" role="status" aria-live="polite"${job ? '' : ' hidden'}>${escapeHtml(job ? (labels[job.state] || job.state) + ' · ' + job.message : '')}</div>
      <button class="button full image-retry" data-card-action="image-retry"${job?.state === 'download_pending' ? '' : ' hidden'}>重试保存图片</button>
      ${job ? `<details class="image-submitted-prompt"><summary>查看实际提交的提示词</summary><pre>${escapeHtml(job.prompt)}</pre></details>` : ''}
      ${candidates.length > 1 ? `<section class="image-candidates" aria-label="候选图片"><div class="image-candidates-heading"><strong>候选图片 · ${candidates.length}</strong></div><select data-preview-candidate aria-label="预览候选图片">${candidates.map((item,index) => imageOption(item.id,`候选 ${item.variantIndex || index + 1} · ${item.name}${item.id === node.selectedAssetId ? ' ✓ 最终素材' : item.id === asset?.id ? ' · 当前素材' : ''}`,preview?.id)).join('')}</select><div class="canvas-node-footer image-output-actions"><button data-card-action="select-image-candidate" data-asset-id="${escapeHtml(preview?.id || '')}"${selected ? ' disabled' : ''}>${selected ? '✓ 最终素材' : '设为最终素材'}</button>${preview ? `<button data-card-action="preview" data-asset-id="${escapeHtml(preview.id)}">放大预览 ↗</button><a href="/api/assets/${encodeURIComponent(preview.id)}?download=1" download>下载图片 ↓</a>` : ''}</div></section>` : ''}
      ${asset ? `<div class="canvas-node-footer image-output-actions"><button data-card-action="preview" data-asset-id="${escapeHtml(asset.id)}">放大预览 ↗</button><a href="/api/assets/${encodeURIComponent(asset.id)}?download=1" download>下载图片 ↓</a><button data-card-action="image-create-next">继续生图</button><button data-card-action="image-create-video">创建视频卡</button></div>` : ''}
      </div></div>`;
  }

  function aiMarkup(node) {
    const config = normalizeAiConfig(node.aiConfig), inputs = bridge.aiInputs?.(node.id) || [];
    const models = state().textCatalog || [], selectedModel = config.model || state().settings.text?.textModel || models[0]?.name || '';
    const modelOptions = models.length ? models.map(model => option(model.name, model.name, selectedModel)).join('')
      : selectedModel ? option(selectedModel, selectedModel, selectedModel) : '<option value="">请先连接语言模型</option>';
    const busy = Boolean(bridge.isAiBusy?.(node.id));
    const ready = Boolean(state().settings.text?.hasKey && selectedModel);
    const status = busy ? '正在生成…' : ({ done: '已生成结果', error: '上次生成失败', idle: '尚未运行' }[config.status] || '尚未运行');
    const hasScenes = config.mode === 'storyboard' && config.scenes.length > 0;
    return `<div class="ai-card-content">
      <div class="ai-card-heading"><strong>AI 创作卡</strong><span>${escapeHtml(status)}</span></div>
      <div class="ai-card-input-summary"><strong>上游输入 · ${inputs.length} 项</strong>${inputs.length ? inputs.slice(0, 3).map(input => `<span>${escapeHtml(input.label)}：${escapeHtml(input.text.slice(0, 90))}${input.text.length > 90 ? '…' : ''}</span>`).join('') : '<span>可从文字便签、创作需求或其他 AI 卡片连入文字。</span>'}</div>
      <div class="ai-card-fields"><label>创作任务<select data-ai-field="mode" aria-label="AI 创作任务"${busy ? ' disabled' : ''}>${AI_MODES.map(mode => option(mode.id, mode.label, config.mode)).join('')}</select></label>
      <label>使用模型<select data-ai-field="model" aria-label="语言模型"${busy ? ' disabled' : ''}>${modelOptions}</select></label></div>
      <div class="ai-skill-control"><label>使用技能<select data-ai-field="skillId" aria-label="技能"${busy ? ' disabled' : ''}>${[{ id: '', name: '不使用技能' }, ...(config.skillId && !(state().skills || []).some(skill => skill.id === config.skillId) ? [{ id: config.skillId, name: '所选技能已删除或未导入' }] : []), ...(state().skills || [])].map(skill => option(skill.id, skill.name, config.skillId)).join('')}</select></label><button data-card-action="ai-manage-skills" type="button" class="skill-manage-button" title="管理技能库" aria-label="管理技能库">${bridge.icon?.('Library') || ''}</button></div>
      <label>具体要求<textarea data-ai-field="instruction" rows="5" placeholder="例如：保持人物外观不变，拆成 3 个镜头，并补充每个镜头的运镜和光线。"${busy ? ' disabled' : ''}>${escapeHtml(config.instruction)}</textarea></label>
      <button class="primary full ai-run" data-card-action="ai-run"${busy || !ready ? ' disabled' : ''}>${busy ? '生成中…' : '运行语言模型 ↗'}</button>
      <p class="shot-hint ai-hint">${escapeHtml(!state().settings.text?.hasKey ? '请在连接中心配置语言模型。' : !selectedModel ? '请刷新并选择语言模型。' : '')}</p>
      ${config.error ? `<p class="ai-error">${escapeHtml(config.error)}</p>` : ''}
      <label>当前结果<textarea class="ai-output" data-ai-field="output" rows="10" placeholder="运行后，模型结果会出现在这里；你也可以手动修改。">${escapeHtml(config.output)}</textarea></label>
      ${bridge.aiImagesMarkup?.(node) || ''}
      <div class="canvas-node-footer ai-output-actions"><span>${config.output ? '结果可继续连接到下游卡片' : '先生成或手动填写结果'}</span>${config.output ? '<button data-card-action="ai-create-text">另存文字卡</button>' : ''}</div>
      <div class="ai-create-actions"><button class="button" data-card-action="ai-create-image"${config.output ? '' : ' disabled'}>创建生图卡</button><button class="button" data-card-action="ai-create-video"${config.output ? '' : ' disabled'}>创建视频卡</button><button class="button" data-card-action="ai-create-speech"${config.output ? '' : ' disabled'}>生成配音</button>${hasScenes ? `<button class="button" data-card-action="ai-create-scenes">创建 ${config.scenes.length} 个镜头</button>` : ''}</div>
    </div>`;
  }
  function refreshImageControls(card,node) {
    const data = imageData(node), button = card.querySelector('.image-generate');
    const skillNote = card.querySelector('.generation-skill-note');
    if (skillNote) {
      const issue = generationSkillIssue(state().skills, data.config.skillId, data.config.prompt);
      skillNote.textContent = issue || generationSkillNote(state().skills, data.config.skillId);
      skillNote.hidden = !data.config.skillId;
      skillNote.classList.toggle('error', Boolean(issue));
    }
    for(const [field,fallback] of [['ratio',IMAGE_RATIOS],['quality',IMAGE_QUALITIES]]) {
      const control=card.querySelector(`[data-image-field="${field}"]`);if(!control)continue;
      const values=data.model?.capabilities?.[field==='ratio'?'ratios':'qualities'] || fallback.map(([value])=>value);
      const selected=data.config[field],valid=values.includes(selected),labels=new Map(fallback);
      const choices=values.map(value=>({value,label:labels.get(value)||value}));
      if(!valid)choices.unshift({value:'',label:'请选择可用'+(field==='ratio'?'比例':'画质')+'（原：'+selected+'）',disabled:true});
      const previous=Array.from(control.options || []);
      if(previous.length!==choices.length || previous.some((item,i)=>item.value!==choices[i].value || item.textContent!==choices[i].label)) {
        control.innerHTML=choices.map(choice=>`<option value="${escapeHtml(choice.value)}"${choice.disabled?' disabled':''}>${escapeHtml(choice.label)}</option>`).join('');
      }
      control.value=valid?selected:'';
    }
    const summary=card.querySelector('.image-capability-summary');if(summary)summary.textContent=capabilitySummary(data.model?.capabilities,'image');
    const capability=card.querySelector('[data-model-capability="image"]');if(capability)capability.dataset.capabilityModel=data.config.model;
    if (button) { button.disabled=data.disabled; button.textContent=data.label; button.setAttribute('aria-label',data.label); button.setAttribute('title',data.label); }
    const hint = card.querySelector('.image-submit-hint'); if (hint) { hint.textContent=data.hint; hint.hidden=!data.disabled; }
    const estimate = card.querySelector('.image-estimate');
    if (estimate) estimate.innerHTML = `<strong>${escapeHtml(imageEstimateText(data.estimate))}</strong><small>按当前图片模型目录估算；最终扣费以平台为准。</small>`;
    const status = card.querySelector('.image-job-status'); if (status) { status.textContent=data.job ? (labels[data.job.state] || data.job.state)+' · '+data.job.message : ''; status.hidden=!data.job; }
    const refresh = card.querySelector('.image-refresh'); if (refresh) refresh.hidden=!data.job;
    const retry = card.querySelector('.image-retry');if (retry) retry.hidden=data.job?.state!=='download_pending';
    if (card.dataset.imageAsset !== (data.asset?.id || '') || card.dataset.imagePreview !== (data.preview?.id || '')) {
      const cover=card.querySelector('.canvas-cover');if (cover) cover.innerHTML=imageCover(data.preview);
      card.dataset.imageAsset=data.asset?.id || ''; card.dataset.imagePreview=data.preview?.id || '';
    }
  }
  function speechData(node) {
    const config = normalizeSpeechDraft(node.speechConfig);
    const jobs = (state().speechJobs || []).filter(item => item.nodeId === node.id);
    const job = jobs[0] || null;
    const asset = project().assets.find(item => !item.deletedAt && item.kind === 'audio' && item.id === (node.assetId || job?.assetId));
    const connection = (state().speechConnections || []).find(item => item.models?.includes(config.model) && item.hasKey);
    const estimate = estimateSpeechCost(config.text, config.model, connection?.baseUrl === 'https://api.minimax.io' ? 'international' : 'domestic');
    const pending = Boolean(bridge.speechPendingForNode?.(node.id));
    const busy = speechSubmitting.has(node.id);
    const blocked = Boolean(job && activeSpeechStates.has(job.state));
    const disabled = busy || blocked || !connection || !config.text.trim() || speechCharacterCount(config.text) > SPEECH_TEXT_LIMIT;
    const label = busy ? '正在提交…' : pending ? '核对上次提交' : blocked ? '原任务处理中' : asset ? '再次生成语音' : '生成语音（可能收费）';
    const status = job ? `${speechLabels[job.state] || job.state} · ${job.message || ''}` : '尚未提交语音任务';
    return { config, job, asset, connection, estimate, pending, disabled, label, status };
  }
  function speechMarkup(node) {
    const { config, job, asset, connection, estimate, disabled, label, status } = speechData(node);
    const models = state().speechCatalog?.length ? state().speechCatalog : SPEECH_MODELS;
    const choices = config.model && !models.includes(config.model) ? [config.model, ...models] : models;
    const voices = state().speechVoices || [];
    return `<div class="canvas-cover canvas-simple-cover speech-cover">${defaultCoverMarkup('audio', '语音生成')}<div class="canvas-cover-drag" data-cover-drag aria-hidden="true"></div></div>
      <div class="canvas-hover-details" aria-label="${escapeHtml(node.label)}详情">${detailHeading(node, '语音创作', node.label)}<div class="canvas-details-content speech-details canvas-composer">
      <label class="speech-card-prompt"><span class="canvas-prompt-label">配音文案</span><textarea data-speech-field="text" aria-label="配音文案" rows="4" maxlength="${SPEECH_TEXT_LIMIT}" placeholder="输入旁白、对白或需要朗读的文字…">${escapeHtml(config.text)}</textarea></label>
      <div class="canvas-composer-toolbar"><div class="canvas-composer-controls speech-card-model-voice"><label><span class="canvas-option-label">语音模型</span><select data-speech-field="model" aria-label="语音模型" title="语音模型">${choices.map(model => option(model, model, config.model)).join('')}</select></label><label><span class="canvas-option-label">音色</span><input data-speech-field="voiceId" aria-label="音色 ID" title="音色 ID" maxlength="256" value="${escapeHtml(config.voiceId)}" placeholder="填写音色 ID"></label></div><div class="speech-card-meta canvas-composer-cost"><span class="speech-card-cost">${estimate ? `预计 ¥${estimate.amount.toFixed(4)}` : '价格以平台为准'}</span></div><button type="button" class="primary speech-card-generate canvas-composer-submit" data-card-action="speech-generate" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button></div>
      <div class="speech-card-count">${speechCharacterCount(config.text)} / ${SPEECH_TEXT_LIMIT} 字符</div>
      ${!connection ? '<button type="button" class="text-button speech-card-connect" data-card-action="speech-connections">连接语音模型 ↗</button>' : ''}
      <details class="speech-card-options canvas-composer-more"><summary>更多设置</summary><div class="speech-card-voice-actions"><button type="button" class="button" data-card-action="speech-voices">读取账户音色</button>${voices.length ? `<select data-speech-voice-select aria-label="选择账户音色"><option value="">选择音色</option>${voices.map(voice => option(voice.id, voice.name || voice.id, config.voiceId)).join('')}</select>` : ''}</div><div class="speech-card-fields"><label>音频格式<select data-speech-field="format">${option('mp3', 'MP3', config.format)}${option('wav', 'WAV', config.format)}</select></label><label>情绪<select data-speech-field="emotion">${SPEECH_EMOTIONS.map(([id, name]) => `<option value="${escapeHtml(id)}"${id === config.emotion ? ' selected' : ''}${speechEmotionSupported(config.model, id) ? '' : ' disabled'}>${escapeHtml(name)}</option>`).join('')}</select></label><label>语速<input type="number" data-speech-field="speed" min="0.5" max="2" step="0.05" value="${escapeHtml(config.speed)}"></label><label>音量<input type="number" data-speech-field="vol" min="0.01" max="10" step="0.01" value="${escapeHtml(config.vol)}"></label><label>音调<input type="number" data-speech-field="pitch" min="-12" max="12" step="1" value="${escapeHtml(config.pitch)}"></label><label>文件名<input data-speech-field="name" maxlength="120" value="${escapeHtml(config.name)}" placeholder="可留空"></label></div></details>
      <div class="speech-card-status" role="status" aria-live="polite"${job ? '' : ' hidden'}>${escapeHtml(status)}</div>
      ${job?.state === 'save_pending' ? '<button type="button" class="button full" data-card-action="speech-save">重试保存已有音频</button>' : ''}
      ${job?.state === 'uncertain' ? '<button type="button" class="text-button" data-card-action="speech-open-page">核对这次任务 ↗</button>' : ''}
      ${asset ? `<div class="speech-card-result"><audio controls preload="none" src="/api/assets/${encodeURIComponent(asset.id)}" aria-label="试听${escapeHtml(asset.name)}"></audio><a class="button" href="/api/assets/${encodeURIComponent(asset.id)}?download=1" download>下载音频 ↓</a></div>` : ''}
      <button type="button" class="text-button speech-card-refresh" data-card-action="speech-refresh"${job ? '' : ' hidden'}>刷新任务状态</button>
      </div></div>`;
  }

  function refreshSpeechControls(card, node) {
    const data = speechData(node);
    const button = card.querySelector('.speech-card-generate');
    if (button) { button.disabled = data.disabled; button.textContent = data.label; button.setAttribute('aria-label',data.label); button.setAttribute('title',data.label); }
    const count = card.querySelector('.speech-card-count');
    if (count) count.textContent = `${speechCharacterCount(data.config.text)} / ${SPEECH_TEXT_LIMIT} 字符`;
    const cost = card.querySelector('.speech-card-cost');
    if (cost) cost.textContent = data.estimate ? `预计 ¥${data.estimate.amount.toFixed(4)}` : '价格以平台为准';
    const status = card.querySelector('.speech-card-status');
    if (status) { status.textContent = data.status; status.hidden = !data.job; }
    const refresh = card.querySelector('.speech-card-refresh'); if (refresh) refresh.hidden = !data.job;
  }
  function cardMarkup(node) {
    const scene = project().scenes.find(scene => scene.id === node.sceneId), descriptor = info[node.kind];
    const title = scene?.title || node.label;
    const asset = project().assets.find(item => !item.deletedAt && item.id === node.assetId);
    const mediaCover = Boolean(isImageGenerationNode(node) || isSpeechGenerationNode(node) || scene || asset && ['image', 'video'].includes(asset.kind));
    let body;
    if (isImageGenerationNode(node)) body = imageMarkup(node);
    else if (isSpeechGenerationNode(node)) body = speechMarkup(node);
    else if (scene) body = shotMarkup(scene, node);
    else if (node.assetId || node.assetName) body = assetMarkup(node);
    else if (node.kind === 'ai') body = aiMarkup(node);
    else if (node.kind === 'text') body = `<textarea class="canvas-note" data-node-field="note" aria-label="${escapeHtml(node.label)}内容" placeholder="写下想法、画面描述或视频提示词…">${escapeHtml(node.note)}</textarea><div class="canvas-node-footer"><span>文字便签</span><button data-card-action="from-text-ai">创建 AI 卡</button><button data-card-action="from-text-image">创建生图 ↗</button><button data-card-action="from-text">创建视频 ↗</button><button data-card-action="from-text-speech">生成配音 ♫</button></div>`;
    else body = `<div class="canvas-guide"><p>${escapeHtml(node.kind === 'compose' ? descriptor[1] : node.note || descriptor[1])}</p><span class="canvas-guide-icon">${descriptor[0]}</span></div><div class="canvas-node-footer"><span>${{ pending: '待制作', draft: '本地草案', ready: '已就绪', uploaded: '已上传', done: '已有成品', failed: '需检查' }[node.status] || '待制作'}</span><button data-card-action="guide">${descriptor[2]} ↗</button></div>`;
    if (!mediaCover) {
      body = `<div class="canvas-cover canvas-simple-cover">${defaultCoverMarkup(node.kind, title)}<div class="canvas-cover-drag" data-cover-drag aria-hidden="true"></div></div><div class="canvas-hover-details" aria-label="${escapeHtml(title)}详情">${detailHeading(node, node.kind === 'text' ? '文字便签' : node.kind === 'ai' ? 'AI 创作' : node.kind === 'audio' ? '声音素材' : '创作卡片', title)}<div class="canvas-details-content">${body}</div></div>`;
    }
    return `<div class="canvas-node-body">${body}</div>
      ${state().kinds[node.kind]?.accepts.length ? `<button class="canvas-port input" data-port="input" aria-label="${escapeHtml(title)}输入端口" title="左侧中点：靠近自动吸附，松开连接"></button>` : ''}
      <button class="canvas-port output" data-port="output" aria-label="${escapeHtml(title)}输出端口" title="${scene ? '将当前预览视频作为参考，拖到另一个视频卡片' : '从右侧中点拖出连线，靠近目标卡片自动吸附；也可点击后选择左端口'}"></button>
      <button class="canvas-node-resize" aria-label="调整${escapeHtml(title)}卡片大小" title="拖动调整大小"></button>`;
  }
  function positionCoverDetails(card) {
    const panel = card.querySelector('.canvas-hover-details'); if (!panel || !project()) return;
    const content = panel.querySelector('.canvas-details-content'), scrollTop = content?.scrollTop || 0;
    const zoom = Number(graph().viewport.zoom) || 1;
    const rect = card.getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
    const gap = 14, margin = 14;
    const viewportWidth = Math.max(0, viewport.clientWidth || bounds.width || 0);
    const assetDetails = Boolean(panel.querySelector('.canvas-reference-hint'));
    panel.classList.toggle('asset-details-panel', assetDetails);
    const width = Math.min(assetDetails ? 420 : 560, Math.max(0, viewportWidth - margin * 2));
    const minX = bounds.left + margin, maxX = Math.max(minX, bounds.right - margin - width);
    const x = clamp(rect.left + rect.width / 2 - width / 2, minX, maxX);
    const safeTop = bounds.top + margin, safeBottom = Math.max(safeTop, bounds.bottom - 68);
    const below = rect.bottom + gap, aboveSpace = Math.max(0, rect.top - gap - safeTop);
    const belowSpace = Math.max(0, safeBottom - below);
    const desiredHeight = Math.min(500, Math.max(0, (content?.scrollHeight || panel.offsetHeight || 360) + 47));
    const showBelow = belowSpace >= desiredHeight || belowSpace >= aboveSpace;
    const height = Math.max(0, Math.min(desiredHeight, showBelow ? belowSpace : aboveSpace));
    const y = showBelow ? below : rect.top - gap - height;
    card.style.setProperty('--details-scale', `${1 / zoom}`);
    card.style.setProperty('--details-width', `${width}px`);
    card.style.setProperty('--details-max-height', `${height}px`);
    card.style.setProperty('--details-left', `${(x - rect.left) / zoom}px`);
    card.style.setProperty('--details-top', `${(y - rect.top) / zoom}px`);
    card.classList.toggle('details-below', showBelow);
    card.classList.toggle('details-above', !showBelow);
    card.classList.remove('details-left');
    if (content) content.scrollTop = scrollTop;
  }
  function syncCoverPlayback(card) {
    const video = card.querySelector('[data-cover-video]'); if (!video) return;
    const isPlaying = !video.paused && !video.ended;
    card.classList.toggle('is-playing', isPlaying); card.classList.toggle('media-active', video.controls);
    const button = card.querySelector('[data-card-action="play-cover"]');
    if (button) { button.textContent = isPlaying ? '暂停' : '播放'; button.setAttribute('aria-label', isPlaying ? '暂停视频' : '播放视频'); }
  }
  function primeVideoCover(video) {
    if (!video?.matches?.('[data-cover-video]') || video.dataset.coverPrimed || video.readyState < 1) return;
    video.dataset.coverPrimed = 'true';
    // Decode an opening frame even when metadata preloading has not painted one.
    if (video.paused && !video.currentTime && Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.min(.01, video.duration / 2);
  }
  function settleCoverControls(card) {
    const video = card?.querySelector('[data-cover-video]'); if (!video || playing(card) || card.contains(document.activeElement)) return;
    video.controls = false; syncCoverPlayback(card);
  }
  function refreshShotControls(card, scene, node) {
    const control = card.querySelector('[data-reference-prompt]');
    if (control && control.value !== scene.videoPrompt) {
      const start = control.selectionStart, end = control.selectionEnd;
      control.value = scene.videoPrompt;
      if (document.activeElement === control) control.setSelectionRange(Math.min(start, control.value.length), Math.min(end, control.value.length));
      promptEditor.close(control);
    }
    const references = card.querySelector('.shot-references'), markup = referenceMarkup(scene);
    if (references && referenceSignatures.get(card) !== markup) {
      references.outerHTML = markup; referenceSignatures.set(card, markup);
    }
    const { p, submitting, disabled, label, estimate, hint } = shotData(scene, node);
    const button = card.querySelector('.shot-generate'); if (button) { button.disabled = disabled; button.textContent = label; button.setAttribute('aria-label',label); button.setAttribute('title',label); }
    const cost = card.querySelector('.shot-estimate strong'); if (cost) cost.textContent = estimate;
    const specifications = card.querySelector('.shot-estimate small');
    if (specifications) specifications.textContent = `${p.model?.name || '选择视频模型后显示接口参数'} · ${p.ratio || '模型默认比例'} · ${p.resolution || '模型默认画质'} · ${videoPricingNote(p)}`;
    const note = card.querySelector('.shot-hint'); if (note) { note.textContent = hint; note.hidden = !disabled && !shotData(scene, node).active; }
    const controls = videoParameterControls(p, state().catalog || [], state().settings.generationCountMax || 5, submitting, scene.videoModel || state().settings.videoModel);
    for (const [field, config] of Object.entries(controls)) {
      const control = card.querySelector(`[data-shot-field="${field}"]`);
      if (!control) continue;
      // Refresh dependent choices even while the prompt is focused or a video
      // is playing, without rebuilding its media element or open details.
      const previous = Array.from(control.options || []);
      if (previous.length !== config.options.length || previous.some((item, index) => item.value !== String(config.options[index].value) || item.textContent !== config.options[index].label)) {
        control.innerHTML = config.options.map(item => option(item.value, item.label, config.value)).join('');
      }
      if (control.value !== String(config.value)) control.value = String(config.value);
      control.disabled = Boolean(config.disabled);
    }
  }
  function render({ force = false, forceId = '' } = {}) {
    if (!project()) return;
    if (projectId !== project().id) reset();
    normalizeGraphMetadata();
    if (!visible()) return;
    const valid = new Set(graph().nodes.map(node => node.id));
    selection = new Set([...selection].filter(id => valid.has(id)));
    graph().groups = (graph().groups || []).map(group => ({ ...group, nodeIds: group.nodeIds.filter(id => valid.has(id)) })).filter(group => group.nodeIds.length > 1);
    if (!valid.has(connectionFrom)) connectionFrom = '';
    if (!graph().links.some(link => link.id === selectedLink)) selectedLink = '';
    for (const [id, card] of cards) if (!valid.has(id)) { if (activeCoverCard === card) closeCoverDetails(); card.remove(); cards.delete(id); signatures.delete(id); }
    for (const node of graph().nodes) {
      let card = cards.get(node.id);
      if (!card) { card = document.createElement('article'); card.dataset.nodeId = node.id; card.tabIndex = 0;
        card.setAttribute('aria-label', `${node.kind === 'compose' ? '生成结果' : node.label}卡片`); cards.set(node.id, card); nodesLayer.append(card); }
      const scene = project().scenes.find(scene => scene.id === node.sceneId);
      card.className = `canvas-node cover-card node-kind-${node.kind}${node.kind === 'text' ? ' text-card' : ''}${isImageGenerationNode(node) ? ' image-generation-card' : scene ? ' shot-card' : node.assetId || node.assetName ? ' asset-card' : ' guide-card'}${selection.has(node.id) ? ' selected' : ''}${activeCoverCard === card ? ' details-open' : ''}`;
      card.setAttribute('aria-expanded', String(activeCoverCard === card));
      Object.assign(card.style, { left: `${node.x}px`, top: `${node.y}px`, width: `${node.width}px`, height: `${node.height}px` });
      const template = cardMarkup(node);
      const locked = interaction || card.contains(document.activeElement) && document.activeElement !== card || playing(card);
      let detailsScroll = null;
      if (signatures.get(node.id) !== template && (!locked || force || forceId === node.id)) {
        const refocusCandidate = card.querySelector('[data-preview-candidate]') === document.activeElement;
        detailsScroll = card.querySelector('.canvas-details-content')?.scrollTop || 0;
        card.innerHTML = template; signatures.set(node.id, template);
        const previewAsset = card.dataset.previewAsset || '';
        card.dataset.previewAsset = scene ? (shotData(scene, node).preview?.id || '') : isImageGenerationNode(node) ? previewAsset : '';
        if (refocusCandidate) card.querySelector('[data-preview-candidate]')?.focus({ preventScroll: true });
      }
      if (scene) refreshShotControls(card, scene, node);
      if (isImageGenerationNode(node)) refreshImageControls(card,node);
      if (isSpeechGenerationNode(node)) refreshSpeechControls(card,node);
      primeVideoCover(card.querySelector('[data-cover-video]')); syncCoverPlayback(card); positionCoverDetails(card);
      if (detailsScroll !== null) { const details = card.querySelector('.canvas-details-content'); if (details) details.scrollTop = detailsScroll; }
      card.querySelector('.canvas-port.output')?.classList.toggle('connecting', connectionFrom === node.id);
    }
    renderGroups();
    $('#canvas-object-count').textContent = `${graph().nodes.length} 张卡片 · ${graph().links.length} 条连接`;
    $('#canvas-empty').hidden = graph().nodes.length > 0;
    updateTools(); applyViewport(); renderAssets();
  }
  // The visible ports and all saved/preview lines use the same middle anchors.
  function connectionPoint(node, side = 'input') {
    return worldToScreen({ x: node.x + (side === 'output' ? node.width : 0), y: node.y + node.height / 2 }, graph().viewport);
  }
  function connectionCandidate(point, hit) {
    if (!connectionFrom || !point || point.x < 0 || point.y < 0 || point.x > viewport.clientWidth || point.y > viewport.clientHeight) return '';
    const direct = hit?.closest('.canvas-node');
    // A directly hovered card owns the drop; an invalid card must never connect
    // to some other card behind it. Keep its normal validation message on release.
    if (direct) return direct.dataset.nodeId === connectionFrom ? '' : direct.dataset.nodeId;
    if (hit?.closest('.canvas-creation-toolbar,.canvas-selection-tools,.canvas-bottom-bar,.canvas-overview,.canvas-context-menu,.canvas-assets-panel,.canvas-brief')) return '';
    let closest = '', bestDistance = Infinity, bestAnchorDistance = Infinity;
    // Screen pixels keep the capture area equally forgiving at every zoom level.
    for (const node of graph().nodes) {
      if (node.id === connectionFrom) continue;
      const corner = worldToScreen(node, graph().viewport), scale = graph().viewport.zoom;
      const distance = Math.hypot(Math.max(corner.x - point.x, 0, point.x - corner.x - node.width * scale),
        Math.max(corner.y - point.y, 0, point.y - corner.y - node.height * scale));
      if (distance > 24 || distance > bestDistance || connectionError(connectionFrom, node.id)) continue;
      const anchor = connectionPoint(node), anchorDistance = Math.hypot(point.x - anchor.x, point.y - anchor.y);
      if (distance < bestDistance || anchorDistance < bestAnchorDistance) {
        closest = node.id; bestDistance = distance; bestAnchorDistance = anchorDistance;
      }
    }
    return closest;
  }
  function updateConnectionTarget(point, hit) {
    hoverPoint = point;
    const candidate = connectionCandidate(point, hit);
    const next = candidate && !connectionError(connectionFrom, candidate) ? candidate : '';
    if (connectionTargetId !== next) { connectionTargetId = next; updateTools(); }
  }
  function nodeReferences(node) {
    if (isImageGenerationNode(node)) return resolveImageInputs(project(), node).references;
    const scene = project()?.scenes.find(scene => scene.id === node?.sceneId);
    return scene ? resolveSceneReferences(project(), scene) : [];
  }
  function referenceSource(reference) {
    return graph().nodes.find(node => node.id === reference.nodeId)
      || (!reference.nodeId && reference.assetId ? graph().nodes.find(node => !node.sceneId && node.assetId === reference.assetId) : null);
  }
  function resolveReferenceFocus(value) {
    if (!value) return null;
    const target = graph().nodes.find(node => node.id === value.to);
    const reference = target && nodeReferences(target).find(item => referenceKey(item) === value.key);
    const source = reference && referenceSource(reference);
    if (!source || source.id === target.id) return null;
    const link = graph().links.find(link => link.from === source.id && link.to === target.id);
    return { ...value, from: source.id, linkId: link?.id || '' };
  }
  function referenceAtElement(element) {
    const item = element?.closest?.('[data-canvas-reference-key],[data-mention-index]');
    const card = item?.closest('.canvas-node');
    const key = item?.dataset.canvasReferenceKey || item?.dataset.referenceKey;
    return card && key ? { to: card.dataset.nodeId, key } : null;
  }
  function linkFocusContext() {
    const reference = resolveReferenceFocus(hoveredReference) || resolveReferenceFocus(focusedReference) || resolveReferenceFocus(promptReference);
    const focusedLink = reference?.linkId || (graph().links.some(link => link.id === hoveredLink) ? hoveredLink : '');
    return { selection, selectedLink, focusedLink, reference, zoom: graph().viewport.zoom,
      hideLabels: Boolean(connectionFrom || tool === 'hand' || spaceDown || interaction?.moved || interaction?.mode === 'marquee') };
  }
  function linkClassName(link, context, hasLabel) {
    const appearance = canvasLinkAppearance(link, context);
    return ['canvas-link', hasLabel && 'reference-link', appearance.selected && 'selected', appearance.related && 'related',
      appearance.highlighted && 'highlighted', appearance.dimmed && 'dimmed', hasLabel && appearance.labelVisible && 'label-visible'].filter(Boolean).join(' ');
  }
  function updateLinkFocus() {
    if (!project()) return;
    const context = linkFocusContext(), active = graph().links.find(link => link.id === (context.focusedLink || selectedLink));
    const endpoints = new Set(context.reference ? [context.reference.from, context.reference.to] : active ? [active.from, active.to] : []);
    for (const element of connections.querySelectorAll('[data-canvas-link-id]')) {
      const link = { id: element.dataset.canvasLinkId, from: element.dataset.fromNode, to: element.dataset.toNode };
      const saved=graph().links.find(item=>item.id===link.id);
      const issue=saved ? modelLinkIssue(project(),saved,state().catalog,state().imageCatalog,state().settings.videoModel) : '';
      element.setAttribute('class', linkClassName(link, context, Boolean(element.querySelector('.canvas-reference-label'))) + (issue ? ' capability-invalid' : ''));
    }
    for (const [id, card] of cards) {
      card.classList.toggle('reference-highlighted', endpoints.has(id));
      for (const item of card.querySelectorAll('[data-canvas-reference-key]')) {
        item.classList.toggle('reference-active', context.reference?.to === id && context.reference.key === item.dataset.canvasReferenceKey);
      }
    }
  }
  function locateReference(target, key) {
    const focus = resolveReferenceFocus({ to: target.id, key });
    const source = focus && graph().nodes.find(node => node.id === focus.from);
    if (!source) return;
    finishEditing(); selection = new Set([source.id]); selectedLink = ''; connectionFrom = ''; connectionTargetId = '';
    hoveredLink = ''; hoveredReference = null; focusedReference = null; promptReference = null;
    const zoom = clamp(graph().viewport.zoom, 0.75, 1.5);
    setViewport({ zoom, x: viewport.clientWidth / 2 - (source.x + source.width / 2) * zoom,
      y: viewport.clientHeight / 2 - (source.y + source.height / 2) * zoom });
    updateTools(); cards.get(source.id)?.focus({ preventScroll: true });
  }
  function drawLinks() {
    const byId = new Map(graph().nodes.map(node => [node.id, node]));
    const context = linkFocusContext();
    let markup = '<defs><marker id="canvas-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M1,1 L6,3.5 L1,6" fill="none" stroke="currentColor" stroke-width="1"/></marker></defs>';
    for (const link of graph().links) {
      const from = byId.get(link.from), to = byId.get(link.to); if (!from || !to) continue;
      const start = connectionPoint(from, 'output'), end = connectionPoint(to), d = connectionPath(start, end);
      const scene = project().scenes.find(scene => scene.id === to.sceneId);
      const references = isImageGenerationNode(to)
        ? resolveImageInputs(project(), to).references
        : scene ? resolveSceneReferences(project(),scene) : [];
      const index = references.findIndex(reference => reference.nodeId === from.id);
      const label = index >= 0 ? referenceLabel(references,index) : '';
      // Endpoints are already in screen coordinates, so reference pills stay fixed-size at every canvas zoom.
      const capabilityIssue=label ? modelLinkIssue(project(),link,state().catalog,state().imageCatalog,state().settings.videoModel) : '';
      markup += `<g class="${linkClassName(link, context, Boolean(label))}${capabilityIssue ? ' capability-invalid' : ''}" data-canvas-link-id="${escapeHtml(link.id)}" data-from-node="${escapeHtml(link.from)}" data-to-node="${escapeHtml(link.to)}">${capabilityIssue ? '<title>'+escapeHtml(capabilityIssue)+'</title>' : ''}<path d="${d}" marker-end="url(#canvas-arrow)"/><path class="canvas-link-hit" data-link-id="${escapeHtml(link.id)}" d="${d}"/>${label ? '<g class="canvas-reference-label" transform="translate(' + (start.x + end.x) / 2 + ',' + (start.y + end.y) / 2 + ')"><rect x="-26" y="-11" width="52" height="22" rx="7" vector-effect="non-scaling-stroke"/><text text-anchor="middle" dominant-baseline="central" font-size="11">' + label + '</text></g>' : ''}</g>`;
    }
    const source = byId.get(connectionFrom);
    if (connectionTargetId && (!source || !byId.has(connectionTargetId) || connectionError(connectionFrom, connectionTargetId))) {
      connectionTargetId = ''; updateTools();
    }
    const snapped = byId.get(connectionTargetId);
    for (const [id, card] of cards) {
      card.classList.toggle('connection-snap', Boolean(source && id === connectionTargetId));
      card.querySelector('.canvas-port.input')?.classList.toggle('snapped', Boolean(source && id === connectionTargetId));
    }
    if (source && hoverPoint) markup += `<path class="canvas-connection-preview${snapped ? ' snapped' : ''}" d="${connectionPath(connectionPoint(source, 'output'), snapped ? connectionPoint(snapped) : hoverPoint)}"/>`;
    connections.innerHTML = markup;
    updateLinkFocus();
  }
  function drawMinimap() {
    if (!project() || !viewport.clientWidth) return;
    const view = graph().viewport, corner = screenToWorld({ x: 0, y: 0 }, view);
    const screen = { ...corner, width: viewport.clientWidth / view.zoom, height: viewport.clientHeight / view.zoom };
    const bounds = selectionBounds([...graph().nodes, screen]); if (!bounds) return;
    const padding = Math.max(80, Math.max(bounds.width, bounds.height) * .05);
    minimapBounds = { x: bounds.x - padding, y: bounds.y - padding, width: bounds.width + padding * 2, height: bounds.height + padding * 2 };
    const box = minimapBounds; minimap.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
    minimap.setAttribute('preserveAspectRatio', 'none');
    minimap.innerHTML = graph().nodes.map(node => `<rect class="minimap-node${selection.has(node.id) ? ' selected' : ''}" x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="12"/>`).join('')
      + `<rect class="minimap-viewport" x="${screen.x}" y="${screen.y}" width="${screen.width}" height="${screen.height}"/>`;
  }
  function renderAssets() {
    if (assetsPanel.hidden || !project()) return;
    const filter = graph().nodes.find(node => node.id === relinkNodeId)?.kind;
    const assets = [...project().assets].reverse().filter(asset => !asset.deletedAt && (!filter || asset.kind === filter));
    $('#canvas-asset-picker').innerHTML = assets.length ? assets.map(asset => `<button class="canvas-asset-item" data-canvas-asset="${escapeHtml(asset.id)}" draggable="true" title="点击或拖到画布：${escapeHtml(asset.name)}"><span class="canvas-asset-thumb">${['image', 'video'].includes(asset.kind) ? `<img src="${assetThumbnailUrl(asset.id)}" loading="lazy" alt="" draggable="false">` : info[asset.kind][0]}</span><span class="canvas-asset-label"><strong>${escapeHtml(asset.name)}</strong><small>${{ image: '图片', video: '视频', audio: '声音' }[asset.kind]} · 拖放到画布</small></span><span>＋</span></button>`).join('') : '<p class="canvas-panel-empty">上传图片、视频或声音，然后放到画布上。</p>';
  }
  function openAssets(point = null, nodeId = '') {
    assetsPanel.hidden = false; briefPanel.hidden = true; relinkNodeId = nodeId; panelPoint = point;
    renderAssets();
  }
  function openBrief() {
    briefPanel.hidden = false; assetsPanel.hidden = true;
  }
  function proposedLink(from, to) {
    const source = graph().nodes.find(node => node.id === from), target = graph().nodes.find(node => node.id === to);
    const link = { id: uid(), from, to };
    if (source?.sceneId && target?.sceneId && source.kind === 'video' && target.kind === 'video') {
      const scene = project().scenes.find(scene => scene.id === source.sceneId);
      const asset = scene && shotData(scene, source).preview;
      if (asset && !asset.deletedAt) link.reference = { assetId: asset.id, kind: asset.kind, name: asset.name };
    }
    if (isImageGenerationNode(source) && (isImageGenerationNode(target) || target?.kind === 'video' && target.sceneId)) {
      const asset = project().assets.find(asset => !asset.deletedAt && asset.id === source.assetId && asset.kind === 'image');
      if (asset) link.reference = {assetId:asset.id,kind:'image',name:asset.name};
    }
    return link;
  }
  function connectionError(from, to) {
    const message = validateCanvasLink(graph(), state().kinds, from, to); if (message) return message;
    const target = graph().nodes.find(node => node.id === to), source = graph().nodes.find(node => node.id === from);
    const scene = project().scenes.find(scene => scene.id === target.sceneId);
    if (isImageGenerationNode(source) && !project().assets.some(asset => !asset.deletedAt && asset.kind === 'image' && asset.id === source.assetId)) return '这张生图卡片还没有保存好的图片，请完成生成后再连接。';
    const link = proposedLink(from, to), output = canvasLinkReference(source, link);
    if (scene && source.sceneId && source.sceneId === scene.id) return '同一视频生成项的卡片不能连接到自身作为参考。';
    if (scene && source.sceneId && !output) return '这个视频生成项还没有可用的视频结果，请生成并保存视频后再连线。';
    if (scene && output) {
      const references = resolveSceneReferences(project(), scene);
      if (references.some(item => item.nodeId && (item.nodeId === source.id || output.assetId && item.assetId === output.assetId))) return '这个素材已经连接到同一视频生成项。';
      const proposed = { ...project(), graph: { ...graph(), links: [...graph().links, link] } };
      const issue=modelLinkIssue(proposed,link,state().catalog,state().imageCatalog,state().settings.videoModel);
      if (issue) return issue;
    }
    if (isImageGenerationNode(target) && source.kind === 'image') {
      const inputs = resolveImageInputs(project(),target);
      if (inputs.references.some(reference => reference.nodeId === source.id || source.assetId && reference.assetId === source.assetId)) return '这张图片已连接到本生图卡片。';
      const proposed={...project(),graph:{...graph(),links:[...graph().links,link]}};
      const issue=modelLinkIssue(proposed,link,state().catalog,state().imageCatalog,state().settings.videoModel);
      if(issue)return issue;
    }
    return '';
  }
  async function connect(to) {
    const from = connectionFrom;
    const target = graph().nodes.find(node => node.id === to);
    const source = graph().nodes.find(node => node.id === from);
    if (target?.kind === 'video' && source?.kind === 'image') {
      const asset = project().assets.find(item => !item.deletedAt && item.id === source.assetId && item.kind === 'image');
      if (asset) {
        const pixelIssue = imagePixelIssue(await readImageDimensions(asset));
        if (pixelIssue) { bridge.toast(pixelIssue, true); return false; }
      }
    }
    if (connectionFrom !== from) return false;
    const message = connectionError(from, to);
    if (message) { bridge.toast(message, true); return false; }
    const scene = project().scenes.find(scene => scene.id === target.sceneId);
    if (!changeGraph(() => { graph().links.push(proposedLink(from, to)); if (connectionFrom === from) connectionFrom = ''; selectedLink = ''; })) return false;
    const references = isImageGenerationNode(target)
      ? resolveImageInputs(project(), target).references
      : scene ? resolveSceneReferences(project(),scene) : [];
    const index = references.findIndex(item => item.nodeId === from);
    const targetTitle = isImageGenerationNode(target) ? target.label || '目标生图卡片' : scene?.title || '目标卡片';
    bridge.toast(index >= 0 ? referenceLabel(references,index) + '已连接到“' + targetTitle + '”，输入 @ 可引用。' : '连接已保存。');
    return true;
  }
  connections.addEventListener('pointerover', event => {
    hoveredLink = event.target.closest?.('[data-canvas-link-id]')?.dataset.canvasLinkId || '';
    updateLinkFocus();
  });
  connections.addEventListener('pointerout', event => {
    hoveredLink = event.relatedTarget?.closest?.('[data-canvas-link-id]')?.dataset.canvasLinkId || '';
    updateLinkFocus();
  });
  viewport.addEventListener('pointerleave', () => {
    hoveredLink = ''; hoveredReference = null; updateLinkFocus();
  });
  viewport.addEventListener('pointerdown', event => {
    if (!project() || ![0, 1, 2].includes(event.button)) return;
    contextMenu.hidden = true;
    suppressContextMenuUntil = 0;
    const point = localPoint(event), card = event.target.closest('.canvas-node');
    if (event.button === 0 && !card) closeCoverDetails();
    const rightButton = event.button === 2;
    if (rightButton) {
      // A short right-click keeps the existing context-menu behavior. A
      // right-drag from any non-interactive canvas point starts marquee selection.
      if (event.target.closest('[data-link-id],[data-port]') || interactive(event.target) || event.target.closest('video,audio')) return;
      // Prevent the browser context menu from stealing pointer capture during
      // a right-button drag. A short click is handled by the contextmenu
      // listener below, while a drag completes the marquee selection.
      event.preventDefault();
      finishEditing();
      interaction = { mode: 'marquee', button: 2, pointerId: event.pointerId, start: point,
        selection: event.shiftKey ? new Set(selection) : new Set(), moved: false };
      marquee.hidden = false; Object.assign(marquee.style, { left: `${point.x}px`, top: `${point.y}px`, width: '0px', height: '0px' });
      document.activeElement?.blur(); viewport.focus({ preventScroll: true });
      viewport.setPointerCapture(event.pointerId); updateTools();
      return;
    }
    const hand = tool === 'hand' || spaceDown || event.button === 1;
    if (!hand && event.target.closest('.chat-image-preview')) return;
    if (tool === 'marquee' && !hand) {
      if (interactive(event.target) || event.target.closest('[data-port]')) return;
      finishEditing(); selectedLink = ''; connectionFrom = ''; connectionTargetId = '';
      interaction = { mode: 'marquee', pointerId: event.pointerId, start: point,
        selection: event.shiftKey ? new Set(selection) : new Set(), moved: false };
      marquee.hidden = false; Object.assign(marquee.style, { left: `${point.x}px`, top: `${point.y}px`, width: '0px', height: '0px' });
      document.activeElement?.blur(); viewport.focus({ preventScroll: true });
      viewport.setPointerCapture(event.pointerId); event.preventDefault(); updateTools(); return;
    }
    const link = event.target.closest('[data-link-id]');
    if (link && !hand) { selection.clear(); selectedLink = link.dataset.linkId; connectionFrom = ''; updateTools(); drawLinks(); event.preventDefault(); return; }
    const port = event.target.closest('[data-port]');
    if (port && !hand) {
      if (port.dataset.port === 'output' && card) {
        finishEditing(); connectionFrom = card.dataset.nodeId; connectionTargetId = ''; selectedLink = ''; selection = new Set([connectionFrom]); hoverPoint = point;
        interaction = { mode: 'connect', pointerId: event.pointerId, start: point, moved: false };
        viewport.setPointerCapture(event.pointerId); event.preventDefault(); updateTools(); drawLinks();
      }
      return;
    }
    const modifiedCardClick = !hand && card && (event.ctrlKey || event.metaKey)
      && !event.target.closest('button,input,textarea,select,a,video,audio');
    if (modifiedCardClick) {
      const id = card.dataset.nodeId;
      if (!connectionFrom) {
        connectionFrom = id; connectionTargetId = ''; selection = new Set([id]); selectedLink = '';
        updateTools(); drawLinks(); bridge.toast('已选择连线起点；按住 Ctrl 再点击目标卡片。'); event.preventDefault(); return;
      }
      if (connectionFrom === id) {
        connectionFrom = ''; connectionTargetId = ''; updateTools(); drawLinks();
        bridge.toast('已取消连线起点。'); event.preventDefault(); return;
      }
      connect(id); event.preventDefault(); return;
    }
    if (connectionFrom && !event.ctrlKey && !event.metaKey) { connectionFrom = ''; connectionTargetId = ''; }
    const groupDrag = event.target.closest('[data-canvas-group-drag]');
    if (groupDrag && !hand && !interactive(event.target)) {
      const group = graph().groups.find(item => item.id === groupDrag.dataset.groupId);
      if (!group) return;
      finishEditing(); selection = new Set(group.nodeIds); selectedLink = ''; connectionFrom = '';
      interaction = { mode: 'move', id: group.nodeIds[0], pointerType: event.pointerType, pointerId: event.pointerId, start: point, before: snapshot(), moved: false,
        positions: graph().nodes.filter(item => selection.has(item.id)).map(item => ({ id: item.id, x: item.x, y: item.y })) };
      viewport.setPointerCapture(event.pointerId); event.preventDefault(); updateTools(); return;
    }
    if (!hand && card) {
      const id = card.dataset.nodeId, node = graph().nodes.find(node => node.id === id);
      if (!node) return;
      if (!card.classList.contains('cover-card')) closeCoverDetails();
      if (event.shiftKey && !interactive(event.target)) {
        if (selection.has(id)) selection.delete(id); else selection.add(id);
      } else if (!selection.has(id)) {
        const group = (graph().groups || []).find(item => item.nodeIds.includes(id));
        selection = new Set(group ? group.nodeIds : [id]);
      }
      selectedLink = ''; updateTools();
      const resize = event.target.closest('.canvas-node-resize');
      const cover = event.target.closest('[data-cover-drag]');
      if (resize) {
        finishEditing(); interaction = { mode: 'resize', id, pointerId: event.pointerId, start: point, width: node.width, height: node.height, before: snapshot(), moved: false };
      } else if (cover && !interactive(event.target) && selection.has(id)) {
        finishEditing(); interaction = { mode: 'move', id, pointerType: event.pointerType, pointerId: event.pointerId, start: point, before: snapshot(), moved: false,
          positions: graph().nodes.filter(item => selection.has(item.id)).map(item => ({ id: item.id, x: item.x, y: item.y })) };
      } else return;
    } else {
      if (event.target.closest('button,input,textarea,select,a,video,audio') && !hand) return;
      finishEditing();
      if (event.shiftKey && !hand) {
        interaction = { mode: 'marquee', pointerId: event.pointerId, start: point, selection: new Set(selection), moved: false };
        marquee.hidden = false; Object.assign(marquee.style, { left: `${point.x}px`, top: `${point.y}px`, width: '0px', height: '0px' });
      } else {
        interaction = { mode: 'pan', pointerId: event.pointerId, start: point, view: clone(graph().viewport), moved: false };
        if (!hand) { selection.clear(); selectedLink = ''; connectionFrom = ''; }
      }
      document.activeElement?.blur(); viewport.focus({ preventScroll: true });
    }
    // Keep clicks on the header intact so a double-click can enter title editing.
    if (interaction.mode !== 'move') viewport.setPointerCapture(event.pointerId);
    event.preventDefault(); updateTools();
  });
  viewport.addEventListener('pointermove', event => {
    if (!project()) return;
    const point = localPoint(event); hoverPoint = point;
    if (!interaction || interaction.pointerId !== event.pointerId) {
      if (connectionFrom) { updateConnectionTarget(point, document.elementFromPoint?.(event.clientX, event.clientY)); drawLinks(); }
      return;
    }
    const dx = point.x - interaction.start.x, dy = point.y - interaction.start.y;
    if (!interaction.moved && Math.hypot(dx, dy) < 3) return;
    interaction.moved = true;
    if (!viewport.hasPointerCapture(event.pointerId)) viewport.setPointerCapture(event.pointerId);
    const view = graph().viewport;
    if (interaction.mode === 'connect') { updateConnectionTarget(point, document.elementFromPoint?.(event.clientX, event.clientY)); drawLinks(); return; }
    if (interaction.mode === 'pan') setViewport({ ...interaction.view, x: interaction.view.x + dx, y: interaction.view.y + dy });
    if (interaction.mode === 'move') {
      for (const position of interaction.positions) {
        const node = graph().nodes.find(node => node.id === position.id); if (!node) continue;
        node.x = coordinate(position.x + dx / view.zoom); node.y = coordinate(position.y + dy / view.zoom);
        const element = cards.get(node.id); if (element) { element.style.left = `${node.x}px`; element.style.top = `${node.y}px`; element.classList.add('dragging'); }
      }
      bridge.mark('graph'); renderGroups(); drawLinks(); drawMinimap();
    }
    if (interaction.mode === 'resize') {
      const node = graph().nodes.find(node => node.id === interaction.id); if (!node) return;
      node.width = Math.round(clamp(interaction.width + dx / view.zoom, 240, 720));
      node.height = Math.round(clamp(interaction.height + dy / view.zoom, 180, 900));
      const element = cards.get(node.id); element.style.width = `${node.width}px`; element.style.height = `${node.height}px`;
      bridge.mark('graph'); renderGroups(); drawLinks(); drawMinimap();
    }
    if (interaction.mode === 'marquee') {
      if (interaction.button === 2) event.preventDefault();
      const rect = { x: Math.min(point.x, interaction.start.x), y: Math.min(point.y, interaction.start.y),
        width: Math.abs(dx), height: Math.abs(dy) };
      Object.assign(marquee.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      const corner = screenToWorld(rect, view), world = { ...corner, width: rect.width / view.zoom, height: rect.height / view.zoom };
      selection = new Set([...interaction.selection, ...graph().nodes.filter(node => intersectsRect(node, world)).map(node => node.id)]);
      selectedLink = ''; updateTools(); drawMinimap();
    }
  });
  function finishPointer(event) {
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const current = interaction; interaction = null; marquee.hidden = true;
    if (current.mode === 'connect') {
      connectionTargetId = '';
      if (current.moved && event.type !== 'pointercancel' && event.type !== 'lostpointercapture') {
        const targetId = connectionCandidate(localPoint(event), document.elementFromPoint?.(event.clientX, event.clientY));
        if (targetId) {
          const from = connectionFrom;
          void connect(targetId).then(connected => {
            if (!connected && connectionFrom === from) { connectionFrom = ''; connectionTargetId = ''; render(); }
          }).catch(error => {
            if (connectionFrom === from) { connectionFrom = ''; connectionTargetId = ''; bridge.toast(error.message, true); render(); }
          });
        }
        else { connectionFrom = ''; bridge.toast('未连接。请从右侧圆点拖到目标卡片附近，吸附后松开。'); }
      } else if (event.type === 'pointercancel' || event.type === 'lostpointercapture') connectionFrom = '';
    }
    if (current.moved) {
      if (current.before) commit(current.before);
      if (current.mode !== 'marquee') bridge.mark('graph');
      if (current.mode === 'marquee' && current.button === 2 && event.type !== 'pointercancel' && event.type !== 'lostpointercapture') {
        event.preventDefault?.();
        // Browsers dispatch contextmenu immediately after pointerup. Keep the
        // custom menu from reopening after a completed right-button marquee.
        suppressContextMenuUntil = Date.now() + 500;
      }
      suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
    }
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    if (!current.moved && current.mode === 'move' && current.pointerType === 'touch') cards.get(current.id)?.focus({ preventScroll: true });
    render();
    if (current.mode === 'marquee' && current.button === 2 && !current.moved && event.type === 'pointerup') openContextMenu(event);
  }
  viewport.addEventListener('pointerup', finishPointer); viewport.addEventListener('pointercancel', finishPointer);
  viewport.addEventListener('lostpointercapture', finishPointer);
  viewport.addEventListener('wheel', event => {
    if (!project() || interaction) return;
    if (!event.ctrlKey) {
      // Let a short textarea pass the wheel to its scrollable details panel.
      for (let scrollable = event.target; scrollable && scrollable !== viewport; scrollable = scrollable.parentElement) {
        if (scrollable.matches('textarea,.canvas-details-content,.canvas-node-body,.reference-mention-menu,.shot-reference-list') && scrollable.scrollHeight > scrollable.clientHeight + 1) return;
      }
    }
    event.preventDefault();
    // Limit very large wheel deltas and keep the world point under the pointer fixed.
    zoom(Math.exp(-clamp(event.deltaY * (event.deltaMode === 1 ? 16 : 1), -160, 160) * .002), localPoint(event));
  }, { passive: false });
  function openContextMenu(event) {
    if (!project() || editing(event.target) || event.target.closest('video,audio')) return;
    const point = localPoint(event); contextPoint = screenToWorld(point, graph().viewport);
    const rect = root.getBoundingClientRect();
    Object.assign(contextMenu.style, { left: `${clamp(event.clientX - rect.left, 12, Math.max(12, rect.width - 180))}px`, top: `${clamp(event.clientY - rect.top, 52, Math.max(52, rect.height - 150))}px` });
    contextMenu.hidden = false;
  }
  viewport.addEventListener('contextmenu', event => {
    // Windows browsers can emit contextmenu on press, before the first move.
    if ((interaction?.mode === 'marquee' && interaction.button === 2) || (interaction?.mode === 'marquee' && interaction.moved) || suppressContextMenuUntil > Date.now()) {
      event.preventDefault();
      return;
    }
    if (!project() || editing(event.target) || event.target.closest('video,audio')) return;
    event.preventDefault(); openContextMenu(event);
  });
  groupsLayer.addEventListener('click', event => {
    const button = event.target.closest('[data-group-action="dissolve"]');
    if (button) { event.preventDefault(); dissolveGroup(button.dataset.groupId); }
  });
  groupsLayer.addEventListener('focusin', event => {
    if (event.target.dataset.canvasGroupField && !editBefore) editBefore = snapshot();
  });
  groupsLayer.addEventListener('focusout', event => {
    if (!event.target.dataset.canvasGroupField) return;
    const group = graph().groups.find(item => item.id === event.target.dataset.groupId);
    if (group && event.target.dataset.canvasGroupField === 'label') {
      group.label = event.target.value.trim().slice(0, 80) || '新分组';
      event.target.value = group.label; bridge.mark('graph');
    }
    finishEditing();
    queueMicrotask(() => { if (!groupsLayer.contains(document.activeElement)) render(); });
  });
  groupsLayer.addEventListener('input', event => {
    const group = graph().groups.find(item => item.id === event.target.dataset.groupId);
    if (!group || !event.target.dataset.canvasGroupField) return;
    if (event.target.dataset.canvasGroupField === 'color') {
      if (/^#[0-9a-f]{6}$/i.test(event.target.value)) { group.color = event.target.value; groupFrames.get(group.id)?.style.setProperty('--group-color', group.color); bridge.mark('graph'); }
      return;
    }
    if (!editBefore) editBefore = snapshot();
    group.label = event.target.value.slice(0, 80); bridge.mark('graph');
  });
  nodesLayer.addEventListener('focusin', event => {
    focusedReference = referenceAtElement(event.target); updateLinkFocus();
    if ((event.target.dataset.imageField || event.target.dataset.aiField || event.target.dataset.speechField || event.target.dataset.nodeField && !event.target.readOnly) && !editBefore) editBefore = snapshot();
  });
  nodesLayer.addEventListener('focusout', event => {
    finishEditing(); const card = event.target.closest('.canvas-node'), next = event.relatedTarget;
    queueMicrotask(() => {
      focusedReference = referenceAtElement(document.activeElement); updateLinkFocus();
      settleCoverControls(card);
      if (!card?.contains(next)) render();
    });
  });
  nodesLayer.addEventListener('input', event => {
    if (!project()) return;
    const card = event.target.closest('.canvas-node'); if (!card) return;
    const node = graph().nodes.find(node => node.id === card.dataset.nodeId); if (!node) return;
    if (event.target.dataset.nodeField) {
      if (!editBefore) editBefore = snapshot();
      const field = event.target.dataset.nodeField;
      if (!['label', 'note'].includes(field)) return;
      node[field] = event.target.value;
      if (field === 'label' && node.sceneId) {
        const scene = project().scenes.find(scene => scene.id === node.sceneId);
        if (scene) { scene.title = event.target.value; bridge.mark('scenes'); }
      }
      bridge.mark('graph');
    }
    if (event.target.dataset.shotField) updateSceneField(event.target, card, node);
    if (event.target.dataset.imageField) updateImageField(event.target,card,node);
    if (event.target.dataset.aiField) updateAiField(event.target, node);
    if (event.target.dataset.speechField) updateSpeechField(event.target,card,node);
  });
  function updateSpeechField(control, card, node) {
    const field = control.dataset.speechField;
    if (!isSpeechGenerationNode(node) || !['model','text','voiceId','name','speed','vol','pitch','emotion','format'].includes(field)) return;
    if (!editBefore) editBefore = snapshot();
    const value = ['speed','vol','pitch'].includes(field) ? control.value === '' ? '' : Number(control.value) : control.value;
    const next = { ...node.speechConfig, [field]: value };
    if (field === 'model' && !speechEmotionSupported(next.model, next.emotion)) next.emotion = '';
    node.speechConfig = normalizeSpeechDraft(next);
    bridge.mark('graph'); refreshSpeechControls(card,node);
    if (field === 'model') {
      const emotion = card.querySelector('[data-speech-field="emotion"]');
      if (emotion) {
        for (const choice of emotion.options) choice.disabled = !speechEmotionSupported(next.model, choice.value);
        emotion.value = node.speechConfig.emotion;
      }
    }
  }
  function updateImageField(control,card,node) {
    const field=control.dataset.imageField;
    if (!isImageGenerationNode(node) || !['model','ratio','quality','style','count','prompt','skillId'].includes(field)) return;
    if (!editBefore) editBefore=snapshot();
    try {
      const next={...node.imageConfig,[field]:control.value};
      if(field==='model') {
        const model=state().imageCatalog?.find(item=>item.name===next.model);
        for(const [key,values] of [['ratio',model?.capabilities?.ratios],['quality',model?.capabilities?.qualities]]) {
          if(values?.length && !values.includes(next[key]||'auto'))next[key]=values.includes('auto')?'auto':values[0];
        }
      }
      node.imageConfig = normalizeImageConfig(next);
      bridge.mark('graph');refreshImageControls(card,node);
    } catch(error) {report(error);}
  }
  function updateAiField(control, node) {
    const field = control.dataset.aiField;
    if (node.kind !== 'ai' || !['mode', 'model', 'skillId', 'instruction', 'output'].includes(field)) return;
    if (!editBefore) editBefore = snapshot();
    node.aiConfig = normalizeAiConfig({ ...node.aiConfig, [field]: control.value, status: field === 'output' ? 'done' : node.aiConfig?.status });
    if (field === 'output') node.note = control.value;
    bridge.mark('graph');
  }
  function updateSceneField(control, card, node) {
    const scene = project().scenes.find(scene => scene.id === node.sceneId); if (!scene) return;
    const field = control.dataset.shotField; if (!['videoPrompt', 'videoModel', 'ratio', 'resolution', 'generationDuration', 'generationCount', 'videoSkillId'].includes(field)) return;
    if (state().submitting.has(scene.id) && field !== 'videoPrompt') return;
    if (field === 'videoPrompt') {
      try { scene.promptMentions = updatePromptMentions(scene.videoPrompt || '',control.value,scene.promptMentions || [],resolveSceneReferences(project(),scene),promptEditor.takeEdit?.(control,scene.videoPrompt || '',control.value)); }
      catch (error) { control.value=scene.videoPrompt || '';report(error);return; }
    }
    if (field === 'videoPrompt') scene.videoPrompt = control.value;
    else if (field === 'videoSkillId') scene.videoSkillId = control.value;
    else {
      const model = field === 'videoModel' ? bridge.modelForScene?.({ videoModel: control.value }) : bridge.parameters(scene)?.model;
      if (!updateVideoParameter(scene, field, control.value, model)) return;
    }
    bridge.mark('scenes');
    if (field === 'videoPrompt') refreshShotControls(card, scene, node);
    else render();
  }
  nodesLayer.addEventListener('change', event => {
    if (!project()) return;
    const card = event.target.closest('.canvas-node'), node = graph().nodes.find(node => node.id === card?.dataset.nodeId);
    if (!node) return;
    if (event.target.dataset.canvasReferenceRole) {
      const scene = project().scenes.find(item => item.id === node.sceneId);
      if (!scene || state().submitting.has(scene.id)) return;
      if (!editBefore) editBefore = snapshot();
      scene.references = resolveSceneReferences(project(), scene);
      const reference = scene.references.find(item => referenceKey(item) === event.target.dataset.canvasReferenceRole);
      if (reference?.kind === 'image') { reference.role = event.target.value; bridge.mark('scenes'); finishEditing(); render({ forceId: node.id }); }
    }
    if (event.target.dataset.shotField) updateSceneField(event.target, card, node);
    if (event.target.dataset.imageField) {updateImageField(event.target,card,node);finishEditing();}
    if (event.target.dataset.aiField) {
      updateAiField(event.target, node); finishEditing();
      if (event.target.tagName === 'SELECT') render({ forceId: node.id });
    }
    if (event.target.dataset.speechField) { updateSpeechField(event.target, card, node); finishEditing(); }
    if (event.target.matches('[data-speech-voice-select]') && event.target.value && isSpeechGenerationNode(node)) {
      const input = card.querySelector('[data-speech-field="voiceId"]');
      if (input) { input.value = event.target.value; updateSpeechField(input,card,node); finishEditing(); }
    }
    if (event.target.matches('[data-preview-candidate]')) { card.dataset.previewAsset = event.target.value; render({ forceId: node.id }); }
  });
  nodesLayer.addEventListener('pointerover', event => {
    hoveredReference = referenceAtElement(event.target); updateLinkFocus();
  });
  nodesLayer.addEventListener('pointerout', event => {
    hoveredReference = referenceAtElement(event.relatedTarget); updateLinkFocus();
  });
  nodesLayer.addEventListener('loadedmetadata', event => primeVideoCover(event.target), true);
  for (const name of ['play', 'pause', 'ended']) nodesLayer.addEventListener(name, event => {
    const card = event.target.closest('.canvas-node');
    if (card) {
      syncCoverPlayback(card);
      if (name === 'play' && card.classList.contains('cover-card')) showCoverDetails(card);
    }
    if (name !== 'play') queueMicrotask(() => {
      settleCoverControls(card);
      if (card?.classList.contains('cover-card') && activeCoverCard === card) settleCoverControls(card);
      render();
    });
  }, true);
  nodesLayer.addEventListener('click', async event => {
    if (!project() || suppressClick || tool === 'hand' || spaceDown) return;
    const card = event.target.closest('.canvas-node'); if (!card) return;
    const node = graph().nodes.find(node => node.id === card.dataset.nodeId); if (!node) return;
    const port = event.target.closest('[data-port]');
    if (port) {
      if (port.dataset.port === 'output') { connectionFrom = node.id; connectionTargetId = ''; selectedLink = ''; selection = new Set([node.id]); render(); }
      else if (connectionFrom) connect(node.id);
      else bridge.toast('先点击来源卡片的右端口，再点击目标的左端口。');
      return;
    }
    const button = event.target.closest('[data-card-action]');
    if (!button) {
      if (card.classList.contains('cover-card') && !event.target.closest('.canvas-hover-details') && !interactive(event.target)
        && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        if (activeCoverCard === card) closeCoverDetails(); else showCoverDetails(card);
      }
      return;
    }
    if (button.disabled) return;
    const operation = button.dataset.cardAction, scene = project().scenes.find(scene => scene.id === node.sceneId);
    if (operation === 'close-details') { closeCoverDetails(); card.focus({ preventScroll: true }); return; }
    try {
      if (operation === 'play-cover') {
        const video = card.querySelector('[data-cover-video]'); if (!video) return;
        if (video.paused || video.ended) {
          if (!video.getAttribute('src') && video.dataset.mediaSrc) video.src = video.dataset.mediaSrc;
          video.controls = true; syncCoverPlayback(card); await video.play();
        }
        else video.pause();
        syncCoverPlayback(card);
      }
      if (operation === 'preview-cover') {
        const asset = project().assets.find(item => !item.deletedAt && item.id === card.dataset.previewAsset); if (asset) bridge.previewAsset(asset);
      }
      if (operation === 'remove') { selection = new Set([node.id]); deleteSelection(); }
      if (operation === 'from-text-ai') addAi(null, node);
      if (operation === 'from-text') addShot(null, node);
      if (operation === 'from-text-image') addImage(null,node);
      if (operation === 'from-text-speech') addSpeech(null, node);
      if (['ai-manage-skills', 'generation-manage-skills'].includes(operation)) { bridge.openSkills?.(); return; }
      if (operation === 'ai-run') { finishEditing(); await bridge.runAiNode(node.id); render({ forceId: node.id }); }
      if (operation === 'ai-create-text') addText(null, normalizeAiConfig(node.aiConfig).output);
      if (operation === 'ai-create-image') addImage(null, node);
      if (operation === 'ai-create-video') addShot(null, node);
      if (operation === 'ai-create-speech') addSpeech(null, node);
      if (operation === 'speech-connections') { bridge.openSpeechConnections?.(); return; }
      if (operation === 'speech-open-page') { bridge.openSpeech?.(node.speechConfig?.text || '', { nodeId: node.id }); return; }
      if (operation === 'speech-voices') {
        try { await bridge.loadSpeechVoices?.(node.speechConfig?.model); render({ forceId: node.id }); }
        catch (error) { report(error); }
        return;
      }
      if (operation === 'speech-refresh') { try { await bridge.refreshSpeechJobs?.(); render({ forceId: node.id }); } catch (error) { report(error); } return; }
      if (operation === 'speech-save') {
        const job = (state().speechJobs || []).find(item => item.nodeId === node.id && item.state === 'save_pending');
        if (!job) return;
        try { button.disabled = true; await bridge.api(`/api/speech-jobs/${job.id}/save`, 'POST', {}); await bridge.refreshSpeechJobs?.(); render({ forceId: node.id }); }
        catch (error) { report(error); }
        finally { if (button.isConnected) button.disabled = false; }
        return;
      }
      if (operation === 'speech-generate') {
        if (speechSubmitting.has(node.id)) return;
        speechSubmitting.add(node.id); refreshSpeechControls(card,node);
        try { finishEditing(); await bridge.submitSpeechCard?.(node.id, normalizeSpeechDraft(node.speechConfig)); await bridge.refreshSpeechJobs?.(); render({ forceId: node.id }); }
        catch (error) { report(error); }
        finally { speechSubmitting.delete(node.id); refreshSpeechControls(card,node); }
        return;
      }
      if (operation === 'ai-create-scenes') addAiScenes(node);
      if (operation === 'image-generate') {finishEditing();await bridge.generateImageCard(node.id);render();}
      if (operation === 'image-refresh') {await bridge.refreshImageJobs();render();}
      if (operation === 'image-retry') {await bridge.retryImageCard(node.id);render();}
      if (operation === 'image-disconnect') changeGraph(() => {graph().links=graph().links.filter(link => link.id!==button.dataset.linkId);});
      if (operation === 'locate-reference') locateReference(node, button.dataset.referenceKey);
      if (operation === 'image-create-next') addImage(null,node);
      if (operation === 'image-create-video') addShot(null,node);
      if (operation === 'relink') openAssets(null, node.id);
       if (operation === 'preview') { const asset = project().assets.find(asset => !asset.deletedAt && asset.id === (button.dataset.assetId || node.assetId)); if (asset) bridge.previewAsset(asset); }
       if (operation === 'select-image-candidate' && isImageGenerationNode(node)) {
         button.disabled = true; await bridge.selectImageCandidate(node.id, button.dataset.assetId); render({ forceId: node.id });
       }
      if (operation === 'place-asset') {
        const asset = project().assets.find(asset => !asset.deletedAt && asset.id === button.dataset.assetId && ['image', 'video'].includes(asset.kind));
        if (!asset) return bridge.toast('这个生成结果尚未保存，请稍后刷新。', true);
        const existing = graph().nodes.find(item => !item.sceneId && item.assetId === asset.id);
        addAsset(asset);
        bridge.toast(existing ? '这个视频已经在画布上，可连接到其他视频卡片。' : '已放到画布，请从素材卡右侧端口拖到目标视频卡片。');
      }
      if (operation === 'details') bridge.setView('videos');
      if (operation === 'guide') {
        if (node.kind === 'brief') openBrief();
        else if (node.kind === 'audio') {
          const incoming = graph().links.filter(link => link.to === node.id).map(link => graph().nodes.find(source => source.id === link.from));
          const text = incoming.map(source => source?.kind === 'ai' ? normalizeAiConfig(source.aiConfig).output : source?.note || '').filter(value => value.trim()).join('\n\n');
          bridge.openSpeech?.(text || node.note || '', { nodeId: node.id });
        }
        else if (node.kind === 'image') openAssets(null, node.id);
        else if (node.kind === 'video') {
          const unplaced = project().scenes.find(item => !graph().nodes.some(card => card.sceneId === item.id));
          if (unplaced) changeGraph(() => { node.sceneId = unplaced.id; node.label = unplaced.title; node.width = CARD_WIDTH; node.height = CARD_HEIGHT; });
          else if (project().scenes.length) syncScenes();
          else {
            const created = bridge.createScene('', '新的视频');
            changeGraph(() => { node.sceneId = created.id; node.label = created.title; node.width = CARD_WIDTH; node.height = CARD_HEIGHT; });
          }
        } else bridge.setView(info[node.kind][3]);
      }
      if (operation === 'insert-reference') {
        const control = card.querySelector('[data-reference-prompt]');
        const references = isImageGenerationNode(node) ? resolveImageInputs(project(),node).references.filter(item => item.kind === 'image')
          : scene ? resolveSceneReferences(project(),scene) : [];
        const reference = references.find(item => referenceKey(item) === button.dataset.referenceKey);
        if (control && reference) promptEditor.insert(control,reference);
      }
      if (operation === 'disconnect-reference' && scene) {
        if (!changeGraph(() => { graph().links = withoutSceneReferenceLinks(graph(), scene.id, button.dataset.referenceNode); })) return;
        bridge.toast('已断开画布连接，原文件保留');
      }
      if (operation === 'generate' && scene) { await bridge.generateScene(scene.id); render(); }
      if (operation === 'select-candidate' && scene) { button.disabled = true; await bridge.selectAsset(scene.id, button.dataset.assetId); render({ forceId: node.id }); }
      if (operation === 'expand-candidates' && scene) {
        const candidates = project().assets.filter(asset => !asset.deletedAt && asset.kind === 'video' && asset.source === 'model' && asset.sceneId === scene.id
          && !graph().nodes.some(item => item.assetId === asset.id));
        if (!candidates.length) return bridge.toast('这组候选已经在画布上了。');
        if (!ensureCapacity(candidates.length)) return;
        const columns = Math.min(candidates.length, 3), rows = Math.ceil(candidates.length / 3);
        const origin = clearSpace({ x: node.x + node.width + 100, y: node.y }, columns * (CARD_WIDTH + 90) - 90, rows * (CARD_HEIGHT + 90) - 90);
        changeGraph(() => { candidates.forEach((asset, index) => {
          const next = baseNode('video', asset.name.slice(0, 80), { x: origin.x + index % 3 * (CARD_WIDTH + 90), y: origin.y + Math.floor(index / 3) * (CARD_HEIGHT + 90) });
          Object.assign(next, { assetId: asset.id, assetName: asset.name, status: 'done' }); graph().nodes.push(next);
        }); }); fit(); bridge.toast(`已展开 ${candidates.length} 个候选，视频卡片可分别播放比较。`);
      }
    } catch (error) { report(error); render(); }
  });
  const promptEditor = createReferencePromptEditor({ container: nodesLayer,
    onHighlight: (control, reference) => {
      const card = control.closest('.canvas-node');
      promptReference = card && reference ? { to: card.dataset.nodeId, key: referenceKey(reference) } : null;
      updateLinkFocus();
    },
    getReferences: control => {
      const node = graph().nodes.find(node => node.id === control.closest('.canvas-node')?.dataset.nodeId);
      if (control.dataset.imageField === 'prompt' && isImageGenerationNode(node)) {
        return resolveImageInputs(project(),node).references.filter(reference => reference.kind === 'image');
      }
      const scene = project()?.scenes.find(scene => scene.id === node?.sceneId);
      return scene ? resolveSceneReferences(project(),scene) : [];
    },
    onInsert: (control, reference, range) => {
      const card = control.closest('.canvas-node'), node = graph().nodes.find(node => node.id === card?.dataset.nodeId);
      if (control.dataset.imageField === 'prompt' && isImageGenerationNode(node)) {
        try {
          const references = resolveImageInputs(project(),node).references.filter(reference => reference.kind === 'image');
          const result = insertReferenceMention(control.value || '', [], range, reference, references);
          node.imageConfig = normalizeImageConfig({...node.imageConfig,prompt:result.prompt});
          control.value = result.prompt; control.setSelectionRange(result.caret,result.caret);
          bridge.mark('graph'); refreshImageControls(card,node); return true;
        } catch (error) { report(error); return false; }
      }
      const scene = project().scenes.find(scene => scene.id === node?.sceneId);
      if (!scene) return false;
      try {
        const result = insertReferenceMention(scene.videoPrompt || '', scene.promptMentions || [], range, reference, resolveSceneReferences(project(),scene));
        scene.videoPrompt = result.prompt; scene.promptMentions = result.mentions; control.value = result.prompt; control.setSelectionRange(result.caret,result.caret);
        bridge.mark('scenes'); refreshShotControls(card,scene,node); return true;
      } catch (error) { report(error); return false; }
    } });
  nodesLayer.addEventListener('pointerdown', event => {
    const button = event.target.closest('[data-card-action="insert-reference"]');
    if (event.button === 0 && button && !button.disabled) event.preventDefault();
  });
  root.addEventListener('click', event => {
    if (!project() || suppressClick) return;
    const add = event.target.closest('[data-canvas-add]');
    if (add) {
      const point = add.closest('#canvas-context-menu') ? contextPoint : null;
      contextMenu.hidden = true;
      if (add.dataset.canvasAdd === 'text') addText(point);
      if (add.dataset.canvasAdd === 'ai') addAi(point);
      if (add.dataset.canvasAdd === 'shot') addShot(point);
      if (add.dataset.canvasAdd === 'image') addImage(point);
      if (add.dataset.canvasAdd === 'speech') addSpeech(point);
      if (add.dataset.canvasAdd === 'assets') openAssets(point);
    }
    const toolButton = event.target.closest('[data-canvas-tool]');
    if (toolButton) { tool = toolButton.dataset.canvasTool; spaceDown = false; connectionFrom = ''; updateTools(); }
  });
  $('#canvas-asset-picker').addEventListener('click', event => {
    const item = event.target.closest('[data-canvas-asset]'); if (!item) return;
    const asset = project().assets.find(asset => !asset.deletedAt && asset.id === item.dataset.canvasAsset); if (!asset) return;
    addAsset(asset, panelPoint); panelPoint = null;
  });
  $('#canvas-asset-picker').addEventListener('dragstart', event => {
    const item = event.target.closest('[data-canvas-asset]'); if (!item) return;
    event.dataTransfer.setData('text/x-jingce-asset', item.dataset.canvasAsset); event.dataTransfer.effectAllowed = 'copy';
  });
  viewport.addEventListener('dragover', event => {
    if (event.dataTransfer.types.includes('Files') || event.dataTransfer.types.includes('text/x-jingce-asset') || event.dataTransfer.types.includes('text/x-jingce-chat-image')) {
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; viewport.classList.add('file-drag-over');
    }
  });
  viewport.addEventListener('dragleave', event => { if (!viewport.contains(event.relatedTarget)) viewport.classList.remove('file-drag-over'); });
  viewport.addEventListener('drop', async event => {
    if (!project()) return;
    event.preventDefault(); viewport.classList.remove('file-drag-over');
    const point = screenToWorld(localPoint(event), graph().viewport), assetId = event.dataTransfer.getData('text/x-jingce-asset');
    const chatImage = event.dataTransfer.getData('text/x-jingce-chat-image');
    if (chatImage) {
      try { await bridge.importChatImage?.(JSON.parse(chatImage), point); }
      catch (error) { report(error); }
      return;
    }
    if (assetId) { const asset = project().assets.find(asset => !asset.deletedAt && asset.id === assetId); if (asset) addAsset(asset, point); return; }
    if (event.dataTransfer.files.length) await uploadToCanvas([...event.dataTransfer.files], point);
  });
  async function uploadToCanvas(files, point = null) {
    if (!files.length || !project()) return;
    const id = project().id;
    try {
      const assets = await bridge.uploadFiles(files);
      if (id !== project()?.id) return;
      const base = point || place(null, CARD_WIDTH, CARD_HEIGHT);
      const available = assets.slice(0, 60 - graph().nodes.length);
      available.forEach((asset, index) => addAsset(asset, { x: base.x + index % 3 * (CARD_WIDTH + 90), y: base.y + Math.floor(index / 3) * (CARD_HEIGHT + 90) }));
      if (available.length < assets.length) bridge.toast('素材已上传；画布已达到 60 张卡片，请移除后从素材抽屉继续放入。', true);
      renderAssets();
    } catch (error) { report(error); }
  }
  const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.multiple = true;
  fileInput.accept = 'image/png,image/jpeg,image/webp,video/mp4,audio/mpeg,audio/wav'; fileInput.hidden = true; root.append(fileInput);
  fileInput.addEventListener('change', async () => { $('#canvas-upload').disabled = true; try { await uploadToCanvas([...fileInput.files], panelPoint); }
    finally { $('#canvas-upload').disabled = false; fileInput.value = ''; panelPoint = null; } });
  $('#canvas-upload').onclick = () => fileInput.click();
  document.addEventListener('paste', event => {
    if (!project() || !visible() || editing(event.target)) return;
    if (event.clipboardData?.files.length) { event.preventDefault(); uploadToCanvas([...event.clipboardData.files]); }
  });
  document.addEventListener('keydown', event => {
    if (!project() || !visible() || $('dialog[open]')) return;
    if (event.key === 'Escape' && activeCoverCard && !interaction && !connectionFrom && contextMenu.hidden) {
      event.preventDefault(); closeCoverDetails(); viewport.focus({ preventScroll: true }); return;
    }
    if (event.key === 'Escape' && root.classList.contains('canvas-expanded') && !interaction && !connectionFrom && contextMenu.hidden && !event.target.closest('.reference-mention-menu')) {
      event.preventDefault();
      setExpanded(false);
      $('#expand-canvas').focus({ preventScroll: true });
      return;
    }
    if (event.target.closest('#canvas-text-panel,#text-selection-actions')) return;
    if (editing(event.target)) {
      if (event.key === 'Enter' && event.target.dataset.nodeField === 'label') { event.preventDefault(); event.target.blur(); }
      if (event.key === 'Enter' && !event.isComposing && event.target.dataset.canvasGroupField === 'label') {
        event.preventDefault(); event.target.blur();
        tool = 'select'; spaceDown = false; updateTools();
        viewport.focus({ preventScroll: true });
      }
      return;
    }
    if (interactive(event.target) && [' ', 'Enter'].includes(event.key)) return;
    const modified = event.ctrlKey || event.metaKey;
    if (event.key === ' ' && !modified) { spaceDown = true; event.preventDefault(); updateTools(); }
    if (!modified && event.key.toLowerCase() === 'h') { tool = 'hand'; updateTools(); }
    if (!modified && event.key.toLowerCase() === 'v') { tool = 'select'; updateTools(); }
    if (event.key === 'Escape') { contextMenu.hidden = true; connectionFrom = ''; connectionTargetId = ''; marquee.hidden = true;
      if (interaction?.mode === 'connect' || interaction?.mode === 'marquee') { const pointerId = interaction.pointerId; interaction = null; if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId); }
      render(); }
    if (modified && event.key.toLowerCase() === 'z') { event.preventDefault(); history(event.shiftKey ? 'redo' : 'undo'); }
    if (modified && event.key.toLowerCase() === 'y') { event.preventDefault(); history('redo'); }
    if (modified && event.key.toLowerCase() === 'a') { event.preventDefault(); selection = new Set(graph().nodes.map(node => node.id)); selectedLink = ''; updateTools(); drawMinimap(); }
    if (modified && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelection(); }
    if (['Delete', 'Backspace'].includes(event.key) && (selection.size || selectedLink)) { event.preventDefault(); deleteSelection(); }
    if (!modified && ['+', '='].includes(event.key)) { event.preventDefault(); zoom(1.2); }
    if (!modified && event.key === '-') { event.preventDefault(); zoom(1 / 1.2); }
    if (event.key === 'F2' && selection.size === 1) {
      event.preventDefault(); const card = cards.get([...selection][0]); card?.focus({ preventScroll: true });
      showCoverDetails(card);
      const input = card?.querySelector('[data-node-field="label"]');
      if (input) { input.focus(); input.select(); }
    }
  });
  document.addEventListener('keyup', event => { if (event.key === ' ') { spaceDown = false; updateTools(); } });
  window.addEventListener('blur', () => { spaceDown = false; updateTools(); });
  document.addEventListener('pointerdown', event => { if (!contextMenu.contains(event.target)) contextMenu.hidden = true; });
  minimap.addEventListener('pointerdown', event => {
    if (!project() || !minimapBounds) return;
    event.preventDefault(); const rect = minimap.getBoundingClientRect(), box = minimapBounds;
    const point = { x: box.x + (event.clientX - rect.left) / rect.width * box.width,
      y: box.y + (event.clientY - rect.top) / rect.height * box.height };
    setViewport({ ...graph().viewport, x: viewport.clientWidth / 2 - point.x * graph().viewport.zoom,
      y: viewport.clientHeight / 2 - point.y * graph().viewport.zoom });
  });
  $('#close-brief').onclick = () => { briefPanel.hidden = true; };
  $('#close-canvas-assets').onclick = () => { assetsPanel.hidden = true; relinkNodeId = ''; panelPoint = null; };
  const chatResizer = $('#canvas-text-resizer'), chatWidthKey = 'jingce-canvas-chat-width';
  let preferredChatWidth = 0, chatResize = null;
  try { preferredChatWidth = Number(window.localStorage?.getItem(chatWidthKey)) || 0; } catch {}
  function chatWidthLimits() {
    const available = root.clientWidth || window.innerWidth || 1024;
    const narrow = (window.innerWidth || available) <= 900;
    const max = Math.max(220, narrow ? available - 34 : Math.min(760, available - 440));
    return { min: Math.min(narrow ? 220 : 280, max), max, defaultWidth: clamp(available * .34, 310, 450) };
  }
  function applyChatWidth() {
    const limits = chatWidthLimits(), width = Math.round(clamp(preferredChatWidth || limits.defaultWidth, limits.min, limits.max));
    root.style.setProperty('--canvas-chat-width', width + 'px');
    chatResizer.setAttribute('aria-valuemin', String(limits.min));
    chatResizer.setAttribute('aria-valuemax', String(limits.max));
    chatResizer.setAttribute('aria-valuenow', String(width));
    chatResizer.setAttribute('aria-valuetext', width + ' 像素');
    return width;
  }
  function saveChatWidth() {
    try {
      if (preferredChatWidth) window.localStorage?.setItem(chatWidthKey, String(preferredChatWidth));
      else window.localStorage?.removeItem(chatWidthKey);
    } catch {}
  }
  function finishChatResize(cancel = false) {
    if (!chatResize) return;
    const active = chatResize; chatResize = null;
    if (cancel) { preferredChatWidth = active.preferred; applyChatWidth(); }
    else saveChatWidth();
    root.classList.remove('canvas-chat-resizing');
    if (chatResizer.hasPointerCapture(active.pointerId)) chatResizer.releasePointerCapture(active.pointerId);
  }
  chatResizer.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !root.classList.contains('canvas-chat-open')) return;
    event.preventDefault(); event.stopPropagation();
    chatResize = { pointerId: event.pointerId, x: event.clientX, width: applyChatWidth(), preferred: preferredChatWidth };
    root.classList.add('canvas-chat-resizing'); chatResizer.setPointerCapture(event.pointerId);
  });
  chatResizer.addEventListener('pointermove', event => {
    if (!chatResize || event.pointerId !== chatResize.pointerId) return;
    const limits = chatWidthLimits();
    preferredChatWidth = clamp(chatResize.width + chatResize.x - event.clientX, limits.min, limits.max);
    applyChatWidth();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) chatResizer.addEventListener(type, event => {
    if (chatResize && event.pointerId === chatResize.pointerId) finishChatResize(type === 'pointercancel');
  });
  chatResizer.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const limits = chatWidthLimits();
    preferredChatWidth = event.key === 'Home' ? 0 : event.key === 'End' ? limits.max
      : clamp(applyChatWidth() + (event.key === 'ArrowLeft' ? 1 : -1) * (event.shiftKey ? 50 : 20), limits.min, limits.max);
    applyChatWidth(); saveChatWidth();
  });
  window.addEventListener('resize', () => { if (root.classList.contains('canvas-chat-open')) applyChatWidth(); });
  window.addEventListener('blur', () => finishChatResize());
  function setChatOpen(open) {
    const expanded = root.classList.contains('canvas-expanded'), isOpen = expanded && Boolean(open);
    root.classList.toggle('canvas-chat-open', isOpen);
    if (isOpen) applyChatWidth(); else finishChatResize();
    $('#canvas-text-panel').hidden = !isOpen;
    const toggle = $('#toggle-canvas-text');
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.textContent = isOpen ? '收起对话' : '语言模型';
    toggle.title = isOpen ? '收起语言模型侧栏' : '打开语言模型侧栏';
    $('#close-canvas-text').onclick = () => setChatOpen(false);
    bridge.setTextChatDocked?.(isOpen);
  }
  function setExpanded(expanded) {
    const isExpanded = Boolean(expanded);
    if (!isExpanded && document.fullscreenElement === root) {
      document.exitFullscreen?.().catch(report);
    }
    root.classList.toggle('canvas-expanded', isExpanded);
    $('#expand-canvas').setAttribute('aria-pressed', String(isExpanded));
    $('#expand-canvas').textContent = isExpanded ? '收起 ↙' : '展开 ↗';
    $('#expand-canvas').title = isExpanded ? '收起画布（Esc）' : '全屏画布';
    setChatOpen(isExpanded);
    requestAnimationFrame(() => { if (project()) applyViewport(); });
  }
  $('#toggle-canvas-text').onclick = () => setChatOpen(!root.classList.contains('canvas-chat-open'));
  $('#expand-canvas').onclick = () => {
    const expanded = !root.classList.contains('canvas-expanded');
    setExpanded(expanded);
    if (expanded && root.requestFullscreen) {
      root.requestFullscreen().catch(() => bridge.toast('浏览器未允许全屏，画布已铺满窗口。', true));
    }
  };
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && root.classList.contains('canvas-expanded')) setExpanded(false);
  });
  $('#undo-canvas').onclick = () => history('undo'); $('#redo-canvas').onclick = () => history('redo');
  $('#create-canvas-group').onclick = createGroup;
  $('#duplicate-selection').onclick = duplicateSelection; $('#remove-selection').onclick = deleteSelection;
  $('#arrange-canvas').onclick = arrange; $('#fit-canvas').onclick = fit;
  $('#zoom-in').onclick = () => zoom(1.2); $('#zoom-out').onclick = () => zoom(1 / 1.2);
  $('#zoom-level').onclick = () => setViewport(zoomAt(graph().viewport, 1, { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }));
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (project() && visible()) applyViewport(); }).observe(viewport);
  return { render, reset, fit, activate: () => requestAnimationFrame(() => render()), finishEditing, syncScenes, addAsset, addAi, addAiScenes, addImage, addShot, addSpeech,
    addPromptImage: prompt => addPromptDraft('image', prompt), addPromptVideo: prompt => addPromptDraft('video', prompt),
    setExpanded, openBrief,
    busy: () => Boolean(interaction || (nodesLayer.contains(document.activeElement) || groupsLayer.contains(document.activeElement)) && editing(document.activeElement) || playing(nodesLayer)) };
}
