import { InputError } from './workflow.mjs';
import { detectMedia } from './media.mjs';
import { imageModelCapabilities, imageModelProtocol, imageModelReferenceLimit, IMAGE_REFERENCE_MAX, IMAGE_REFERENCE_FILE_LIMIT, IMAGE_REFERENCE_TOTAL_LIMIT } from '../public/image-parameters.js';

export const IMAGE_PLATFORM = 'https://sub.beibeihai.xyz';
export const IMAGE_DOCS_URL = 'https://sub.beibeihai.xyz/pricing';
export const DEFAULT_IMAGE_CONNECTION = {
  platform: 'beibeihai 图片 API',
  baseUrl: IMAGE_PLATFORM,
  docsUrl: IMAGE_DOCS_URL,
  imageModel: 'gpt-image-2.5-flare',
  apiKey: '',
};

export const FALLBACK_IMAGE_CATALOG = [
  { name: 'gpt-image-2.5-flare', platform: 'openai', description: 'OpenAI 图片模型（支持多图参考）', billingMode: 'image', priceUnit: '以平台账户分组账单为准' },
  { name: 'gpt-image-2.5-sunburst', platform: 'openai', description: 'OpenAI 图片模型（支持多图参考）', billingMode: 'image', priceUnit: '以平台账户分组账单为准' },
  { name: 'image-2', platform: 'openai', description: 'OpenAI 图片模型', billingMode: 'image', priceUnit: '以平台账户分组账单为准' },
  { name: 'grok-imagine-image', platform: 'grok', description: 'Grok 图片模型（最多 3 张参考）', billingMode: 'image', priceUnit: '以平台账户分组账单为准' },
  { name: 'grok-imagine-image-2.0', platform: 'grok', description: 'Grok 图片模型 2.0（最多 3 张参考）', billingMode: 'image', priceUnit: '以平台账户分组账单为准' },
  { name: 'gemini-nano-banana-2.1', platform: 'google', description: 'Gemini Nano Banana 2.1（支持多图参考）', billingMode: 'image', priceUnit: '以平台账户分组账单为准' },
  { name: 'gemini-3.1-flash-image-preview', platform: 'google', description: 'Gemini Flash Image Preview（支持多图参考）', billingMode: 'image', priceUnit: '以平台账户分组账单为准' },
  { name: 'gemini-3-pro-image', platform: 'google', description: 'Gemini Pro Image（支持多图参考）', billingMode: 'image', priceUnit: '以平台账户分组账单为准' },
];

function normalizedBaseUrl(value) {
  const base = String(value || IMAGE_PLATFORM).trim().replace(/\/+$/, '');
  if (base !== IMAGE_PLATFORM) throw new InputError('当前生图适配器仅支持已核对的 sub.beibeihai.xyz 平台。');
  return base;
}

async function jsonResponse(response, key = '') {
  const body = await response.text();
  if (body.length > 30 * 1024 * 1024) throw new InputError('生图平台返回的数据超过允许大小。', 502);
  let data;
  try { data = JSON.parse(body); } catch { throw new InputError('生图平台未返回 JSON，请检查平台服务状态。', 502); }
  if (!response.ok) {
    let message = String(data?.error?.message || data?.message || `HTTP ${response.status}`).slice(0, 400);
    if (key) message = message.split(key).join('[已隐藏密钥]');
    const error = new InputError(`生图平台请求失败：${message}`, response.status === 401 ? 401 : 502);
    const code = String(data?.error?.code || data?.code || '').trim();
    if (code) error.code = code;
    throw error;
  }
  return data;
}

