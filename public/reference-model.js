import { isImageGenerationNode } from './image-parameters.js';

const REFERENCE_KINDS = new Set(['image', 'video', 'audio']);
const text = (value, max = 1200) => typeof value === 'string' ? value.trim().slice(0, max) : '';

// A deterministic legacy identity keeps read-only resolution pure. Once synced,
// this refId is saved with the scene; new UI references may use crypto.randomUUID.
function legacyRefId(scene, reference, index) {
  const value = JSON.stringify([scene?.id || '', reference.kind, reference.assetId || '', reference.assetId ? '' : reference.name || '', reference.assetId ? '' : index]);
  let left = 2166136261, right = 2246822519;
  for (let position = 0; position < value.length; position++) {
    const code = value.charCodeAt(position);
    left = Math.imul(left ^ code, 16777619); right = Math.imul(right ^ code, 3266489917);
  }
  return 'legacy-' + (left >>> 0).toString(16).padStart(8, '0') + (right >>> 0).toString(16).padStart(8, '0');
}
function sceneReferences(scene) {
  const raw = Array.isArray(scene?.references) ? [...scene.references] : [];
  const legacy = text(scene?.referenceAssetId, 100);
  if (legacy && !raw.some(reference => reference?.assetId === legacy)) raw.unshift({ assetId: legacy, kind: 'image' });
  return raw.filter(reference => reference && REFERENCE_KINDS.has(reference.kind)).map((reference, index) => {
    const result = { assetId: text(reference.assetId, 100), kind: reference.kind, name: text(reference.name, 200), note: text(reference.note) };
    const publicUrl = text(reference.publicUrl, 4096);
    if (publicUrl) result.publicUrl = publicUrl;
    if (reference.role) result.role = text(reference.role, 40);
    const nodeId = text(reference.nodeId, 100), refId = text(reference.refId, 100);
    if (nodeId) result.nodeId = nodeId;
    if (refId) result.refId = refId;
    else if (!nodeId) result.refId = legacyRefId(scene, result, index);
    return result;
  });
}
function sameAsset(left, right) {
  return left.kind === right.kind && Boolean(left.assetId) && left.assetId === right.assetId;
}
function sameNode(left, right) {
  return left.nodeId === right.nodeId && left.kind === right.kind && (!left.assetId || left.assetId === right.assetId);
}

export function referenceKey(reference) {
  const nodeId = text(reference?.nodeId, 100), refId = text(reference?.refId, 100);
  return nodeId ? 'node:' + nodeId : refId ? 'ref:' + refId : '';
}

export function referenceLabel(references, index) {
  const reference = references?.[index];
  if (!reference || !REFERENCE_KINDS.has(reference.kind)) return '';
  const order = references.slice(0, index + 1).filter(item => item?.kind === reference.kind).length;
  return ({ image: '图片', video: '视频', audio: '音频' }[reference.kind]) + order;
}

// Scene cards expose a pinned output on each reference edge. Legacy flow edges
// have no reference snapshot and must never change into references by themselves.
export function canvasLinkReference(source, link) {
  if (!source || !REFERENCE_KINDS.has(source.kind)) return null;
  const output = source.sceneId || isImageGenerationNode(source) ? link?.reference : { assetId: source.assetId, kind: source.kind, name: source.assetName };
  if (!output || !REFERENCE_KINDS.has(output.kind)) return null;
  const assetId = text(output.assetId, 100), name = text(output.name, 200);
  if (!assetId && !name) return null;
  return { nodeId: source.id, assetId, kind: output.kind, name, note: '' };
}

// Duplicate cards share a scene. Check media dependencies by scene identity so
// copying a card cannot create a self-reference or a cycle through its duplicate.
export function sceneReferenceCycle(graph, from, to) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const sourceScene = nodes.get(from)?.sceneId, targetScene = nodes.get(to)?.sceneId;
  if (!sourceScene || !targetScene) return false;
  const stack = [targetScene], seen = new Set();
  while (stack.length) {
    const sceneId = stack.pop();
    if (sceneId === sourceScene) return true;
    if (seen.has(sceneId)) continue;
    seen.add(sceneId);
    for (const link of graph.links) {
      if (link.reference && nodes.get(link.from)?.sceneId === sceneId && nodes.get(link.to)?.sceneId) stack.push(nodes.get(link.to).sceneId);
    }
  }
  return false;
}

