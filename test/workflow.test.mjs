import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { createProject, draftPlan, defaultGraph, validateGraph, normalizeScenes, updateProject, exportProject, importProject } from '../lib/workflow.mjs';

test('旧工程补齐空分组，新分组保存有效成员并允许卡片属于多个分组', () => {
  const nodes=['a','b','c','d'].map(id=>({id,kind:'text'})), base={nodes,links:[]};
  assert.deepEqual(validateGraph(base).groups,[]);
  const group={id:'group-one',label:'  人物与场景  ',nodeIds:['a','b','a'],privateField:'不保存'};
  assert.deepEqual(validateGraph({...base,groups:[group]}).groups,[{id:'group-one',label:'人物与场景',nodeIds:['a','b']}]);
  for (const groups of [
    {},[null],[{...group,nodeIds:['a']}],[{...group,nodeIds:['a','missing']}],
    [{...group,id:'a'}],[group,group],
  ]) assert.throws(()=>validateGraph({...base,groups}), /分组|分组编号/);
  assert.equal(validateGraph({...base,groups:[group,{id:'group-two',nodeIds:['b','c']}]}).groups.length,2);
  assert.equal(validateGraph({...base,groups:[{...group,label:'名称'.repeat(50)}]}).groups[0].label.length,80);
});

test('本地草案按目标时长生成可编辑分镜，并重置制作状态、保留素材', () => {
  const project = createProject({ brief: { product: '雨夜书店', duration: 30, benefits: '街巷\n旧书店\n翻书' } });
  project.assets.push({ id: 'keep-asset' }); project.graph.nodes.forEach(node => node.status = 'done');
  const planned = draftPlan(project);
  assert.equal(planned.scenes.length, 6); assert.equal(planned.planSource, 'local-draft');
  assert.equal(planned.scenes.reduce((sum, scene) => sum + scene.duration, 0), 30);
  assert.equal(planned.graph.nodes.find(node => node.kind === 'video').status, 'pending');
  assert.equal(planned.assets[0].id, 'keep-asset'); assert.equal(project.scenes.length, 0);
});

test('新建项目从空白画布开始，整理草案时再恢复规划流程卡', () => {
  const project = createProject();
  assert.deepEqual(project.graph.nodes, []);
  assert.deepEqual(project.graph.links, []);
  assert.deepEqual(project.graph.viewport, { x: 0, y: 0, zoom: 1 });
  const planned = draftPlan(createProject({ brief: { product: '主题' } }));
  assert.ok(planned.graph.nodes.some(node => node.kind === 'brief'));
  assert.ok(planned.graph.nodes.some(node => node.kind === 'video'));
});

test('拒绝环路、端口类型冲突及重复编号', () => {
  const graph = defaultGraph();
  assert.throws(() => validateGraph({ ...graph, links: [...graph.links, { from: 'compose', to: 'video' }] }), /循环/);
  assert.throws(() => validateGraph({ ...graph, links: [{ from: 'image', to: 'audio' }] }), /不匹配/);
  assert.throws(() => validateGraph({ ...graph, nodes: [...graph.nodes, graph.nodes[0]] }), /重复/);
  assert.throws(() => normalizeScenes([{ id: 'one' }, { id: 'one' }]), /重复/);
});

test('版本冲突与引用素材检查保护工程', () => {
  const project = createProject();
  assert.throws(() => updateProject(project, { revision: 0, title: 'bad' }), error => error.status === 409);
  assert.throws(() => updateProject(project, { revision: 1, scenes: [{ id: 'one', videoAssetId: 'foreign' }] }), /不存在/);
  assert.throws(() => updateProject(project, { revision: 1, scenes: [{ id: 'one', referenceAssetId: 'foreign' }] }), /不存在/);
  assert.equal(updateProject(project, { revision: 1, title: '保存' }).revision, 2);
});

