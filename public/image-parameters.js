// Shared by the browser and server. The visible controls use stable, provider-neutral
// values; the server maps them to each model's request protocol before submission.
export const IMAGE_RATIOS = [
  ['auto', '模型默认'], ['1:1', '1:1 方形'], ['16:9', '16:9 横屏'], ['9:16', '9:16 竖屏'],
  ['4:3', '4:3 横向'], ['3:4', '3:4 竖向'], ['3:2', '3:2 横向'], ['2:3', '2:3 竖向'],
];
export const IMAGE_QUALITIES = [['auto', '模型默认'], ['1k', '1K 清晰'], ['2k', '2K 高清'], ['4k', '4K 超清']];
export const IMAGE_STYLES = [
  ['auto', '遵循提示词'], ['photo', '真实摄影'], ['cinematic', '电影感'], ['anime', '动漫'],
  ['illustration', '插画'], ['product', '产品广告'], ['watercolor', '水彩'], ['oil', '油画'], ['3d', '3D 渲染'],
];
export const IMAGE_CONTROL_NOTE = '比例、画质、风格会按所选模型的协议发送；实际尺寸和效果由模型决定。';
export const IMAGE_REFERENCE_NOTE = '支持用已上传或已生成图片作参考；上限按模型能力执行（最多 16 张），每张不超过 20 MiB。';
export const IMAGE_GENERATION_COUNT_MAX = 5;
// This is the storage and upload safety ceiling. Individual model limits are
// returned by imageModelReferenceLimit().
export const IMAGE_REFERENCE_MAX = 16;
export const IMAGE_REFERENCE_FILE_LIMIT = 20 * 1024 * 1024;
export const IMAGE_REFERENCE_TOTAL_LIMIT = 64 * 1024 * 1024;

const IMAGE_QUALITY_LABELS = new Map(IMAGE_QUALITIES.filter(([id]) => id !== 'auto').map(([id, label]) => [id, label.split(' ')[0]]));

const finitePrice = value => {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
};

function imageTierPrices(tier) {
  const values = Array.isArray(tier?.prices) ? tier.prices : [tier?.price];
  return [...new Set(values.map(finitePrice).filter(value => value != null))].sort((a, b) => a - b);
}

/** Return published per-image price tiers from the live image model catalog. */
export function imagePriceTiers(model) {
  const intervals = Array.isArray(model?.intervals) ? model.intervals : [];
  return intervals.map(interval => ({ label: String(interval?.label || interval?.tier_label || '').trim(), prices: imageTierPrices(interval) }))
    .filter(interval => interval.label || interval.prices.length);
}

/**
 * Calculate an image quote without guessing when the provider did not publish
 * a price for the selected model/quality. A range means the public catalog
 * contains the same model in more than one account group.
 */
export function imageEstimate(model, config = {}) {
  const count = Number.isInteger(Number(config?.count)) && Number(config.count) > 0 ? Number(config.count) : 1;
  const quality = String(config?.quality || 'auto').toLowerCase();
  const tiers = imagePriceTiers(model);
  const requestedLabel = IMAGE_QUALITY_LABELS.get(quality);
  const selected = requestedLabel
    ? tiers.filter(tier => tier.label.toLowerCase() === requestedLabel.toLowerCase())
    : tiers;
  const prices = [...new Set(selected.flatMap(tier => tier.prices))].sort((a, b) => a - b);
  if (!prices.length) return { count, quality, tiers: selected, perImageMin: null, perImageMax: null, totalMin: null, totalMax: null, exact: false, unit: model?.priceUnit || '平台余额单位' };
  const perImageMin = prices[0], perImageMax = prices.at(-1);
  return { count, quality, tiers: selected, perImageMin, perImageMax,
    totalMin: Number((perImageMin * count).toFixed(6)), totalMax: Number((perImageMax * count).toFixed(6)),
    exact: perImageMin === perImageMax, unit: model?.priceUnit || '平台余额单位' };
}

export function formatImageAmount(value) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(6)).toString() : '';
}

export function imageEstimateText(estimate, { prefix = '预计合计' } = {}) {
  if (!estimate || estimate.totalMin == null) return '暂无有效报价';
  const amount = estimate.exact ? formatImageAmount(estimate.totalMin) : `${formatImageAmount(estimate.totalMin)}–${formatImageAmount(estimate.totalMax)}`;
  const perImage = estimate.exact ? formatImageAmount(estimate.perImageMin) : `${formatImageAmount(estimate.perImageMin)}–${formatImageAmount(estimate.perImageMax)}`;
  return `${prefix} ¥${amount} · 每张 ¥${perImage} · ${estimate.count} 张`;
}

