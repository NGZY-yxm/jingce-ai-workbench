import { estimateSpeechCost } from './speech-parameters.js';

export const VOICE_RECORDING_LIMIT = 20 * 1024 * 1024;
export const VOICE_PREVIEW_LIMITS = { clone: 1000, design: 500 };
export const VOICE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{7,255}$/;
export const newVoiceId = () => `jc_voice_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

export function normalizeVoiceRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('音色参数应为 JSON 对象。');
  const kind = input.kind;
  if (!['clone', 'design'].includes(kind)) throw new Error('请选择录音复刻或文字设计。');
  const voiceId = typeof input.voiceId === 'string' ? input.voiceId.trim() : '';
  if (!VOICE_ID_PATTERN.test(voiceId) || /[-_]$/.test(voiceId)) throw new Error('Voice ID 须为 8–256 位，以英文字母开头，仅含字母、数字、连字符或下划线，末尾不能是连字符或下划线。');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('请填写音色名称，最多 120 字符，不能包含换行。');
  const previewText = typeof input.previewText === 'string' ? input.previewText.trim() : '';
  if (Array.from(previewText).length > VOICE_PREVIEW_LIMITS[kind]) throw new Error(`试听文案最多 ${VOICE_PREVIEW_LIMITS[kind]} 字符。`);
  if (kind === 'design' && !previewText) throw new Error('文字设计需要填写试听文案。');
  const prompt = kind === 'design' && typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (kind === 'design' && (!prompt || prompt.length > 2000)) throw new Error('请描述想要的音色特征，幻帧 MiraFrame单次接受最多 2000 字符。');
  const recordingId = kind === 'clone' && typeof input.recordingId === 'string' ? input.recordingId : '';
  if (kind === 'clone' && !/^[A-Za-z0-9_-]{8,100}$/.test(recordingId)) throw new Error('请先上传用于复刻的录音。');
  for (const key of ['noiseReduction', 'volumeNormalization']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error('录音处理选项应为布尔值。');
  }
  return { kind, name, voiceId, model: input.model, previewText, prompt, recordingId,
    noiseReduction: kind === 'clone' && input.noiseReduction === true,
    volumeNormalization: kind === 'clone' && input.volumeNormalization === true };
}

// Voice Design previews use the official flat rate of RMB 2 per 10,000 billing characters.
export function estimateVoicePreviewCost(text, kind, model, region = 'domestic') {
  return estimateSpeechCost(text, kind === 'design' ? 'speech-2.8-turbo' : model, region);
}
