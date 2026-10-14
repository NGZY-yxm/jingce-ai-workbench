import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createStudio } from '../server.mjs';
import { createProject, updateProject } from '../lib/workflow.mjs';
import { createPackageManifest, restorePackageProject } from '../lib/project-portability.mjs';
import { resolveSceneReferences } from '../public/reference-model.js';
import { invalidPromptMentions } from '../public/prompt-mentions.js';
import { crc32, zipStream } from '../lib/project-archive.mjs';
await import('../public/jszip.js');
const Zip = globalThis.JSZip;

const png = Buffer.alloc(64); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
const mp4 = Buffer.alloc(96); mp4.write('ftyp', 4);
const wav = Buffer.alloc(80); wav.write('RIFF'); wav.write('WAVE', 8);
function fixtureProject() {
  let project = createProject({ title: '朋友继续创作的画布', brief: { product: '雨夜书店' } });
  project.assets = [
    { id: 'original-upload-image', kind: 'image', mime: 'image/png', name: '人物参考.png', file: 'private-upload.png', size: png.length, source: 'upload' },
    { id: 'original-model-image', kind: 'image', mime: 'image/png', name: '生成图片.png', file: 'private-image.png', size: png.length, source: 'model', nodeId: 'generate-image', batchId: 'private-batch', variantIndex: 2, jobId: 'private-job' },
    { id: 'original-model-video', kind: 'video', mime: 'video/mp4', name: '生成视频.mp4', file: 'private-video.mp4', size: mp4.length, source: 'model', sceneId: 'source', duration: 5, resolution: '720p' },
    { id: 'original-audio', kind: 'audio', mime: 'audio/wav', name: '雨声.wav', file: 'private-audio.wav', size: wav.length, source: 'upload' },
    { id: 'excluded-deleted-image', kind: 'image', mime: 'image/png', name: '已删除图片', file: 'deleted.png', size: png.length, deletedAt: '2026-10-14T00:00:00Z' },
  ];
  project = updateProject(project, { revision: project.revision,
    graph: { viewport: { x: -250, y: 110, zoom: 0.75 }, groups: [{ id: 'group', label: '准备与生成', nodeIds: ['material', 'generate-image'], color: '#5c82ed' }],
      nodes: [
        { id: 'note', kind: 'text', note: '朋友可以继续修改这张文字卡', x: -500, y: -200 },
        { id: 'material', kind: 'image', assetId: 'original-upload-image', x: 100, y: 200 },
        { id: 'generate-image', kind: 'image', role: 'image-generation', assetId: 'original-model-image', selectedAssetId: 'original-model-image',
          imageJobId: 'private-job', imageConfig: { prompt: '书店暖光', model: 'friend-image-model', ratio: '16:9' }, x: 500, y: 200 },
        { id: 'source-card', kind: 'video', sceneId: 'source', x: 100, y: 600 },
        { id: 'sound', kind: 'audio', assetId: 'original-audio', x: 500, y: 900 },
        { id: 'target-card', kind: 'video', sceneId: 'target', x: 1000, y: 600 },
      ], links: [
        { id: 'input-image', from: 'material', to: 'generate-image' },
        { id: 'image-output', from: 'generate-image', to: 'target-card', reference: { assetId: 'original-model-image', kind: 'image', name: '生成图片.png' } },
        { id: 'video-output', from: 'source-card', to: 'target-card', reference: { assetId: 'original-model-video', kind: 'video', name: '生成视频.mp4' } },
        { id: 'sound-input', from: 'sound', to: 'target-card' },
      ] },
    scenes: [
      { id: 'source', title: '原视频', videoAssetId: 'original-model-video', imageAssetId: 'original-model-image' },
      { id: 'target', title: '下一镜头', videoPrompt: '@图片1 @视频1 @音频1', references: [
        { nodeId: 'generate-image', assetId: 'original-model-image', kind: 'image', name: '生成图片.png', publicUrl: 'https://example.org/image?signature=private-signature' },
        { nodeId: 'source-card', assetId: 'original-model-video', kind: 'video', name: '生成视频.mp4' },
        { nodeId: 'sound', assetId: 'original-audio', kind: 'audio', name: '雨声.wav' },
      ], promptMentions: [
        { start: 0, end: 4, key: 'asset:original-model-image', assetId: 'original-model-image' },
        { start: 5, end: 9, key: 'node:source-card', assetId: 'original-model-video' },
        { start: 10, end: 14, key: 'node:sound', assetId: 'original-audio' },
      ] },
    ],
  });
  project.privateData = 'private-runtime-secret';
  project.graph.nodes[0].apiKey = 'private-config-key';
  return project;
}
async function studio(t, { projectLimit } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'miraframe-package-'));
  let calls = 0;
  const unexpected = async () => { calls++; throw new Error('分享工程不得提交模型请求'); };
  const options = { root, catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false },
    integrations: { submit: unexpected, poll: unexpected, download: unexpected }, getProjectLimit: projectLimit };
  const app = await createStudio(options), url = await app.start(0);
  const boot = await (await fetch(url + '/api/bootstrap')).json();
  const project = fixtureProject();
  for (const asset of project.assets.filter(asset => !asset.deletedAt)) await writeFile(path.join(root, 'assets', asset.file), asset.kind === 'video' ? mp4 : asset.kind === 'audio' ? wav : png);
  await writeFile(path.join(root, 'connection.private.json'), JSON.stringify({ apiKey: 'private-config-key' }));
  await app.store.mutate(state => { state.projects.push(project); return project; });
  t.after(async () => {
    await app.close(); assert.equal(calls, 0);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('miraframe-package-')); await rm(root, { recursive: true, force: true });
  });
  const importArchive = data => fetch(url + '/api/projects/import', { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Studio-Token': boot.token }, body: data });
  const exportArchive = async () => {
    const response = await fetch(url + `/api/projects/${project.id}/package`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(response.headers.get('Content-Type'), /application\/zip/);
    assert.match(response.headers.get('Content-Disposition'), /miraframe\.zip/);
    return Buffer.from(await response.arrayBuffer());
  };
  return { root, app, url, project, boot, importArchive, exportArchive };
}
async function mutatedArchive(bytes, change) {
  const zip = await Zip.loadAsync(bytes);
  const manifest = JSON.parse(await zip.file('project.json').async('string'));
  await change(zip, manifest);
  zip.file('project.json', JSON.stringify(manifest));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('工程分享清单保留素材与引用，清除原媒体编号、私有路径和任务记录，导入生成新身份', () => {
  const original = fixtureProject(), before = structuredClone(original), manifest = createPackageManifest(original);
  assert.deepEqual(original, before);
  assert.equal(manifest.project.assets.length, 4);
  assert.doesNotMatch(JSON.stringify(manifest), /original-|private-|excluded-deleted|apiKey|publicUrl|jobId/);
  const { project } = restorePackageProject(manifest);
  assert.notEqual(project.id, original.id);
  assert.equal(project.assets.length, 4);
  assert.deepEqual(project.graph.groups, original.graph.groups);
  assert.deepEqual(project.graph.viewport, original.graph.viewport);
  const image = project.assets.find(asset => asset.nodeId === 'generate-image');
  const imageNode = project.graph.nodes.find(node => node.id === 'generate-image');
  assert.equal(imageNode.assetId, image.id); assert.equal(imageNode.selectedAssetId, image.id); assert.equal(imageNode.imageJobId, '');
  assert.equal(project.scenes[0].imageAssetId, image.id);
  assert.equal(project.scenes[1].videoPrompt, '@图片1 @视频1 @音频1');
  assert.equal(invalidPromptMentions(project.scenes[1], resolveSceneReferences(project, project.scenes[1])).length, 0);
});

test('HTTP 工程包在朋友工作空间恢复全部原文件，重复导入互不覆盖，无模型提交且兼容 JSON 备份', async t => {
  const f = await studio(t), bytes = await f.exportArchive();
  const zip = await Zip.loadAsync(bytes, { checkCRC32: true });
  assert.deepEqual(Object.keys(zip.files).sort(), ['media/asset-1.png', 'media/asset-2.png', 'media/asset-3.mp4', 'media/asset-4.wav', 'project.json']);
  const manifestText = await zip.file('project.json').async('string');
  assert.doesNotMatch(manifestText, /private-|original-|excluded-deleted|connection|apiKey|signature|jobId/);
  const manifest = JSON.parse(manifestText);
  for (const asset of manifest.project.assets) assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  const friendRoot = await mkdtemp(path.join(os.tmpdir(), 'miraframe-friend-'));
  const friend = await createStudio({ root: friendRoot, catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false } }), friendUrl = await friend.start(0);
  t.after(async () => { await friend.close(); assert.equal(path.dirname(friendRoot), os.tmpdir()); await rm(friendRoot, { recursive: true, force: true }); });
  const token = (await (await fetch(friendUrl + '/api/bootstrap')).json()).token;
  const importFriend = () => fetch(friendUrl + '/api/projects/import', { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Studio-Token': token }, body: bytes });
  const response = await importFriend(); assert.equal(response.status, 201); const restored = await response.json();
  assert.equal(restored.title, f.project.title); assert.notEqual(restored.id, f.project.id);
  assert.deepEqual(restored.graph.viewport, f.project.graph.viewport); assert.deepEqual(restored.graph.groups, f.project.graph.groups);
  for (const asset of restored.assets) {
    assert.notEqual(asset.id, f.project.assets[restored.assets.indexOf(asset)].id);
    const media = await fetch(friendUrl + '/api/assets/' + asset.id);
    assert.equal(media.status, 200); assert.deepEqual(Buffer.from(await media.arrayBuffer()), asset.kind === 'video' ? mp4 : asset.kind === 'audio' ? wav : png);
  }
  assert.equal(restored.scenes[1].videoPrompt, '@图片1 @视频1 @音频1');
  assert.equal(invalidPromptMentions(restored.scenes[1], resolveSceneReferences(restored, restored.scenes[1])).length, 0);
  assert.deepEqual(friend.store.state.jobs, []); assert.deepEqual(friend.store.state.imageJobs, []);
  const repeat = await importFriend(); assert.equal(repeat.status, 201); const repeated = await repeat.json();
  assert.notEqual(repeated.id, restored.id); assert.ok(repeated.assets.every(asset => !restored.assets.some(other => other.id === asset.id)));
  assert.equal(friend.store.list().length, 2);
  const legacy = await (await fetch(f.url + `/api/projects/${f.project.id}/export`)).json();
  const legacyResponse = await fetch(friendUrl + '/api/projects/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token }, body: JSON.stringify(legacy) });
  assert.equal(legacyResponse.status, 201); assert.equal((await legacyResponse.json()).assets.length, 0);
  assert.deepEqual(await readdir(path.join(friendRoot, 'imports')), []);
});

test('导入损坏、缺素材、伪装媒体、越界文件、重复编号和未知素材引用全部拒绝且不留下新工程或文件', async t => {
  const f = await studio(t), bytes = await f.exportArchive(), initialFiles = (await readdir(path.join(f.root, 'assets'))).sort();
  const cases = [
    zip => zip.remove('media/asset-1.png'),
    (zip, manifest) => { manifest.project.assets[0].sha256 = '0'.repeat(64); },
    zip => zip.file('../connection.private.json', 'unsafe'),
    (_zip, manifest) => { manifest.project.assets[1].id = manifest.project.assets[0].id; },
    (_zip, manifest) => { manifest.project.graph.nodes[1].assetId = 'another-account-media'; },
    (zip, manifest) => { const fake = Buffer.alloc(png.length, 65); zip.file('media/asset-1.png', fake); manifest.project.assets[0].sha256 = createHash('sha256').update(fake).digest('hex'); },
    (_zip, manifest) => { manifest.project.assets[0].path = '../../connection.private.json'; },
  ];
  for (const mutate of cases) {
    const response = await f.importArchive(await mutatedArchive(bytes, mutate));
    assert.equal(response.status, 400, await response.text());
    assert.equal(f.app.store.list().length, 1); assert.deepEqual((await readdir(path.join(f.root, 'assets'))).sort(), initialFiles);
    assert.deepEqual(await readdir(path.join(f.root, 'imports')), []);
  }
  const damaged = Buffer.from(bytes); const firstMediaOffset = damaged.indexOf(png); assert.ok(firstMediaOffset > 0); damaged[firstMediaOffset + 20] ^= 1;
  assert.equal((await f.importArchive(damaged)).status, 400); assert.equal(f.app.store.list().length, 1);
  assert.deepEqual((await readdir(path.join(f.root, 'assets'))).sort(), initialFiles);
});

test('项目上限导致最终提交失败时回滚已提取素材，导入仍需要有效操作令牌', async t => {
  const f = await studio(t, { projectLimit: () => 1 }), bytes = await f.exportArchive();
  const before = (await readdir(path.join(f.root, 'assets'))).sort();
  const response = await f.importArchive(bytes); assert.equal(response.status, 409); assert.match((await response.json()).error, /工程数量上限/);
  assert.equal(f.app.store.list().length, 1); assert.deepEqual((await readdir(path.join(f.root, 'assets'))).sort(), before);
  const refused = await fetch(f.url + '/api/projects/import', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: bytes });
  assert.equal(refused.status, 403); assert.deepEqual(await readdir(path.join(f.root, 'imports')), []);
});

test('ZIP 文件不会接受重名文件或目录穿越，素材缺失会阻止导出而不是静默生成半个包', async t => {
  const f = await studio(t), bytes = await f.exportArchive();
  const zip = await Zip.loadAsync(bytes), manifest = Buffer.from(await zip.file('project.json').async('string'));
  const duplicates = [{ name: 'project.json', data: manifest, size: manifest.length, crc: crc32(manifest) }, { name: 'project.json', data: manifest, size: manifest.length, crc: crc32(manifest) }];
  const parts = []; for await (const chunk of zipStream(duplicates)) parts.push(chunk);
  assert.equal((await f.importArchive(Buffer.concat(parts))).status, 400);
  await rm(path.join(f.root, 'assets', f.project.assets[0].file));
  const failed = await fetch(f.url + `/api/projects/${f.project.id}/package`); assert.equal(failed.status, 409); assert.match((await failed.json()).error, /原文件不存在/);
});


async function attachExtras(f) {
  const response = await fetch(f.url + '/api/skills/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': f.boot.token },
    body: JSON.stringify({ files: [{ path: 'SKILL.md', content: '---\nname: 书店技能\ndescription: 保持画面一致\n---\n暖色照明，主体外观一致。' },
      { path: 'references/style.md', content: '摄影机缓慢推进。' }, { path: 'scripts/example.py', content: 'print("not executed")' }] }) });
  assert.equal(response.status, 201); const skill = (await response.json())[0], requestId = randomUUID();
  await writeFile(path.join(f.root, 'text-results', requestId + '.json'), JSON.stringify({ projectId: f.project.id, images: [{ name: 'AI 回复参考图', source: 'data:image/png;base64,' + png.toString('base64') }] }));
  await f.app.store.update(f.project.id, previous => updateProject(previous, { revision: previous.revision,
    graph: { ...previous.graph, nodes: [...previous.graph.nodes, { id: 'ai-portable', kind: 'ai', aiConfig: { output: '继续编辑的 AI 草稿', instruction: '保持同一人物', status: 'done', skillId: skill.id,
      images: [{ requestId, index: 0, name: 'AI 回复参考图' }] } }] },
    scenes: previous.scenes.map(scene => ({ ...scene, videoSkillId: skill.id })),
  }));
  return { skill, requestId };
}

test('所选技能与 AI 回复图片随工程分享，新技能身份与图片地址刷新后仍可使用，重新导出不会复制素材', async t => {
  const f = await studio(t), { skill, requestId } = await attachExtras(f), bytes = await f.exportArchive();
  const zip = await Zip.loadAsync(bytes), manifestText = await zip.file('project.json').async('string'), manifest = JSON.parse(manifestText);
  assert.doesNotMatch(manifestText, new RegExp(skill.id + '|' + requestId + '|original-model|private-signature'));
  assert.equal(manifest.skills.length, 1); assert.equal(manifest.skills[0].references[0].content, '摄影机缓慢推进。');
  assert.equal(manifest.skills[0].attachments[0].path, 'scripts/example.py');
  assert.equal(manifest.project.assets.length, 5); assert.deepEqual(manifest.project.graph.nodes.at(-1).aiConfig.images, []);
  const response = await f.importArchive(bytes); assert.equal(response.status, 201); const project = await response.json(), node = project.graph.nodes.at(-1);
  assert.notEqual(node.aiConfig.skillId, skill.id); assert.equal(project.scenes[0].videoSkillId, node.aiConfig.skillId);
  const importedSkill = await (await fetch(f.url + '/api/skills/' + node.aiConfig.skillId)).json(); assert.equal(importedSkill.name, skill.name);
  assert.equal(importedSkill.attachments.length, 1); assert.equal(node.aiConfig.output, '继续编辑的 AI 草稿');
  const image = node.aiConfig.images[0]; assert.notEqual(image.requestId, requestId);
  const media = await fetch(f.url + image.previewUrl); assert.equal(media.status, 200); assert.deepEqual(Buffer.from(await media.arrayBuffer()), png);
  const reexport = await fetch(f.url + `/api/projects/${project.id}/package`); assert.equal(reexport.status, 200);
  const secondManifest = JSON.parse(await (await Zip.loadAsync(Buffer.from(await reexport.arrayBuffer()))).file('project.json').async('string'));
  assert.equal(secondManifest.project.assets.length, project.assets.length);
  const sidecar = JSON.parse(await readFile(path.join(f.root, 'text-results', image.requestId + '.json'), 'utf8'));
  assert.equal(sidecar.projectId, project.id); assert.equal(sidecar.images[0].assetId, project.assets.at(-1).id);
  const persisted = JSON.parse(await readFile(path.join(f.root, 'projects.json'), 'utf8')); assert.equal(persisted.projects.find(item => item.id === project.id).graph.nodes.at(-1).aiConfig.images[0].requestId, image.requestId);
});

test('包含技能与 AI 回复图片的工程在最终保存失败时恢复原技能库并清理新图片索引', async t => {
  const f = await studio(t, { projectLimit: () => 1 }); await attachExtras(f);
  const bytes = await f.exportArchive(), beforeFiles = (await readdir(path.join(f.root, 'assets'))).sort(), beforePreviews = (await readdir(path.join(f.root, 'text-results'))).sort();
  const beforeSkills = JSON.parse(await readFile(path.join(f.root, 'skills.json'), 'utf8'));
  const response = await f.importArchive(bytes); assert.equal(response.status, 409);
  assert.equal(f.app.store.list().length, 1);
  assert.deepEqual((await readdir(path.join(f.root, 'assets'))).sort(), beforeFiles);
  assert.deepEqual((await readdir(path.join(f.root, 'text-results'))).sort(), beforePreviews);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, 'skills.json'), 'utf8')), beforeSkills);
});
