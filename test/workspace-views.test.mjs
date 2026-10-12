import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import vm from 'node:vm';
import { createProject, updateProject, setAssetDeleted } from '../lib/workflow.mjs';
import { createAssetCanvasNode } from '../public/canvas.js';
import { intersectsRect } from '../public/canvas-geometry.js';
import * as videoParameters from '../public/video-parameters.js';
import * as referenceModel from '../public/reference-model.js';
import * as referenceApi from '../public/reference-api.js';
import * as promptMentions from '../public/prompt-mentions.js';
import * as promptEditor from '../public/prompt-editor.js';
import * as imageParameters from '../public/image-parameters.js';
import { renderTextMarkdown } from '../public/text-markdown.js';
import { createSkillLibrary, skillOptions } from '../public/skills.js';
import { imageHistoryContent } from '../public/chat-images.js';
import { capabilitySummary } from '../public/model-capabilities.js';
import { createCapabilityEditor } from '../public/capability-editor.js';

const views = ['overview', 'canvas', 'text', 'images', 'videos', 'assets', 'results', 'skills'];
const labels = ['项目总览', '创作画布', '创作助手', '图片生成', '视频生成', '素材库', '生成结果', '技能库'];

// Model only the DOM operations used by app.js. Rendering, routing, form
// validation and API request construction all run from the real page script.
async function pageHarness({ respond, confirm = () => true } = {}) {
  const elements = new Map(), requests = [], canvasCalls = [], downloads = [], archives = [];
  class Element {
    constructor(selector = '', tagName = 'div') {
      this.selector = selector; this.tagName = tagName.toUpperCase();
      this.id = selector.startsWith('#') && !selector.includes(' ') ? selector.slice(1) : '';
      this.dataset = {}; this.value = ''; this.textContent = ''; this.hidden = false;
      this.disabled = false; this.isConnected = true; this.children = []; this.open = false;
      this.attributes = new Map(); this.listeners = new Map(); this.options = [];
      this.style = { setProperty() {} }; this.nodeType = 1; this.readOnly = false;
      const classes = new Set(); let html = '';
      this.classList = {
        contains: value => classes.has(value), add: value => classes.add(value), remove: value => classes.delete(value),
        toggle(value, force) {
          const enabled = force === undefined ? !classes.has(value) : Boolean(force);
          if (enabled) classes.add(value); else classes.delete(value);
          return enabled;
        },
      };
      Object.defineProperty(this, 'className', { get: () => [...classes].join(' '), set: value => {
        classes.clear(); for (const name of String(value).split(/\s+/).filter(Boolean)) classes.add(name);
      } });
      Object.defineProperty(this, 'innerHTML', { get: () => html, set: value => {
        html = String(value); this.children = [];
        this.options = [...html.matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>/g)].map(match => ({ value: match[1] }));
        if (this.options.length && !this.options.some(option => option.value === this.value)) this.value = this.options[0].value;
      } });
      this.elements = new Proxy({}, { get: (_object, name) => name === 'namedItem'
        ? field => fieldElement(selector, field) : fieldElement(selector, String(name)) });
    }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    }
    async fire(type, event = {}) {
      event.target ??= this; event.currentTarget = this;
      event.preventDefault ??= function () { this.defaultPrevented = true; };
      event.stopPropagation ??= function () { this.cancelBubble = true; };
      const result = this['on' + type]?.(event);
      await result;
      for (const handler of this.listeners.get(type) || []) await handler(event);
      if (type === 'click' && this.parentElement && event.bubbles !== false && !event.cancelBubble) {
        await this.parentElement.fire(type, event);
      }
    }
    querySelector(selector) { return element(this.selector + ' ' + selector); }
    insertAdjacentHTML(position, html) { this.innerHTML = position === 'afterbegin' ? String(html) + this.innerHTML : this.innerHTML + String(html); }
    querySelectorAll() { return []; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    contains(child) { return child === this || this.children.some(item => item.contains(child)); }
    replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.innerHTML = ''; this.append(...children); }
    append(...children) {
      for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); }
    }
    insertBefore(child, reference) {
      child.remove(); child.parentElement = this;
      const index = this.children.indexOf(reference); this.children.splice(index < 0 ? this.children.length : index, 0, child);
    }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    }
    get childElementCount() { return this.children.length || (this.innerHTML ? 1 : 0); }
    closest(selector) {
      for (let current = this; current; current = current.parentElement) {
        if (selector.split(',').some(value => value[0] === '.' ? value.slice(1).split('.').every(cls => current.classList.contains(cls))
          : value[0] === '#' ? current.id === value.slice(1) : false)) return current;
      }
      return null;
    }
    showModal() { this.open = true; this.modalOpens = (this.modalOpens || 0) + 1; }
    close() {
      if (!this.open) return;
      this.open = false; this.modalCloses = (this.modalCloses || 0) + 1;
      return this.fire('close', { target: this });
    }
    reset() {
      if (this.selector === '#image-page-form') {
        element('#image-page-prompt').value = '';
        element('#image-page-model').value = element('#image-page-model').options[0]?.value || '';
        element('#image-page-count').value = '1';
        element('#image-page-quality').value = 'auto';
      }
    }
    click() { if (this.tagName === 'A' && this.download) downloads.push({ href: this.href, name: this.download }); return this.fire('click', { target: this }); }
    focus() { document.activeElement = this; }
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
    blur() { if (document.activeElement === this) document.activeElement = null; return this.fire('blur'); }
  }
  function element(selector) {
    if (!elements.has(selector)) {
      elements.set(selector, new Element(selector));
      if (selector === '#result-details-content') elements.get(selector).parentElement = element('#result-details-dialog');
    }
    return elements.get(selector);
  }
  function fieldElement(selector, name) {
    const ids = {
      '#image-page-form': { model: '#image-page-model', prompt: '#image-page-prompt', count: '#image-page-count', quality: '#image-page-quality' },
      '#image-form': { model: '#image-model', prompt: '#image-prompt', sceneId: '#image-scene-id', count: '#image-count', quality: '#image-quality' },
    };
    return element(ids[selector]?.[name] || selector + ' [name="' + name + '"]');
  }
  const panels = views.map(view => { const panel = element('#' + view + '-view'); panel.className = 'view'; return panel; });
  const tabs = views.map(view => {
    const tab = element('[data-view="' + view + '"]'); tab.dataset.view = view; tab.className = 'tab'; return tab;
  });
  const documentListeners = new Map(); let selection = null, bridge;
  const document = {
    body: new Element('body', 'body'),
    documentElement: { dataset: { theme: 'night' } }, activeElement: null,
    querySelector: element, getSelection: () => selection,
    addEventListener(type, handler) { if (!documentListeners.has(type)) documentListeners.set(type, []); documentListeners.get(type).push(handler); },
    querySelectorAll: selector => selector === '.view' ? panels : selector === '.tab' || selector === '[data-view]' ? tabs : [],
    createElement: tag => new Element('', tag),
  };
  element('#text-chat-home').append(element('#text-chat-card'));
  element('#text-chat-home').append(element('#text-chat-home .text-context-card'));
  const canvas = {
    render() { canvasCalls.push('render'); }, fit() { canvasCalls.push('fit'); },
    activate() { canvasCalls.push('activate'); }, finishEditing() { canvasCalls.push('finishEditing'); },
    reset() {}, busy: () => false, syncScenes(options) { canvasCalls.push({action:'syncScenes',options}); }, openBrief() {},
    addAsset(asset) { canvasCalls.push({ action: 'addAsset', asset: structuredClone(asset) }); return { id: 'placed-' + asset.id }; },
    setExpanded(value) { bridge.setTextChatDocked(value); },
    addPromptImage(prompt) { canvasCalls.push({ action:'addPromptImage',prompt }); return { id:'image-draft' }; },
    addPromptVideo(prompt) { canvasCalls.push({ action:'addPromptVideo',prompt }); return { id:'video-draft' }; },
  };
  let sequence = 0, harness;
  class Zip {
    constructor() { this.files = new Map(); archives.push(this); }
    file(name, data) { this.files.set(name, data); return this; }
    async generateAsync(options) { this.options = options; return new Blob(['test archive']); }
  }
  const context = vm.createContext({ document, window: { addEventListener() {}, confirm }, Blob, URL: { createObjectURL: () => 'blob:test-archive', revokeObjectURL() {} }, JSZip: Zip,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, structuredClone, console,
    ...videoParameters, ...referenceModel, ...referenceApi, ...promptMentions, ...promptEditor, ...imageParameters, renderTextMarkdown, createSkillLibrary, skillOptions, imageHistoryContent, capabilitySummary, createCapabilityEditor, createAssetCanvasNode,
    createInfiniteCanvas: value => { bridge = value; return canvas; }, setTimeout: () => 1, clearTimeout() {},
    crypto: { randomUUID: () => 'operation-' + ++sequence },
    fetch: async (url, options = {}) => {
      const request = { url, method: options.method || 'GET', headers: options.headers,
        body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body };
      requests.push(request);
      const value = request.url.startsWith('/api/skills') ? [] : respond ? await respond(request, harness) : request.url.includes('/image-jobs')
        ? harness.state.imageJobs : request.url.includes('/jobs') ? harness.state.jobs : harness.state.project;
      const status = value?.$status || 200;
      return { ok: status < 400, status, json: async () => structuredClone(value), arrayBuffer: async () => Uint8Array.from(value?.bytes || [1, 2, 3]).buffer };
    },
  });
  const script = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
    .replace(/^import[^\n]*\n/gm, '').replace(/\ninit\(\);\s*$/, '\n');
  vm.runInContext(script + '\nglobalThis.harness={state,setView,setProject,refreshImageJobs,refreshJobs,addImagePageReference,imagePageIssue,generateImageCard,generateScene,renderTextChat,sendTextChat,flush};', context);
  harness = context.harness;
  const project = createProject({ title: '五页导航测试' });
  harness.state.project = project; harness.state.saved = structuredClone(project); harness.state.token = 'frontend-test-token';
  harness.state.settings = { hasKey: true, videoModel: 'video-a', generationCountMax: 5,
    image: { hasKey: true, imageModel: 'image-a' } };
  const imageCapabilities = { imageLimit: 16, videoLimit: 0, audioLimit: 0, totalLimit: 16,
    qualities: ['auto', '1k', '2k', '4k'], ratios: ['auto', '1:1', '16:9', '9:16'] };
  harness.state.imageCatalog = [{ name: 'image-a', description: '默认图片模型', imageProtocol: 'gpt', capabilities: imageCapabilities },
    { name: 'image-b', imageProtocol: 'gpt', capabilities: imageCapabilities }];
  harness.state.catalog = [{ name: 'video-a', defaultDuration: 5, defaultResolution: '720p',
    tiers: [{ duration: 5, resolution: '720p', price: 1 }] }];
  harness.state.tools = { ready: true, message: '本机合成可用' };
  element('#image-page-count').value = '1';
  element('#result-sort').value = 'newest';
  const selectText = async (value, role = 'assistant', { mixed = false } = {}) => {
    const message = new Element(); message.className = 'text-chat-message ' + role;
    const content = new Element(); content.className = 'text-chat-message-content'; message.append(content);
    selection = { isCollapsed:!value,rangeCount:1,anchorNode:content,focusNode:mixed ? new Element() : content,
      toString:()=>value,getRangeAt:()=>({getBoundingClientRect:()=>({left:300,top:150,bottom:180})}),removeAllRanges(){this.isCollapsed=true;this.rangeCount=0;} };
    for (const handler of documentListeners.get('selectionchange') || []) await handler();
    return selection;
  };
  return { ...harness, element, tabs, panels, requests, canvasCalls, canvas, selectText, downloads, archives };
}

test('全屏聊天挂载移动同一个聊天卡，往返保留输入、消息和滚动位置', async () => {
  const h=await pageHarness();h.setView('text');
  const card=h.element('#text-chat-card'), messages=h.element('#text-chat-messages');
  h.element('#text-chat-input').value='尚未发送的想法';messages.scrollTop=37;
  const html=messages.innerHTML;
  h.canvas.setExpanded(true);assert.equal(card.parentElement,h.element('#canvas-text-host'));
  h.canvas.setExpanded(false);assert.equal(card.parentElement,h.element('#text-chat-home'));
  assert.equal(h.element('#text-chat-input').value,'尚未发送的想法');
  assert.equal(messages.innerHTML,html);assert.equal(messages.scrollTop,37);
});

