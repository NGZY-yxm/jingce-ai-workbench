import { InputError } from './workflow.mjs';
import { detectMedia } from './media.mjs';
import { SPEECH_MODELS, normalizeSpeechRequest } from '../public/speech-parameters.js';

export const SPEECH_ENDPOINTS = { domestic: 'https://api.minimax.cn', international: 'https://api.minimax.io' };
export const SPEECH_DOCS_URL = 'https://platform.minimaxi.com/docs/api-reference/speech-t2a-http';
export const DEFAULT_SPEECH_CONNECTION = { region: 'domestic', model: SPEECH_MODELS[0], apiKey: '' };
export const SPEECH_AUDIO_LIMIT = 64 * 1024 * 1024;

export function normalizeSpeechSettings(input = {}, previous = DEFAULT_SPEECH_CONNECTION) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('语音连接设置应为 JSON 对象。');
  const baseUrl = input.baseUrl || previous.baseUrl;
  const region = input.region ?? (baseUrl ? Object.keys(SPEECH_ENDPOINTS).find(key => SPEECH_ENDPOINTS[key] === baseUrl) : previous.region ?? 'domestic');
  const model = input.model ?? previous.models?.[0] ?? previous.model ?? SPEECH_MODELS[0];
  if (!Object.hasOwn(SPEECH_ENDPOINTS, region)) throw new InputError('请选择 MiniMax 官方国内或国际接口。');
  if (input.baseUrl && input.baseUrl !== SPEECH_ENDPOINTS[region]) throw new InputError('语音连接仅支持所选区域的 MiniMax 官方接口。');
  if (!SPEECH_MODELS.includes(model)) throw new InputError('请选择已接入的 MiniMax 语音模型。');
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string') throw new InputError('API Key 应为文本。');
  const apiKey = input.clearKey === true ? '' : input.apiKey?.trim() || previous.apiKey || '';
  if (apiKey.length > 8192 || /[^\x21-\x7e]/.test(apiKey)) throw new InputError('MiniMax API Key 格式不正确，不能包含空格或换行。');
  return { region, model, apiKey };
}

export function publicSpeechSettings(settings = DEFAULT_SPEECH_CONNECTION) {
  const region = settings.baseUrl ? Object.keys(SPEECH_ENDPOINTS).find(key => SPEECH_ENDPOINTS[key] === settings.baseUrl) || 'domestic' : Object.hasOwn(SPEECH_ENDPOINTS, settings.region) ? settings.region : 'domestic';
  return { region, baseUrl: SPEECH_ENDPOINTS[region], model: settings.models?.[0] || settings.model || SPEECH_MODELS[0], hasKey: Boolean(settings.apiKey),
    docsUrl: region === 'domestic' ? SPEECH_DOCS_URL : 'https://platform.minimax.io/docs/api-reference/speech-t2a-http',
    pricingUrl: region === 'domestic' ? 'https://platform.minimaxi.com/docs/guides/pricing-paygo' : 'https://platform.minimax.io/docs/guides/pricing-paygo' };
}

export class SpeechProviderError extends InputError {
  constructor(message, { uncertain = false, traceId = '', providerCode = null } = {}) {
    super(message, 502); this.uncertain = uncertain; this.traceId = traceId; this.providerCode = providerCode;
  }
}

export function redactSpeechText(value, settings) {
  let text = String(value || '');
  if (settings.apiKey) for (const secret of [settings.apiKey, encodeURIComponent(settings.apiKey)]) text = text.split(secret).join('[已隐藏密钥]');
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏密钥]').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500);
}

