import { dump } from './yaml.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const textFile = /\.(?:md|txt|json|ya?ml|csv|tsv)$/i;
const hiddenFile = /(?:^|\/)(?:\.git|node_modules|\.env[^/]*|[^/]*\.private\.json)(?:\/|$)/i;

export function exportSkillFiles(skill) {
  const metadata = { name: skill.name, description: skill.description, license: skill.license, 'allowed-tools': skill.declaredTools };
  if (skill.dependencies?.length) metadata['jingce-dependencies'] = skill.dependencies;
  return [{ path: 'SKILL.md', content: `---\n${dump(metadata)}---\n\n${skill.content}` }, ...(skill.references || []), ...(skill.attachments || [])];
}

export function skillOptions(items = [], selected = '') {
  const available = items.filter(item => !item.deletedAt);
  return `<option value="">不使用技能</option>` + (selected && !available.some(item => item.id === selected)
    ? `<option value="${escapeHtml(selected)}" selected>所选技能已删除或未导入</option>` : '')
    + available.map(item => `<option value="${escapeHtml(item.id)}"${item.id === selected ? ' selected' : ''}>${escapeHtml(item.name)}</option>`).join('');
}

export function generationSkillText(skill) {
  return [`技能：${skill.name}`, skill.content,
    ...(skill.references || []).map(file => `参考资料：${file.path}\n${file.content}`)].filter(Boolean).join('\n\n');
}

export function generationSkillPrompt(prompt, skill, kind = 'image') {
  if (!skill) return prompt;
  const result = generationSkillText(skill) + `\n\n本次${kind === 'video' ? '视频' : '图片'}生成要求：\n` + prompt;
  if (result.length > 4000) throw new Error('合并技能、参考资料和生成要求后，提示词超过 4000 个字符，请缩短技能或提示词。');
  return result;
}

export function generationSkillIssue(items = [], selected = '', prompt, kind = 'image') {
  if (!selected) return '';
  const skill = items.find(item => item.id === selected && !item.deletedAt);
  if (!skill) return '所选技能已删除或未导入，请恢复或重新选择技能。';
  const length = skill.generationCharacters;
  if (typeof prompt === 'string' && Number.isFinite(length)
      && length + `\n\n本次${kind === 'video' ? '视频' : '图片'}生成要求：\n`.length + prompt.length > 4000) {
    return '合并技能、参考资料和生成要求后，提示词超过 4000 个字符，请缩短技能或提示词。';
  }
  return '';
}

export function generationSkillNote(items = [], selected = '') {
  if (!selected) return '';
  const issue = generationSkillIssue(items, selected);
  if (issue) return issue;
  const skill = items.find(item => item.id === selected);
  return [skill.description, '生成时应用技能的文字规则' + (skill.referenceCount ? `和 ${skill.referenceCount} 份文字参考资料。` : '。'),
    skill.dependencies?.length || skill.declaredTools ? '脚本和外部工具需手动运行。' : ''].filter(Boolean).join(' ');
}

export function generationSkillControl(items, selected, { field, disabled = false, canvas = false, icon = '' } = {}) {
  return `<div class="generation-skill-control"><label><span class="generation-skill-label">使用技能</span><select ${field} aria-label="使用技能"${disabled ? ' disabled' : ''}>${skillOptions(items, selected)}</select></label><button type="button" class="skill-manage-button" ${canvas ? 'data-card-action="generation-manage-skills"' : 'data-generation-manage-skills'} title="管理技能库" aria-label="管理技能库">${icon}</button></div><p class="generation-skill-note honest-note"${selected ? '' : ' hidden'}>${escapeHtml(generationSkillNote(items, selected))}</p>`;
}

