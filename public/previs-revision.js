import { defaultPrevisSpec, normalizePrevisSpec, parsePrevisSpec, PREVIS_LIMITS } from './previs-spec.js';

// Only scene data crosses this boundary. Replies can never supply executable Blender code.
export function previsRevisionMessages({ story = '', spec, sceneJson, editorJson, history = [], feedback, source = '', preferences, isNewScene = false }) {
  const raw = typeof sceneJson === 'string' ? sceneJson : JSON.stringify(spec ?? null);
  let current = null, validationError = '';
  try { current = typeof sceneJson === 'string' ? parsePrevisSpec(sceneJson) : normalizePrevisSpec(spec); }
  catch (error) { validationError = error.message; }
  const editorContext = [];
  if (typeof editorJson === 'string' && editorJson !== raw) {
    editorContext.push(`当前编辑框原文（待确认方案尚未应用）：\n${editorJson}`);
    try { parsePrevisSpec(editorJson); }
    catch (error) { editorContext.push(`编辑框检查错误：${error.message}`); }
  }
  const messages = [{ role: 'system', content: [
    '你是幻帧 MiraFrame Blender 镜头预演中的中文导演助手，在同一个聊天中帮助用户整理故事、创建白模场景、讨论预演和修复场景 JSON。',
    '用户可能提供一个新故事、询问原因、讨论方案或要求修改。新故事需要整理成完整场景；仅讨论时解释清楚；要求修改或修复时在本轮提供完整可用的场景。',
    '以最后一条消息中的当前编辑、待确认方案和检查错误为准。历史仅供理解对话，不代表旧方案已应用；尊重用户手动编辑、恢复版本和已经满意的部分，未要求变更的字段与对象 id 尽量保留。',
    '当前 JSON 可能语法错误或字段不合规范。这不会阻止对话：结合原始 JSON、检查错误、故事和历史修复，返回完整 scene_spec。上一轮模型方案未通过检查时，也要结合保留的原始回复修复，不能声称该方案已应用。',
    '同时给出编辑框原文和待确认方案时，可继续完善待确认方案；用户询问检查错误时，应根据编辑框原文解释，不要把未应用的方案当成编辑框现状。',
    '尚未建立场景时，示例仅提供字段结构，不代表用户选择了庭院故事；按用户本轮描述创建场景。',
    '输入只有场景数据和文字反馈，没有视频或图片。不要声称已经观看预演；空间、遮挡和构图的判断应说明来自配置或用户描述。',
    '只输出一个 JSON 对象：{"reply":"面向用户的中文回复，说明整理或修改了什么、为什么以及需要看哪一段","scene_spec":完整场景对象或null}。仅讨论、不修改时 scene_spec 为 null。不要输出 Python、脚本、代码补丁或额外字段。',
    'scene_spec 严格使用下方示例字段。坐标单位米，Z 向上，地面中心为原点；活动主体位置为脚底，静态道具位置为中心。yaw 为绕 Z 轴角度，人物面向 +Y。',
    '场景是简单几何白模，只支持位置、朝向、路线、道具尺寸、颜色、固定焦距和动作节拍；不支持精细人物、骨骼动作、表情、动态焦距或剪辑。超出能力的要求请解释并给出可用的预演近似，不得伪造字段。',
    `最多 ${PREVIS_LIMITS.objects} 个道具、${PREVIS_LIMITS.actors} 个主体，每条路线 2–${PREVIS_LIMITS.keys} 个关键点。objects.shape=box/sphere/cylinder，actors.shape=human/box/sphere/cylinder；id 唯一且仅用英文字母、数字、下划线、短横线；color=#RRGGBB。`,
    '每条路线首点 time=0，末点 time=duration，中间时间严格递增且不能落在同一帧；摄影机每点都有 position 和 target 且两者不能重合。interpolation=linear/smooth 只能放在 actors 的人物对象或 camera 对象上，不能放在 keys 的单个关键点里。人物关键点只允许 time、position、yaw；摄影机关键点只允许 time、position、target。摄影机 lens=15–120。',
    'duration=1–30 秒且 duration*fps 为整数；fps=12/24/25/30，ratio=16:9/9:16/1:1，resolution=360/540/720；world.size 是两个数值，position/target/size 是三个数值。新场景使用用户选择的预演参数；本轮明确要求调整时按新要求处理，并同步所有路线和节拍。',
    '检查路线避开墙和道具、主体与镜头注视点协调。方案要先由用户应用，之后才会开始新预演，不要声称已渲染或已修改原视频。',
    `结构示例：${JSON.stringify(defaultPrevisSpec())}`,
  ].join('\n') }];
  for (const item of history.filter(item => item && ['user', 'assistant', 'context'].includes(item.role)
    && typeof item.content === 'string' && item.content.trim() && !item.failed && !item.pending).slice(-20)) {
    messages.push({ role: item.role === 'context' ? 'user' : item.role,
      content: item.role === 'context' ? `【编辑状态变化】${item.content}`
        : item.content + (item.raw ? `\n\n上一轮未通过检查的原始回复（尚未应用）：\n${item.raw}\n检查错误：${item.validationError || '场景格式需要修复'}` : '') });
  }
  messages.push({ role: 'user', content: [
    story.trim() ? `故事和镜头要求：\n${story.trim()}` : '',
    source ? `当前修改起点：${source}` : '',
    isNewScene ? '当前尚未建立场景，请将故事整理为新的场景；下方配置仅作格式参考。' : '',
    preferences ? `用户选择的预演参数：${JSON.stringify(preferences)}` : '',
    current ? `当前场景（本轮请以此为准）：\n${JSON.stringify(current)}`
      : `当前场景 JSON（未通过检查，请结合故事修复）：\n${raw}\n\n当前检查错误：${validationError}`,
    ...editorContext,
    `本轮问题或修改要求：\n${String(feedback).trim()}`,
  ].filter(Boolean).join('\n\n') });
  return messages;
}

