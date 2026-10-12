import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createStudio } from '../server.mjs';
import { buildVideoRequest, submitVideo, pollVideo, LEGACY_PLATFORM as PLATFORM, LEGACY_CONNECTION as DEFAULT_CONNECTION, LEGACY_VIDEO_REQUEST_MODE as VIDEO_REQUEST_MODE } from '../lib/providers.mjs';
import { verifyPublicReferenceUrls } from '../lib/media.mjs';
import { referenceCapabilities, publicReferenceUrlIssue, referenceRequestIssue } from '../public/reference-api.js';
import { resolveSceneReferences } from '../public/reference-model.js';

const model = { name: 'sd-2.0-J2', description: '9图片 3视频 3音频', defaultDuration: 5,
  defaultResolution: '720p', ratios: ['16:9', '9:16', '1:1'], tiers: [{ duration: 5, resolution: '720p', price: 1.9 }] };
const references = [
  { assetId: 'img-1', kind: 'image', publicUrl: 'https://media.example.org/character.png?signature=keep', note: '人物外观' },
  { assetId: 'vid-1', kind: 'video', publicUrl: 'https://media.example.org/motion.mp4', note: '动作' },
  { assetId: 'img-2', kind: 'image', publicUrl: 'https://media.example.org/scene.png', note: '场景' },
  { assetId: 'vid-2', kind: 'video', publicUrl: 'https://media.example.org/camera.mp4', note: '运镜' },
];
const job = { model: model.name, prompt: '让@图片1在@图片2的场景中参考@视频1的动作和@视频2的运镜。',
  duration: 5, resolution: '720p', ratio: '9:16', requestMode: VIDEO_REQUEST_MODE,
  providerDefaults: { duration: 5, resolution: '720p' }, providerRatios: model.ratios,
  referenceSupport: referenceCapabilities(model), references };
const settings = { ...DEFAULT_CONNECTION, apiKey: 'test-reference-secret' };
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

test('模型参考能力来自明确数量；文档混合示例不能覆盖当前目录的不参考视频说明', () => {
  assert.deepEqual(referenceCapabilities(model), { imageLimit: 9, videoLimit: 3, videoDurationRequired: false });
  assert.equal(referenceCapabilities({ description: '最多支持9张图3视频3音频' }).videoLimit, 3);
  assert.equal(referenceCapabilities({ description: '30图10视频 10音频' }).imageLimit, 30);
  assert.equal(referenceCapabilities({ description: '最多7图' }).imageLimit, 7);
  const unsupported = { name: 'seedance-2.5-301010', description: '最多支持30张图10个音频,不参考视频，请注意' };
  assert.match(referenceRequestIssue(unsupported, references), /不支持参考视频/);
  assert.match(referenceRequestIssue({ description: '9图3视频，视频需要传视频duration_seconds' }, references), /时长/);
  assert.match(referenceRequestIssue(model, [...references, ...Array(2).fill(references[1])]), /最多支持 3 段/);
  assert.equal(referenceRequestIssue(model, [{ assetId: 'img-1', kind: 'image' }], { allowLocalUpload: true }), '');
  assert.match(referenceRequestIssue(model, [{ assetId: 'img-1', kind: 'image', publicUrl: 'http://cdn.example.org/a.png' }], { allowLocalUpload: true }), /HTTPS/);
  assert.equal(referenceRequestIssue(model, references), '');
});

test('两图两视频按类别编号发出一次 JSON POST，签名链接与用途保留，无本机路径或未知参数', async () => {
  let posts = 0;
  await submitVideo(settings, job, undefined, async (url, options) => {
    posts++; assert.equal(url, PLATFORM + '/v1/video/generations'); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body).sort(), ['model','prompt','duration','resolution','ratio','images','videos'].sort());
    assert.deepEqual(body.images, [{ url: references[0].publicUrl, name: '图片1' }, { url: references[2].publicUrl, name: '图片2' }]);
    assert.deepEqual(body.videos, [{ url: references[1].publicUrl, name: '视频1' }, { url: references[3].publicUrl, name: '视频2' }]);
    assert.equal(body.ratio, '9:16'); assert.match(body.prompt, /@图片1：人物外观/); assert.match(body.prompt, /@视频2：运镜/);
    assert.equal(body.prompt.startsWith(job.prompt), true);
    assert.doesNotMatch(options.body, /assetId|media\/assets|reference_images|reference_videos|duration_seconds|referenceSupport/);
    return response({ id: 'mixed-task', status: 'queued' });
  });
  assert.equal(posts, 1);
  const imageOnly = buildVideoRequest({ ...job, references: [references[0]] });
  assert.equal('videos' in imageOnly, false); assert.equal(imageOnly.images.length, 1);
});

