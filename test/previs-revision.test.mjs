import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPrevisSpec } from '../public/previs-spec.js';
import { parsePrevisRevision, previsChanges, previsEditorSignature, previsRevisionMessages } from '../public/previs-revision.js';

test('预演对话每轮携带当前场景与反馈，旧失败消息不进入下一轮请求', () => {
  const spec = defaultPrevisSpec(); spec.name = '正在编辑的庭院';
  const messages = previsRevisionMessages({ story: '保留最后两人同框', spec,
    history: [{ role: 'user', content: '镜头太快' }, { role: 'assistant', content: '可以放慢中段。' },
      { role: 'user', content: '上次失败的发送', failed: true }],
    feedback: '第 3–5 秒人物被桌子挡住，让他从左边绕过。', source: '第一次预演' });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /没有视频或图片/);
  assert.deepEqual(messages.slice(1, 3).map(item => item.role), ['user', 'assistant']);
  assert.doesNotMatch(JSON.stringify(messages), /上次失败的发送/);
  assert.match(messages.at(-1).content, /正在编辑的庭院/);
  assert.match(messages.at(-1).content, /第 3–5 秒人物被桌子挡住/);
  assert.match(messages.at(-1).content, /保留最后两人同框/);
});

test('模型结构化修订先校验；讨论回复或无效 JSON 不会生成可应用方案', () => {
  const spec = defaultPrevisSpec(); spec.camera.lens = 45;
  const accepted = parsePrevisRevision(JSON.stringify({ reply: '放慢镜头，拉近焦距。', scene_spec: spec }));
  assert.equal(accepted.error, ''); assert.equal(accepted.spec.camera.lens, 45);
  const discussion = parsePrevisRevision(JSON.stringify({ reply: '可以先调整镜头注视点。', scene_spec: null }));
  assert.equal(discussion.spec, null); assert.equal(discussion.error, '');
  assert.equal(parsePrevisRevision('建议先看第 4 秒的构图。').error, '');
  const invalid = structuredClone(spec); invalid.script = 'bpy.ops.wm.read_factory_settings()';
  const rejected = parsePrevisRevision(JSON.stringify({ reply: '已完成。', scene_spec: invalid }));
  assert.equal(rejected.spec, null); assert.match(rejected.error, /不支持的字段/);
  assert.equal(rejected.reply, '已完成。');
});

test('待应用方案绑定当前编辑，改动列表反映实际路线而非模型自述', () => {
  const original = defaultPrevisSpec(), next = structuredClone(original);
  next.camera.lens = 50; next.camera.keys[1].position[0] += 1; next.actors[0].keys[1].position[1] += 1;
  const signature = previsEditorSignature(JSON.stringify(original), '开场保留');
  assert.equal(signature, previsEditorSignature(JSON.stringify(original, null, 2), '开场保留'));
  assert.notEqual(signature, previsEditorSignature(JSON.stringify(next), '开场保留'));
  assert.notEqual(signature, previsEditorSignature(JSON.stringify(original), '更改了故事'));
  assert.match(previsChanges(original, next).join('；'), /摄影机焦距/);
  assert.match(previsChanges(original, next).join('；'), /摄影机路线或注视点/);
  assert.match(previsChanges(original, next).join('；'), /修改主体/);
});


test('JSON 语法错误与字段错误可直接带入聊天修复，不阻断发送', () => {
  for (const raw of ['{"name":"未闭合的场景",', JSON.stringify({ ...defaultPrevisSpec(), script: 'unsupported' })]) {
    const messages = previsRevisionMessages({ sceneJson: raw, story: '街道相遇', feedback: '请保留故事并修复 JSON' });
    assert.ok(messages.at(-1).content.includes(raw));
    assert.match(messages.at(-1).content, /当前检查错误/);
    assert.match(messages.at(-1).content, /修复 JSON/);
  }
});

test('新故事使用预演参数；失败方案原文与错误进入下一轮，待回复消息排除', () => {
  const raw = JSON.stringify({ reply: '已修改', scene_spec: { ...defaultPrevisSpec(), unsupported: '原始错误数据' } });
  const messages = previsRevisionMessages({ sceneJson: JSON.stringify(defaultPrevisSpec()), isNewScene: true,
    preferences: { duration: 12, fps: 24, ratio: '9:16', resolution: 540 }, feedback: '请修复上次方案',
    history: [{ role: 'assistant', content: '已修改', raw, validationError: '场景包含不支持的字段' },
      { role: 'user', content: '仍在等待的请求', pending: true }] });
  assert.match(messages.at(-1).content, /尚未建立场景/);
  assert.match(messages.at(-1).content, /"duration":12/);
  assert.match(messages[1].content, /原始错误数据/);
  assert.match(messages[1].content, /场景包含不支持的字段/);
  assert.doesNotMatch(JSON.stringify(messages), /仍在等待的请求/);
});

test('无效编辑的待应用方案同时绑定预演参数', () => {
  const raw = '{"broken":';
  const a = { duration: 8, fps: 24, ratio: '16:9', resolution: 360 };
  assert.notEqual(previsEditorSignature(raw, '', a), previsEditorSignature(raw, '', { ...a, duration: 10 }));
  assert.equal(previsEditorSignature(raw, '', a), previsEditorSignature(raw, '', { ...a }));
});
