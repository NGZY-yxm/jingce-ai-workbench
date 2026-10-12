import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SkillLibrary, previewSkills } from '../lib/skills.mjs';
import { readSkillFiles, skillOptions, exportSkillFiles } from '../public/skills.js';
import { normalizeAiConfig, buildAiMessages, parseAiResponse } from '../public/ai-text.js';
import { normalizeReply, imageHistoryContent } from '../public/chat-images.js';
import { createProject, exportProject, importProject } from '../lib/workflow.mjs';
import { createStudio } from '../server.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const packageFiles = [
  { path: 'film/SKILL.md', content: '---\nname: 电影分镜\ndescription: >-\n  规划故事镜头，\n  输出可编辑分镜。\nallowed-tools: [python, browser]\nlicense: MIT\n---\n\n先识别主体，再规划镜头。' },
  { path: 'film/references/style.md', content: '参考规则：保持角色一致。' },
  { path: 'film/scripts/inspect.py', content: null },
];
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

async function fixture(t, providerMessage = { content: '已完成' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-skills-images-'));
  const calls = [];
  const app = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [{ name: 'model-a' }], tools: { ready: false },
    textFetcher: async (_url, options) => { calls.push(JSON.parse(options.body)); return response({ choices: [{ message: providerMessage, finish_reason: 'stop' }] }); } });
  const url = await app.start(0);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await (await fetch(url + '/api/bootstrap')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token };
  const send = async (route, method = 'GET', body) => {
    const result = await fetch(url + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await result.json(); return { status: result.status, data };
  };
  await send('/api/text-settings', 'PUT', { apiKey: 'private-fixture-key', textModel: 'model-a' });
  const { data: project } = await send('/api/projects', 'POST', { title: '技能图片测试' });
  return { app, root, url, calls, send, project };
}

test('技能 YAML、多行说明和参考资料正确解析，脚本标为外部依赖', () => {
  const [draft] = previewSkills({ files: packageFiles });
  assert.equal(draft.name, '电影分镜');
  assert.equal(draft.description, '规划故事镜头， 输出可编辑分镜。');
  assert.equal(draft.content, '先识别主体，再规划镜头。');
  assert.equal(draft.declaredTools, 'python, browser');
  assert.equal(draft.references[0].path, 'references/style.md');
  assert.deepEqual(draft.dependencies, ['scripts/inspect.py']);
});

test('多技能及嵌套技能的资料按所属目录隔离，私有文件不导入', () => {
  const drafts = previewSkills({ files: [
    { path: 'SKILL.md', content: '# 主技能\n规则' },
    { path: 'references/main.txt', content: '主资料' },
    { path: 'child/SKILL.md', content: '# 子技能\n规则' },
    { path: 'child/references/child.txt', content: '子资料' },
    { path: 'child/.env', content: 'secret' },
  ] });
  assert.equal(drafts.length, 2);
  assert.deepEqual(drafts[0].references.map(item => item.content), ['主资料']);
  assert.deepEqual(drafts[1].references.map(item => item.content), ['子资料']);
  assert.doesNotMatch(JSON.stringify(drafts), /secret/);
});

test('技能包拒绝目录穿越、重复文件、不完整 YAML 和空正文', () => {
  for (const filename of ['../SKILL.md', '/SKILL.md', 'C:/SKILL.md', 'a/../SKILL.md', 'a\\SKILL.md']) {
    assert.throws(() => previewSkills({ files: [{ path: filename, content: '# 测试' }] }), /路径|目录/);
  }
  assert.throws(() => previewSkills({ files: [packageFiles[0], packageFiles[0]] }), /重复/);
  assert.throws(() => previewSkills({ files: [{ path: 'SKILL.md', content: '---\nname: [\n---\n正文' }] }), /YAML/);
  assert.throws(() => previewSkills({ files: [{ path: 'SKILL.md', content: '---\nname: 测试\n---\n' }] }), /正文/);
});

test('技能导入、编辑、删除、恢复和再次启动保留正文与资料', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-skill-library-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = new SkillLibrary(root); await library.init();
  const [skill] = await library.import({ files: packageFiles });
  assert.equal(library.list()[0].referenceCount, 1);
  assert.ok(!Object.hasOwn(library.list()[0], 'content'));
  await library.update(skill.id, { content: '更新的规则' });
  await library.setDeleted(skill.id, true);
  assert.equal(library.list().length, 0);
  assert.throws(() => library.apply([{ role: 'user', content: '任务' }], skill.id), /已删除/);
  await library.setDeleted(skill.id, false);
  const reopened = new SkillLibrary(root); await reopened.init();
  const applied = reopened.apply([{ role: 'user', content: '任务' }], skill.id);
  assert.match(applied[0].content, /更新的规则/);
  assert.match(applied[0].content, /保持角色一致/);
  assert.match(applied[0].content, /不要声称已经执行/);
});

