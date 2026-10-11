import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createProject, normalizeScenes, updateProject, exportProject, importProject } from '../lib/workflow.mjs';
import { createPortablePromptMentionMapper, invalidPromptMentions } from '../public/prompt-mentions.js';
import { resolveSceneReferences } from '../public/reference-model.js';

const legacyId = 'private-original-person-media';
const otherId = 'private-original-background-media';
function orphanProject() {
  const project = createProject();
  project.scenes = normalizeScenes([
    { id: 'one', videoPrompt: '@图片1（已断开） @图片1（已断开）', references: [], promptMentions: [
      { start: 0, end: 9, key: 'asset:' + legacyId, assetId: legacyId, refId: legacyId },
      { start: 10, end: 19, key: 'asset:' + legacyId, assetId: legacyId },
    ] },
    { id: 'two', videoPrompt: '@图片1（已断开） @图片1（已断开）', references: [], promptMentions: [
      { start: 0, end: 9, key: 'asset:' + legacyId, assetId: legacyId },
      { start: 10, end: 19, key: 'asset:' + otherId, assetId: otherId },
    ] },
  ]);
  return project;
}
function assertPortable(document) {
  assert.doesNotMatch(JSON.stringify(document), /private-original-person-media|private-original-background-media/);
  const [one, two] = document.project.scenes;
  assert.equal(one.promptMentions[0].key, one.promptMentions[1].key);
  assert.equal(one.promptMentions[0].key, two.promptMentions[0].key);
  assert.notEqual(one.promptMentions[0].key, two.promptMentions[1].key);
  for (const scene of document.project.scenes) for (const mention of scene.promptMentions) {
    assert.match(mention.key, /^ref:portable-material-\d+$/);
    assert.equal(mention.assetId, undefined); assert.equal(mention.refId, undefined);
  }
}

test('孤立旧 asset:key 导入导出脱敏，同工程重复与跨分镜映射一致且不同素材不会合并', () => {
  const project = orphanProject(), original = structuredClone(project);
  const document = exportProject(project); assertPortable(document); assert.deepEqual(project, original);
  const imported = importProject(document);
  assert.deepEqual(imported.scenes.map(scene => scene.promptMentions.map(mention => mention.key)),
    document.project.scenes.map(scene => scene.promptMentions.map(mention => mention.key)));
  assertPortable(exportProject(imported));
  const oldDocument = { format: 'jingce-project', schemaVersion: 1, project: {
    title: project.title, brief: project.brief, graph: project.graph, scenes: project.scenes,
  } };
  const sanitizedImport = importProject(oldDocument);
  assertPortable({ project: sanitizedImport });
  assert.equal(sanitizedImport.scenes[0].videoPrompt, project.scenes[0].videoPrompt);
});

test('旧 asset:key 仍有参考时清理前转为原 node/ref 身份，补选素材可以恢复提示词', () => {
  for (const linked of [false, true]) {
    const project = createProject();
    project.assets = [{ id: legacyId, kind: 'image', name: '人物.png' }];
    project.graph = { nodes: [{ id: 'material', kind: 'image', assetId: legacyId, assetName: '人物.png' },
      { id: 'scene-video', kind: 'video', sceneId: 'one' }],
      links: linked ? [{ id: 'reference-link', from: 'material', to: 'scene-video' }] : [] };
    project.scenes = normalizeScenes([{ id: 'one', videoPrompt: '@图片1的人物行走',
      references: [{ assetId: legacyId, kind: 'image', name: '人物.png', refId: 'stable-reference', ...(linked ? { nodeId: 'material' } : {}) }],
      promptMentions: [{ start: 0, end: 4, key: 'asset:' + legacyId, assetId: legacyId }],
    }]);
    const document = { format: 'jingce-project', schemaVersion: 1, project: {
      title: project.title, brief: project.brief, graph: project.graph, scenes: project.scenes,
    } };
    const restored = importProject(document), key = linked ? 'node:material' : 'ref:stable-reference';
    assert.equal(restored.scenes[0].promptMentions[0].key, key);
    assert.equal(restored.scenes[0].promptMentions[0].assetId, undefined);
    assert.doesNotMatch(JSON.stringify(restored), /private-original-person-media/);
    assert.equal(restored.scenes[0].videoPrompt, '@图片1（已断开）的人物行走');
    restored.assets.push({ id: 'newly-selected-media', kind: 'image', name: '新人物.png' });
    let saved;
    if (linked) {
      const graph = structuredClone(restored.graph); graph.nodes[0].assetId = 'newly-selected-media';
      saved = updateProject(restored, { revision: restored.revision, graph });
    } else {
      const scenes = structuredClone(restored.scenes); scenes[0].references[0].assetId = 'newly-selected-media';
      saved = updateProject(restored, { revision: restored.revision, scenes });
    }
    assert.equal(saved.scenes[0].videoPrompt, '@图片1的人物行走');
    assert.equal(saved.scenes[0].promptMentions[0].key, key);
    assert.equal(invalidPromptMentions(saved.scenes[0], resolveSceneReferences(saved, saved.scenes[0])).length, 0);
    assert.doesNotMatch(JSON.stringify(exportProject(saved)), /private-original-person-media|newly-selected-media/);
  }
});

