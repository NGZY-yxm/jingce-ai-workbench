export const SPEECH_TEXT_LIMIT = 9999;
export const SPEECH_MODELS = ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo'];
export const SPEECH_EMOTIONS = [
  ['', '自动'], ['happy', '高兴'], ['sad', '悲伤'], ['angry', '愤怒'], ['fearful', '害怕'],
  ['disgusted', '厌恶'], ['surprised', '惊讶'], ['calm', '平静'], ['fluent', '生动（2.6）'], ['whisper', '低语（2.6）'],
];
export const speechCharacterCount = text => Array.from(String(text || '')).length;
export const speechEmotionSupported = (model, emotion) => !['fluent', 'whisper'].includes(emotion) || model.startsWith('speech-2.6-');

export const isSpeechGenerationNode = node => node?.kind === 'audio' && node.role === 'speech-generation';

export function normalizeSpeechDraft(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const string = (field, limit, fallback = '') => typeof source[field] === 'string' ? source[field].slice(0, limit) : fallback;
  const numeric = (field, fallback) => Number.isFinite(Number(source[field])) && source[field] !== '' ? Number(source[field]) : fallback;
  const emotion = string('emotion', 20);
  const format = string('format', 8, 'mp3');
  return {
    model: string('model', 80, SPEECH_MODELS[0]), text: string('text', SPEECH_TEXT_LIMIT),
    voiceId: string('voiceId', 256, 'male-qn-qingse'), name: string('name', 120),
    speed: numeric('speed', 1), vol: numeric('vol', 1), pitch: numeric('pitch', 0),
    emotion: SPEECH_EMOTIONS.some(([id]) => id === emotion) ? emotion : '',
    format: ['mp3', 'wav'].includes(format) ? format : 'mp3',
  };
}

// Official domestic pay-as-you-go list, checked 2026-10-13: Chinese characters count twice.
export function estimateSpeechCost(text, model, region = 'domestic') {
  if (region !== 'domestic' || !SPEECH_MODELS.includes(model)) return null;
  const characters = Array.from(String(text || '')).reduce((sum, character) => sum + (/\p{Script=Han}/u.test(character) ? 2 : 1), 0);
  const pricePerTenThousand = model.endsWith('-turbo') ? 2 : 3.5;
  return { characters, pricePerTenThousand, amount: characters / 10000 * pricePerTenThousand };
}

export function normalizeSpeechRequest(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配音参数应为 JSON 对象。');
  const model = input.model ?? SPEECH_MODELS[0];
  if (!SPEECH_MODELS.includes(model)) throw new Error('请选择已接入的 MiniMax 语音模型。');
  const text = typeof input.text === 'string' ? input.text : '';
  if (!text.trim()) throw new Error('请先填写需要读出的配音文案。');
  if (speechCharacterCount(text) > SPEECH_TEXT_LIMIT) throw new Error(`单次配音最多 ${SPEECH_TEXT_LIMIT} 个字符，请拆成多个任务。`);
  const voiceId = typeof input.voiceId === 'string' ? input.voiceId.trim() : 'male-qn-qingse';
  if (!voiceId || voiceId.length > 256 || /[\x00-\x1f\x7f]/.test(voiceId)) throw new Error('请填写有效的 MiniMax Voice ID（最多 256 字符）。');
  function numeric(field, fallback, min, max, integer = false) {
    const value = input[field] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) {
      throw new Error(`${{ speed: '语速', vol: '音量', pitch: '音调' }[field]}须在 ${min}–${max} 之间${integer ? '，并使用整数' : ''}。`);
    }
    return value;
  }
  const speed = numeric('speed', 1, 0.5, 2), vol = numeric('vol', 1, 0, 10), pitch = numeric('pitch', 0, -12, 12, true);
  if (vol === 0) throw new Error('音量须大于 0，最大为 10。');
  const emotion = input.emotion ?? '';
  if (!SPEECH_EMOTIONS.some(([value]) => value === emotion) || !speechEmotionSupported(model, emotion)) throw new Error('这个模型不支持所选情绪，请调整后提交。');
  const format = input.format ?? 'mp3';
  if (!['mp3', 'wav'].includes(format)) throw new Error('当前支持 MP3 或 WAV 配音文件。');
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : `配音 · ${Array.from(text.trim().replace(/\s+/g, ' ')).slice(0, 24).join('')}`;
  if (name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('配音名称最多 120 字符，不能包含换行。');
  return { model, text, voiceId, speed, vol, pitch, emotion, format, name };
}
