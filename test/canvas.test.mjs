import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canvasLinkAppearance, createInfiniteCanvas, createAssetCanvasNode, validateCanvasLink } from '../public/canvas.js';
import { intersectsRect, WORLD_LIMIT } from '../public/canvas-geometry.js';
import { kinds, validateGraph } from '../lib/workflow.mjs';
import { normalizeImageConfig, resolveImageInputs } from '../public/image-parameters.js';
import { videoParameters } from '../public/video-parameters.js';

const node = (id, kind = 'script', extra = {}) => ({ id, kind, label: id, note: '', status: 'pending', x: 0, y: 0, width: 320, height: 260, assetId: '', sceneId: '', assetName: '', ...extra });
const graph = (nodes = [], links = []) => ({ nodes, links, viewport: { x: 0, y: 0, zoom: 1 } });

test('画布连接的文本、图像、视频和声音类型与后端契约一致', () => {
  for (const [fromKind, toKind, allowed] of [['text','video',true], ['image','video',true], ['video','video',true], ['audio','compose',true], ['text','script',true], ['audio','image',false], ['video','audio',false], ['video','text',false], ['image','brief',false]]) {
    const input = graph([node('from', fromKind), node('to', toKind)]);
    const message = validateCanvasLink(input, kinds, 'from', 'to');
    const proposed = { ...input, links: [{ id: 'edge', from: 'from', to: 'to' }] };
    assert.equal(message === '', allowed, fromKind + ' to ' + toKind);
    if (allowed) assert.doesNotThrow(() => validateGraph(proposed));
    else assert.throws(() => validateGraph(proposed));
    assert.equal(input.links.length, 0, '校验不得修改画布');
  }
});

test('自连、缺失目标和已有连接在修改图前被拒绝', () => {
  const input = graph([node('a'), node('b')], [{ id:'edge', from:'a', to:'b' }]);
  const before = structuredClone(input);
  assert.match(validateCanvasLink(input, kinds, 'a', 'a'), /不同/);
  assert.match(validateCanvasLink(input, kinds, 'a', 'missing'), /不同/);
  assert.match(validateCanvasLink(input, kinds, 'a', 'b'), /已经连接/);
  assert.deepEqual(input, before);
});

test('60 个节点的长 DAG 回边被拒绝，合法前向捷径可保存', () => {
  const input = graph(Array.from({length:60}, (_, i) => node('n'+i)), Array.from({length:59}, (_, i) => ({id:'e'+i, from:'n'+i, to:'n'+(i+1)})));
  assert.doesNotThrow(() => validateGraph(input));
  assert.match(validateCanvasLink(input, kinds, 'n59', 'n0'), /循环/);
  assert.equal(validateCanvasLink(input, kinds, 'n0', 'n59'), '');
  assert.doesNotThrow(() => validateGraph({ ...input, links:[...input.links, { id:'shortcut', from:'n0', to:'n59' }] }));
});

test('160 条连接上限与后端一致，移除一条后可以重新连接', () => {
  const nodes = Array.from({length:20}, (_, i) => node('n'+i));
  const links = [];
  for (let from=0; from<20; from++) for (let to=from+1; to<20; to++) links.push({id:'e'+links.length,from:'n'+from,to:'n'+to});
  const input = graph(nodes, links.slice(0,160));
  assert.doesNotThrow(() => validateGraph(input));
  assert.match(validateCanvasLink(input, kinds, links[160].from, links[160].to), /160/);
  const removed = input.links.pop();
  assert.equal(validateCanvasLink(input, kinds, removed.from, removed.to), '');
  assert.doesNotThrow(() => validateGraph({ ...input, links:[...input.links,removed] }));
});

test('连线编号仅在聚焦单条连接时显示，选中卡片只突出相关连线', () => {
  const first = { id:'first', from:'image-a', to:'shot-a' }, second = { id:'second', from:'video-a', to:'shot-b' };
  const selection = new Set(['shot-a']);
  assert.deepEqual(canvasLinkAppearance(first, {selection}),
    {selected:false,highlighted:false,related:true,dimmed:false,labelVisible:false});
  assert.deepEqual(canvasLinkAppearance(second, {selection}),
    {selected:false,highlighted:false,related:false,dimmed:true,labelVisible:false});
  assert.equal(canvasLinkAppearance(first, {focusedLink:'first'}).labelVisible, true);
  assert.equal(canvasLinkAppearance(second, {focusedLink:'first'}).dimmed, true);
  assert.equal(canvasLinkAppearance(first, {selectedLink:'first'}).selected, true);
  assert.equal(canvasLinkAppearance(first, {selectedLink:'first'}).labelVisible, true);
  assert.equal(canvasLinkAppearance(first, {focusedLink:'first',zoom:.64}).labelVisible, false);
  assert.equal(canvasLinkAppearance(first, {focusedLink:'first',hideLabels:true}).labelVisible, false);
});

// Only model the DOM primitives used by the public canvas. All graph mutations,
// history, bindings and card markup below come from createInfiniteCanvas itself.
function canvasHarness(t, project = { id:'project-test', graph:graph(), scenes:[], assets:[] }) {
  const elements = new Map();
  class Element {
    constructor(tagName = 'div') {
      this.tagName = tagName.toUpperCase(); this.dataset = {}; this.style = { setProperty: (name,value) => { this.style[name] = String(value); this.onStyleChange?.(name,String(value)); } }; this.hidden = false;
      this.children = []; this.listeners = new Map(); this.textContent = ''; this.attributes = new Map();
      this.clientWidth = 1024; this.clientHeight = 700; this.scrollHeight = 700; this.scrollTop = 0; this.offsetHeight = 260; this.readOnly = false;
      this.capturedPointers = new Set(); this.value = ''; this.selectionStart = 0; this.selectionEnd = 0; this.disabled = false;
      const classes = new Set(); let markup = '';
      this.classList = { contains: value => classes.has(value), add: value => classes.add(value), remove: value => classes.delete(value),
        toggle(value, state) { const next = state === undefined ? !classes.has(value) : state; if (next) classes.add(value); else classes.delete(value); return next; } };
      Object.defineProperty(this, 'className', { get: () => [...classes].join(' '),
        set: value => { classes.clear(); for (const name of String(value).split(/\s+/).filter(Boolean)) classes.add(name); } });
      Object.defineProperty(this, 'innerHTML', { get: () => markup,
        set: value => { markup = String(value); this.replaceChildren(); for (const child of this.childrenFromHTML?.(markup) || []) this.append(child); } });
      Object.defineProperty(this, 'outerHTML', { get: () => this.serializedOuterHTML || markup,
        set: value => {
          const parent = this.parent, index = parent?.children.indexOf(this) ?? -1;
          const replacements = this.elementsFromOuterHTML?.(String(value));
          if (index < 0 || !Array.isArray(replacements)) throw new Error('outerHTML replacement requires attached, parsed elements');
          this.outerHTMLUpdates = [...(this.outerHTMLUpdates || []), String(value)];
          parent.children.splice(index, 1, ...replacements); this.parent = null;
          for (const child of replacements) child.parent = parent;
        } });
    }
    addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(handler); }
    fire(type, event) { return Promise.all((this.listeners.get(type) || []).map(handler => handler(event))); }
    append(child) { this.children.push(child); child.parent = this; }
    replaceChildren() { for (const child of this.children) child.parent = null; this.children = []; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
    contains(child) { return child === this || this.children.some(item => item.contains(child)); }
    matches(selector) {
      return selector.split(',').some(value => {
        const part = value.trim();
        if (part.startsWith('#')) return this.id === part.slice(1);
        if (part === ':hover') return Boolean(this.hovered);
        if (part === ':focus-within') return this.contains(document.activeElement);
        if (part === 'input:not([readonly])') return this.tagName === 'INPUT' && !this.readOnly;
        if (part.startsWith('.')) return part.slice(1).split('.').every(name => this.classList.contains(name));
        const compound = part.match(/^([a-z][\w-]*)(\[.+\])$/i);
        if (compound) return this.tagName.toLowerCase() === compound[1].toLowerCase() && this.matches(compound[2]);
        const attribute = part.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
        if (attribute) {
          const name = attribute[1], expected = attribute[2];
          const key = name.replace(/^data-/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
          const value = name.startsWith('data-') ? this.dataset[key] : this.attributes.get(name);
          return value !== undefined && (expected === undefined || String(value) === expected);
        }
        return this.tagName.toLowerCase() === part;
      });
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
      const descendant = selector.match(/^(.+)\s+([a-z]+)$/i);
      if (descendant) return this.querySelectorAll(descendant[1]).flatMap(parent=>parent.querySelectorAll(descendant[2]));
      return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); this[name] = String(value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); delete this[name]; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    select() { this.setSelectionRange(0, this.value.length); }
    getBoundingClientRect() { return { left:0, top:0, right:this.clientWidth, bottom:this.clientHeight, width:this.clientWidth, height:this.clientHeight }; }
    setPointerCapture(id) { this.capturedPointers.add(id); }
    hasPointerCapture(id) { return this.capturedPointers.has(id); }
    releasePointerCapture(id) { this.capturedPointers.delete(id); }
    focus() { document.activeElement = this; }
    blur() { if (document.activeElement === this) document.activeElement = null; }
    get parentElement() { return this.parent || null; }
    closest(selector) { for (let current = this; current; current = current.parent) if (current.matches(selector)) return current; return null; }
  }
  const element = selector => { if (!elements.has(selector)) { const item = new Element(); item.id = selector.slice(1); elements.set(selector, item); } return elements.get(selector); };
  const documentElement = new Element();
  documentElement.querySelector = selector => selector === 'dialog[open]' ? null : element(selector);
  documentElement.createElement = tagName => new Element(tagName);
  documentElement.activeElement = null; documentElement.hitTarget = null; documentElement.hitTests = [];
  documentElement.elementFromPoint = (x, y) => { documentElement.hitTests.push({x,y}); return documentElement.hitTarget; };
  const original = Object.fromEntries(['document','window','requestAnimationFrame'].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  globalThis.document = documentElement; globalThis.window = new Element(); globalThis.requestAnimationFrame = callback => callback();
  // Real canvas ancestry lets the focus/click regression exercise bubbling via
  // nodes -> space -> viewport -> root rather than calling a handler directly.
  documentElement.append(element('#creative-canvas'));
  element('#creative-canvas').append(element('#canvas-viewport'));
  element('#canvas-viewport').append(element('#canvas-space'));
  element('#canvas-space').append(element('#nodes'));
  element('#canvas-space').append(element('#canvas-groups'));
  element('#creative-canvas').append(element('#canvas-text-panel'));
  element('#canvas-text-panel').append(element('#canvas-text-resizer'));
  t.after(() => { for (const [key,descriptor] of Object.entries(original)) { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key]; } });
  element('#canvas-assets-panel').hidden = true;
  Object.assign(element('#canvas-overview'),{clientWidth:0,clientHeight:0});
  const state = { project, kinds, view:'canvas', jobs:[], submitting:new Set(), settings:{hasKey:false} };
  const marked = [], messages = [], generated = [], selectedImages = [], docked = [];
  const canvas = createInfiniteCanvas({ getState:()=>state, mark:field=>marked.push(field), toast:message=>messages.push(message),
    referencesFor:()=>[], parameters:scene=>state.catalog?.length
      ? videoParameters(state.catalog.find(model=>model.name === (scene.videoModel || state.settings.videoModel)) || state.catalog[0],scene)
      : ({duration:scene.generationDuration||5,count:scene.generationCount||1,durations:[],model:null,tier:null,totalEstimate:0,resolution:''}),
    createScene:(prompt,title)=> { const scene={id:randomUUID(),title,videoPrompt:prompt,duration:5,videoAssetId:'',references:[],generationDuration:5,generationCount:1}; project.scenes.push(scene); marked.push('scenes'); return scene; },
    flush:async()=>{}, setView:()=>{}, generateScene:async sceneId=>{ generated.push(sceneId); }, selectAsset:async()=>{},
    selectImageCandidate:async (nodeId,assetId)=>{ selectedImages.push([nodeId,assetId]); const node=project.graph.nodes.find(item=>item.id===nodeId); node.selectedAssetId=assetId; node.assetId=assetId; },
    uploadFiles:async()=>[], previewAsset:()=>{}, setTextChatDocked:value=>docked.push(value) });
  canvas.render();
  const keyboard = async (key, overrides = {}) => {
    const event = { key, ctrlKey:true, metaKey:false, shiftKey:false, target:element('#canvas-viewport'), defaultPrevented:false,
      ...overrides, preventDefault() { this.defaultPrevented = true; } };
    await documentElement.fire('keydown', event); return event;
  };
  const cardFor = id => element('#nodes').children.find(card => card.dataset.nodeId === id);
  const cardAction = (id, action, data = {}) => {
    const card = cardFor(id), target = { dataset: { cardAction: action, ...data }, disabled: false,
      closest: selector => selector === '.canvas-node' ? card : selector === '[data-card-action]' ? target : null };
    return element('#nodes').fire('click', { target });
  };
  const dispatch = async (target, type, overrides = {}) => {
    const path = []; for (let current = target; current; current = current.parentElement) path.push(current);
    const event = { type, target, defaultPrevented:false, propagationStopped:false, ...overrides,
      composedPath:() => [...path], preventDefault(){this.defaultPrevented=true;}, stopPropagation(){this.propagationStopped=true;} };
    for (const current of path) { event.currentTarget = current; await current.fire(type,event); if (event.propagationStopped) break; }
    event.currentTarget = null; return event;
  };
  return { canvas,state,project,element,marked,messages,generated,selectedImages,docked,keyboard,cardFor,cardAction,dispatch, document:documentElement, makeElement:tagName=>new Element(tagName) };
}

test('批量放置用真实画布保存独立素材卡，自动避让且保留未补选的占位卡和撤销记录', async t => {
  const placeholder = node('batch-placeholder', 'image', { label: '待补构图', assetName: '构图.png' });
  const first = { id: 'batch-image-a', kind: 'image', name: '第一张.png' }, second = { id: 'batch-image-b', kind: 'image', name: '第二张.png' };
  const h = canvasHarness(t, { id: 'batch-project', graph: graph([placeholder]), scenes: [], assets: [first, second] });
  await h.cardAction(placeholder.id, 'relink');
  const original = structuredClone(h.project.graph.nodes.find(item => item.id === placeholder.id));
  const options = { allowRelink: false, avoidOverlap: true };
  const a = h.canvas.addAsset(first, { x: 0, y: 0 }, options), b = h.canvas.addAsset(second, { x: 0, y: 0 }, options);
  assert.equal(h.project.graph.nodes.length, 3);
  assert.deepEqual(h.project.graph.nodes.find(item => item.id === placeholder.id), original);
  for (const added of [a, b]) {
    assert.equal(added.status, 'uploaded'); assert.equal(added.sceneId, '');
    assert.equal(added.width, 320); assert.equal(added.height, 260);
    assert.equal(intersectsRect(added, original), false);
  }
  assert.equal(intersectsRect(a, b), false);
  assert.doesNotThrow(() => validateGraph(h.project.graph));
  assert.equal(h.marked.includes('graph'), true); assert.deepEqual(h.generated, []);
  h.element('#undo-canvas').onclick();
  assert.equal(h.project.graph.nodes.some(item => item.assetId === second.id), false);
  h.element('#undo-canvas').onclick();
  assert.equal(h.project.graph.nodes.length, 1);
  const relinked = h.canvas.addAsset(second);
  assert.equal(relinked.id, placeholder.id, '批量添加后仍可继续补选原占位卡');
  assert.equal(h.project.graph.nodes.length, 1);
});

test('素材卡创建函数在世界边界避让，不修改原画布且生成后端可接受的节点', () => {
  const input = graph([node('world-edge', 'text', { x: 0, y: WORLD_LIMIT - 100 })]);
  const before = structuredClone(input);
  const asset = { id: 'boundary-asset', kind: 'image', name: '边界素材.png' };
  const added = createAssetCanvasNode(asset, input, { x: 0, y: WORLD_LIMIT - 100 });
  assert.deepEqual(input, before);
  assert.equal(intersectsRect(added, input.nodes[0]), false);
  assert.doesNotThrow(() => validateGraph({ ...input, nodes: [...input.nodes, added] }));
});

test('聊天选区创建生图和视频草稿保留提示词、限制长度并且不提交生成', t => {
  const h = canvasHarness(t), prompt = '雨夜里，一位旅行者走进旧书店。\n暖色灯光，缓慢推镜头。';
  const image = h.canvas.addPromptImage(prompt);
  assert.equal(image.imageConfig.prompt, prompt);
  assert.equal(h.cardFor(image.id).classList.contains('details-open'), true);
  const video = h.canvas.addPromptVideo(prompt);
  assert.equal(h.project.scenes.find(scene => scene.id === video.sceneId).videoPrompt, prompt);
  assert.equal(h.cardFor(video.id).classList.contains('details-open'), true);
  const long = '文字'.repeat(2300);
  assert.equal(h.canvas.addPromptImage(long).imageConfig.prompt.length, 4000);
  const longVideo = h.canvas.addPromptVideo(long);
  assert.equal(h.project.scenes.find(scene => scene.id === longVideo.sceneId).videoPrompt.length, 4000);
  for (const [index, card] of h.project.graph.nodes.entries()) for (const other of h.project.graph.nodes.slice(index + 1)) {
    assert.ok(card.x + card.width <= other.x || other.x + other.width <= card.x || card.y + card.height <= other.y || other.y + other.height <= card.y,
      '选区草稿应放在空位，避免遮住已有卡片');
  }
  const view=h.project.graph.viewport;
  assert.equal((longVideo.x+longVideo.width/2)*view.zoom+view.x,h.element('#canvas-viewport').clientWidth/2);
  assert.deepEqual(h.generated, []);
});

test('Ctrl 连点按点击先后保存连线，重复、类型错误与回环保持已有图且可撤销', async t => {
  const h = canvasHarness(t, { id:'ctrl-links',scenes:[],assets:[],graph:graph([node('a'),node('b'),node('audio','audio')]) });
  const click = async id => {
    const card = h.cardFor(id);
    await h.dispatch(card,'pointerdown',{button:0,ctrlKey:true,pointerId:31,clientX:200,clientY:200});
    await h.dispatch(card,'pointerup',{button:0,ctrlKey:true,pointerId:31,clientX:200,clientY:200});
    await h.dispatch(card,'click',{button:0,ctrlKey:true});
  };
  await click('b'); await click('a');
  assert.deepEqual(h.project.graph.links.map(({from,to}) => [from,to]), [['b','a']]);
  await click('b'); await click('a');
  assert.match(h.messages.at(-1), /已经连接/);
  await h.keyboard('Escape');
  await click('a'); await click('b');
  assert.match(h.messages.at(-1), /循环/);
  await h.keyboard('Escape');
  await click('audio'); await click('a');
  assert.match(h.messages.at(-1), /不匹配/);
  assert.equal(h.project.graph.links.length,1);
  h.element('#undo-canvas').onclick(); assert.equal(h.project.graph.links.length,0);
  h.element('#redo-canvas').onclick(); assert.equal(h.project.graph.links[0].from,'b');
  assert.deepEqual(h.generated,[]);
});

test('框选创建分组、整体拖动、重命名与解散都保留内容并支持撤销和重做', async t => {
  const h = canvasHarness(t, {id:'group-test', scenes:[],assets:[],graph:graph([
    node('first','text',{x:120,y:120,note:'保留想法'}),node('second','text',{x:520,y:120,note:'保留提示词'}),node('third','text',{x:1000,y:120}),
  ])});
  const viewport = h.element('#canvas-viewport');
  const pointer = (target,type,x,y,button=0) => h.dispatch(target,type,{button,pointerId:65,pointerType:'mouse',clientX:x,clientY:y});
  await pointer(viewport,'pointerdown',80,70,2); await pointer(viewport,'pointermove',900,450,2); await pointer(viewport,'pointerup',900,450,2);
  assert.equal(h.element('#create-canvas-group').disabled,false);
  h.element('#create-canvas-group').onclick();
  assert.deepEqual(h.project.graph.groups[0].nodeIds,['first','second']);
  const groupId = h.project.graph.groups[0].id, frame = h.element('#canvas-groups').children[0];
  const header = h.makeElement('div'); header.dataset.canvasGroupDrag=''; header.dataset.groupId=groupId; frame.append(header);
  const initial = h.project.graph.nodes.map(({x,y})=>[x,y]);
  h.project.graph.viewport.zoom=.5; h.canvas.render();
  await pointer(header,'pointerdown',100,70); await pointer(header,'pointermove',150,100); await pointer(header,'pointerup',150,100);
  assert.deepEqual(h.project.graph.nodes.map(({x,y})=>[x,y]),[[220,180],[620,180],initial[2]]);
  h.element('#undo-canvas').onclick(); assert.deepEqual(h.project.graph.nodes.map(({x,y})=>[x,y]),initial);
  h.element('#redo-canvas').onclick(); assert.equal(h.project.graph.nodes[0].x,220);
  const input = h.makeElement('input'); input.dataset.canvasGroupField='label';input.dataset.groupId=groupId;frame.append(input);
  input.focus();await h.dispatch(input,'focusin');input.value='  雨夜素材  ';await h.dispatch(input,'input');input.blur();await h.dispatch(input,'focusout');
  assert.equal(h.project.graph.groups[0].label,'雨夜素材');
  h.element('#undo-canvas').onclick();assert.equal(h.project.graph.groups[0].label,'新分组');
  h.element('#redo-canvas').onclick();assert.equal(h.project.graph.groups[0].label,'雨夜素材');
  const button=h.makeElement('button');button.dataset.groupAction='dissolve';button.dataset.groupId=groupId;frame.append(button);
  const content=structuredClone(h.project.graph.nodes);
  await h.dispatch(button,'click');assert.deepEqual(h.project.graph.groups,[]);assert.deepEqual(h.project.graph.nodes,content);
  h.element('#undo-canvas').onclick();assert.equal(h.project.graph.groups[0].label,'雨夜素材');
  assert.deepEqual(h.generated,[]);
});

test('独立框选工具用左键从卡片开始选择并创建分组，不移动卡片', async t => {
  const h = canvasHarness(t, {id:'left-marquee', scenes:[], assets:[], graph:graph([
    node('first','text',{x:120,y:120}), node('second','text',{x:520,y:120}), node('third','text',{x:1000,y:120}),
  ])});
  const button = h.makeElement('button'); button.dataset.canvasTool = 'marquee';
  h.element('#canvas-viewport').append(button);
  await h.dispatch(button,'click');
  const before = structuredClone(h.project.graph.nodes);
  await h.dispatch(h.cardFor('first'),'pointerdown',{button:0,pointerId:75,clientX:140,clientY:140});
  await h.dispatch(h.element('#canvas-viewport'),'pointermove',{button:0,pointerId:75,clientX:900,clientY:450});
  await h.dispatch(h.element('#canvas-viewport'),'pointerup',{button:0,pointerId:75,clientX:900,clientY:450});
  h.element('#create-canvas-group').onclick();
  assert.deepEqual(h.project.graph.groups[0].nodeIds,['first','second']);
  assert.deepEqual(h.project.graph.nodes,before);
  h.element('#create-canvas-group').onclick();
  assert.equal(h.project.graph.groups.length,2);
  assert.deepEqual(h.project.graph.groups[1].nodeIds,['first','second']);
  assert.doesNotThrow(() => validateGraph(h.project.graph));
  const frames = h.element('#canvas-groups').children;
  assert.notEqual(frames[0].style['--group-header-offset'],frames[1].style['--group-header-offset']);
});

test('分组复制保持成员关系，删除单个成员后清理不足两张的分组并可恢复', async t => {
  const h=canvasHarness(t,{id:'copy-group',scenes:[],assets:[],graph:{...graph([node('a'),node('b')]),groups:[{id:'group-a',label:'参考',nodeIds:['a','b']}]}});
  await h.keyboard('a');await h.keyboard('d');
  assert.equal(h.project.graph.groups.length,2);
  const copy=h.project.graph.groups[1];assert.equal(copy.label,'参考 副本');assert.equal(copy.nodeIds.length,2);
  assert.ok(copy.nodeIds.every(id=>id!=='a'&&id!=='b'&&h.project.graph.nodes.some(node=>node.id===id)));
  h.element('#remove-selection').onclick();assert.equal(h.project.graph.groups.length,1);
  h.element('#undo-canvas').onclick();assert.equal(h.project.graph.groups.length,2);
  await h.dispatch(h.cardFor('a'),'pointerdown',{button:0,shiftKey:true,pointerId:68,clientX:200,clientY:200});
  h.element('#remove-selection').onclick();assert.ok(!h.project.graph.groups.some(group=>group.id==='group-a'));
  assert.ok(h.project.graph.nodes.some(node=>node.id==='b'));
  h.element('#undo-canvas').onclick();assert.ok(h.project.graph.groups.some(group=>group.id==='group-a'));
});

test('Esc 收起展开画布并恢复按钮焦点', async t => {
  const h = canvasHarness(t);
  h.canvas.setExpanded(true);
  await h.keyboard('Escape');
  assert.equal(h.element('#creative-canvas').classList.contains('canvas-expanded'), false);
  assert.equal(h.element('#expand-canvas').getAttribute('aria-pressed'), 'false');
  assert.equal(h.element('#canvas-text-panel').hidden, true);
  assert.equal(h.docked.at(-1), false);
  assert.equal(h.document.activeElement, h.element('#expand-canvas'));
});

test('全屏侧栏拖动与键盘调宽记忆宽度并限制范围，取消拖动恢复起始值', async t => {
  const h=canvasHarness(t), saved=new Map();
  window.innerWidth=1440;h.element('#creative-canvas').clientWidth=1410;
  window.localStorage={getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)};
  h.canvas.setExpanded(true);assert.equal(h.docked.at(-1),false);
  h.element('#toggle-canvas-text').onclick();assert.equal(h.docked.at(-1),true);
  const handle=h.element('#canvas-text-resizer'),width=()=>Number(handle.getAttribute('aria-valuenow'));
  const initial=width();assert.equal(initial,450);
  await h.dispatch(handle,'pointerdown',{button:0,pointerId:77,clientX:960});
  await h.dispatch(handle,'pointermove',{pointerId:77,clientX:820});await h.dispatch(handle,'pointerup',{pointerId:77});
  assert.equal(width(),590);assert.equal(saved.get('jingce-canvas-chat-width'),'590');
  h.element('#close-canvas-text').onclick();h.element('#toggle-canvas-text').onclick();assert.equal(width(),590);
  await h.dispatch(handle,'keydown',{key:'ArrowRight'});assert.equal(width(),570);
  await h.dispatch(handle,'pointerdown',{button:0,pointerId:78,clientX:960});
  await h.dispatch(handle,'pointermove',{pointerId:78,clientX:5000});assert.equal(width(),280);
  await h.dispatch(handle,'pointercancel',{pointerId:78});assert.equal(width(),570);
  window.innerWidth=390;h.element('#creative-canvas').clientWidth=374;await window.fire('resize',{});assert.equal(width(),340);
  h.canvas.setExpanded(false);assert.equal(h.docked.at(-1),false);assert.equal(h.element('#canvas-text-panel').hidden,true);
  assert.equal(h.element('#creative-canvas').classList.contains('canvas-chat-resizing'),false);
});