export function parsePrevisRevision(content) {
  const raw = String(content || '').trim();
  if (!raw) return { reply: '', spec: null, error: '模型没有返回文字，请检查语言模型连接。', raw };
  let value;
  try { value = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch {
    return { reply: raw, spec: null, error: /^[{\[]|^```/.test(raw)
      ? '回复未包含可校验的场景方案。可以继续说明要求，请模型给出完整修订方案。' : '', raw };
  }
  const reply = typeof value?.reply === 'string' ? value.reply.trim() : '';
  if (value?.scene_spec === null && reply) return { reply, spec: null, error: '', raw };
  try {
    const spec = normalizePrevisSpec(value?.schemaVersion === 1 ? value : value?.scene_spec);
    return { reply: reply || '已整理修订方案。请查看下方改动，确认后应用到场景。', spec, error: '', raw };
  } catch (error) {
    return { reply: reply || '模型返回的场景还需要修正。', spec: null,
      error: `场景检查未通过：${error.message} 当前场景保持原样，可继续对话修正。`, raw };
  }
}

export function previsEditorSignature(json, story = '', preferences) {
  let scene;
  try { scene = parsePrevisSpec(json); } catch { scene = String(json); }
  return JSON.stringify(preferences ? [scene, String(story).trim(), preferences] : [scene, String(story).trim()]);
}

export function previsChanges(before, after) {
  const a = normalizePrevisSpec(before), b = normalizePrevisSpec(after), changes = [];
  for (const [key, label, unit] of [['name', '场景名称', ''], ['duration', '时长', ' 秒'], ['fps', '帧率', ' fps'],
    ['ratio', '画面比例', ''], ['resolution', '预演短边', ' px']]) {
    if (a[key] !== b[key]) changes.push(`${label}：${a[key]}${unit} → ${b[key]}${unit}`);
  }
  const different = (x, y) => JSON.stringify(x) !== JSON.stringify(y);
  if (different(a.world, b.world)) changes.push('调整地面尺寸或颜色');
  if (a.camera.lens !== b.camera.lens) changes.push(`摄影机焦距：${a.camera.lens} mm → ${b.camera.lens} mm`);
  if (different(a.camera.keys, b.camera.keys)) changes.push(`调整摄影机路线或注视点（${a.camera.keys.length} → ${b.camera.keys.length} 个关键点）`);
  if (a.camera.interpolation !== b.camera.interpolation) changes.push(`摄影机运动：${b.camera.interpolation === 'linear' ? '匀速插值' : '平滑插值'}`);
  for (const [key, label] of [['actors', '主体'], ['objects', '道具']]) {
    const previous = new Map(a[key].map(item => [item.id, item])), current = new Map(b[key].map(item => [item.id, item]));
    for (const item of b[key]) {
      if (!previous.has(item.id)) changes.push(`新增${label}：${item.name}`);
      else if (different(previous.get(item.id), item)) changes.push(`修改${label}：${item.name}`);
    }
    for (const item of a[key]) if (!current.has(item.id)) changes.push(`移除${label}：${item.name}`);
  }
  if (different(a.beats, b.beats)) changes.push('调整动作节拍');
  return changes.length ? changes : ['场景配置与修改起点相同'];
}
