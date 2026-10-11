import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_VIDEO_PROMPT_LENGTH, normalizePromptMentions, updatePromptMentions, insertReferenceMention,
  remapPromptMentions, invalidPromptMentions } from '../public/prompt-mentions.js';

const image = (id, extra = {}) => ({ kind: 'image', assetId: 'asset-' + id, refId: 'ref-' + id, name: id + '.png', ...extra });
const video = (id, extra = {}) => ({ kind: 'video', assetId: 'asset-' + id, refId: 'ref-' + id, name: id + '.mp4', ...extra });
const connected = (id, kind = 'image') => ({ ...(kind === 'image' ? image(id) : video(id)), nodeId: 'node-' + id });
const scene = (prompt, mentions) => ({ videoPrompt: prompt, promptMentions: mentions });
const bind = (prompt, refs) => updatePromptMentions('', prompt, [], refs);

test('typed image and video references get independent numbers and stable identities', () => {
  const refs = [connected('a'), connected('v', 'video'), connected('b'), connected('w', 'video')];
  const prompt = '让@图片2的人物复现@视频1的动作，色彩参考@图片1，结束参考@视频2。';
  const mentions = bind(prompt, refs);
  assert.deepEqual(mentions.map(item => [item.key, item.kind, item.label]), [
    ['node:node-b', 'image', '图片2'], ['node:node-v', 'video', '视频1'],
    ['node:node-a', 'image', '图片1'], ['node:node-w', 'video', '视频2'],
  ]);
  assert.equal(invalidPromptMentions(scene(prompt, mentions), refs).length, 0);
});

test('menu insertion replaces an @ query and moves later references without changing their identities', () => {
  const refs = [connected('a'), connected('b')], prompt = '参考@图，然后看@图片2。';
  const mentions = bind(prompt, refs), range = { start: 2, end: 4 };
  const inserted = insertReferenceMention(prompt, mentions, range, refs[0], refs);
  assert.equal(inserted.prompt, '参考@图片1，然后看@图片2。');
  assert.equal(inserted.caret, 6);
  assert.deepEqual(inserted.mentions.map(item => item.key), ['node:node-a', 'node:node-b']);
  assert.equal(inserted.prompt.slice(inserted.mentions[1].start, inserted.mentions[1].end), '@图片2');
  assert.throws(() => insertReferenceMention(prompt, mentions, range, connected('foreign'), refs), /未连接/);
});

test('reordering references updates every repeated token while retaining the original material', () => {
  const a = connected('a'), b = connected('b'), v = connected('v', 'video'), before = [a, v, b];
  const prompt = '@图片1追随@图片2，再次看@图片1以及@视频1。', mentions = bind(prompt, before);
  const result = remapPromptMentions(prompt, mentions, before, [b, a, v]);
  assert.equal(result.prompt, '@图片2追随@图片1，再次看@图片2以及@视频1。');
  assert.deepEqual(result.mentions.map(item => item.key), mentions.map(item => item.key));
  assert.equal(invalidPromptMentions(scene(result.prompt, result.mentions), [b, a, v]).length, 0);
});

test('removing an image does not silently redirect its old token to the newly numbered image', () => {
  const a = connected('a'), b = connected('b'), prompt = '@图片1是人物，@图片2是环境。';
  const result = remapPromptMentions(prompt, bind(prompt, [a, b]), [a, b], [b]);
  assert.equal(result.prompt, '@图片1（已断开）是人物，@图片1是环境。');
  assert.deepEqual(result.mentions.map(item => [item.key, item.missing]), [['node:node-a', true], ['node:node-b', false]]);
  const issues = invalidPromptMentions(scene(result.prompt, result.mentions), [b]);
  assert.equal(issues.length, 1); assert.equal(issues[0].type, 'missing'); assert.equal(issues[0].key, 'node:node-a');
});

test('reconnection and undo recover disconnected tokens using stable identities', () => {
  const a = connected('a'), b = connected('b'), refs = [a, b], prompt = '@图片1和@图片2。';
  const disconnected = remapPromptMentions(prompt, bind(prompt, refs), refs, [b]);
  const restored = remapPromptMentions(disconnected.prompt, disconnected.mentions, [b], refs);
  assert.equal(restored.prompt, prompt);
  assert.deepEqual(restored.mentions.map(item => item.key), ['node:node-a', 'node:node-b']);
  assert.equal(invalidPromptMentions(scene(restored.prompt, restored.mentions), refs).length, 0);
  const reconnectedAtEnd = remapPromptMentions(disconnected.prompt, disconnected.mentions, [b], [b, a]);
  assert.equal(reconnectedAtEnd.prompt, '@图片2和@图片1。');
});