test('工程导入导出只保留白名单字段，去掉密钥、媒体引用与签名链接', () => {
  const project = draftPlan(createProject({ brief: { product: '主题' } }));
  project.apiKey = 'test-secret'; project.assets = [{ id: 'a', file: 'private.mp4' }];
  project.scenes[0].videoAssetId = 'a'; project.scenes[0].referenceAssetId = 'b';
  project.exports = [{ url: 'https://example.com/private-signed-url' }];
  const document = exportProject(project), restored = importProject({ ...document, apiKey: 'inject', project: { ...document.project, apiKey: 'inject', assets: project.assets } });
  assert.doesNotMatch(JSON.stringify(document), /test-secret|private\.mp4|private-signed-url/);
  assert.equal(restored.assets.length, 0); assert.equal(restored.scenes[0].videoAssetId, '');
  assert.equal(restored.scenes[0].referenceAssetId, ''); assert.equal(restored.apiKey, undefined);
  assert.notEqual(project.id, restored.id);
});

test('多参考准备保留素材顺序和用途，校验项目归属与类型，并兼容原单图工程', () => {
  const project = createProject();
  project.assets = [
    { id: 'image-a', kind: 'image', name: '人物.png' }, { id: 'image-b', kind: 'image', name: '街景.jpg' },
    { id: 'video-a', kind: 'video', name: '运镜.mp4' }, { id: 'video-b', kind: 'video', name: '动作.mp4' },
  ];
  const references = project.assets.map(asset => ({ assetId: asset.id, kind: asset.kind, name: '忽略外来名称', note: `用途 ${asset.id}` }));
  const saved = updateProject(project, { revision: 1, scenes: [{ id: 'one', references }] });
  assert.deepEqual(saved.scenes[0].references.map(item => item.assetId), ['image-a', 'image-b', 'video-a', 'video-b']);
  assert.equal(saved.scenes[0].references[0].name, '人物.png');
  assert.equal(saved.scenes[0].references[3].note, '用途 video-b');
  const legacy = updateProject(project, { revision: 1, scenes: [{ id: 'old', referenceAssetId: 'image-a' }] });
  assert.equal(legacy.scenes[0].references[0].assetId, 'image-a'); assert.equal(legacy.scenes[0].referenceAssetId, '');
  for (const reference of [{ assetId: 'foreign', kind: 'image' }, { assetId: 'image-a', kind: 'video' }]) {
    assert.throws(() => updateProject(project, { revision: 1, scenes: [{ references: [reference] }] }), /不存在|类型不匹配/);
  }
  assert.equal(normalizeScenes([{ references: [{ kind: 'audio' }] }])[0].references[0].kind, 'audio');
  assert.throws(() => normalizeScenes([{ references: [{ kind: 'text' }] }]), /图片、视频和音频/);
  assert.equal(updateProject(project, { revision: 1, scenes: [{ references: [references[0], references[0]] }] }).scenes[0].references.length, 1);
  assert.throws(() => normalizeScenes([{ references: 'bad' }]), /格式/);
  assert.throws(() => updateProject(project, { revision: 1, scenes: [{ references: Array.from({ length: 101 }, () => ({ kind: 'image' })) }] }), /100/);
  assert.equal(project.revision, 1); assert.equal(project.scenes.length, 0);
});

