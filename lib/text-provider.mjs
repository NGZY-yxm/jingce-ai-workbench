import { InputError } from './workflow.mjs';

// The text API is an OpenAI-compatible Chat Completions endpoint. Keep this
// adapter separate from the image and video adapters because its model list,
// request shape, and credential file have different contracts.
export const TEXT_PLATFORM = 'https://sub.beibeihai.xyz/v1';
export const TEXT_DOCS_URL = 'https://sub.beibeihai.xyz/pricing';
export const DEFAULT_TEXT_CONNECTION = {
  platform: '北北海文本模型 API',
  baseUrl: TEXT_PLATFORM,
  docsUrl: TEXT_DOCS_URL,
  textModel: '',
  apiKey: '',
};

const allowedRoles = new Set(['system', 'user', 'assistant']);
const textReplyInstruction = '请直接给出最终结果，不要反问，不要要求用户选择方案，不要调用工具。回复必须包含文本内容；若任务要求 JSON，请严格返回指定格式的 JSON。';

function redact(value, key = '') {
  let result = String(value || '');
  for (const secret of new Set([key, key && encodeURIComponent(key)])) {
    if (secret) result = result.split(secret).join('[已隐藏密钥]');
  }
  return result;
}

function credentials(settings) {
  if (settings.baseUrl !== TEXT_PLATFORM) throw new InputError('当前语言模型适配器仅支持文档中的 sub.beibeihai.xyz/v1。');
  if (!settings.apiKey) throw new InputError('请先在“语言模型”连接中保存 API Key。');
  if (/[\r\n]/.test(settings.apiKey)) throw new InputError('语言模型 API Key 不能包含换行。');
  return { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' };
}

function providerStatus(status) {
  return status >= 400 && status < 500 ? status : 502;
}

function transportError(error, timeoutMs, submitted) {
  // Do not expose raw network messages: they can contain headers, URLs or keys.
  const codes = new Set(), names = new Set();
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth++) {
    codes.add(current.code); names.add(current.name);
  }
  const has = (...values) => values.some(value => codes.has(value));
  const uncertain = submitted ? '平台是否已完成本次生成无法确认，请先核对平台记录；工作台没有自动重发请求。' : '';
  let message, status = 502, code;
  if (names.has('TimeoutError')) {
    message = Number.isFinite(timeoutMs)
      ? `语言模型请求超过 ${timeoutMs / 1000} 秒仍未收到完整回复。`
      : '语言模型请求被中断，未收到完整回复。';
    status = 504; code = 'TEXT_REQUEST_TIMEOUT';
  } else if (has('UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT')) {
    message = '连接语言模型平台超时，请检查本机网络和代理。';
    status = 504; code = 'TEXT_CONNECT_TIMEOUT';
  } else if (has('UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT')) {
    message = '等待语言模型平台回复超时，未收到完整结果。';
    status = 504; code = 'TEXT_RESPONSE_TIMEOUT';
  } else if (has('ENOTFOUND', 'EAI_AGAIN')) {
    message = '无法解析语言模型平台地址，请检查本机网络、DNS 和代理。';
    code = 'TEXT_DNS_ERROR';
  } else if (has('CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_SIGNATURE_FAILURE', 'ERR_TLS_CERT_ALTNAME_INVALID')) {
    message = '语言模型平台的 HTTPS 证书校验失败，请检查系统时间、平台证书和代理配置。';
    code = 'TEXT_TLS_ERROR';
  } else if (names.has('AbortError') || has('ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET')) {
    message = '语言模型请求连接中断，未收到完整回复。';
    code = 'TEXT_CONNECTION_INTERRUPTED';
  } else if (has('ECONNREFUSED')) {
    message = '无法连接语言模型平台，请检查网络、代理和平台服务状态。';
    code = 'TEXT_CONNECTION_REFUSED';
  } else {
    message = '语言模型网络请求失败，未收到完整回复，请检查网络、代理和平台服务状态。';
    code = 'TEXT_NETWORK_ERROR';
  }
  return Object.assign(new InputError(message + uncertain, status), { code });
}

async function requestTextJson(settings, route, options, fetcher, timeoutMs) {
  try {
    const response = await fetcher(`${TEXT_PLATFORM}${route}`, {
      ...options, ...(Number.isFinite(timeoutMs) ? { signal: AbortSignal.timeout(timeoutMs) } : {}), redirect: 'error',
    });
    // Body consumption can fail after HTTP headers have arrived as well.
    return await jsonResponse(response, settings.apiKey);
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw transportError(error, timeoutMs, options.method === 'POST');
  }
}

