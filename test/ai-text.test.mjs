import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_MODES, buildAiMessages, normalizeAiConfig, parseAiResponse } from '../public/ai-text.js';
import { validateGraph } from '../lib/workflow.mjs';

test('AI 创作配置限制字段，并保留结构化分镜草稿', () => {
  const config = normalizeAiConfig({ mode: 'storyboard', model: 'model-a', instruction: '  拆成镜头  ', scenes: [
    { title: '开场', visual: '夜晚街道', videoPrompt: '镜头缓慢推进', duration: 6 },
  ] });
  assert.equal(config.mode, 'storyboard');
  assert.equal(config.instruction, '拆成镜头');
  assert.equal(config.scenes[0].description, '夜晚街道');
  assert.equal(config.scenes[0].videoPrompt, '镜头缓慢推进');
});

test('AI 请求将上游文字和任务放进独立消息，不把结果直接提交媒体平台', () => {
  const messages = buildAiMessages({ mode: 'optimize-video', instruction: '补充运镜', inputs: [{ label: '人物设定', text: '穿红色外套的女孩' }] });
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /补充运镜/);
  assert.match(messages[1].content, /穿红色外套的女孩/);
  assert.ok(AI_MODES.some(mode => mode.id === 'storyboard'));
});

test('结构化分镜响应可转换为可创建镜头的草稿，普通回复保持原文', () => {
  const result = parseAiResponse('storyboard', '```json\n{"title":"夜行","scenes":[{"title":"开场","description":"雨夜街道","imagePrompt":"雨夜电影感","videoPrompt":"镜头向前推进","duration":5}]}\n```');
  assert.equal(result.scenes.length, 1);
  assert.equal(result.scenes[0].title, '开场');
  assert.match(result.output, /雨夜街道/);
  const plain = parseAiResponse('free', '保留这段创作结果');
  assert.equal(plain.output, '保留这段创作结果');
});

test('画布支持 AI 创作节点连接到视频卡片并持久化配置', () => {
  const graph = validateGraph({
    nodes: [
      { id: 'ai', kind: 'ai', label: 'AI 创作', aiConfig: { mode: 'storyboard', output: '方案' } },
      { id: 'video', kind: 'video', label: '镜头', sceneId: 'scene-1' },
    ],
    links: [{ id: 'link', from: 'ai', to: 'video' }],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
  assert.equal(graph.nodes[0].kind, 'ai');
  assert.equal(graph.nodes[0].aiConfig.mode, 'storyboard');
  assert.equal(graph.links[0].from, 'ai');
});