async function readJson(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('response too large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty response');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) throw new Error('response too large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

async function post(settings, route, body, fetcher, synthesis) {
  const connection = normalizeSpeechSettings({}, settings);
  if (!connection.apiKey) throw new InputError('请先保存 MiniMax API Key。');
  let response;
  try {
    response = await fetcher(SPEECH_ENDPOINTS[connection.region] + route, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${connection.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(synthesis ? 300000 : 30000) });
  } catch {
    throw new SpeechProviderError(synthesis ? '配音请求连接中断或超时，请先核对 MiniMax 记录。镜策不会自动再次生成。' : '音色列表连接中断，请检查网络后重新读取。', { uncertain: synthesis });
  }
  let data;
  try { data = await readJson(response, synthesis ? SPEECH_AUDIO_LIMIT * 2 + 1024 * 1024 : 4 * 1024 * 1024); }
  catch {
    throw new SpeechProviderError(synthesis ? '配音响应不完整或无法读取，请先核对 MiniMax 记录。' : 'MiniMax 音色列表响应无法读取。',
      { uncertain: synthesis && (response.ok || response.status >= 500 || response.status === 408) });
  }
  const traceId = redactSpeechText(typeof data?.trace_id === 'string' ? data.trace_id : '', connection).slice(0, 160);
  const code = data?.base_resp?.status_code;
  if (!response.ok || code !== 0) {
    const detail = redactSpeechText(data?.base_resp?.status_msg || `HTTP ${response.status}`, connection);
    throw new SpeechProviderError(`MiniMax ${synthesis ? '配音' : '音色读取'}未完成：${detail}${Number.isFinite(code) ? `（${code}）` : ''}。`,
      { traceId, providerCode: Number.isFinite(code) ? code : null, uncertain: synthesis && (code === 1001 || !Number.isFinite(code) && (response.ok || response.status >= 500 || response.status === 408)) });
  }
  return { data, traceId };
}

export async function listSpeechVoices(settings, fetcher = fetch) {
  const { data } = await post(settings, '/v1/get_voice', { voice_type: 'all' }, fetcher, false);
  const voices = [], seen = new Set();
  for (const [field, type] of [['system_voice', 'system'], ['voice_cloning', 'cloned'], ['voice_generation', 'designed']]) {
    if (data[field] !== undefined && !Array.isArray(data[field])) throw new SpeechProviderError('MiniMax 音色列表格式不正确。');
    for (const voice of data[field] || []) {
      const id = redactSpeechText(typeof voice?.voice_id === 'string' ? voice.voice_id : '', settings).slice(0, 256);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const descriptions = Array.isArray(voice.description) ? voice.description.filter(value => typeof value === 'string').join('，') : typeof voice.description === 'string' ? voice.description : '';
      voices.push({ id, name: redactSpeechText(voice.voice_name || id, settings).slice(0, 160), description: redactSpeechText(descriptions, settings), type });
    }
  }
  if (!['system_voice', 'voice_cloning', 'voice_generation'].some(field => Array.isArray(data[field]))) throw new SpeechProviderError('MiniMax 未返回音色列表。');
  return { voices, checkedAt: new Date().toISOString(), message: `已读取 ${voices.length} 个音色；本次未提交配音生成。` };
}

export async function synthesizeSpeech(settings, input, fetcher = fetch) {
  let request;
  try { request = normalizeSpeechRequest(input); } catch (error) { throw new InputError(error.message); }
  const voice = { voice_id: request.voiceId, speed: request.speed, vol: request.vol, pitch: request.pitch };
  if (request.emotion) voice.emotion = request.emotion;
  const { data, traceId } = await post(settings, '/v1/t2a_v2', {
    model: request.model, text: request.text, stream: false, voice_setting: voice,
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: request.format, channel: 1 }, output_format: 'hex',
  }, fetcher, true);
  const hex = data?.data?.audio;
  if (data?.data?.status !== 2 || typeof hex !== 'string' || !hex.length || hex.length % 2 || hex.length > SPEECH_AUDIO_LIMIT * 2 || !/^[a-f0-9]+$/i.test(hex)) {
    throw new SpeechProviderError('MiniMax 未返回完整有效的配音音频，请先核对平台记录。', { uncertain: true, traceId });
  }
  const audio = Buffer.from(hex, 'hex'); let media;
  try { media = detectMedia(audio.subarray(0, 32)); } catch {}
  if (!media || media.kind !== 'audio' || media.extension !== `.${request.format}`) throw new SpeechProviderError('MiniMax 返回的文件与所选音频格式不符，请先核对平台记录。', { uncertain: true, traceId });
  const extra = data.extra_info || {};
  const duration = Number.isFinite(extra.audio_length) && extra.audio_length > 0 ? extra.audio_length / 1000 : null;
  const usageCharacters = Number.isFinite(extra.usage_characters) && extra.usage_characters >= 0 ? extra.usage_characters : null;
  return { audio, mime: media.mime, extension: media.extension, duration, usageCharacters, traceId };
}