test('只对同一条模型回复选区提供草稿操作，真实按钮点击保留文字并切回画布', async () => {
  const h=await pageHarness();h.setView('text');
  const actions=h.element('#text-selection-actions');
  for (const [text,role,options] of [['用户文字','user',{}],['跨回复','assistant',{mixed:true}],['','assistant',{}]]) {
    await h.selectText(text,role,options);assert.equal(actions.hidden,true);
  }
  const prompt='雨夜书店\n人物走入暖光';await h.selectText(prompt);assert.equal(actions.hidden,false);
  const button={dataset:{selectionDraft:'image'},disabled:false,closest:selector=>selector==='[data-selection-draft]'?button:null};
  const pointer={target:button,pointerType:'mouse'};await actions.fire('pointerdown',pointer);assert.equal(pointer.defaultPrevented,true);
  await actions.fire('click',{target:button});assert.equal(h.state.view,'canvas');
  assert.equal(h.canvasCalls.find(call=>call.action==='addPromptImage').prompt,prompt);assert.equal(actions.hidden,true);
  await h.selectText('内容'.repeat(2200));button.dataset.selectionDraft='video';await actions.fire('click',{target:button});
  assert.equal(h.canvasCalls.find(call=>call.action==='addPromptVideo').prompt.length,4000);
  assert.deepEqual(h.requests,[]);
});

test('工程名称编辑后自动保存并同步侧栏，空白编辑保留原名称', async () => {
  const h=await pageHarness({respond:(request,h)=>request.method==='PATCH'
    ? {...h.state.project,...request.body,revision:h.state.project.revision+1} : h.state.project});
  const input=h.element('#project-title');await h.element('#rename-project').click();assert.equal(input.readOnly,false);
  input.value='  新的雨夜创作  ';await input.fire('input');await input.fire('keydown',{key:'Enter'});await h.flush();
  assert.equal(input.readOnly,true);assert.equal(input.value,'新的雨夜创作');
  assert.equal(h.state.saved.title,'新的雨夜创作');assert.match(h.element('#project-list').innerHTML,/新的雨夜创作/);
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].body.title,'新的雨夜创作');
  await h.element('#rename-project').click();input.value='   ';await input.fire('input');await input.blur();await h.flush();
  assert.equal(h.state.project.title,'新的雨夜创作');assert.equal(input.value,'新的雨夜创作');assert.equal(h.requests.length,1);
});

async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await setImmediate(); }
  assert.fail('页面操作未进入预期状态');
}

function delegatedTarget(selector, dataset) {
  const button = { dataset, disabled: false, isConnected: true };
  return { closest: requested => requested === selector ? button : null };
}


function imageBatchFixture(projectId, { count = 3, nodeId = '', model = 'gpt-image-2.5-flare',
  prompt = '参考人物和场景生成雨夜书店画面', referenceAssetIds = [] } = {}) {
  const batchId = 'frontend-image-batch';
  const jobs = Array.from({ length: count }, (_, index) => ({
    id: 'batch-image-' + (index + 1), kind: 'image', projectId, sceneId: '', nodeId, model, prompt,
    state: 'waiting', assetId: '', batchId, count, variantIndex: index + 1,
    operationId: 'operation-1:' + (index + 1), batchOperationId: 'operation-1', referenceAssetIds,
    createdAt: '2026-10-08T01:00:00Z', updatedAt: '2026-10-08T01:00:00Z',
  }));
  return { batchId, jobs, count };
}

function enableImageReferenceModel(h) {
  h.state.imageCatalog.push({ name: 'gpt-image-2.5-flare', description: '参考图测试模型', imageProtocol: 'gpt',
    capabilities: { imageLimit: 16, videoLimit: 0, audioLimit: 0, totalLimit: 16,
      qualities: ['auto', '1k', '2k', '4k'], ratios: ['auto', '1:1', '16:9', '9:16'] } });
  h.setView('images');
  h.element('#image-page-model').value = 'gpt-image-2.5-flare';
}

test('语言模型历史回复显示成表格，用户输入保持原文且不改动已存消息', async () => {
  const h = await pageHarness();
  const content = '| 镜头 | 时长 |\n|---|---:|\n| 开场 | 3 秒 |';
  h.state.textMessages = [{ role: 'user', content }, { role: 'assistant', content }];
  const before = structuredClone(h.state.textMessages);
  h.renderTextChat();
  const html = h.element('#text-chat-messages').innerHTML;
  assert.equal((html.match(/<table>/g) || []).length, 1);
  assert.match(html, /text-chat-message user[\s\S]*\| 镜头 \| 时长 \|<br>\|---\|---:\|/);
  assert.match(html, /text-chat-message assistant[\s\S]*text-markdown[\s\S]*<th scope="col">镜头/);
  assert.deepEqual(h.state.textMessages, before);
  assert.equal(h.requests.length, 0);
});

test('对话只把原始文字发送给接口，新回复直接显示表格且不产生附加请求', async () => {
  const content = '| 镜头 | 时长 |\n|---|---:|\n| 开场 | 3 秒 |';
  const h = await pageHarness({ respond: request => request.url === '/api/text-chat' ? { content } : {} });
  h.state.settings.text = { hasKey: true, textModel: 'text-a' };
  h.state.textCatalog = [{ name: 'text-a' }];
  h.state.textMessages = [{ role: 'assistant', content }];
  h.renderTextChat();
  h.element('#text-chat-input').value = '继续补充';
  await h.sendTextChat();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/api/text-chat');
  assert.equal(h.requests[0].method, 'POST');
  assert.equal(h.requests[0].body.messages[0].content, content);
  assert.equal(h.state.textMessages.at(-1).content, content);
  assert.equal((h.element('#text-chat-messages').innerHTML.match(/<table>/g) || []).length, 2);
  assert.equal(h.state.textBusy, false);
});