const MODEL_CAPABILITIES = [
  ...[
    'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst',
    'gpt-image-2.5-flare-2026-09-08', 'gpt-image-2.5-sunburst-2026-09-08',
    'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini',
  ].map(name => ({ name, protocol: 'gpt', supportsReferences: true, referenceMax: 16, imageSize: true })),
  { name: 'grok-imagine-image', protocol: 'grok', supportsReferences: true, referenceMax: 3, imageSize: false },
  { name: 'grok-imagine-image-2.0', protocol: 'grok', supportsReferences: true, referenceMax: 3, imageSize: false },
  { name: 'gemini-nano-banana-2.1', protocol: 'gemini', supportsReferences: true, referenceMax: 14, imageSize: true },
  { name: 'gemini-3.1-flash-image', protocol: 'gemini', supportsReferences: true, referenceMax: 14, imageSize: true },
  { name: 'gemini-3.1-flash-image-preview', protocol: 'gemini', supportsReferences: true, referenceMax: 14, imageSize: true },
  { name: 'gemini-3-pro-image', protocol: 'gemini', supportsReferences: true, referenceMax: 14, imageSize: true },
  { name: 'gemini-3-pro-image-preview', protocol: 'gemini', supportsReferences: true, referenceMax: 14, imageSize: true },
  { name: 'gemini-3.1-flash-lite-image-preview', protocol: 'gemini', supportsReferences: true, referenceMax: 14, imageSize: false },
  { name: 'gemini-2.5-flash-image', protocol: 'gemini', supportsReferences: true, referenceMax: 3, imageSize: false },
];
const MODEL_CAPABILITY_MAP = new Map(MODEL_CAPABILITIES.map(capability => [capability.name, capability]));
export const IMAGE_REFERENCE_MODELS = MODEL_CAPABILITIES.filter(item => item.supportsReferences).map(item => item.name);

/** Return the verified wire protocol and limits for a model ID.
 *
 * Exact IDs from the provider catalog are preferred. Prefix handling keeps
 * date-suffixed GPT/Gemini IDs useful without treating an unrelated model as
 * a text-only GPT request.
 */
export function imageModelCapabilities(model) {
  const id = String(model || '').trim();
  if (!id) return null;
  const exact = MODEL_CAPABILITY_MAP.get(id);
  if (exact) return { ...exact };
  if (/^gpt-image-/.test(id)) return { name: id, protocol: 'gpt', supportsReferences: true, referenceMax: 16, imageSize: true };
  if (/^grok-imagine-image(?:-2\.0)?$/.test(id)) {
    return { name: id, protocol: 'grok', supportsReferences: true, referenceMax: 3, imageSize: false };
  }
  if (/^gemini-2\.5-flash-image$/.test(id)) {
    return { name: id, protocol: 'gemini', supportsReferences: true, referenceMax: 3, imageSize: false };
  }
  if (/^gemini-/.test(id)) {
    return { name: id, protocol: 'gemini', supportsReferences: true, referenceMax: 14, imageSize: true };
  }
  return null;
}
export const imageModelProtocol = model => imageModelCapabilities(model)?.protocol || '';
export const imageModelReferenceLimit = model => imageModelCapabilities(model)?.referenceMax || 0;
export const imageModelSupportsReferences = model => Boolean(imageModelCapabilities(model)?.supportsReferences);

export const IMAGE_ACTIVE_STATES = new Set(['waiting', 'preparing', 'submitting', 'saving', 'download_pending', 'uncertain']);
export const isImageGenerationNode = node => node?.kind === 'image' && node?.role === 'image-generation';
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function normalizeImageCount(value = 1) {
  const count = value == null || value === '' ? 1 : Number(value);
  if (!Number.isInteger(count) || count < 1 || count > IMAGE_GENERATION_COUNT_MAX || value != null && !['number','string'].includes(typeof value)) {
    throw new Error('图片生成张数应为 1–' + IMAGE_GENERATION_COUNT_MAX + ' 张。');
  }
  return count;
}

export function normalizeImageConfig(value = {}, fallbackModel = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('生图设置格式不正确。');
  const option = (field, options) => {
    const selected = value[field] || 'auto';
    if (!options.some(([id]) => id === selected)) throw new Error('生图' + ({ratio:'比例',quality:'画质',style:'风格'}[field]) + '选项不正确。');
    return selected;
  };
  if (typeof value.prompt === 'string' && value.prompt.trim().length > 4000) throw new Error('图片提示词最多 4000 个字符。');
  return { model: clean(value.model || fallbackModel, 120), prompt: clean(value.prompt, 4000),
    ratio: option('ratio', IMAGE_RATIOS), quality: option('quality', IMAGE_QUALITIES), style: option('style', IMAGE_STYLES), count: normalizeImageCount(value.count) };
}

export function resolveImageInputs(project, node) {
  const nodes = new Map((project?.graph?.nodes || []).map(item => [item.id, item]));
  const assets = new Map((project?.assets || []).map(asset => [asset.id, asset]));
  const references = [], textInputs = [], seen = new Set();
  for (const link of project?.graph?.links || []) {
    if (link.to !== node?.id) continue;
    const source = nodes.get(link.from);
    if (!source) continue;
    if (source.kind === 'image') {
      const output = isImageGenerationNode(source) ? link.reference : {assetId:source.assetId, name:source.assetName, kind:'image'};
      // Even an empty image input must prevent a silent text-only submission.
      const assetId = clean(output?.assetId,100), key = assetId || source.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const asset = assets.get(assetId);
      references.push({nodeId:source.id, assetId:asset?.deletedAt ? '' : assetId, kind:'image',
        name:clean(asset?.name || output?.name || source.label,200), note:''});
    } else if (source.kind === 'video' || source.kind === 'audio') {
      references.push({nodeId:source.id, assetId:source.assetId || '', kind:source.kind, name:clean(source.label,200), note:''});
    } else if (source.kind === 'text' && source.note?.trim()) {
      textInputs.push({nodeId:source.id, name:clean(source.label,80), text:clean(source.note,2000)});
    }
  }
  return {references, textInputs};
}

