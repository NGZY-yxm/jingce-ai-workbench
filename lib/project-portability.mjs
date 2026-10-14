import { randomUUID } from 'node:crypto';
import { createProject, updateProject, normalizeBrief, normalizeScenes, validateGraph, InputError } from './workflow.mjs';
import { syncProjectReferences } from '../public/reference-model.js';
import { createPortablePromptMentionMapper, remapPromptMentions } from '../public/prompt-mentions.js';
import { isImageGenerationNode } from '../public/image-parameters.js';
import { validateSkill } from './skills.mjs';

export const PACKAGE_FORMAT = 'miraframe-project-package';
export const PACKAGE_MAX_BYTES = 1024 * 1024 * 1024;
export const PACKAGE_MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
export const PACKAGE_ASSET_MAX_COUNT = 1000;
export const PACKAGE_MEDIA = {
  'image/png': { kind: 'image', extension: '.png', limit: 20 * 1024 * 1024 },
  'image/jpeg': { kind: 'image', extension: '.jpg', limit: 20 * 1024 * 1024 },
  'image/webp': { kind: 'image', extension: '.webp', limit: 20 * 1024 * 1024 },
  'video/mp4': { kind: 'video', extension: '.mp4', limit: 300 * 1024 * 1024 },
  'audio/mpeg': { kind: 'audio', extension: '.mp3', limit: 100 * 1024 * 1024 },
  'audio/wav': { kind: 'audio', extension: '.wav', limit: 100 * 1024 * 1024 },
};
const text = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const identity = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);

function metadata(asset) {
  const result = {
    name: text(asset.name) || '未命名素材', kind: asset.kind, mime: asset.mime,
    source: ['model', 'previs', 'chat'].includes(asset.source) ? asset.source : 'upload',
  };
  for (const [key, max] of [['sceneId', 100], ['nodeId', 100], ['model', 120], ['resolution', 40]]) {
    if (text(asset[key], max)) result[key] = text(asset[key], max);
  }
  if (typeof asset.createdAt === 'string' && Number.isFinite(Date.parse(asset.createdAt))) result.createdAt = new Date(asset.createdAt).toISOString();
  for (const key of ['duration', 'variantIndex', 'variantCount']) {
    if (Number.isFinite(asset[key]) && asset[key] > 0 && asset[key] <= 86400) result[key] = asset[key];
  }
  return result;
}

function portableScenes(scenes) {
  const portable = createPortablePromptMentionMapper(scenes);
  for (const scene of scenes) {
    scene.promptMentions = scene.promptMentions.map(mention => portable(mention, scene.references));
    scene.references = scene.references.map(({ publicUrl, ...reference }) => reference);
  }
}

function remapAssets(project, ids, strict = false) {
  const remap = id => {
    if (!id) return '';
    if (strict && !ids.has(id)) throw new InputError('分享包引用了清单之外的素材。');
    return ids.get(id) || '';
  };
  for (const node of project.graph.nodes) {
    node.assetId = remap(node.assetId);
    if (isImageGenerationNode(node)) {
      node.selectedAssetId = remap(node.selectedAssetId);
      node.imageJobId = ''; node.status = node.assetId ? 'uploaded' : 'pending';
    } else if (['done', 'uploaded', 'failed'].includes(node.status)) {
      node.status = node.assetId ? 'uploaded' : 'pending';
    }
  }
  for (const link of project.graph.links) if (link.reference) link.reference.assetId = remap(link.reference.assetId);
  for (const scene of project.scenes) {
    scene.videoAssetId = remap(scene.videoAssetId); scene.imageAssetId = remap(scene.imageAssetId);
    scene.referenceAssetId = '';
    for (const reference of scene.references) reference.assetId = remap(reference.assetId);
  }
}

function skillControls(project) {
  return [
    ...project.graph.nodes.flatMap(node => [node.aiConfig, node.imageConfig].filter(Boolean)),
    ...project.scenes.flatMap(scene => [
      { get skillId() { return scene.videoSkillId; }, set skillId(id) { scene.videoSkillId = id; } },
      { get skillId() { return scene.imageSkillId; }, set skillId(id) { scene.imageSkillId = id; } },
    ]),
  ];
}
export function selectedProjectSkills(project, library) {
  return [...new Set(skillControls(project).map(control => control.skillId).filter(Boolean))].map(id => library.get(id));
}