test('空链接、内网、Base64、示例链接和包含本站密钥的链接在收费提交前拒绝', async () => {
  for (const value of ['', 'C:\\素材.png', 'data:image/png;base64,AAAA', 'http://cdn.example.org/a.png',
    'https://127.0.0.1/a.png', 'https://0x7f000001/a.png', 'https://localhost/a.png', 'https://10.0.0.2/a.png',
    'https://[::1]/a.png', 'https://user:pass@cdn.example.org/a.png', 'https://example.com/a.png']) {
    assert.ok(publicReferenceUrlIssue(value), value);
  }
  assert.equal(publicReferenceUrlIssue(references[0].publicUrl), '');
  let posts = 0;
  const fetcher = async () => { posts++; return response({ id: 'unexpected' }); };
  await assert.rejects(submitVideo(settings, { ...job, references: [{ ...references[0], publicUrl: '' }] }, undefined, fetcher), /HTTPS/);
  await assert.rejects(submitVideo(settings, { ...job, references: [{ ...references[0], publicUrl: 'https://media.example.org/a.png?k=' + settings.apiKey }] }, undefined, fetcher), /API Key/);
  for (const invalid of [{}, 'not-a-list', false, 1]) {
    await assert.rejects(submitVideo(settings, { ...job, references: invalid }, undefined, fetcher), /清单格式/);
  }
  assert.equal(posts, 0);
  await assert.rejects(verifyPublicReferenceUrls(references, '', async () => [{ address: '192.168.1.2', family: 4 }]), /内网/);
  await assert.rejects(verifyPublicReferenceUrls(references, '', async () => [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }]), /内网/);
  await verifyPublicReferenceUrls(references, '', publicDns);
});

test('图像接管手动参考保留同文件链接，素材更换不继承旧链接', () => {
  const scene = { id: 'shot', references: [{ ...references[0], refId: 'stable-reference' }] };
  const project = { assets: [{ id: 'img-1', name: '原人物', kind: 'image' }, { id: 'new-img', name: '新人物', kind: 'image' }],
    graph: { nodes: [{ id: 'material', kind: 'image', assetId: 'img-1' }, { id: 'shot-card', kind: 'video', sceneId: 'shot' }],
      links: [{ from: 'material', to: 'shot-card' }] } };
  scene.references = resolveSceneReferences(project, scene); assert.equal(scene.references[0].publicUrl, references[0].publicUrl);
  project.graph.nodes[0].assetId = 'new-img';
  const replaced = resolveSceneReferences(project, scene);
  assert.equal(replaced.find(ref => ref.assetId === 'new-img').publicUrl, undefined);
});

