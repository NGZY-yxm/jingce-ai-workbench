import { referenceLabel, referenceKey } from './reference-model.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function mentionQuery(value, caret, selectionEnd = caret) {
  const prompt = String(value);
  if (!Number.isInteger(caret) || caret < 0 || caret > prompt.length || caret !== selectionEnd) return null;
  const before = prompt.slice(0, caret), match = before.match(/@([^\s@（）()，,。；;！？!?]{0,80})$/u);
  if (!match) return null;
  const start = before.length - match[0].length;
  // Chinese prose may be immediately followed by @图片1. Latin e-mail
  // local parts are excluded even while the user has typed only its @.
  if (start && /[A-Za-z0-9_.%+@-]/u.test(before[start - 1])) return null;
  const token = prompt.slice(start).match(/^@(图片|视频|音频)[0-9]+(?:（已断开）)?/u);
  // Choosing an existing token replaces the whole token, including a missing
  // suffix or digits after the caret, rather than leaving a broken remainder.
  const end = token && caret <= start + token[0].length ? start + token[0].length : caret;
  return { start, end, query: match[1].toLocaleLowerCase() };
}

function replacementEdit(capture, before, after) {
  if (!capture || capture.before !== before || typeof before !== 'string' || typeof after !== 'string') return undefined;
  const { start, end, inputType } = capture;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > before.length) return undefined;
  const at = (left, right) => {
    const prefix = before.slice(0, left), suffix = before.slice(right);
    if (left < 0 || right > before.length || after.length < prefix.length + suffix.length
      || !after.startsWith(prefix) || !after.endsWith(suffix)) return undefined;
    return { start: left, end: right, text: after.slice(prefix.length, after.length - suffix.length) };
  };
  if (inputType?.startsWith('insert')) return at(start, end);
  if (!inputType?.startsWith('delete')) return undefined;
  if (start !== end) {
    const edit = at(start, end); return edit?.text === '' ? edit : undefined;
  }
  const removed = before.length - after.length;
  if (removed < 0) return undefined;
  const edit = /Backward$/u.test(inputType) ? at(start - removed, end)
    : /Forward$/u.test(inputType) ? at(start, end + removed) : undefined;
  return edit?.text === '' ? edit : undefined;
}

const matchesReferenceQuery = (reference, label, query) => !query || label.toLocaleLowerCase().includes(query)
  || String(reference.name || '').toLocaleLowerCase().includes(query);

