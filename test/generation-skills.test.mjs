import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server.mjs';
import { createProject, exportProject, importProject, normalizeScenes } from '../lib/workflow.mjs';
import { DEFAULT_CONNECTION, catalogForVideoModelIds } from '../lib/video-v3.mjs';
import { DEFAULT_IMAGE_CONNECTION } from '../lib/image-provider.mjs';
import { normalizeImageConfig } from '../public/image-parameters.js';
import { generationSkillText, generationSkillPrompt, generationSkillIssue, generationSkillControl } from '../public/skills.js';
import { videoModelFixture } from './fixtures/video-models.mjs';

const imageModel = 'gpt-image-2.5-flare';
const videoModel = 'seedance-2.0-fast-933-720P（次）';
const catalog = catalogForVideoModelIds([videoModelFixture(videoModel)]);
const files = [
  { path: 'film/SKILL.md', content: '---\nname: 电影广告\ndescription: 统一人物、光线和运镜。\nallowed-tools: [python]\n---\n\n使用柔和侧光，保持人物外观一致。' },
  { path: 'film/references/style.md', content: '低饱和暖色，镜头缓慢推进。' },
  { path: 'film/scripts/run.py', content: 'never-execute-this-script' },
];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const waitFor = async (read, predicate) => {
  for (let i = 0; i < 200; i++) {
    const value = await read(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('Mock generation did not reach the expected state');
};

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-generation-skills-'));
  const imageCalls = [], videoCalls = [];
  const app = await createStudio({ root, catalog, imageCatalog: [{ name: imageModel }], textCatalog: [], tools: { ready: false },
    imageIntegrations: { submitImage: async (_settings, request) => {
      imageCalls.push(structuredClone(request)); return { kind: 'base64', data: png, mime: 'image/png' };
    } },
    integrations: { submit: async (_settings, job) => {
      videoCalls.push(structuredClone(job)); return { taskId: 'mock-' + job.id, state: 'queued', providerStatus: 'queued' };
    }, poll: async () => ({ state: 'queued', providerStatus: 'queued' }) },
  });
  await app.store.saveSettings({ ...DEFAULT_CONNECTION, apiKey: 'fixture-video-key', videoModel });
  await app.store.saveImageSettings({ ...DEFAULT_IMAGE_CONNECTION, apiKey: 'fixture-image-key', imageModel });
  const url = await app.start(0);
  const send = async (route, method = 'GET', body, expected = 200) => {
    const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json', 'X-Studio-Token': app.token },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  };
  const [skill] = await send('/api/skills/import', 'POST', { files }, 201);
  let project = await send('/api/projects', 'POST', { title: '生成技能测试' }, 201);
  project = await send(`/api/projects/${project.id}`, 'PATCH', { revision: project.revision,
    scenes: [{ id: 'clip', title: '原创人物', imagePrompt: '人物站在窗边', videoPrompt: '人物走向窗边', videoModel, videoSkillId: skill.id,
      imageSkillId: skill.id, generationDuration: 5, resolution: '720p', ratio: '16:9' }],
    graph: { nodes: [{ id: 'image-card', kind: 'image', role: 'image-generation', label: '图片', x: 80, y: 100,
      imageConfig: { model: imageModel, prompt: '人物坐在书桌前', skillId: skill.id } }], links: [], viewport: { x: 0, y: 0, zoom: 1 } },
  });
  const imageInput = { sceneId: 'clip', model: imageModel, prompt: project.scenes[0].imagePrompt, skillId: skill.id, operationId: 'image-operation' };
  const videoInput = { sceneId: 'clip', model: videoModel, skillId: skill.id, duration: 5, resolution: '720p', ratio: '16:9',
    requestMode: catalog[0].requestMode, operationId: 'video-operation' };
  t.after(async () => { await app.close(); assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true }); });
  return { app, root, send, project, skill, imageCalls, videoCalls, imageInput, videoInput,
    waitImages: () => waitFor(() => send(`/api/projects/${project.id}/image-jobs`), jobs => jobs.length && jobs.every(job => job.state === 'done')),
    waitVideos: () => waitFor(() => videoCalls, calls => calls.length > 0),
  };
}