test('页面结构提供六个独立入口，图片页和结果页保留自己的操作控件', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const navigation = [...html.matchAll(/<button\b[^>]*data-view="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)];
  assert.deepEqual(navigation.map(match => match[1]), views);
  assert.deepEqual(navigation.map(match => match[2].replace(/<span\b[^>]*>[\s\S]*?<\/span>/g, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()), labels);
  for (const view of views) assert.match(html, new RegExp('id="' + view + '-view"'));
  assert.doesNotMatch(html, /id="(?:scenes|delivery)-view"|分镜/);
  for (const id of ['scene-list', 'image-page-form', 'image-page-model', 'image-page-prompt',
    'image-page-note', 'image-page-message', 'result-list', 'result-filter', 'image-dialog', 'image-form',
    'result-details-dialog', 'result-details-title', 'result-details-content', 'close-result-details']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  const resultFilter = html.match(/<select\b[^>]*id="result-filter"[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.ok(resultFilter, '结果页应提供类型筛选器');
  assert.deepEqual([...resultFilter.matchAll(/<option\b[^>]*value="([^"]*)"/g)].map(match => match[1]), ['all', 'image', 'video']);
});

test('点击五个入口更新可见页面和选中状态，返回创作画布重新激活画布', async () => {
  const h = await pageHarness();
  h.setView('canvas');
  const before = structuredClone(h.state.project);
  for (const view of ['assets', 'images', 'videos', 'results', 'canvas']) {
    await h.tabs.find(tab => tab.dataset.view === view).click();
    assert.equal(h.state.view, view);
    assert.deepEqual(h.panels.filter(panel => !panel.classList.contains('hidden')).map(panel => panel.id), [view + '-view']);
    assert.deepEqual(h.tabs.filter(tab => tab.classList.contains('active')).map(tab => tab.dataset.view), [view]);
    for (const tab of h.tabs) assert.equal(tab.getAttribute('aria-selected'), String(tab.dataset.view === view));
  }
  assert.equal(h.canvasCalls.filter(call => call === 'finishEditing').length, 1);
  assert.equal(h.canvasCalls.filter(call => call === 'activate').length, 2);
  assert.deepEqual(h.state.project, before, '切换入口不应修改工程或生成项');
  assert.deepEqual(h.requests, [], '页面导航不应提交任何生成请求');
});

test('图片页报价随模型画质和张数实时更新，切换工程恢复模型默认画质', async () => {
  const h = await pageHarness();
  h.state.imageCatalog = [
    { name: 'image-a', intervals: [{ label: '1K', prices: [0.08, 0.15] }, { label: '2K', prices: [0.09, 0.25] }] },
    { name: 'image-b', intervals: [{ label: '1K', price: 0.2 }] },
  ];
  h.setView('images');
  assert.equal(h.element('#image-page-cost').textContent, '预计合计 ¥0.08–0.25 · 每张 ¥0.08–0.25 · 1 张');
  h.element('#image-page-model').value = 'image-b';
  await h.element('#image-page-model').fire('change', { target: h.element('#image-page-model') });
  assert.equal(h.element('#image-page-cost').textContent, '预计合计 ¥0.2 · 每张 ¥0.2 · 1 张');
  h.element('#image-page-model').value = 'image-a';
  await h.element('#image-page-model').fire('change', { target: h.element('#image-page-model') });
  h.element('#image-page-quality').value = '2k';
  await h.element('#image-page-quality').fire('change', { target: h.element('#image-page-quality') });
  h.element('#image-page-count').value = '3';
  await h.element('#image-page-count').fire('change', { target: h.element('#image-page-count') });
  assert.equal(h.element('#image-page-cost').textContent, '预计合计 ¥0.27–0.75 · 每张 ¥0.09–0.25 · 3 张');
  h.setProject(createProject({ title: '报价重置工程' }));
  assert.equal(h.element('#image-page-quality').value, 'auto');
  assert.equal(h.element('#image-page-count').value, '1');
  assert.equal(h.element('#image-page-cost').textContent, '预计合计 ¥0.08–0.25 · 每张 ¥0.08–0.25 · 1 张');
});

test('旧入口名称映射到新的视频和结果页面，工程中的 scenes 字段继续兼容', async () => {
  const h = await pageHarness();
  const scenes = structuredClone(h.state.project.scenes);
  for (const [oldView, canonical] of [['scenes', 'videos'], ['delivery', 'results']]) {
    h.setView(oldView);
    assert.equal(h.state.view, canonical);
    assert.deepEqual(h.panels.filter(panel => !panel.classList.contains('hidden')).map(panel => panel.id), [canonical + '-view']);
    assert.equal(h.tabs.find(tab => tab.dataset.view === canonical).getAttribute('aria-selected'), 'true');
  }
  assert.deepEqual(h.state.project.scenes, scenes);
  assert.deepEqual(h.requests, []);
});

test('生成结果只展示有效模型图片视频，卡片保留预览与详情，详情支持下载和放入画布', async () => {
  const h = await pageHarness();
  const generatedImage = { id: 'generated-image', kind: 'image', source: 'model', name: '人物 <b>一</b>.png', size: 100,
    createdAt: '2026-10-08T01:00:00Z' };
  const generatedVideo = { id: 'generated-video', kind: 'video', source: 'model', name: '夜景.mp4', size: 100,
    createdAt: '2026-10-08T02:00:00Z' };
  h.state.project.assets = [generatedImage, generatedVideo,
    { id: 'uploaded-image', kind: 'image', source: 'upload', name: '本机参考.png', size: 100 },
    { id: 'generated-audio', kind: 'audio', source: 'model', name: '声音.mp3', size: 100 },
    { id: 'deleted-image', kind: 'image', source: 'model', name: '已删除.png', deletedAt: '2026-10-08T03:00:00Z', size: 100 }];
  const filter = h.element('#result-filter'); filter.value = 'all';
  h.setView('results');
  const results = h.element('#result-list');
  assert.match(results.innerHTML, /generated-image/); assert.match(results.innerHTML, /generated-video/);
  assert.doesNotMatch(results.innerHTML, /uploaded-image|generated-audio|deleted-image/);
  assert.match(results.innerHTML, /人物 &lt;b&gt;一&lt;\/b&gt;\.png/);
  assert.doesNotMatch(results.innerHTML, /<b>一<\/b>/);
  const imageThumbnail = results.innerHTML.match(/<img\b[^>]*src="\/api\/assets\/generated-image"[^>]*>/)?.[0];
  const videoThumbnail = results.innerHTML.match(/<video\b[^>]*src="\/api\/assets\/generated-video[^"]*"[^>]*>/)?.[0];
  assert.ok(imageThumbnail, '图片结果应直接显示真实图片缩略图');
  assert.ok(videoThumbnail, '视频结果应直接显示真实视频缩略图');
  for (const thumbnail of [imageThumbnail, videoThumbnail]) {
    assert.doesNotMatch(thumbnail, /\bhidden(?:=|\s|>)|display\s*:\s*none|visibility\s*:\s*hidden/);
  }
  for (const asset of [generatedImage, generatedVideo]) {
    assert.match(results.innerHTML, new RegExp('data-preview-asset="' + asset.id + '"'));
    assert.match(results.innerHTML, new RegExp('data-result-details="' + asset.id + '"'));

  }
  assert.doesNotMatch(results.innerHTML, /data-add-to-canvas|data-delete-asset|data-use-image-reference|download=1|以此图生成/);
  filter.value = 'image'; await filter.fire('change', { target: filter });
  assert.match(results.innerHTML, /generated-image/); assert.doesNotMatch(results.innerHTML, /generated-video/);
  filter.value = 'video'; await filter.fire('change', { target: filter });
  assert.match(results.innerHTML, /generated-video/); assert.doesNotMatch(results.innerHTML, /generated-image/);
  await results.fire('click', { target: delegatedTarget('[data-preview-asset]', { previewAsset: generatedVideo.id }) });
  assert.equal(h.element('#preview-title').textContent, generatedVideo.name);
  assert.equal(h.element('#preview-content').children[0].tagName, 'VIDEO');
  assert.equal(h.element('#preview-content').children[0].src, '/api/assets/' + generatedVideo.id);
  assert.equal(h.element('#preview-dialog').open, true);
  const before = structuredClone(h.state.project);
  await results.fire('click', { target: delegatedTarget('[data-result-details]', { resultDetails: generatedVideo.id }) });
  const details = h.element('#result-details-content');
  assert.equal(h.element('#result-details-dialog').open, true);
  assert.match(details.innerHTML, /href="\/api\/assets\/generated-video\?download=1"/);
  assert.match(details.innerHTML, /下载视频/);
  assert.match(details.innerHTML, /data-add-to-canvas="generated-video"/);
  assert.match(details.innerHTML, /data-delete-asset="generated-video"/);
  assert.doesNotMatch(details.innerHTML, /data-use-image-reference|以此图生成/);
  await details.fire('click', { target: delegatedTarget('[data-add-to-canvas]', { addToCanvas: generatedVideo.id }) });
  await until(() => !h.element('#result-details-dialog').open && !details.innerHTML);
  assert.equal(h.state.view, 'canvas');
  assert.equal(h.canvasCalls.find(call => call?.action === 'addAsset')?.asset.id, generatedVideo.id);
  assert.deepEqual(h.state.project.assets, before.assets, '放入画布复用既有素材，不应复制生成结果');
  assert.deepEqual(h.state.project.scenes, before.scenes, '放入画布不应自动新增视频生成项');
  assert.deepEqual(h.requests, [], '预览、筛选和放入画布不应提交生成请求');
});

test('结果详情按当前图片或视频显示完整信息，卡片不展开元数据和提示词', async () => {
  const h = await pageHarness();
  const image = { id: 'details-image', kind: 'image', source: 'model', name: '图片 <b>一</b>.png', size: 2 * 1024 * 1024,
    createdAt: '2026-10-08T01:00:00Z' };
  const video = { id: 'details-video', kind: 'video', source: 'model', name: '雨夜视频.mp4', size: 5 * 1024 * 1024,
    createdAt: '2026-10-08T02:00:00Z' };
  const imagePrompt = '完整图片提示词：' + '雨夜书店人物与场景。'.repeat(80) + '<script>alert("不应执行")</script>';
  const videoPrompt = '完整视频提示词：镜头从书店窗外缓慢推进，人物抬头。';
  h.state.project.assets = [image, video];
  h.state.imageJobs = [{ id: 'details-image-job', state: 'done', assetId: image.id, model: 'details-image-model', prompt: imagePrompt }];
  h.state.jobs = [{ id: 'details-video-job', state: 'done', assetId: video.id, model: 'details-video-model', prompt: videoPrompt }];
  h.setView('results');
  const before = structuredClone(h.state.project), results = h.element('#result-list');
  assert.doesNotMatch(results.innerHTML, /details-image-model|details-video-model|完整图片提示词|完整视频提示词|result-time|result-prompt/);
  const dialog = h.element('#result-details-dialog'), title = h.element('#result-details-title');
  const content = h.element('#result-details-content');
  await results.fire('click', { target: delegatedTarget('[data-result-details]', { resultDetails: image.id }) });
  assert.equal(dialog.open, true);
  assert.equal(title.textContent, image.name);
  assert.match(content.innerHTML, /<img\b[^>]*src="\/api\/assets\/details-image"/);
  assert.match(content.innerHTML, /details-image-model/);
  assert.match(content.innerHTML, /2\.0 MB/);
  assert.match(content.innerHTML, /2026(?:\/|-|年)10/);
  assert.match(content.innerHTML, /<details\b[\s\S]*<summary\b/);
  assert.ok(content.innerHTML.includes(imagePrompt.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))),
    '长提示词应完整保留在详情中，而非卡片里的截断摘要');
  assert.doesNotMatch(content.innerHTML, /<script>|data-use-image-reference|以此图生成/);
  assert.match(content.innerHTML, /href="\/api\/assets\/details-image\?download=1"/);
  assert.match(content.innerHTML, /下载图片/);
  await results.fire('click', { target: delegatedTarget('[data-result-details]', { resultDetails: video.id }) });
  assert.equal(dialog.open, true);
  assert.equal(title.textContent, video.name);
  const media = content.innerHTML.match(/<video\b[^>]*>/)?.[0];
  assert.ok(media, '视频详情应提供视频播放器');
  assert.match(media, /src="\/api\/assets\/details-video"/);
  assert.match(media, /\bcontrols(?:\s|=|>)/);
  assert.doesNotMatch(media, /\bautoplay(?:\s|=|>)/);
  assert.match(content.innerHTML, /details-video-model|完整视频提示词/);
  assert.match(content.innerHTML, /5\.0 MB/);
  assert.match(content.innerHTML, /href="\/api\/assets\/details-video\?download=1"/);
  assert.match(content.innerHTML, /下载视频/);
  assert.doesNotMatch(content.innerHTML, /details-image-model|完整图片提示词|data-use-image-reference|以此图生成/);
  assert.deepEqual(h.state.project, before, '查看不同详情只改变展示内容');
  assert.deepEqual(h.requests, [], '查看详情不调用模型或下载接口');
});

test('关闭结果详情清空媒体内容与标题，重新打开仍使用当前结果', async () => {
  const h = await pageHarness();
  const asset = { id: 'details-close-image', kind: 'image', source: 'model', name: '可关闭图片.png', size: 100 };
  h.state.project.assets = [asset]; h.setView('results');
  const results = h.element('#result-list'), dialog = h.element('#result-details-dialog');
  const content = h.element('#result-details-content'), title = h.element('#result-details-title');
  await results.fire('click', { target: delegatedTarget('[data-result-details]', { resultDetails: asset.id }) });
  assert.equal(dialog.open, true); assert.match(content.innerHTML, /details-close-image/);
  await h.element('#close-result-details').click();
  await until(() => !dialog.open && !content.innerHTML && !title.textContent);
  assert.deepEqual(content.children, [], '关闭后移除媒体节点');
  await results.fire('click', { target: delegatedTarget('[data-result-details]', { resultDetails: asset.id }) });
  assert.equal(dialog.open, true); assert.equal(title.textContent, asset.name);
  assert.match(content.innerHTML, /details-close-image/);
  h.setView('assets');
  await until(() => !dialog.open && !content.innerHTML && !title.textContent);
  assert.deepEqual(h.requests, []);
});

test('结果详情删除只软删除原素材，关闭对话框并保留原任务记录', async () => {
  const confirmations = [];
  const h = await pageHarness({ confirm: message => { confirmations.push(message); return true; },
    respond: async (request, current) => {
      assert.equal(request.method, 'DELETE');
      return { ...current.state.project, revision: current.state.project.revision + 1,
        assets: current.state.project.assets.map(asset => ({ ...asset, deletedAt: '2026-10-08T03:00:00Z' })) };
    } });
  const asset = { id: 'details-delete-image', kind: 'image', source: 'model', name: '删除详情图片.png', size: 100 };
  const job = { id: 'preserved-image-job', state: 'done', assetId: asset.id, providerJobId: 'preserved-provider-task' };
  h.state.project.assets = [asset]; h.state.imageJobs = [job]; h.setView('results');
  await h.element('#result-list').fire('click', { target: delegatedTarget('[data-result-details]', { resultDetails: asset.id }) });
  await h.element('#result-details-content').fire('click', {
    target: delegatedTarget('[data-delete-asset],[data-restore-asset]', { deleteAsset: asset.id }) });
  await until(() => Boolean(h.state.project.assets[0]?.deletedAt) && !h.element('#result-details-dialog').open);
  await until(() => !h.element('#result-details-content').innerHTML && !h.element('#result-details-title').textContent);
  assert.equal(confirmations.length, 1); assert.match(confirmations[0], /删除详情图片/);
  assert.deepEqual(h.requests.map(request => [request.method, request.url]),
    [['DELETE', '/api/projects/' + h.state.project.id + '/assets/' + asset.id]]);
  assert.equal(h.requests[0].headers['X-Studio-Token'], 'frontend-test-token');
  assert.equal(h.state.project.assets.length, 1, '软删除仍保留原素材记录');
  assert.equal(h.state.project.assets[0].id, asset.id);
  assert.deepEqual(Array.from(h.state.imageJobs), [job], '不删除本地或远端任务的追踪信息');
  assert.doesNotMatch(h.element('#result-list').innerHTML, /data-asset-id="details-delete-image"/);
  assert.equal(h.state.view, 'results');
});

test('取消结果详情删除保持详情和工程，不发删除或生成请求', async () => {
  const confirmations = [];
  const h = await pageHarness({ confirm: message => { confirmations.push(message); return false; } });
  const asset = { id: 'details-cancel-delete', kind: 'video', source: 'model', name: '保留的视频.mp4', size: 100 };
  h.state.project.assets = [asset]; h.setView('results');
  const before = structuredClone(h.state.project), dialog = h.element('#result-details-dialog');
  const content = h.element('#result-details-content');
  await h.element('#result-list').fire('click', { target: delegatedTarget('[data-result-details]', { resultDetails: asset.id }) });
  const previousHtml = content.innerHTML;
  await content.fire('click', { target: delegatedTarget('[data-delete-asset],[data-restore-asset]', { deleteAsset: asset.id }) });
  assert.equal(confirmations.length, 1);
  assert.equal(dialog.open, true); assert.equal(content.innerHTML, previousHtml);
  assert.equal(h.element('#result-details-title').textContent, asset.name);
  assert.deepEqual(h.state.project, before);
  assert.deepEqual(h.requests, []);
});

test('结果详情拒绝失效结果，刷新移除素材及切换工程时关闭并清理旧内容', async () => {
  let confirmations = 0;
  const h = await pageHarness({ confirm: () => { confirmations++; return true; } });
  const asset = { id: 'details-invalidated', kind: 'image', source: 'model', name: '原工程图片.png', size: 100 };
  const deleted = { id: 'details-already-deleted', kind: 'image', source: 'model', name: '已删除图片.png', size: 100,
    deletedAt: '2026-10-08T03:00:00Z' };
  const uploaded = { id: 'details-uploaded', kind: 'image', source: 'upload', name: '上传参考.png', size: 100 };
  h.state.project.assets = [asset, deleted, uploaded]; h.setView('results');
  const results = h.element('#result-list'), dialog = h.element('#result-details-dialog');
  const content = h.element('#result-details-content'), title = h.element('#result-details-title');
  for (const id of ['missing-result', deleted.id, uploaded.id]) {
    await results.fire('click', { target: delegatedTarget('[data-result-details]', { resultDetails: id }) });
    assert.equal(dialog.open, false, '失效或非生成结果不能打开详情：' + id);
    assert.equal(content.innerHTML, '');
  }
  await results.fire('click', { target: delegatedTarget('[data-result-details]', { resultDetails: asset.id }) });
  assert.equal(dialog.open, true);
  h.state.project.assets = [{ ...asset, deletedAt: '2026-10-08T03:00:00Z' }];
  h.setView('results');
  await until(() => !dialog.open && !content.innerHTML && !title.textContent);
  h.state.project.assets = [asset]; h.setView('results');
  await results.fire('click', { target: delegatedTarget('[data-result-details]', { resultDetails: asset.id }) });
  h.state.project.assets = []; h.setView('results');
  await until(() => !dialog.open && !content.innerHTML && !title.textContent);
  h.state.project.assets = [asset]; h.setView('results');
  await results.fire('click', { target: delegatedTarget('[data-result-details]', { resultDetails: asset.id }) });
  h.state.project.assets = [];
  await content.fire('click', { target: delegatedTarget('[data-delete-asset],[data-restore-asset]', { deleteAsset: asset.id }) });
  await until(() => !dialog.open && !content.innerHTML && !title.textContent);
  assert.equal(confirmations, 0, '失效的旧详情按钮不能进入素材删除确认');
  h.state.project.assets = [asset]; h.setView('results');
  await results.fire('click', { target: delegatedTarget('[data-result-details]', { resultDetails: asset.id }) });
  const nextProject = createProject({ title: '另一个工程' });
  nextProject.assets = [{ ...asset, name: '新工程中同编号图片.png' }];
  h.setProject(nextProject);
  await until(() => !dialog.open && !content.innerHTML && !title.textContent);
  assert.equal(h.state.project.id, nextProject.id);
  await results.fire('click', { target: delegatedTarget('[data-result-details]', { resultDetails: asset.id }) });
  assert.equal(title.textContent, nextProject.assets[0].name);
  h.setProject(null);
  await until(() => !dialog.open && !content.innerHTML && !title.textContent);
  assert.deepEqual(h.requests, [], '详情生命周期只更新本地展示');
});

test('素材库和生成结果的多选集合独立，全选只作用于当前工程筛选列表', async () => {
  const h = await pageHarness();
  const current = h.state.project;
  const other = createProject({ title: '另一工程' });
  const currentUpload = { id: 'batch-current-upload', kind: 'image', source: 'upload', name: '当前参考.png', size: 100 };
  const currentResult = { id: 'batch-current-result', kind: 'image', source: 'model', name: '当前结果.png', size: 100 };
  const otherUpload = { id: 'batch-other-upload', kind: 'video', source: 'upload', name: '另一工程视频.mp4', size: 100 };
  current.assets = [currentUpload, currentResult]; other.assets = [otherUpload];
  h.state.projects = [current, other];
  h.setView('assets');
  h.element('#asset-project-filter').value = current.id;
  await h.element('#asset-project-filter').fire('change', { target: h.element('#asset-project-filter') });
  await h.element('#select-all-assets').click();
  assert.deepEqual(new Set(h.state.assetSelection), new Set([currentUpload.id, currentResult.id]));
  assert.equal(h.element('#asset-selection-count').textContent, '已选 2 个素材');
  await h.element('#clear-asset-selection').click();
  assert.equal(h.state.assetSelection.size, 0);
  h.element('#asset-project-filter').value = other.id;
  await h.element('#asset-project-filter').fire('change', { target: h.element('#asset-project-filter') });
  await h.element('#select-all-assets').click();
  assert.deepEqual(new Set(h.state.assetSelection), new Set([otherUpload.id]), '全选不能带入其他工程素材');
  h.setView('results');
  await h.element('#select-all-results').click();
  assert.deepEqual(new Set(h.state.resultSelection), new Set([currentResult.id]), '结果页使用独立选择集合');
  assert.deepEqual(new Set(h.state.assetSelection), new Set([otherUpload.id]), '素材页选择不应被结果页覆盖');
});

test('单项勾选可以取消，结果类型筛选只保留当前可见项的选择', async () => {
  const h = await pageHarness();
  h.state.project.assets = [
    { id: 'select-image', kind: 'image', source: 'model', name: '图片.png', size: 100 },
    { id: 'select-video', kind: 'video', source: 'model', name: '视频.mp4', size: 100 },
  ];
  h.setView('assets');
  const input = { dataset: { selectAsset: 'select-image' }, checked: true,
    closest: selector => selector === '[data-select-asset],[data-select-result]' ? input : null };
  await h.element('#asset-list').fire('change', { target: input });
  assert.deepEqual([...h.state.assetSelection], ['select-image']);
  input.checked = false;
  await h.element('#asset-list').fire('change', { target: input });
  assert.equal(h.state.assetSelection.size, 0);
  h.setView('results'); await h.element('#select-all-results').click();
  h.element('#result-filter').value = 'video';
  await h.element('#result-filter').fire('change');
  assert.deepEqual([...h.state.resultSelection], ['select-video']);
  await h.element('#select-all-results').click();
  assert.equal(h.state.resultSelection.size, 0);
  assert.equal(h.element('#batch-delete-results').disabled, true);
});

test('批量下载把所选素材打成一个 ZIP，重名和非法文件名会被安全处理', async () => {
  const h = await pageHarness();
  h.state.project.assets = [
    { id: 'batch-download-one', kind: 'image', source: 'upload', name: '同名/参考.png', size: 100 },
    { id: 'batch-download-two', kind: 'image', source: 'upload', name: '同名/参考.png', size: 100 },
  ];
  h.setView('assets');
  await h.element('#select-all-assets').click();
  await h.element('#batch-download-assets').click();
  assert.deepEqual(h.requests.filter(request => request.url.includes('/api/assets/')).map(request => request.url), [
    '/api/assets/batch-download-two?download=1', '/api/assets/batch-download-one?download=1']);
  assert.equal(h.archives.length, 1);
  assert.deepEqual([...h.archives[0].files.keys()], ['同名_参考.png', '同名_参考 (2).png']);
  assert.equal(h.downloads.length, 1, '批量下载只触发一次浏览器下载');
  assert.match(h.downloads[0].name, /素材-2个\.zip$/);
});

test('批量操作执行期间禁用两个页面的选择工具，结束后恢复且不能重复删除', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = await pageHarness({ respond: async request => {
    if (request.url.startsWith('/api/assets/')) { await pending; return { bytes: [1, 2, 3] }; }
    throw new Error('不应发送其他请求');
  } });
  h.state.project.assets = [{ id: 'busy-file', kind: 'image', source: 'model', name: '打包.png', size: 100 }];
  h.setView('assets'); await h.element('#select-all-assets').click();
  const downloading = h.element('#batch-download-assets').click();
  try {
    await until(() => h.requests.length === 1);
    for (const id of ['select-all-assets', 'clear-asset-selection', 'batch-delete-assets', 'select-all-results', 'result-filter', 'asset-project-filter']) {
      assert.equal(h.element('#' + id).disabled, true, id);
    }
    await h.element('#batch-delete-assets').click();
    assert.equal(h.requests.some(request => request.method === 'DELETE'), false);
  } finally { release(); await downloading; }
  assert.equal(h.element('#select-all-assets').disabled, false);
  assert.equal(h.element('#batch-delete-assets').disabled, false);
  assert.equal(h.element('#result-filter').disabled, false);
});

test('批量删除部分失败时只清理成功项，失败项保留选择且可重试', async () => {
  const h = await pageHarness({
    confirm: () => true,
    respond: async (request, current) => {
      if (request.method !== 'DELETE') return current.state.project;
      if (request.url.endsWith('/batch-delete-success')) {
        return { ...current.state.project, revision: current.state.project.revision + 1,
          assets: current.state.project.assets.map(asset => asset.id === 'batch-delete-success'
            ? { ...asset, deletedAt: '2026-10-12T01:00:00Z' } : asset) };
      }
      return { $status: 503, error: '暂时无法删除' };
    },
  });
  h.state.project.assets = [
    { id: 'batch-delete-success', kind: 'image', source: 'upload', name: '成功删除.png', size: 100 },
    { id: 'batch-delete-failure', kind: 'image', source: 'upload', name: '稍后重试.png', size: 100 },
  ];
  h.setView('assets'); await h.element('#select-all-assets').click();
  await h.element('#batch-delete-assets').click();
  assert.equal(h.state.project.assets.find(asset => asset.id === 'batch-delete-success').deletedAt, '2026-10-12T01:00:00Z');
  assert.equal(h.state.assetSelection.has('batch-delete-success'), false);
  assert.deepEqual([...h.state.assetSelection], ['batch-delete-failure']);
  assert.deepEqual(h.requests.filter(request => request.method === 'DELETE').map(request => request.url), [
    '/api/projects/' + h.state.project.id + '/assets/batch-delete-failure',
    '/api/projects/' + h.state.project.id + '/assets/batch-delete-success',
  ]);
});

test('取消批量删除不发送请求并保留选择', async () => {
  const h = await pageHarness({ confirm: () => false });
  const asset = { id: 'batch-delete-cancel', kind: 'image', source: 'upload', name: '不删除.png', size: 100 };
  h.state.project.assets = [asset]; h.setView('assets'); await h.element('#select-all-assets').click();
  await h.element('#batch-delete-assets').click();
  assert.deepEqual([...h.state.assetSelection], [asset.id]);
  assert.equal(h.requests.some(request => request.method === 'DELETE'), false);
});

test('批量恢复按素材所属工程保存，部分失败时保留删除列表和失败项供重试', async () => {
  const other = createProject({ title: '恢复目标工程' }), projects = new Map();
  let retry = false;
  const h = await pageHarness({ respond: async (request, current) => {
    const parts = request.url.split('/'), id = parts[3], assetId = parts[5];
    assert.equal(request.method, 'POST'); assert.ok(request.url.endsWith('/restore'));
    if (assetId === 'restore-failure' && !retry) return { $status: 503, error: '稍后重试' };
    const restored = setAssetDeleted(projects.get(id) || current.state.project, assetId, false);
    projects.set(id, restored); return restored;
  } });
  const deleted = (id, name) => ({ id, name, kind: 'image', source: 'model', size: 100, deletedAt: '2026-10-12T01:00:00Z' });
  h.state.project.assets = [deleted('restore-current', '当前.png'), deleted('restore-failure', '待重试.png')];
  other.assets = [deleted('restore-other', '另一工程.png')];
  h.state.projects = [h.state.project, other]; projects.set(other.id, other);
  h.setView('assets'); await h.element('#toggle-deleted-assets').click();
  await h.element('#select-all-assets').click(); await h.element('#batch-restore-assets').click();
  assert.equal(h.state.project.assets.find(asset => asset.id === 'restore-current').deletedAt, null);
  assert.equal(h.state.projects.find(project => project.id === other.id).assets[0].deletedAt, null);
  assert.deepEqual([...h.state.assetSelection], ['restore-failure']);
  assert.equal(h.state.showDeletedAssets, true);
  assert.equal(h.element('#batch-restore-assets').hidden, false);
  retry = true; await h.element('#batch-restore-assets').click();
  assert.equal(h.state.assetSelection.size, 0); assert.equal(h.state.showDeletedAssets, false);
  assert.equal(h.requests.some(request => /image-jobs|\/jobs/.test(request.url)), false);
});

test('批量删除过程中切换工程会停止后续请求并把已删除记录保存在原工程', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = await pageHarness({ respond: async (request, current) => {
    const original = structuredClone(current.state.project);
    await pending;
    return setAssetDeleted(original, request.url.split('/').at(-1), true);
  } });
  h.state.project.assets = ['stop-one', 'stop-two'].map(id => ({ id, kind: 'image', source: 'upload', name: id + '.png', size: 100 }));
  const originalId = h.state.project.id;
  h.setView('assets'); await h.element('#select-all-assets').click();
  const deleting = h.element('#batch-delete-assets').click();
  await until(() => h.requests.some(request => request.method === 'DELETE'));
  const next = createProject({ title: '切换后工程' }); h.setProject(next);
  release(); await deleting;
  assert.equal(h.state.project.id, next.id);
  assert.equal(h.requests.filter(request => request.method === 'DELETE').length, 1);
  assert.equal(h.state.projects.find(project => project.id === originalId).assets.filter(asset => asset.deletedAt).length, 1);
  assert.match(h.element('#toast').textContent, /剩余操作已停止/);
});

function mockAssetPlacement(h) {
  h.canvas.addAsset = (asset, point, options) => {
    const node = createAssetCanvasNode(asset, h.state.project.graph, point);
    h.state.project.graph.nodes.push(node); h.state.dirty.add('graph');
    h.canvasCalls.push({ action: 'addAsset', asset: structuredClone(asset), options }); return node;
  };
}

test('批量放置复用既有素材并跳过已在画布的素材，不提交生成请求', async () => {
  const h = await pageHarness();
  const existing = { id: 'batch-place-existing', kind: 'image', source: 'upload', name: '已有画布.png', size: 100 };
  const fresh = { id: 'batch-place-fresh', kind: 'video', source: 'model', name: '新视频.mp4', size: 100 };
  h.state.project.assets = [existing, fresh];
  h.state.project.graph.nodes = [{ id: 'existing-node', kind: 'image', label: existing.name, assetId: existing.id, assetName: existing.name,
    sceneId: '', x: 0, y: 0, width: 300, height: 200, status: 'uploaded', note: '' }];
  mockAssetPlacement(h);
  h.setView('assets'); await h.element('#select-all-assets').click();
  await h.element('#batch-place-assets').click();
  assert.equal(h.state.project.graph.nodes.filter(node => node.assetId === fresh.id).length, 1);
  assert.equal(h.state.assetSelection.size, 0, '成功放置和已存在项都会从选择中移除');
  assert.equal(h.requests.some(request => request.method === 'POST'), false, '批量放置不能触发生图或视频生成');
  assert.equal(h.state.view, 'assets', '批量处理保留当前页面');
  assert.equal(h.requests.filter(request => request.method === 'PATCH').length, 1, '新增卡片必须保存');
  const options = h.canvasCalls.find(call => call?.action === 'addAsset').options;
  assert.equal(options.allowRelink, false); assert.equal(options.avoidOverlap, true);
});

test('跨工程批量放置读取最新画布并保留当前工程、输入草稿和已有节点，新卡片不重叠', async () => {
  const other = createProject({ title: '另一工程最新画布' }), projects = new Map();
  const h = await pageHarness({ respond: async request => {
    const id = request.url.split('/')[3], project = projects.get(id);
    assert.ok(project);
    if (request.method === 'PATCH') {
      const updated = updateProject(project, request.body); projects.set(id, updated); return updated;
    }
    return project;
  } });
  const asset = id => ({ id, kind: 'image', source: 'model', name: id + '.png', size: 100 });
  h.state.project.assets = [asset('place-local')]; other.assets = [asset('place-remote-a'), asset('place-remote-b')];
  h.state.projects = [structuredClone(h.state.project), structuredClone(other)];
  projects.set(h.state.project.id, structuredClone(h.state.project));
  other.revision = 9;
  other.graph.nodes = [{ id: 'remote-note', kind: 'text', label: '远端最新便签', note: '保留远端文字',
    x: 0, y: 0, width: 320, height: 260 }];
  projects.set(other.id, structuredClone(other));
  h.state.project.title = '未保存的工程名称'; h.state.dirty.add('title');
  h.element('#image-page-prompt').value = '尚未生成的图片草稿';
  h.element('#image-page-model').value = 'image-b'; h.element('#image-page-count').value = '3';
  h.element('#text-chat-input').value = '尚未发送的聊天草稿';
  mockAssetPlacement(h);
  h.setView('results'); h.element('#result-sort').value = 'oldest';
  await h.element('#select-all-results').click();
  const currentId = h.state.project.id;
  await h.element('#batch-place-results').click();
  assert.equal(h.state.project.id, currentId); assert.equal(h.state.view, 'results');
  assert.equal(h.state.project.title, '未保存的工程名称');
  assert.equal(projects.get(currentId).title, '未保存的工程名称');
  assert.equal(h.element('#image-page-prompt').value, '尚未生成的图片草稿');
  assert.equal(h.element('#image-page-model').value, 'image-b'); assert.equal(h.element('#image-page-count').value, '3');
  assert.equal(h.element('#text-chat-input').value, '尚未发送的聊天草稿');
  assert.equal(h.element('#result-sort').value, 'oldest');
  assert.equal(h.state.resultSelection.size, 0);
  const remotePatch = h.requests.find(request => request.method === 'PATCH' && request.url.endsWith('/' + other.id));
  assert.equal(remotePatch.body.revision, 9, '使用 GET 获得的最新版本');
  const nodes = projects.get(other.id).graph.nodes;
  assert.equal(nodes.find(node => node.id === 'remote-note').note, '保留远端文字');
  assert.equal(nodes.length, 3);
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) assert.equal(intersectsRect(nodes[i], nodes[j]), false);
  assert.equal(h.requests.some(request => request.method === 'POST'), false);
});

test('其他工程画布保存冲突时保留选择，不覆盖缓存或远端画布', async () => {
  const other = createProject({ title: '发生冲突的工程' });
  other.assets = [{ id: 'conflict-asset', kind: 'image', source: 'model', name: '保留.png', size: 100 }];
  const original = structuredClone(other.graph);
  const h = await pageHarness({ respond: async request => request.method === 'PATCH'
    ? { $status: 409, error: '工程已在其他窗口更新，请刷新后继续编辑。' } : other });
  const currentId = h.state.project.id;
  h.state.projects = [h.state.project, other]; h.setView('results');
  await h.element('#select-all-results').click(); await h.element('#batch-place-results').click();
  assert.equal(h.state.project.id, currentId);
  assert.deepEqual([...h.state.resultSelection], ['conflict-asset']);
  assert.deepEqual(other.graph, original);
  assert.deepEqual(h.state.projects.find(project => project.id === other.id).graph, original);
  assert.match(h.element('#toast').textContent, /1 个未保存，已保留选择/);
  assert.equal(h.requests.filter(request => request.method === 'PATCH').length, 1, '冲突不能自动覆盖');
});

test('其他工程画布达到容量上限时跳过新增并保留选择，已有素材仍可识别', async () => {
  const other = createProject({ title: '已满画布' });
  other.assets = ['capacity-existing', 'capacity-new'].map(id => ({ id, kind: 'image', source: 'model', name: id + '.png', size: 100 }));
  other.graph.nodes = Array.from({ length: 60 }, (_, index) => ({ id: 'capacity-' + index, kind: index === 0 ? 'image' : 'text',
    assetId: index === 0 ? 'capacity-existing' : '', label: '已有卡片', x: index * 400, y: 0, width: 320, height: 260 }));
  const h = await pageHarness({ respond: async () => other });
  h.state.projects = [h.state.project, other]; h.setView('results');
  await h.element('#select-all-results').click(); await h.element('#batch-place-results').click();
  assert.deepEqual([...h.state.resultSelection], ['capacity-new']);
  assert.equal(other.graph.nodes.length, 60);
  assert.equal(h.requests.some(request => request.method !== 'GET'), false);
  assert.match(h.element('#toast').textContent, /1 个已在画布.*1 个因容量/);
});

test('独立图片页提交使用图片接口并刷新任务，不依赖视频生成项或修改旧弹窗输入', async () => {
  const created = { id: 'image-job-once', state: 'submitting', model: 'image-b', prompt: '夜晚书店门口',
    operationId: 'operation-1', createdAt: '2026-10-08T01:00:00Z', sceneId: '' };
  const completed = { ...created, state: 'done', assetId: 'independent-image-result' };
  const asset = { id: completed.assetId, kind: 'image', source: 'model', name: '夜晚书店门口.png', size: 100,
    createdAt: created.createdAt };
  const h = await pageHarness({ respond: async (request, current) => {
    if (request.method === 'POST' && request.url.endsWith('/image-jobs')) return created;
    if (request.url.includes('/image-jobs')) return [completed];
    return { ...current.state.project, revision: current.state.project.revision + 1, assets: [asset] };
  } });
  h.setView('images');
  assert.match(h.element('#image-page-model').innerHTML, /image-a/);
  assert.match(h.element('#image-page-model').innerHTML, /image-b/);
  h.element('#image-model').value = 'image-a'; h.element('#image-prompt').value = '保留弹窗草稿';
  h.element('#image-page-model').value = 'image-b'; h.element('#image-page-prompt').value = '  夜晚书店门口  ';
  await h.element('#image-page-form').fire('submit', { preventDefault() {} });
  await until(() => h.state.imageJobs[0]?.state === 'done' && h.state.project.assets.length === 1
    && !h.element('#image-page-form [type=submit]').disabled);
  const submitted = h.requests.filter(request => request.method === 'POST');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].url, '/api/projects/' + h.state.project.id + '/image-jobs');
  assert.deepEqual(submitted[0].body, { sceneId: '', model: 'image-b', prompt: '夜晚书店门口', count: 1, referenceAssetIds: [], operationId: 'operation-1' });
  assert.equal(submitted[0].headers['X-Studio-Token'], 'frontend-test-token');
  assert.equal(h.state.imageJobs[0].id, created.id);
  assert.equal(h.state.imageJobs[0].assetId, asset.id);
  assert.deepEqual(h.state.project.assets, [asset]);
  assert.equal(h.element('#result-count').textContent, 1);
  assert.equal(h.state.project.scenes.length, 0);
  assert.equal(h.element('#image-model').value, 'image-a');
  assert.equal(h.element('#image-prompt').value, '保留弹窗草稿');
  assert.equal(h.element('#image-page-model').value, 'image-b');
  assert.equal(h.element('#image-page-prompt').value, '  夜晚书店门口  ');
  assert.equal(h.element('#image-dialog').modalOpens || 0, 0);
  assert.match(h.element('#image-page-message').textContent, /已提交/);
  assert.equal(h.requests.some(request => /\/batches|\/video-jobs/.test(request.url)), false);
});