test('多参考导入导出保留文件名称及用途，但清空本机媒体编号并允许重新关联', () => {
  const project = createProject();
  project.assets = [{ id: 'private-image-id', kind: 'image', name: '人物.png' }, { id: 'private-video-id', kind: 'video', name: '动作.mp4' }];
  const saved = updateProject(project, { revision: 1, scenes: [{ id: 'one', videoPrompt: '参考图片1的外观、视频1的动作',
    references: [{ assetId: 'private-image-id', kind: 'image', note: '人物外观' }, { assetId: 'private-video-id', kind: 'video', note: '动作' }] }] });
  const document = exportProject(saved), restored = importProject(document);
  assert.doesNotMatch(JSON.stringify(document), /private-image-id|private-video-id/);
  assert.deepEqual(restored.scenes[0].references.map(({ refId, ...reference }) => reference), [
    { assetId: '', kind: 'image', name: '人物.png', note: '人物外观' },
    { assetId: '', kind: 'video', name: '动作.mp4', note: '动作' },
  ]);
  assert.equal(restored.scenes[0].videoPrompt, saved.scenes[0].videoPrompt);
  assert.deepEqual(restored.scenes[0].references.map(reference => reference.refId), saved.scenes[0].references.map(reference => reference.refId));
  restored.assets.push({ id: 'new-image', kind: 'image', name: '补选人物.png' });
  const scenes = structuredClone(restored.scenes); scenes[0].references[0].assetId = 'new-image';
  assert.equal(updateProject(restored, { revision: restored.revision, scenes }).scenes[0].references[0].name, '补选人物.png');
});


test('旧版画布导入兼容默认视口和卡片尺寸，原流程及编号保持不变', () => {
  const graph = defaultGraph();
  const legacy = { nodes: graph.nodes.map(({ id, kind, label, x, y, status, note }) => ({ id, kind, label, x, y, status, note })), links: graph.links };
  const restored = importProject({ format: 'jingce-project', schemaVersion: 1, project: { title: '旧工程', graph: legacy } });
  assert.deepEqual(restored.graph.viewport, { x: 0, y: 0, zoom: 1 });
  assert.deepEqual(restored.graph.links, legacy.links);
  assert.deepEqual(restored.graph.nodes.map(node => node.id), legacy.nodes.map(node => node.id));
  assert.ok(restored.graph.nodes.every(node => node.width === 320 && node.height === 260 && !node.assetId && !node.sceneId));
  assert.deepEqual(defaultGraph().viewport, { x: 0, y: 0, zoom: 1 });
});