test('manual-to-linked and linked-to-manual keys migrate only for the same nonempty real asset', () => {
  const manual = image('a'), linked = { ...manual, nodeId: 'material-a' }, prompt = '参考@图片1';
  const first = remapPromptMentions(prompt, bind(prompt, [manual]), [manual], [linked]);
  assert.equal(first.mentions[0].key, 'node:material-a'); assert.equal(first.prompt, prompt);
  const second = remapPromptMentions(first.prompt, first.mentions, [linked], [manual]);
  assert.equal(second.mentions[0].key, 'ref:ref-a'); assert.equal(second.prompt, prompt);
  const changedAsset = { ...manual, assetId: 'another-asset', nodeId: 'other-node' };
  const rejected = remapPromptMentions(prompt, bind(prompt, [manual]), [manual], [changedAsset]);
  assert.equal(rejected.prompt, '参考@图片1（已断开）'); assert.equal(rejected.mentions[0].key, 'ref:ref-a');
  const empty = { ...manual, assetId: '' }, emptyLinked = { ...empty, nodeId: 'empty-node' };
  const emptyResult = remapPromptMentions(prompt, bind(prompt, [empty]), [empty], [emptyLinked]);
  assert.equal(emptyResult.mentions[0].key, 'ref:ref-a'); assert.equal(emptyResult.mentions[0].missing, true);
});

test('a material replacement under the same node does not silently replace the referenced asset', () => {
  const original = connected('a'), replacement = { ...original, assetId: 'replacement' }, prompt = '@图片1';
  const result = remapPromptMentions(prompt, bind(prompt, [original]), [original], [replacement]);
  assert.equal(result.prompt, '@图片1（已断开）');
  assert.equal(result.mentions[0].assetId, original.assetId);
  assert.equal(invalidPromptMentions(scene(result.prompt, result.mentions), [replacement])[0].type, 'missing');
});

test('asset renaming leaves token identity and numbering unchanged', () => {
  const before = [connected('a')], after = [{ ...before[0], name: '重新命名.png' }], prompt = '使用@图片1';
  const result = remapPromptMentions(prompt, bind(prompt, before), before, after);
  assert.equal(result.prompt, prompt); assert.equal(result.mentions[0].key, 'node:node-a');
  assert.equal(invalidPromptMentions(scene(result.prompt, result.mentions), after).length, 0);
});

test('Chinese, emoji and multi-location text edits preserve unchanged token ranges', () => {
  const refs = [connected('a'), connected('b')], prompt = '🌅先看@图片1，中间说明，最后@图片2。';
  const edited = '🌄新增内容，先看@图片1，中间更长的说明，最后@图片2！';
  const mentions = updatePromptMentions(prompt, edited, bind(prompt, refs), refs);
  assert.deepEqual(mentions.map(item => item.key), ['node:node-a', 'node:node-b']);
  for (const mention of mentions) assert.equal(edited.slice(mention.start, mention.end), '@' + mention.label);
  assert.equal(mentions[0].start, edited.indexOf('@图片1'));
  const deleted = edited.replace('@图片1，', '');
  assert.deepEqual(updatePromptMentions(edited, deleted, mentions, refs).map(item => item.key), ['node:node-b']);
});

test('editing or pasting a canonical @ number deliberately selects that current reference', () => {
  const refs = Array.from({ length: 10 }, (_, index) => connected(String(index + 1))), prompt = '看@图片1';
  const changed = updatePromptMentions(prompt, '看@图片10', bind(prompt, refs), refs);
  assert.equal(changed.length, 1); assert.equal(changed[0].key, 'node:node-10'); assert.equal(changed[0].label, '图片10');
  const pasted = bind('@图片10和@图片1和@图片10', refs);
  assert.deepEqual(pasted.map(item => item.key), ['node:node-10', 'node:node-1', 'node:node-10']);
  const invalid = updatePromptMentions('看@图片10', '看@图片11', changed, refs);
  assert.deepEqual(invalid, []); assert.equal(invalidPromptMentions(scene('看@图片11', invalid), refs)[0].type, 'unknown');
});

test('ordinary email addresses are not recognized as material mentions', () => {
  const refs = [connected('a')], prompt = '邮件 foo@example.com、hello@图片1.com、user@图片1，以及素材@图片1。';
  const mentions = bind(prompt, refs);
  assert.equal(mentions.length, 1); assert.equal(mentions[0].start, prompt.lastIndexOf('@图片1'));
  assert.equal(invalidPromptMentions(scene(prompt, mentions), refs).length, 0);
});

