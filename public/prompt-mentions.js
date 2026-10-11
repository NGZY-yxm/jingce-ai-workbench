import { referenceKey, referenceLabel } from './reference-model.js';

export const MAX_VIDEO_PROMPT_LENGTH = 4000;
const DISCONNECTED = '（已断开）';
const KINDS = new Set(['image', 'video', 'audio']);

// Offsets use the textarea's UTF-16 indexes. `key` identifies the material, rather
// than its current number. assetId/refId let a manual reference become a linked
// reference (and return to a manual reference) without changing the material.
// Public API: updatePromptMentions -> array; insert -> {prompt,mentions,caret};
// remap -> {prompt,mentions}; invalidPromptMentions -> array of issue objects.
function checkedPrompt(value) {
  if (typeof value !== 'string') throw new TypeError('视频提示词必须是文字。');
  if (value.length > MAX_VIDEO_PROMPT_LENGTH) {
    const error = new RangeError('视频提示词最多 4000 字，操作后会超出限制。请先缩短提示词。');
    error.code = 'PROMPT_LIMIT'; throw error;
  }
  return value;
}
function optionalIdentity(value, name) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${name}格式不正确。`);
  return value;
}
function tokenParts(text) {
  const match = text.match(/^@(图片|视频|音频)([1-9][0-9]*)(（已断开）)?$/u);
  return match ? { kind: ({ 图片: 'image', 视频: 'video', 音频: 'audio' }[match[1]]), label: match[1] + match[2], missing: Boolean(match[3]) } : null;
}
function hasWholeToken(prompt, start, end) {
  const match = prompt.slice(start).match(/^@(图片|视频|音频)([1-9][0-9]*)(（已断开）)?/u);
  return Boolean(match && start + match[0].length === end);
}
export function normalizePromptMentions(value, prompt) {
  checkedPrompt(prompt);
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError('提示词素材引用格式不正确。');
  const result = value.map(item => {
    if (!item || typeof item !== 'object' || !Number.isInteger(item.start) || !Number.isInteger(item.end)
      || item.start < 0 || item.end <= item.start || item.end > prompt.length) throw new TypeError('提示词素材引用位置不正确。');
    const key = optionalIdentity(item.key, '素材引用身份');
    if (!/^(node|ref|asset):.+$/u.test(key)) throw new TypeError('素材引用身份格式不正确。');
    const parts = tokenParts(prompt.slice(item.start, item.end));
    if (!parts || !hasWholeToken(prompt, item.start, item.end) || (item.kind != null && item.kind !== parts.kind)) throw new TypeError('提示词素材引用和文字不一致。');
    const normalized = { start: item.start, end: item.end, key, ...parts };
    const assetId = optionalIdentity(item.assetId, '素材编号'), refId = optionalIdentity(item.refId, '参考编号');
    if (assetId) normalized.assetId = assetId;
    if (refId) normalized.refId = refId;
    return normalized;
  }).sort((a, b) => a.start - b.start);
  for (let index = 1; index < result.length; index++) {
    if (result[index].start < result[index - 1].end) throw new TypeError('提示词素材引用位置不能重叠。');
  }
  return result;
}
// One mapper per document keeps legacy asset identities consistent across scenes.
// Orphans receive opaque placeholders, never a label or a copied media identifier.
export function createPortablePromptMentionMapper(scenes) {
  const reserved = new Set(), placeholders = new Map();
  let sequence = 0;
  for (const scene of scenes || []) {
    for (const mention of scene.promptMentions || []) {
      if (/^(node|ref):/u.test(mention.key)) reserved.add(mention.key);
    }
    for (const reference of scene.references || []) {
      const key = referenceKey(reference); if (key) reserved.add(key);
      if (reference.refId) reserved.add('ref:' + reference.refId);
    }
  }
  return (mention, references = []) => {
    const { assetId, ...portable } = mention;
    if (!portable.key?.startsWith('asset:')) return portable;
    const legacyAssetId = portable.key.slice(6);
    const target = inventory(references).find(item => item.reference.assetId === legacyAssetId
      && item.reference.kind === mention.kind && (!assetId || assetId === legacyAssetId));
    delete portable.refId;
    if (target) {
      portable.key = target.key;
      if (target.reference.refId) portable.refId = target.reference.refId;
    } else {
      if (!placeholders.has(mention.key)) {
        let key;
        do { key = 'ref:portable-material-' + (++sequence); } while (reserved.has(key));
        placeholders.set(mention.key, key); reserved.add(key);
      }
      portable.key = placeholders.get(mention.key);
    }
    return portable;
  };
}
function inventory(references) {
  if (!Array.isArray(references)) return [];
  return references.map((reference, index) => ({ reference, key: referenceKey(reference), label: referenceLabel(references, index) }))
    .filter(item => item.key && KINDS.has(item.reference?.kind));
}
function mentionFor(item, start, end, missing = false, fallback = {}) {
  const result = { start, end, key: item.key, kind: item.reference.kind, label: item.label, missing };
  const assetId = item.reference.assetId || fallback.assetId, refId = item.reference.refId || item.reference.id || fallback.refId;
  if (assetId) result.assetId = assetId;
  if (refId) result.refId = refId;
  return result;
}
// Only reference-shaped @ expressions are parsed. Latin e-mail addresses and
// strings such as hello@图片1.com are left as ordinary prompt text.
function scanTokens(prompt) {
  const result = [], pattern = /@(图片|视频|音频)([0-9]*)(（已断开）)?/gu;
  for (const match of prompt.matchAll(pattern)) {
    const start = match.index, end = start + match[0].length;
    if (start && /[A-Za-z0-9_.%+@-]/u.test(prompt[start - 1])) continue;
    const after = prompt.slice(end);
    if (/^[A-Za-z0-9_]/u.test(after) || /^\.[A-Za-z]/u.test(after)) continue;
    result.push({ start, end, text: match[0], kind: ({ 图片: 'image', 视频: 'video', 音频: 'audio' }[match[1]]), label: match[1] + match[2],
      canonical: /^[1-9][0-9]*$/u.test(match[2]), missing: Boolean(match[3]) });
  }
  return result;
}
function overlap(left, right) { return left.start < right.end && right.start < left.end; }

// A caller that knows beforeinput's exact replacement can pass a fifth argument
// {start,end,text}. This disambiguates deleting one of two identical tokens with
// different material identities. Without that hint, deterministic character LCS
// preserves tokens through prefix, suffix and multiple separated text edits.
function unchangedPositions(before, after, edit) {
  const positions = new Int32Array(before.length); positions.fill(-1);
  if (edit && Number.isInteger(edit.start) && Number.isInteger(edit.end) && edit.start >= 0
    && edit.end >= edit.start && edit.end <= before.length && typeof edit.text === 'string'
    && before.slice(0, edit.start) + edit.text + before.slice(edit.end) === after) {
    for (let index = 0; index < edit.start; index++) positions[index] = index;
    const delta = edit.text.length - (edit.end - edit.start);
    for (let index = edit.end; index < before.length; index++) positions[index] = index + delta;
    return positions;
  }
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) { positions[prefix] = prefix; prefix++; }
  while (suffix < Math.min(before.length, after.length) - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) {
    positions[before.length - suffix - 1] = after.length - suffix - 1; suffix++;
  }
  const oldLength = before.length - prefix - suffix, newLength = after.length - prefix - suffix;
  if (!oldLength || !newLength) return positions;
  const columns = newLength + 1, lengths = new Uint16Array((oldLength + 1) * columns);
  for (let oldIndex = oldLength - 1; oldIndex >= 0; oldIndex--) {
    const row = oldIndex * columns, next = row + columns;
    for (let newIndex = newLength - 1; newIndex >= 0; newIndex--) lengths[row + newIndex] = before[prefix + oldIndex] === after[prefix + newIndex]
      ? lengths[next + newIndex + 1] + 1 : Math.max(lengths[next + newIndex], lengths[row + newIndex + 1]);
  }
  let oldIndex = 0, newIndex = 0;
  while (oldIndex < oldLength && newIndex < newLength) {
    if (before[prefix + oldIndex] === after[prefix + newIndex]) { positions[prefix + oldIndex] = prefix + newIndex; oldIndex++; newIndex++; }
    else if (lengths[(oldIndex + 1) * columns + newIndex] >= lengths[oldIndex * columns + newIndex + 1]) oldIndex++;
    else newIndex++;
  }
  return positions;
}
export function updatePromptMentions(oldPrompt, newPrompt, oldMentions, references, edit) {
  checkedPrompt(oldPrompt); checkedPrompt(newPrompt);
  const existing = normalizePromptMentions(oldMentions, oldPrompt), items = inventory(references), result = [];
  const positions = existing.length ? unchangedPositions(oldPrompt, newPrompt, edit) : null;
  for (const mention of existing) {
    const start = positions[mention.start]; if (start < 0) continue;
    let unchanged = true;
    for (let index = mention.start; index < mention.end; index++) {
      if (positions[index] !== start + index - mention.start) { unchanged = false; break; }
    }
    const end = start + mention.end - mention.start;
    if (unchanged && hasWholeToken(newPrompt, start, end)) result.push({ ...mention, start, end });
  }
  for (const token of scanTokens(newPrompt)) {
    if (!token.canonical || token.missing || result.some(mention => overlap(mention, token))) continue;
    const item = items.find(entry => entry.label === token.label);
    if (item) result.push(mentionFor(item, token.start, token.end));
  }
  return normalizePromptMentions(result, newPrompt);
}
export function insertReferenceMention(prompt, mentions, range, reference, references) {
  checkedPrompt(prompt);
  const normalized = normalizePromptMentions(mentions, prompt), key = referenceKey(reference);
  const item = inventory(references).find(entry => entry.key === key);
  if (!item || !item.reference.assetId) throw new TypeError('这个素材未连接到当前生成项，或尚未补选素材。');
  if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start || range.end > prompt.length) throw new TypeError('提示词插入位置不正确。');
  const token = '@' + item.label;
  // Keep an inserted number separate from pre-existing Latin letters/digits.
  const text = token + (/^[A-Za-z0-9_]/u.test(prompt.slice(range.end)) ? ' ' : '');
  const next = prompt.slice(0, range.start) + text + prompt.slice(range.end); checkedPrompt(next);
  const result = updatePromptMentions(prompt, next, normalized, references, { ...range, text })
    .filter(mention => !overlap(mention, { start: range.start, end: range.start + token.length }));
  result.push(mentionFor(item, range.start, range.start + token.length));
  return { prompt: next, mentions: normalizePromptMentions(result, next), caret: range.start + text.length };
}
function migratedReference(mention, before, after) {
  const source = before.find(item => item.key === mention.key), identity = source?.reference || mention;
  const assetId = identity.assetId || mention.assetId, refId = identity.refId || identity.id || mention.refId;
  const exact = after.find(item => item.key === mention.key && item.reference.kind === mention.kind);
  if (exact && (!assetId || !exact.reference.assetId || exact.reference.assetId === assetId)) return exact;
  // Key migrations are permitted only when both ends name the same real asset.
  if (!assetId) return null;
  const sameAsset = after.filter(item => item.reference.assetId === assetId && item.reference.kind === mention.kind);
  return sameAsset.find(item => refId && (item.reference.refId || item.reference.id) === refId) || sameAsset[0] || null;
}
export function remapPromptMentions(prompt, mentions, beforeRefs, afterRefs) {
  checkedPrompt(prompt);
  const normalized = updatePromptMentions(prompt, prompt, mentions, beforeRefs), before = inventory(beforeRefs), after = inventory(afterRefs);
  let cursor = 0, next = ''; const result = [];
  for (const mention of normalized) {
    next += prompt.slice(cursor, mention.start);
    const item = migratedReference(mention, before, after);
    const previous = before.find(entry => entry.key === mention.key), label = item?.label || previous?.label || mention.label;
    const missing = !item?.reference.assetId, token = '@' + label + (missing ? DISCONNECTED : '');
    const start = next.length; next += token;
    result.push(item ? mentionFor(item, start, next.length, missing, mention)
      : { ...mention, start, end: next.length, label, missing: true });
    cursor = mention.end;
  }
  next += prompt.slice(cursor); checkedPrompt(next);
  return { prompt: next, mentions: normalizePromptMentions(result, next) };
}
export function invalidPromptMentions(scene, references) {
  const prompt = scene?.videoPrompt ?? '', value = scene?.promptMentions ?? scene?.videoPromptMentions ?? [];
  let mentions;
  try { mentions = normalizePromptMentions(value, prompt); }
  catch (error) { return [{ type: 'invalid', message: error.message }]; }
  const items = inventory(references), issues = [];
  for (const mention of mentions) {
    const item = items.find(entry => entry.key === mention.key);
    if (mention.missing || !item || !item.reference.assetId || (mention.assetId && mention.assetId !== item.reference.assetId)) {
      issues.push({ type: 'missing', start: mention.start, end: mention.end, key: mention.key, label: mention.label,
        message: `@${mention.label} 的素材已断开或未补选，请重新连接或删除这处引用。` });
    } else if (item.reference.kind !== mention.kind || item.label !== mention.label) {
      issues.push({ type: 'stale', start: mention.start, end: mention.end, key: mention.key, label: mention.label,
        message: `@${mention.label} 的编号已变化，请重新选择素材。` });
    }
  }
  for (const token of scanTokens(prompt)) {
    if (mentions.some(mention => overlap(mention, token))) continue;
    const exists = token.canonical && items.some(item => item.label === token.label);
    issues.push({ type: token.missing ? 'missing' : exists ? 'unbound' : 'unknown', start: token.start, end: token.end, label: token.label,
      message: token.missing ? `${token.text} 尚未恢复连接，请重新选择素材。`
        : exists ? `${token.text} 未绑定素材，请通过 @ 菜单重新选择。` : `${token.text} 没有对应的参考素材，请修改编号或删除这处引用。` });
  }
  return issues;
}