// Only project fields and active project media enter the package; runtime records stay local.
export function createPackageManifest(project, { skills = [], aiImages = new Map() } = {}) {
  const assets = (project.assets || []).filter(asset => !asset.deletedAt);
  if (assets.length > PACKAGE_ASSET_MAX_COUNT) throw new InputError('工程分享最多支持 1000 个素材。', 413);
  const copy = {
    title: text(project.title, 120), brief: normalizeBrief(project.brief),
    graph: validateGraph(project.graph), scenes: normalizeScenes(project.scenes),
    assets, planSource: project.planSource === 'local-draft' ? 'local-draft' : null,
  };
  const before = new Map(copy.scenes.map(scene => [scene.id, scene.references]));
  syncProjectReferences(copy);
  for (const scene of copy.scenes) {
    const result = remapPromptMentions(scene.videoPrompt, scene.promptMentions, before.get(scene.id), scene.references);
    scene.videoPrompt = result.prompt; scene.promptMentions = result.mentions;
  }
  portableScenes(copy.scenes);
  const ids = new Map(assets.map((asset, index) => [asset.id, `asset-${index + 1}`]));
  if (ids.size !== assets.length) throw new InputError('工程包含重复的素材编号。');
  const batches = new Map();
  copy.assets = assets.map(asset => {
    const media = PACKAGE_MEDIA[asset.mime];
    if (!media || asset.kind !== media.kind) throw new InputError(`素材“${text(asset.name)}”的格式不支持工程分享。`);
    const id = ids.get(asset.id), record = { ...metadata(asset), id, path: `media/${id}${media.extension}`, size: asset.size };
    if (asset.batchId) {
      if (!batches.has(asset.batchId)) batches.set(asset.batchId, `batch-${batches.size + 1}`);
      record.batchId = batches.get(asset.batchId);
    }
    return record;
  });
  remapAssets(copy, ids);
  const skillIds = new Map(skills.map((skill, index) => [skill.id, `skill-${index + 1}`]));
  const portableSkills = skills.map(skill => ({ ...validateSkill(skill), id: skillIds.get(skill.id), source: '工程分享包' }));
  for (const control of skillControls(copy)) if (control.skillId) {
    if (!skillIds.has(control.skillId)) throw new InputError('工程使用的技能不可用，请先恢复技能后再导出。', 409);
    control.skillId = skillIds.get(control.skillId);
  }
  const previews = [];
  for (const node of copy.graph.nodes) if (node.aiConfig) {
    const references = aiImages.get(node.id) || [];
    if (node.aiConfig.images.length && references.length !== node.aiConfig.images.length) throw new InputError('AI 创作卡的回复图片尚未保存，请稍后重试工程导出。', 409);
    if (references.length) previews.push({ nodeId: node.id, assets: references.map(id => ids.get(id)) });
    node.aiConfig.images = []; node.aiConfig.error = '';
    node.aiConfig.status = node.aiConfig.output ? 'done' : 'idle';
  }
  return { format: PACKAGE_FORMAT, schemaVersion: 1, exportedAt: new Date().toISOString(), project: copy,
    ...(portableSkills.length ? { skills: portableSkills } : {}), ...(previews.length ? { aiImages: previews } : {}) };
}

export function validatePackageManifest(input) {
  if (input?.format !== PACKAGE_FORMAT || input.schemaVersion !== 1 || !input.project
      || !Array.isArray(input.project.assets) || input.project.assets.length > PACKAGE_ASSET_MAX_COUNT) {
    throw new InputError('请选择幻帧导出的工程 ZIP 分享包。');
  }
  const ids = new Set(), paths = new Set(); let total = 0;
  for (const asset of input.project.assets) {
    const media = PACKAGE_MEDIA[asset?.mime];
    if (!asset || !identity(asset.id) || ids.has(asset.id) || !media || media.kind !== asset.kind
        || asset.path !== `media/${asset.id}${media.extension}` || paths.has(asset.path)) {
      throw new InputError('分享包中的素材编号、类型或文件路径不正确。');
    }
    if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > media.limit) throw new InputError('分享包素材超过上限：图片 20 MB、音频 100 MB、视频 300 MB。', 413);
    total += asset.size;
    ids.add(asset.id); paths.add(asset.path);
  }
  if (total > PACKAGE_MAX_BYTES) throw new InputError('工程分享包最大支持 1 GB。', 413);
  if (!Array.isArray(input.project.scenes)) throw new InputError('分享包中的视频生成清单格式不正确。');
  if (input.skills !== undefined && (!Array.isArray(input.skills) || input.skills.length > 100)) throw new InputError('分享包中的技能清单格式不正确。');
  if (input.aiImages !== undefined && (!Array.isArray(input.aiImages) || input.aiImages.length > 60)) throw new InputError('分享包中的 AI 图片清单格式不正确。');
  return input;
}