test('ZIP、独立 Markdown 和文件夹使用同一导入流程', async () => {
  await import('../public/jszip.js');
  const archive = new globalThis.JSZip();
  for (const file of packageFiles) archive.file(file.path, file.content || 'print(1)');
  const bytes = await archive.generateAsync({ type: 'uint8array' });
  const files = await readSkillFiles([{ name: 'skills.zip', size: bytes.length, arrayBuffer: async () => bytes }]);
  assert.equal(previewSkills({ files })[0].references.length, 1);
  const standalone = await readSkillFiles([{ name: '写作.md', text: async () => '# 写作\n规则' }]);
  assert.equal(previewSkills({ files: standalone })[0].name, '写作');
  const folder = await readSkillFiles([{ name: 'SKILL.md', webkitRelativePath: '文字/SKILL.md', text: async () => '# 文字技能\n规则' }]);
  assert.equal(previewSkills({ files: folder })[0].name, '文字技能');
  assert.match(skillOptions([{ id: 'one', name: '<script>' }], 'one'), /&lt;script&gt;/);
  assert.match(skillOptions([], 'deleted'), /所选技能已删除/);
});

test('AI 要求、输出和上游输入超过旧上限仍完整保留，包括工程导入导出', () => {
  const instruction = '长要求'.repeat(5000) + '要求结尾';
  const output = '长输出'.repeat(15000) + '输出结尾';
  const config = normalizeAiConfig({ instruction, output, skillId: 'selected-skill' });
  assert.equal(config.instruction, instruction); assert.equal(config.output, output);
  const messages = buildAiMessages({ mode: 'free', instruction, inputs: [{ label: '上游', text: output }] });
  assert.match(messages[1].content, /要求结尾/); assert.match(messages[1].content, /输出结尾/);
  assert.equal(parseAiResponse('free', output).output, output);
  const project = createProject(); project.graph.nodes.push({ id: 'ai', kind: 'ai', aiConfig: config, note: output });
  const restored = importProject(exportProject(project));
  assert.equal(restored.graph.nodes[0].aiConfig.output, output);
  assert.equal(restored.graph.nodes[0].note, output);
  assert.equal(restored.graph.nodes[0].aiConfig.skillId, 'selected-skill');
});

test('技能导出再导入保留脚本与二进制附件，附件不会送入模型', async t => {
  await import('../public/jszip.js');
  const archive = new globalThis.JSZip();
  archive.file('film/SKILL.md', packageFiles[0].content);
  archive.file('film/references/style.md', packageFiles[1].content);
  archive.file('film/scripts/inspect.py', 'print("do-not-execute")');
  archive.file('film/assets/example.png', png.slice(png.indexOf(',') + 1), { base64: true });
  const bytes = await archive.generateAsync({ type: 'uint8array' });
  const files = await readSkillFiles([{ name: 'film.zip', size: bytes.length, arrayBuffer: async () => bytes }]);
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-skill-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = new SkillLibrary(root); await library.init();
  const [skill] = await library.import({ files });
  assert.equal(skill.attachments.length, 2);
  const [restored] = previewSkills({ files: exportSkillFiles(skill) });
  assert.deepEqual(restored.attachments, skill.attachments);
  assert.deepEqual(restored.dependencies, skill.dependencies);
  assert.doesNotMatch(JSON.stringify(library.list()), /iVBOR|do-not-execute/);
  assert.doesNotMatch(JSON.stringify(library.apply([{ role: 'user', content: '任务' }], skill.id)), /iVBOR|do-not-execute/);
  assert.throws(() => previewSkills({ files: [{ path: 'SKILL.md', content: '# 技能\n规则' }, { path: 'assets/x.png', base64: 'invalid!' }] }), /附件/);
});

test('AI 卡片保存纯图片结果并过滤无效图片编号', () => {
  const images = [{ requestId: '6767d0da-f785-4c0c-8227-637f06779c8e', index: 0, name: '角色' }, { requestId: '../secret', index: 0 }];
  const config = normalizeAiConfig({ output: '', images });
  assert.equal(config.images.length, 1);
  const project = createProject(); project.graph.nodes.push({ id: 'ai-image', kind: 'ai', aiConfig: config });
  assert.deepEqual(importProject(exportProject(project)).graph.nodes[0].aiConfig.images, config.images);
});