test('自由画布负坐标、卡片尺寸和视口保存后可在存储重启时恢复', async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), 'jingce-canvas-workflow-'));
  try {
    const project = createProject();
    const store = new Store(testRoot); await store.init();
    await store.mutate(state => { state.projects.push(project); return project; });
    const graph = { nodes: [{ id: 'sticky', kind: 'text', x: -450.25, y: -1100, width: 440, height: 350, note: '雨夜，慢速运镜' }],
      links: [], viewport: { x: -320.5, y: 720, zoom: 0.55 } };
    const saved = await store.update(project.id, previous => updateProject(previous, { revision: previous.revision, graph }));
    const restarted = new Store(testRoot); await restarted.init();
    assert.deepEqual(restarted.get(project.id).graph, saved.graph);
    assert.deepEqual(saved.graph.viewport, graph.viewport);
    assert.equal(saved.graph.nodes[0].x, -450.25); assert.equal(saved.graph.nodes[0].width, 440);
    assert.equal(saved.graph.nodes[0].note, '雨夜，慢速运镜');
    assert.equal(project.graph.nodes.length, 0);
  } finally {
    assert.equal(path.dirname(path.resolve(testRoot)), path.resolve(tmpdir()));
    assert.ok(path.basename(testRoot).startsWith('jingce-canvas-workflow-'));
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('画布数值边界受保护，便签仅输出文字且额外字段不进入工程', () => {
  const graph = validateGraph({ nodes: [
    { id: 'note', kind: 'text', x: -Infinity, y: Infinity, width: NaN, height: Infinity, note: '镜头想法', apiKey: 'injected' },
    { id: 'video', kind: 'video', x: -1000005, y: 1000005, width: 30, height: 9000 },
    { id: 'image', kind: 'image', width: 9000, height: 30 },
  ], links: [{ from: 'note', to: 'video' }], viewport: { x: -1000005, y: 1000005, zoom: 99, apiKey: 'injected' } });
  assert.deepEqual(graph.viewport, { x: -1000000, y: 1000000, zoom: 3 });
  assert.equal(graph.nodes[0].x, 60); assert.equal(graph.nodes[0].y, 180);
  assert.equal(graph.nodes[0].width, 320); assert.equal(graph.nodes[0].height, 260);
  assert.equal(graph.nodes[1].x, -1000000); assert.equal(graph.nodes[1].y, 1000000);
  assert.equal(graph.nodes[1].width, 240); assert.equal(graph.nodes[1].height, 900);
  assert.equal(graph.nodes[2].width, 720); assert.equal(graph.nodes[2].height, 180);
  assert.doesNotMatch(JSON.stringify(graph), /injected|apiKey/);
  assert.equal(validateGraph({ ...graph, viewport: { zoom: -1 } }).viewport.zoom, 0.15);
  assert.deepEqual(validateGraph({ ...graph, viewport: { x: Infinity, y: NaN, zoom: Infinity } }).viewport, { x: 0, y: 0, zoom: 1 });
  assert.throws(() => validateGraph({ ...graph, links: [{ from: 'image', to: 'note' }] }), /不匹配/);
});

test('画布媒体和镜头绑定校验工程归属、类型，并使用本工程的素材名称', () => {
  const project = createProject();
  project.assets = [{ id: 'picture', kind: 'image', name: '人物.png' }, { id: 'movie', kind: 'video', name: '雨夜.mp4' }, { id: 'sound', kind: 'audio', name: '旁白.wav' }];
  project.scenes = normalizeScenes([{ id: 'scene-one', title: '雨夜' }]);
  const graph = { nodes: [
    { id: 'picture-node', kind: 'image', assetId: 'picture', assetName: '外部伪造名称' },
    { id: 'movie-node', kind: 'video', assetId: 'movie', sceneId: 'scene-one' },
    { id: 'sound-node', kind: 'audio', assetId: 'sound' },
  ], links: [] };
  const saved = updateProject(project, { revision: project.revision, graph });
  assert.deepEqual(saved.graph.nodes.map(node => node.assetName), ['人物.png', '雨夜.mp4', '旁白.wav']);
  assert.equal(saved.graph.nodes[1].sceneId, 'scene-one');
  for (const node of [
    { kind: 'image', assetId: 'foreign' }, { kind: 'image', assetId: 'movie' }, { kind: 'text', assetId: 'picture' },
    { kind: 'compose', assetId: 'movie' }, { kind: 'video', sceneId: 'foreign-scene' }, { kind: 'image', sceneId: 'scene-one' },
  ]) assert.throws(() => updateProject(project, { revision: 1, graph: { nodes: [{ id: 'bad', ...node }], links: [] } }), /不存在|类型不匹配|视频生成项/);
  assert.throws(() => updateProject(saved, { revision: saved.revision, scenes: [] }), /视频生成项/);
  assert.equal(project.graph.nodes.length, 0);
});

test('画布导入导出保留布局、镜头和素材占位，移除本机资产编号及非白名单信息', () => {
  const project = createProject();
  project.assets = [{ id: 'private-canvas-video', kind: 'video', name: '候选 2.mp4', file: 'private-video-file.mp4', url: 'https://example.com/signed-private' }];
  project.scenes = normalizeScenes([{ id: 'public-scene-one', title: '雨夜', videoAssetId: 'private-canvas-video' }]);
  project.graph = { nodes: [
    { id: 'video-card', kind: 'video', x: -2000, y: 500, width: 500, height: 400, assetId: 'private-canvas-video', sceneId: 'public-scene-one', assetName: '旧名称', status: 'done', apiKey: 'canvas-secret', url: 'https://example.com/signed-private' },
    { id: 'note', kind: 'text', x: -1000, y: -500, note: '从三支视频中选用第二支' },
  ], links: [], viewport: { x: 350, y: -200, zoom: 0.75, apiKey: 'canvas-secret' } };
  const document = exportProject(project);
  assert.doesNotMatch(JSON.stringify(document), /private-canvas-video|private-video-file|signed-private|canvas-secret|apiKey/);
  const video = document.project.graph.nodes[0];
  assert.equal(video.assetId, ''); assert.equal(video.assetName, '候选 2.mp4'); assert.equal(video.sceneId, 'public-scene-one');
  assert.equal(video.x, -2000); assert.equal(video.width, 500);
  const importedDocument = structuredClone(document); importedDocument.project.graph.nodes[0].assetId = 'injected-asset';
  const restored = importProject(importedDocument);
  assert.equal(restored.graph.nodes[0].assetId, ''); assert.equal(restored.graph.nodes[0].status, 'pending');
  assert.equal(restored.graph.nodes[0].assetName, '候选 2.mp4'); assert.equal(restored.graph.nodes[0].sceneId, 'public-scene-one');
  assert.equal(restored.graph.nodes[1].note, project.graph.nodes[1].note);
  assert.deepEqual(restored.graph.viewport, project.graph.viewport && { x: 350, y: -200, zoom: 0.75 });
  assert.deepEqual(restored.assets, []);
  importedDocument.project.graph.nodes[0].sceneId = 'missing-scene';
  assert.throws(() => importProject(importedDocument), /视频生成项/);
});

test('整理分镜草案保留自由画布、便签、媒体及视口，仅清理被替换的镜头绑定', () => {
  const project = createProject({ brief: { product: '雨夜书店' } });
  project.assets = [{ id: 'saved-picture', kind: 'image', name: '人物.png' }];
  project.scenes = normalizeScenes([{ id: 'old-scene', title: '旧镜头' }]);
  project.graph = { nodes: [
    { id: 'sticky', kind: 'text', x: -900, y: -500, label: '构思', note: '主人公推开书店的门' },
    { id: 'material', kind: 'image', x: 1800, y: -450, assetId: 'saved-picture', assetName: '人物.png', width: 550, height: 600 },
    { id: 'old-video', kind: 'video', x: -1000, y: 350, sceneId: 'old-scene', label: '保留这个位置', note: '雨夜氛围' },
  ], links: [{ id: 'creative-link', from: 'sticky', to: 'old-video' }], viewport: { x: -760, y: 680, zoom: 0.5 } };
  const planned = draftPlan(project);
  assert.deepEqual(planned.graph.viewport, project.graph.viewport);
  assert.deepEqual(planned.graph.links, project.graph.links);
  assert.deepEqual(planned.graph.nodes.map(node => node.id), ['sticky', 'material', 'old-video']);
  assert.equal(planned.graph.nodes[0].x, -900); assert.equal(planned.graph.nodes[0].note, '主人公推开书店的门');
  assert.equal(planned.graph.nodes[1].assetId, 'saved-picture'); assert.equal(planned.graph.nodes[1].width, 550);
  assert.equal(planned.graph.nodes[2].sceneId, ''); assert.equal(planned.graph.nodes[2].label, '保留这个位置');
  assert.equal(planned.graph.nodes[2].note, '雨夜氛围'); assert.equal(planned.graph.nodes[2].x, -1000);
  assert.equal(project.graph.nodes[2].sceneId, 'old-scene');
  const legacy = createProject({ brief: { product: '旧布局' } }); delete legacy.graph.viewport;
  for (const node of legacy.graph.nodes) { delete node.width; delete node.height; }
  assert.deepEqual(draftPlan(legacy).graph.viewport, { x: 0, y: 0, zoom: 1 });
});


function referenceCanvasProject() {
  const project = createProject();
  project.assets = [{ id: 'person-asset', kind: 'image', name: '人物.png' }, { id: 'street-asset', kind: 'image', name: '街道.png' }];
  project.graph = { nodes: [
    { id: 'person-node', kind: 'image', assetId: 'person-asset' }, { id: 'street-node', kind: 'image', assetId: 'street-asset' },
    { id: 'scene-node', kind: 'video', sceneId: 'one' },
  ], links: [] };
  project.scenes = normalizeScenes([{ id: 'one', videoPrompt: '  @图片1 的人物走入街道  ',
    references: [{ refId: 'manual-person', assetId: 'person-asset', kind: 'image', note: '保持服装' }],
    promptMentions: [{ start: 2, end: 6, key: 'ref:manual-person', assetId: 'person-asset' }],
  }]);
  return project;
}
const canvasLink = from => ({ id: from + '-link', from, to: 'scene-node' });

test('graph-only 保存按连线重排提示词且保留空白，手动接管和断线恢复都跟随素材身份', () => {
  const project = referenceCanvasProject(), graph = structuredClone(project.graph);
  graph.links = [canvasLink('street-node'), canvasLink('person-node')];
  let saved = updateProject(project, { revision: project.revision, graph });
  assert.equal(saved.scenes[0].videoPrompt, '  @图片2 的人物走入街道  ');
  assert.equal(saved.scenes[0].promptMentions[0].key, 'node:person-node');
  assert.equal(saved.scenes[0].references[1].refId, 'manual-person'); assert.equal(saved.scenes[0].references[1].note, '保持服装');
  const disconnected = structuredClone(saved.graph); disconnected.links = [canvasLink('street-node')];
  saved = updateProject(saved, { revision: saved.revision, graph: disconnected });
  assert.equal(saved.scenes[0].promptMentions[0].key, 'ref:manual-person');
  assert.equal(saved.scenes[0].references[1].nodeId, undefined); assert.equal(saved.scenes[0].references[1].note, '保持服装');
  saved = updateProject(saved, { revision: saved.revision, graph: { ...saved.graph, links: [] } });
  assert.equal(saved.scenes[0].videoPrompt, '  @图片1 的人物走入街道  ');
  assert.equal(project.scenes[0].videoPrompt, '  @图片1 的人物走入街道  ');
});

test('graph-only 移除纯连线参考会明确标记断开，下一份同编号素材不会接管提示词', () => {
  let project = referenceCanvasProject(); project.scenes[0].references = []; project.scenes[0].promptMentions = [];
  project = updateProject(project, { revision: project.revision, graph: { ...project.graph, links: [canvasLink('person-node'), canvasLink('street-node')] },
    scenes: [{ id: 'one', videoPrompt: '@图片1走入街道', references: [{ nodeId: 'person-node', assetId: 'person-asset', kind: 'image' }, { nodeId: 'street-node', assetId: 'street-asset', kind: 'image' }] }] });
  const saved = updateProject(project, { revision: project.revision, graph: { ...project.graph, links: [canvasLink('street-node')] } });
  assert.equal(saved.scenes[0].videoPrompt, '@图片1（已断开）走入街道');
  assert.equal(saved.scenes[0].promptMentions[0].key, 'node:person-node'); assert.equal(saved.scenes[0].promptMentions[0].missing, true);
  assert.equal(saved.scenes[0].references[0].nodeId, 'street-node');
  const again = updateProject(saved, { revision: saved.revision, graph: saved.graph });
  assert.equal(again.scenes[0].videoPrompt, saved.scenes[0].videoPrompt);
});

test('客户端已同步的 graph/scenes PATCH 不会再次按旧编号改写素材绑定', () => {
  let project = referenceCanvasProject();
  project = updateProject(project, { revision: project.revision, graph: { ...project.graph, links: [canvasLink('person-node'), canvasLink('street-node')] } });
  const graph = { ...project.graph, links: [canvasLink('street-node'), canvasLink('person-node')] }, scenes = structuredClone(project.scenes);
  scenes[0].references.reverse(); scenes[0].videoPrompt = '  @图片2 的人物走入街道  '; scenes[0].promptMentions[0].label = '图片2';
  const saved = updateProject(project, { revision: project.revision, graph, scenes });
  assert.equal(saved.scenes[0].videoPrompt, scenes[0].videoPrompt); assert.equal(saved.scenes[0].promptMentions[0].key, 'node:person-node');
});

test('模型支持三十张图片时，连线和手动参考合并去重后仍可准备全部素材', () => {
  const project = createProject();
  project.assets = Array.from({ length: 30 }, (_,index) => ({ id: 'asset-' + index, kind: 'image', name: index + '.png' }));
  const nodes = project.assets.slice(0,10).map((asset,index) => ({ id: 'node-' + index, kind: 'image', assetId: asset.id }));
  nodes.push({ id: 'scene-node', kind: 'video', sceneId: 'one' }, { id: 'duplicate-node', kind: 'image', assetId: 'asset-0' });
  const references = project.assets.slice(0,10).flatMap((asset,index) => [
    { refId: 'manual-' + index, assetId: asset.id, kind: 'image', note: '用途' + index },
    { nodeId: 'node-' + index, assetId: asset.id, kind: 'image' },
  ]);
  const graph = { nodes, links: [...nodes.slice(0,10).map(node=>canvasLink(node.id)), canvasLink('duplicate-node')] };
  const saved = updateProject(project, { revision: project.revision, graph, scenes: [{ id: 'one', references }] });
  assert.equal(saved.scenes[0].references.length, 10); assert.equal(saved.scenes[0].references[0].note, '用途0');
  const extra = { ...saved.graph, nodes: [...saved.graph.nodes, { id: 'node-10', kind: 'image', assetId: 'asset-10' }], links: [...saved.graph.links, canvasLink('node-10')] };
  const expanded=updateProject(saved, { revision: saved.revision, graph: extra });
  assert.equal(expanded.scenes[0].references.length,11);
  const final=updateProject(expanded,{revision:expanded.revision,scenes:[{...expanded.scenes[0],references:project.assets.map(asset=>({kind:'image',assetId:asset.id}))}]});
  assert.equal(final.scenes[0].references.length,30);
  assert.equal(saved.scenes[0].references.length, 10);
});

test('工程导入保留连线参考身份和用途、脱敏提示词资产信息且不增加重复占位', () => {
  const project = referenceCanvasProject(), linked = updateProject(project, { revision: project.revision, graph: { ...project.graph, links: [canvasLink('person-node'),canvasLink('street-node')] } });
  linked.scenes[0].references[1].note = '街道背景';
  const document = exportProject(linked), restored = importProject(document);
  assert.doesNotMatch(JSON.stringify(document), /person-asset|street-asset/);
  assert.deepEqual(restored.scenes[0].references.map(reference=>reference.nodeId), ['person-node','street-node']);
  assert.deepEqual(restored.scenes[0].references.map(reference=>reference.note), ['保持服装','街道背景']);
  assert.equal(restored.scenes[0].references[0].refId, 'manual-person');
  assert.equal(restored.scenes[0].promptMentions[0].key, 'node:person-node'); assert.equal(restored.scenes[0].promptMentions[0].assetId, undefined);
  assert.equal(restored.scenes[0].videoPrompt, '  @图片1（已断开） 的人物走入街道  ');
  const saved = updateProject(restored, { revision: restored.revision, graph: restored.graph });
  assert.deepEqual(saved.scenes[0].references, restored.scenes[0].references);
});

test('伪造节点身份不能隐藏手动素材，错误提示词元数据返回输入错误', () => {
  const project = referenceCanvasProject();
  for (const nodeId of ['missing-node','street-node']) {
    assert.throws(() => updateProject(project, { revision: project.revision, scenes: [{ id: 'one', references: [{ nodeId, assetId: 'person-asset', kind: 'image' }] }] }), /连线/);
  }
  assert.throws(() => updateProject(project, { revision: project.revision, scenes: [{ id: 'one', videoPrompt: ' @图片1', promptMentions: [{ start: 0, end: 4, key: 'ref:manual-person' }] }] }), error=>error.status===400);
  assert.equal(normalizeScenes([{ videoPrompt: '  ' + '字'.repeat(4001) }])[0].videoPrompt.length, 4000);
});
