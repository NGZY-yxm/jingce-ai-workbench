// Shared by the browser and server. A scene is data; it never contains Python.
export const PREVIS_LIMITS = { objects: 160, actors: 12, keys: 120, duration: 30 };
const fail = message => { throw new Error(message); };
const object = (value, label) => value && typeof value === 'object' && !Array.isArray(value) ? value : fail(`${label}需要是对象。`);
function fields(value, allowed, label) {
  object(value, label);
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) fail(`${label}包含不支持的字段：${extra.join('、')}。`);
}
function number(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label}需要是 ${min}–${max} 之间的数值。`);
  return value;
}
function vector(value, min, max, label, length = 3) {
  if (!Array.isArray(value) || value.length !== length) fail(`${label}需要有 ${length} 个数值。`);
  return value.map((item, index) => number(item, min, max, `${label}[${index}]`));
}
function name(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120) fail(`${label}需要有 1–120 个字符。`);
  return value.trim();
}
const color = (value = '#b9bdc6') => /^#[0-9a-f]{6}$/i.test(value) ? value : fail('颜色需要使用 #RRGGBB。');
const choice = (value, choices, label) => choices.includes(value) ? value : fail(`${label}可选：${choices.join('、')}。`);
const list = (value, max, label) => Array.isArray(value) && value.length <= max ? value : fail(`${label}需要是数组，最多 ${max} 项。`);
export function previsDimensions(spec) {
  const [a, b] = spec.ratio.split(':').map(Number), edge = spec.resolution;
  return a >= b ? { width: Math.round(edge * a / b / 2) * 2, height: edge }
    : { width: edge, height: Math.round(edge * b / a / 2) * 2 };
}
export function normalizePrevisSpec(value) {
  fields(value, ['schemaVersion', 'name', 'duration', 'fps', 'ratio', 'resolution', 'world', 'objects', 'actors', 'camera', 'beats'], '场景');
  if (value.schemaVersion !== 1) fail('scene_spec 的 schemaVersion 需要为 1。');
  const spec = { schemaVersion: 1, name: name(value.name, '场景名称'), duration: number(value.duration, 1, PREVIS_LIMITS.duration, '时长'),
    fps: choice(value.fps, [12, 24, 25, 30], '帧率'), ratio: choice(value.ratio, ['16:9', '9:16', '1:1'], '画面比例'),
    resolution: choice(value.resolution, [360, 540, 720], '预演短边分辨率') };
  if (!Number.isInteger(spec.duration * spec.fps)) fail('时长乘帧率需要为整数帧。');
  const totalFrames = spec.duration * spec.fps;
  fields(value.world, ['size', 'color'], '地面');
  spec.world = { size: vector(value.world.size, 2, 100, '地面尺寸', 2), color: color(value.world.color || '#646b75') };
  const ids = new Set();
  function id(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value) || ids.has(value)) fail('人物和道具 id 需要唯一，只使用字母、数字、下划线或短横线。');
    ids.add(value); return value;
  }
  function routeInterpolation(route, label) {
    const modes = new Set();
    if (route.interpolation !== undefined) modes.add(choice(route.interpolation, ['linear', 'smooth'], label + '插值'));
    for (const key of Array.isArray(route.keys) ? route.keys : []) {
      if (key?.interpolation !== undefined) modes.add(choice(key.interpolation, ['linear', 'smooth'], label + '关键点插值'));
    }
    if (modes.size > 1) fail(label + '包含不同的 interpolation；当前预演仅支持整条路线统一使用 linear 或 smooth，请将 interpolation 放在路线所属的人物或摄影机上。');
    return [...modes][0] || 'smooth';
  }
  function keys(values, camera = false) {
    if (!list(values, PREVIS_LIMITS.keys, '路线关键点').length || values.length < 2) fail('每条路线至少需要开头和结尾两个关键点。');
    let previousFrame = -1;
    const result = values.map(key => {
      fields(key, camera ? ['time', 'position', 'target', 'interpolation'] : ['time', 'position', 'yaw', 'interpolation'], '路线关键点');
      const time = number(key.time, 0, spec.duration, '关键点时间'), frame = Math.min(totalFrames - 1, Math.round(time * spec.fps));
      if (frame <= previousFrame) fail('关键点时间需要严格递增，且不能落在同一帧。');
      previousFrame = frame;
      const point = { time, position: vector(key.position, -100, 100, '关键点位置') };
      if (camera) {
        point.target = vector(key.target, -100, 100, '镜头注视点');
        if (Math.hypot(...point.target.map((v, i) => v - point.position[i])) < 0.01) fail('镜头位置不能与注视点重合。');
      } else if (key.yaw !== undefined) point.yaw = number(key.yaw, -3600, 3600, '人物朝向（度）');
      return point;
    });
    if (result[0].time !== 0 || result.at(-1).time !== spec.duration) fail('路线需要从 0 秒开始，在场景总时长结束。');
    return result;
  }
  spec.objects = list(value.objects, PREVIS_LIMITS.objects, '道具').map(item => {
    fields(item, ['id', 'name', 'shape', 'position', 'size', 'yaw', 'color'], '道具');
    return { id: id(item.id), name: name(item.name || item.id, '道具名称'), shape: choice(item.shape, ['box', 'sphere', 'cylinder'], '道具形状'),
      position: vector(item.position, -100, 100, '道具位置'), size: vector(item.size, 0.01, 50, '道具尺寸'),
      yaw: number(item.yaw ?? 0, -3600, 3600, '道具朝向（度）'), color: color(item.color) };
  });
  spec.actors = list(value.actors, PREVIS_LIMITS.actors, '活动主体').map(item => {
    fields(item, ['id', 'name', 'shape', 'size', 'color', 'keys', 'interpolation'], '活动主体');
    return { id: id(item.id), name: name(item.name || item.id, '主体名称'), shape: choice(item.shape || 'human', ['human', 'box', 'sphere', 'cylinder'], '主体形状'),
      size: vector(item.size || [0.65, 0.4, 1.75], 0.05, 20, '主体尺寸'), color: color(item.color || '#dfae70'),
      interpolation: routeInterpolation(item, '主体'), keys: keys(item.keys) };
  });
  fields(value.camera, ['lens', 'keys', 'interpolation'], '摄影机');
  spec.camera = { lens: number(value.camera.lens, 15, 120, '焦距（mm）'),
    interpolation: routeInterpolation(value.camera, '摄影机'), keys: keys(value.camera.keys, true) };
  spec.beats = list(value.beats || [], 20, '剧情节拍').map(beat => {
    fields(beat, ['time', 'label'], '剧情节拍');
    return { time: number(beat.time, 0, spec.duration, '节拍时间'), label: name(beat.label, '节拍说明') };
  }).sort((a, b) => a.time - b.time);
  return spec;
}
export function parsePrevisSpec(text) {
  let value;
  try { value = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*\n/i, '').replace(/\n```\s*$/, '')); }
  catch { fail('场景 JSON 无法解析，请检查逗号、引号和括号；可在对话中保留原文并请求修复。'); }
  return normalizePrevisSpec(value);
}
export function defaultPrevisSpec() {
  return {
    schemaVersion: 1, name: '庭院相遇', duration: 8, fps: 24, ratio: '16:9', resolution: 360,
    world: { size: [18, 14], color: '#8e949a' },
    objects: [
      { id: 'back-wall', name: '庭院后墙', shape: 'box', position: [0, 5, 1.5], size: [16, 0.25, 3], color: '#c6c9ce' },
      { id: 'bench', name: '长椅', shape: 'box', position: [3, 2, 0.4], size: [2.2, 0.6, 0.8], color: '#a4a8b0' },
      { id: 'planter', name: '花坛', shape: 'cylinder', position: [-3.5, 1.8, 0.4], size: [1.2, 1.2, 0.8], color: '#929c90' },
    ],
    actors: [
      { id: 'walker', name: '走入庭院的人', shape: 'human', color: '#d9a269', keys: [
        { time: 0, position: [-2, -3, 0] }, { time: 4, position: [0, 0, 0] }, { time: 8, position: [2, 1, 0] },
      ] },
      { id: 'friend', name: '等候的朋友', shape: 'human', color: '#789bb6', keys: [
        { time: 0, position: [3, 1.3, 0], yaw: 90 }, { time: 8, position: [3, 1.3, 0], yaw: 90 },
      ] },
    ],
    camera: { lens: 32, keys: [
      { time: 0, position: [-5, -6, 2.6], target: [-1, -1, 1] },
      { time: 4, position: [-2.5, -4.5, 2.4], target: [1, 1, 1] },
      { time: 8, position: [0, -3.5, 2.2], target: [2.6, 1.3, 1.1] },
    ] },
    beats: [{ time: 0, label: '人物进入庭院' }, { time: 4, label: '转向等候的朋友' }, { time: 8, label: '两人同框收束' }],
  };
}
export function previsDraftMessages(story, { duration = 8, fps = 24, ratio = '16:9', resolution = 360 } = {}) {
  return [{ role: 'system', content: `你是镜头预演导演。将故事转换为 Blender 白模的 scene_spec，只输出一个完整 JSON 对象，不输出 Python、Markdown 或解释。\n坐标为米，Z 向上，地面中心为原点。活动主体 position 为脚底位置，静态道具 position 为中心；yaw 为绕 Z 轴角度，人物面向 +Y。几何体只是空间和运镜代理，不生成精细人物或材质。\n严格沿用示例字段，不增加字段。objects 形状为 box/sphere/cylinder；actors 可用 human/box/sphere/cylinder。名字可用中文，id 使用唯一英文字符。color 为 #RRGGBB。\n每条人物和摄影机路线至少两个关键点，时间严格递增，首点 time=0，末点 time=duration。摄影机每点都有 position 和 target，不能重合。主体可选 yaw、size、interpolation，摄影机可选 interpolation=linear/smooth、lens=15到120。interpolation 只能放在 actors 的人物对象或 camera 对象上，不能放在 keys 的单个关键点里。人物关键点只允许 time、position、yaw；摄影机关键点只允许 time、position、target。\n最多 ${PREVIS_LIMITS.objects} 个道具、${PREVIS_LIMITS.actors} 个主体，每条路线最多 ${PREVIS_LIMITS.keys} 个点。保持路线避开墙和道具；使用地面、墙、盒子和圆柱安排不同故事空间。输出将先供用户检查和修改，之后才会本机渲染。\n结构示例：\n${JSON.stringify(defaultPrevisSpec())}` },
    { role: 'user', content: `故事和镜头要求：\n${story}\n\n必须使用：duration=${duration} 秒，fps=${fps}，ratio=${ratio}，resolution=${resolution}。一镜到底，无切镜；设计明确的开场、揭示和结尾构图。` }];
}