test('移除画布卡片保留工程素材、分镜与任务，撤销恢复素材和镜头关联', async t => {
  const h = canvasHarness(t);
  h.project.scenes.push({id:'scene-1',title:'原镜头',videoPrompt:'雨中的书店',duration:5,generationDuration:5,generationCount:1,videoAssetId:'asset-1',references:[]});
  h.project.assets.push({id:'asset-1',kind:'video',name:'候选一',source:'model',sceneId:'scene-1'});
  h.state.jobs.push({id:'job-1',sceneId:'scene-1',state:'done'});
  h.canvas.syncScenes(); h.canvas.addAsset(h.project.assets[0]);
  const before = structuredClone(h.project.graph), scenes = structuredClone(h.project.scenes), assets = structuredClone(h.project.assets), jobs = structuredClone(h.state.jobs);
  await h.keyboard('a'); h.element('#remove-selection').onclick();
  assert.equal(h.project.graph.nodes.length,0);
  assert.deepEqual(h.project.scenes,scenes); assert.deepEqual(h.project.assets,assets); assert.deepEqual(h.state.jobs,jobs);
  h.element('#undo-canvas').onclick();
  assert.deepEqual(h.project.graph.nodes,before.nodes); assert.deepEqual(h.project.graph.links,before.links);
  assert.equal(h.project.graph.nodes.find(n=>n.sceneId).sceneId,'scene-1');
  assert.equal(h.project.graph.nodes.find(n=>n.assetId).assetId,'asset-1');
});

test('新增视频只放入指定新生成项，已移除的完成卡片刷新后仍保持移除，显式补入可以恢复且不重复', async t => {
  const h = canvasHarness(t,coverFixture());
  h.state.jobs.push({id:'completed-history',sceneId:'cover-scene',state:'done',assetId:'local-cover-video'});
  const assets = structuredClone(h.project.assets), jobs = structuredClone(h.state.jobs);
  await h.cardAction('cover-shot','remove');
  h.canvas.reset(); h.canvas.render();
  assert.equal(h.project.graph.nodes.length,0);
  const scene = {id:'new-scene-only',title:'新视频',videoPrompt:'新画面',duration:5,references:[],generationDuration:10,generationCount:1};
  h.project.scenes.push(scene);
  h.canvas.syncScenes({sceneIds:[scene.id]});
  assert.deepEqual(h.project.graph.nodes.map(card=>card.sceneId),[scene.id], '新增不能把历史生成项一起补回');
  h.canvas.syncScenes({sceneIds:[scene.id]});
  assert.equal(h.project.graph.nodes.length,1);
  h.canvas.reset(); h.canvas.render();
  assert.deepEqual(h.project.graph.nodes.map(card=>card.sceneId),[scene.id]);
  assert.deepEqual(h.project.assets,assets); assert.deepEqual(h.state.jobs,jobs);
  assert.deepEqual(h.generated,[]);
});


test('右键拖拽空白区域可以框选多个卡片，完成后不弹出右键菜单', async t => {
  const project = { id:'right-marquee-project', scenes:[], assets:[], graph:graph([
    node('inside-a','text',{x:100,y:100}), node('inside-b','text',{x:500,y:100}), node('outside','text',{x:1000,y:100}),
  ]) };
  const h = canvasHarness(t,project), viewport = h.element('#canvas-viewport'), marquee = h.element('#canvas-marquee'), menu = h.element('#canvas-context-menu');
  const pointer = (type,x,y) => h.dispatch(viewport,type,{button:2,pointerId:41,pointerType:'mouse',clientX:x,clientY:y,shiftKey:false});

  await pointer('pointerdown',50,50);
  assert.equal(viewport.hasPointerCapture(41),true);
  const earlyMenu = await h.dispatch(viewport,'contextmenu',{button:2,pointerId:41,clientX:50,clientY:50});
  assert.equal(earlyMenu.defaultPrevented,true);
  assert.equal(menu.hidden,true,'按下右键时不能弹出菜单干扰框选');
  await pointer('pointermove',900,450);
  assert.equal(h.cardFor('inside-a').classList.contains('selected'),true);
  assert.equal(h.cardFor('inside-b').classList.contains('selected'),true);
  assert.equal(h.cardFor('outside').classList.contains('selected'),false);
  assert.equal(viewport.classList.contains('selecting'),true);
  const release = await pointer('pointerup',900,450);
  assert.equal(release.defaultPrevented,true);
  assert.equal(viewport.hasPointerCapture(41),false);
  assert.equal(marquee.hidden,true);
  assert.equal(menu.hidden,true);
  h.element('#create-canvas-group').onclick();
  assert.deepEqual(h.project.graph.groups[0].nodeIds,['inside-a','inside-b']);

  await h.dispatch(viewport,'pointerdown',{button:2,pointerId:42,pointerType:'mouse',clientX:900,clientY:450,shiftKey:false});
  await h.dispatch(viewport,'pointerup',{button:2,pointerId:42,pointerType:'mouse',clientX:900,clientY:450,shiftKey:false});
  const context = await h.dispatch(viewport,'contextmenu',{button:2,pointerId:42,clientX:900,clientY:450});
  assert.equal(context.defaultPrevented,true);
  assert.equal(menu.hidden,false,'短右键仍应打开原有画布菜单');
});

test('右键框选支持反向拖拽，并可用 Shift 叠加已有选择', async t => {
  const project = { id:'right-marquee-reverse-project', scenes:[], assets:[], graph:graph([
    node('first','text',{x:100,y:100}), node('second','text',{x:500,y:100}), node('third','text',{x:1000,y:100}),
  ]) };
  const h = canvasHarness(t,project), viewport = h.element('#canvas-viewport');
  const drag = async (id,start,end,shiftKey=false) => {
    const event = (type,x,y) => h.dispatch(viewport,type,{button:2,pointerId:id,pointerType:'mouse',clientX:x,clientY:y,shiftKey});
    await event('pointerdown',...start); await event('pointermove',...end); await event('pointerup',...end);
  };

  await drag(51,[900,450],[50,50]);
  assert.equal(h.cardFor('first').classList.contains('selected'),true);
  assert.equal(h.cardFor('second').classList.contains('selected'),true);
  assert.equal(h.cardFor('third').classList.contains('selected'),false);

  await drag(52,[900,450],[950,500],true);
  assert.equal(h.cardFor('first').classList.contains('selected'),true,'Shift 右键框选应保留已有选择');
  assert.equal(h.cardFor('second').classList.contains('selected'),true);
});

test('复制所选卡片时复制内部连接，保留同一素材与分镜且不创建新任务', async t => {
  const h = canvasHarness(t);
  h.project.scenes.push({id:'scene-1',title:'镜头',videoPrompt:'天空',duration:5,videoAssetId:'',references:[]});
  h.project.assets.push({id:'asset-1',kind:'video',name:'素材',source:'upload'});
  h.canvas.syncScenes(); const media = h.canvas.addAsset(h.project.assets[0]);
  const shot = h.project.graph.nodes.find(n=>n.sceneId);
  h.project.graph.links.push({id:'edge-1',from:media.id,to:shot.id});
  const originalIds = new Set(h.project.graph.nodes.map(n=>n.id));
  await h.keyboard('a'); h.element('#duplicate-selection').onclick();
  const copies = h.project.graph.nodes.filter(n=>!originalIds.has(n.id));
  assert.equal(copies.length,2); assert.equal(h.project.graph.links.length,2);
  const copiedMedia=copies.find(n=>n.assetId), copiedShot=copies.find(n=>n.sceneId);
  assert.equal(copiedMedia.assetId,'asset-1'); assert.equal(copiedShot.sceneId,'scene-1');
  assert.ok(h.project.graph.links.some(edge=>edge.from===copiedMedia.id&&edge.to===copiedShot.id));
  assert.equal(h.project.scenes.length,1); assert.equal(h.project.assets.length,1); assert.equal(h.state.jobs.length,0);
  assert.doesNotThrow(()=>validateGraph(h.project.graph));
});

test('文字便签创建真实镜头并传递提示词，原便签仍留在画布', async t => {
  const h = canvasHarness(t);
  const original = node('idea','text',{label:'雨夜开场',note:'雨滴沿书店玻璃滑落，镜头缓缓推进。'});
  h.project.graph.nodes.push(original); h.canvas.render();
  await h.cardAction(original.id,'from-text');
  assert.equal(h.project.scenes.length,1);
  const scene = h.project.scenes[0], shot=h.project.graph.nodes.find(n=>n.sceneId===scene.id);
  assert.equal(scene.title,original.label); assert.equal(scene.videoPrompt,original.note);
  assert.ok(shot); assert.ok(h.project.graph.nodes.some(n=>n.id===original.id));
  assert.ok(h.project.graph.links.some(edge=>edge.from===original.id&&edge.to===shot.id));
  assert.doesNotThrow(()=>validateGraph(h.project.graph));
});