test('独立图片页拒绝空白提示词，不提交或创建视频生成项', async () => {
  const h = await pageHarness();
  h.setView('images');
  h.element('#image-page-prompt').value = '   ';
  await h.element('#image-page-form').fire('submit', { preventDefault() {} });
  await until(() => /请输入.*提示词/.test(h.element('#toast').textContent));
  assert.deepEqual(h.requests, []);
  assert.equal(h.state.project.scenes.length, 0);
  assert.equal(h.state.imageJobs.length, 0);
});

test('图片任务轮询更新结果时保留未提交提示词模型张数和参考图草稿', async () => {
  const completed = { id: 'poll-completed', state: 'done', assetId: 'poll-result', model: 'image-a',
    prompt: '之前已提交的提示词', createdAt: '2026-10-08T01:00:00Z' };
  const asset = { id: 'poll-result', kind: 'image', source: 'model', name: '已保存的生成图.png', size: 100,
    createdAt: '2026-10-08T01:00:00Z' };
  const reference = { id: 'poll-draft-reference', kind: 'image', source: 'upload', name: '未提交草稿的参考图.png', size: 100 };
  const h = await pageHarness({ respond: async (request, current) => {
    if (request.url.includes('/image-jobs')) return [completed];
    return { ...current.state.project, revision: current.state.project.revision + 1, assets: [reference, asset] };
  } });
  h.state.project.assets = [reference];
  h.state.saved = structuredClone(h.state.project);
  h.state.imageJobs = [{ ...completed, state: 'saving', assetId: '' }];
  h.setView('images');
  h.element('#image-page-model').value = 'image-b';
  h.element('#image-page-prompt').value = '正在编辑，还未提交的新提示词';
  h.element('#image-page-count').value = '4';
  h.addImagePageReference(reference.id);
  await h.refreshImageJobs();
  assert.equal(h.state.imageJobs[0].id, completed.id);
  assert.equal(h.state.imageJobs[0].state, 'done');
  assert.ok(h.state.project.assets.some(item => item.id === asset.id));
  assert.equal(h.element('#image-page-prompt').value, '正在编辑，还未提交的新提示词');
  assert.equal(h.element('#image-page-model').value, 'image-b');
  assert.equal(h.element('#image-page-count').value, '4');
  assert.deepEqual(Array.from(h.state.imageReferenceIds), [reference.id]);
  assert.equal(h.requests.some(request => request.method === 'POST'), false);
});