function credentials(settings, protocol = '') {
  const baseUrl = normalizedBaseUrl(settings.baseUrl);
  if (!settings.apiKey) throw new InputError('请先在“生图连接”中保存平台 API Key。');
  if (/[\r\n]/.test(settings.apiKey)) throw new InputError('生图 API Key 中不能包含换行。');
  const headers = protocol === 'gemini'
    ? { 'x-goog-api-key': settings.apiKey, 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' };
  return { baseUrl, headers };
}

function modelRecord(model, group = {}) {
  const pricing = model?.pricing || {};
  const intervals = Array.isArray(pricing.intervals) ? pricing.intervals : [];
  const normalizedIntervals = intervals.map(item => {
    const label = String(item?.label || item?.tier_label || item?.name || item?.size || '').trim();
    const value = item?.price ?? item?.per_request_price;
    const price = (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' && Number(value) >= 0 ? Number(value) : NaN;
    return { label, price };
  }).filter(item => item.label || Number.isFinite(item.price));
  const prices = normalizedIntervals.map(item => item.price).filter(Number.isFinite);
  return {
    name: String(model?.name || '').trim(), platform: String(model?.platform || ''),
    description: String(model?.description || ''), billingMode: String(pricing.billing_mode || ''),
    // The public image catalog describes these values as the RMB price per
    // generated image. Keep the source group so
    // callers can show a range when the same model is listed for several
    // account groups with different rates.
    priceUnit: '人民币￥/张', prices: prices.length ? prices : undefined,
    group: String(group?.name || '').trim(),
    rateMultiplier: Number.isFinite(Number(group?.rate_multiplier)) ? Number(group.rate_multiplier) : undefined,
    imageRateIndependent: group?.image_rate_independent === true,
    imageRateMultiplier: Number.isFinite(Number(group?.image_rate_multiplier)) ? Number(group.image_rate_multiplier) : undefined,
    intervals: normalizedIntervals,
  };
}

function mergeImageCatalog(records) {
  const merged = new Map();
  for (const record of records) {
    if (!record?.name) continue;
    let target = merged.get(record.name);
    if (!target) {
      target = { ...record, groups: [], intervals: [] };
      merged.set(record.name, target);
    }
    if (record.group && !target.groups.some(group => group.name === record.group)) {
      target.groups.push({ name: record.group, intervals: record.intervals, rateMultiplier: record.rateMultiplier,
        imageRateIndependent: record.imageRateIndependent, imageRateMultiplier: record.imageRateMultiplier });
    }
    for (const interval of record.intervals || []) {
      const key = interval.label || `__price:${interval.price}`;
      let targetInterval = target.intervals.find(item => (item.label || `__price:${item.price}`) === key);
      if (!targetInterval) {
        targetInterval = { label: interval.label, prices: [] };
        target.intervals.push(targetInterval);
      }
      if (Number.isFinite(interval.price) && !targetInterval.prices.includes(interval.price)) targetInterval.prices.push(interval.price);
    }
  }
  return [...merged.values()].map(model => {
    const intervals = model.intervals.map(interval => {
      const prices = interval.prices.sort((a, b) => a - b);
      return { label: interval.label, price: prices.length === 1 ? prices[0] : undefined, prices };
    });
    const prices = intervals.flatMap(interval => interval.prices).filter(Number.isFinite);
    return { ...model, intervals, prices: prices.length ? [...new Set(prices)].sort((a, b) => a - b) : undefined };
  });
}

export async function loadImageCatalog(fetcher = fetch) {
  const response = await fetcher(`${IMAGE_PLATFORM}/api/v1/model-plaza`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  const data = await jsonResponse(response);
  const groups = Array.isArray(data?.data?.groups) ? data.data.groups : [];
  const models = groups.flatMap(group => Array.isArray(group.models) ? group.models.map(model => modelRecord({ ...model,
    platform: model.platform || group.platform, description: model.description || group.description }, group)) : [])
    .filter(model => model.name && (model.billingMode === 'image' || /image|生图|图片|grok|gemini/i.test(model.name + model.description)));
  if (!models.length) throw new InputError('生图平台没有返回可用的图片模型目录。', 502);
  return mergeImageCatalog(models);
}

export function imageCatalogOrFallback(catalog) {
  return Array.isArray(catalog) && catalog.length ? catalog : FALLBACK_IMAGE_CATALOG;
}

function base64Result(value, mime = '') {
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(value.trim());
  const data = (match ? match[2] : value).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(data)) throw new InputError('生图平台返回的 Base64 图片格式不正确。', 502);
  return { kind: 'base64', data, mime: String(match?.[1] || mime || '').toLowerCase() };
}

export function normalizeImageResponse(raw, key = '') {
  const data = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const result = base64Result(item.b64_json || item.base64 || item.image_base64 || item.data, item.mime_type || item.mimeType);
    if (result) return result;
    const value = item.url || item.image_url || item.imageUrl;
    if (typeof value === 'string' && value.trim()) {
      const url = value.trim();
      if (key && [key, encodeURIComponent(key)].some(secret => url.includes(secret))) throw new InputError('生图结果地址包含 API Key，已拒绝保存。', 502);
      return { kind: 'url', url };
    }
  }
  // Gemini may put text before the image and may return several candidates.
  for (const candidate of Array.isArray(raw?.candidates) ? raw.candidates : []) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      const inline = part?.inlineData || part?.inline_data;
      const result = base64Result(inline?.data, inline?.mimeType || inline?.mime_type);
      if (result) return result;
      const value = part?.url || part?.image_url || part?.imageUrl;
      if (typeof value === 'string' && value.trim()) {
        const url = value.trim();
        if (key && [key, encodeURIComponent(key)].some(secret => url.includes(secret))) throw new InputError('生图结果地址包含 API Key，已拒绝保存。', 502);
        return { kind: 'url', url };
      }
    }
  }
  throw new InputError('生图平台返回中没有可保存的图片数据。', 502);
}