test('生成技能组合完整文字资料，附件不注入；超限拒绝且不截断', () => {
  const skill = { name: '电影', content: '柔和光线', references: [{ path: 'style.md', content: '保持角色一致' }], attachments: [{ content: 'do-not-send' }] };
  assert.equal(generationSkillPrompt('原提示词', null), '原提示词');
  const prompt = generationSkillPrompt('人物行走', skill, 'video');
  assert.match(prompt, /技能：电影/); assert.match(prompt, /参考资料：style.md\n保持角色一致/);
  assert.ok(prompt.endsWith('本次视频生成要求：\n人物行走')); assert.doesNotMatch(prompt, /do-not-send/);
  const summary = { id: 'film', name: '<img onerror=alert(1)>', generationCharacters: generationSkillText(skill).length };
  assert.match(generationSkillControl([summary], summary.id, { field: 'data-image-field="skillId"' }), /&lt;img/);
  assert.match(generationSkillIssue([], 'missing'), /已删除/);
  assert.match(generationSkillIssue([summary], 'film', '字'.repeat(4000)), /4000/);
  assert.throws(() => generationSkillPrompt('字'.repeat(4000), skill), /4000/);
});

test('图片卡及视频项的技能选择经工程导入导出保留', () => {
  const project = createProject();
  project.scenes = normalizeScenes([{ id: 'clip', videoSkillId: 'video-skill', imageSkillId: 'scene-image-skill' }]);
  project.graph.nodes = [{ id: 'image', kind: 'image', role: 'image-generation', imageConfig: normalizeImageConfig({ skillId: 'image-skill' }) }];
  const restored = importProject(exportProject(project));
  assert.equal(restored.graph.nodes[0].imageConfig.skillId, 'image-skill');
  assert.equal(restored.scenes[0].videoSkillId, 'video-skill'); assert.equal(restored.scenes[0].imageSkillId, 'scene-image-skill');
});

test('HTTP 图片生成向实际提交注入规则，批量使用同一快照且正确关联原视频项', async t => {
  const f = await fixture(t);
  const batch = await f.send(`/api/projects/${f.project.id}/image-batches`, 'POST', { ...f.imageInput, count: 2 }, 202);
  const jobs = await f.waitImages();
  assert.equal(f.imageCalls.length, 2); assert.equal(batch.count, 2);
  for (const call of f.imageCalls) { assert.match(call.prompt, /柔和侧光/); assert.match(call.prompt, /低饱和暖色/); assert.doesNotMatch(call.prompt, /never-execute/); }
  assert.equal(jobs[0].prompt, jobs[1].prompt); assert.equal(jobs[0].skillId, f.skill.id); assert.equal(jobs[0].skillName, '电影广告');
  assert.equal(jobs[0].sourcePrompt, f.imageInput.prompt);
  const project = await f.send(`/api/projects/${f.project.id}`);
  assert.ok(project.scenes[0].imageAssetId);
  assert.equal(project.scenes[0].imagePrompt, f.imageInput.prompt);
});

test('HTTP 画布图片卡按保存的技能生成并核对 expectedConfig', async t => {
  const f = await fixture(t), node = f.project.graph.nodes[0];
  const job = await f.send(`/api/projects/${f.project.id}/image-jobs`, 'POST', { nodeId: node.id, expectedConfig: node.imageConfig, operationId: 'canvas-image' }, 202);
  await f.waitImages();
  assert.equal(job.config.skillId, f.skill.id); assert.match(f.imageCalls[0].prompt, /人物坐在书桌前/); assert.match(f.imageCalls[0].prompt, /低饱和暖色/);
  const project = await f.send(`/api/projects/${f.project.id}`);
  assert.equal(project.graph.nodes[0].imageConfig.skillId, f.skill.id); assert.ok(project.graph.nodes[0].assetId);
});

test('HTTP 视频按视频项技能注入规则并保持原始提示词可编辑', async t => {
  const f = await fixture(t);
  const job = await f.send(`/api/projects/${f.project.id}/jobs`, 'POST', f.videoInput, 202);
  await f.waitVideos();
  assert.match(f.videoCalls[0].prompt, /柔和侧光/); assert.match(f.videoCalls[0].prompt, /低饱和暖色/);
  assert.doesNotMatch(f.videoCalls[0].prompt, /never-execute/); assert.ok(f.videoCalls[0].prompt.endsWith('人物走向窗边'));
  assert.equal(job.skillId, f.skill.id); assert.equal(job.skillName, f.skill.name);
  const project = await f.send(`/api/projects/${f.project.id}`); assert.equal(project.scenes[0].videoPrompt, '人物走向窗边');
  assert.equal(f.app.store.state.jobs[0].sourcePrompt, '人物走向窗边');
});

