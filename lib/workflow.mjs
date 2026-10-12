import { randomUUID } from 'node:crypto';
import { normalizeImageConfig, isImageGenerationNode } from '../public/image-parameters.js';
import { CARD_WIDTH, CARD_HEIGHT, CARD_SIZE_VERSION } from '../public/canvas-layout.js';
import { canvasLinkReference, sceneReferenceCycle, resolveSceneReferences, syncProjectReferences, detachAssetReferences, referenceLabel } from '../public/reference-model.js';
import { normalizePromptMentions, remapPromptMentions, createPortablePromptMentionMapper } from '../public/prompt-mentions.js';
import { normalizeAiConfig } from '../public/ai-text.js';

export const MAX_GENERATION_COUNT = 5;
// Local submission is unlimited; the provider may still queue or rate-limit requests.
export const MAX_CONCURRENT_TASKS = null;

export const kinds = {
  text: { label: '文字便签', accepts: [], produces: 'text' },
  ai: { label: 'AI 创作', accepts: ['text', 'image'], produces: 'text' },
  brief: { label: '创作需求', accepts: [], produces: 'text' },
  script: { label: '脚本构思', accepts: ['text'], produces: 'text' },
  storyboard: { label: '创作规划', accepts: ['text', 'image'], produces: 'text' },
  image: { label: '画面素材', accepts: ['text', 'image'], produces: 'image' },
  video: { label: '视频片段', accepts: ['text', 'image', 'video', 'audio'], produces: 'video' },
  audio: { label: '声音素材', accepts: ['text', 'audio'], produces: 'audio' },
  compose: { label: '成片交付', accepts: ['video', 'audio', 'image', 'text'], produces: 'video' },
};