export async function readSkillFiles(files, Zip = globalThis.JSZip) {
  const result = [];
  let totalBytes = 0;
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      if (!Zip) throw new Error('ZIP 组件尚未加载，请刷新页面。');
      if (file.size > 64 * 1024 * 1024) throw new Error('技能 ZIP 超过 64 MB。');
      const archive = await Zip.loadAsync(await file.arrayBuffer());
      const entries = Object.values(archive.files).filter(entry => !entry.dir);
      if (entries.length > 2000) throw new Error('技能 ZIP 文件数量超过 2000。');
      const total = entries.reduce((bytes, entry) => bytes + (entry._data?.uncompressedSize || 0), 0);
      totalBytes += total;
      if (totalBytes > 64 * 1024 * 1024) throw new Error('解压后的技能包超过 64 MB。');
      for (const entry of entries) {
        const filename = entry.unsafeOriginalName || entry.name;
        if (hiddenFile.test(filename)) continue;
        result.push({ path: filename, ...(textFile.test(filename) ? { content: await entry.async('string') } : { base64: await entry.async('base64') }) });
      }
    } else {
      const filename = file.webkitRelativePath || file.name;
      if (hiddenFile.test(filename)) continue;
      totalBytes += file.size || 0;
      if (totalBytes > 64 * 1024 * 1024) throw new Error('技能文件超过 64 MB。');
      let data;
      if (textFile.test(filename)) data = { content: await file.text() };
      else {
        const bytes = new Uint8Array(await file.arrayBuffer()), chunks = [];
        for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
        data = { base64: btoa(chunks.join('')) };
      }
      result.push({ path: filename, ...data, standalone: !file.webkitRelativePath });
    }
    if (result.length > 2000) throw new Error('技能包文件数量超过 2000。');
  }
  return result;
}