test('浏览器冲突备份使用同一脱敏映射，清理原媒体编号并保留跨分镜身份', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.match(/function localExport\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source, 'localExport function is available');
  const project = orphanProject(), before = structuredClone(project);
  const document = vm.runInNewContext(source + '\nlocalExport();', {
    state: { project }, clone: structuredClone, createPortablePromptMentionMapper,
    referencesFor: scene => resolveSceneReferences(project, scene),
  });
  assertPortable(document); assert.deepEqual(project, before);
  const imported = importProject(document);
  assertPortable(exportProject(imported));
});

test('便携占位避开已有 node/ref 身份，兼容映射不借相同编号改绑其他素材', () => {
  const project = orphanProject();
  project.scenes.push({ videoPrompt: '@图片1（已断开）', promptMentions: [{ start: 0, end: 9, kind: 'image', key: 'ref:portable-material-1' }],
    references: [{ assetId: '', kind: 'image', refId: 'portable-material-2' }] });
  const portable = createPortablePromptMentionMapper(project.scenes);
  const mention = project.scenes[0].promptMentions[0];
  const result = portable(mention, [{ assetId: otherId, kind: 'image', refId: 'unrelated' }]);
  assert.equal(result.key, 'ref:portable-material-3');
  assert.equal(portable(mention).key, result.key); assert.equal(result.refId, undefined);
  const stale = portable({ ...mention, assetId: otherId }, [{ assetId: legacyId, kind: 'image', refId: 'same-label' }]);
  assert.equal(stale.key, result.key); assert.equal(stale.assetId, undefined);
});


test('浏览器备份保留分镜输出连线与提及身份，清除固定候选编号及签名地址', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const source = app.match(/function localExport\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source);
  const project = createProject();
  project.assets = [{ id: legacyId, kind: 'video', sceneId: 'source', name: '原生成结果.mp4', file: 'private-file.mp4' }];
  project.scenes = normalizeScenes([
    { id: 'source', videoAssetId: legacyId },
    { id: 'target', videoPrompt: '使用@视频1的运镜',
      references: [{ nodeId: 'source-card', assetId: legacyId, kind: 'video', name: '原生成结果.mp4',
        publicUrl: 'https://media.example.org/private-file.mp4?signature=secret-address' }],
      promptMentions: [{ start: 2, end: 6, key: 'node:source-card', assetId: legacyId, kind: 'video' }] },
  ]);
  project.graph = { nodes: [{ id: 'source-card', kind: 'video', sceneId: 'source' }, { id: 'target-card', kind: 'video', sceneId: 'target' }],
    links: [{ id: 'output', from: 'source-card', to: 'target-card', reference: { assetId: legacyId, kind: 'video', name: '原生成结果.mp4' } }] };
  const before = structuredClone(project);
  const document = vm.runInNewContext(source + '\nlocalExport();', {
    state: { project }, clone: structuredClone, createPortablePromptMentionMapper,
    referencesFor: scene => resolveSceneReferences(project, scene),
  });
  assert.doesNotMatch(JSON.stringify(document), /private-original-person-media|private-file|secret-address|publicUrl/);
  assert.equal(document.project.graph.links[0].reference.assetId, '');
  assert.equal(document.project.graph.links[0].reference.name, '原生成结果.mp4');
  assert.equal(document.project.scenes[1].promptMentions[0].key, 'node:source-card');
  assert.equal(document.project.scenes[1].references[0].assetId, '');
  assert.deepEqual(project, before);
  const imported = importProject(document);
  assert.equal(imported.graph.links[0].reference.assetId, '');
  assert.equal(imported.scenes[1].references[0].nodeId, 'source-card');
  assert.match(imported.scenes[1].videoPrompt, /@视频1（已断开）/);
  assert.equal(invalidPromptMentions(imported.scenes[1], resolveSceneReferences(imported, imported.scenes[1])).length, 1);
});
