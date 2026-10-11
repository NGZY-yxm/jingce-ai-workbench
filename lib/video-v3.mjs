import { InputError } from './workflow.mjs';
import { UncertainSubmission } from './providers-legacy.mjs';
import { randomUUID } from 'node:crypto';
import { referenceRequestIssue, publicReferenceUrlIssue } from '../public/reference-api.js';
import { referenceLabel } from '../public/reference-model.js';

// Both hostnames expose the same documented video API. The documented `sub`
// endpoint is the default; callers may select the direct endpoint explicitly.
export const PLATFORM = 'https://sub.beibeihai.xyz';
export const VIDEO_PLATFORMS = Object.freeze([
  'https://sub.beibeihai.xyz',
  'https://direct.beibeihai.xyz',
]);
export const VIDEO_REQUEST_MODE = 'beibeihai-content-v3';
export const VIDEO_DOCS_URL = PLATFORM;
export const DEFAULT_CONNECTION = {
  platform: '北北海视频 API', baseUrl: PLATFORM, docsUrl: VIDEO_DOCS_URL,
  videoModel: 'seedance-2.0-933-720P（秒）', resolution: '720p', apiKey: '',
};
const TASKS = '/api/v3/contents/generations/tasks';
const MODEL_DEFAULTS = new Map([
  ['seedance-2.0-933-720P（秒）', '720p'],
  ['seedance-2.0-fast-933-720P（次）', '720p'],
  ['seedance-2.0-mini-903-720P（次）', '480p'],
  ['seedance-2.5-301010-1K（秒）', '720p'],
  ['minimax-h3-933-2K（次）', '720p'],
]);
const RESOLUTIONS = ['480p', '720p', '1080p'];
const RATIOS = ['16:9', '9:16', '1:1'];
export const V3_REFERENCE_SUPPORT = {
  protocol: 'content-v3', imageLimit: null, videoLimit: null, audioLimit: null,
  videoDurationRequired: false, verified: false,
};

