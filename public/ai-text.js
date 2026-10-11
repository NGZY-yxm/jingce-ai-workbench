export const AI_OUTPUT_LIMIT = 16000;
export const AI_INSTRUCTION_LIMIT = 4000;

export const AI_MODES = [
  { id: 'free', label: '自由创作', hint: '根据输入内容继续构思或整理文字。' },
  { id: 'optimize-video', label: '优化视频提示词', hint: '补全主体、动作、运镜、光线和画面风格。' },
  { id: 'optimize-image', label: '优化图片提示词', hint: '补全主体、构图、材质、光线和视觉风格。' },
  { id: 'storyboard', label: '拆分分镜', hint: '输出可转换为多个视频生成项的结构化分镜。' },
];

const modeIds = new Set(AI_MODES.map(mode => mode.id));
const statusIds = new Set(['idle', 'running', 'done', 'error']);
const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const number = value => Number.isFinite(Number(value)) ? Math.max(0.5, Math.min(30, Number(value))) : 5;

export function modeRecord(mode) { return AI_MODES.find(item => item.id === mode) || AI_MODES[0]; }

export function normalizeAiConfig(value = {}) {
  const scenes = Array.isArray(value.scenes) ? value.scenes.slice(0, 30).map((scene, index) => ({
    title: clean(scene?.title, 120) || `镜头 ${index + 1}`,
    description: clean(scene?.description || scene?.visual || scene?.scene, 2000),
    visual: clean(scene?.visual || scene?.description || scene?.scene, 2000),
    narration: clean(scene?.narration, 1200),
    imagePrompt: clean(scene?.imagePrompt, 3000),
    videoPrompt: clean(scene?.videoPrompt || scene?.prompt, 4000),
    duration: number(scene?.duration),
  })) : [];
  return {
    mode: modeIds.has(value.mode) ? value.mode : 'free',
    model: clean(value.model, 160),
    instruction: clean(value.instruction, AI_INSTRUCTION_LIMIT),
    output: clean(value.output, AI_OUTPUT_LIMIT),
    status: statusIds.has(value.status) ? value.status : 'idle',
    error: clean(value.error, 400),
    scenes,
    updatedAt: clean(value.updatedAt, 40),
  };
}

export function buildAiMessages({ mode, instruction = '', inputs = [] }) {
  const selected = modeRecord(mode);
  const source = inputs.filter(item => item && typeof item.text === 'string' && item.text.trim())
    .map(item => `【${clean(item.label, 120) || '输入'}】\n${clean(item.text, 6000)}`).join('\n\n');
  const system = [
    '你是镜策视频创作工作台中的中文创作助手。',
    '请只依据用户提供的内容创作，不要编造没有依据的品牌事实、人物身份或产品参数。',
    '输出要具体、可编辑、可直接交给图片或视频生成模型使用。',
    mode === 'storyboard'
      ? '本次必须只返回 JSON，不要 Markdown 代码围栏，不要解释文字。格式为：{"title":"方案标题","scenes":[{"title":"镜头标题","description":"画面内容","visual":"画面内容","narration":"旁白，没有则空字符串","imagePrompt":"图片提示词","videoPrompt":"视频提示词","duration":5}]}。scenes 数量按用户要求控制，duration 使用 0.5 到 30 的数字。'
      : `本次任务是“${selected.label}”：${selected.hint}`,
  ].join('\n');
  const user = [
    selected.id === 'storyboard' ? '请把下面的创作输入整理成结构化分镜。' : '请处理下面的创作输入。',
    instruction.trim() ? `具体要求：\n${instruction.trim()}` : '如果没有额外要求，请先整理输入，再给出可直接使用的结果。',
    source ? `创作输入：\n${source}` : '当前没有上游卡片输入，请仅根据具体要求完成任务。',
  ].join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function jsonCandidate(content) {
  const source = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const firstObject = source.indexOf('{'), lastObject = source.lastIndexOf('}');
  const firstArray = source.indexOf('['), lastArray = source.lastIndexOf(']');
  const candidates = [];
  if (firstObject >= 0 && lastObject > firstObject) candidates.push(source.slice(firstObject, lastObject + 1));
  if (firstArray >= 0 && lastArray > firstArray) candidates.push(source.slice(firstArray, lastArray + 1));
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

function sceneText(scene, index) {
  return [
    `${index + 1}. ${scene.title}`,
    scene.description || scene.visual ? `画面：${scene.description || scene.visual}` : '',
    scene.narration ? `旁白：${scene.narration}` : '',
    scene.imagePrompt ? `图片提示词：${scene.imagePrompt}` : '',
    scene.videoPrompt ? `视频提示词：${scene.videoPrompt}` : '',
    `建议生成时长：${scene.duration} 秒`,
  ].filter(Boolean).join('\n');
}

export function parseAiResponse(mode, content) {
  const raw = clean(content, AI_OUTPUT_LIMIT);
  if (mode !== 'storyboard') return { output: raw, scenes: [] };
  const parsed = jsonCandidate(raw);
  const source = Array.isArray(parsed) ? parsed : parsed?.scenes;
  if (!Array.isArray(source) || !source.length) return { output: raw, scenes: [] };
  const scenes = normalizeAiConfig({ scenes: source }).scenes;
  const title = clean(parsed?.title, 120);
  return { output: [title ? `分镜方案：${title}` : '分镜方案', ...scenes.map(sceneText)].join('\n\n'), scenes };
}