test('本地 HTTP 混合生成：先拦截缺链接，保存两图两视频后提交，去重、重启查询及脱敏导出完整贯通', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-mixed-api-'));
  let app, posts = [], gets = 0, checks = 0;
  const config = { root, catalog: [model], tools: { ready: false }, integrations: {
    verifyReferences: async (refs, key) => { checks++; await verifyPublicReferenceUrls(refs, key, publicDns); },
    submit: async (connection, candidate) => submitVideo(connection, candidate, undefined, async (_url, options) => {
      posts.push(JSON.parse(options.body)); return response({ id: 'mixed-task-' + posts.length, status: 'queued' }); }),
    poll: async (connection, id) => pollVideo(connection, id, async () => { gets++; return response({ id, status: 'in_progress', progress: 25 }); }),
  } };
  t.after(async () => { if (app) await app.close(); await rm(root, { recursive: true, force: true }); });
  app = await createStudio(config); let base = await app.start(0);
  let boot = await (await fetch(base + '/api/bootstrap')).json();
  const send = (route, method, data) => fetch(base + route, { method, headers: { 'X-Studio-Token': boot.token, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  await send('/api/settings', 'PUT', { apiKey: settings.apiKey, videoModel: model.name });
  let project = await (await send('/api/projects', 'POST', { brief: { product: '混合接口验证', ratio: '9:16' } })).json();
  project = await (await send('/api/projects/' + project.id + '/plan', 'POST', {})).json();
  let refs = [];
  for (const [index, reference] of references.entries()) {
    const bytes = Buffer.alloc(128); if (reference.kind === 'image') Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); else bytes.write('ftyp',4,'ascii');
    const uploaded = await fetch(base + '/api/projects/' + project.id + '/assets', { method: 'POST',
      headers: { 'X-Studio-Token': boot.token, 'X-File-Name': encodeURIComponent('素材' + index + (reference.kind === 'image' ? '.png' : '.mp4')) }, body: bytes });
    assert.equal(uploaded.status, 201); const saved = await uploaded.json(); project = saved.project;
    refs.push({ ...reference, assetId: saved.asset.id, publicUrl: '' });
  }
  const save = async () => { const saved = await send('/api/projects/' + project.id, 'PATCH', { revision: project.revision, scenes: project.scenes }); assert.equal(saved.status,200); project = await saved.json(); };
  project.scenes[0].references = refs; project.scenes[0].videoPrompt = job.prompt; await save();
  const input = { sceneId: project.scenes[0].id, model: model.name, duration: 5, count: 2, requestMode: VIDEO_REQUEST_MODE, operationId: 'mixed-operation' };
  const rejected = await send('/api/projects/' + project.id + '/batches', 'POST', input);
  assert.equal(rejected.status,400); assert.match((await rejected.json()).error,/HTTPS/); assert.equal(posts.length,0); assert.equal(app.store.state.jobs.length,0);
  project.scenes[0].references.forEach((ref,i) => { ref.publicUrl = references[i].publicUrl; }); await save();
  const submitted = await send('/api/projects/' + project.id + '/batches', 'POST', input);
  assert.equal(submitted.status,202); const batch = await submitted.json(); assert.equal(batch.count,2); assert.equal(batch.totalEstimate,3.8);
  for (const item of batch.jobs) {
    assert.equal(item.referenceCount,4); assert.equal(item.ratio,'9:16');
    assert.equal(JSON.stringify(item).includes('media.example.org'),false);
  }
  for (let n=0;n<100 && posts.length<2;n++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(posts.length,2); assert.equal(posts[0].images.length,2); assert.equal(posts[0].videos.length,2); assert.equal(checks,1);
  const duplicated = await send('/api/projects/' + project.id + '/batches', 'POST', input); assert.equal(duplicated.status,202); assert.equal(posts.length,2);
  const exported = await (await fetch(base + '/api/projects/' + project.id + '/export')).json();
  assert.doesNotMatch(JSON.stringify(exported), /signature=keep|media.example.org|test-reference-secret|publicUrl/);
  await app.close(); app = null; app = await createStudio(config); base = await app.start(0);
  boot = await (await fetch(base + '/api/bootstrap')).json();
  for (const record of app.store.state.jobs) record.nextPollAt = new Date(0).toISOString();
  await app.jobs.tick();
  for (let n=0;n<100 && app.jobs.busy.size;n++) await new Promise(resolve=>setTimeout(resolve,5));
  const recovered = await (await fetch(base + '/api/projects/' + project.id)).json();
  assert.deepEqual(recovered.scenes[0].references.map(x=>x.publicUrl),references.map(x=>x.publicUrl));
  assert.equal(posts.length,2); assert.ok(gets>=2); assert.equal(boot.settings.referenceGenerationReady,true);
  assert.doesNotMatch(JSON.stringify(boot), /test-reference-secret/);
});
