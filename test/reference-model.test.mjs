import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSceneReferences, syncProjectReferences, referenceKey, referenceLabel, withoutSceneReferenceLinks } from '../public/reference-model.js';

function fixture() {
  const scene = { id: 'scene', references: [] };
  const project = { assets: [
    { id: 'image-a', kind: 'image', name: '人物.png' }, { id: 'image-b', kind: 'image', name: '街道.png' },
    { id: 'video-a', kind: 'video', name: '运镜.mp4' },
  ], scenes: [scene], graph: { nodes: [
    { id: 'picture-a', kind: 'image', assetId: 'image-a' }, { id: 'picture-b', kind: 'image', assetId: 'image-b' },
    { id: 'movie-a', kind: 'video', assetId: 'video-a' },
    { id: 'target-a', kind: 'video', sceneId: 'scene' }, { id: 'target-b', kind: 'video', sceneId: 'scene' },
  ], links: [] } };
  return { project, scene };
}
const link = (from, to = 'target-a') => ({ id: from + '-' + to, from, to });

test('按连线原顺序汇总同一分镜的全部视频卡，图片视频各自编号', () => {
  const { project, scene } = fixture();
  project.graph.links = [link('movie-a','target-b'), link('picture-b'), link('picture-a','target-b')];
  const snapshot = structuredClone(project), references = resolveSceneReferences(project, scene);
  assert.deepEqual(references.map(reference => reference.nodeId), ['movie-a','picture-b','picture-a']);
  assert.deepEqual(references.map((_,index) => referenceLabel(references,index)), ['视频1','图片1','图片2']);
  assert.deepEqual(references.map(referenceKey), ['node:movie-a','node:picture-b','node:picture-a']);
  assert.equal(references[1].name, '街道.png'); assert.deepEqual(project, snapshot);
});

test('同素材的重复卡片只保留最先连接的一份，代表节点变化时保留用途', () => {
  const { project, scene } = fixture();
  project.graph.nodes.push({ id: 'duplicate-picture', kind: 'image', assetId: 'image-a' });
  project.graph.links = [link('duplicate-picture'), link('picture-a','target-b')];
  syncProjectReferences(project); scene.references[0].note = '保持人物服饰';
  assert.equal(scene.references.length, 1); assert.equal(scene.references[0].nodeId, 'duplicate-picture');
  project.graph.links.shift(); syncProjectReferences(project);
  assert.equal(scene.references[0].nodeId, 'picture-a'); assert.equal(scene.references[0].note, '保持人物服饰');
  const once = structuredClone(project); syncProjectReferences(project); assert.deepEqual(project, once);
});

test('连线接管手动素材时保留稳定身份和用途，断开后恢复手动项', () => {
  const { project, scene } = fixture();
  scene.references = [{ refId: 'manual-person', assetId: 'image-a', kind: 'image', name: '人物.png', note: '人物外观' },
    { refId: 'manual-motion', assetId: 'video-a', kind: 'video', name: '运镜.mp4', note: '慢速推镜' }];
  project.graph.links = [link('picture-a')]; syncProjectReferences(project);
  assert.deepEqual(scene.references[0], { nodeId: 'picture-a', refId: 'manual-person', assetId: 'image-a', kind: 'image', name: '人物.png', note: '人物外观' });
  assert.equal(referenceKey(scene.references[0]), 'node:picture-a'); assert.equal(referenceKey(scene.references[1]), 'ref:manual-motion');
  project.graph.links = []; syncProjectReferences(project);
  assert.deepEqual(scene.references[0], { refId: 'manual-person', assetId: 'image-a', kind: 'image', name: '人物.png', note: '人物外观' });
});

test('删除纯连线素材节点会删除参考，不会留下伪手动项', () => {
  const { project, scene } = fixture(); project.graph.links = [link('picture-a')]; syncProjectReferences(project);
  project.graph.nodes = project.graph.nodes.filter(node => node.id !== 'picture-a'); project.graph.links = [];
  syncProjectReferences(project); assert.deepEqual(scene.references, []);
});

