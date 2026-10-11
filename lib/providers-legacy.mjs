import { InputError } from './workflow.mjs';
import { referenceCapabilities, referenceRequestIssue } from '../public/reference-api.js';
import { referenceLabel } from '../public/reference-model.js';

export const PLATFORM = 'https://api.beibeihai.xyz';
export const VIDEO_REQUEST_MODE = 'platform-duration';
export const VIDEO_DOCS_URL = `${PLATFORM}/pricing`;
export const DEFAULT_CONNECTION = {
  platform: 'beibeihai API', baseUrl: PLATFORM,
  docsUrl: VIDEO_DOCS_URL,
  videoModel: 'seedance-2.0-900', resolution: '720p', apiKey: '',
};

async function jsonResponse(response, key = '') {
  const body = await response.text();
  if (body.length > 2 * 1024 * 1024) throw new InputError('平台返回的数据超过允许大小。', 502);
  let data;
  try { data = JSON.parse(body); } catch { throw new InputError('平台未返回 JSON，请检查平台服务状态。', 502); }
  const responseCode = String(data.code || data.error?.code || data.data?.code || '').trim().toLowerCase();
  if (responseCode === 'task_not_exist' || responseCode === 'task_not_found') {
    const error = new InputError('平台请求失败：平台任务不存在。', response.status === 401 ? 401 : 502);
    error.code = responseCode;
    error.providerHttpStatus = response.status; error.retryable = false;
    throw error;
  }
  if (!response.ok) {
    let message = String(data.error?.message || data.message || `HTTP ${response.status}`).slice(0, 400);
    if (key) message = message.split(key).join('[已隐藏密钥]');
    const error = new InputError(`平台请求失败：${message}`, response.status === 401 ? 401 : 502);
    if (responseCode) error.code = responseCode;
    error.providerHttpStatus = response.status;
    error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    const retry = response.headers?.get('retry-after');
    if (retry) error.retryAfterMs = /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(10000, Date.parse(retry) - Date.now());
    throw error;
  }
  return data;
}

export class UncertainSubmission extends Error {
  constructor() { super('平台提交结果无法确认，请先核对平台任务记录。'); }
}

function safeTask(result, key) {
  for (const secret of new Set([key, encodeURIComponent(key)])) {
    if (!secret) continue;
    result.message = result.message.split(secret).join('[已隐藏密钥]');
    result.providerStatus = (result.providerStatus || '').split(secret).join('[已隐藏密钥]');
    // Do not forward a credential echoed into a task identifier or download URL.
    if (result.taskId.includes(secret)) result.taskId = '';
    if (result.url.includes(secret)) result.url = '';
  }
  if (result.taskId.length > 200 || /[\r\n]/.test(result.taskId)) result.taskId = '';
  return result;
}