test('恢复同一工程的旧画布时补齐视口和卡片尺寸，避免后台刷新崩溃', t => {
  const h = canvasHarness(t);
  h.project.graph={nodes:[{id:'legacy',kind:'text',label:'旧便签',note:'保留原数据',status:'pending',x:-200,y:-150}],links:[]};
  assert.doesNotThrow(()=>h.canvas.render());
  assert.ok(Number.isFinite(h.project.graph.viewport.zoom));
  assert.ok(Number.isFinite(h.project.graph.nodes[0].width)); assert.ok(Number.isFinite(h.project.graph.nodes[0].height));
  assert.equal(h.project.graph.nodes[0].note,'保留原数据');
});

test('镜头标题撤销和重做同时恢复关联分镜的标题与卡片显示', async t => {
  const h = canvasHarness(t);
  h.project.scenes.push({id:'scene-1',title:'原镜头',videoPrompt:'天空',duration:5,videoAssetId:'',references:[]});
  h.canvas.syncScenes(); const shot=h.project.graph.nodes.find(n=>n.sceneId), card=h.cardFor(shot.id);
  const control={dataset:{nodeField:'label'},value:'修改后镜头',readOnly:false,closest:selector=>selector==='.canvas-node'?card:null};
  await h.element('#nodes').fire('focusin',{target:control});
  await h.element('#nodes').fire('input',{target:control});
  await h.element('#nodes').fire('focusout',{target:control});
  assert.equal(h.project.scenes[0].title,'修改后镜头');
  h.element('#undo-canvas').onclick();
  assert.equal(h.project.scenes[0].title,'原镜头');
  assert.equal(h.project.graph.nodes.find(n=>n.sceneId).label,'原镜头');
  h.element('#redo-canvas').onclick();
  assert.equal(h.project.scenes[0].title,'修改后镜头');
  assert.match(h.cardFor(shot.id).innerHTML,/修改后镜头/);
});


test('撤销标题保留随后更新的选片、提示词、任务及其他镜头标题', async t => {
  const h = canvasHarness(t);
  h.project.scenes.push(
    {id:'scene-1',title:'原镜头',videoPrompt:'原提示词',duration:5,videoAssetId:'',references:[]},
    {id:'scene-2',title:'第二镜头',videoPrompt:'第二段提示词',duration:5,videoAssetId:'',references:[]}
  );
  h.canvas.syncScenes();
  const shot = h.project.graph.nodes.find(n => n.sceneId === 'scene-1'), card = h.cardFor(shot.id);
  const control = {dataset:{nodeField:'label'},value:'修改后镜头',readOnly:false,
    closest:selector => selector === '.canvas-node' ? card : null};
  await h.element('#nodes').fire('focusin', {target:control});
  await h.element('#nodes').fire('input', {target:control});
  await h.element('#nodes').fire('focusout', {target:control});

  // Mimic later candidate completion, selection and edits made outside the title operation.
  const candidate = {id:'asset-after-title',kind:'video',name:'新完成的候选',source:'model',sceneId:'scene-1'};
  h.project.assets.push(candidate);
  h.project.scenes[0].videoAssetId = candidate.id;
  h.project.scenes[0].videoPrompt = '随后更新的镜头运动提示词';
  h.project.scenes[1].title = '第二镜头随后改名';
  h.state.jobs.push({id:'job-after-title',sceneId:'scene-1',state:'done',assetId:candidate.id});
  const assets = structuredClone(h.project.assets), jobs = structuredClone(h.state.jobs);

  for (const [operation, expectedTitle] of [['#undo-canvas','原镜头'], ['#redo-canvas','修改后镜头']]) {
    h.element(operation).onclick();
    assert.equal(h.project.scenes[0].title, expectedTitle);
    assert.equal(h.project.scenes[0].videoAssetId, candidate.id);
    assert.equal(h.project.scenes[0].videoPrompt, '随后更新的镜头运动提示词');
    assert.equal(h.project.scenes[1].title, '第二镜头随后改名');
    assert.equal(h.project.scenes[1].videoPrompt, '第二段提示词');
    assert.deepEqual(h.project.assets, assets); assert.deepEqual(h.state.jobs, jobs);
    const otherShot = h.project.graph.nodes.find(n => n.sceneId === 'scene-2');
    assert.match(h.cardFor(otherShot.id).innerHTML, /第二镜头随后改名/);
  }
});


function coverFixture() {
  const asset = { id:'local-cover-video', kind:'video', name:'本地候选视频.mp4', source:'model', sceneId:'cover-scene', duration:5 };
  const scene = { id:asset.sceneId, title:'已有视频镜头', videoPrompt:'沿着湖面缓慢推进。', duration:5, generationDuration:5,
    generationCount:1, videoAssetId:asset.id, references:[] };
  return { id:'cover-project', assets:[asset], scenes:[scene],
    graph:graph([node('cover-shot','video',{label:scene.title,sceneId:scene.id,x:-240,y:120,width:400,height:600})]) };
}

// Media methods and DOM attachments simulate local browser primitives; canvas
// event handling, graph mutations, history and playback flags use the real module.
function attachCoverMedia(h, card = h.cardFor('cover-shot')) {
  const header = h.makeElement('header'); header.className = 'canvas-node-header';
  const button = h.makeElement('button'); button.dataset.cardAction = 'play-cover'; header.append(button);
  const cover = h.makeElement('div'); cover.className = 'canvas-cover';
  const video = h.makeElement('video'); video.dataset.coverVideo = '';
  Object.assign(video,{src:'/api/assets/local-cover-video',paused:true,ended:false,controls:false,readyState:1,duration:5,currentTime:0,playCount:0,pauseCount:0});
  video.play = async () => { video.playCount++; video.paused = false; video.ended = false; };
  video.pause = () => { video.pauseCount++; video.paused = true; };
  const drag = h.makeElement('div'); drag.dataset.coverDrag = ''; cover.append(video); cover.append(drag);
  card.append(header); card.append(cover);
  return {card,button,video,drag};
}