test('旧版手动清单和旧单图引用的只读身份稳定，首次保存后仍幂等', () => {
  const { project, scene } = fixture(); scene.referenceAssetId = 'image-a';
  scene.references = [{ assetId: '', kind: 'video', name: '补选视频.mp4', note: '动作' }];
  const first = resolveSceneReferences(project, scene), second = resolveSceneReferences(project, scene);
  assert.deepEqual(second, first); assert.ok(first.every(reference => reference.refId));
  assert.equal(scene.references[0].refId, undefined); syncProjectReferences(project);
  assert.deepEqual(scene.references, first); assert.equal(scene.referenceAssetId, '');
  syncProjectReferences(project); assert.deepEqual(scene.references, first);
});

test('导入的同名占位素材按节点身份保留，空流程节点不误算参考', () => {
  const { project, scene } = fixture(); project.assets = [];
  project.graph.nodes = [
    { id: 'placeholder-one', kind: 'image', assetId: '', assetName: '人物.png' },
    { id: 'placeholder-two', kind: 'image', assetId: '', assetName: '人物.png' },
    { id: 'old-flow', kind: 'image', label: '画面素材' },
    { id: 'target-a', kind: 'video', sceneId: 'scene' },
  ];
  scene.references = [{ nodeId: 'placeholder-one', assetId: '', kind: 'image', name: '人物.png', note: '角色甲' },
    { nodeId: 'placeholder-two', assetId: '', kind: 'image', name: '人物.png', note: '角色乙' }];
  project.graph.links = [link('placeholder-two'), link('old-flow'), link('placeholder-one')]; syncProjectReferences(project);
  assert.deepEqual(scene.references.map(reference => [reference.nodeId, reference.note]), [['placeholder-two','角色乙'],['placeholder-one','角色甲']]);
  const original = structuredClone(scene.references); syncProjectReferences(project); assert.deepEqual(scene.references, original);
});

test('重新补选导入节点会保留用途，替换已选素材不会继承原手动素材的身份', () => {
  const { project, scene } = fixture(); project.graph.links = [link('picture-a')];
  const node = project.graph.nodes[0]; node.assetId = ''; node.assetName = '人物.png';
  scene.references = [{ nodeId: 'picture-a', refId: 'original-manual', assetId: '', kind: 'image', name: '人物.png', note: '外观' }];
  syncProjectReferences(project); node.assetId = 'image-a'; syncProjectReferences(project);
  assert.equal(scene.references[0].note, '外观'); assert.equal(scene.references[0].refId, 'original-manual');
  node.assetId = 'image-b'; syncProjectReferences(project);
  assert.equal(scene.references[0].assetId, 'image-b'); assert.equal(scene.references[0].refId, undefined);
  assert.equal(scene.references[1].assetId, 'image-a'); assert.equal(scene.references[1].refId, 'original-manual');
});


test('旧分镜流程边没有固定输出时不误算参考，独立素材仍可进入清单', () => {
  const { project, scene } = fixture();
  project.scenes.push({ id: 'other-scene', references: [] });
  project.graph.nodes.find(node => node.id === 'movie-a').sceneId = 'other-scene';
  project.graph.links = [link('movie-a'), link('picture-a')];
  assert.deepEqual(resolveSceneReferences(project, scene).map(reference => reference.nodeId), ['picture-a']);
});


test('导入占位的完整文件名不被卡片的短名称覆盖', () => {
  const { project, scene } = fixture(), name = '完整文件名'.repeat(30) + '.png';
  const source = project.graph.nodes[0]; source.assetId = ''; source.assetName = name.slice(0,120);
  scene.references = [{ nodeId: 'picture-a', assetId: '', kind: 'image', name, note: '人物' }];
  project.graph.links = [link('picture-a')]; syncProjectReferences(project);
  assert.equal(scene.references[0].name, name);
});