test('视频任务从 running 轮询到 done 时加载已保存素材并自动更新生成结果页', async () => {
  const completed = { id: 'video-poll-completed', state: 'done', assetId: 'video-poll-result', model: 'video-a',
    prompt: '之前提交的视频提示词', message: '视频已保存', duration: 5, resolution: '720p', estimate: '1', progress: 100,
    createdAt: '2026-10-08T01:00:00Z' };
  const asset = { id: completed.assetId, kind: 'video', source: 'model', name: '已保存的生成视频.mp4', size: 100,
    createdAt: completed.createdAt };
  const h = await pageHarness({ respond: async (request, current) => {
    if (request.url.endsWith('/jobs?includeDeleted=1')) return [completed];
    assert.equal(request.url, '/api/projects/' + current.state.project.id);
    return { ...current.state.project, revision: current.state.project.revision + 1, assets: [asset] };
  } });
  h.state.jobs = [{ ...completed, state: 'running', assetId: '', progress: 40, message: '视频正在生成' }];
  h.setView('results');
  assert.match(h.element('#result-list').innerHTML, /还没有生成结果/);
  await h.refreshJobs();
  assert.equal(h.state.jobs.length, 1);
  assert.equal(h.state.jobs[0].id, completed.id);
  assert.equal(h.state.jobs[0].state, 'done');
  assert.deepEqual(h.state.project.assets, [asset]);
  assert.equal(h.element('#result-count').textContent, 1);
  assert.match(h.element('#result-list').innerHTML, /video-poll-result/);
  assert.match(h.element('#result-list').innerHTML, /已保存的生成视频/);
  assert.doesNotMatch(h.element('#result-list').innerHTML, /之前提交的视频提示词|download=1/);
  await h.element('#result-list').fire('click', { target: delegatedTarget('[data-result-details]', { resultDetails: asset.id }) });
  assert.match(h.element('#result-details-content').innerHTML, /之前提交的视频提示词/);
  assert.match(h.element('#result-details-content').innerHTML, /download=1/);
  assert.equal(h.state.view, 'results');
  assert.ok(h.canvasCalls.includes('render'), '任务变化后仍执行真实媒体保护逻辑和画布刷新');
  assert.deepEqual(h.requests.map(request => request.method), ['GET', 'GET']);
});