export function createSkillLibrary({ document, api, getState, onChange, toast, icon }) {
  const $ = selector => document.querySelector(selector);
  let all = [], selectedId = '', editing = null, pendingFiles = [], drafts = [], busy = false;
  const status = (message = '', error = false) => {
    const element = $('#skill-status');
    if (element) { element.textContent = message; element.classList.toggle('error', error); }
  };
  const work = async operation => {
    if (busy) return;
    busy = true; status();
    try { await operation(); }
    catch (error) { status(error.message, true); toast(error.message, true); }
    finally { busy = false; }
  };
  async function refresh() {
    all = await api('/api/skills?includeDeleted=1');
    getState().skills = all.filter(item => !item.deletedAt);
    onChange(); renderList();
  }
  function renderList() {
    const query = ($('#skill-search')?.value || '').trim().toLowerCase(), deleted = Boolean($('#skill-show-deleted')?.checked);
    const filtered = all.filter(item => Boolean(item.deletedAt) === deleted
      && `${item.name}\n${item.description}`.toLowerCase().includes(query));
    const list = $('#skill-list');
    if (!list) return;
    list.innerHTML = filtered.length ? filtered.map(item => `<button type="button" class="skill-row${selectedId === item.id ? ' selected' : ''}" data-skill-id="${escapeHtml(item.id)}" aria-pressed="${selectedId === item.id}"><span>${icon('BookOpen')}</span><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.description || '未填写说明')}</small><span class="skill-row-meta">${item.referenceCount} 份资料 · ${item.characters.toLocaleString('zh-CN')} 字符${item.dependencies?.length || item.declaredTools ? ' · 含外部依赖' : ''}</span></span></button>`).join('')
      : `<p class="skill-empty">${query ? '没有匹配的技能。' : deleted ? '没有已删除技能。' : '暂无技能'}</p>`;
    $('#skill-count').textContent = String(all.filter(item => !item.deletedAt).length);
  }
  function showEditor(item) {
    editing = item; selectedId = item.id || ''; renderList();
    $('#skill-editor-empty').hidden = true; $('#skill-editor').hidden = false;
    $('#skill-name').value = item.name; $('#skill-description').value = item.description || '';
    $('#skill-license').value = item.license || ''; $('#skill-content').value = item.content || '';
    $('#skill-source').textContent = item.source || '本机创建';
    $('#skill-dependencies').textContent = item.dependencies?.length || item.declaredTools
      ? `文字规则可用；外部依赖：${[...(item.dependencies || []), item.declaredTools || ''].filter(Boolean).join('、')}`
      : '文字规则与参考资料';
    $('#skill-references').innerHTML = (item.references || []).map((file, index) => `<details><summary>${escapeHtml(file.path)}</summary><textarea data-skill-reference="${index}" aria-label="参考资料 ${escapeHtml(file.path)}" rows="8">${escapeHtml(file.content)}</textarea></details>`).join('') || '<p class="skill-empty">没有附带参考资料。</p>';
    for (const control of [$('#skill-name'), $('#skill-description'), $('#skill-license'), $('#skill-content'), ...$('#skill-references').querySelectorAll('textarea')]) control.disabled = Boolean(item.deletedAt);
    $('#skill-save').hidden = Boolean(item.deletedAt); $('#skill-delete').hidden = !item.id || Boolean(item.deletedAt);
    $('#skill-restore').hidden = !item.deletedAt; $('#skill-export').hidden = !item.id;
    status();
  }
  async function select(id) { showEditor(await api(`/api/skills/${encodeURIComponent(id)}`)); }
  async function preview(files) {
    pendingFiles = await readSkillFiles(files);
    drafts = await api('/api/skills/preview', 'POST', { files: pendingFiles });
    $('#skill-import-preview').innerHTML = drafts.map(item => `<article class="skill-import-item"><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.description || item.source)}</p><small>${item.references.length} 份资料${item.dependencies.length || item.declaredTools ? ' · 含外部依赖' : ''}</small><details><summary>技能正文</summary><pre>${escapeHtml(item.content)}</pre></details></article>`).join('');
    $('#skill-import-dialog').showModal();
  }
  $('#skill-search')?.addEventListener('input', renderList);
  $('#skill-show-deleted')?.addEventListener('change', renderList);
  $('#skill-list')?.addEventListener('click', event => {
    const row = event.target.closest('[data-skill-id]');
    if (row) work(() => select(row.dataset.skillId));
  });
  $('#skill-import-files')?.addEventListener('click', () => $('#skill-file-input').click());
  $('#skill-import-folder')?.addEventListener('click', () => $('#skill-folder-input').click());
  for (const id of ['skill-file-input', 'skill-folder-input']) $('#'+id)?.addEventListener('change', event => {
    const files = [...event.target.files]; event.target.value = '';
    if (files.length) work(() => preview(files));
  });
  $('#skill-new')?.addEventListener('click', () => showEditor({ name: '', content: '', references: [], dependencies: [] }));
  $('#skill-cancel-import')?.addEventListener('click', () => $('#skill-import-dialog').close());
  $('#skill-confirm-import')?.addEventListener('click', () => work(async () => {
    const items = await api('/api/skills/import', 'POST', { files: pendingFiles });
    $('#skill-import-dialog').close(); pendingFiles = []; drafts = [];
    await refresh(); await select(items[0].id); toast(`已导入 ${items.length} 个技能。`);
  }));
  $('#skill-editor')?.addEventListener('submit', event => {
    event.preventDefault(); work(async () => {
      const input = { name: $('#skill-name').value.trim(), description: $('#skill-description').value.trim(),
        license: $('#skill-license').value.trim(), content: $('#skill-content').value,
        references: (editing?.references || []).map((file, index) => ({ ...file, content: $(`[data-skill-reference="${index}"]`)?.value ?? file.content })) };
      if (!input.name || !input.content.trim()) throw new Error('请填写技能名称和正文。');
      const saved = editing?.id ? await api(`/api/skills/${editing.id}`, 'PUT', input)
        : (await api('/api/skills/import', 'POST', { files: [{ path: 'SKILL.md', content: `---\n${dump({ name: input.name, description: input.description, license: input.license })}---\n\n${input.content}` }] }))[0];
      await refresh(); showEditor(saved); toast('技能已保存。');
    });
  });
  $('#skill-delete')?.addEventListener('click', () => work(async () => {
    const saved = await api(`/api/skills/${editing.id}`, 'DELETE'); await refresh(); showEditor(saved); toast('技能已移到已删除，可恢复。');
  }));
  $('#skill-restore')?.addEventListener('click', () => work(async () => {
    const saved = await api(`/api/skills/${editing.id}/restore`, 'POST', {}); $('#skill-show-deleted').checked = false;
    await refresh(); showEditor(saved); toast('技能已恢复。');
  }));
  $('#skill-export')?.addEventListener('click', () => work(async () => {
    const { skill } = await api(`/api/skills/${editing.id}/export`), archive = new globalThis.JSZip();
    const root = archive.folder('skill');
    for (const file of exportSkillFiles(skill)) root.file(file.path, file.content ?? file.base64, { base64: typeof file.base64 === 'string' });
    const url = URL.createObjectURL(await archive.generateAsync({ type: 'blob' })), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${skill.name.replace(/[\\/:*?"<>|]/g, '_')}.zip`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }));
  return { render: () => { renderList(); }, refresh };
}