export async function loadCatalog(fetcher = fetch) {
  const response = await fetcher(`${PLATFORM}/api/pricing`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  const data = await jsonResponse(response);
  if (data.success === false || !Array.isArray(data.data)) throw new InputError('无法读取平台的模型价格表。', 502);
  return data.data.filter(item => item.supported_endpoint_types?.includes('openai-video')).map(item => ({
    name: String(item.model_name), description: String(item.description || ''),
    defaultDuration: Number(item.video_pricing?.default_duration) || null,
    defaultResolution: String(item.video_pricing?.default_resolution || ''),
    ratios: Array.isArray(item.video_pricing?.ratios) ? item.video_pricing.ratios.filter(ratio => typeof ratio === 'string') : [],
    referenceSupport: referenceCapabilities({ description: item.description }),
    tiers: (item.video_pricing?.tiers || []).map(tier => ({
      duration: Number(tier.duration), resolution: String(tier.resolution), price: Number(tier.price),
    })),
    priceUnit: '平台余额单位',
  }));
}

function credentials(settings) {
  if (settings.baseUrl !== PLATFORM) throw new InputError('当前适配器仅支持已核对文档的 beibeihai 平台。');
  if (!settings.apiKey) throw new InputError('请先在“模型连接”中保存平台 API Key。');
  if (/[\r\n]/.test(settings.apiKey)) throw new InputError('API Key 中不能包含换行。');
  return { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' };
}

export function buildVideoRequest(job, image) {
  if (job.requestMode !== VIDEO_REQUEST_MODE) throw new InputError('视频时长设置已更新，请刷新工作台后选择生成时长。');
  if (image || job.referenceAssetId) {
    throw new InputError('参考素材请通过已保存的多参考清单及公网链接提交；接口未约定 Base64 或本地文件上传。');
  }
  const references = job.references ?? [];
  const referenceIssue = referenceRequestIssue({ name: job.model, referenceSupport: job.referenceSupport }, references);
  if (referenceIssue) throw new InputError('多参考生成：' + referenceIssue);
  const durationValid = Number.isInteger(job.duration) && job.duration >= 1 && job.duration <= 30;
  const tiers = Array.isArray(job.providerTiers) ? job.providerTiers.filter(tier => tier && Number.isInteger(Number(tier.duration))
    && typeof tier.resolution === 'string' && tier.resolution.trim()) : [];
  const selectedTier = tiers.find(tier => Number(tier.duration) === job.duration && tier.resolution === job.resolution);
  const includeVideoOptions = job.includeVideoOptions === true;
  // New jobs snapshot the catalog tiers, so both duration and resolution are
  // checked against the exact priced combination before a paid POST. Older
  // records do not have tiers and retain the old default-resolution contract.
  if (!durationValid || (tiers.length && !selectedTier)
      || (!tiers.length && !includeVideoOptions && (!job.providerDefaults?.resolution || job.resolution !== job.providerDefaults.resolution))) {
    throw new InputError(includeVideoOptions
      ? '请选择模型价目表支持的整数秒数与画质组合。'
      : '请选择模型价目表支持的整数秒数；分辨率仍使用模型默认值。');
  }
  if ((includeVideoOptions || references.length) && !job.resolution) {
    throw new InputError('请选择模型价目表中的画质 / 分辨率。');
  }
  const body = { model: job.model, prompt: job.prompt, duration: job.duration };
  // Preserve accepted legacy text-only tasks unless the user explicitly chose
  // scene-level video options. Reference requests always use the full JSON
  // contract because the provider needs their resolution and aspect ratio.
  if (includeVideoOptions || references.length) {
    if (job.providerRatios?.length) {
      if (!job.providerRatios.includes(job.ratio)) throw new InputError('当前模型不支持工程选择的画面比例。');
      body.ratio = job.ratio;
    } else if (job.ratio && includeVideoOptions) {
      // A model without a published ratio list cannot be proven to support a
      // requested ratio; omit it from the paid request rather than guessing.
      if (references.length) throw new InputError('当前模型没有公开可用的画面比例，不能提交多参考生成。');
    }
    body.resolution = job.resolution;
  }
  if (!references.length) return body;
  const notes = [];
  references.forEach((reference, index) => {
    const name = referenceLabel(references, index), field = reference.kind === 'image' ? 'images' : 'videos';
    (body[field] ||= []).push({ url: reference.publicUrl, name });
    if (reference.note) notes.push('@' + name + '：' + reference.note);
  });
  if (notes.length) body.prompt += '\n\n参考素材用途：\n' + notes.join('\n');
  return body;
}

export async function submitVideo(settings, job, image, fetcher = fetch) {
  const headers = credentials(settings);
  const request = buildVideoRequest(job, image);
  if (job.references?.some(reference => [settings.apiKey, encodeURIComponent(settings.apiKey)].some(secret => reference.publicUrl.includes(secret)))) {
    throw new InputError('素材链接不能包含本站 API Key。');
  }
  const body = JSON.stringify(request);
  const response = await fetcher(`${PLATFORM}/v1/video/generations`, {
    method: 'POST', headers, body,
    signal: AbortSignal.timeout(60000), redirect: 'error',
  });
  // A gateway error or malformed success response may follow an accepted, billable POST.
  // Only explicit client rejection is safe to describe as a failed submission.
  if (response.status === 408 || response.status >= 500 || response.status >= 300 && response.status < 400) throw new UncertainSubmission();
  if (!response.ok) return normalizeTask(await jsonResponse(response, settings.apiKey));
  try {
    return safeTask(normalizeTask(await jsonResponse(response, settings.apiKey)), settings.apiKey);
  } catch { throw new UncertainSubmission(); }
}

export async function pollVideo(settings, taskId, fetcher = fetch) {
  if (!taskId || taskId.length > 200) throw new InputError('平台任务编号不正确。');
  const response = await fetcher(`${PLATFORM}/v1/video/generations/${encodeURIComponent(taskId)}`, {
    headers: credentials(settings), signal: AbortSignal.timeout(20000), redirect: 'error',
  });
  return safeTask(normalizeTask(await jsonResponse(response, settings.apiKey)), settings.apiKey);
}

function taskProgress(value) {
  if (value == null || typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(typeof value === 'string' ? value.trim().replace(/%$/, '') : value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function taskTime(value) {
  if (value == null || value === '' || value === 0 || value === '0') return null;
  const timestamp = typeof value === 'number' || /^\d+$/.test(String(value))
    ? Number(value) * (Number(value) < 1e12 ? 1000 : 1) : Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8640000000000000
    ? new Date(timestamp).toISOString() : null;
}

export function normalizeTask(raw) {
  const envelopeCode = String(raw?.code || raw?.error?.code || '').trim().toLowerCase();
  if (envelopeCode === 'task_not_exist' || envelopeCode === 'task_not_found') {
    const error = new InputError('平台请求失败：平台任务不存在。', 502);
    error.code = envelopeCode;
    throw error;
  }
  const data = raw?.data && typeof raw.data === 'object' ? raw.data : raw;
  if (!data || typeof data !== 'object') throw new InputError('平台任务响应格式不正确。', 502);
  const dataCode = String(data.code || data.error?.code || '').trim().toLowerCase();
  if (dataCode === 'task_not_exist' || dataCode === 'task_not_found') {
    const error = new InputError('平台请求失败：平台任务不存在。', 502);
    error.code = dataCode;
    throw error;
  }
  // This gateway wraps the upstream video result inside data.data.
  const details = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : {};
  const providerStatus = String(data.status || details.status || '').slice(0, 60);
  const status = providerStatus.toLowerCase();
  const states = {
    not_start: 'queued', submitted: 'queued', queued: 'queued', pending: 'queued', processing: 'running', running: 'running', in_progress: 'running',
    completed: 'completed', succeeded: 'completed', success: 'completed', failed: 'failed',
    failure: 'failed', canceled: 'failed', cancelled: 'failed', error: 'failed',
  };
  const urls = [data.url, data.video_url, details.url, details.video_url,
    ...(Array.isArray(data.result_urls) ? data.result_urls : []),
    ...(Array.isArray(details.result_urls) ? details.result_urls : [])];
  const url = urls.find(value => typeof value === 'string' && value.trim());
  return { taskId: String(data.task_id || data.id || details.task_id || details.id || ''),
    state: states[status] || 'unknown', providerStatus, url: url || '',
    message: String(data.error?.message || data.fail_reason || details.error?.message || details.fail_reason || data.message || details.message || '').slice(0, 400),
    progress: taskProgress(data.progress) ?? taskProgress(details.progress),
    providerSubmittedAt: taskTime(data.submit_time), providerStartedAt: taskTime(data.start_time),
    providerFinishedAt: taskTime(data.finish_time) };
}

export async function checkConnection(settings, fetcher = fetch) {
  const response = await fetcher(`${PLATFORM}/v1/models`, { headers: credentials(settings),
    signal: AbortSignal.timeout(20000), redirect: 'error' });
  const data = await jsonResponse(response, settings.apiKey);
  const names = Array.isArray(data.data) ? data.data.map(item => item.id) : [];
  return { readable: true, selectedModelVisible: names.includes(settings.videoModel), modelCount: names.length,
    message: '令牌已通过只读查询验证。可在“视频生成”页设置时长、数量和参考素材；参考素材需公网 HTTPS 链接，生成结果与实际扣费以平台为准。' };
}
