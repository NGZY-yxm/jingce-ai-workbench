import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { load, JSON_SCHEMA } from '../public/yaml.js';
import { atomicJson } from './store.mjs';
import { InputError } from './workflow.mjs';

const textFile = /\.(?:md|txt|json|ya?ml|csv|tsv)$/i;
const ignoredPath = /(?:^|\/)(?:\.git|node_modules|\.env[^/]*|[^/]*\.private\.json)(?:\/|$)/i;
const clean = value => typeof value === 'string' ? value.trim() : '';
const maxPackageBytes = 64 * 1024 * 1024;

function storedFile(file) {
  const filename = filePath(file?.path);
  if (ignoredPath.test(filename)) throw new InputError('技能包不能包含私有配置文件。');
  if (typeof file.content === 'string') return { path: filename, content: file.content };
  if (typeof file.base64 === 'string' && /^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(file.base64)) {
    return { path: filename, base64: file.base64 };
  }
  throw new InputError('技能附件内容不正确。');
}

function checkPackageSize(files) {
  if (files.length > 2000) throw new InputError('技能包文件数量超过 2000。');
  const bytes = files.reduce((total, file) => total + (typeof file?.content === 'string' ? Buffer.byteLength(file.content, 'utf8') : Math.ceil((file?.base64?.length || 0) * 3 / 4)), 0);
  if (bytes > maxPackageBytes) throw new InputError('技能包超过 64 MB。', 413);
}

function filePath(value) {
  if (typeof value !== 'string' || !value || /[\0:\\]/.test(value) || value.startsWith('/')) throw new InputError('技能文件路径不正确。');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new InputError('技能文件路径不能越出技能目录。');
  return value;
}

function documentParts(content) {
  const source = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const frontmatter = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(source);
  if (!frontmatter) return { metadata: {}, body: source.trim() };
  let metadata;
  try { metadata = load(frontmatter[1], { schema: JSON_SCHEMA, json: false }) || {}; }
  catch { throw new InputError('SKILL.md 的 YAML 信息格式不正确，请检查名称和说明。'); }
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw new InputError('技能信息需要使用 YAML 对象。');
  return { metadata, body: source.slice(frontmatter[0].length).trim() };
}