function attachShotParameters(h) {
  const card = h.cardFor('cover-shot'), details = h.makeElement('div');
  details.className = 'canvas-details-content';
  const prompt = h.makeElement('textarea'); prompt.dataset.referencePrompt = ''; prompt.value = h.project.scenes[0].videoPrompt;
  details.append(prompt);
  const controls = {};
  for (const field of ['videoModel','ratio','generationDuration','generationCount','resolution']) {
    const control = h.makeElement('select'); control.dataset.shotField = field;
    Object.defineProperty(control,'options',{get:()=>[...control.innerHTML.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
      .map(match=>({value:match[1],textContent:match[2]}))});
    details.append(control); controls[field] = control;
  }
  const estimate = h.makeElement('div'); estimate.className = 'shot-estimate';
  const cost = h.makeElement('strong'), specifications = h.makeElement('small'); estimate.append(cost); estimate.append(specifications); details.append(estimate);
  const button = h.makeElement('button'); button.className = 'shot-generate'; details.append(button);
  card.append(details); prompt.focus();
  return {card,prompt,controls,cost,specifications,button};
}

const selectableVideoModel = () => ({name:'selectable-video',defaultDuration:5,defaultResolution:'720p',ratios:['16:9','9:16'],
  tiers:[...['720p','1080p'].flatMap((resolution,index)=>[5,10,15].map(duration=>({resolution,duration,price:duration/5+index})))]});

test('画布的历史完成、失败、排队和已删除待核对任务不锁定下一次生成参数，只在提交期间锁定全部参数', t => {
  const h = canvasHarness(t,coverFixture()); h.state.catalog = [selectableVideoModel()];
  h.state.settings = {hasKey:true,videoModel:'selectable-video'};
  const {controls,button} = attachShotParameters(h);
  for (const jobState of ['done','failed','waiting','queued','running','download_pending','uncertain','attention']) {
    h.state.jobs = [{id:'historical-job',sceneId:'cover-scene',state:jobState,deletedAt:'2026-10-08T00:00:00Z'}];
    h.canvas.render();
    for (const [field,control] of Object.entries(controls)) assert.equal(control.disabled,false,jobState+' 不应锁定 '+field);
    assert.deepEqual(controls.generationDuration.options.map(option=>option.value),['5','10','15']);
    assert.equal(button.disabled,false);
  }
  h.state.submitting.add('cover-scene'); h.canvas.render();
  for (const [field,control] of Object.entries(controls)) assert.equal(control.disabled,true,'提交期间必须锁定 '+field);
  assert.match(button.textContent,/提交中/);
  h.state.submitting.clear(); h.canvas.render();
  for (const control of Object.values(controls)) assert.equal(control.disabled,false);
  assert.deepEqual(h.generated,[]);
});

test('聚焦提示词或播放已有视频时刷新参数选项、所选值和报价，不替换视频或改动历史任务', t => {
  const h = canvasHarness(t,coverFixture()); const model = selectableVideoModel();
  h.state.catalog = [model]; h.state.settings = {hasKey:true,videoModel:model.name};
  const {video} = attachCoverMedia(h), {controls,cost,specifications} = attachShotParameters(h);
  const scene = h.project.scenes[0]; scene.generationDuration = 15; scene.generationCount = 3; scene.resolution = '1080p'; scene.ratio = '9:16';
  video.paused = false; video.currentTime = 1.75;
  const history = [{id:'original-request',sceneId:scene.id,state:'done',duration:5}]; h.state.jobs = structuredClone(history);
  h.canvas.render();
  assert.equal(controls.generationDuration.value,'15'); assert.equal(controls.generationCount.value,'3');
  assert.equal(controls.resolution.value,'1080p'); assert.equal(controls.ratio.value,'9:16');
  assert.match(cost.textContent,/12/); assert.match(specifications.textContent,/1080p/);
  model.tiers = [{duration:4,resolution:'720p',price:2},{duration:8,resolution:'720p',price:3}];
  model.ratios = ['16:9']; h.canvas.render();
  assert.deepEqual(controls.generationDuration.options.map(option=>option.value),['4','8']);
  assert.equal(controls.generationDuration.value,'4'); assert.equal(controls.resolution.value,'720p');
  assert.equal(controls.ratio.value,'16:9'); assert.match(cost.textContent,/6/);
  model.tiers = []; h.canvas.render();
  assert.equal(controls.generationDuration.disabled,true); assert.equal(controls.resolution.disabled,true);
  assert.equal(h.cardFor('cover-shot').querySelector('[data-cover-video]'),video);
  assert.equal(video.paused,false); assert.equal(video.currentTime,1.75);
  assert.deepEqual(h.state.jobs,history); assert.deepEqual(h.generated,[]);
});

test('从媒体封面拖动卡片按缩放移动，撤销和重做保留镜头及已有视频', async t => {
  const project = coverFixture(); project.graph.viewport = {x:60,y:40,zoom:.5};
  const h = canvasHarness(t,project), {drag} = attachCoverMedia(h);
  h.state.jobs.push({id:'existing-cover-job',sceneId:'cover-scene',state:'done',assetId:'local-cover-video'});
  const before = structuredClone(h.project.graph), scenes = structuredClone(h.project.scenes), assets = structuredClone(h.project.assets), jobs = structuredClone(h.state.jobs);
  const viewport = h.element('#canvas-viewport');
  const pointer = (type,x,y) => viewport.fire(type,{target:drag,button:0,pointerId:9,pointerType:'mouse',clientX:x,clientY:y,shiftKey:false,preventDefault(){}});
  assert.equal(drag.closest('.canvas-node-header'),null,'封面拖动不能借用标题栏路径');
  await pointer('pointerdown',200,140); assert.equal(h.canvas.busy(),true);
  await pointer('pointermove',275,110);
  assert.equal(h.project.graph.nodes[0].x,-90); assert.equal(h.project.graph.nodes[0].y,60);
  assert.equal(viewport.hasPointerCapture(9),true);
  await pointer('pointerup',275,110); assert.equal(viewport.hasPointerCapture(9),false); assert.equal(h.canvas.busy(),false);
  const moved = structuredClone(h.project.graph);
  h.element('#undo-canvas').onclick(); assert.deepEqual(h.project.graph,before);
  h.element('#redo-canvas').onclick(); assert.deepEqual(h.project.graph,moved);
  assert.deepEqual(h.project.scenes,scenes); assert.deepEqual(h.project.assets,assets); assert.deepEqual(h.state.jobs,jobs);
  assert.deepEqual(h.generated,[]); assert.doesNotThrow(()=>validateGraph(h.project.graph));
});

test('按钮与原生视频的空格保留默认行为，空白画布的空格仍可临时启用抓手', async t => {
  const h = canvasHarness(t,coverFixture()), {button,video} = attachCoverMedia(h), viewport = h.element('#canvas-viewport');
  const before = structuredClone(h.project.graph);
  for (const target of [button,video]) {
    const event = await h.keyboard(' ',{target,ctrlKey:false});
    assert.equal(event.defaultPrevented,false);
    assert.equal(viewport.classList.contains('hand-tool'),false);
    assert.equal(h.canvas.busy(),false);
  }
  const canvasSpace = await h.keyboard(' ',{target:viewport,ctrlKey:false});
  assert.equal(canvasSpace.defaultPrevented,true); assert.equal(viewport.classList.contains('hand-tool'),true);
  await h.document.fire('keyup',{key:' ',target:viewport});
  assert.equal(viewport.classList.contains('hand-tool'),false);
  assert.deepEqual(h.project.graph,before); assert.deepEqual(h.generated,[]);
});

test('封面播放按钮只播放和暂停既有本地视频，不申请生成或修改选片', async t => {
  const h = canvasHarness(t,coverFixture()), {card,button,video} = attachCoverMedia(h);
  h.marked.length = 0; // The initial layout migration is complete before playback.
  h.state.settings.hasKey = true;
  h.state.jobs.push({id:'existing-cover-job',sceneId:'cover-scene',state:'done',assetId:'local-cover-video'});
  const project = structuredClone(h.project), jobs = structuredClone(h.state.jobs);
  await h.cardAction('cover-shot','play-cover');
  assert.equal(video.playCount,1); assert.equal(video.pauseCount,0); assert.equal(video.paused,false); assert.equal(video.controls,true);
  assert.equal(card.classList.contains('is-playing'),true); assert.equal(card.classList.contains('media-active'),true); assert.equal(button.textContent,'暂停');
  await h.cardAction('cover-shot','play-cover');
  assert.equal(video.playCount,1); assert.equal(video.pauseCount,1); assert.equal(video.paused,true);
  assert.equal(card.classList.contains('is-playing'),false); assert.equal(button.textContent,'播放');
  assert.equal(card.querySelector('[data-cover-video]'),video); assert.equal(video.src,'/api/assets/local-cover-video');
  assert.deepEqual(h.generated,[]); assert.deepEqual(h.project,project); assert.deepEqual(h.state.jobs,jobs); assert.deepEqual(h.marked,[]);
});

test('画布重新渲染保留播放中的视频、播放位置和原生控制栏，暂停并聚焦时仍保留控制栏', async t => {
  const h = canvasHarness(t,coverFixture()), {card,button,video} = attachCoverMedia(h);
  video.currentTime = 1.75;
  await h.cardAction('cover-shot','play-cover');
  await h.element('#nodes').fire('play',{target:video});
  h.project.assets[0].name = '后台更新后的候选名称.mp4';
  const originalMarkup = card.innerHTML;
  h.canvas.render();
  assert.equal(card.querySelector('[data-cover-video]'),video,'播放期间不得替换媒体元素');
  assert.equal(card.innerHTML,originalMarkup,'媒体元数据变化应等播放结束后再更新内容');
  assert.equal(video.currentTime,1.75); assert.equal(video.paused,false); assert.equal(video.controls,true); assert.equal(video.playCount,1);
  assert.equal(card.classList.contains('is-playing'),true); assert.equal(card.classList.contains('media-active'),true); assert.equal(button.textContent,'暂停');
  button.focus();
  await h.cardAction('cover-shot','play-cover');
  await h.element('#nodes').fire('pause',{target:video});
  h.canvas.render();
  assert.equal(card.querySelector('[data-cover-video]'),video); assert.equal(video.currentTime,1.75); assert.equal(video.paused,true); assert.equal(video.controls,true);
  assert.equal(card.classList.contains('is-playing'),false); assert.equal(card.classList.contains('media-active'),true); assert.equal(button.textContent,'播放');
  assert.equal(video.playCount,1); assert.equal(video.pauseCount,1); assert.deepEqual(h.generated,[]);
});


// The fixture creates DOM children as a browser would after innerHTML changes;
// focus, scroll restoration and event routing come from the public canvas.
function coverDetailsFixture(h, { detailsHeight = 180, detailsScrollHeight = 700, textareaHeight = 80, textareaScrollHeight = 80 } = {}) {
  const panel = h.makeElement('aside'); panel.className = 'canvas-hover-details';
  const details = h.makeElement('div'); details.className = 'canvas-details-content';
  Object.assign(details,{clientHeight:detailsHeight,scrollHeight:detailsScrollHeight});
  const label = h.makeElement('label'), textarea = h.makeElement('textarea');
  Object.assign(textarea,{clientHeight:textareaHeight,scrollHeight:textareaScrollHeight});
  const candidate = h.makeElement('select'); candidate.dataset.previewCandidate = '';
  label.append(textarea); details.append(label); details.append(candidate); panel.append(details);
  return {panel,details,textarea,candidate};
}

function canvasWheelEvent(target) {
  return {target,deltaY:90,deltaMode:0,ctrlKey:false,clientX:280,clientY:160,defaultPrevented:false,
    preventDefault() { this.defaultPrevented = true; }};
}

test('聚焦的候选切换重建详情后恢复焦点与滚动位置，预览不改变成片选片', async t => {
  const project = coverFixture();
  project.assets.push({...project.assets[0],id:'local-cover-alternative',name:'另一个本地候选.mp4',variantIndex:2});
  const h = canvasHarness(t,project), card = h.cardFor('cover-shot');
  card.childrenFromHTML = () => [coverDetailsFixture(h).panel];
  const initial = coverDetailsFixture(h); card.append(initial.panel);
  initial.details.scrollTop = 170; initial.candidate.value = 'local-cover-alternative'; initial.candidate.focus();
  const scenes = structuredClone(project.scenes), assets = structuredClone(project.assets);
  await h.element('#nodes').fire('change',{target:initial.candidate});
  const nextDetails = card.querySelector('.canvas-details-content'), nextCandidate = card.querySelector('[data-preview-candidate]');
  assert.notEqual(nextDetails,initial.details,'候选切换必须实际经历详情 DOM 重建');
  assert.notEqual(nextCandidate,initial.candidate);
  assert.equal(h.document.activeElement,nextCandidate,'候选下拉框继续保有焦点');
  assert.equal(nextDetails.scrollTop,170,'重建后仍停留在原来的详情滚动位置');
  assert.equal(card.dataset.previewAsset,'local-cover-alternative');
  assert.deepEqual(project.scenes,scenes); assert.deepEqual(project.assets,assets); assert.deepEqual(h.generated,[]);
});

test('短提示词文本框内的滚轮交给可滚动的外层详情，不取消默认滚动或缩放画布', async t => {
  const h = canvasHarness(t,coverFixture()), fixture = coverDetailsFixture(h);
  h.cardFor('cover-shot').append(fixture.panel);
  const before = structuredClone(h.project.graph.viewport), event = canvasWheelEvent(fixture.textarea);
  assert.equal(fixture.textarea.scrollHeight,fixture.textarea.clientHeight);
  assert.ok(fixture.details.scrollHeight > fixture.details.clientHeight);
  await h.element('#canvas-viewport').fire('wheel',event);
  assert.equal(event.defaultPrevented,false); assert.deepEqual(h.project.graph.viewport,before); assert.deepEqual(h.generated,[]);
});

test('长提示词文本框使用自己的原生滚动，外层详情未溢出时也不缩放画布', async t => {
  const h = canvasHarness(t,coverFixture()), fixture = coverDetailsFixture(h,{detailsHeight:700,textareaScrollHeight:600});
  h.cardFor('cover-shot').append(fixture.panel);
  const before = structuredClone(h.project.graph.viewport), event = canvasWheelEvent(fixture.textarea);
  assert.equal(fixture.details.scrollHeight,fixture.details.clientHeight);
  assert.ok(fixture.textarea.scrollHeight > fixture.textarea.clientHeight);
  await h.element('#canvas-viewport').fire('wheel',event);
  assert.equal(event.defaultPrevented,false); assert.deepEqual(h.project.graph.viewport,before); assert.deepEqual(h.generated,[]);
});

test('普通媒体封面的滚轮仍以指针为中心缩放画布', async t => {
  const h = canvasHarness(t,coverFixture()), {drag} = attachCoverMedia(h);
  const before = structuredClone(h.project.graph.viewport), event = canvasWheelEvent(drag);
  const pointBefore = {x:(event.clientX-before.x)/before.zoom,y:(event.clientY-before.y)/before.zoom};
  await h.element('#canvas-viewport').fire('wheel',event);
  const after = h.project.graph.viewport;
  assert.equal(event.defaultPrevented,true); assert.ok(after.zoom < before.zoom);
  assert.ok(Math.abs((event.clientX-after.x)/after.zoom-pointBefore.x) < 1e-9);
  assert.ok(Math.abs((event.clientY-after.y)/after.zoom-pointBefore.y) < 1e-9);
  assert.deepEqual(h.generated,[]);
});

test('详情浮层定位临时放大再收缩时恢复被浏览器布局夹紧的滚动位置', t => {
  const h = canvasHarness(t,coverFixture()), card = h.cardFor('cover-shot');
  const fixture = coverDetailsFixture(h,{detailsScrollHeight:560}); card.append(fixture.panel);
  const viewport = h.element('#canvas-viewport'); viewport.clientWidth = 620; viewport.clientHeight = 700;
  card.getBoundingClientRect = () => ({left:40,top:95,right:400,bottom:250,width:360,height:155});
  fixture.details.scrollTop = 170; card.hovered = true;
  let layoutClamps = 0;
  card.onStyleChange = (name,value) => {
    if (name !== '--details-max-height') return;
    // Layout clamps scrollTop to the available range when clientHeight changes.
    const before = fixture.details.scrollTop;
    fixture.details.clientHeight = Number.parseFloat(value);
    fixture.details.scrollTop = Math.min(before,Math.max(0,fixture.details.scrollHeight-fixture.details.clientHeight));
    if (fixture.details.scrollTop < before) layoutClamps++;
  };
  const before = structuredClone(h.project.graph.viewport);
  h.canvas.render();
  assert.ok(layoutClamps > 0,'此布局必须实际触发浏览器的滚动范围夹紧');
  assert.ok(fixture.details.clientHeight < fixture.details.scrollHeight);
  assert.equal(card.querySelector('.canvas-details-content'),fixture.details);
  assert.equal(fixture.details.scrollTop,170,'定位后的最终可滚区域应恢复原位置');
  assert.deepEqual(h.project.graph.viewport,before); assert.deepEqual(h.generated,[]);
});


const canvasDOMRect = (left,top,width,height) => ({left,top,right:left+width,bottom:top+height,width,height});

// Simulate layout dimensions and a positioned element's transformed DOMRect.
// Decisions about collisions, pointer avoidance and available space stay in canvas.js.
function coverDetailsGeometry(h, { coverRect, viewportRect, overviewRect = null, contentHeight = 560 }) {
  const viewport = h.element('#canvas-viewport');
  Object.assign(viewport,{clientWidth:viewportRect.width,clientHeight:viewportRect.height});
  viewport.getBoundingClientRect = () => viewportRect;
  globalThis.window.matchMedia = () => ({matches:true});
  const media = attachCoverMedia(h), {card,button} = media;
  card.getBoundingClientRect = () => coverRect;
  const header = button.parentElement; header.offsetHeight = 48;
  header.getBoundingClientRect = () => { const current = card.getBoundingClientRect(); return canvasDOMRect(current.left,current.top,current.width,header.offsetHeight*h.project.graph.viewport.zoom); };
  const fixture = coverDetailsFixture(h,{detailsHeight:contentHeight,detailsScrollHeight:contentHeight});
  card.append(fixture.panel);
  card.onStyleChange = (name,value) => {
    if (name === '--details-max-height') fixture.details.clientHeight = Math.min(contentHeight,Number.parseFloat(value));
    if (name === '--details-width') fixture.details.clientWidth = Number.parseFloat(value);
  };
  Object.defineProperty(fixture.panel,'offsetHeight',{get:()=>fixture.details.clientHeight});
  Object.defineProperty(fixture.panel,'offsetWidth',{get:()=>fixture.details.clientWidth});
  fixture.panel.getBoundingClientRect = () => {
    const current = card.getBoundingClientRect();
    const zoom = h.project.graph.viewport.zoom, scale = zoom*Number.parseFloat(card.style['--details-scale'] || '1');
    const left = current.left + zoom*Number.parseFloat(card.style['--details-left'] || '0');
    const top = current.top + zoom*Number.parseFloat(card.style['--details-top'] || '0');
    return canvasDOMRect(left,top,fixture.panel.offsetWidth*scale,fixture.panel.offsetHeight*scale);
  };
  if (overviewRect) {
    const overview = h.element('#canvas-overview');
    Object.assign(overview,{clientWidth:overviewRect.width,clientHeight:overviewRect.height});
    overview.getBoundingClientRect = () => overviewRect;
    overview.append(h.element('#canvas-minimap')); h.element('#creative-canvas').append(overview);
  }
  return {...media,...fixture,header,viewport};
}

test('详情贴着卡片显示，并在卡片移动和画布缩放后保持相邻', async t => {
  const h = canvasHarness(t,coverFixture());
  const viewportRect = canvasDOMRect(0,0,850,720), coverRect = canvasDOMRect(250,120,200,260);
  const fixture = coverDetailsGeometry(h,{coverRect,viewportRect,contentHeight:260});
  await h.element('#nodes').fire('pointerover',{target:fixture.drag,relatedTarget:null,clientX:320,clientY:180});
  const first = fixture.panel.getBoundingClientRect();
  assert.equal(Math.round(first.left - coverRect.right),12,'详情优先贴在卡片右侧');
  assert.equal(Math.round(first.top),120,'详情顶部与卡片顶部对齐');
  assert.equal(Math.round(first.width),360);
  assert.equal(fixture.card.classList.contains('details-left'),false);
  fixture.card.getBoundingClientRect = () => canvasDOMRect(620,450,136,204);
  h.project.graph.viewport.zoom = .34;
  h.canvas.render();
  const second = fixture.panel.getBoundingClientRect();
  assert.equal(Math.round(fixture.card.getBoundingClientRect().left - second.right),12,'右侧空间不足时详情贴在卡片左侧');
  assert.equal(Math.round(second.top),316,'卡片靠近底部时详情向上夹紧');
  assert.equal(Math.round(second.width),360);
  assert.equal(fixture.card.classList.contains('details-left'),true);
});

test('总览面板存在时，详情仍贴着卡片；两侧都不足时收缩到可用空间', async t => {
  const project = coverFixture(); project.graph.viewport.zoom = .34;
  const h = canvasHarness(t,project);
  const viewportRect = canvasDOMRect(0,0,850,720), coverRect = canvasDOMRect(370,180,136,204), overviewRect = canvasDOMRect(664,82,170,110);
  const fixture = coverDetailsGeometry(h,{coverRect,viewportRect,overviewRect,contentHeight:340});
  await h.element('#nodes').fire('pointerover',{target:fixture.drag,relatedTarget:null,clientX:438,clientY:220});
  const first = fixture.panel.getBoundingClientRect();
  assert.equal(Math.round(coverRect.left - first.right),12,'总览不应把详情推到远处');
  assert.equal(Math.round(first.top),180,'详情仍与卡片顶部对齐');
  assert.equal(Math.round(first.width),346,'两侧不足时面板宽度收缩到左侧可用空间');
  assert.equal(fixture.card.classList.contains('details-left'),true);
  fixture.card.getBoundingClientRect = () => canvasDOMRect(20,20,360,180);
  h.canvas.render();
  const second = fixture.panel.getBoundingClientRect();
  const movedCard = fixture.card.getBoundingClientRect();
  assert.equal(Math.round(second.left - movedCard.right),12,'卡片移动后详情仍贴在右侧');
  assert.equal(Math.round(second.top),20);
  assert.equal(Math.round(second.width),360);
  assert.equal(fixture.card.classList.contains('details-left'),false);
});

test('鼠标离开卡片前往相邻详情时，详情保持打开并允许交互', async t => {
  const h = canvasHarness(t,coverFixture());
  const fixture = coverDetailsGeometry(h,{coverRect:canvasDOMRect(80,280,360,220),viewportRect:canvasDOMRect(0,0,620,700),contentHeight:700});
  await h.element('#nodes').fire('pointerover',{target:fixture.drag,relatedTarget:null,clientX:120,clientY:300});
  await h.element('#nodes').fire('pointerout',{target:fixture.drag,relatedTarget:null,clientX:120,clientY:300});
  assert.equal(fixture.card.classList.contains('details-open'),true,'跨越卡片与详情之间的空白时不能立即关闭');
  await h.element('#nodes').fire('pointerover',{target:fixture.panel,relatedTarget:null,clientX:500,clientY:220});
  await new Promise(resolve => setTimeout(resolve,560));
  assert.equal(fixture.card.classList.contains('details-open'),true,'进入详情面板后应取消隐藏计时器');
  await h.element('#nodes').fire('pointerout',{target:fixture.panel,relatedTarget:null,clientX:500,clientY:220});
  await new Promise(resolve => setTimeout(resolve,560));
  assert.equal(fixture.card.classList.contains('details-open'),false);
});


function referenceCanvasFixture(links = []) {
  const assets = [
    {id:'asset-image-a',kind:'image',name:'人物.png',source:'upload'},
    {id:'asset-video-a',kind:'video',name:'动作.mp4',source:'upload'},
    {id:'asset-image-b',kind:'image',name:'街景.png',source:'upload'},
    {id:'asset-video-b',kind:'video',name:'运镜.mp4',source:'upload'},
    {id:'asset-audio',kind:'audio',name:'配乐.mp3',source:'upload'},
  ];
  const sources = ['image-a','video-a','image-b','video-b','audio-a'];
  const scenes = ['scene-main','scene-other'].map((id,index) => ({id,title:index ? '其他分镜' : '主分镜',videoPrompt:'',promptMentions:[],
    duration:5,generationDuration:5,generationCount:1,videoAssetId:'',references:[]}));
  const nodes = assets.map((asset,index) => node(sources[index],asset.kind,{assetId:asset.id,assetName:asset.name,x:index*400,y:0}));
  nodes.push(node('shot-main','video',{sceneId:'scene-main',label:'主分镜',x:0,y:500,width:400,height:600}),
    node('shot-other','video',{sceneId:'scene-other',label:'其他分镜',x:500,y:500,width:400,height:600}));
  return {id:'reference-project',assets,scenes,graph:graph(nodes,links.map(([from,to='shot-main'],index) => ({id:'original-link-'+index,from,to})))};
}

// Pointer capture keeps event.target on the source; hit testing at release must
// find the entire destination card, including its cover and textarea children.
async function dragReference(h, from, destination, {release='pointerup',moved=true} = {}) {
  const viewport = h.element('#canvas-viewport'), source = h.cardFor(from), port = h.makeElement('button');
  port.dataset.port = 'output'; source.append(port);
  h.document.hitTarget = typeof destination === 'string' ? h.cardFor(destination) : destination;
  const pointer = (type,x,y) => viewport.fire(type,{type,target:port,button:0,pointerId:17,pointerType:'mouse',clientX:x,clientY:y,
    shiftKey:false,preventDefault(){}});
  await pointer('pointerdown',410,290);
  assert.equal(viewport.hasPointerCapture(17),true); assert.equal(h.canvas.busy(),true);
  if (moved) await pointer('pointermove',720,420);
  await pointer(release,moved ? 720 : 410,moved ? 420 : 290);
  assert.equal(viewport.hasPointerCapture(17),false); assert.equal(h.canvas.busy(),false);
  await new Promise(resolve => setTimeout(resolve,0));
}

function attachReferencePrompt(h, nodeId = 'shot-main') {
  const card = h.cardFor(nodeId), sceneId = h.project.graph.nodes.find(item => item.id === nodeId).sceneId;
  const scene = h.project.scenes.find(item => item.id === sceneId), editor = h.makeElement('div');
  editor.className = 'reference-prompt-editor';
  const control = h.makeElement('textarea'); control.dataset.referencePrompt = ''; control.dataset.shotField = 'videoPrompt';
  control.value = scene.videoPrompt; control.setSelectionRange(control.value.length,control.value.length);
  const menu = h.makeElement('div'); menu.className = 'reference-mention-menu'; menu.hidden = true;
  menu.childrenFromHTML = markup => Array.from(markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g),match => {
    const option = h.makeElement('button'), index = match[1].match(/data-mention-index="(\d+)"/);
    option.dataset.mentionIndex = index[1]; option.id = match[1].match(/id="([^"]+)"/)[1];
    option.disabled = /\sdisabled(?:\s|$)/.test(match[1]); option.textContent = match[2].replace(/<[^>]*>/g,'');
    return option;
  });
  editor.append(control); editor.append(menu); card.append(editor);
  return {control,menu,card,scene};
}

function attachImageReferencePrompt(h, nodeId = 'image-target') {
  const card = h.cardFor(nodeId), node = h.project.graph.nodes.find(item => item.id === nodeId), editor = h.makeElement('div');
  editor.className = 'reference-prompt-editor';
  const control = h.makeElement('textarea'); control.dataset.referencePrompt = ''; control.dataset.imageField = 'prompt';
  control.value = node.imageConfig.prompt; control.setSelectionRange(control.value.length,control.value.length);
  const menu = h.makeElement('div'); menu.className = 'reference-mention-menu'; menu.hidden = true;
  menu.childrenFromHTML = markup => Array.from(markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g),match => {
    const option = h.makeElement('button'), index = match[1].match(/data-mention-index="(\d+)"/);
    option.dataset.mentionIndex = index[1]; option.id = match[1].match(/id="([^"]+)"/)[1];
    option.disabled = /\sdisabled(?:\s|$)/.test(match[1]); option.textContent = match[2].replace(/<[^>]*>/g,'');
    return option;
  });
  editor.append(control); editor.append(menu); card.append(editor);
  return {control,menu,card,node};
}

async function inputPrompt(h, control, value, {start=0,end=control.value.length,text=value,inputType='insertText',isComposing=false} = {}) {
  control.focus(); control.setSelectionRange(start,end);
  await h.element('#nodes').fire('beforeinput',{type:'beforeinput',target:control,inputType,data:text,isComposing,preventDefault(){}});
  control.value = value; control.setSelectionRange(start + text.length,start + text.length);
  await h.element('#nodes').fire('input',{type:'input',target:control,inputType,data:text,isComposing});
}

async function promptKey(h, control, key, overrides = {}) {
  const event = {type:'keydown',target:control,key,ctrlKey:false,metaKey:false,altKey:false,shiftKey:false,isComposing:false,
    defaultPrevented:false,propagationStopped:false,...overrides,
    preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.propagationStopped=true;}};
  await h.element('#nodes').fire('keydown',event); return event;
}

const referenceRows = card => Array.from(card.innerHTML.matchAll(/title="插入 @(图片\d+|视频\d+)：([^"]*)"/g),match => [match[1],match[2]]);