test('pasted disconnected tokens never bind to a different material with the same visible number', () => {
  const refs = [connected('b')], prompt = '@图片1（已断开）与@图片1';
  const mentions = bind(prompt, refs);
  assert.equal(mentions.length, 1); assert.equal(mentions[0].start, prompt.lastIndexOf('@图片1'));
  assert.equal(invalidPromptMentions(scene(prompt, mentions), refs)[0].type, 'missing');
});

test('exact replacement hint disambiguates deletion of identical disconnected tokens', () => {
  const a = connected('a'), b = connected('b'), prompt = '@图片1|@图片2';
  const first = remapPromptMentions(prompt, bind(prompt, [a, b]), [a, b], [b]);
  const disconnected = remapPromptMentions(first.prompt, first.mentions, [b], []);
  assert.equal(disconnected.prompt, '@图片1（已断开）|@图片1（已断开）');
  const end = disconnected.prompt.indexOf('|') + 1, next = disconnected.prompt.slice(end);
  const remaining = updatePromptMentions(disconnected.prompt, next, disconnected.mentions, [], { start: 0, end, text: '' });
  assert.equal(remaining.length, 1); assert.equal(remaining[0].key, 'node:node-b');
});

test('normalization rejects invalid identity, ranges, overlap and partial number matches', () => {
  const refs = [connected('a')], prompt = '@图片1 @图片1', mentions = bind(prompt, refs);
  assert.throws(() => normalizePromptMentions('bad', prompt), /格式/);
  assert.throws(() => normalizePromptMentions([{ ...mentions[0], key: 'node:' + 'a'.repeat(201) }], prompt), /格式/);
  assert.throws(() => normalizePromptMentions([{ ...mentions[0], start: -1 }], prompt), /位置/);
  assert.throws(() => normalizePromptMentions([mentions[0], mentions[0]], prompt), /重叠/);
  assert.throws(() => normalizePromptMentions([{ ...mentions[0], kind: 'video' }], prompt), /文字不一致/);
  assert.throws(() => normalizePromptMentions([{ ...mentions[0], start: 0, end: 4 }], '@图片10'), /文字不一致/);
  assert.equal(normalizePromptMentions([...mentions].reverse(), prompt)[0].start, 0);
});

test('unknown, zero, padded and incomplete reference numbers block generation', () => {
  const refs = [connected('a')], prompt = '@图片2 @视频1 @图片0 @图片01 @图片';
  const issues = invalidPromptMentions(scene(prompt, bind(prompt, refs)), refs);
  assert.equal(issues.length, 5); assert.ok(issues.every(issue => issue.type === 'unknown'));
  const stale = bind('@图片1', refs); stale[0].key = 'node:unknown';
  assert.equal(invalidPromptMentions(scene('@图片1', stale), refs)[0].type, 'missing');
  assert.equal(invalidPromptMentions(scene('@图片1', []), refs)[0].type, 'unbound');
});

test('insert and disconnect operations reject overflow without truncating or mutating prompt metadata', () => {
  const refs = [connected('a')], full = '字'.repeat(MAX_VIDEO_PROMPT_LENGTH - 1) + '@';
  assert.throws(() => insertReferenceMention(full, [], { start: full.length - 1, end: full.length }, refs[0], refs), error => error.code === 'PROMPT_LIMIT');
  const prompt = '@图片1' + '字'.repeat(MAX_VIDEO_PROMPT_LENGTH - 4), mentions = bind(prompt, refs), snapshot = structuredClone(mentions);
  assert.throws(() => remapPromptMentions(prompt, mentions, refs, []), error => error.code === 'PROMPT_LIMIT');
  assert.deepEqual(mentions, snapshot); assert.equal(prompt.length, MAX_VIDEO_PROMPT_LENGTH);
  const images = Array.from({ length: 10 }, (_, index) => connected(String(index + 1)));
  const reordered = [...images.slice(1), images[0]];
  assert.throws(() => remapPromptMentions(prompt, bind(prompt, images), images, reordered), error => error.code === 'PROMPT_LIMIT');
});

test('explicit menu insertion remains intentional next to English text and separates adjacent digits', () => {
  const refs = [connected('a')], result = insertReferenceMention('ref@123', [], { start: 3, end: 4 }, refs[0], refs);
  assert.equal(result.prompt, 'ref@图片1 123'); assert.equal(result.caret, 8);
  assert.equal(result.mentions.length, 1); assert.equal(invalidPromptMentions(scene(result.prompt, result.mentions), refs).length, 0);
});