// Both the canvas card and the scene form use this controller.
export function createReferencePromptEditor({ container, getReferences, onInsert, onHighlight = () => {} }) {
  const sessions = new WeakMap(), composing = new WeakSet(), pendingEdits = new WeakMap(), compositionEdits = new WeakMap();
  const activeHighlights = new WeakMap(), insertedSelections = new WeakMap();
  let serial = 0;
  const isPrompt = target => Boolean(target?.matches?.('textarea[data-reference-prompt]'));
  const menuFor = control => control.closest('.reference-prompt-editor')?.querySelector('.reference-mention-menu');
  function setHighlight(control, reference) {
    const key = reference ? referenceKey(reference) : '';
    if (activeHighlights.get(control) === key) return;
    activeHighlights.set(control, key); onHighlight(control, reference || null);
  }
  function referenceAtOffset(control, offset) {
    const references = getReferences(control);
    for (const match of control.value.matchAll(/(^|[^A-Za-z0-9_.%+@-])@(图片|视频|音频)([1-9][0-9]*)(（已断开）)?/gu)) {
      if (match[4]) continue;
      const start = match.index + match[1].length, end = start + 1 + match[2].length + match[3].length;
      if (offset < start || offset > end) continue;
      const label = match[2] + match[3], index = references.findIndex((reference, position) => referenceLabel(references, position) === label);
      return index < 0 ? null : references[index];
    }
    return null;
  }
  function close(control) {
    const menu = menuFor(control); if (menu) { menu.hidden = true; menu.replaceChildren(); }
    sessions.delete(control); control.removeAttribute?.('aria-activedescendant'); control.setAttribute('aria-expanded', 'false');
    setHighlight(control, null);
  }
  function highlight(control, session) {
    const menu = menuFor(control); control.removeAttribute('aria-activedescendant');
    for (const option of menu?.querySelectorAll('[data-mention-index]') || []) {
      const selected = Number(option.dataset.mentionIndex) === session.active;
      option.setAttribute('aria-selected', String(selected)); option.classList.toggle('active', selected);
      if (selected) { control.setAttribute('aria-activedescendant', option.id); option.scrollIntoView?.({ block: 'nearest' }); }
    }
    setHighlight(control, session.items[session.active]?.reference || null);
  }
  function positionMenu(control, menu) {
    const wrapper = control.closest('.reference-prompt-editor'), panel = control.closest('.canvas-details-content');
    if (!panel || !menu.style || !wrapper?.getBoundingClientRect) return;
    const bounds = wrapper.getBoundingClientRect(), available = panel.getBoundingClientRect();
    const scale = bounds.width / (wrapper.offsetWidth || bounds.width) || 1;
    const below = (available.bottom - bounds.bottom - 10) / scale;
    const overlay = below < 80;
    const visibleHeight = (Math.min(bounds.bottom, available.bottom) - Math.max(bounds.top, available.top)) / scale - 12;
    menu.dataset.placement = overlay ? 'overlay' : 'below';
    menu.style.setProperty('--reference-menu-max-height', Math.max(48, Math.min(160, overlay ? visibleHeight : below)) + 'px');
    menu.style.setProperty('--reference-menu-bottom', Math.max(6, (bounds.bottom - available.bottom) / scale + 6) + 'px');
  }
  function refresh(control) {
    if (!isPrompt(control) || composing.has(control)) return;
    const menu = menuFor(control); if (!menu) return;
    const range = mentionQuery(control.value, control.selectionStart, control.selectionEnd);
    if (!range) { close(control); return; }
    const references = getReferences(control), items = references.map((reference, index) => ({ reference, label: referenceLabel(references,index) }))
      .filter(item => matchesReferenceQuery(item.reference, item.label, range.query));
    const id = menu.id || (menu.id = 'reference-mentions-' + ++serial);
    control.setAttribute('aria-controls', id); control.setAttribute('aria-autocomplete', 'list'); control.setAttribute('aria-expanded', 'true');
    const previousKey = sessions.get(control)?.items[sessions.get(control)?.active]?.reference;
    const previousIndex = items.findIndex(item => previousKey && referenceKey(item.reference) === referenceKey(previousKey));
    const active = previousIndex >= 0 && items[previousIndex].reference.assetId ? previousIndex : items.findIndex(item => item.reference.assetId);
    const session = { range, items, active }; sessions.set(control, session);
    menu.innerHTML = items.length ? '<div class="reference-mention-heading">插入引用 · ↑↓ 选择，Enter 确认</div>' + items.map((item,index) =>
      '<button type="button" role="option" tabindex="-1" id="' + id + '-' + index + '" data-mention-index="' + index + '" data-reference-key="' + escapeHtml(referenceKey(item.reference)) + '"' + (item.reference.assetId ? '' : ' disabled') + '><span class="reference-mention-icon">' + (({image:'▧',video:'▷',audio:'♫'}[item.reference.kind])) + '</span><span><strong>@' + escapeHtml(item.label) + '</strong><small>' + escapeHtml(item.reference.name || '未命名素材') + (item.reference.assetId ? '' : ' · 待补选') + '</small></span></button>').join('')
      : '<p class="reference-mention-empty">' + (references.length ? '没有匹配素材，可输入“图片”、“视频”或“音频”。' : '先为当前生成项添加参考素材，再输入 @ 选择。') + '</p>';
    menu.hidden = false; positionMenu(control,menu); highlight(control,session);
  }
  function currentSession(control) {
    const current = mentionQuery(control.value, control.selectionStart, control.selectionEnd), previous = sessions.get(control);
    if (!current) { close(control); return null; }
    if (!previous || ['start','end','query'].some(field => previous.range[field] !== current[field])) refresh(control);
    return sessions.get(control) || null;
  }
  function captureEdit(event) {
    const control = event.target; if (!isPrompt(control)) return;
    let start = control.selectionStart, end = control.selectionEnd;
    const base = compositionEdits.get(control), inputType = event.inputType || '';
    if (base && (composing.has(control) || /Composition/u.test(inputType))) {
      const prefix = base.before.slice(0, base.start), suffix = base.before.slice(base.end), value = control.value;
      if (value.startsWith(prefix) && value.endsWith(suffix) && value.length >= prefix.length + suffix.length) {
        start = base.start; end = value.length - suffix.length;
      }
    } else if (!event.isComposing) compositionEdits.delete(control);
    pendingEdits.set(control, { before: control.value, start, end, inputType, event });
  }
  function takeEdit(control, before, after) {
    const pending = pendingEdits.get(control); pendingEdits.delete(control);
    let edit = pending?.event.defaultPrevented ? undefined : replacementEdit(pending, before, after);
    const base = compositionEdits.get(control);
    if (!edit && base) edit = replacementEdit({ ...base, inputType: 'insertCompositionText' }, before, after);
    if (!composing.has(control)) compositionEdits.delete(control);
    return edit;
  }
  function insert(control, reference, range) {
    const references = getReferences(control);
    const available = references.find(item => referenceKey(item) === referenceKey(reference));
    if (!available?.assetId) return false;
    const query = mentionQuery(control.value, control.selectionStart, control.selectionEnd);
    const pendingRange = query && references.some((item, index) => matchesReferenceQuery(item, referenceLabel(references,index), query.query)) ? query : null;
    const selected = range || pendingRange || { start: control.selectionStart ?? control.value.length, end: control.selectionEnd ?? control.value.length };
    const inserted = onInsert(control, available, selected);
    if (inserted !== false) {
      insertedSelections.set(control, { value: control.value, start: control.selectionStart, end: control.selectionEnd });
      close(control); control.focus({ preventScroll: true }); return true;
    }
    return false;
  }
  container.addEventListener('beforeinput', captureEdit);
  container.addEventListener('input', event => { if (isPrompt(event.target) && !event.isComposing) {
    insertedSelections.delete(event.target); refresh(event.target);
  } });
  container.addEventListener('compositionstart', event => { if (isPrompt(event.target)) {
    const control = event.target; composing.add(control); pendingEdits.delete(control);
    compositionEdits.set(control, { before: control.value, start: control.selectionStart, end: control.selectionEnd }); close(control);
  } });
  container.addEventListener('compositionend', event => { if (isPrompt(event.target)) {
    composing.delete(event.target);
    if (document.activeElement === event.target) refresh(event.target); else close(event.target);
  } });
  container.addEventListener('click', event => {
    if (isPrompt(event.target)) { insertedSelections.delete(event.target); refresh(event.target); return; }
    const option = event.target.closest?.('[data-mention-index]'); if (!option || option.disabled) return;
    const control = option.closest('.reference-prompt-editor')?.querySelector('textarea[data-reference-prompt]');
    const item = sessions.get(control)?.items[Number(option.dataset.mentionIndex)], session = control && currentSession(control);
    if (item && session) { event.preventDefault(); event.stopPropagation(); insert(control, item.reference, session.range); }
  });
  container.addEventListener('pointerdown', event => { if (event.target.closest?.('[data-mention-index]')) { event.preventDefault(); event.stopPropagation(); } });
  container.addEventListener('pointermove', event => {
    const control = event.target;
    if (!isPrompt(control)) return;
    const position = document.caretPositionFromPoint?.(event.clientX, event.clientY);
    setHighlight(control, position?.offsetNode === control ? referenceAtOffset(control, position.offset) : null);
  });
  container.addEventListener('pointerout', event => {
    if (isPrompt(event.target) && !isPrompt(event.relatedTarget)) setHighlight(event.target, null);
  });
  container.addEventListener('select', event => {
    const control = event.target; if (!isPrompt(control)) return;
    const inserted = insertedSelections.get(control);
    if (inserted && inserted.value === control.value && inserted.start === control.selectionStart && inserted.end === control.selectionEnd) return;
    insertedSelections.delete(control); refresh(control);
  });
  container.addEventListener('keyup', event => {
    if (isPrompt(event.target) && (['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.key)
      || (event.key?.toLowerCase() === 'a' && (event.ctrlKey || event.metaKey)))) refresh(event.target);
  });
  container.addEventListener('keydown', event => {
    const control = event.target; if (!isPrompt(control) || event.isComposing || composing.has(control)) return;
    if (!sessions.has(control)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(control); return; }
    const session = currentSession(control); if (!session) return;
    const selectable = session.items.map((item,index) => item.reference.assetId ? index : -1).filter(index => index >= 0);
    if (!selectable.length) return;
    if (['ArrowDown','ArrowUp'].includes(event.key) && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.stopPropagation();
      const current = selectable.indexOf(session.active), offset = event.key === 'ArrowDown' ? 1 : -1;
      session.active = selectable[(current + offset + selectable.length) % selectable.length]; highlight(control,session);
    }
    if (['Enter','Tab'].includes(event.key) && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const item = session.items[session.active]; if (!item) return;
      event.preventDefault(); event.stopPropagation(); insert(control,item.reference,session.range);
    }
  });
  container.addEventListener('focusout', event => { if (isPrompt(event.target)) queueMicrotask(() => { if (document.activeElement !== event.target) close(event.target); }); });
  return { refresh, close, insert, takeEdit };
}