export function previewSkills(input) {
  if (!Array.isArray(input?.files) || !input.files.length) throw new InputError('请选择 SKILL.md、Markdown 文件或技能文件夹。');
  checkPackageSize(input.files);
  const seen = new Set();
  const files = input.files.map(file => {
    const filename = filePath(file?.path);
    if (seen.has(filename)) throw new InputError('技能包中存在重复文件路径。');
    seen.add(filename);
    return { path: filename, content: typeof file.content === 'string' ? file.content : null,
      ...(typeof file.base64 === 'string' ? { base64: file.base64 } : {}), standalone: file.standalone === true };
  }).filter(file => !ignoredPath.test(file.path));
  let entries = files.filter(file => /(?:^|\/)SKILL\.md$/i.test(file.path));
  if (!entries.length) entries = files.filter(file => file.standalone && /\.md$/i.test(file.path));
  if (!entries.length && files.length === 1 && /\.md$/i.test(files[0].path)) entries = files;
  if (!entries.length) throw new InputError('技能包中未找到 SKILL.md。');
  return entries.map(entry => {
    if (!clean(entry.content)) throw new InputError(`${entry.path} 没有可用的文字内容。`);
    const root = entry.path.slice(0, entry.path.lastIndexOf('/') + 1);
    const related = entry.standalone ? [] : files.filter(file => !entries.includes(file) && file.path.startsWith(root)
      && !entries.some(other => other !== entry && other.path.slice(0, other.path.lastIndexOf('/') + 1).length > root.length
        && file.path.startsWith(other.path.slice(0, other.path.lastIndexOf('/') + 1))));
    const { metadata, body } = documentParts(entry.content);
    if (!body) throw new InputError(`${entry.path} 没有技能正文。`);
    const references = related.filter(file => textFile.test(file.path) && file.content !== null && !/^scripts\//i.test(file.path.slice(root.length)))
      .map(file => ({ path: file.path.slice(root.length), content: file.content }));
    const externalFiles = related.filter(file => !references.some(reference => root + reference.path === file.path));
    const dependencies = [...new Set([...externalFiles.map(file => file.path.slice(root.length)),
      ...(Array.isArray(metadata['jingce-dependencies']) ? metadata['jingce-dependencies'].map(filePath).filter(filename => !ignoredPath.test(filename)) : [])])];
    const attachments = externalFiles.filter(file => file.content !== null || typeof file.base64 === 'string')
      .map(file => storedFile({ ...file, path: file.path.slice(root.length) }));
    const declaredTools = clean(metadata['allowed-tools']) || (Array.isArray(metadata['allowed-tools']) ? metadata['allowed-tools'].join(', ') : '');
    return { name: clean(metadata.name) || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || root.split('/').filter(Boolean).at(-1) || entry.path.replace(/\.md$/i, ''),
      description: clean(metadata.description), content: body, references, dependencies, attachments,
      source: entry.path, license: clean(metadata.license), declaredTools, mode: 'instructions' };
  });
}

function validateSkill(value) {
  const name = clean(value?.name), content = clean(value?.content);
  if (!name || !content) throw new InputError('技能名称和正文不能为空。');
  const references = Array.isArray(value.references) ? value.references.map(file => {
    const filename = filePath(file?.path);
    if (!textFile.test(filename) || ignoredPath.test(filename) || typeof file.content !== 'string') throw new InputError('技能参考资料只支持文字文件。');
    return { path: filename, content: file.content };
  }) : [];
  if (new Set(references.map(file => file.path)).size !== references.length) throw new InputError('参考资料的文件路径重复。');
  const attachments = Array.isArray(value.attachments) ? value.attachments.map(storedFile) : [];
  const filePaths = ['SKILL.md', ...references.map(file => file.path), ...attachments.map(file => file.path)];
  if (new Set(filePaths).size !== filePaths.length) throw new InputError('技能资料与附件的文件路径重复。');
  checkPackageSize([{ path: 'SKILL.md', content }, ...references, ...attachments]);
  return { name, description: clean(value.description), content, references,
    attachments,
    dependencies: Array.isArray(value.dependencies) ? value.dependencies.map(filePath) : [],
    source: clean(value.source), license: clean(value.license), declaredTools: clean(value.declaredTools), mode: 'instructions' };
}

export class SkillLibrary {
  constructor(root) { this.filename = path.join(root, 'skills.json'); this.items = []; this.pending = Promise.resolve(); }
  async init() {
    try {
      this.items = JSON.parse(await readFile(this.filename, 'utf8'));
      if (!Array.isArray(this.items)) throw new Error('Invalid skills');
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('技能库无法读取，请保留 runtime/skills.json 后检查文件。'); }
  }
  list(includeDeleted = false) {
    return structuredClone(this.items.filter(item => includeDeleted || !item.deletedAt)
      .map(({ content, references, attachments, ...item }) => ({ ...item, referenceCount: references.length, characters: content.length })));
  }
  get(id, includeDeleted = false) {
    const item = this.items.find(item => item.id === id && (includeDeleted || !item.deletedAt));
    if (!item) throw new InputError('所选技能不存在或已删除，请重新选择或恢复技能。', 404);
    return structuredClone(item);
  }
  mutate(operation) {
    const action = this.pending.then(async () => {
      const next = structuredClone(this.items), result = operation(next);
      await atomicJson(this.filename, next); this.items = next;
      return structuredClone(result);
    });
    this.pending = action.catch(() => {}); return action;
  }
  import(input) {
    const drafts = previewSkills(input).map(validateSkill);
    return this.mutate(items => {
      const now = new Date().toISOString();
      const added = drafts.map(draft => ({ ...draft, id: randomUUID(), createdAt: now, updatedAt: now, deletedAt: null }));
      items.push(...added); return added;
    });
  }
  update(id, input) {
    const fields = validateSkill({ ...this.get(id), ...input });
    return this.mutate(items => {
      const item = items.find(item => item.id === id && !item.deletedAt);
      if (!item) throw new InputError('技能已删除，请先恢复。', 409);
      Object.assign(item, fields, { updatedAt: new Date().toISOString() }); return item;
    });
  }
  setDeleted(id, deleted) {
    return this.mutate(items => {
      const item = items.find(item => item.id === id);
      if (!item) throw new InputError('找不到这个技能。', 404);
      item.deletedAt = deleted ? new Date().toISOString() : null;
      item.updatedAt = new Date().toISOString(); return item;
    });
  }
  apply(messages, skillId) {
    if (!skillId) return messages;
    const skill = this.get(skillId);
    const rules = [`技能：${skill.name}`, skill.content,
      ...skill.references.map(file => `参考资料：${file.path}\n${file.content}`),
      skill.dependencies.length || skill.declaredTools ? '当前仅使用技能的文字规则和参考资料。需要外部脚本或工具才能完成的步骤，请说明所需条件，不要声称已经执行。' : '',
    ].filter(Boolean).join('\n\n');
    return [{ role: 'system', content: rules }, ...messages];
  }
}
