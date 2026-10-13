import { InputError } from './workflow.mjs';
import { normalizeSpeechSettings, SPEECH_ENDPOINTS, SPEECH_AUDIO_LIMIT, SpeechProviderError, redactSpeechText } from './speech-provider.mjs';
import { detectMedia, isPrivateAddress } from './media.mjs';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { videoProxyAgent } from './download-proxy.mjs';

// MiniMax file IDs are int64 values. Keep large JSON integers exact until the next request.
export function parseVoiceJson(text) {
  return JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (token, number) =>
    number && /^-?\d+$/.test(number) && !Number.isSafeInteger(Number(number)) ? JSON.stringify(number) : token));
}
async function readResponse(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('response too large');
  const reader = response.body?.getReader(); if (!reader) throw new Error('empty response');
  const chunks = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error('response too large'); chunks.push(Buffer.from(value)); }
    return Buffer.concat(chunks);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
async function postVoice(settings, route, body, label, fetcher, creation = false) {
  const connection = normalizeSpeechSettings({}, settings);
  if (!connection.apiKey) throw new InputError('请先在连接中心保存 MiniMax API Key。');
  const multipart = body instanceof FormData;
  let response, data;
  try {
    response = await fetcher(SPEECH_ENDPOINTS[connection.region] + route, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${connection.apiKey}`, ...(!multipart ? { 'Content-Type': 'application/json' } : {}) },
      body: multipart ? body : JSON.stringify(body).replace(/("file_id":)"(\d+)"/g, '$1$2'), signal: AbortSignal.timeout(300000) });
  } catch {
    throw new SpeechProviderError(`MiniMax ${label}连接中断或超时。${creation ? '请先核对平台音色；镜策不会自动再次创建。' : '尚未调用音色创建接口，可重新提交上传。'}`, { uncertain: creation });
  }
  try { data = parseVoiceJson((await readResponse(response, creation ? SPEECH_AUDIO_LIMIT * 2 + 1024 * 1024 : 1024 * 1024)).toString('utf8')); }
  catch { throw new SpeechProviderError(`MiniMax ${label}响应无法读取。${creation ? '请先核对平台音色。' : ''}`, { uncertain: creation && (response.ok || response.status >= 500 || response.status === 408) }); }
  const traceId = redactSpeechText(typeof data?.trace_id === 'string' ? data.trace_id : '', connection).slice(0, 160), code = data?.base_resp?.status_code;
  if (!response.ok || code !== 0) {
    const detail = redactSpeechText(data?.base_resp?.status_msg || `HTTP ${response.status}`, connection);
    throw new SpeechProviderError(`MiniMax ${label}未完成：${detail}${Number.isFinite(code) ? `（${code}）` : ''}。`,
      { traceId, providerCode: Number.isFinite(code) ? code : null, uncertain: creation && (code === 1001 || !Number.isFinite(code) && (response.ok || response.status >= 500 || response.status === 408)) });
  }
  return { data, traceId };
}
export async function uploadCloneRecording(settings, bytes, recording, fetcher = fetch) {
  const form = new FormData(); form.append('purpose', 'voice_clone');
  form.append('file', new Blob([bytes], { type: recording.mime }), recording.name);
  const { data } = await postVoice(settings, '/v1/files/upload', form, '录音上传', fetcher);
  const id = data?.file?.file_id;
  if (!(typeof id === 'string' && /^[1-9]\d{0,39}$/.test(id) || typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) throw new SpeechProviderError('MiniMax 未返回有效的录音文件编号，尚未提交音色复刻。');
  return String(id);
}
function previewUrl(value) {
  let url; try { url = new URL(value); } catch { throw new Error('invalid preview URL'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' ||
    hostname === 'localhost' || hostname.endsWith('.localhost') || isIP(hostname) && isPrivateAddress(hostname)) throw new Error('invalid preview URL');
  return url.href;
}
function previewAudio(bytes) {
  if (!bytes.length || bytes.length > SPEECH_AUDIO_LIMIT) throw new Error('invalid preview audio');
  const media = detectMedia(bytes.subarray(0, 32));
  if (media.kind !== 'audio') throw new Error('invalid preview audio');
  return { audio: bytes.toString('base64'), mime: media.mime, extension: media.extension };
}
export async function createCustomVoice(settings, request, fileId, fetcher = fetch) {
  let body;
  if (request.kind === 'clone') {
    if (!/^[1-9]\d{0,39}$/.test(String(fileId || ''))) throw new InputError('请先完成复刻录音上传。');
    body = { file_id: String(fileId), voice_id: request.voiceId, need_noise_reduction: request.noiseReduction, need_volume_normalization: request.volumeNormalization };
    if (request.previewText) { body.text = request.previewText; body.model = request.model; }
  } else body = { prompt: request.prompt, preview_text: request.previewText, voice_id: request.voiceId };
  const { data, traceId } = await postVoice(settings, request.kind === 'clone' ? '/v1/voice_clone' : '/v1/voice_design', body,
    request.kind === 'clone' ? '音色复刻' : '音色设计', fetcher, true);
  const voiceId = request.kind === 'clone' ? request.voiceId : data.voice_id;
  if (typeof voiceId !== 'string' || !voiceId || voiceId.length > 256 || /[\x00-\x1f\x7f]/.test(voiceId)) throw new SpeechProviderError('平台响应未包含有效 Voice ID，请先核对平台音色。', { uncertain: true, traceId });
  const result = { voiceId, traceId, preview: null, previewUrl: '', previewMessage: '' };
  try {
    if (request.kind === 'design') {
      const hex = data.trial_audio;
      if (typeof hex !== 'string' || !hex.length || hex.length % 2 || hex.length > SPEECH_AUDIO_LIMIT * 2 || !/^[a-f0-9]+$/i.test(hex)) throw new Error('invalid preview');
      result.preview = previewAudio(Buffer.from(hex, 'hex'));
    } else if (data.demo_audio) result.previewUrl = previewUrl(data.demo_audio);
    else if (request.previewText) result.previewMessage = '音色已创建，平台没有返回试听音频。可使用该 Voice ID 正式合成配音。';
  } catch { result.previewMessage = '音色已创建，平台返回的试听音频暂时无法保存。可使用该 Voice ID 正式合成配音。'; }
  return result;
}
// Provider URLs may use a public object-storage CDN as well as MiniMax domains.
// Validate and pin every DNS result, including redirect destinations, before any production download.
export async function resolveVoicePreview(value, resolver = lookup) {
  const url = new URL(previewUrl(value)), hostname = url.hostname.replace(/^\[|\]$/g, '');
  let timeout;
  try {
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
      resolver(hostname, { all: true }), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('DNS timeout')), 10000); timeout.unref(); }),
    ]);
    if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new Error('private preview address');
    return { url, pinned: addresses[0] };
  } finally { clearTimeout(timeout); }
}
async function fetchPinnedPreview(value) {
  const { url, pinned } = await resolveVoicePreview(value), agent = await videoProxyAgent(url, pinned);
  return new Promise((resolve, reject) => {
    const request = https.get(url, { agent, lookup: (_name, options, callback) => options.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
      timeout: 30000, headers: { 'User-Agent': 'Jingce-Ad-Studio/0.1' } }, incoming => {
      const timer = setTimeout(() => incoming.destroy(new Error('preview timeout')), 60000); timer.unref();
      incoming.once('close', () => clearTimeout(timer));
      try {
        const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        const empty = [204, 205, 304].includes(incoming.statusCode);
        if (empty) incoming.resume();
        resolve(new Response(empty ? null : Readable.toWeb(incoming), { status: incoming.statusCode, headers }));
      } catch (error) { incoming.destroy(); reject(error); }
    });
    request.on('timeout', () => request.destroy(new Error('preview timeout'))); request.on('error', reject);
  });
}
export async function downloadVoicePreview(value, fetcher = fetch) {
  let url = previewUrl(value);
  for (let redirect = 0; redirect <= 3; redirect++) {
    const response = fetcher === fetch ? await fetchPinnedPreview(url) : await fetcher(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(60000) });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel(); url = previewUrl(new URL(response.headers.get('location'), url).href); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error('preview download failed'); }
    return previewAudio(await readResponse(response, SPEECH_AUDIO_LIMIT));
  }
  throw new Error('too many preview redirects');
}