export function restorePackageProject(input) {
  validatePackageManifest(input);
  const originalAssets = input.project.assets, ids = new Map(originalAssets.map(asset => [asset.id, randomUUID()]));
  const batches = new Map();
  const project = createProject({ title: input.project.title, brief: input.project.brief });
  project.assets = originalAssets.map(asset => {
    const media = PACKAGE_MEDIA[asset.mime], id = ids.get(asset.id);
    const record = { ...metadata(asset), id, file: `${id}${media.extension}`, size: asset.size, createdAt: metadata(asset).createdAt || project.createdAt };
    if (asset.batchId) {
      if (!batches.has(asset.batchId)) batches.set(asset.batchId, randomUUID());
      record.batchId = batches.get(asset.batchId);
    }
    return record;
  });
  const normalized = { graph: validateGraph(input.project.graph), scenes: normalizeScenes(input.project.scenes) };
  portableScenes(normalized.scenes);
  for (const node of normalized.graph.nodes) if (node.aiConfig) {
    node.aiConfig.images = []; node.aiConfig.error = ''; node.aiConfig.status = node.aiConfig.output ? 'done' : 'idle';
  }
  remapAssets(normalized, ids, true);
  const skillIds = new Map(), importedSkills = (input.skills || []).map(skill => {
    if (!identity(skill?.id) || skillIds.has(skill.id)) throw new InputError('分享包中的技能编号为空或重复。');
    const id = randomUUID(); skillIds.set(skill.id, id);
    return { ...validateSkill(skill), id, source: '工程分享包', createdAt: project.createdAt, updatedAt: project.createdAt, deletedAt: null };
  });
  for (const control of skillControls(normalized)) if (control.skillId) {
    if (!skillIds.has(control.skillId)) throw new InputError('工程使用的技能未包含在分享包中。');
    control.skillId = skillIds.get(control.skillId);
  }
  const previews = [], previewNodes = new Set();
  for (const preview of input.aiImages || []) {
    const node = normalized.graph.nodes.find(node => node.id === preview?.nodeId && node.kind === 'ai');
    if (!node || previewNodes.has(node.id) || !Array.isArray(preview.assets) || preview.assets.length > 100) throw new InputError('分享包中的 AI 图片关联不正确。');
    previewNodes.add(node.id);
    const requestId = randomUUID(), images = preview.assets.map((originalId, index) => {
      const asset = project.assets.find(asset => asset.id === ids.get(originalId) && asset.kind === 'image');
      if (!asset) throw new InputError('分享包中的 AI 图片素材缺失或类型不匹配。');
      asset.chatImageId ||= `${requestId}-${index}`;
      return { assetId: asset.id, source: '', name: asset.name };
    });
    node.aiConfig.images = images.map((image, index) => ({ requestId, index, name: image.name, previewUrl: `/api/text-images/${requestId}/${index}` }));
    previews.push({ requestId, projectId: project.id, images });
  }
  const result = updateProject(project, { revision: project.revision, ...normalized });
  for (const scene of result.scenes) {
    if (scene.imageAssetId && !result.assets.some(asset => asset.id === scene.imageAssetId && asset.kind === 'image')) throw new InputError('分享包的视频生成项关联了类型不匹配的图片。');
  }
  result.planSource = input.project.planSource === 'local-draft' ? 'local-draft' : null;
  result.revision = 1;
  return { project: result, skills: importedSkills, previews, assetFiles: originalAssets.map((asset, index) => ({ path: asset.path, asset: result.assets[index] })) };
}