export function buildImagePrompt(config, textInputs = []) {
  const c = normalizeImageConfig(config), parts = [c.prompt];
  for (const input of textInputs) if (input.text?.trim()) parts.push('文字参考（' + input.name + '）：' + input.text.trim());
  if (!parts.some(part => part?.trim())) throw new Error('请输入图片提示词，或连接有内容的文字便签。');
  if (c.ratio !== 'auto') parts.push('画面比例要求：' + c.ratio + '。');
  if (c.quality !== 'auto') parts.push('画质要求：' + IMAGE_QUALITIES.find(([id]) => id === c.quality)[1] + '，画面细节清晰。');
  if (c.style !== 'auto') parts.push('画面风格要求：' + IMAGE_STYLES.find(([id]) => id === c.style)[1] + '。');
  const prompt = parts.filter(Boolean).join('\n\n');
  if (prompt.length > 4000) throw new Error('合并文字参考和生图设置后，提示词超过 4000 个字符，请缩短内容。');
  return prompt;
}

export function imageRequestIssue(config, inputs = {}) {
  const references = inputs.references || [];
  if (!Array.isArray(references)) return '图片参考格式不正确。';
  const model = String(config?.model || '').trim();
  if (!model) return '请选择生图模型。';
  if (references.length > IMAGE_REFERENCE_MAX) return '每次最多使用 ' + IMAGE_REFERENCE_MAX + ' 张参考图片。';
  if (references.some(reference => !reference || reference.kind && reference.kind !== 'image')) return '图片生成仅支持图片参考，请移除视频或音频连线。';
  if (references.length) {
    const limit = imageModelReferenceLimit(model);
    if (!limit) return '当前模型的图片参考接口尚未核实，请选择已适配的 GPT、Grok 或 Gemini 图片模型；参考不会被忽略。';
    if (references.length > limit) return `当前模型最多支持 ${limit} 张参考图片，请减少参考素材。`;
  }
  if (references.some(reference => typeof reference.assetId !== 'string' || !reference.assetId.trim())) return '有参考图片尚未选定有效素材，请补选后再生成。';
  if (/@视频\d+/.test(config.prompt || '')) return '图片生成不能使用视频引用，请改为图片参考。';
  const mentioned = [...String(config.prompt || '').matchAll(/@图片(\d+)/g)].map(match => Number(match[1]));
  if (mentioned.some(index => index < 1 || index > references.length)) return '提示词中的图片引用没有对应参考素材，请补选图片后再生成。';
  try { buildImagePrompt(config, inputs.textInputs); return ''; } catch (error) { return error.message; }
}

// Task associations and saved media always follow the latest actual task. Used
// when an undo restores a card and when a stale client saves its graph.
export function syncImageCardJobs(project, jobs = []) {
  const assets = new Map((project.assets || []).filter(asset => !asset.deletedAt).map(asset => [asset.id,asset]));
  const relevant = jobs.filter(job => job.projectId === project.id && job.nodeId).sort((a,b) => a.createdAt.localeCompare(b.createdAt));
  for (const node of project.graph?.nodes || []) {
    if (!isImageGenerationNode(node)) continue;
    const history = relevant.filter(job => job.nodeId === node.id), latest = history.at(-1);
    node.imageJobId = latest?.id || '';
    if (!latest) continue;
    const output = history.findLast(job => job.state === 'done' && assets.get(job.assetId)?.kind === 'image');
    // A completed batch supplies a default preview, but an explicit user choice
    // must remain the card's output when a later candidate finishes.
    let selected = node.selectedAssetId ? assets.get(node.selectedAssetId) : null;
    if (selected?.kind !== 'image' || selected.nodeId !== node.id) selected = null;
    const chosen = selected || (output ? assets.get(output.assetId) : null);
    if (chosen?.kind === 'image') {
      node.assetId = chosen.id;
      node.assetName = chosen.name;
    } else if (node.assetId && !assets.has(node.assetId)) {
      node.assetId = ''; node.assetName = '';
    }
    if (!selected && node.selectedAssetId) node.selectedAssetId = '';
    const batch = latest.batchId ? history.filter(job => job.batchId === latest.batchId) : [latest];
    node.imageJobIds = batch.map(job => job.id);
    node.status = batch.some(job => IMAGE_ACTIVE_STATES.has(job.state)) ? 'pending'
      : batch.some(job => job.state === 'done' && assets.get(job.assetId)?.kind === 'image') ? 'done'
      : batch.every(job => job.state === 'failed') ? 'failed' : 'pending';
  }
  return project;
}