export class UncertainImageSubmission extends Error {
  constructor(message = '生图平台提交结果无法确认，请先核对平台记录，避免重复收费。') { super(message); this.code = 'IMAGE_SUBMISSION_UNCERTAIN'; }
}

const GPT_SIZE_BY_RATIO = { '1:1': '2048x2048', '16:9': '2048x1152', '9:16': '1152x2048' };
const GROK_RATIOS = new Set(['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20']);
const qualityValue = value => ({ auto: '', '1k': 'low', '2k': 'medium', '4k': 'high' }[value] || '');
const resolutionValue = value => value === '1k' || value === '2k' ? value : '';

function protocolOptions(model, config = {}) {
  const cap = imageModelCapabilities(model), protocol = cap?.protocol || imageModelProtocol(model);
  const options = { protocol, ratio: config?.ratio || 'auto', quality: config?.quality || 'auto' };
  if (protocol === 'gpt') {
    if (options.quality !== 'auto') options.qualityValue = qualityValue(options.quality);
    if (GPT_SIZE_BY_RATIO[options.ratio]) options.size = GPT_SIZE_BY_RATIO[options.ratio];
  } else if (protocol === 'grok') {
    if (GROK_RATIOS.has(options.ratio) && options.ratio !== 'auto') options.aspectRatio = options.ratio;
    options.resolution = resolutionValue(options.quality);
    if (model === 'grok-imagine-image-2.0') options.grokQuality = options.quality === '1k' ? 'low' : 'medium';
  } else if (protocol === 'gemini') {
    if (options.ratio !== 'auto') options.aspectRatio = options.ratio;
    if (cap?.imageSize && options.quality !== 'auto') options.imageSize = options.quality.toUpperCase();
  }
  return options;
}