test('页面移除合成成片和工程导出入口，保留生成结果分类及时间排序', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['compose-video', 'bgm-asset', 'composition-summary', 'export-list',
    'export-project', 'delivery-export', 'script-download']) {
    assert.equal(html.includes('id="' + id + '"'), false, '不再显示旧工作台入口：' + id);
  }
  assert.doesNotMatch(html, /合成并导出|合成成片|导出工程(?: JSON)?/);
  const sort = html.match(/<select\b[^>]*id="result-sort"[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.ok(sort, '生成结果应提供时间排序控件');
  assert.deepEqual([...sort.matchAll(/<option\b[^>]*value="([^"]*)"/g)].map(match => match[1]), ['newest', 'oldest']);
});

test('生成结果按 createdAt 最新或最早排序，类型切换保留选定排序且不改变项目素材', async () => {
  const h = await pageHarness();
  h.state.project.assets = [
    { id: 'sort-middle-video', kind: 'video', source: 'model', name: '中间视频.mp4', size: 100, createdAt: '2026-10-08T03:00:00Z' },
    { id: 'sort-oldest-image', kind: 'image', source: 'model', name: '最早图片.png', size: 100, createdAt: '2026-10-08T01:00:00Z' },
    { id: 'sort-newest-image', kind: 'image', source: 'model', name: '最新图片.png', size: 100, createdAt: '2026-10-08T04:00:00Z' },
    { id: 'sort-older-video', kind: 'video', source: 'model', name: '较早视频.mp4', size: 100, createdAt: '2026-10-08T02:00:00Z' },
  ];
  const before = structuredClone(h.state.project.assets);
  const filter = h.element('#result-filter'), sort = h.element('#result-sort');
  filter.value = 'all'; sort.value = 'newest';
  const shownIds = () => [...h.element('#result-list').innerHTML.matchAll(/data-asset-id="([^"]+)"/g)].map(match => match[1]);
  h.setView('results');
  assert.deepEqual(shownIds(), ['sort-newest-image', 'sort-middle-video', 'sort-older-video', 'sort-oldest-image']);
  sort.value = 'oldest'; await sort.fire('change', { target: sort });
  assert.deepEqual(shownIds(), ['sort-oldest-image', 'sort-older-video', 'sort-middle-video', 'sort-newest-image']);
  filter.value = 'image'; await filter.fire('change', { target: filter });
  assert.equal(sort.value, 'oldest');
  assert.deepEqual(shownIds(), ['sort-oldest-image', 'sort-newest-image']);
  filter.value = 'video'; await filter.fire('change', { target: filter });
  assert.deepEqual(shownIds(), ['sort-older-video', 'sort-middle-video']);
  sort.value = 'newest'; await sort.fire('change', { target: sort });
  assert.deepEqual(shownIds(), ['sort-middle-video', 'sort-older-video']);
  filter.value = 'all'; await filter.fire('change', { target: filter });
  assert.equal(sort.value, 'newest');
  assert.deepEqual(shownIds(), ['sort-newest-image', 'sort-middle-video', 'sort-older-video', 'sort-oldest-image']);
  assert.deepEqual(h.state.project.assets, before, '排序只改变展示顺序');
  assert.deepEqual(h.requests, [], '筛选和排序应在本地完成');
});


test('新增视频默认只显示一个视频提示词，仍提供模型比例时长数量和分辨率参数', async () => {
  const h = await pageHarness();
  h.setView('videos');
  await h.element('#add-scene').click();
  assert.equal(h.state.project.scenes.length, 1);
  const scene = h.state.project.scenes[0], html = h.element('#scene-list').innerHTML;
  assert.equal(scene.videoPrompt, '');
  assert.deepEqual([...html.matchAll(/<textarea\b[^>]*data-scene-field="([^"]+)"/g)].map(match => match[1]), ['videoPrompt']);
  assert.equal([...html.matchAll(/<textarea\b/g)].length, 1, '默认只保留一个视频提示词输入');
  for (const field of ['videoModel', 'ratio', 'generationDuration', 'generationCount', 'resolution']) {
    assert.match(html, new RegExp('<select\\b[^>]*data-scene-field="' + field + '"'), '保留视频参数：' + field);
  }
  for (const field of ['visual', 'narration', 'imagePrompt', 'duration']) {
    assert.doesNotMatch(html, new RegExp('<(?:input|textarea|select)\\b[^>]*data-scene-field="' + field + '"'), '移除额外编辑框：' + field);
  }
  assert.match(html, /data-scene-action="generate"/);
  assert.deepEqual(h.requests, [], '新增本地视频生成项不应调用模型');
});

test('视频页新增只请求把新生成项放到画布，不隐式恢复已移除的旧视频卡片', async () => {
  const h = await pageHarness();
  h.state.project.scenes.push({id:'removed-completed-scene',title:'已经生成过的视频',videoPrompt:'保留旧提示词',references:[],duration:5});
  h.setView('videos'); await h.element('#add-scene').click();
  const placed = h.canvasCalls.filter(call=>call.action === 'syncScenes');
  assert.equal(placed.length,1);
  assert.deepEqual(Array.from(placed[0].options?.sceneIds || []),[h.state.project.scenes[1].id]);
  assert.equal(h.state.project.scenes[0].videoPrompt,'保留旧提示词');
  assert.deepEqual(h.requests,[]);
});

test('视频页修改秒数和数量后再次生成按新参数提交，历史已完成和已删除待核对记录保持原样', async () => {
  const h = await pageHarness({respond:async (request,current)=>request.method === 'POST'
    ? {count:3,jobs:[{id:'new-video-job',sceneId:'regenerate-scene',state:'queued',duration:15,createdAt:'2026-10-09T00:00:00Z',message:'等待平台生成'}]}
    : {...current.state.project,revision:current.state.project.revision+1}});
  h.state.catalog[0].tiers = [5,10,15].map(duration=>({duration,resolution:'720p',price:duration/5}));
  const scene = {id:'regenerate-scene',title:'再次生成',videoPrompt:'第二版画面',generationDuration:5,generationCount:1,
    videoAssetId:'existing-result',references:[],promptMentions:[],duration:2.5};
  h.state.project.scenes.push(scene);
  h.state.project.assets.push({id:'existing-result',sceneId:scene.id,kind:'video',source:'model',name:'已有结果.mp4',createdAt:'2026-10-08T00:00:00Z'});
  h.state.jobs = [{id:'old-done',sceneId:scene.id,state:'done',duration:5,assetId:'existing-result',createdAt:'2026-10-08T00:00:00Z',message:'视频已保存'},
    {id:'old-uncertain',sceneId:scene.id,state:'uncertain',duration:10,createdAt:'2026-10-08T00:00:00Z',message:'需要核对',deletedAt:'2026-10-08T00:00:00Z'}];
  const history = structuredClone(h.state.jobs); h.state.saved = structuredClone(h.state.project);
  const card = h.element('#regenerate-card'); card.dataset.sceneId = scene.id;
  for (const [field,value] of [['generationDuration','15'],['generationCount','3']]) {
    const control = h.element('#regenerate-'+field); control.tagName = 'SELECT'; control.dataset.sceneField = field; control.value = value;
    control.matches = () => false;
    control.closest = selector=>selector === '.scene-card' ? card : null;
    await h.element('#scene-list').fire('change',{target:control});
  }
  await h.generateScene(scene.id);
  const posts = h.requests.filter(request=>request.method === 'POST');
  assert.equal(posts.length,1); assert.equal(posts[0].body.duration,15); assert.equal(posts[0].body.count,3);
  assert.deepEqual(Array.from(h.state.jobs.slice(1)),history);
  assert.equal(h.state.project.scenes[0].duration,2.5); assert.equal(h.state.project.scenes[0].videoAssetId,'existing-result');
});

test('旧视频生成项使用紧凑视频提示词编辑时保留原画面旁白图片提示词和剪辑时长', async () => {
  const h = await pageHarness();
  const oldFields = { visual: '以前写的画面描述', narration: '以前写的旁白', imagePrompt: '以前写的图片提示词', duration: 12 };
  const scene = { id: 'legacy-video-draft', order: 1, title: '保留内容的视频生成项', ...oldFields,
    videoPrompt: '原视频提示词', videoModel: 'video-a', generationDuration: 5, generationCount: 1,
    ratio: '', resolution: '720p', references: [], promptMentions: [], videoAssetId: '', referenceAssetId: '' };
  h.state.project.scenes.push(scene);
  h.state.saved = structuredClone(h.state.project);
  h.setView('videos');
  const html = h.element('#scene-list').innerHTML;
  assert.match(html, /原视频提示词/);
  assert.doesNotMatch(html, /以前写的画面描述|以前写的旁白|以前写的图片提示词/);
  const card = h.element('#legacy-video-card'); card.dataset.sceneId = scene.id;
  const control = h.element('#legacy-video-prompt'); control.tagName = 'TEXTAREA';
  control.dataset.sceneField = 'videoPrompt'; control.value = '直接描述新的电影画面、动作和镜头';
  control.closest = selector => selector === '.scene-card' ? card : null;
  await h.element('#scene-list').fire('input', { target: control });
  assert.equal(scene.videoPrompt, control.value);
  for (const view of ['results', 'assets', 'images', 'videos']) h.setView(view);
  const savedScene = h.state.project.scenes.find(item => item.id === scene.id);
  assert.deepEqual(Object.fromEntries(Object.keys(oldFields).map(field => [field, savedScene[field]])), oldFields);
  assert.equal(savedScene.videoPrompt, control.value);
  assert.equal(savedScene.generationDuration, 5);
  assert.equal(savedScene.generationCount, 1);
  assert.match(h.element('#scene-list').innerHTML, /直接描述新的电影画面/);
  assert.ok(h.state.dirty.has('scenes'), '普通编辑仍进入工程保存流程');
  assert.deepEqual(h.requests, [], '编辑和切换入口不提交模型请求');
});


test('素材库生成图片保留以此图生成入口，选择预览移除和重复添加都不自动收费', async () => {
  const h = await pageHarness();
  const asset = { id: 'image-reuse-source', kind: 'image', source: 'model', name: '原生成图.png', size: 100,
    createdAt: '2026-10-08T01:00:00Z' };
  h.state.project.assets = [asset];
  const before = structuredClone(h.state.project);
  h.setView('assets');
  assert.match(h.element('#asset-list').innerHTML, /data-use-image-reference="image-reuse-source"/);
  await h.element('#asset-list').fire('click', { target: delegatedTarget('[data-use-image-reference]', { useImageReference: asset.id }) });
  assert.equal(h.state.view, 'images');
  assert.deepEqual(Array.from(h.state.imageReferenceIds), [asset.id]);
  assert.match(h.element('#image-page-references').innerHTML, /src="\/api\/assets\/image-reuse-source"/);
  assert.match(h.element('#image-page-references').innerHTML, /原生成图.png/);
  h.addImagePageReference(asset.id);
  assert.equal(h.state.imageReferenceIds.length, 1, '同一图片不重复作为参考');
  await h.element('#image-page-references').fire('click', { target: delegatedTarget('[data-preview-asset]', { previewAsset: asset.id }) });
  assert.equal(h.element('#preview-dialog').open, true);
  assert.equal(h.element('#preview-content').children[0].src, '/api/assets/' + asset.id);
  await h.element('#image-page-references').fire('click', { target: delegatedTarget('[data-remove-image-reference]', { removeImageReference: asset.id }) });
  assert.deepEqual(Array.from(h.state.imageReferenceIds), []);
  assert.match(h.element('#image-page-reference-picker').innerHTML, /image-reuse-source/);
  assert.deepEqual(h.state.project.assets, before.assets);
  assert.deepEqual(h.state.project.scenes, before.scenes);
  assert.deepEqual(h.requests, []);
});

test('参考图片选择器仅提供当前工程的有效图片，支持已上传和已生成图片并拒绝其他来源', async () => {
  const h = await pageHarness();
  const uploaded = { id: 'valid-uploaded-reference', kind: 'image', source: 'upload', name: '上传参考.png', size: 100 };
  const generated = { id: 'valid-generated-reference', kind: 'image', source: 'model', name: '生成参考.png', size: 100 };
  h.state.project.assets = [uploaded, generated,
    { id: 'invalid-video-reference', kind: 'video', source: 'model', name: '不能作图片参考.mp4', size: 100 },
    { id: 'invalid-deleted-reference', kind: 'image', source: 'upload', name: '删除参考.png', size: 100, deletedAt: '2026-10-08T01:00:00Z' }];
  const other = createProject({ title: '其他工程' });
  other.assets = [{ id: 'invalid-other-project-reference', kind: 'image', source: 'upload', name: '其他工程图片.png', size: 100 }];
  h.state.projects = [h.state.project, other];
  h.setView('images');
  const picker = h.element('#image-page-reference-picker');
  assert.match(picker.innerHTML, /valid-uploaded-reference/);
  assert.match(picker.innerHTML, /已上传/);
  assert.match(picker.innerHTML, /valid-generated-reference/);
  assert.match(picker.innerHTML, /已生成/);
  assert.doesNotMatch(picker.innerHTML, /invalid-video-reference|invalid-deleted-reference|invalid-other-project-reference/);
  picker.value = uploaded.id; await picker.fire('change', { target: picker });
  picker.value = generated.id; await picker.fire('change', { target: picker });
  assert.deepEqual(Array.from(h.state.imageReferenceIds), [uploaded.id, generated.id]);
  assert.doesNotMatch(picker.innerHTML, /valid-uploaded-reference|valid-generated-reference/);
  for (const id of ['invalid-video-reference', 'invalid-deleted-reference', 'invalid-other-project-reference', 'missing-reference']) {
    assert.throws(() => h.addImagePageReference(id), /当前工程中可用的图片/);
  }
  assert.deepEqual(Array.from(h.state.imageReferenceIds), [uploaded.id, generated.id]);
  assert.deepEqual(h.requests, []);
});

test('上传图片只进行素材上传并加入参考，保留模型提示词和张数草稿，不创建生成任务', async () => {
  const asset = { id: 'uploaded-page-reference', kind: 'image', source: 'upload', name: '本机参考.png', size: 12 };
  const h = await pageHarness({ respond: async (request, current) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/projects/' + current.state.project.id + '/assets');
    return { asset, project: { ...current.state.project, revision: current.state.project.revision + 1,
      assets: [...current.state.project.assets, asset] } };
  } });
  h.setView('images');
  h.element('#image-page-model').value = 'image-b';
  h.element('#image-page-prompt').value = '上传时保留未提交提示词';
  h.element('#image-page-count').value = '3';
  const input = h.element('#image-page-reference-input');
  const file = Object.assign(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]), { name: '本机参考.png', type: 'image/png' });
  input.files = [file]; input.value = '本机参考.png';
  await input.fire('change', { target: input });
  await until(() => h.state.imageReferenceIds.includes(asset.id) && !h.element('#image-page-reference-upload').disabled);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body, file);
  assert.equal(h.requests[0].headers['X-File-Name'], encodeURIComponent(file.name));
  assert.deepEqual(Array.from(h.state.imageReferenceIds), [asset.id]);
  assert.match(h.element('#image-page-references').innerHTML, /本机参考.png/);
  assert.equal(h.element('#image-page-model').value, 'image-b');
  assert.equal(h.element('#image-page-prompt').value, '上传时保留未提交提示词');
  assert.equal(h.element('#image-page-count').value, '3');
  assert.equal(input.value, '');
  assert.equal(h.state.imageJobs.length, 0);
  assert.equal(h.state.jobs.length, 0);
  assert.equal(h.state.project.scenes.length, 0);
});