async function jsonResponse(response, key = '') {
  const body = await response.text();
  let data;
  try { data = JSON.parse(body); }
  catch { throw Object.assign(new InputError(`文本模型未返回 JSON（HTTP ${response.status}）。`, providerStatus(response.status)), { code: 'TEXT_INVALID_JSON' }); }
  if (!data || typeof data !== 'object') throw Object.assign(new InputError('文本模型返回的 JSON 结构不正确。', 502), { code: 'TEXT_INVALID_RESPONSE' });
  if (!response.ok) {
    const message = redact(data.error?.message || data.message || `HTTP ${response.status}`, key).slice(0, 400);
    throw Object.assign(new InputError(`文本模型请求失败（HTTP ${response.status}）：${message}`, providerStatus(response.status)), { code: 'TEXT_PROVIDER_ERROR', providerStatus: response.status });
  }
  return data;
}

function modelRecords(data) {
  if (!Array.isArray(data?.data)) throw new InputError('文本模型目录格式不正确。', 502);
  return data.data.map(item => ({
    name: typeof item?.id === 'string' ? item.id.trim().slice(0, 160) : '',
    owner: typeof item?.owned_by === 'string' ? item.owned_by.trim().slice(0, 120) : '',
  })).filter(item => item.name);
}

export async function loadTextCatalog(settings, fetcher = fetch) {
  return modelRecords(await requestTextJson(settings, '/models', { headers: credentials(settings) }, fetcher, 20000));
}

export async function checkTextConnection(settings, fetcher = fetch) {
  const catalog = await loadTextCatalog(settings, fetcher);
  const selected = String(settings.textModel || '');
  return {
    readable: true,
    selectedModelVisible: Boolean(selected && catalog.some(model => model.name === selected)),
    modelCount: catalog.length,
    message: selected && catalog.some(model => model.name === selected)
      ? `语言模型令牌已通过只读查询验证，当前模型在目录中。已读取 ${catalog.length} 个模型；实际生成能力需以对话响应为准。`
      : `语言模型令牌已通过只读查询验证，但当前选择的模型不在目录中。已读取 ${catalog.length} 个模型，请刷新并重新选择。`,
  };
}

export function normalizeTextMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new InputError('至少需要一条对话消息。');
  const result = messages.map(message => {
    if (!message || typeof message !== 'object' || !allowedRoles.has(message.role)) {
      throw new InputError('对话消息的角色必须是 system、user 或 assistant。');
    }
    if (typeof message.content !== 'string' || !message.content.trim()) throw new InputError('对话消息内容不能为空。');
    const content = message.content.trim();
    return { role: message.role, content };
  });
  return result;
}

export async function chatText(settings, input, fetcher = fetch) {
  const model = typeof input?.model === 'string' && input.model.trim() ? input.model.trim().slice(0, 160) : settings.textModel;
  if (!model) throw new InputError('请先刷新语言模型目录并选择一个模型。');
  const messages = normalizeTextMessages(input?.messages);
  const systemMessage = messages.find(message => message.role === 'system');
  if (systemMessage) systemMessage.content += `\n\n${textReplyInstruction}`;
  else messages.unshift({ role: 'system', content: textReplyInstruction });
  const data = await requestTextJson(settings, '/chat/completions', {
    method: 'POST',
    headers: credentials(settings),
    body: JSON.stringify({ model, messages, stream: false }),
  }, fetcher, null);
  const answer = data.choices?.[0]?.message?.content;
  if (typeof answer !== 'string') throw new InputError('文本模型响应中没有文字回复，请检查所选模型的 Chat Completions 能力。', 502);
  if (!answer.trim()) {
    throw Object.assign(new InputError('文本模型返回了空白回复，请检查所选模型的 Chat Completions 输出能力。', 502), { code: 'TEXT_EMPTY_RESPONSE' });
  }
  const usage = data.usage && typeof data.usage === 'object' ? {
    promptTokens: Number.isFinite(Number(data.usage.prompt_tokens)) ? Number(data.usage.prompt_tokens) : null,
    completionTokens: Number.isFinite(Number(data.usage.completion_tokens)) ? Number(data.usage.completion_tokens) : null,
    totalTokens: Number.isFinite(Number(data.usage.total_tokens)) ? Number(data.usage.total_tokens) : null,
  } : null;
  return {
    model,
    content: answer,
    finishReason: String(data.choices?.[0]?.finish_reason || ''),
    usage,
  };
}