export async function submitImage(settings, { model, prompt, n = 1, references = [], config = null }, fetcher = fetch) {
  model = String(model || '').trim().replace(/^models\//, '');
  if (!model || typeof prompt !== 'string' || !prompt.trim()) throw new InputError('生图模型和提示词不能为空。');
  if (!Array.isArray(references)) throw new InputError('图片参考格式不正确。');
  const capability = imageModelCapabilities(model);
  const protocol = capability?.protocol || (references.length ? '' : 'gpt');
  if (!protocol) throw new InputError('所选模型的生图协议尚未核实；不会忽略参考图后提交。');
  const { baseUrl, headers } = credentials(settings, protocol);
  const referenceLimit = imageModelReferenceLimit(model);
  if (!Array.isArray(references) || references.length > IMAGE_REFERENCE_MAX || references.length > referenceLimit && references.length) {
    const limit = referenceLimit || IMAGE_REFERENCE_MAX;
    throw new InputError(`图片参考数量不正确；当前模型最多支持 ${limit} 张参考图片。`);
  }
  const options = protocolOptions(model, config || {});
  const count = Number.isInteger(n) && n > 0 ? Math.min(n, 4) : 1;
  let endpoint;
  let body;
  if (protocol === 'gemini') {
    endpoint = `/v1beta/models/${encodeURIComponent(String(model).replace(/^models\//, ''))}:generateContent`;
    const parts = [{ text: prompt.trim() }];
    let total = 0;
    for (const reference of references) {
      const bytes = reference?.data;
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > IMAGE_REFERENCE_FILE_LIMIT) throw new InputError('参考图片文件缺失，或超过单张 20 MiB 限制。');
      total += bytes.byteLength;
      if (total > IMAGE_REFERENCE_TOTAL_LIMIT) throw new InputError('参考图片总大小超过 64 MiB，请减少图片。');
      const media = detectMedia(Buffer.from(bytes).subarray(0, 32));
      if (media.kind !== 'image') throw new InputError('图片生成只能上传 PNG、JPEG 或 WebP 参考文件。');
      parts.push({ inlineData: { mimeType: media.mime, data: Buffer.from(bytes).toString('base64') } });
    }
    const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
    if (options.aspectRatio || options.imageSize) {
      generationConfig.imageConfig = {};
      if (options.aspectRatio) generationConfig.imageConfig.aspectRatio = options.aspectRatio;
      if (options.imageSize) generationConfig.imageConfig.imageSize = options.imageSize;
    }
    body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig });
  } else if (protocol === 'grok' && references.length) {
    endpoint = '/v1/images/edits';
    const images = [];
    let total = 0;
    for (const reference of references) {
      const bytes = reference?.data;
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > IMAGE_REFERENCE_FILE_LIMIT) throw new InputError('参考图片文件缺失，或超过单张 20 MiB 限制。');
      total += bytes.byteLength;
      if (total > IMAGE_REFERENCE_TOTAL_LIMIT) throw new InputError('参考图片总大小超过 64 MiB，请减少图片。');
      const media = detectMedia(Buffer.from(bytes).subarray(0, 32));
      if (media.kind !== 'image') throw new InputError('图片生成只能上传 PNG、JPEG 或 WebP 参考文件。');
      images.push({ url: `data:${media.mime};base64,${Buffer.from(bytes).toString('base64')}` });
    }
    const payload = { model, prompt: prompt.trim(), n: 1, response_format: 'b64_json' };
    if (options.aspectRatio) payload.aspect_ratio = options.aspectRatio;
    if (options.resolution) payload.resolution = options.resolution;
    if (options.grokQuality) payload.quality = options.grokQuality;
    if (images.length === 1) payload.image = images[0];
    else payload.images = images;
    body = JSON.stringify(payload);
    endpoint = '/v1/images/edits';
  } else {
    endpoint = '/v1/images/generations';
    const payload = { model, prompt: prompt.trim(), n: count };
    if (options.qualityValue) payload.quality = options.qualityValue;
    if (options.size) payload.size = options.size;
    if (protocol === 'grok') {
      payload.response_format = 'b64_json';
      if (options.aspectRatio) payload.aspect_ratio = options.aspectRatio;
      if (options.resolution) payload.resolution = options.resolution;
      if (options.grokQuality) payload.quality = options.grokQuality;
    }
    body = JSON.stringify(payload);
  }
  if (protocol === 'gpt' && references.length) {
    endpoint = '/v1/images/edits';
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt.trim());
    form.append('n', '1');
    if (options.qualityValue) form.append('quality', options.qualityValue);
    if (options.size) form.append('size', options.size);
    let total = 0;
    for (const [index, reference] of references.entries()) {
      const bytes = reference?.data;
      if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > IMAGE_REFERENCE_FILE_LIMIT) throw new InputError('参考图片文件缺失，或超过单张 20 MiB 限制。');
      total += bytes.byteLength;
      if (total > IMAGE_REFERENCE_TOTAL_LIMIT) throw new InputError('参考图片总大小超过 64 MiB，请减少图片。');
      const media = detectMedia(Buffer.from(bytes).subarray(0, 32));
      if (media.kind !== 'image') throw new InputError('图片生成只能上传 PNG、JPEG 或 WebP 参考文件。');
      const name = String(reference.name || 'reference-' + (index + 1)).replace(/[\\/\r\n\0"<>|:*?]/g, '_').slice(0, 160);
      // The API requires repeated `image` fields, not image[].
      form.append('image', new Blob([bytes], { type: media.mime }), name + media.extension);
    }
    body = form;
    delete headers['Content-Type'];
  }
  let response;
  try {
    response = await fetcher(`${baseUrl}${endpoint}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(300000), redirect: 'manual' });
  } catch {
    throw new UncertainImageSubmission('生图提交中断，无法确认平台是否已生成。请先检查平台调用记录，不要立即重复提交。');
  }
  if (response.status === 408 || response.status >= 500 || response.status >= 300 && response.status < 400) {
    throw new UncertainImageSubmission('生图平台未明确返回提交结果（HTTP ' + response.status + '）。请先核对平台调用记录，避免重复收费。');
  }
  try { return normalizeImageResponse(await jsonResponse(response, settings.apiKey), settings.apiKey); }
  catch (error) {
    if (response.ok) throw new UncertainImageSubmission('平台已响应生图请求，但图片结果无法确认或解析。请先核对平台记录，避免重复收费。');
    throw error;
  }
}

export async function checkImageConnection(settings, fetcher = fetch) {
  const protocol = imageModelProtocol(settings.imageModel) || 'gpt';
  const { baseUrl, headers } = credentials(settings, protocol);
  const endpoint = protocol === 'gemini' ? '/v1beta/models' : '/v1/models';
  const response = await fetcher(`${baseUrl}${endpoint}`, { headers, signal: AbortSignal.timeout(20000), redirect: 'error' });
  const data = await jsonResponse(response, settings.apiKey);
  const names = protocol === 'gemini'
    ? (Array.isArray(data?.models) ? data.models.map(item => String(item?.name || '').replace(/^models\//, '')).filter(Boolean) : [])
    : (Array.isArray(data?.data) ? data.data.map(item => String(item?.id || item?.name || '')).filter(Boolean) : []);
  return { readable: true, selectedModelVisible: names.includes(String(settings.imageModel || '').replace(/^models\//, '')), modelCount: names.length,
    models: [...new Set(names)].map(name => ({ name })),
    message: names.length ? `生图令牌已通过只读查询验证，平台返回 ${names.length} 个模型。` : '生图令牌已通过只读查询验证，但平台未返回模型列表。' };
}