test('已删除或缺失技能在图片、视频计费调用前拒绝，恢复后可用', async t => {
  const f = await fixture(t);
  await f.send(`/api/skills/${f.skill.id}`, 'DELETE');
  const imageError = await f.send(`/api/projects/${f.project.id}/image-jobs`, 'POST', f.imageInput, 404);
  const videoError = await f.send(`/api/projects/${f.project.id}/jobs`, 'POST', f.videoInput, 404);
  assert.match(imageError.error, /技能/); assert.match(videoError.error, /技能/);
  await f.send(`/api/projects/${f.project.id}/image-jobs`, 'POST', { ...f.imageInput, skillId: 'missing' }, 404);
  assert.equal(f.imageCalls.length, 0); assert.equal(f.videoCalls.length, 0);
  assert.equal(f.app.store.state.jobs.length, 0); assert.equal(f.app.store.state.imageJobs.length, 0);
  await f.send(`/api/skills/${f.skill.id}/restore`, 'POST', {});
  await f.send(`/api/projects/${f.project.id}/image-jobs`, 'POST', f.imageInput, 202); await f.waitImages();
  assert.equal(f.imageCalls.length, 1);
});

test('图片和视频重试原操作在技能编辑、删除后继续返回原快照，避免重复提交', async t => {
  const f = await fixture(t);
  const image = await f.send(`/api/projects/${f.project.id}/image-jobs`, 'POST', f.imageInput, 202); await f.waitImages();
  const video = await f.send(`/api/projects/${f.project.id}/jobs`, 'POST', f.videoInput, 202); await f.waitVideos();
  await f.send(`/api/skills/${f.skill.id}`, 'PUT', { content: '已修改的新规则' });
  await f.send(`/api/skills/${f.skill.id}`, 'DELETE');
  const replayImage = await f.send(`/api/projects/${f.project.id}/image-jobs`, 'POST', f.imageInput, 202);
  const replayVideo = await f.send(`/api/projects/${f.project.id}/jobs`, 'POST', f.videoInput, 202);
  assert.equal(replayImage.id, image.id); assert.equal(replayVideo.id, video.id);
  assert.match(replayImage.prompt, /柔和侧光/); assert.doesNotMatch(replayImage.prompt, /已修改/);
  assert.equal(f.imageCalls.length, 1); assert.equal(f.videoCalls.length, 1);
  assert.match(f.app.store.state.jobs[0].prompt, /柔和侧光/);
});

test('技能合并超限时图片与视频都在生成前拒绝，列表仍可读取', async t => {
  const f = await fixture(t);
  await f.send(`/api/skills/${f.skill.id}`, 'PUT', { content: '规则'.repeat(2100) });
  const skills = await f.send('/api/skills'); assert.ok(skills[0].generationCharacters > 4000);
  const image = await f.send(`/api/projects/${f.project.id}/image-jobs`, 'POST', f.imageInput, 400);
  const video = await f.send(`/api/projects/${f.project.id}/jobs`, 'POST', f.videoInput, 400);
  assert.match(image.error, /4000/); assert.match(video.error, /4000/);
  assert.equal(f.imageCalls.length, 0); assert.equal(f.videoCalls.length, 0);
});

test('取消图片和视频技能后只发送本次提示词，保持原有生成路径', async t => {
  const f = await fixture(t);
  const project = await f.send(`/api/projects/${f.project.id}`, 'PATCH', { revision: f.project.revision,
    scenes: f.project.scenes.map(scene => ({ ...scene, videoSkillId: '', imageSkillId: '' })) });
  assert.equal(project.scenes[0].videoSkillId, '');
  await f.send(`/api/projects/${f.project.id}/image-jobs`, 'POST', { ...f.imageInput, skillId: '' }, 202); await f.waitImages();
  await f.send(`/api/projects/${f.project.id}/jobs`, 'POST', { ...f.videoInput, skillId: '' }, 202); await f.waitVideos();
  assert.equal(f.imageCalls[0].prompt, f.imageInput.prompt); assert.equal(f.videoCalls[0].prompt, '人物走向窗边');
});