export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const text = (value, max = 4000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const number = (value, min, max, fallback) => Number.isFinite(Number(value))
  ? Math.max(min, Math.min(max, Number(value))) : fallback;

// This is a local planning limit, not a claim about a provider's input contract.
export const REFERENCE_PREPARATION_LIMIT = 100;

export function normalizeReferences(value, legacyAssetId = '', enforceLimit = true) {
  if (value !== undefined && !Array.isArray(value)) throw new InputError('参考素材清单格式不正确。');
  const items = [...(value || [])], legacyId = text(legacyAssetId, 100);
  if (legacyId && !items.some(item => item?.assetId === legacyId)) items.unshift({ assetId: legacyId, kind: 'image' });
  const referenceIds = new Map();
  const normalized = items.map(item => {
    if (!item || typeof item !== 'object' || !['image', 'video', 'audio'].includes(item.kind)) throw new InputError('参考素材仅支持图片、视频和音频。');
    const reference = { assetId: text(item.assetId, 100), kind: item.kind, name: text(item.name, 200), note: text(item.note, 1200) };
    if (item.role) {
      const roles = { image: ['reference_image', 'first_frame', 'last_frame', 'end_frame'], video: ['reference_video'], audio: ['reference_audio'] };
      if (!roles[item.kind].includes(item.role)) throw new InputError('参考素材的用途类型不正确。');
      reference.role = item.role;
    }
    if (typeof item.publicUrl === 'string' && item.publicUrl.length > 4096) throw new InputError('素材链接超过 4096 个字符。');
    const publicUrl = text(item.publicUrl, 4096);
    if (publicUrl) reference.publicUrl = publicUrl;
    const nodeId = text(item.nodeId, 100), refId = text(item.refId, 100);
    if (nodeId) reference.nodeId = nodeId;
    if (refId) reference.refId = refId;
    else if (!nodeId) reference.refId = randomUUID();
    if (reference.refId) {
      const identity = JSON.stringify([reference.assetId, reference.kind]);
      if (referenceIds.has(reference.refId) && referenceIds.get(reference.refId) !== identity) throw new InputError('参考素材编号重复。');
      referenceIds.set(reference.refId, identity);
    }
    return reference;
  });
  // Raw linked/manual copies may overlap. Count only the merged material list.
  if (enforceLimit) {
    const seen = new Set();
    const unique = normalized.filter(reference => {
      const key = reference.assetId ? 'asset:' + reference.assetId : reference.nodeId ? 'node:' + reference.nodeId : 'ref:' + reference.refId;
      if (seen.has(key)) return false; seen.add(key); return true;
    });
    if (unique.length > REFERENCE_PREPARATION_LIMIT) throw new InputError('参考素材超过本机存储上限 100 份。');
    return unique;
  }
  return normalized;
}

function normalizedMentions(value, prompt) {
  try { return normalizePromptMentions(value, prompt); }
  catch (error) { throw new InputError(error.message); }
}
function remapScene(scene, beforeReferences) {
  try {
    const remapped = remapPromptMentions(scene.videoPrompt, scene.promptMentions, beforeReferences, scene.references);
    scene.videoPrompt = remapped.prompt; scene.promptMentions = remapped.mentions;
  } catch (error) { throw new InputError(error.message); }
}
function validateSceneReferences(project) {
  const assets = new Map(project.assets.filter(asset => !asset.deletedAt).map(asset => [asset.id, asset]));
  for (const scene of project.scenes) {
    for (const reference of scene.references) {
      if (!reference.assetId) continue;
      const asset = assets.get(reference.assetId);
      if (!asset || asset.kind !== reference.kind) throw new InputError('视频生成项关联了不存在或类型不匹配的参考素材。');
      reference.name = text(asset.name, 200);
    }
  }
}
function validateSubmittedNodes(project, previous, allowPrevious) {
  const matches = (graph, reference, sceneId) => graph.links.some(link => {
    const source = graph.nodes.find(node => node.id === link.from), target = graph.nodes.find(node => node.id === link.to);
    const output = canvasLinkReference(source, link);
    return link.from === reference.nodeId && target?.kind === 'video' && target.sceneId === sceneId
      && source?.sceneId !== sceneId && output?.kind === reference.kind && (!reference.assetId || output.assetId === reference.assetId);
  });
  for (const scene of project.scenes) {
    for (const reference of scene.references) {
      if (!reference.nodeId) continue;
      if (matches(project.graph, reference, scene.id)) continue;
      if (allowPrevious && matches(previous.graph, reference, scene.id)) continue;
      throw new InputError('画布参考素材与当前视频生成项的连线不一致，请刷新后重新连接。');
    }
  }
}
function syncAndValidateReferences(project, beforeByScene) {
  syncProjectReferences(project);
  validateSceneReferences(project);
  for (const scene of project.scenes) {
    if (scene.references.length > REFERENCE_PREPARATION_LIMIT) throw new InputError('参考素材超过本机存储上限 100 份。');
    remapScene(scene, beforeByScene?.get(scene.id) || scene.references);
  }
}

export function normalizeBrief(value = {}) {
  return {
    product: text(value.product, 120), audience: text(value.audience, 300),
    type: ['story', 'product', 'portrait', 'landscape', 'free'].includes(value.type) ? value.type : 'story',
    benefits: text(value.benefits, 1200), tone: text(value.tone, 120) || '自然、有质感',
    channel: text(value.channel, 120) || '短视频平台',
    duration: Math.round(number(value.duration, 5, 90, 30)),
    ratio: ['9:16', '16:9', '1:1'].includes(value.ratio) ? value.ratio : '9:16',
    cta: text(value.cta, 300) || '用一个有记忆点的画面收尾',
  };
}

export function emptyGraph() {
  return { nodes: [], links: [], groups: [], viewport: { x: 0, y: 0, zoom: 1 }, cardSizeVersion: CARD_SIZE_VERSION };
}

// The editable planning template is added only when a project is explicitly
// turned into a local storyboard draft. New projects start with empty space.
export function defaultGraph() {
  const nodes = [
    { id: 'brief', kind: 'brief', x: 50, y: 70 },
    { id: 'script', kind: 'script', x: 440, y: 70 },
    { id: 'storyboard', kind: 'storyboard', x: 830, y: 70 },
    { id: 'image', kind: 'image', x: 830, y: 420 },
    { id: 'video', kind: 'video', x: 440, y: 420 },
    { id: 'audio', kind: 'audio', x: 440, y: 770 },
    { id: 'compose', kind: 'compose', x: 50, y: 420 },
  ].map(node => ({ ...node, label: kinds[node.kind].label, status: 'pending', note: '',
    width: CARD_WIDTH, height: CARD_HEIGHT, assetId: '', sceneId: '', assetName: '' }));
  return { nodes, links: [
    ['brief', 'script'], ['script', 'storyboard'], ['storyboard', 'image'],
    ['image', 'video'], ['video', 'compose'], ['script', 'audio'], ['audio', 'compose'],
  ].map(([from, to]) => ({ id: randomUUID(), from, to })), groups: [], viewport: { x: 0, y: 0, zoom: 1 }, cardSizeVersion: CARD_SIZE_VERSION };
}

export function validateGraph(value) {
  if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.links)) {
    throw new InputError('工程中的画布格式不正确。');
  }
  if (value.nodes.length > 60 || value.links.length > 160) {
    throw new InputError('第一版每个画布最多支持 60 个节点和 160 条连接。');
  }
  const ids = new Set();
  const nodes = value.nodes.map(node => {
    if (!node || !Object.hasOwn(kinds, node.kind)) throw new InputError('存在不支持的节点类型。');
    const id = text(node.id, 100);
    if (!id || ids.has(id)) throw new InputError('节点编号为空或重复。');
    ids.add(id);
    return { id, kind: node.kind, label: text(node.label, 80) || kinds[node.kind].label,
      x: number(node.x, -1000000, 1000000, 60), y: number(node.y, -1000000, 1000000, 180),
      width: number(node.width, 240, 720, CARD_WIDTH), height: number(node.height, 180, 900, CARD_HEIGHT),
      assetId: text(node.assetId, 100), sceneId: text(node.sceneId, 100), assetName: text(node.assetName, 120),
      status: ['pending', 'draft', 'ready', 'uploaded', 'done', 'failed'].includes(node.status)
        ? node.status : 'pending', note: text(node.note, ['text', 'ai'].includes(node.kind) ? Infinity : 2000),
      ...(node.kind === 'ai' ? { aiConfig: normalizeAiConfig(node.aiConfig) } : {}),
      ...(isImageGenerationNode(node) ? { role: 'image-generation', imageConfig: (() => {
        try { return normalizeImageConfig(node.imageConfig); } catch (error) { throw new InputError(error.message); }
       })(), imageJobId: text(node.imageJobId, 100), selectedAssetId: text(node.selectedAssetId, 100) } : {}) };
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  const pairs = new Set();
  const linkIds = new Set();
  const links = value.links.map(link => {
    if (!link || !ids.has(link.from) || !ids.has(link.to) || link.from === link.to) {
      throw new InputError('连接必须指向两个不同且存在的节点。');
    }
    const pair = `${link.from}\u0000${link.to}`;
    if (pairs.has(pair)) throw new InputError('两个节点之间已经存在相同连接。');
    pairs.add(pair);
    if (!kinds[byId.get(link.to).kind].accepts.includes(kinds[byId.get(link.from).kind].produces)) {
      throw new InputError('这两个节点的输入与输出类型不匹配。');
    }
    const id = text(link.id, 100) || randomUUID();
    if (linkIds.has(id)) throw new InputError('连接编号重复。');
    linkIds.add(id);
    const normalized = { id, from: link.from, to: link.to };
    if (Object.hasOwn(link, 'reference')) {
      const source = byId.get(link.from), target = byId.get(link.to), reference = link.reference;
      const sceneOutput = source.kind === 'video' && source.sceneId && target.kind === 'video' && target.sceneId;
      const imageOutput = isImageGenerationNode(source) && reference?.kind === 'image'
        && (isImageGenerationNode(target) || target.kind === 'video' && target.sceneId);
      if (!reference || typeof reference !== 'object' || !['image', 'video'].includes(reference.kind) || !(sceneOutput || imageOutput)) {
        throw new InputError('生成结果参考必须连接到图片生成卡片或视频生成卡片，且使用类型匹配的图片或视频结果。');
      }
      normalized.reference = { assetId: text(reference.assetId, 100), kind: reference.kind, name: text(reference.name, 200) };
      if (!normalized.reference.assetId && !normalized.reference.name) throw new InputError('生成结果参考缺少具体图片或视频。');
    }
    return normalized;
  });
  for (const link of links) {
    if (link.reference && sceneReferenceCycle({ nodes, links }, link.from, link.to)) throw new InputError('视频参考出现循环，请保留单向的制作流程。');
  }
  if (value.groups !== undefined && !Array.isArray(value.groups)) throw new InputError('画布分组格式不正确。');
  const groupIds = new Set();
  const groups = (value.groups || []).map(group => {
    if (!group || typeof group !== 'object' || !Array.isArray(group.nodeIds)) throw new InputError('画布分组格式不正确。');
    const id = text(group.id, 100);
    if (!id || ids.has(id) || groupIds.has(id)) throw new InputError('分组编号为空或重复。');
    groupIds.add(id);
    const nodeIds = [...new Set(group.nodeIds.map(nodeId => text(nodeId, 100)))];
    if (nodeIds.length < 2 || nodeIds.some(nodeId => !ids.has(nodeId))) throw new InputError('每个分组至少包含两张有效卡片。');
    return { id, label: text(group.label, 80) || '新分组', nodeIds, ...(/^#[0-9a-f]{6}$/i.test(group.color || '') ? { color: group.color } : {}) };
  });
  if (groups.length > 60) throw new InputError('每个画布最多创建 60 个分组。');
  const incoming = new Map(nodes.map(node => [node.id, 0]));
  for (const link of links) incoming.set(link.to, incoming.get(link.to) + 1);
  const queue = nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift(); visited++;
    for (const link of links.filter(link => link.from === id)) {
      incoming.set(link.to, incoming.get(link.to) - 1);
      if (!incoming.get(link.to)) queue.push(link.to);
    }
  }
  if (visited !== nodes.length) throw new InputError('画布出现循环连接，请保留单向的制作流程。');
  const viewport = value.viewport && typeof value.viewport === 'object' ? value.viewport : {};
  return { nodes, links, groups, ...(value.cardSizeVersion === CARD_SIZE_VERSION ? { cardSizeVersion: CARD_SIZE_VERSION } : {}), viewport: {
    x: number(viewport.x, -1000000, 1000000, 0), y: number(viewport.y, -1000000, 1000000, 0),
    zoom: number(viewport.zoom, 0.15, 3, 1),
  } };
}

function validateGraphReferences(project) {
  const assets = new Map(project.assets.filter(asset => !asset.deletedAt).map(asset => [asset.id, asset]));
  const scenes = new Set(project.scenes.map(scene => scene.id));
  for (const node of project.graph.nodes) {
    if (isImageGenerationNode(node) && node.selectedAssetId) {
      const selected = assets.get(node.selectedAssetId);
      if (!selected || selected.kind !== 'image' || selected.nodeId !== node.id) {
        throw new InputError('生图卡片选中的最终素材不存在、类型不匹配，或不属于当前生图卡片。');
      }
    }
    if (node.assetId) {
      const asset = assets.get(node.assetId);
      if (!['image', 'video', 'audio'].includes(node.kind) || !asset || asset.kind !== node.kind) {
        throw new InputError('画布关联了不存在或类型不匹配的素材。');
      }
      node.assetName = text(asset.name, 120);
    }
    if (node.sceneId && (node.kind !== 'video' || !scenes.has(node.sceneId))) {
      throw new InputError('画布视频卡片必须关联本工程中已有的视频生成项，且使用视频节点。');
    }
  }
  for (const link of project.graph.links) {
    if (!link.reference?.assetId) continue;
    const source = project.graph.nodes.find(node => node.id === link.from), asset = assets.get(link.reference.assetId);
    const scene = project.scenes.find(scene => scene.id === source?.sceneId);
    const owned = isImageGenerationNode(source) ? asset?.kind === 'image' && asset.nodeId === source.id
      : scene && (asset?.sceneId === scene.id || scene.videoAssetId === asset?.id);
    if (!asset || asset.kind !== link.reference.kind || !owned) {
      throw new InputError(isImageGenerationNode(source) ? '参考的生成结果不存在、类型不匹配，或不属于来源生图卡片。' : '参考的生成结果不存在、类型不匹配，或不属于来源视频生成项。');
    }
    link.reference.name = text(asset.name, 200);
  }
}

export function normalizeScenes(value) {
  if (!Array.isArray(value) || value.length > 30) throw new InputError('视频生成清单格式不正确，最多支持 30 项。');
  const ids = new Set();
  return value.map((scene, index) => {
    if (!scene || typeof scene !== 'object') throw new InputError('视频生成项内容不正确。');
    const id = text(scene.id, 100) || randomUUID();
    if (ids.has(id)) throw new InputError('视频生成项编号重复。');
    ids.add(id);
    return {
    id, order: index + 1,
    title: text(scene.title, 120) || `视频 ${index + 1}`,
    duration: number(scene.duration, 0.5, 30, 5), visual: text(scene.visual),
    narration: text(scene.narration, 1200), imagePrompt: text(scene.imagePrompt),
    videoPrompt: typeof scene.videoPrompt === 'string' ? scene.videoPrompt.slice(0, 4000) : '', videoAssetId: text(scene.videoAssetId, 100), imageAssetId: text(scene.imageAssetId, 100),
    promptMentions: normalizedMentions(scene.promptMentions ?? scene.videoPromptMentions, typeof scene.videoPrompt === 'string' ? scene.videoPrompt.slice(0, 4000) : ''),
    referenceAssetId: '', references: normalizeReferences(scene.references, scene.referenceAssetId, false),
    generationDuration: number(scene.generationDuration, 0, 300, 0),
    generationCount: Math.round(number(scene.generationCount, 1, MAX_GENERATION_COUNT, 1)),
    videoModel: text(scene.videoModel, 120),
    // These are validated against the selected model's live catalog at submission time.
    ratio: text(scene.ratio, 40),
    resolution: text(scene.resolution, 40),
  }; });
}

export function createProject(input = {}) {
  const now = new Date().toISOString();
  return { id: randomUUID(), title: text(input.title, 120) || '我的第一支 AI 短片',
    createdAt: now, updatedAt: now, revision: 1, brief: normalizeBrief(input.brief),
    graph: emptyGraph(), scenes: [], assets: [], exports: [], planSource: null };
}

export function updateProject(project, patch) {
  if (patch.revision !== project.revision) throw new InputError('工程已在其他窗口更新，请刷新后继续编辑。', 409);
  const result = structuredClone(project), graphChanged = Object.hasOwn(patch, 'graph'), scenesChanged = Object.hasOwn(patch, 'scenes');
  if (Object.hasOwn(patch, 'title')) result.title = text(patch.title, 120) || project.title;
  if (Object.hasOwn(patch, 'brief')) result.brief = normalizeBrief(patch.brief);
  if (graphChanged) result.graph = validateGraph(patch.graph);
  if (graphChanged || scenesChanged) {
    result.scenes = normalizeScenes(scenesChanged ? patch.scenes : result.scenes);
    const assetIds = new Set(project.assets.filter(asset => !asset.deletedAt && asset.kind === 'video').map(asset => asset.id));
    if (result.scenes.some(scene => scene.videoAssetId && !assetIds.has(scene.videoAssetId))) throw new InputError('视频生成项关联了不存在的视频素材。');
    validateGraphReferences(result); validateSceneReferences(result);
    if (scenesChanged) validateSubmittedNodes(result, project, graphChanged);
    // A client may have already synchronized both fields. Its supplied identities
    // describe its prompt; graph-only patches instead use the previous inventory.
    const beforeByScene = new Map(result.scenes.map(scene => [scene.id, scenesChanged ? scene.references
      : resolveSceneReferences(project, project.scenes.find(item => item.id === scene.id) || scene)]));
    syncAndValidateReferences(result, beforeByScene);
  }
  return touch(result);
}

export function setAssetDeleted(project, assetId, deleted) {
  const result = structuredClone(project), asset = result.assets.find(item => item.id === assetId);
  if (!asset) throw new InputError('找不到本工程中的这个素材。', 404);
  if (Boolean(asset.deletedAt) === deleted) return result;
  if (!deleted) {
    asset.deletedAt = null;
    return touch(result);
  }
  const beforeByScene = new Map(project.scenes.map(scene => [scene.id, resolveSceneReferences(project, scene)]));
  result.scenes = normalizeScenes(result.scenes);
  result.graph = validateGraph(result.graph);
  detachAssetReferences(result, assetId);
  asset.deletedAt = new Date().toISOString();
  validateGraphReferences(result);
  syncAndValidateReferences(result, beforeByScene);
  return touch(result);
}

export function touch(project) {
  project.revision++; project.updatedAt = new Date().toISOString(); return project;
}

export function draftPlan(project) {
  const brief = normalizeBrief(project.brief);
  if (!brief.product) throw new InputError('先填写视频主题或主体，再整理创作草案。');
  const points = brief.benefits.split(/[\n；;]+/).map(value => value.trim()).filter(Boolean);
  const count = Math.max(3, Math.min(8, Math.round(brief.duration / 5)));
  const items = [
    ['建立画面', `用全景建立“${brief.product}”的时间、地点和氛围，画面风格为${brief.tone}。`, '在这里写下开场旁白，或留空保持纯画面。'],
    ['主体入场', `让${brief.product}成为清晰的视觉中心，通过一个具体动作引出后续内容。`, '在这里写下主体入场时的旁白。'],
    ...Array.from({ length: count - 3 }, (_, index) => [
      `内容展开 ${index + 1}`, `围绕一个具体事件或细节展开：${points[index % Math.max(points.length, 1)] || '请补充这段视频的画面与动作'}。`,
      points[index % Math.max(points.length, 1)] || '在这里写下对应旁白，也可以留空。',
    ]),
    ['片尾收束', `用稳定、有余韵的画面收束：${brief.cta}。`, '在这里写下片尾旁白，也可以留空。'],
  ];
  const result = structuredClone(project);
  // A new project intentionally has no placeholder cards. Once the user asks
  // for a storyboard draft, restore the planning template so the existing
  // draft workflow and its manual canvas actions remain available.
  if (!result.graph?.nodes?.length && !result.graph?.links?.length) result.graph = defaultGraph();
  result.scenes = normalizeScenes(items.map(([title, visual, narration], index) => ({
    id: randomUUID(), title, duration: Number((brief.duration / count).toFixed(2)), visual, narration,
    imagePrompt: `${brief.ratio} 画面，${brief.tone}，${visual} 如有参考图，保持主体外观一致；不要自行添加文字、水印或不存在的细节。`,
    videoPrompt: `${visual} 运镜克制，主体外观保持稳定，画面风格为${brief.tone}，结尾保留剪辑余量。`,
  })));
  result.planSource = 'local-draft';
  result.graph = validateGraph(result.graph);
  const sceneIds = new Set(result.scenes.map(scene => scene.id));
  for (const node of result.graph.nodes) {
    if (node.sceneId && !sceneIds.has(node.sceneId)) node.sceneId = '';
    node.status = ['brief', 'script', 'storyboard'].includes(node.kind) ? 'draft' : 'pending';
  }
  const bound = new Map(result.graph.nodes.map(node => [node.id,node]));
  result.graph.links = result.graph.links.filter(link => !link.reference
    || isImageGenerationNode(bound.get(link.from)) && isImageGenerationNode(bound.get(link.to))
    || bound.get(link.from)?.sceneId && bound.get(link.to)?.sceneId);
  return touch(result);
}

export function exportProject(project) {
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  const copy = { ...project, graph: validateGraph(project.graph), scenes: normalizeScenes(project.scenes) };
  const beforeByScene = new Map(copy.scenes.map(scene => [scene.id, scene.references]));
  syncProjectReferences(copy);
  for (const scene of copy.scenes) {
    if (scene.references.length > REFERENCE_PREPARATION_LIMIT) throw new InputError('参考素材超过本机存储上限 100 份。');
    remapScene(scene, beforeByScene.get(scene.id));
  }
  const portableMention = createPortablePromptMentionMapper(copy.scenes);
  const graph = copy.graph;
  graph.nodes = graph.nodes.map(node => ({ ...node, assetId: '', assetName: text(assets.get(node.assetId)?.name, 120) || node.assetName,
    ...(isImageGenerationNode(node) ? {imageJobId:'', imageJobIds:[], selectedAssetId:'', status:'pending'} : {}) }));
  graph.links = graph.links.map(link => link.reference ? { ...link, reference: { assetId: '', kind: link.reference.kind,
    name: text(assets.get(link.reference.assetId)?.name, 200) || link.reference.name } } : link);
  return { format: 'jingce-project', schemaVersion: 1, exportedAt: new Date().toISOString(),
    project: { title: project.title, brief: normalizeBrief(project.brief), graph,
      scenes: copy.scenes.map(scene => ({ ...scene, videoAssetId: '', referenceAssetId: '',
        references: scene.references.map(({ publicUrl, ...reference }) => ({ ...reference, assetId: '', name: text(assets.get(reference.assetId)?.name, 200) || reference.name })),
        promptMentions: scene.promptMentions.map(mention => portableMention(mention, scene.references)),
      })), planSource: project.planSource } };
}

export function importProject(input) {
  if (input?.format !== 'jingce-project' || input.schemaVersion !== 1 || !input.project) throw new InputError('请选择镜策导出的工程 JSON 文件。');
  const project = createProject(input.project);
  project.graph = validateGraph(input.project.graph);
  const scenes = normalizeScenes(input.project.scenes || []);
  const portableMention = createPortablePromptMentionMapper(scenes);
  project.scenes = scenes.map(scene => ({ ...scene, videoAssetId: '', referenceAssetId: '',
    references: scene.references.map(({ publicUrl, ...reference }) => ({ ...reference, assetId: '' })),
    promptMentions: scene.promptMentions.map(mention => portableMention(mention, scene.references)),
  }));
  project.planSource = input.project.planSource === 'local-draft' ? 'local-draft' : null;
  for (const node of project.graph.nodes) {
    node.assetId = '';
    if (isImageGenerationNode(node)) {node.imageJobId='';node.imageJobIds=[];node.selectedAssetId='';node.status='pending';}
    if (['done', 'uploaded'].includes(node.status)) node.status = 'pending';
  }
  for (const link of project.graph.links) if (link.reference) link.reference.assetId = '';
  validateGraphReferences(project);
  const beforeByScene = new Map(project.scenes.map(scene => [scene.id, scene.references]));
  syncAndValidateReferences(project, beforeByScene);
  return project;
}

export function screenplay(project) {
  const brief = project.brief;
  return [`# ${project.title} · 创作方案`, '', `视频主题：${brief.product}`, `面向观众：${brief.audience}`,
    `投放位置：${brief.channel} · ${brief.ratio} · ${brief.duration} 秒`, '',
    project.planSource === 'local-draft' ? '本地模板创作草案，尚未调用 AI。请按创作意图编辑画面和提示词。' : '视频创作清单', '',
    ...project.scenes.flatMap(scene => [`## 视频 ${scene.order}：${scene.title}（${scene.duration} 秒）`,
      `画面：${scene.visual}`, `旁白：${scene.narration}`, '', `图片提示词：${scene.imagePrompt}`,
      `视频提示词：${scene.videoPrompt}`,
      ...resolveSceneReferences(project, scene).map((reference, index, references) => {
        const label = referenceLabel(references, index);
        const asset = project.assets.find(item => !item.deletedAt && item.id === reference.assetId);
        return `参考${label}：${asset?.name || reference.name || '待补选素材'}；用途：${reference.note || '待填写'}（生成前请确认参考链接可用）`;
      }), ''])].join('\n');
}