test('已选参考图变为不可用时保持可见记录并拦截提交，不静默退成纯文字生成', async () => {
  const h = await pageHarness();
  const asset = { id: 'reference-deleted-after-selection', kind: 'image', source: 'upload', name: '刚删除的参考.png', size: 100 };
  h.state.project.assets = [asset];
  h.setView('images');
  h.element('#image-page-prompt').value = '必须使用已选图片的请求';
  h.addImagePageReference(asset.id);
  asset.deletedAt = '2026-10-08T01:00:00Z';
  h.setView('images');
  assert.deepEqual(Array.from(h.state.imageReferenceIds), [asset.id], '不能自动丢掉不可用参考');
  assert.match(h.element('#image-page-references').innerHTML, /图片不可用/);
  assert.match(h.element('#image-page-reference-note').textContent, /删除或不可用/);
  assert.equal(h.element('#image-page-form [type=submit]').disabled, true);
  assert.match(h.imagePageIssue(), /删除或不可用/);
  await h.element('#image-page-form').fire('submit', { preventDefault() {} });
  await until(() => !h.state.submitting.has('image-page-form'));
  assert.equal(h.requests.some(request => request.method === 'POST'), false, '不可用参考在提交边界也应被拒绝');
});

test('切换工程重置图片提示词模型张数和参考图，防止将前一个工程草稿带入新工程', async () => {
  const h = await pageHarness();
  const asset = { id: 'previous-project-reference', kind: 'image', source: 'upload', name: '旧工程参考.png', size: 100 };
  h.state.project.assets = [asset];
  h.setView('images');
  h.element('#image-page-model').value = 'image-b';
  h.element('#image-page-prompt').value = '旧工程未提交草稿';
  h.element('#image-page-count').value = '5';
  h.element('#image-page-quality').value = '4k';
  h.addImagePageReference(asset.id);
  h.setProject(createProject({ title: '切换到新工程' }));
  assert.equal(h.element('#image-page-prompt').value, '');
  assert.equal(h.element('#image-page-model').value, 'image-a');
  assert.equal(h.element('#image-page-count').value, '1');
  assert.equal(h.element('#image-page-quality').value, 'auto');
  assert.deepEqual(Array.from(h.state.imageReferenceIds), []);
  assert.doesNotMatch(h.element('#image-page-reference-picker').innerHTML, /previous-project-reference/);
  assert.deepEqual(h.requests, []);
});


test('图片页选择三张并使用上传和生成参考图，一次提交后立即追踪整批任务并保存全部结果', async () => {
  const uploaded = { id: 'batch-uploaded-reference', kind: 'image', source: 'upload', name: '人物参考.png', size: 100 };
  const generated = { id: 'batch-generated-reference', kind: 'image', source: 'model', name: '场景参考.png', size: 100 };
  let batch, pollJobs, resultAssets = [], releaseFirstPoll;
  const firstPoll = new Promise(resolve => { releaseFirstPoll = resolve; });
  let firstPollHeld = true;
  const h = await pageHarness({ respond: async (request, current) => {
    if (request.method === 'POST') return batch;
    if (request.url.includes('/image-jobs')) {
      if (firstPollHeld) { firstPollHeld = false; await firstPoll; }
      return pollJobs;
    }
    return { ...current.state.project, revision: current.state.project.revision + 1,
      assets: [uploaded, generated, ...resultAssets] };
  } });
  h.state.project.assets = [uploaded, generated];
  batch = imageBatchFixture(h.state.project.id, { referenceAssetIds: [uploaded.id, generated.id] });
  pollJobs = batch.jobs.map((job, index) => ({ ...job, state: ['preparing', 'submitting', 'saving'][index] }));
  enableImageReferenceModel(h);
  h.element('#image-page-prompt').value = '  ' + batch.jobs[0].prompt + '  ';
  h.element('#image-page-count').value = '3';
  h.element('#image-page-quality').value = '2k';
  h.addImagePageReference(uploaded.id); h.addImagePageReference(generated.id);
  const form = h.element('#image-page-form'), submit = form.querySelector('[type=submit]');
  await form.fire('submit', { preventDefault() {} });
  await until(() => h.requests.some(request => request.method === 'GET' && request.url.includes('/image-jobs')));
  const posts = h.requests.filter(request => request.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { sceneId: '', model: 'gpt-image-2.5-flare', prompt: batch.jobs[0].prompt,
    count: 3, referenceAssetIds: [uploaded.id, generated.id], operationId: 'operation-1', config: { quality: '2k' } });
  assert.deepEqual(Array.from(h.state.imageJobs, job => job.id), batch.jobs.map(job => job.id),
    '轮询尚未返回时也应将批次展开为三个任务');
  assert.equal(h.state.imageJobs.some(job => Array.isArray(job.jobs)), false, '批次外壳不能作为任务记录');
  releaseFirstPoll();
  await until(() => !submit.disabled && h.state.imageJobs[2]?.state === 'saving');
  assert.match(h.element('#image-job-list').innerHTML, /准备参考图|准备参考图片/);
  for (let index = 1; index <= 3; index++) assert.match(h.element('#image-job-list').innerHTML, new RegExp('候选 ' + index + ' / 3'));
  resultAssets = batch.jobs.map(job => ({ id: 'saved-' + job.id, kind: 'image', source: 'model',
    name: '生成图-' + job.variantIndex + '.png', size: 100, createdAt: job.createdAt }));
  pollJobs = batch.jobs.map((job, index) => ({ ...job, state: 'done', assetId: resultAssets[index].id }));
  await h.refreshImageJobs();
  assert.deepEqual(Array.from(h.state.imageJobs, job => [job.id, job.state, job.assetId]),
    pollJobs.map(job => [job.id, 'done', job.assetId]));
  assert.ok(resultAssets.every(asset => h.state.project.assets.some(saved => saved.id === asset.id)));
  assert.equal(h.element('#image-page-count').value, '3');
  assert.equal(h.element('#image-page-prompt').value, '  ' + batch.jobs[0].prompt + '  ');
  assert.equal(h.element('#image-page-model').value, 'gpt-image-2.5-flare');
  assert.deepEqual(Array.from(h.state.imageReferenceIds), [uploaded.id, generated.id]);
  h.element('#result-filter').value = 'image'; h.setView('results');
  for (const asset of resultAssets) assert.match(h.element('#result-list').innerHTML,
    new RegExp('<img[^>]+src="/api/assets/' + asset.id + '"'));
  assert.equal(h.state.project.scenes.length, 0);
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 1, '轮询完成全部结果不会重新提交生成');
});