// Incoming links are read in their stored order, across every card for the scene.
// Linked material wins over a manual item, while retaining its refId and purpose.
export function resolveSceneReferences(project, scene) {
  const assets = new Map((project?.assets || []).map(asset => [asset.id, asset]));
  const existing = sceneReferences(scene).filter(reference => !assets.get(reference.assetId)?.deletedAt);
  const nodes = new Map((project?.graph?.nodes || []).map(node => [node.id, node]));
  const result = [], usedAssets = new Set(), usedNodes = new Set(), usedRefs = new Set();
  for (const link of project?.graph?.links || []) {
    const target = nodes.get(link.to), source = nodes.get(link.from);
    if (!scene?.id || target?.kind !== 'video' || target.sceneId !== scene.id || source?.sceneId === scene.id) continue;
    const linked = canvasLinkReference(source, link);
    if (!linked || assets.get(linked.assetId)?.deletedAt || usedNodes.has(source.id) || (linked.assetId && usedAssets.has(linked.assetId))) continue;
    const { assetId } = linked;
    linked.name = text(assets.get(assetId)?.name, 200) || linked.name;
    const matches = existing.filter(reference => sameNode(reference, linked) || sameAsset(reference, linked));
    const previous = matches.find(reference => reference.nodeId === source.id) || matches.find(reference => reference.nodeId) || matches[0];
    const manual = matches.find(reference => reference.refId);
    if (!assetId) linked.name = previous?.name || linked.name;
    linked.note = previous?.note || matches.find(reference => reference.note)?.note || '';
    if (previous?.role) linked.role = previous.role;
    // Replacing a material never inherits the old material's remote address.
    if (previous?.assetId === assetId && previous?.publicUrl) linked.publicUrl = previous.publicUrl;
    if (manual?.refId) { linked.refId = manual.refId; usedRefs.add(manual.refId); }
    result.push(linked); usedNodes.add(source.id);
    if (assetId) usedAssets.add(assetId);
  }
  for (const reference of existing) {
    // A purely linked item disappears on disconnect. A former manual item returns.
    if (reference.nodeId && !reference.refId) continue;
    if (usedRefs.has(reference.refId) || (reference.assetId && usedAssets.has(reference.assetId))) continue;
    const { nodeId, ...manual } = reference;
    result.push(manual); usedRefs.add(manual.refId);
    if (manual.assetId) usedAssets.add(manual.assetId);
  }
  return result;
}

// Remove a material from future work while retaining its canvas card and files.
export function detachAssetReferences(project, assetId) {
  const asset = project.assets.find(item => item.id === assetId);
  const detachedNodes = new Set();
  for (const node of project.graph.nodes) {
    if (node.assetId !== assetId && node.selectedAssetId !== assetId) continue;
    detachedNodes.add(node.id);
    if (node.assetId === assetId) node.assetId = '';
    if (node.selectedAssetId === assetId) node.selectedAssetId = '';
    node.assetName = text(asset?.name, 120) || node.assetName; node.status = 'pending';
  }
  const shotNodes = new Set(project.graph.nodes.filter(node => node.kind === 'video' && node.sceneId).map(node => node.id));
  project.graph.links = project.graph.links.filter(link => link.reference?.assetId !== assetId
    && (!detachedNodes.has(link.from) || !shotNodes.has(link.to)));
  for (const scene of project.scenes) {
    if (scene.videoAssetId === assetId) scene.videoAssetId = '';
    if (scene.referenceAssetId === assetId) scene.referenceAssetId = '';
    scene.references = (scene.references || []).filter(reference => reference.assetId !== assetId && !detachedNodes.has(reference.nodeId));
  }
  return project;
}

export function syncProjectReferences(project) {
  for (const scene of project.scenes || []) {
    scene.references = resolveSceneReferences(project, scene);
    scene.referenceAssetId = '';
  }
  return project;
}

// A reference may be represented by several material cards and several shot cards.
// Removing it from a reference list disconnects every matching incoming link for
// that scene. Selecting a single edge uses the canvas' separate edge deletion.
export function withoutSceneReferenceLinks(graph, sceneId, nodeId) {
  const links = graph?.links || [], nodes = new Map((graph?.nodes || []).map(node => [node.id, node]));
  if (!sceneId || !nodes.has(nodeId)) return [...links];
  const incoming = link => nodes.get(link.to)?.kind === 'video' && nodes.get(link.to)?.sceneId === sceneId;
  const selectedLink = links.find(link => link.from === nodeId && incoming(link) && canvasLinkReference(nodes.get(link.from), link));
  const selected = selectedLink && canvasLinkReference(nodes.get(nodeId), selectedLink);
  if (!selected) return [...links];
  return links.filter(link => {
    if (!incoming(link)) return true;
    const reference = canvasLinkReference(nodes.get(link.from), link);
    if (!reference) return true;
    if (reference.nodeId === nodeId) return false;
    return !sameAsset(reference, selected);
  });
}