test('图片回复解析支持结构化内容、纯图片与 Markdown，跳过代码和不安全地址', () => {
  const result = normalizeReply({ content: [{ type: 'text', text: '方案' }, { type: 'image_url', image_url: { url: png } }] });
  assert.equal(result.content, '方案'); assert.equal(result.images[0].source, png);
  const pure = normalizeReply({ content: null, images: [{ image_url: { url: png } }] });
  assert.equal(pure.images.length, 1);
  const markdown = normalizeReply({ content: '人物 ![人物](https://example.com/image.png)\n```md\n![代码](https://example.com/code.png)\n```' });
  assert.equal(markdown.images.length, 1); assert.doesNotMatch(markdown.content, /image\.png/);
  for (const href of ['javascript:alert(1)', '/api/assets/private', 'data:image/svg+xml;base64,PHN2Zz4=', 'http://example.com/image.png']) {
    assert.equal(normalizeReply({ content: '', images: [{ url: href }] }).images.length, 0);
  }
  assert.equal(imageHistoryContent({ content: '', images: [{ requestId: 'x' }] }), '[已返回 1 张图片]');
});

test('HTTP 技能应用加载资料，不存在或已删除技能在模型调用前拒绝', async t => {
  const f = await fixture(t);
  const { data: imported } = await f.send('/api/skills/import', 'POST', { files: packageFiles });
  const skillId = imported[0].id;
  const input = { projectId: f.project.id, model: 'model-a', skillId, messages: [{ role: 'user', content: '规划广告' }] };
  assert.equal((await f.send('/api/text-chat', 'POST', input)).status, 200);
  assert.match(f.calls[0].messages[0].content, /保持角色一致/);
  assert.equal(f.calls[0].messages.at(-1).content, '规划广告');
  await f.send(`/api/skills/${skillId}`, 'DELETE');
  assert.equal((await f.send('/api/text-chat', 'POST', input)).status, 404);
  assert.equal(f.calls.length, 1);
  await f.send(`/api/skills/${skillId}/restore`, 'POST', {});
  assert.equal((await f.send('/api/skills')).data.length, 1);
  for (const route of ['/skills.js', '/skills.css', '/chat-images.js', '/yaml.js', '/jszip.js']) assert.equal((await fetch(f.url + route)).status, 200);
});

test('超过 2 MB 的 AI 草稿经 HTTP 保存后完整读回', async t => {
  const f = await fixture(t);
  const output = '大'.repeat(800000) + '最终结尾';
  const graph = structuredClone(f.project.graph);
  graph.nodes.push({ id: 'large-ai', kind: 'ai', aiConfig: { instruction: output, output }, note: output });
  const saved = await f.send(`/api/projects/${f.project.id}`, 'PATCH', { revision: f.project.revision, graph });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.graph.nodes[0].aiConfig.output, output);
  const reopened = await f.send(`/api/projects/${f.project.id}`);
  assert.equal(reopened.data.graph.nodes[0].aiConfig.instruction, output);
});

test('纯图片回复可以预览及幂等加入素材库，重启后仍可读取且不重发模型请求', async t => {
  const f = await fixture(t, { content: null, images: [{ image_url: { url: png }, name: '角色参考' }] });
  const result = await f.send('/api/text-chat', 'POST', { projectId: f.project.id, model: 'model-a', messages: [{ role: 'user', content: '返回图片' }] });
  assert.equal(result.status, 200); assert.equal(result.data.images.length, 1);
  const image = result.data.images[0];
  assert.ok(!Object.hasOwn(image, 'source'));
  const preview = await fetch(f.url + image.previewUrl);
  assert.equal(preview.status, 200); assert.equal(preview.headers.get('content-type'), 'image/png');
  const added = await Promise.all([1, 2].map(() => f.send(`/api/projects/${f.project.id}/chat-images`, 'POST', image)));
  assert.equal(added[0].status, 200); assert.equal(added[0].data.asset.id, added[1].data.asset.id);
  assert.equal(f.app.store.get(f.project.id).assets.length, 1); assert.equal(f.calls.length, 1);
  assert.equal((await readdir(path.join(f.root, 'assets'))).length, 1);
  const other = (await f.send('/api/projects', 'POST', { title: '其他工程' })).data;
  assert.equal((await f.send(`/api/projects/${other.id}/chat-images`, 'POST', image)).status, 409);
  const audit = JSON.parse(await readFile(path.join(f.root, 'text-last-request.json'), 'utf8'));
  assert.equal(audit.imageCount, 1); assert.doesNotMatch(JSON.stringify(audit), /private-fixture-key|iVBOR/);
});

test('对话图片下载拒绝本机地址和伪装文件，失败不会触发新模型调用', async t => {
  const f = await fixture(t, { content: [{ type: 'image_url', image_url: { url: 'https://127.0.0.1/private.png' } }] });
  const result = await f.send('/api/text-chat', 'POST', { projectId: f.project.id, model: 'model-a', messages: [{ role: 'user', content: '图片' }] });
  assert.equal(result.status, 200);
  assert.equal((await fetch(f.url + result.data.images[0].previewUrl)).status, 502);
  assert.equal((await f.send(`/api/projects/${f.project.id}/chat-images`, 'POST', result.data.images[0])).status, 502);
  assert.equal(f.calls.length, 1); assert.equal(f.app.store.get(f.project.id).assets.length, 0);
});