// Parse the actual referenceMarkup output, including actionable buttons. An
// outerHTML update detaches the old section and installs a new DOM subtree.
function attachReferenceList(h, card) {
  const decode = value => value.replace(/&(amp|lt|gt|quot|#39);/g, (_,entity) => ({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[entity]));
  const sectionFromMarkup = markup => {
    const sectionMatch = markup.match(/^<section\b[^>]*class="shot-references"[^>]*>([\s\S]*)<\/section>$/);
    assert.ok(sectionMatch,'reference section must be parsed rather than stored as a string');
    const section = h.makeElement('section'); section.className = 'shot-references';
    section.innerHTML = sectionMatch[1]; section.serializedOuterHTML = markup;
    section.elementsFromOuterHTML = replacement => [sectionFromMarkup(replacement)];
    const heading = h.makeElement('div'); heading.className = 'shot-reference-heading';
    const total = h.makeElement('strong'); total.textContent = sectionMatch[1].match(/<strong>(参考素材 · \d+)<\/strong>/)[1]; heading.append(total); section.append(heading);
    const list = h.makeElement('div'); list.className = 'shot-reference-list';
    for (const match of sectionMatch[1].matchAll(/<div class="shot-reference-item"([^>]*)>([\s\S]*?)<\/div>/g)) {
      const row = h.makeElement('div'); row.className = 'shot-reference-item'; row.innerHTML = match[2];
      for (const attribute of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
        const name = attribute[1], value = decode(attribute[2]);
        if (name.startsWith('data-')) row.dataset[name.slice(5).replace(/-([a-z])/g,(_,letter) => letter.toUpperCase())] = value;
      }
      for (const buttonMatch of match[2].matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
        const button = h.makeElement('button');
        for (const attribute of buttonMatch[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
          const name = attribute[1], value = decode(attribute[2]); button.setAttribute(name,value);
          if (name.startsWith('data-')) button.dataset[name.slice(5).replace(/-([a-z])/g,(_,letter) => letter.toUpperCase())] = value;
        }
        button.disabled = /\sdisabled(?:\s|$)/.test(buttonMatch[1]);
        for (const textMatch of buttonMatch[2].matchAll(/<(strong|small)>([^<]*)<\/\1>/g)) {
          const text = h.makeElement(textMatch[1]); text.textContent = decode(textMatch[2]); button.append(text);
        }
        row.append(button);
      }
      assert.ok([2,3].includes(row.querySelectorAll('button').length)); list.append(row);
    }
    if (list.children.length) section.append(list);
    return section;
  };
  const markup = card.innerHTML.match(/<section class="shot-references"[^>]*>[\s\S]*?<\/section>/)?.[0];
  assert.ok(markup,'card must contain the production reference markup');
  const section = sectionFromMarkup(markup); card.append(section); return section;
}

const liveReferenceRows = section => section.querySelectorAll('.shot-reference-item').map(row => [
  ...row.querySelector('button').getAttribute('title').match(/^插入 @([^：]+)：(.*)$/).slice(1)]);

test('已生成的视频和图片可作为另一个分镜素材，并可跨分镜复用且不复制文件', async t => {
  const project = {
    id: 'generated-reference-project',
    assets: [
      { id: 'generated-video', kind: 'video', name: '镜头一生成视频.mp4', source: 'model', sceneId: 'scene-one' },
      { id: 'generated-image', kind: 'image', name: '镜头一生成图片.png', source: 'model', sceneId: 'scene-one' },
    ],
    scenes: ['scene-one', 'scene-two', 'scene-three'].map((id, index) => ({
      id, title: id, videoPrompt: '', promptMentions: [], duration: 5, generationDuration: 5,
      generationCount: 1, videoAssetId: '', references: [], x: index * 500,
    })),
    graph: graph([
      node('shot-one', 'video', { sceneId: 'scene-one', x: 0, y: 600, width: 400, height: 600 }),
      node('shot-two', 'video', { sceneId: 'scene-two', x: 500, y: 600, width: 400, height: 600 }),
      node('shot-three', 'video', { sceneId: 'scene-three', x: 1000, y: 600, width: 400, height: 600 }),
    ]),
  };
  const h = canvasHarness(t, project);
  h.canvas.render();
  const videoCard = h.canvas.addAsset(project.assets[0]);
  const imageCard = h.canvas.addAsset(project.assets[1]);
  assert.equal(videoCard.sceneId, '', '生成结果放到画布后不应继续绑定原分镜');
  assert.equal(imageCard.sceneId, '', '生成图片放到画布后不应继续绑定原分镜');

  await dragReference(h, videoCard.id, 'shot-two');
  await dragReference(h, imageCard.id, 'shot-two');
  await dragReference(h, videoCard.id, 'shot-three');
  assert.deepEqual(h.project.scenes.find(scene => scene.id === 'scene-two').references.map(item => [item.kind, item.assetId]), [
    ['video', 'generated-video'], ['image', 'generated-image'],
  ]);
  assert.deepEqual(h.project.scenes.find(scene => scene.id === 'scene-three').references.map(item => [item.kind, item.assetId]), [
    ['video', 'generated-video'],
  ]);
  assert.deepEqual(referenceRows(h.cardFor('shot-two')), [
    ['视频1', '镜头一生成视频.mp4'], ['图片1', '镜头一生成图片.png'],
  ]);
  assert.deepEqual(referenceRows(h.cardFor('shot-three')), [['视频1', '镜头一生成视频.mp4']]);

  h.canvas.addAsset(project.assets[0]);
  h.canvas.addAsset(project.assets[1]);
  assert.equal(h.project.graph.nodes.filter(item => item.assetId).length, 2, '同一生成结果重复放置不能创建重复素材卡');
  assert.equal(h.project.assets.length, 2, '跨分镜复用不能复制媒体文件');
  assert.doesNotThrow(() => validateGraph(h.project.graph));
});

test('素材右端口可拖到整张分镜的封面、提示词和按钮，多图片视频按连接顺序分别编号', async t => {
  const h = canvasHarness(t,referenceCanvasFixture()), beforeAssets = structuredClone(h.project.assets);
  h.state.jobs.push({id:'already-accepted',sceneId:'scene-other',state:'queued'});
  const jobs = structuredClone(h.state.jobs); h.marked.length = 0;
  for (const [from,tag] of [['image-a','img'],['video-a','textarea'],['image-b','button'],['video-b','span']]) {
    const card = h.cardFor('shot-main'), cover = h.makeElement('div'), child = h.makeElement(tag);
    cover.className = 'canvas-cover'; cover.append(child); card.append(cover);
    assert.equal(child.closest('[data-port]'),null,'目标必须整卡可接线，不借用输入端口');
    await dragReference(h,from,child);
  }
  assert.deepEqual(h.project.graph.links.map(link => [link.from,link.to]),
    [['image-a','shot-main'],['video-a','shot-main'],['image-b','shot-main'],['video-b','shot-main']]);
  assert.deepEqual(h.project.scenes[0].references.map(item => [item.nodeId,item.assetId,item.kind]),
    [['image-a','asset-image-a','image'],['video-a','asset-video-a','video'],['image-b','asset-image-b','image'],['video-b','asset-video-b','video']]);
  assert.deepEqual(referenceRows(h.cardFor('shot-main')),[['图片1','人物.png'],['视频1','动作.mp4'],['图片2','街景.png'],['视频2','运镜.mp4']]);
  assert.ok(h.document.hitTests.length >= 4);
  assert.ok(h.document.hitTests.every(point => point.x === 720 && point.y === 420),'预览和释放都使用实际屏幕指针位置');
  assert.ok(h.marked.includes('scenes')); assert.ok(h.marked.includes('graph'));
  assert.deepEqual(h.project.assets,beforeAssets); assert.deepEqual(h.state.jobs,jobs); assert.deepEqual(h.generated,[]);
  assert.doesNotThrow(() => validateGraph(h.project.graph));
});

test('拖线取消、丢失捕获、空白放开、自连和不兼容素材都不创建参考或申请任务', async t => {
  const h = canvasHarness(t,referenceCanvasFixture()), before = structuredClone(h.project);
  for (const release of ['pointercancel','lostpointercapture']) {
    const hitTestsBefore = h.document.hitTests.length;
    await dragReference(h,'image-a','shot-main',{release});
    assert.equal(h.document.hitTests.length,hitTestsBefore + 1,'取消时只进行移动预览，不进行释放连接判断');
    assert.equal(h.cardFor('shot-main').classList.contains('connection-snap'),false);
  }
  await dragReference(h,'image-a',null);
  await dragReference(h,'image-a','image-a');
  await dragReference(h,'image-a','audio-a');
  assert.deepEqual(h.project,before); assert.deepEqual(h.generated,[]); assert.deepEqual(h.state.jobs,[]);
  assert.ok(h.messages.some(message => /类型不匹配/.test(message)));
  assert.equal(h.element('#connections').innerHTML.includes('canvas-connection-preview'),false);
});

test('同分镜的多个卡片与同素材的重复卡不能重复占用参考名额，另一分镜可独立引用', async t => {
  const project = referenceCanvasFixture();
  project.graph.nodes.push(node('shot-copy','video',{sceneId:'scene-main',label:'主分镜副卡',x:900,y:500,width:400,height:600}),
    node('image-copy','image',{assetId:'asset-image-a',assetName:'人物.png',x:900,y:0}));
  const h = canvasHarness(t,project);
  await dragReference(h,'image-a','shot-main');
  await dragReference(h,'image-a','shot-copy');
  await dragReference(h,'image-copy','shot-copy');
  assert.equal(h.project.graph.links.length,1); assert.equal(h.project.scenes[0].references.length,1);
  assert.equal(h.messages.filter(message => /已经连接到同一视频/.test(message)).length,2);
  await dragReference(h,'image-copy','shot-other');
  assert.equal(h.project.graph.links.length,2);
  assert.equal(h.project.scenes[1].references[0].assetId,'asset-image-a');
  assert.equal(h.project.scenes[1].references[0].nodeId,'image-copy');
  assert.deepEqual(h.generated,[]); assert.doesNotThrow(() => validateGraph(h.project.graph));
});

test('到达参考准备上限后拒绝新增连接，并保留已经绑定的图片视频及其顺序', async t => {
  const h = canvasHarness(t,referenceCanvasFixture());
  h.state.catalog=[{name:'limited-model',referenceSupport:{protocol:'content-v3',imageLimit:9,videoLimit:3,audioLimit:3,totalLimit:2}}];
  await dragReference(h,'image-a','shot-main'); await dragReference(h,'video-a','shot-main');
  const links = structuredClone(h.project.graph.links), references = structuredClone(h.project.scenes[0].references);
  await dragReference(h,'image-b','shot-main');
  assert.deepEqual(h.project.graph.links,links); assert.deepEqual(h.project.scenes[0].references,references);
  assert.ok(h.messages.some(message => /最多/.test(message))); assert.deepEqual(h.generated,[]);
});

test('断开一份素材同步同分镜的全部卡片、重编号并标记失效引用，其他分镜及原文件保留', async t => {
  const project = referenceCanvasFixture([['image-a'],['video-a'],['image-b'],['video-b'],['image-a','shot-other']]);
  project.graph.nodes.push(node('shot-copy','video',{sceneId:'scene-main',label:'主分镜副卡',width:400,height:600}));
  project.graph.links.push({id:'old-copy-link',from:'image-a',to:'shot-copy'});
  const h = canvasHarness(t,project), {control,scene} = attachReferencePrompt(h);
  await inputPrompt(h,control,'以@图片1确定人物，@图片2确定场景；参考@视频1动作和@视频2运镜。'); control.blur();
  scene.references.find(item => item.nodeId === 'image-a').note = '保持人物服饰';
  h.state.jobs.push({id:'preserved-job',sceneId:scene.id,state:'done'});
  const assets = structuredClone(h.project.assets), jobs = structuredClone(h.state.jobs), other = structuredClone(h.project.scenes[1]);
  await h.cardAction('shot-main','disconnect-reference',{referenceNode:'image-a'});
  assert.deepEqual(scene.references.map(item => item.nodeId),['video-a','image-b','video-b']);
  assert.equal(scene.videoPrompt,'以@图片1（已断开）确定人物，@图片1确定场景；参考@视频1动作和@视频2运镜。');
  assert.deepEqual(scene.promptMentions.map(item => [item.key,item.label,item.missing]),
    [['node:image-a','图片1',true],['node:image-b','图片1',false],['node:video-a','视频1',false],['node:video-b','视频2',false]]);
  assert.deepEqual(h.project.graph.links.filter(link => link.from === 'image-a').map(link => link.to),['shot-other']);
  assert.deepEqual(referenceRows(h.cardFor('shot-main')),[['视频1','动作.mp4'],['图片1','街景.png'],['视频2','运镜.mp4']]);
  assert.deepEqual(referenceRows(h.cardFor('shot-copy')),referenceRows(h.cardFor('shot-main')));
  assert.deepEqual(h.project.scenes[1],other); assert.deepEqual(h.project.assets,assets); assert.deepEqual(h.state.jobs,jobs);
  assert.ok(h.project.graph.nodes.some(item => item.id === 'image-a')); assert.deepEqual(h.generated,[]);
});

test('连接的撤销重做恢复参考身份、用途和提示词编号，同时保留后来的选片及任务', async t => {
  const h = canvasHarness(t,referenceCanvasFixture([['image-a']]));
  await dragReference(h,'image-b','shot-main');
  const {control,scene} = attachReferencePrompt(h);
  await inputPrompt(h,control,'用@图片1的人物进入@图片2街景。'); control.blur();
  scene.references.find(item => item.nodeId === 'image-a').note = '后来编辑的人物用途';
  scene.references.find(item => item.nodeId === 'image-b').note = '后来编辑的街景用途';
  const candidate = {id:'later-candidate',kind:'video',name:'后完成候选.mp4',source:'model',sceneId:scene.id};
  h.project.assets.push(candidate); scene.videoAssetId = candidate.id;
  h.state.jobs.push({id:'later-completion',sceneId:scene.id,state:'done',assetId:candidate.id});
  const assets = structuredClone(h.project.assets), jobs = structuredClone(h.state.jobs);
  h.element('#undo-canvas').onclick();
  assert.deepEqual(scene.references.map(item => item.nodeId),['image-a']);
  assert.equal(scene.references[0].note,'后来编辑的人物用途');
  assert.equal(scene.videoPrompt,'用@图片1的人物进入@图片2（已断开）街景。');
  assert.equal(scene.promptMentions[1].key,'node:image-b'); assert.equal(scene.promptMentions[1].missing,true);
  h.element('#redo-canvas').onclick();
  assert.deepEqual(scene.references.map(item => [item.nodeId,item.note]),
    [['image-a','后来编辑的人物用途'],['image-b','后来编辑的街景用途']]);
  assert.equal(scene.videoPrompt,'用@图片1的人物进入@图片2街景。');
  assert.equal(scene.promptMentions[1].key,'node:image-b'); assert.equal(scene.promptMentions[1].missing,false);
  assert.equal(scene.videoAssetId,candidate.id); assert.deepEqual(h.project.assets,assets); assert.deepEqual(h.state.jobs,jobs);
  assert.deepEqual(h.generated,[]); assert.doesNotThrow(() => validateGraph(h.project.graph));
});

test('断线的撤销重做恢复被移除的用途，保留之后编辑的其他用途和提示词正文', async t => {
  const h = canvasHarness(t,referenceCanvasFixture([['image-a'],['image-b']]));
  let editor = attachReferencePrompt(h), scene = editor.scene;
  await inputPrompt(h,editor.control,'使用@图片1人物和@图片2街景'); editor.control.blur();
  scene.references[0].note = '保持人物服饰'; scene.references[1].note = '初始街景用途';
  await h.cardAction('shot-main','disconnect-reference',{referenceNode:'image-a'});
  scene.references[0].note = '断线之后编辑的街景用途';
  editor = attachReferencePrompt(h);
  const suffix = '，保持夜色';
  await inputPrompt(h,editor.control,scene.videoPrompt + suffix,{start:scene.videoPrompt.length,end:scene.videoPrompt.length,text:suffix});
  editor.control.blur();
  h.element('#undo-canvas').onclick();
  assert.deepEqual(scene.references.map(item => [item.nodeId,item.note]),
    [['image-a','保持人物服饰'],['image-b','断线之后编辑的街景用途']]);
  assert.equal(scene.videoPrompt,'使用@图片1人物和@图片2街景，保持夜色');
  assert.deepEqual(scene.promptMentions.map(item => [item.key,item.missing]),[['node:image-a',false],['node:image-b',false]]);
  h.element('#redo-canvas').onclick();
  assert.deepEqual(scene.references.map(item => [item.nodeId,item.note]),[['image-b','断线之后编辑的街景用途']]);
  assert.equal(scene.videoPrompt,'使用@图片1（已断开）人物和@图片1街景，保持夜色');
  assert.deepEqual(h.generated,[]);
});

test('@ 菜单按连线顺序列出分类型编号，键盘插入并在重编号后仍指向原素材', async t => {
  const h = canvasHarness(t,referenceCanvasFixture([['image-a'],['video-a'],['image-b'],['video-b']]));
  const {control,menu,scene} = attachReferencePrompt(h);
  await inputPrompt(h,control,'参考@');
  assert.equal(menu.hidden,false); assert.equal(control.getAttribute('aria-expanded'),'true');
  assert.deepEqual(menu.querySelectorAll('[data-mention-index]').map(option => option.textContent),
    ['▧@图片1人物.png','▷@视频1动作.mp4','▧@图片2街景.png','▷@视频2运镜.mp4']);
  await promptKey(h,control,'ArrowDown'); await promptKey(h,control,'ArrowDown');
  const chosen = menu.querySelectorAll('[data-mention-index]')[2];
  assert.equal(chosen.getAttribute('aria-selected'),'true'); assert.equal(control.getAttribute('aria-activedescendant'),chosen.id);
  const inserted = await promptKey(h,control,'Enter');
  assert.equal(inserted.defaultPrevented,true); assert.equal(inserted.propagationStopped,true);
  assert.equal(scene.videoPrompt,'参考@图片2'); assert.equal(control.value,scene.videoPrompt);
  assert.equal(control.selectionStart,6); assert.equal(control.selectionEnd,6);
  assert.deepEqual(scene.promptMentions.map(item => [item.key,item.assetId,item.start,item.end]),[['node:image-b','asset-image-b',2,6]]);
  assert.equal(menu.hidden,true); assert.equal(control.getAttribute('aria-activedescendant'),null); assert.equal(h.document.activeElement,control);
  control.blur(); await h.cardAction('shot-main','disconnect-reference',{referenceNode:'image-a'});
  assert.equal(scene.videoPrompt,'参考@图片1'); assert.equal(scene.promptMentions[0].key,'node:image-b'); assert.equal(scene.promptMentions[0].missing,false);
  assert.deepEqual(h.generated,[]);
});

test('@ 菜单可筛选视频，中文输入法组合期间不拦截 Enter，Esc 收起后仍能继续输入', async t => {
  const h = canvasHarness(t,referenceCanvasFixture([['image-a'],['video-a'],['image-b'],['video-b']]));
  const {control,menu,scene} = attachReferencePrompt(h);
  await h.element('#nodes').fire('compositionstart',{target:control});
  await inputPrompt(h,control,'@视频',{isComposing:true});
  assert.equal(menu.hidden,true);
  assert.equal((await promptKey(h,control,'Enter',{isComposing:true})).defaultPrevented,false);
  await h.element('#nodes').fire('compositionend',{target:control});
  assert.deepEqual(menu.querySelectorAll('[data-mention-index]').map(option => option.textContent),['▷@视频1动作.mp4','▷@视频2运镜.mp4']);
  const escaped = await promptKey(h,control,'Escape');
  assert.equal(escaped.defaultPrevented,true); assert.equal(menu.hidden,true); assert.equal(scene.videoPrompt,'@视频');
  await inputPrompt(h,control,'@视频',{start:control.value.length,end:control.value.length,text:''});
  await promptKey(h,control,'ArrowDown'); await promptKey(h,control,'Tab');
  assert.equal(scene.videoPrompt,'@视频2'); assert.equal(scene.promptMentions[0].key,'node:video-b');
  assert.deepEqual(h.generated,[]); assert.equal(h.project.graph.links.length,4);
});

test('精确删除两个同号失效引用中的第一条时，保留第二条素材身份并可在重连后恢复', async t => {
  const project = referenceCanvasFixture(), scene = project.scenes[0], token = '@图片1（已断开）';
  scene.videoPrompt = token + token;
  scene.promptMentions = ['image-a','image-b'].map((id,index) => ({start:index*token.length,end:(index+1)*token.length,
    key:'node:'+id,assetId:'asset-'+id,kind:'image',label:'图片1',missing:true}));
  const h = canvasHarness(t,project), {control} = attachReferencePrompt(h);
  await inputPrompt(h,control,token,{start:0,end:token.length,text:'',inputType:'deleteContentBackward'});
  assert.equal(scene.videoPrompt,token); assert.equal(scene.promptMentions.length,1);
  assert.equal(scene.promptMentions[0].key,'node:image-b','不能把被删除的第一份素材身份交给剩下的同号引用');
  control.blur(); await dragReference(h,'image-b','shot-main');
  assert.equal(scene.videoPrompt,'@图片1'); assert.equal(scene.promptMentions[0].key,'node:image-b'); assert.equal(scene.promptMentions[0].missing,false);
  assert.deepEqual(h.generated,[]);
});

test('已有手动参考被连线接管再断开后，保留手动身份与用途且提示词引用保持有效', async t => {
  const project = referenceCanvasFixture(), scene = project.scenes[0];
  scene.references = [{refId:'manual-person',assetId:'asset-image-a',kind:'image',name:'人物.png',note:'固定人设'}];
  scene.videoPrompt = '保持@图片1的服饰';
  const h = canvasHarness(t,project);
  assert.equal(scene.promptMentions[0].key,'ref:manual-person');
  await dragReference(h,'image-a','shot-main');
  assert.equal(scene.references[0].nodeId,'image-a'); assert.equal(scene.references[0].refId,'manual-person');
  assert.equal(scene.references[0].note,'固定人设'); assert.equal(scene.promptMentions[0].key,'node:image-a');
  await h.cardAction('shot-main','disconnect-reference',{referenceNode:'image-a'});
  assert.deepEqual(scene.references,[{refId:'manual-person',assetId:'asset-image-a',kind:'image',name:'人物.png',note:'固定人设'}]);
  assert.equal(scene.videoPrompt,'保持@图片1的服饰'); assert.equal(scene.promptMentions[0].key,'ref:manual-person'); assert.equal(scene.promptMentions[0].missing,false);
  h.element('#undo-canvas').onclick();
  assert.equal(scene.references[0].nodeId,'image-a'); assert.equal(scene.promptMentions[0].key,'node:image-a');
  h.element('#redo-canvas').onclick();
  assert.equal(scene.references[0].nodeId,undefined); assert.equal(scene.references[0].note,'固定人设');
  assert.equal(scene.promptMentions[0].key,'ref:manual-person'); assert.deepEqual(h.generated,[]);
});


test('导入占位图片补选再撤销时恢复原用途和空素材身份，再补选另一素材可恢复引用', async t => {
  const project = referenceCanvasFixture(), scene = project.scenes[0];
  project.graph.nodes.push(node('import-placeholder','image',{assetName:'导入人物.png',x:1600,y:0}));
  project.graph.links.push({id:'placeholder-reference',from:'import-placeholder',to:'shot-main'});
  scene.references = [{nodeId:'import-placeholder',refId:'import-person',assetId:'',kind:'image',name:'导入人物.png',note:'原人物用途'}];
  scene.videoPrompt = '遵循@图片1的服饰';
  const h = canvasHarness(t,project), first = project.assets.find(asset => asset.id === 'asset-image-a'), second = project.assets.find(asset => asset.id === 'asset-image-b');
  assert.equal(scene.references.length,1); assert.equal(scene.references[0].note,'原人物用途');
  await h.cardAction('import-placeholder','relink'); h.canvas.addAsset(first);
  assert.equal(scene.references.length,1); assert.equal(scene.references[0].refId,'import-person');
  assert.equal(scene.references[0].assetId,first.id); assert.equal(scene.references[0].note,'原人物用途');
  assert.equal(scene.promptMentions[0].assetId,first.id); assert.equal(scene.promptMentions[0].missing,false);
  scene.references[0].note = '补选人物的新用途';
  h.element('#undo-canvas').onclick();
  assert.equal(project.graph.nodes.find(item => item.id === 'import-placeholder').assetId,'');
  assert.deepEqual(scene.references,[{nodeId:'import-placeholder',refId:'import-person',assetId:'',kind:'image',name:'导入人物.png',note:'原人物用途'}]);
  assert.equal(scene.references.some(reference => reference.assetId === first.id),false,'补选素材不能退回残留的伪手动参考');
  assert.equal(scene.promptMentions.length,1); assert.equal(scene.promptMentions[0].key,'node:import-placeholder');
  assert.notEqual(scene.promptMentions[0].assetId,first.id,'撤销后的占位引用不能仍然绑定已撤销的素材');
  await h.cardAction('import-placeholder','relink'); h.canvas.addAsset(second);
  assert.equal(scene.references.length,1); assert.equal(scene.references[0].assetId,second.id); assert.equal(scene.references[0].note,'原人物用途');
  assert.equal(scene.videoPrompt,'遵循@图片1的服饰');
  assert.deepEqual(scene.promptMentions.map(mention => [mention.key,mention.assetId,mention.missing]),[['node:import-placeholder',second.id,false]]);
  assert.deepEqual(h.generated,[]);
});

test('同素材的代表卡移除后编辑用途，撤销移除恢复原代表但保留后来用途', async t => {
  const project = referenceCanvasFixture([['image-a'],['image-copy']]), scene = project.scenes[0];
  project.graph.nodes.push(node('image-copy','image',{assetId:'asset-image-a',assetName:'人物.png',x:1600,y:0}));
  scene.references = [{nodeId:'image-a',assetId:'asset-image-a',kind:'image',name:'人物.png',note:'原用途',publicUrl:'https://media.example.org/original.png'}];
  scene.videoPrompt = '保持@图片1的人设';
  const h = canvasHarness(t,project);
  assert.equal(scene.references.length,1); assert.equal(scene.references[0].nodeId,'image-a');
  await h.cardAction('image-a','remove');
  assert.equal(scene.references.length,1); assert.equal(scene.references[0].nodeId,'image-copy'); assert.equal(scene.references[0].note,'原用途');
  scene.references[0].note = '删除代表卡后补写的新用途';
  scene.references[0].publicUrl = 'https://media.example.org/new-signed.png?signature=new';
  h.element('#undo-canvas').onclick();
  assert.ok(project.graph.nodes.some(item => item.id === 'image-a')); assert.equal(project.graph.links.length,2);
  assert.equal(scene.references.length,1); assert.equal(scene.references[0].nodeId,'image-a');
  assert.equal(scene.references[0].note,'删除代表卡后补写的新用途','旧快照不能覆盖对相同素材后来补写的用途');
  assert.equal(scene.references[0].publicUrl,'https://media.example.org/new-signed.png?signature=new');
  h.element('#redo-canvas').onclick(); delete scene.references[0].publicUrl;
  h.element('#undo-canvas').onclick();
  assert.equal(scene.references[0].publicUrl,undefined,'用户清空链接后撤销也不能恢复失效旧链接');
  assert.equal(scene.videoPrompt,'保持@图片1的人设'); assert.equal(scene.promptMentions[0].key,'node:image-a');
  assert.deepEqual(h.generated,[]);
});

test('提示词失焦到实际断开按钮时一次点击断线，立即刷新控件与参考编号', async t => {
  const h = canvasHarness(t,referenceCanvasFixture([['image-a'],['video-a'],['image-b'],['video-b']]));
  const {card,control,menu,scene} = attachReferencePrompt(h); attachReferenceList(h,card);
  const value = '遵循@图片1与@视频1，在@图片2的街景中使用@视频2的运镜';
  control.focus(); control.setSelectionRange(0,0);
  await h.dispatch(control,'beforeinput',{inputType:'insertText',data:value,isComposing:false});
  control.value = value; control.setSelectionRange(value.length,value.length);
  await h.dispatch(control,'input',{inputType:'insertText',data:value,isComposing:false});
  assert.equal(scene.promptMentions.length,4); assert.equal(scene.videoPrompt,value);
  const sectionBefore = card.querySelector('.shot-references'), action = sectionBefore.querySelector('[data-card-action="disconnect-reference"]');
  assert.equal(action.tagName,'BUTTON'); assert.equal(action.dataset.referenceNode,'image-a'); assert.equal(action.closest('.canvas-node'),card);
  assert.deepEqual(liveReferenceRows(sectionBefore),[['图片1','人物.png'],['视频1','动作.mp4'],['图片2','街景.png'],['视频2','运镜.mp4']]);
  const seen = [], viewport = h.element('#canvas-viewport');
  for (const type of ['pointerdown','focusout','click']) viewport.addEventListener(type,event => seen.push([type,event.target,event.composedPath()]));
  await h.dispatch(action,'pointerdown',{button:0,pointerId:29,pointerType:'mouse',clientX:700,clientY:430,shiftKey:false});
  control.blur(); await h.dispatch(control,'focusout',{relatedTarget:action});
  // Await dispatch has already drained the focusout microtask before the button
  // takes focus, matching the vulnerable gap in the native event sequence.
  assert.equal(h.document.activeElement,null); assert.equal(card.contains(action),true,'失焦微任务不能替换下一次 click 的按钮');
  assert.equal(card.querySelector('[data-reference-prompt]'),control,'从提示词切到同卡按钮时不能重建编辑器');
  action.focus(); await h.dispatch(action,'focusin',{relatedTarget:control}); menu.hidden = false;
  await h.dispatch(action,'pointerup',{button:0,pointerId:29,pointerType:'mouse',clientX:700,clientY:430});
  const clicked = await h.dispatch(action,'click',{button:0});
  assert.equal(h.project.graph.links.length,3); assert.equal(h.project.graph.links.some(link => link.from === 'image-a'),false);
  assert.equal(scene.references.length,3);
  assert.equal(control.value,'遵循@图片1（已断开）与@视频1，在@图片1的街景中使用@视频2的运镜');
  assert.equal(control.value,scene.videoPrompt); assert.equal(card.querySelector('[data-reference-prompt]'),control);
  assert.equal(menu.hidden,true,'重映射提示词后立即关闭旧的 @ 菜单');
  assert.equal(scene.promptMentions.find(mention => mention.key === 'node:image-a').missing,true);
  assert.equal(scene.promptMentions.find(mention => mention.key === 'node:image-b').label,'图片1');
  const sectionAfter = card.querySelector('.shot-references');
  assert.notEqual(sectionAfter,sectionBefore); assert.equal(sectionBefore.parentElement,null,'outerHTML 应真正替换参考 DOM');
  assert.equal(sectionBefore.outerHTMLUpdates.length,1); assert.equal(sectionAfter.querySelector('.shot-reference-heading').querySelector('strong').textContent,'参考素材 · 3');
  assert.deepEqual(liveReferenceRows(sectionAfter),[['视频1','动作.mp4'],['图片1','街景.png'],['视频2','运镜.mp4']]);
  assert.deepEqual(sectionAfter.querySelectorAll('[data-card-action="disconnect-reference"]').map(button => button.getAttribute('aria-label')),['断开视频1','断开图片1','断开视频2']);
  assert.deepEqual(seen.map(([type]) => type),['pointerdown','focusout','click'],'事件应通过真实 viewport 冒泡');
  assert.equal(seen.every(([,target,path]) => path.includes(card) && path.includes(viewport) && path.includes(h.document)),true);
  assert.equal(clicked.composedPath().includes(viewport),true); assert.deepEqual(h.generated,[]);
});


for (const placeholderRefId of ['', 'import-placeholder-ref']) {
  test('占位参考' + (placeholderRefId ? '有独立refId' : '无refId') + '时拒绝补选同分镜手动素材，补选另一素材及撤销保留手动身份', async t => {
    const project = referenceCanvasFixture(), scene = project.scenes[0];
    project.graph.nodes.push(node('import-placeholder','image',{assetName:'导入构图.png',x:1600,y:0}));
    project.graph.links.push({id:'placeholder-reference',from:'import-placeholder',to:'shot-main'});
    const placeholder = {nodeId:'import-placeholder',assetId:'',kind:'image',name:'导入构图.png',note:'原占位构图用途',...(placeholderRefId ? {refId:placeholderRefId} : {})};
    const manual = {refId:'manual-person',assetId:'asset-image-a',kind:'image',name:'人物.png',note:'原手动人物用途'};
    scene.references = [placeholder,manual]; scene.videoPrompt = '遵循@图片1的构图和@图片2的人物服饰';
    const h = canvasHarness(t,project), occupied = project.assets.find(asset => asset.id === manual.assetId), available = project.assets.find(asset => asset.id === 'asset-image-b');
    const before = structuredClone(project), originalManual = structuredClone(scene.references.find(reference => reference.refId === manual.refId));
    assert.equal(h.element('#undo-canvas').disabled,true); assert.equal(h.element('#redo-canvas').disabled,true);
    assert.equal(scene.promptMentions.find(mention => mention.key === 'ref:manual-person').assetId,occupied.id);
    await h.cardAction('import-placeholder','relink'); h.marked.length = 0;
    assert.equal(h.element('#canvas-assets-panel').hidden,false);
    h.canvas.addAsset(occupied);
    assert.deepEqual(project,before,'拒绝重复补选应在工程修改前完成'); assert.deepEqual(h.marked,[],'拒绝操作不能把工程标为未保存');
    assert.equal(h.element('#canvas-assets-panel').hidden,false,'保留补选抽屉供用户继续选择');
    assert.equal(h.element('#undo-canvas').disabled,true); assert.equal(h.element('#redo-canvas').disabled,true);
    h.element('#undo-canvas').onclick(); assert.deepEqual(project,before); assert.deepEqual(h.marked,[],'拒绝补选不得加入撤销历史');
    assert.ok(h.messages.some(message => /素材已用于.*视频/.test(message)));
    // No new relink click: the rejected choice must retain the intended target.
    const supplemented = h.canvas.addAsset(available);
    assert.equal(supplemented.id,'import-placeholder'); assert.equal(supplemented.assetId,available.id);
    assert.equal(project.graph.nodes.length,before.graph.nodes.length,'继续选择应补选原卡，而非新增卡');
    assert.equal(h.element('#canvas-assets-panel').hidden,true); assert.equal(h.element('#undo-canvas').disabled,false);
    assert.equal(scene.references.length,2);
    assert.deepEqual(scene.references.find(reference => reference.refId === manual.refId),originalManual,'手动素材的身份和用途不能被占位素材接管');
    const selectedReference = scene.references.find(reference => reference.nodeId === 'import-placeholder');
    assert.equal(selectedReference.assetId,available.id); assert.equal(selectedReference.note,placeholder.note);
    assert.equal(selectedReference.refId,placeholderRefId || undefined);
    assert.deepEqual(scene.promptMentions.map(mention => [mention.key,mention.assetId,mention.missing]),[['node:import-placeholder',available.id,false],['ref:manual-person',occupied.id,false]]);
    assert.equal(scene.videoPrompt,'遵循@图片1的构图和@图片2的人物服饰');
    h.element('#undo-canvas').onclick();
    assert.deepEqual(project,before,'撤销成功补选应恢复原占位及手动素材，不能还原到被拒绝的重复素材');
    assert.deepEqual(scene.references.find(reference => reference.refId === manual.refId),originalManual);
    assert.equal(scene.promptMentions.find(mention => mention.key === 'ref:manual-person').assetId,occupied.id);
    assert.equal(scene.promptMentions.find(mention => mention.key === 'ref:manual-person').missing,false);
    assert.equal(h.element('#undo-canvas').disabled,true); assert.equal(h.element('#redo-canvas').disabled,false);
    assert.deepEqual(h.generated,[]);
  });
}


for (const useManualReference of [false, true]) {
  test('复制素材及同分镜副卡后，参考清单一次断开全部同素材连线并可撤销重做' + (useManualReference ? '，保留手动参考' : '，标记连线引用失效'), async t => {
    const project = referenceCanvasFixture([['image-a','shot-other']]), scene = project.scenes[0];
    project.graph.nodes = project.graph.nodes.filter(item => ['image-a','shot-main','shot-other'].includes(item.id));
    const originalReference = {assetId:'asset-image-a',kind:'image',name:'人物.png',note:'固定人设',
      ...(useManualReference ? {refId:'manual-person'} : {nodeId:'image-a'})};
    scene.references = [originalReference]; scene.videoPrompt = '遵循@图片1的人物服饰';
    project.scenes[1].references = [{nodeId:'image-a',assetId:'asset-image-a',kind:'image',name:'人物.png',note:'其他分镜用途'}];
    project.scenes[1].videoPrompt = '其他分镜也使用@图片1';
    if (!useManualReference) project.graph.links.push({id:'main-original-link',from:'image-a',to:'shot-main'});
    const h = canvasHarness(t,project);
    if (useManualReference) {
      assert.equal(scene.promptMentions[0].key,'ref:manual-person');
      await dragReference(h,'image-a','shot-main');
      assert.equal(scene.promptMentions[0].key,'node:image-a');
    }
    await h.keyboard('a'); h.element('#duplicate-selection').onclick();
    const copiedSource = project.graph.nodes.find(item => item.id !== 'image-a' && item.assetId === 'asset-image-a');
    const copiedShot = project.graph.nodes.find(item => item.id !== 'shot-main' && item.sceneId === scene.id);
    const mainLinks = () => project.graph.links.filter(link => project.graph.nodes.find(item => item.id === link.to)?.sceneId === scene.id);
    const otherLinks = () => project.graph.links.filter(link => project.graph.nodes.find(item => item.id === link.to)?.sceneId === 'scene-other');
    assert.ok(copiedSource); assert.ok(copiedShot); assert.equal(mainLinks().length,2); assert.equal(otherLinks().length,2);
    assert.equal(scene.references.length,1,'同素材副卡不能增加参考数量');
    assert.ok(mainLinks().some(link => link.from === copiedSource.id && link.to === copiedShot.id),'必须通过真实复制操作建立副卡连线');
    h.state.jobs.push({id:'preserved-accepted-job',sceneId:scene.id,state:'queued'});
    const before = structuredClone({nodes:project.graph.nodes,links:project.graph.links,references:scene.references,mentions:scene.promptMentions}),
      other = structuredClone(project.scenes[1]), otherConnections = structuredClone(otherLinks()), assets = structuredClone(project.assets), jobs = structuredClone(h.state.jobs);
    const {control,card} = attachReferencePrompt(h), section = attachReferenceList(h,card);
    const button = section.querySelector('[data-card-action="disconnect-reference"]');
    assert.equal(button.dataset.referenceNode,'image-a'); button.focus(); await h.dispatch(button,'click');
    assert.deepEqual(mainLinks(),[],'一次断开应移除同分镜原卡和所有同素材副卡的连线');
    assert.deepEqual(otherLinks(),otherConnections,'其他分镜及其副卡连线保留');
    assert.deepEqual(project.graph.nodes,before.nodes,'保留素材卡、分镜卡和副卡');
    assert.equal(h.messages.at(-1),'已断开画布连接，原文件保留');
    if (useManualReference) {
      assert.deepEqual(scene.references,[originalReference]);
      assert.equal(scene.videoPrompt,'遵循@图片1的人物服饰');
      assert.equal(scene.promptMentions[0].key,'ref:manual-person'); assert.equal(scene.promptMentions[0].missing,false);
      assert.deepEqual(liveReferenceRows(card.querySelector('.shot-references')),[['图片1','人物.png']]);
      assert.equal(card.querySelector('[data-card-action="disconnect-reference"]'),null,'回退手动参考后不再显示断线按钮');
      assert.deepEqual(referenceRows(h.cardFor(copiedShot.id)),[['图片1','人物.png']]);
    } else {
      assert.deepEqual(scene.references,[]); assert.equal(scene.videoPrompt,'遵循@图片1（已断开）的人物服饰');
      assert.equal(scene.promptMentions[0].key,'node:image-a'); assert.equal(scene.promptMentions[0].missing,true);
      assert.deepEqual(liveReferenceRows(card.querySelector('.shot-references')),[]);
      assert.deepEqual(referenceRows(h.cardFor(copiedShot.id)),[]);
    }
    assert.equal(control.value,scene.videoPrompt,'当前提示词控件应立即同步');
    assert.deepEqual(project.scenes[1],other); assert.deepEqual(project.assets,assets); assert.deepEqual(h.state.jobs,jobs);
    h.element('#undo-canvas').onclick();
    assert.deepEqual(project.graph.links,before.links); assert.deepEqual(scene.references,before.references); assert.deepEqual(scene.promptMentions,before.mentions);
    assert.equal(scene.videoPrompt,'遵循@图片1的人物服饰'); assert.equal(scene.references[0].note,'固定人设');
    assert.deepEqual(referenceRows(h.cardFor('shot-main')),[['图片1','人物.png']]);
    assert.deepEqual(referenceRows(h.cardFor(copiedShot.id)),[['图片1','人物.png']]);
    h.element('#redo-canvas').onclick();
    assert.deepEqual(mainLinks(),[]); assert.deepEqual(otherLinks(),otherConnections);
    assert.equal(scene.references.length,useManualReference ? 1 : 0);
    assert.equal(scene.promptMentions[0].missing,!useManualReference);
    assert.equal(scene.promptMentions[0].key,useManualReference ? 'ref:manual-person' : 'node:image-a');
    if (useManualReference) assert.deepEqual(scene.references,[originalReference]);
    assert.deepEqual(project.scenes[1],other); assert.deepEqual(project.assets,assets); assert.deepEqual(h.state.jobs,jobs); assert.deepEqual(h.generated,[]);
  });
}

test('复制素材和分镜后选中单条连线按Delete仅删除该线，其余同素材连线继续引用且可撤销重做', async t => {
  const project = referenceCanvasFixture([['image-a']]), scene = project.scenes[0];
  project.graph.nodes = project.graph.nodes.filter(item => ['image-a','shot-main'].includes(item.id));
  scene.references = [{nodeId:'image-a',assetId:'asset-image-a',kind:'image',name:'人物.png',note:'固定人设'}];
  scene.videoPrompt = '保持@图片1的人物服饰';
  const h = canvasHarness(t,project); await h.keyboard('a'); h.element('#duplicate-selection').onclick();
  const sourceCopy = project.graph.nodes.find(item => item.id !== 'image-a' && item.assetId === 'asset-image-a');
  const originalLink = project.graph.links.find(link => link.from === 'image-a'), copiedLink = project.graph.links.find(link => link.from === sourceCopy.id);
  assert.equal(project.graph.links.length,2); assert.equal(scene.references.length,1);
  const before = structuredClone({nodes:project.graph.nodes,links:project.graph.links,assets:project.assets});
  const edge = h.makeElement('path'); edge.dataset.linkId = originalLink.id; h.element('#canvas-viewport').append(edge);
  await h.dispatch(edge,'pointerdown',{button:0,pointerId:23,clientX:450,clientY:350});
  const deleted = await h.keyboard('Delete',{ctrlKey:false}); assert.equal(deleted.defaultPrevented,true);
  assert.deepEqual(project.graph.links,[copiedLink],'Delete选中连线只删除该线'); assert.deepEqual(project.graph.nodes,before.nodes);
  assert.equal(scene.references.length,1); assert.equal(scene.references[0].nodeId,sourceCopy.id); assert.equal(scene.references[0].note,'固定人设');
  assert.equal(scene.videoPrompt,'保持@图片1的人物服饰'); assert.equal(scene.promptMentions[0].key,'node:'+sourceCopy.id); assert.equal(scene.promptMentions[0].missing,false);
  h.element('#undo-canvas').onclick(); assert.deepEqual(project.graph.links,before.links); assert.equal(scene.references[0].nodeId,'image-a');
  assert.equal(scene.references[0].note,'固定人设'); assert.equal(scene.promptMentions[0].missing,false);
  h.element('#redo-canvas').onclick(); assert.deepEqual(project.graph.links,[copiedLink]); assert.equal(scene.references[0].nodeId,sourceCopy.id);
  assert.equal(scene.promptMentions[0].missing,false); assert.deepEqual(project.assets,before.assets); assert.deepEqual(h.generated,[]);
});

test('同名空素材占位的清单断开按nodeId匹配，保留其他占位的连线及引用身份', async t => {
  const project = referenceCanvasFixture(), scene = project.scenes[0];
  project.graph.nodes = project.graph.nodes.filter(item => item.id === 'shot-main');
  project.graph.nodes.push(node('empty-a','image',{assetName:'待补人物.png'}),node('empty-b','image',{assetName:'待补人物.png'}),
    node('shot-copy','video',{sceneId:scene.id,label:'主分镜副卡',width:400,height:600}));
  project.graph.links = [
    {id:'empty-a-main',from:'empty-a',to:'shot-main'},{id:'empty-a-copy',from:'empty-a',to:'shot-copy'},
    {id:'empty-b-main',from:'empty-b',to:'shot-main'}];
  scene.references = ['empty-a','empty-b'].map((id,index) => ({nodeId:id,assetId:'',kind:'image',name:'待补人物.png',note:'占位用途'+index}));
  scene.videoPrompt = '参考@图片1的人物和@图片2的场景';
  const h = canvasHarness(t,project), before = structuredClone(project.graph.links);
  const {card} = attachReferencePrompt(h), section = attachReferenceList(h,card), button = section.querySelector('[data-card-action="disconnect-reference"]');
  assert.equal(button.dataset.referenceNode,'empty-a'); button.focus(); await h.dispatch(button,'click');
  assert.deepEqual(project.graph.links,[before[2]]); assert.equal(scene.references.length,1); assert.equal(scene.references[0].nodeId,'empty-b');
  assert.equal(scene.references[0].note,'占位用途1');
  assert.deepEqual(scene.promptMentions.map(mention => [mention.key,mention.missing]),[['node:empty-a',true],['node:empty-b',true]]);
  assert.equal(scene.videoPrompt,'参考@图片1（已断开）的人物和@图片1（已断开）的场景');
  h.element('#undo-canvas').onclick(); assert.deepEqual(project.graph.links,before); assert.deepEqual(scene.references.map(reference => reference.nodeId),['empty-a','empty-b']);
  h.element('#redo-canvas').onclick(); assert.deepEqual(project.graph.links,[before[2]]); assert.equal(scene.references[0].nodeId,'empty-b'); assert.deepEqual(h.generated,[]);
});


function directSceneFixture() {
  const project = referenceCanvasFixture();
  project.scenes.push({ id: 'scene-third', title: '第三分镜', videoPrompt: '', promptMentions: [], duration: 5, references: [] });
  project.graph.nodes.push(node('shot-third', 'video', { sceneId: 'scene-third' }));
  project.assets.push(
    { id: 'generated-first', kind: 'video', name: '主分镜候选一.mp4', source: 'model', sceneId: 'scene-main' },
    { id: 'generated-second', kind: 'video', name: '主分镜候选二.mp4', source: 'model', sceneId: 'scene-main' });
  project.scenes[0].videoAssetId = 'generated-first';
  return project;
}

test('已生成的分镜卡直接连接另一个分镜，使用当前封面候选并固定参考，不需要额外素材卡', async t => {
  const h = canvasHarness(t, directSceneFixture()), nodeCount = h.project.graph.nodes.length;
  const source = h.cardFor('shot-main');
  source.dataset.previewAsset = 'generated-second'; h.canvas.render({ forceId: 'shot-main' });
  await dragReference(h, 'shot-main', 'shot-other');
  const target = h.project.scenes[1];
  assert.equal(h.project.graph.nodes.length, nodeCount);
  assert.deepEqual(target.references.map(ref => [ref.nodeId, ref.assetId, ref.kind]), [['shot-main', 'generated-second', 'video']]);
  assert.deepEqual(h.project.graph.links[0].reference, { assetId: 'generated-second', kind: 'video', name: '主分镜候选二.mp4' });
  assert.deepEqual(referenceRows(h.cardFor('shot-other')), [['视频1', '主分镜候选二.mp4']]);
  const { control, menu } = attachReferencePrompt(h, 'shot-other');
  await inputPrompt(h, control, '@'); assert.equal(menu.children.length, 1); assert.match(menu.children[0].textContent, /@视频1.*主分镜候选二\.mp4/);
  await inputPrompt(h, control, '参考@视频1延续动作。'); control.blur();
  assert.equal(target.promptMentions[0].key, 'node:shot-main'); assert.equal(target.promptMentions[0].assetId, 'generated-second');
  source.dataset.previewAsset = 'generated-first'; h.canvas.render({ forceId: 'shot-main' });
  await dragReference(h, 'shot-main', 'shot-third');
  h.project.assets.push({ id: 'newly-generated', kind: 'video', name: '后来完成.mp4', source: 'model', sceneId: 'scene-main' });
  h.project.scenes[0].videoAssetId = 'newly-generated'; h.canvas.render({ force: true });
  assert.equal(target.references[0].assetId, 'generated-second');
  assert.equal(h.project.scenes[2].references[0].assetId, 'generated-first');
  assert.equal(target.promptMentions[0].missing, false);
  assert.equal(h.project.graph.nodes.length, nodeCount); assert.deepEqual(h.generated, []);
});

test('分镜输出连线的断开、撤销重做保留用途、链接和当前引用，不影响另一个分镜及任务', async t => {
  const h = canvasHarness(t, directSceneFixture());
  await dragReference(h, 'shot-main', 'shot-other');
  await dragReference(h, 'shot-main', 'shot-third');
  const target = h.project.scenes[1], third = structuredClone(h.project.scenes[2]);
  const { control } = attachReferencePrompt(h, 'shot-other');
  await inputPrompt(h, control, '延续@视频1的场景。'); control.blur();
  target.references[0].note = '延续人物和镜头运动'; target.references[0].publicUrl = 'https://media.example.org/source.mp4';
  h.state.jobs.push({ id: 'kept-task', sceneId: 'scene-main', state: 'done' });
  const assets = structuredClone(h.project.assets), jobs = structuredClone(h.state.jobs);
  await h.cardAction('shot-other', 'disconnect-reference', { referenceNode: 'shot-main' });
  assert.deepEqual(target.references, []); assert.match(target.videoPrompt, /@视频1（已断开）/);
  assert.deepEqual(h.project.scenes[2], third);
  h.element('#undo-canvas').onclick();
  assert.equal(target.references[0].assetId, 'generated-first'); assert.equal(target.references[0].note, '延续人物和镜头运动');
  assert.equal(target.references[0].publicUrl, 'https://media.example.org/source.mp4');
  assert.equal(target.videoPrompt, '延续@视频1的场景。'); assert.equal(target.promptMentions[0].missing, false);
  h.element('#redo-canvas').onclick(); assert.deepEqual(target.references, []);
  h.element('#undo-canvas').onclick(); assert.equal(target.references[0].assetId, 'generated-first');
  assert.deepEqual(h.project.assets, assets); assert.deepEqual(h.state.jobs, jobs); assert.deepEqual(h.generated, []);
});

test('分镜和素材卡引用相同生成视频时去重；未生成分镜、自身副卡和跨副卡循环不能变成参考', async t => {
  const h = canvasHarness(t, directSceneFixture());
  await dragReference(h, 'shot-main', 'shot-other');
  const material = h.canvas.addAsset(h.project.assets.find(asset => asset.id === 'generated-first'));
  await dragReference(h, material.id, 'shot-other');
  assert.equal(h.project.scenes[1].references.length, 1); assert.equal(h.project.graph.links.length, 1);
  await dragReference(h, 'shot-other', 'shot-third');
  assert.ok(h.messages.some(message => /还没有可用的视频结果/.test(message)));
  h.project.graph.nodes.push(node('main-duplicate', 'video', { sceneId: 'scene-main' })); h.canvas.render();
  await dragReference(h, 'shot-main', 'main-duplicate');
  assert.ok(h.messages.some(message => /自身|循环/.test(message)));
  h.project.assets.push({ id: 'other-generated', kind: 'video', name: '第二分镜.mp4', source: 'model', sceneId: 'scene-other' }); h.canvas.render();
  await dragReference(h, 'shot-other', 'main-duplicate');
  assert.equal(h.project.graph.links.length, 1); assert.deepEqual(h.generated, []);
});

test('所有已有素材、分镜及流程卡首次打开统一尺寸，新建卡片一致，保存后不反复覆盖手动调整', async t => {
  const project = directSceneFixture();
  project.graph.nodes.push(node('old-audio', 'audio', { width: 340, height: 250 }), node('old-note', 'text', { width: 320, height: 290 }));
  const positions = project.graph.nodes.map(item => [item.x, item.y]);
  const h = canvasHarness(t, project);
  assert.ok(h.project.graph.nodes.every(item => item.width === 320 && item.height === 260));
  assert.deepEqual(h.project.graph.nodes.map(item => [item.x, item.y]), positions);
  assert.equal(h.project.graph.cardSizeVersion, 1); assert.ok(h.marked.includes('graph'));
  await h.cardAction('old-note', 'from-text'); h.canvas.addAsset(project.assets[0]);
  assert.ok(h.project.graph.nodes.every(item => item.width === 320 && item.height === 260));
  project.graph.nodes[0].width = 410; project.graph.nodes[0].height = 350; h.marked.length = 0;
  h.canvas.render(); assert.equal(project.graph.nodes[0].width, 410); assert.equal(project.graph.nodes[0].height, 350);
  assert.deepEqual(h.marked, []); assert.equal(validateGraph(project.graph).cardSizeVersion, 1);
});


function snapFixture(viewport = {x:0,y:0,zoom:1}) {
  const project = referenceCanvasFixture();
  project.graph.cardSizeVersion = 1;
  project.graph.nodes = project.graph.nodes.filter(item => ['image-a','shot-main','shot-other'].includes(item.id));
  Object.assign(project.graph.nodes.find(item => item.id === 'image-a'),{x:30,y:60,width:320,height:260});
  Object.assign(project.graph.nodes.find(item => item.id === 'shot-main'),{x:500,y:100,width:320,height:260});
  Object.assign(project.graph.nodes.find(item => item.id === 'shot-other'),{x:500,y:400,width:320,height:260});
  project.graph.viewport = viewport;
  return project;
}
function snapDrag(h) {
  const source = h.cardFor('image-a'), port = h.makeElement('button');
  port.dataset.port = 'output'; source.append(port);
  h.document.hitTarget = null;
  return (type,x,y) => h.dispatch(port,type,{button:0,pointerId:31,pointerType:'mouse',clientX:x,clientY:y,shiftKey:false});
}

test('目标边缘 24 屏幕像素内吸附到中点，附近空白释放可连接且不申请生成', async t => {
  const h = canvasHarness(t,snapFixture()), pointer = snapDrag(h);
  const assets = structuredClone(h.project.assets);
  await pointer('pointerdown',350,190);
  await pointer('pointermove',476,160);
  assert.equal(h.cardFor('shot-main').classList.contains('connection-snap'),true);
  assert.match(h.element('#selection-note').textContent,/已吸附/);
  const preview = h.element('#connections').innerHTML;
  assert.match(preview,/canvas-connection-preview snapped/);
  assert.match(preview,/M 350 190 C .* 500 230/,'预览起止点按两张卡片高度居中');
  await pointer('pointerup',476,160);
  assert.deepEqual(h.project.graph.links.map(link => [link.from,link.to]),[['image-a','shot-main']]);
  assert.equal(h.project.scenes[0].references[0].assetId,'asset-image-a');
  assert.match(h.element('#connections').innerHTML,/M 350 190 C .* 500 230/,'保存连线保持中点');
  assert.equal(h.cardFor('shot-main').classList.contains('connection-snap'),false);
  assert.deepEqual(h.project.assets,assets); assert.deepEqual(h.state.jobs,[]); assert.deepEqual(h.generated,[]);
});

test('离开吸附范围立即清理高亮，释放位置移远不能沿用旧目标', async t => {
  const h = canvasHarness(t,snapFixture()), pointer = snapDrag(h);
  await pointer('pointerdown',350,190); await pointer('pointermove',480,160);
  assert.equal(h.cardFor('shot-main').classList.contains('connection-snap'),true);
  await pointer('pointermove',475,160);
  assert.equal(h.cardFor('shot-main').classList.contains('connection-snap'),false);
  assert.doesNotMatch(h.element('#selection-note').textContent,/已吸附/);
  await pointer('pointermove',480,160);
  assert.equal(h.cardFor('shot-main').classList.contains('connection-snap'),true);
  await pointer('pointerup',430,160);
  assert.deepEqual(h.project.graph.links,[]); assert.deepEqual(h.project.scenes[0].references,[]);
  assert.equal(h.element('#connections').innerHTML.includes('canvas-connection-preview'),false);
});

test('多个附近卡片选择最近有效目标，直接命中无效卡片不会连接背后分镜', async t => {
  const project = snapFixture();
  Object.assign(project.graph.nodes.find(item => item.id === 'shot-other'),{x:500,y:380});
  const h = canvasHarness(t,project), pointer = snapDrag(h);
  await pointer('pointerdown',350,190); await pointer('pointermove',495,374);
  assert.equal(h.cardFor('shot-other').classList.contains('connection-snap'),true);
  assert.equal(h.cardFor('shot-main').classList.contains('connection-snap'),false);
  // Direct hit on a forbidden destination owns the pointer, even near a valid shot.
  const blocker = node('blocked','audio',{x:490,y:365,width:30,height:30});
  project.graph.nodes.push(blocker); h.canvas.render();
  h.document.hitTarget = h.cardFor('blocked');
  await pointer('pointermove',495,374);
  assert.equal(h.cardFor('shot-other').classList.contains('connection-snap'),false);
  await pointer('pointerup',495,374);
  assert.deepEqual(project.graph.links,[]); assert.match(h.messages.at(-1),/类型不匹配/);
});

test('平移缩放后吸附仍为 24 屏幕像素，调整卡片尺寸后预览和保存端点保持居中', async t => {
  const project = snapFixture({x:50,y:30,zoom:0.5});
  Object.assign(project.graph.nodes.find(item => item.id === 'shot-main'),{width:420,height:400});
  const h = canvasHarness(t,project), pointer = snapDrag(h);
  await pointer('pointerdown',225,125); await pointer('pointermove',275,100);
  assert.equal(h.cardFor('shot-main').classList.contains('connection-snap'),false);
  await pointer('pointermove',276,100);
  assert.equal(h.cardFor('shot-main').classList.contains('connection-snap'),true);
  assert.match(h.element('#connections').innerHTML,/M 225 125 C .* 300 180/);
  await pointer('pointerup',276,100);
  assert.equal(project.graph.links[0].to,'shot-main');
  Object.assign(project.graph.nodes.find(item => item.id === 'shot-main'),{height:520}); h.canvas.render();
  assert.match(h.element('#connections').innerHTML,/M 225 125 C .* 300 210/);
});

test('已有参考、来源自身、画布工具和画布外不吸附，也不新增参考', async t => {
  const project = snapFixture(); project.graph.links.push({id:'existing',from:'image-a',to:'shot-main'});
  const h = canvasHarness(t,project), pointer = snapDrag(h), before = structuredClone(project);
  await pointer('pointerdown',350,190); await pointer('pointermove',480,160);
  assert.equal(h.cardFor('shot-main').classList.contains('connection-snap'),false);
  h.document.hitTarget = h.cardFor('image-a'); await pointer('pointermove',495,410);
  assert.equal(h.cardFor('shot-other').classList.contains('connection-snap'),false);
  const toolbar = h.makeElement('div'); toolbar.className = 'canvas-creation-toolbar';
  h.document.hitTarget = toolbar; await pointer('pointermove',495,410);
  assert.equal(h.cardFor('shot-other').classList.contains('connection-snap'),false);
  h.document.hitTarget = null; await pointer('pointermove',-1,410); await pointer('pointerup',-1,410);
  assert.deepEqual(project,before); assert.deepEqual(h.generated,[]);
});

test('吸附后取消拖动、丢失捕获或按 Esc 均清除高亮预览和捕获且不连接', async t => {
  const h = canvasHarness(t,snapFixture()), pointer = snapDrag(h);
  for (const release of ['pointercancel','lostpointercapture','Escape']) {
    await pointer('pointerdown',350,190); await pointer('pointermove',480,160);
    assert.equal(h.cardFor('shot-main').classList.contains('connection-snap'),true);
    if (release === 'Escape') await h.keyboard('Escape',{ctrlKey:false});
    else await pointer(release,480,160);
    assert.equal(h.cardFor('shot-main').classList.contains('connection-snap'),false);
    assert.equal(h.element('#connections').innerHTML.includes('canvas-connection-preview'),false);
    assert.equal(h.element('#canvas-viewport').hasPointerCapture(31),false);
    assert.equal(h.canvas.busy(),false); assert.deepEqual(h.project.graph.links,[]);
  }
});


function imageReferenceFixture(model = 'gpt-image-2.5-flare') {
  const assets = ['one','two','three','four'].map((id,index) => ({id:'image-'+id,kind:'image',name:['人物.png','场景.png','服装.png','光线.png'][index]}));
  return {id:'image-reference-project',scenes:[],assets,graph:graph([
    node('generated-image','image',{role:'image-generation',assetId:'image-one',imageConfig:normalizeImageConfig({model,prompt:'人物参考'})}),
    ...['two','three','four'].map(id => node('source-'+id,'image',{assetId:'image-'+id})),
    node('image-target','image',{label:'融合画面',role:'image-generation',imageConfig:normalizeImageConfig({model,prompt:'保留人物，参考场景'})}),
    node('empty-image','image',{role:'image-generation',imageConfig:normalizeImageConfig({model,prompt:'未生成'})}),
  ])};
}
const imageLineLabels = h => [...h.element('#connections').innerHTML.matchAll(/<text\b[^>]*>(图片\d+)<\/text>/g)].map(match => match[1]);
const imageRows = card => [...card.innerHTML.matchAll(/title="(图片\d+)：([^"]*)"/g)].map(match => [match[1],match[2]]);

test('图片生成卡片批量候选可预览并显式选定最终素材', async t => {
  const model = 'gpt-image-2.5-flare';
  const nodeId = 'image-batch-card';
  const jobs = [1, 2, 3].map(index => ({ id:`image-job-${index}`, projectId:'image-batch-project', nodeId,
    state:'done', assetId:`image-candidate-${index}`, batchId:'image-batch', variantIndex:index, count:3,
    model, prompt:'批量候选', createdAt:`2026-10-10T00:00:0${index}.000Z`, message:'图片已保存' }));
  const project = { id:'image-batch-project', scenes:[], assets:[1,2,3].map(index => ({
    id:`image-candidate-${index}`, kind:'image', source:'model', nodeId, batchId:'image-batch', variantIndex:index,
    name:`候选 ${index}.png`, createdAt:`2026-10-10T00:00:0${index}.000Z` })), graph:graph([node(nodeId,'image',{
      role:'image-generation', imageJobId:'image-job-3', imageJobIds:jobs.map(job => job.id), assetId:'image-candidate-3',
      imageConfig:normalizeImageConfig({model,prompt:'批量候选',count:3}) })])};
  const h = canvasHarness(t, project);
  h.state.settings.image = { hasKey:true, imageModel:model };
  h.state.imageCatalog = [{ name:model }]; h.state.imageJobs = jobs;
  h.canvas.render();
  const card = h.cardFor(nodeId);
  assert.match(card.innerHTML, /候选图片 · 3/);
  assert.match(card.innerHTML, /设为最终素材/);
  assert.equal(project.graph.nodes[0].assetId, 'image-candidate-3', '初始候选只是默认当前素材');
  assert.equal(project.graph.nodes[0].selectedAssetId || '', '', '没有点击确认前不应产生显式选片');

  const preview = { value:'image-candidate-2', dataset:{previewCandidate:''}, matches: selector => selector === '[data-preview-candidate]',
    closest: () => card };
  await h.element('#nodes').fire('change', { target:preview });
  assert.equal(card.dataset.previewAsset, 'image-candidate-2');
  assert.equal(project.graph.nodes[0].assetId, 'image-candidate-3', '切换预览不能直接改最终素材');
  assert.equal(project.graph.nodes[0].selectedAssetId || '', '', '切换预览不能直接写入选片状态');
  await h.cardAction(nodeId, 'select-image-candidate', { assetId:'image-candidate-2' });
  assert.deepEqual(h.selectedImages, [[nodeId, 'image-candidate-2']]);
  assert.equal(project.graph.nodes[0].selectedAssetId, 'image-candidate-2');
  assert.equal(project.graph.nodes[0].assetId, 'image-candidate-2');
});

test('生图提示词输入 @ 会按连线顺序列出参考图片并可插入，断线后菜单重新编号', async t => {
  const h = canvasHarness(t,imageReferenceFixture());
  await dragReference(h,'generated-image','image-target');
  await dragReference(h,'source-two','image-target');
  let {control,menu,node} = attachImageReferencePrompt(h);
  await inputPrompt(h,control,'参考@');
  assert.equal(menu.hidden,false); assert.equal(control.getAttribute('aria-expanded'),'true');
  assert.deepEqual(menu.querySelectorAll('[data-mention-index]').map(option => option.textContent),
    ['▧@图片1人物.png','▧@图片2场景.png']);
  await promptKey(h,control,'ArrowDown');
  const inserted = await promptKey(h,control,'Enter');
  assert.equal(inserted.defaultPrevented,true); assert.equal(inserted.propagationStopped,true);
  assert.equal(node.imageConfig.prompt,'参考@图片2'); assert.equal(control.value,node.imageConfig.prompt);
  assert.equal(control.selectionStart,6); assert.equal(control.selectionEnd,6); assert.equal(menu.hidden,true);
  control.blur();

  const firstLink = h.project.graph.links.find(link => link.from === 'generated-image' && link.to === 'image-target');
  await h.cardAction('image-target','image-disconnect',{linkId:firstLink.id});
  ({control,menu,node} = attachImageReferencePrompt(h));
  await inputPrompt(h,control,'@');
  assert.deepEqual(menu.querySelectorAll('[data-mention-index]').map(option => option.textContent),['▧@图片1场景.png']);
  assert.equal(node.imageConfig.prompt,'@');
  assert.deepEqual(h.generated,[],'选择引用不得提交收费生成');
});

test('生图提示词没有连接图片时输入 @ 显示清晰空态', async t => {
  const h = canvasHarness(t,imageReferenceFixture()), {control,menu} = attachImageReferencePrompt(h);
  await inputPrompt(h,control,'@');
  assert.equal(menu.hidden,false); assert.match(menu.innerHTML,/先为当前生成项添加参考素材/);
  assert.equal(menu.querySelectorAll('[data-mention-index]').length,0);
  assert.deepEqual(h.generated,[]);
});

test('已生成图片连到生图卡片：连线与参考清单按连接顺序编号，生成快照持久保留', async t => {
  const h = canvasHarness(t,imageReferenceFixture()), assets = structuredClone(h.project.assets);
  await dragReference(h,'generated-image','image-target');
  await dragReference(h,'source-two','image-target');
  assert.deepEqual(imageLineLabels(h),['图片1','图片2']);
  assert.deepEqual(imageRows(h.cardFor('image-target')),[['图片1','人物.png'],['图片2','场景.png']]);
  assert.deepEqual(resolveImageInputs(h.project,h.project.graph.nodes.find(n => n.id === 'image-target')).references.map(r => r.assetId),['image-one','image-two']);
  assert.deepEqual(h.project.graph.links[0].reference,{assetId:'image-one',kind:'image',name:'人物.png'});
  assert.match(h.messages.at(-1),/图片2已连接/);
  h.project.assets.push({id:'image-new',kind:'image',name:'人物重新生成.png'});
  h.project.graph.nodes.find(n => n.id === 'generated-image').assetId = 'image-new';
  h.canvas.render({force:true});
  assert.equal(resolveImageInputs(h.project,h.project.graph.nodes.find(n => n.id === 'image-target')).references[0].assetId,'image-one');
  assert.equal(validateGraph(h.project.graph).links[0].reference.assetId,'image-one');
  assert.deepEqual(h.project.assets.slice(0,assets.length),assets);
  assert.deepEqual(h.generated,[],'连线不得提交收费生成');
});

test('生图断线和重连后重新编号，撤销和重做恢复原图片及连接顺序', async t => {
  const h = canvasHarness(t,imageReferenceFixture());
  await dragReference(h,'generated-image','image-target');
  await dragReference(h,'source-two','image-target');
  const links = structuredClone(h.project.graph.links);
  await h.cardAction('image-target','image-disconnect',{linkId:links[0].id});
  assert.deepEqual(imageRows(h.cardFor('image-target')),[['图片1','场景.png']]);
  assert.deepEqual(imageLineLabels(h),['图片1']);
  h.element('#undo-canvas').onclick();
  assert.deepEqual(h.project.graph.links,links); assert.deepEqual(imageLineLabels(h),['图片1','图片2']);
  h.element('#redo-canvas').onclick();
  await dragReference(h,'generated-image','image-target');
  assert.deepEqual(imageRows(h.cardFor('image-target')),[['图片1','场景.png'],['图片2','人物.png']]);
  assert.deepEqual(resolveImageInputs(h.project,h.project.graph.nodes.find(n=>n.id==='image-target')).references.map(r=>r.assetId),['image-two','image-one']);
});

for (const model of ['grok-imagine-image','gemini-2.5-flash-image']) {
  test(model + ' 的生图连线最多接入三张参考，重复素材和未生成图片被拦截', async t => {
    const h = canvasHarness(t,imageReferenceFixture(model));
    await dragReference(h,'generated-image','image-target');
    await dragReference(h,'source-two','image-target');
    await dragReference(h,'source-three','image-target');
    assert.deepEqual(imageLineLabels(h),['图片1','图片2','图片3']);
    await dragReference(h,'source-four','image-target');
    assert.equal(h.project.graph.links.length,3); assert.match(h.messages.at(-1),/最多支持 3 张/);
    await dragReference(h,'empty-image','image-target');
    assert.equal(h.project.graph.links.length,3); assert.match(h.messages.at(-1),/还没有保存好的图片/);
    h.project.graph.nodes.push(node('duplicate-source','image',{assetId:h.project.assets[1].id})); h.canvas.render({force:true});
    await dragReference(h,'duplicate-source','image-target');
    assert.equal(h.project.graph.links.length,3); assert.match(h.messages.at(-1),/已连接/);
    assert.deepEqual(h.generated,[]);
  });
}

test('参考这张图继续生图快捷按钮会新建卡片、保存图片快照并显示图片1', async t => {
  const h = canvasHarness(t,imageReferenceFixture());
  h.state.settings.image = {imageModel:'gpt-image-2.5-flare'};
  const count=h.project.graph.nodes.length;
  await h.cardAction('generated-image','image-create-next');
  const target=h.project.graph.nodes.at(-1), link=h.project.graph.links.at(-1);
  assert.equal(h.project.graph.nodes.length,count+1); assert.equal(target.role,'image-generation');
  assert.equal(link.to,target.id); assert.equal(link.reference.assetId,'image-one');
  assert.deepEqual(imageLineLabels(h),['图片1']);
  assert.deepEqual(resolveImageInputs(h.project,target).references.map(r=>r.assetId),['image-one']);
  assert.deepEqual(h.generated,[]);
});