export function videoBaseUrl(value = PLATFORM) {
  const normalized = String(value).replace(/\/+$/, '');
  const accepted = VIDEO_PLATFORMS.flatMap(base => [base, base + '/api/v3']);
  if (!accepted.includes(normalized)) {
    throw new InputError('新版视频连接地址应为 https://sub.beibeihai.xyz 或 https://direct.beibeihai.xyz。');
  }
  return normalized.endsWith('/api/v3') ? normalized.slice(0, -'/api/v3'.length) : normalized;
}
function credentials(settings) {
  videoBaseUrl(settings.baseUrl);
  if (!settings.apiKey) throw new InputError('请先在“模型连接”中保存平台 API Key。');
  if (typeof settings.apiKey !== 'string' || /[\r\n]/.test(settings.apiKey)) throw new InputError('API Key 格式不正确。');
  return { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' };
}
function redact(value, key) {
  let result = String(value || '');
  for (const secret of new Set([key, encodeURIComponent(key || '')])) if (secret) result = result.split(secret).join('[已隐藏密钥]');
  return result;
}
function retryAfter(response) {
  const value = response.headers?.get('retry-after');
  if (!value) return null;
  const milliseconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(10000, milliseconds) : null;
}
async function jsonResponse(response, key) {
  const body = await response.text();
  let data;
  if (body.length <= 2 * 1024 * 1024) { try { data = JSON.parse(body); } catch {} }
  const code = String(data?.error?.code || data?.error?.type || data?.code || '');
  // HTTP 200 can carry a terminal task error, including a response without id.
  // Keep task status handling separate from an HTTP/API error envelope.
  if (!response.ok || code && !data?.id && typeof data?.status !== 'string' && !Array.isArray(data?.data)) {
    const message = redact(data?.error?.message || data?.message || `HTTP ${response.status}`, key).slice(0, 400);
    const error = new InputError(`平台请求失败：${message}`, response.status === 401 ? 401 : 502);
    error.code = redact(code, key).slice(0, 200);
    error.providerHttpStatus = response.status;
    error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    error.retryAfterMs = retryAfter(response);
    throw error;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const error = new InputError('平台未返回有效 JSON，请核对平台状态。', 502);
    error.retryable = true; error.providerHttpStatus = response.status;
    throw error;
  }
  return data;
}

// The current-key model list establishes visibility. Parameters below describe
// the documented protocol range, not a guarantee about each model's output.
// The latest document provides no price API or fixed prices.
export function catalogForVideoModelIds(ids) {
  return [...new Set(ids)].filter(id => MODEL_DEFAULTS.has(id)).map(name => ({
    name, requestMode: VIDEO_REQUEST_MODE, baseUrl: PLATFORM, pricingAvailable: false,
    description: (name.includes('seedance-2.0-')
      ? `文档建议：5 秒、${MODEL_DEFAULTS.get(name)}；其他参数组合待平台验证。`
      : '完整生成及输出规格待平台验证。')
      + '可选参数为接口范围，素材能力和数量未逐模型实测；报价请联系平台，实际扣费以账单为准。',
    defaultDuration: 5, defaultResolution: MODEL_DEFAULTS.get(name), ratios: [...RATIOS],
    referenceSupport: { ...V3_REFERENCE_SUPPORT },
    tiers: RESOLUTIONS.flatMap(resolution => Array.from({ length: 15 }, (_, index) => ({ duration: index + 1, resolution, price: null }))),
    priceUnit: '平台账单', pricingNote: '新版文档不提供单价；请联系平台确认报价。', documentDate: '2026-10-10',
  }));
}
async function modelIds(settings, fetcher) {
  const response = await fetcher(`${videoBaseUrl(settings.baseUrl)}/v1/models`, {
    headers: credentials(settings), signal: AbortSignal.timeout(20000), redirect: 'error',
  });
  const data = await jsonResponse(response, settings.apiKey);
  if (!Array.isArray(data.data)) throw new InputError('平台模型目录格式不正确。', 502);
  return data.data.map(item => item?.id).filter(id => typeof id === 'string' && id && id.length <= 120);
}
export async function loadCatalog(settings, fetcher = fetch) {
  return catalogForVideoModelIds(await modelIds(settings, fetcher));
}
export async function checkConnection(settings, fetcher = fetch) {
  const ids = await modelIds(settings, fetcher);
  return { readable: true, selectedModelVisible: ids.includes(settings.videoModel), modelCount: ids.length,
    videoModelCount: catalogForVideoModelIds(ids).length,
    message: '已通过当前密钥的只读模型查询。模型可见不代表所有参数和参考素材都已验证；报价请联系平台，实际扣费以平台账单为准。' };
}

export function buildVideoRequest(job, image) {
  if (job.requestMode !== VIDEO_REQUEST_MODE) throw new InputError('视频接口已更新，请刷新工作台并重新选择模型参数。');
  if (image || job.referenceAssetId) throw new InputError('参考素材请先保存到当前视频卡片，并准备公网 HTTPS 链接。');
  if (!MODEL_DEFAULTS.has(job.model)) throw new InputError('请选择当前密钥目录中的完整视频模型名称。');
  if (typeof job.prompt !== 'string' || !job.prompt.trim()) throw new InputError('请填写非空视频提示词。');
  if (!Number.isInteger(job.duration) || job.duration < 1 || job.duration > 15) throw new InputError('新版视频时长必须为 1 至 15 的整数秒数。');
  if (!RESOLUTIONS.includes(job.resolution)) throw new InputError('视频分辨率请选择 480p、720p 或 1080p。');
  if (!RATIOS.includes(job.ratio)) throw new InputError('画面比例请选择 16:9、9:16 或 1:1。');
  if (job.providerTiers?.length && !job.providerTiers.some(tier => tier.duration === job.duration && tier.resolution === job.resolution)) {
    throw new InputError('所选时长与分辨率不在当前模型参数列表中。');
  }
  const references = job.references ?? [];
  const issue = referenceRequestIssue({ referenceSupport: V3_REFERENCE_SUPPORT }, references);
  if (issue) throw new InputError('多参考生成：' + issue);
  const notes = references.map((reference, index) => reference.note ? '@' + referenceLabel(references, index) + '：' + reference.note : '').filter(Boolean);
  const text = job.prompt + (notes.length ? '\n\n参考素材用途：\n' + notes.join('\n') : '');
  const content = [{ type: 'text', text }];
  references.forEach((reference, index) => {
    const type = reference.kind + '_url';
    content.push({ type, [type]: { url: reference.publicUrl },
      role: reference.role || 'reference_' + reference.kind, name: referenceLabel(references, index) });
  });
  return { model: job.model, duration: job.duration, resolution: job.resolution, ratio: job.ratio, content };
}
function progress(value) {
  if (value == null || value === '' || !['number', 'string'].includes(typeof value)) return null;
  const number = Number(String(value).replace(/%$/, ''));
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}
function taskTime(value) {
  if (value == null || value === '' || value === 0) return null;
  const timestamp = /^\d+$/.test(String(value)) ? Number(value) * (Number(value) < 1e12 ? 1000 : 1) : Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8640000000000000 ? new Date(timestamp).toISOString() : null;
}
export function normalizeVideoV3Task(data, key = '') {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new InputError('平台任务响应格式不正确。', 502);
  const providerStatus = redact(data.status, key).slice(0, 60);
  const states = { queued: 'queued', running: 'running', succeeded: 'completed', completed: 'completed', failed: 'failed', cancelled: 'failed', expired: 'failed' };
  let taskId = typeof data.id === 'string' ? data.id : typeof data.task_id === 'string' ? data.task_id : '';
  let url = typeof data.content?.video_url === 'string' ? data.content.video_url.trim() : '';
  for (const secret of new Set([key, encodeURIComponent(key || '')])) if (secret) {
    if (taskId.includes(secret)) taskId = '';
    if (url.includes(secret)) url = '';
  }
  if (!/^[\w.-]{1,200}$/.test(taskId)) taskId = '';
  if (url && publicReferenceUrlIssue(url)) url = '';
  let state = states[providerStatus] || 'attention', pollBlocked = state === 'attention';
  let message = redact(data.error?.message || data.message, key).slice(0, 400);
  if (state === 'completed' && !url) {
    state = 'attention'; pollBlocked = true;
    message = '平台报告 succeeded，但未返回有效 content.video_url。请保留原编号并联系平台核查。';
  } else if (state === 'attention' && !message) message = '平台任务状态尚未识别，已暂停自动查询；请保留原编号并核对。';
  if (providerStatus === 'cancelled' && !message) message = '平台任务已取消，已停止查询。';
  if (providerStatus === 'expired' && !message) message = '平台任务已过期，已停止查询。';
  return { taskId, state, providerStatus, url: state === 'completed' ? url : '', message,
    errorCode: redact(data.error?.code || data.error?.type, key).slice(0, 200), pollBlocked, progress: progress(data.progress),
    providerSubmittedAt: taskTime(data.created_at), providerStartedAt: taskTime(data.started_at), providerFinishedAt: taskTime(data.finished_at) };
}
function uncertainSubmission(message, code, httpStatus = null) {
  const error = new UncertainSubmission();
  error.message = message + ' 请保留提交记录并联系平台核查，不会自动重新提交。';
  error.code = code;
  error.providerHttpStatus = httpStatus;
  return error;
}
export async function submitVideo(settings, job, image, fetcher = fetch) {
  const headers = credentials(settings), request = buildVideoRequest(job, image);
  headers['X-Request-Id'] = job.providerRequestId || randomUUID();
  if (job.references?.some(reference => [settings.apiKey, encodeURIComponent(settings.apiKey)].some(secret => reference.publicUrl.includes(secret)))) {
    throw new InputError('素材链接不能包含本站 API Key。');
  }
  let response;
  try {
    response = await fetcher(`${videoBaseUrl(settings.baseUrl)}${TASKS}`, { method: 'POST', headers,
      body: JSON.stringify(request), signal: AbortSignal.timeout(120000), redirect: 'error' });
  } catch { throw uncertainSubmission('创建请求连接中断或超时，是否已创建任务尚不确定。', 'SUBMISSION_NETWORK'); }
  if (response.status === 408 || response.status >= 500 || response.status >= 300 && response.status < 400) {
    throw uncertainSubmission(`创建接口返回 HTTP ${response.status}，是否已创建任务尚不确定。`, `SUBMISSION_HTTP_${response.status}`, response.status);
  }
  if (!response.ok) await jsonResponse(response, settings.apiKey);
  try {
    const result = normalizeVideoV3Task(await jsonResponse(response, settings.apiKey), settings.apiKey);
    if (!result.taskId) throw uncertainSubmission('创建响应未包含有效任务编号。', 'SUBMISSION_ID_MISSING', response.status);
    return result;
  } catch (error) {
    if (error instanceof UncertainSubmission) throw error;
    throw uncertainSubmission('创建响应格式无法确认。', 'SUBMISSION_RESPONSE_INVALID', response.status);
  }
}
export async function pollVideo(settings, taskId, fetcher = fetch) {
  if (typeof taskId !== 'string' || !/^[\w.-]{1,200}$/.test(taskId)) throw new InputError('平台任务编号不正确。');
  const response = await fetcher(`${videoBaseUrl(settings.baseUrl)}${TASKS}/${encodeURIComponent(taskId)}`, {
    headers: credentials(settings), signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  const data = await jsonResponse(response, settings.apiKey);
  const result = normalizeVideoV3Task(data, settings.apiKey);
  // Polling must remain attached to the original identifier, even if a response
  // omits its id. A conflicting id is a protocol problem requiring review.
  const returnedTaskId = typeof data.id === 'string' ? data.id : typeof data.task_id === 'string' ? data.task_id : '';
  if (returnedTaskId && result.taskId !== taskId) {
    result.state = 'attention'; result.pollBlocked = true; result.url = '';
    result.message = '平台查询返回的编号与原任务不一致，已暂停查询，请核对原任务。';
  }
  result.taskId = taskId;
  return result;
}
