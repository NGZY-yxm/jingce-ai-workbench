import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionQuery, createReferencePromptEditor } from '../public/prompt-editor.js';
import { referenceLabel, referenceKey } from '../public/reference-model.js';
import { updatePromptMentions } from '../public/prompt-mentions.js';

// Small event/DOM harness for this controller, not a browser simulation.
// It models only APIs that prompt-editor.js reads and writes.
class Element {
  constructor(tag, classes = []) {
    this.tagName = tag.toUpperCase(); this.attributes = new Map(); this.dataset = {}; this.children = [];
    this.parentElement = null; this.hidden = false; this.disabled = false; this.id = '';
    const names = new Set(classes);
    this.classList = { contains: value => names.has(value), toggle: (value, enabled) => enabled ? names.add(value) : names.delete(value) };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  matches(selector) {
    if (selector === 'textarea[data-reference-prompt]') return this.tagName === 'TEXTAREA' && this.attributes.has('data-reference-prompt');
    if (selector === '[data-mention-index]') return this.dataset.mentionIndex != null;
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    return false;
  }
  closest(selector) { let current = this; while (current && !current.matches(selector)) current = current.parentElement; return current; }
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  replaceChildren() { this.children = []; this._html = ''; }
  set innerHTML(html) {
    this._html = html; this.children = [];
    for (const match of html.matchAll(/<button\b([^>]*)>[\s\S]*?<\/button>/gu)) {
      const option = this.append(new Element('button'));
      for (const attribute of match[1].matchAll(/([\w-]+)(?:="([^"]*)")?/gu)) {
        const [, name, value = ''] = attribute; option.setAttribute(name, value);
        if (name === 'id') option.id = value;
        if (name === 'data-mention-index') option.dataset.mentionIndex = value;
        if (name === 'disabled') option.disabled = true;
      }
      option.append(new Element('span'));
    }
  }
  get innerHTML() { return this._html || ''; }
  scrollIntoView(options) { this.scrolled = options; }
  focus(options) { globalThis.document.activeElement = this; this.focusOptions = options; }
}
function harness(t, initialReferences, initialPrompt = '参考@') {
  const previousDocument = globalThis.document; globalThis.document = { activeElement: null };
  t.after(() => { globalThis.document = previousDocument; });
  const container = new Element('div'), wrapper = container.append(new Element('div', ['reference-prompt-editor']));
  const control = wrapper.append(new Element('textarea')); control.setAttribute('data-reference-prompt', '');
  control.value = initialPrompt; control.selectionStart = control.selectionEnd = initialPrompt.length;
  const menu = wrapper.append(new Element('div', ['reference-mention-menu'])); menu.hidden = true;
  const listeners = new Map(), inserts = [], highlights = []; let references = initialReferences;
  container.addEventListener = (type, handler) => { const handlers = listeners.get(type) || []; handlers.push(handler); listeners.set(type, handlers); };
  const controller = createReferencePromptEditor({ container, getReferences: () => references,
    onHighlight(_control, reference) { highlights.push(reference ? referenceKey(reference) : null); },
    onInsert(target, reference, range) {
      inserts.push({ target, reference, range: { ...range } });
      const index = references.findIndex(item => referenceKey(item) === referenceKey(reference)), token = '@' + referenceLabel(references, index);
      target.value = target.value.slice(0, range.start) + token + target.value.slice(range.end);
      target.selectionStart = target.selectionEnd = range.start + token.length;
      return true;
    } });
  const fire = (type, properties = {}) => {
    const event = { target: control, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...properties };
    for (const handler of listeners.get(type) || []) handler(event);
    return event;
  };
  control.focus();
  return { container, control, menu, controller, inserts, highlights, fire, setReferences(value) { references = value; },
    type(value, caret = value.length) { control.value = value; control.selectionStart = control.selectionEnd = caret; fire('input'); } };
}
const image = (id, assetId = 'asset-' + id) => ({ refId: id, kind: 'image', assetId, name: id + '.png' });
const video = (id, assetId = 'asset-' + id) => ({ refId: id, kind: 'video', assetId, name: id + '.mp4' });


test('query ranges use textarea indexes and do not open for ordinary email addresses', () => {
  assert.deepEqual(mentionQuery('🌅参考@图片', 7), { start: 4, end: 7, query: '图片' });
  assert.equal(mentionQuery('name@example.com', 16), null);
  assert.equal(mentionQuery('hello@图片1.com', 13), null);
  assert.equal(mentionQuery('@图片', 3, 1), null);
  assert.deepEqual(mentionQuery('文字\n@', 4), { start: 3, end: 4, query: '' });
});

test('CJK text before a numbered reference still permits filtering the mention menu', () => {
  assert.deepEqual(mentionQuery('参考@图片1', 6), { start: 2, end: 6, query: '图片1' });
});

test('CJK composition does not swallow Enter, and suggestions return after composition ends', t => {
  const ui = harness(t, [image('人物'), image('背景')]); ui.fire('input'); assert.equal(ui.menu.hidden, false);
  ui.fire('compositionstart'); assert.equal(ui.menu.hidden, true);
  ui.control.value = '参考@图片'; ui.control.selectionStart = ui.control.selectionEnd = 5;
  ui.fire('input', { isComposing: true });
  const enterDuringComposition = ui.fire('keydown', { key: 'Enter', isComposing: false });
  assert.equal(enterDuringComposition.defaultPrevented, false); assert.equal(ui.inserts.length, 0);
  ui.fire('compositionend'); assert.equal(ui.menu.hidden, false);
  const enter = ui.fire('keydown', { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true); assert.equal(ui.inserts.length, 1);
  assert.deepEqual(ui.inserts[0].range, { start: 2, end: 5, query: '图片' });
  assert.equal(ui.control.value, '参考@图片1'); assert.equal(ui.menu.hidden, true);
});

test('up/down cycle through available assets and Enter inserts the selected material at the current query', t => {
  const ui = harness(t, [image('人物'), video('待补选', ''), image('环境'), video('动作')]); ui.fire('input');
  const options = ui.menu.querySelectorAll('[data-mention-index]'); assert.equal(options.length, 4); assert.equal(options[1].disabled, true);
  ui.fire('keydown', { key: 'ArrowDown' }); assert.equal(options[2].getAttribute('aria-selected'), 'true');
  ui.fire('keydown', { key: 'ArrowDown' }); assert.equal(options[3].getAttribute('aria-selected'), 'true');
  ui.fire('keydown', { key: 'ArrowDown' }); assert.equal(options[0].getAttribute('aria-selected'), 'true');
  ui.fire('keydown', { key: 'ArrowUp' }); assert.equal(options[3].getAttribute('aria-selected'), 'true');
  const enter = ui.fire('keydown', { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true); assert.equal(ui.inserts[0].reference.refId, '动作');
  assert.deepEqual(ui.inserts[0].range, { start: 2, end: 3, query: '' }); assert.equal(ui.control.value, '参考@视频2');
});

test('@ 菜单随键盘候选切换高亮对应素材，并在关闭时清除关系', t => {
  const ui = harness(t, [image('人物'), video('动作')]); ui.fire('input');
  assert.equal(ui.highlights.at(-1), 'ref:人物');
  ui.fire('keydown', {key:'ArrowDown'});
  assert.equal(ui.highlights.at(-1), 'ref:动作');
  ui.fire('keydown', {key:'Escape'});
  assert.equal(ui.highlights.at(-1), null);
});

test('鼠标悬停到提示词中的 @素材编号时高亮来源，离开文本框后清除', t => {
  const ui = harness(t, [image('人物'), video('动作')]);
  ui.control.value = '保持@图片1外观并参考@视频1动作';
  const previous = globalThis.document.caretPositionFromPoint;
  globalThis.document.caretPositionFromPoint = () => ({offsetNode:ui.control,offset:ui.control.value.indexOf('@视频1') + 3});
  ui.fire('pointermove', {target:ui.control,clientX:40,clientY:20});
  assert.equal(ui.highlights.at(-1), 'ref:动作');
  ui.fire('pointerout', {target:ui.control,relatedTarget:new Element('button')});
  assert.equal(ui.highlights.at(-1), null);
  if (previous) globalThis.document.caretPositionFromPoint = previous; else delete globalThis.document.caretPositionFromPoint;
});

test('Tab inserts while Shift-Tab and modified Enter retain their normal behavior', t => {
  const ui = harness(t, [image('人物')]); ui.fire('input');
  assert.equal(ui.fire('keydown', { key: 'Tab', shiftKey: true }).defaultPrevented, false);
  assert.equal(ui.fire('keydown', { key: 'Enter', ctrlKey: true }).defaultPrevented, false);
  assert.equal(ui.fire('keydown', { key: 'Enter', metaKey: true }).defaultPrevented, false);
  assert.equal(ui.inserts.length, 0);
  assert.equal(ui.fire('keydown', { key: 'Tab' }).defaultPrevented, true);
  assert.equal(ui.inserts.length, 1); assert.equal(ui.control.getAttribute('aria-expanded'), 'false');
});

test('all missing asset placeholders leave Tab and Enter free and are not selectable', t => {
  const ui = harness(t, [image('人物', ''), video('动作', '')]); ui.fire('input');
  assert.equal(ui.menu.hidden, false);
  assert.ok(ui.menu.querySelectorAll('[data-mention-index]').every(option => option.disabled));
  assert.equal(ui.fire('keydown', { key: 'Tab' }).defaultPrevented, false);
  assert.equal(ui.fire('keydown', { key: 'Enter' }).defaultPrevented, false);
  const option = ui.menu.querySelector('[data-mention-index]'); ui.fire('click', { target: option });
  assert.equal(ui.inserts.length, 0);
});

test('pointer selection keeps textarea focus, prevents canvas dragging and uses the exact saved range', t => {
  const ui = harness(t, [image('人物'), image('环境')], '先看@环境，再说别的');
  ui.control.selectionStart = ui.control.selectionEnd = 5; ui.fire('input');
  const option = ui.menu.querySelector('[data-mention-index]'), child = option.children[0];
  const down = ui.fire('pointerdown', { target: child });
  assert.equal(down.defaultPrevented, true); assert.equal(down.propagationStopped, true);
  assert.equal(globalThis.document.activeElement, ui.control);
  const click = ui.fire('click', { target: child }); assert.equal(click.defaultPrevented, true);
  assert.equal(ui.inserts[0].reference.refId, '环境'); assert.deepEqual(ui.inserts[0].range, { start: 2, end: 5, query: '环境' });
  assert.equal(ui.control.value, '先看@图片2，再说别的'); assert.equal(ui.menu.hidden, true);
});

test('Escape and genuine blur dismiss suggestions and clear ARIA active selection', async t => {
  const ui = harness(t, [image('人物')]); ui.fire('input');
  assert.ok(ui.control.getAttribute('aria-activedescendant'));
  const escape = ui.fire('keydown', { key: 'Escape' }); assert.equal(escape.defaultPrevented, true);
  assert.equal(ui.menu.hidden, true); assert.equal(ui.control.getAttribute('aria-activedescendant'), null);
  ui.fire('input'); globalThis.document.activeElement = new Element('button'); ui.fire('focusout'); await Promise.resolve();
  assert.equal(ui.menu.hidden, true); assert.equal(ui.control.getAttribute('aria-expanded'), 'false');
});

test('selection change after opening a menu cannot reuse an old query range on Tab', t => {
  const ui = harness(t, [image('人物')]); ui.fire('input');
  ui.control.selectionStart = 0; ui.control.selectionEnd = ui.control.value.length;
  // Ctrl+A changes the selection without one of the currently special-cased arrow keys.
  ui.fire('keyup', { key: 'a', ctrlKey: true });
  const tab = ui.fire('keydown', { key: 'Tab' });
  assert.equal(tab.defaultPrevented, false); assert.equal(ui.inserts.length, 0);
});

test('replacing a disconnected token consumes its suffix instead of leaving an unbindable token', t => {
  const ui = harness(t, [image('新人物')], '前@图片1（已断开）后');
  ui.control.selectionStart = ui.control.selectionEnd = 5; ui.fire('input');
  ui.fire('keydown', { key: 'Enter' });
  assert.equal(ui.inserts.length, 1); assert.equal(ui.inserts[0].range.start, 1); assert.equal(ui.inserts[0].range.end, 10);
  assert.equal(ui.control.value, '前@图片1后');
});

test('refreshing a previously selected asset as missing clears the obsolete ARIA active descendant', t => {
  const ui = harness(t, [image('人物')]); ui.fire('input'); assert.ok(ui.control.getAttribute('aria-activedescendant'));
  ui.setReferences([image('人物', '')]); ui.fire('input');
  assert.equal(ui.control.getAttribute('aria-activedescendant'), null);
  assert.equal(ui.fire('keydown', { key: 'Enter' }).defaultPrevented, false); assert.equal(ui.inserts.length, 0);
});

function edited(ui, before, after, start, end, inputType, data = null) {
  ui.control.value = before; ui.control.selectionStart = start; ui.control.selectionEnd = end;
  ui.fire('beforeinput', { inputType, data }); ui.control.value = after;
  return ui.controller.takeEdit(ui.control, before, after);
}

test('beforeinput tracks ordinary insertion, replacement selection and data-less paste exactly', t => {
  const ui = harness(t, []);
  assert.deepEqual(edited(ui, '前后', '前内容后', 1, 1, 'insertText', '内容'), { start: 1, end: 1, text: '内容' });
  assert.deepEqual(edited(ui, '前旧文字后', '前替换后', 1, 4, 'insertText', '替换'), { start: 1, end: 4, text: '替换' });
  assert.deepEqual(edited(ui, '前旧文字后', '前粘贴\n多行后', 1, 4, 'insertFromPaste'), { start: 1, end: 4, text: '粘贴\n多行' });
  assert.deepEqual(edited(ui, '文字', '文字\n', 2, 2, 'insertLineBreak'), { start: 2, end: 2, text: '\n' });
  assert.equal(ui.controller.takeEdit(ui.control, '文字', '文字\n'), undefined, 'each beforeinput capture is consumed once');
});

test('backward/forward deletion uses actual UTF-16 removal length, including emoji and repeated text', t => {
  const ui = harness(t, []);
  assert.deepEqual(edited(ui, '😀😀', '😀', 2, 2, 'deleteContentBackward'), { start: 0, end: 2, text: '' });
  assert.deepEqual(edited(ui, '😀😀', '😀', 2, 2, 'deleteContentForward'), { start: 2, end: 4, text: '' });
  assert.deepEqual(edited(ui, 'aaa', 'aa', 1, 1, 'deleteContentBackward'), { start: 0, end: 1, text: '' });
  assert.deepEqual(edited(ui, 'aaa', 'aa', 1, 1, 'deleteContentForward'), { start: 1, end: 2, text: '' });
});

test('word and line deletion infer the precise range from the direction and current caret', t => {
  const ui = harness(t, []);
  assert.deepEqual(edited(ui, 'word word', 'word', 5, 5, 'deleteWordBackward'), { start: 0, end: 5, text: '' });
  assert.deepEqual(edited(ui, 'word word', 'word', 0, 0, 'deleteWordForward'), { start: 0, end: 5, text: '' });
  assert.deepEqual(edited(ui, '第一行\n第二行', '第一行\n', 7, 7, 'deleteSoftLineBackward'), { start: 4, end: 7, text: '' });
  assert.deepEqual(edited(ui, '第一行\n第二行', '第一行\n', 4, 4, 'deleteSoftLineForward'), { start: 4, end: 7, text: '' });
});

test('selection deletion and cut preserve exact ranges even when two references have identical text', t => {
  const ui = harness(t, []), token = '@图片1（已断开）', before = token + '|' + token, after = token;
  const mentions = [{ start: 0, end: token.length, key: 'ref:a', assetId: 'asset-a' },
    { start: token.length + 1, end: before.length, key: 'ref:b', assetId: 'asset-b' }];
  const forward = edited(ui, before, after, 0, 0, 'deleteContentForward');
  assert.deepEqual(forward, { start: 0, end: token.length + 1, text: '' });
  assert.equal(updatePromptMentions(before, after, mentions, [], forward)[0].key, 'ref:b');
  const cut = edited(ui, before, after, 0, token.length + 1, 'deleteByCut');
  assert.deepEqual(cut, forward); assert.equal(updatePromptMentions(before, after, mentions, [], cut)[0].key, 'ref:b');
  const backward = edited(ui, before, after, before.length, before.length, 'deleteContentBackward');
  assert.deepEqual(backward, { start: token.length, end: before.length, text: '' });
  assert.equal(updatePromptMentions(before, after, mentions, [], backward)[0].key, 'ref:a');
});

test('composition replacement tracks its whole current span rather than only the IME caret', t => {
  const ui = harness(t, [], '甲乙'); ui.control.selectionStart = ui.control.selectionEnd = 1; ui.fire('compositionstart');
  assert.deepEqual(edited(ui, '甲乙', '甲中乙', 1, 1, 'insertCompositionText', '中'), { start: 1, end: 1, text: '中' });
  assert.deepEqual(edited(ui, '甲中乙', '甲中文乙', 2, 2, 'insertCompositionText', '中文'), { start: 1, end: 2, text: '中文' });
  assert.deepEqual(edited(ui, '甲中文乙', '甲乙', 3, 3, 'deleteCompositionText'), { start: 1, end: 3, text: '' });
  ui.fire('compositionend');
});

test('IME editing also supplies a single precise edit when the app skipped intermediate composition inputs', t => {
  const ui = harness(t, [], '甲乙'); ui.control.selectionStart = ui.control.selectionEnd = 1; ui.fire('compositionstart');
  ui.fire('beforeinput', { inputType: 'insertCompositionText', data: '中' }); ui.control.value = '甲中乙';
  ui.control.selectionStart = ui.control.selectionEnd = 2;
  ui.fire('beforeinput', { inputType: 'insertCompositionText', data: '中文' }); ui.control.value = '甲中文乙';
  ui.control.selectionStart = ui.control.selectionEnd = 3; ui.fire('compositionend');
  assert.deepEqual(ui.controller.takeEdit(ui.control, '甲乙', '甲中文乙'), { start: 1, end: 1, text: '中文' });
  assert.equal(ui.controller.takeEdit(ui.control, '甲乙', '甲中文乙'), undefined);
});

test('ending composition after blur cannot reopen suggestions in an unfocused textarea', async t => {
  const ui = harness(t, [image('人物')], '@'); ui.fire('compositionstart');
  globalThis.document.activeElement = new Element('button'); ui.fire('focusout'); await Promise.resolve();
  ui.control.value = '@图片'; ui.control.selectionStart = ui.control.selectionEnd = 3;
  ui.fire('compositionend'); assert.equal(ui.menu.hidden, true); assert.equal(ui.control.getAttribute('aria-expanded'), 'false');
});

test('unknown, cancelled or nonlocal edits use the mention helper fallback instead of guessing an identity', t => {
  const ui = harness(t, []);
  assert.equal(edited(ui, '前后', '改变前后', 1, 1, 'insertText', '改变'), undefined, 'insertion happened outside the recorded range');
  assert.equal(edited(ui, '前后', '前', 2, 2, 'historyUndo'), undefined);
  assert.equal(edited(ui, '前后', '前', 2, 2, 'deleteContent'), undefined, 'direction is unknown');
  ui.control.value = '前后'; ui.control.selectionStart = ui.control.selectionEnd = 1;
  const cancelled = ui.fire('beforeinput', { inputType: 'insertText', data: '中' }); cancelled.preventDefault();
  assert.equal(ui.controller.takeEdit(ui.control, '前后', '前中后'), undefined);
  ui.control.value = '前后'; ui.fire('beforeinput', { inputType: 'insertText', data: '中' });
  assert.equal(ui.controller.takeEdit(ui.control, '不同的旧文本', '前中后'), undefined);
});

test('Shift/Ctrl arrow selection retains browser behavior and dismisses suggestions after select', t => {
  const ui = harness(t, [image('人物')]); ui.fire('input');
  assert.equal(ui.fire('keydown', { key: 'ArrowUp', shiftKey: true }).defaultPrevented, false);
  assert.equal(ui.fire('keydown', { key: 'ArrowDown', ctrlKey: true }).defaultPrevented, false);
  ui.control.selectionStart = 0; ui.control.selectionEnd = ui.control.value.length; ui.fire('select');
  assert.equal(ui.menu.hidden, true); assert.equal(ui.inserts.length, 0);
});