test('移除一份视频参考时断开同分镜的所有同类型素材副卡，保留其他分镜、不同类型及绑定分镜卡的连线', () => {
  const { project, scene } = fixture();
  project.scenes.push({id:'other-scene',references:[]});
  project.graph.nodes.push(
    {id:'movie-copy',kind:'video',assetId:'video-a'},
    {id:'same-id-picture',kind:'image',assetId:'video-a'},
    {id:'bound-movie',kind:'video',assetId:'video-a',sceneId:'other-scene'},
    {id:'other-target',kind:'video',sceneId:'other-scene'});
  project.graph.nodes.find(node => node.id === 'target-a').assetId = 'video-a';
  project.graph.links = [link('movie-a'),link('movie-copy','target-b'),link('movie-a','other-target'),link('movie-copy','other-target'),
    link('same-id-picture'),link('bound-movie'),link('picture-b'),link('target-a','other-target')];
  const before = structuredClone(project);
  const retained = withoutSceneReferenceLinks(project.graph,scene.id,'movie-a');
  assert.deepEqual(retained.map(edge => edge.id),before.graph.links.slice(2).map(edge => edge.id));
  assert.deepEqual(project,before,'清单过滤不得直接修改工程、参考或素材');
  assert.deepEqual(withoutSceneReferenceLinks(project.graph,scene.id,'target-a'),before.graph.links,'绑定分镜的视频卡不能被当作独立参考移除');
  assert.deepEqual(withoutSceneReferenceLinks(project.graph,scene.id,'missing-card'),before.graph.links);
});


test('分镜到分镜的固定输出按连接顺序成为视频参考，选片改变不替换已连接的结果', () => {
  const { project, scene } = fixture();
  project.scenes.push({ id: 'source-scene', videoAssetId: 'video-a', references: [] });
  project.graph.nodes.push({ id: 'source-shot', kind: 'video', sceneId: 'source-scene' });
  project.graph.links = [link('picture-a'), { ...link('source-shot'), reference: { assetId: 'video-a', kind: 'video', name: '运镜.mp4' } }, link('movie-a')];
  syncProjectReferences(project);
  assert.deepEqual(scene.references.map(reference => [reference.nodeId, reference.assetId]), [['picture-a', 'image-a'], ['source-shot', 'video-a']]);
  scene.references[1].note = '保持镜头运动'; project.scenes[1].videoAssetId = 'another-result';
  syncProjectReferences(project); assert.equal(scene.references[1].assetId, 'video-a'); assert.equal(scene.references[1].note, '保持镜头运动');
  const retained = withoutSceneReferenceLinks(project.graph, scene.id, 'source-shot');
  assert.deepEqual(retained.map(edge => edge.from), ['picture-a']);
});

test('分镜输出和独立素材重复连接时清单断开所有同素材边，保留其他分镜与旧流程边', () => {
  const { project, scene } = fixture();
  project.scenes.push({ id: 'source', references: [] }, { id: 'other', references: [] });
  project.graph.nodes.push({ id: 'shot-source', kind: 'video', sceneId: 'source' }, { id: 'other-shot', kind: 'video', sceneId: 'other' });
  const output = { assetId: 'video-a', kind: 'video', name: '运镜.mp4' };
  project.graph.links = [link('movie-a'), { ...link('shot-source', 'target-b'), reference: output },
    { ...link('shot-source', 'other-shot'), reference: output }, link('shot-source'), link('picture-a')];
  const retained = withoutSceneReferenceLinks(project.graph, scene.id, 'movie-a');
  assert.deepEqual(retained.map(edge => edge.to), ['other-shot', 'target-a', 'target-a']);
  syncProjectReferences({ ...project, graph: { ...project.graph, links: retained } });
  assert.deepEqual(scene.references.map(reference => reference.kind), ['image']);
});

test('导入分镜输出占位保留原名称用途，来源重新选片不会把占位悄悄替换为新结果', () => {
  const { project, scene } = fixture();
  project.scenes.push({ id: 'source', videoAssetId: 'video-a', references: [] });
  project.graph.nodes.push({ id: 'shot-source', kind: 'video', sceneId: 'source' });
  project.graph.links = [{ ...link('shot-source'), reference: { assetId: '', kind: 'video', name: '原候选.mp4' } }];
  scene.references = [{ nodeId: 'shot-source', assetId: '', kind: 'video', name: '原候选.mp4', note: '延续动作' }];
  syncProjectReferences(project);
  assert.deepEqual(scene.references, [{ nodeId: 'shot-source', assetId: '', kind: 'video', name: '原候选.mp4', note: '延续动作' }]);
});