test('图片批次提交确认中断后按 batchOperationId 找回全部原任务，不重复 POST', async () => {
  let batch;
  const reference = { id: 'ambiguous-image-reference', kind: 'image', source: 'upload', name: '需保持的人物.png', size: 100 };
  const h = await pageHarness({ respond: async (request, current) => {
    if (request.method === 'POST') throw new Error('模拟已创建批次后连接中断');
    if (request.url.includes('/image-jobs')) return batch.jobs;
    return { ...current.state.project, revision: current.state.project.revision + 1 };
  } });
  h.state.project.assets = [reference];
  batch = imageBatchFixture(h.state.project.id, { referenceAssetIds: [reference.id] });
  enableImageReferenceModel(h);
  h.element('#image-page-prompt').value = batch.jobs[0].prompt;
  h.element('#image-page-count').value = '3'; h.addImagePageReference(reference.id);
  const form = h.element('#image-page-form'), submit = form.querySelector('[type=submit]');
  await form.fire('submit', { preventDefault() {} });
  await until(() => /提交确认暂未收到/.test(h.element('#image-page-message').textContent) && !submit.disabled);
  assert.equal(h.state.imageOperations.size, 1);
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
  assert.ok(batch.jobs.every(job => job.operationId !== 'operation-1'), '子任务操作编号必须不同于原批次编号');
  await form.fire('submit', { preventDefault() {} });
  await until(() => /已找到原图片任务/.test(h.element('#image-page-message').textContent) && !submit.disabled);
  assert.deepEqual(Array.from(h.state.imageJobs, job => job.id), batch.jobs.map(job => job.id));
  assert.equal(h.state.imageOperations.size, 0, '找到原批次后清理歧义操作标记');
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 1, '核对使用批次编号，不能再创建付费请求');
  assert.ok(h.requests.some(request => request.url.endsWith('/image-jobs?includeDeleted=1')));
  assert.deepEqual(Array.from(h.state.imageReferenceIds), [reference.id]);
  assert.equal(h.element('#image-page-count').value, '3');
});

test('单张旧弹窗兼容单 job 响应，保留 sceneId 且不带入独立图片页所选参考', async () => {
  const scene = { id: 'legacy-image-scene', title: '既有视频项', imagePrompt: '旧弹窗单张提示词',
    videoPrompt: '原视频提示词', visual: '保留旧画面', narration: '保留旧旁白', duration: 8 };
  const job = { id: 'legacy-single-image-job', state: 'submitting', model: 'image-b', prompt: scene.imagePrompt,
    sceneId: scene.id, operationId: 'operation-1', createdAt: '2026-10-08T01:00:00Z' };
  const reference = { id: 'page-only-reference', kind: 'image', source: 'upload', name: '页面独有参考.png', size: 100 };
  const h = await pageHarness({ respond: async (request, current) => request.method === 'POST' ? job
    : request.url.includes('/image-jobs') ? [job] : current.state.project });
  h.state.project.scenes = [scene]; h.state.project.assets = [reference];
  enableImageReferenceModel(h); h.addImagePageReference(reference.id);
  h.element('#image-page-prompt').value = '保留页面草稿'; h.element('#image-page-count').value = '4';
  h.element('#image-model').value = 'image-b'; h.element('#image-prompt').value = scene.imagePrompt; h.element('#image-quality').value = '2k';
  h.element('#image-scene-id').value = scene.id; h.element('#image-count').value = '1';
  h.element('#image-dialog').showModal();
  await h.element('#image-form').fire('submit', { preventDefault() {} });
  await until(() => h.state.imageJobs[0]?.id === job.id && !h.element('#image-form [type=submit]').disabled);
  const posts = h.requests.filter(request => request.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { sceneId: scene.id, model: 'image-b', prompt: scene.imagePrompt,
    count: 1, referenceAssetIds: [], operationId: 'operation-1', config: { quality: '2k' } });
  assert.deepEqual(Array.from(h.state.imageJobs, item => item.id), [job.id]);
  assert.equal(h.element('#image-dialog').open, false);
  assert.deepEqual(h.state.project.scenes, [scene]);
  assert.deepEqual(Array.from(h.state.imageReferenceIds), [reference.id]);
  assert.equal(h.element('#image-page-count').value, '4');
  assert.equal(h.element('#image-page-prompt').value, '保留页面草稿');
});

test('图片页生成张数越界或不是整数时在请求之前拒绝提交', async () => {
  for (const count of ['0', '6', '1.5', '不是数字']) {
    const h = await pageHarness(); h.setView('images');
    h.element('#image-page-prompt').value = '用于数量校验的有效提示词';
    h.element('#image-page-count').value = count;
    await h.element('#image-page-form').fire('submit', { preventDefault() {} });
    await until(() => /图片生成张数/.test(h.element('#toast').textContent));
    assert.deepEqual(h.requests, [], '非法张数 ' + count + ' 不能发送请求');
    assert.equal(h.state.imageOperations.size, 0);
  }
});

test('画布生图将已保存张数同时传入 count 和 expectedConfig，并展开全部返回任务', async () => {
  let batch;
  const config = { model: 'image-b', prompt: '画布批量雨夜书店', ratio: '16:9', quality: '2k', style: 'cinematic', count: 4 };
  const imageNode = { id: 'canvas-image-count', kind: 'image', role: 'image-generation', label: '四张生图卡片',
    imageConfig: config, x: 0, y: 0, width: 320, height: 260, status: 'pending', assetId: '', sceneId: '' };
  const h = await pageHarness({ respond: async (request, current) => request.method === 'POST' ? batch
    : request.url.includes('/image-jobs') ? batch.jobs : { ...current.state.project, revision: current.state.project.revision + 1 } });
  h.state.project.graph.nodes = [imageNode];
  batch = imageBatchFixture(h.state.project.id, { count: 4, nodeId: imageNode.id, model: config.model, prompt: config.prompt });
  await h.generateImageCard(imageNode.id);
  const posts = h.requests.filter(request => request.method === 'POST');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { nodeId: imageNode.id, expectedConfig: config, count: 4, operationId: 'operation-1' });
  assert.deepEqual(Array.from(h.state.imageJobs, job => job.id), batch.jobs.map(job => job.id));
  const savedNode = h.state.project.graph.nodes.find(node => node.id === imageNode.id);
  assert.equal(savedNode.imageConfig.count, 4);
  assert.deepEqual(Array.from(savedNode.imageJobIds), batch.jobs.map(job => job.id));
  assert.equal(savedNode.status, 'pending');
  assert.equal(h.state.imageOperations.size, 0);
  assert.equal(h.state.submitting.has('image:' + imageNode.id), false);
});

test('画布批量生图确认中断后按 batchOperationId 找回原任务而不再次提交', async () => {
  let batch;
  const imageNode = { id: 'canvas-ambiguous-image', kind: 'image', role: 'image-generation', label: '批量确认中断卡片',
    imageConfig: { model: 'image-b', prompt: '画布三张批量提示词', count: 3 },
    x: 0, y: 0, width: 320, height: 260, status: 'pending', assetId: '', sceneId: '' };
  const h = await pageHarness({ respond: async (request, current) => {
    if (request.method === 'POST') throw new Error('模拟画布批次响应丢失');
    if (request.url.includes('/image-jobs')) return batch.jobs;
    return { ...current.state.project, revision: current.state.project.revision + 1 };
  } });
  h.state.project.graph.nodes = [imageNode];
  batch = imageBatchFixture(h.state.project.id, { nodeId: imageNode.id, model: 'image-b', prompt: imageNode.imageConfig.prompt });
  await h.generateImageCard(imageNode.id);
  assert.match(h.element('#toast').textContent, /提交确认暂未收到/);
  assert.equal(h.state.imageOperations.size, 1);
  await h.generateImageCard(imageNode.id);
  assert.match(h.element('#toast').textContent, /已找到原生图任务/);
  assert.deepEqual(Array.from(h.state.imageJobs, job => job.id), batch.jobs.map(job => job.id));
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(h.state.imageOperations.size, 0);
  assert.equal(h.state.submitting.has('image:' + imageNode.id), false);
  const savedNode = h.state.project.graph.nodes.find(node => node.id === imageNode.id);
  assert.deepEqual(Array.from(savedNode.imageJobIds), batch.jobs.map(job => job.id));
});

test('素材库和生成结果按工程分组并支持工程筛选', async () => {
  const h = await pageHarness();
  const first = h.state.project;
  first.title = '工程甲';
  first.assets = [
    { id: 'asset-project-a', kind: 'image', source: 'upload', name: '甲参考.png', size: 100 },
    { id: 'result-project-a', kind: 'image', source: 'model', name: '甲生成.png', size: 100, createdAt: '2026-10-10T01:00:00Z' },
  ];
  const second = createProject({ title: '工程乙' });
  second.assets = [
    { id: 'asset-project-b', kind: 'image', source: 'upload', name: '乙参考.png', size: 100 },
    { id: 'result-project-b', kind: 'video', source: 'model', name: '乙生成.mp4', size: 100, createdAt: '2026-10-10T02:00:00Z' },
  ];
  h.state.projects = [structuredClone(first), second];

  h.setView('assets');
  const assets = h.element('#asset-list');
  assert.match(assets.innerHTML, /project-asset-group[^>]+data-project-id="[^"]+"/);
  assert.match(assets.innerHTML, /工程甲[\s\S]*甲参考\.png/);
  assert.match(assets.innerHTML, /工程乙[\s\S]*乙参考\.png/);
  const assetFilter = h.element('#asset-project-filter');
  assert.match(assetFilter.innerHTML, /工程甲/);
  assert.match(assetFilter.innerHTML, /工程乙/);
  assetFilter.value = second.id;
  await assetFilter.fire('change', { target: assetFilter });
  assert.doesNotMatch(assets.innerHTML, /asset-project-a|甲参考/);
  assert.match(assets.innerHTML, /asset-project-b|乙参考/);

  h.setView('results');
  const results = h.element('#result-list');
  assert.match(results.innerHTML, /project-result-group[^>]+data-project-id="[^"]+"/);
  assert.match(results.innerHTML, /工程甲[\s\S]*result-project-a/);
  assert.match(results.innerHTML, /工程乙[\s\S]*result-project-b/);
  const resultFilter = h.element('#result-project-filter');
  resultFilter.value = second.id;
  await resultFilter.fire('change', { target: resultFilter });
  assert.doesNotMatch(results.innerHTML, /result-project-a|甲生成/);
  assert.match(results.innerHTML, /result-project-b|乙生成/);
});

test('跨工程结果详情和素材恢复使用素材所属工程', async () => {
  const firstAssetId = 'same-result-id';
  const deletedId = 'deleted-project-b';
  const h = await pageHarness({ respond: async (request, current) => {
    if (request.method === 'POST' && request.url.endsWith('/api/projects/project-b/assets/' + deletedId + '/restore')) {
      return { ...current.state.projects.find(project => project.id === 'project-b'),
        assets: current.state.projects.find(project => project.id === 'project-b').assets.map(asset => asset.id === deletedId ? { ...asset, deletedAt: null } : asset) };
    }
    return current.state.project;
  }});
  const first = h.state.project;
  first.title = '当前工程';
  first.assets = [{ id: firstAssetId, kind: 'image', source: 'model', name: '当前工程结果.png', size: 100, createdAt: '2026-10-10T01:00:00Z' }];
  const second = createProject({ title: '工程乙' });
  second.id = 'project-b';
  second.assets = [
    { id: firstAssetId, kind: 'image', source: 'model', name: '工程乙结果.png', size: 100, createdAt: '2026-10-10T02:00:00Z' },
    { id: deletedId, kind: 'image', source: 'upload', name: '工程乙待恢复.png', size: 100, deletedAt: '2026-10-10T03:00:00Z' },
  ];
  h.state.projects = [structuredClone(first), second];

  h.setView('results');
  await h.element('#result-list').fire('click', { target: delegatedTarget('[data-result-details]', { resultDetails: firstAssetId, projectId: second.id }) });
  assert.equal(h.element('#result-details-title').textContent, '工程乙结果.png');
  assert.match(h.element('#result-details-content').innerHTML, /工程乙/);

  h.state.showDeletedAssets = true;
  h.setView('assets');
  await h.element('#asset-list').fire('click', { target: delegatedTarget('[data-delete-asset],[data-restore-asset]', { restoreAsset: deletedId, projectId: second.id }) });
  await until(() => h.requests.some(request => request.url.endsWith('/api/projects/project-b/assets/' + deletedId + '/restore'))
    && h.state.projects.find(project => project.id === second.id)?.assets.find(asset => asset.id === deletedId)?.deletedAt === null);
  assert.equal(h.requests.at(-1).url, '/api/projects/project-b/assets/' + deletedId + '/restore');
  assert.equal(h.state.project.id, first.id, '跨工程恢复不应切换当前工程');
  assert.equal(h.state.projects.find(project => project.id === second.id).assets.find(asset => asset.id === deletedId).deletedAt, null);
});
