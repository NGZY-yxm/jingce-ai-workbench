import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createPrevisWorkflow } from '../public/previs.js';
import { defaultPrevisSpec, parsePrevisSpec } from '../public/previs-spec.js';

// A small DOM adapter drives the actual workflow handlers without a browser dependency.
class Element {
  constructor(id) {
    this.id = id; this.value = ''; this.textContent = ''; this.disabled = false; this.hidden = false;
    this.checked = false; this.options = []; this.handlers = new Map(); this.markup = '';
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  set innerHTML(value) {
    this.markup = value;
    if (this.id.endsWith('select') || this.id.endsWith('model')) {
      this.options = [...value.matchAll(/<option value="([^"]*)"/g)].map(match => ({ value: match[1] }));
      if (!this.options.some(option => option.value === this.value)) this.value = this.options[0]?.value || '';
    }
  }
  get innerHTML() { return this.markup; }
  addEventListener(name, handler) {
    const handlers = this.handlers.get(name) || []; handlers.push(handler); this.handlers.set(name, handlers);
  }
  fire(name) { for (const handler of this.handlers.get(name) || []) handler({ preventDefault() {}, target: this }); }
  focus() { this.focused = true; }
  scrollIntoView() {}
}
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
async function until(check) {
  const deadline = Date.now() + 1500;
  while (!check()) { if (Date.now() > deadline) throw new Error('Workflow did not settle'); await delay(1); }
}
function fixture(t, saved = new Map()) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key),
  } });
  t.after(() => original ? Object.defineProperty(globalThis, 'localStorage', original) : delete globalThis.localStorage);
  const elements = new Map([...html.matchAll(/id="(previs-[^"]+)"/g)].map(match => [match[1], new Element(match[1])]));
  const get = id => elements.get(id);
  for (const [key, value] of Object.entries({ duration: '8', fps: '24', ratio: '16:9', resolution: '360' })) get('previs-' + key).value = value;
  const state = { project: { id: 'project-a', assets: [] }, settings: { text: { hasKey: true, textModel: 'mock-model' } }, textCatalog: [{ name: 'mock-model' }] };
  const requests = [], replies = [], notices = [];
  const workflow = createPrevisWorkflow({ document: { querySelector: selector => elements.get(selector.slice(1)) },
    getState: () => state, flush: async () => {}, toast: (message, error) => notices.push({ message, error }),
    onProjectUpdate: async () => {}, onUseVideo: async () => {}, onPlaceAsset: async () => {},
    api: async (route, method, body) => {
      requests.push({ route, method, body });
      if (route === '/api/text-chat') {
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        if (typeof reply === 'function') return reply();
        return { content: typeof reply === 'string' ? reply : JSON.stringify(reply) };
      }
      if (route === '/api/previs/validate') return { spec: body.spec };
      throw new Error('Unexpected API route: ' + route);
    } });
  workflow.render();
  const edit = (id, value, event = 'input') => { get(id).value = value; get(id).fire(event); };
  const settled = () => until(() => !get('previs-load-example').disabled);
  const send = async feedback => { edit('previs-chat-input', feedback); get('previs-chat-form').fire('submit'); await settled(); };
  const click = async id => { get(id).fire('click'); await settled(); };
  const draft = id => JSON.parse(saved.get('jingce-previs-draft:' + (id || state.project.id)) || '{}');
  return { get, state, requests, replies, saved, workflow, edit, settled, send, click, draft, notices };
}
const sceneReply = (name = '街道相遇') => ({ reply: '已整理人物和镜头，请检查后应用。', scene_spec: { ...defaultPrevisSpec(), name } });

test('单一聊天从故事创建场景，确认前不覆盖编辑或渲染，应用前保留版本', async t => {
  const f = fixture(t), before = f.get('previs-spec').value;
  assert.equal(f.get('previs-ai-draft'), undefined);
  f.replies.push(sceneReply()); await f.send('两人在街道相遇，镜头由远及近。');
  assert.equal(f.get('previs-spec').value, before);
  assert.equal(f.get('previs-chat-proposal').hidden, false);
  assert.match(f.requests[0].body.messages.at(-1).content, /尚未建立场景/);
  assert.match(f.draft().story, /街道相遇/);
  await f.click('previs-chat-apply');
  assert.equal(parsePrevisSpec(f.get('previs-spec').value).name, '街道相遇');
  assert.equal(f.draft().chatVersions[0].json, before);
  assert.equal(f.requests.filter(request => request.route !== '/api/text-chat').length, 0);
});

test('JSON 语法错误仍可发送修复，原文与检查错误随请求发送，修复后保留坏版本', async t => {
  const f = fixture(t), broken = '{"name":"用户手动编辑",';
  f.edit('previs-spec', broken); await f.click('previs-validate');
  assert.match(f.get('previs-validation-status').textContent, /JSON 无法解析/);
  assert.equal(f.requests.length, 0);
  await f.click('previs-chat-repair');
  assert.match(f.get('previs-chat-input').value, /修复当前场景/);
  assert.equal(f.requests.length, 0, 'Preparing repair feedback must not call a model.');
  f.replies.push(sceneReply('修复后的场景')); await f.send(f.get('previs-chat-input').value);
  assert.ok(f.requests[0].body.messages.at(-1).content.includes(broken));
  assert.match(f.requests[0].body.messages.at(-1).content, /当前检查错误/);
  assert.equal(f.get('previs-spec').value, broken);
  await f.click('previs-chat-apply');
  assert.equal(parsePrevisSpec(f.get('previs-spec').value).name, '修复后的场景');
  assert.equal(f.draft().chatVersions[0].json, broken);
});

test('失败的模型方案保留原文，刷新后可继续修复，危险文本仅作转义展示', async t => {
  const f = fixture(t), before = f.get('previs-spec').value;
  const bad = sceneReply(); bad.scene_spec.script = '<img src=x onerror=alert(1)>';
  f.replies.push(bad); await f.send('整理这个故事。');
  assert.equal(f.get('previs-spec').value, before);
  assert.equal(f.get('previs-chat-proposal').hidden, true);
  assert.match(f.get('previs-chat-history').innerHTML, /&lt;img/);
  assert.doesNotMatch(f.get('previs-chat-history').innerHTML, /<img src=x/);
  const restored = fixture(t, f.saved);
  assert.equal(restored.get('previs-chat-repair').disabled, false);
  restored.replies.push(sceneReply('修正方案')); await restored.send('修复上一轮不支持的字段。');
  assert.match(JSON.stringify(restored.requests[0].body.messages), /onerror=alert/);
  assert.match(JSON.stringify(restored.requests[0].body.messages), /不支持的字段/);
  await restored.click('previs-chat-apply');
  assert.equal(parsePrevisSpec(restored.get('previs-spec').value).name, '修正方案');
});

test('参数或 JSON 改动后禁止旧方案覆盖；无效编辑的新参数也参与绑定', async t => {
  const f = fixture(t);
  f.edit('previs-spec', '{"broken":');
  f.replies.push(sceneReply()); await f.send('请修复。');
  assert.equal(f.get('previs-chat-apply').disabled, false);
  f.edit('previs-duration', '10', 'change');
  assert.equal(f.get('previs-chat-apply').disabled, true);
  const raw = f.get('previs-spec').value;
  await f.click('previs-chat-apply'); assert.equal(f.get('previs-spec').value, raw);
  assert.match(f.notices.at(-1).message, /场景或故事已改变/);
});

test('请求期间切换工程，迟到回复只保存到原工程，当前工程编辑和对话不受影响', async t => {
  const f = fixture(t);
  let complete;
  f.replies.push(() => new Promise(resolve => { complete = resolve; }));
  f.edit('previs-chat-input', '工程 A 的故事'); f.get('previs-chat-form').fire('submit');
  assert.equal(f.requests.length, 1);
  f.state.project = { id: 'project-b', assets: [] }; f.workflow.render();
  f.edit('previs-story', '工程 B 的故事');
  complete({ content: JSON.stringify(sceneReply('A 的方案')) }); await f.settled();
  assert.equal(f.get('previs-chat-proposal').hidden, true);
  assert.equal(f.get('previs-story').value, '工程 B 的故事');
  assert.equal(f.draft('project-a').chatProposal.json.includes('A 的方案'), true);
  f.state.project = { id: 'project-a', assets: [] }; f.workflow.render();
  assert.equal(f.get('previs-chat-proposal').hidden, false);
  assert.match(f.get('previs-chat-history').innerHTML, /工程 A 的故事/);
});

test('接口失败保留输入且不自动重发；空 JSON 刷新保留并可继续沟通', async t => {
  const f = fixture(t);
  f.edit('previs-spec', '');
  f.replies.push(new Error('模拟网络失败')); await f.send('请修复空白场景。');
  assert.equal(f.requests.length, 1);
  assert.equal(f.get('previs-chat-input').value, '请修复空白场景。');
  const restored = fixture(t, f.saved);
  assert.equal(restored.get('previs-spec').value, '');
  assert.equal(restored.get('previs-chat-repair').disabled, false);
  restored.replies.push(sceneReply()); await restored.send('按照故事重新整理。');
  assert.equal(restored.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(restored.requests[0].body.messages.slice(1, -1)), /请修复空白场景/);
});


test('继续完善待确认修复方案时，同时保留错误编辑框原文与当前检查原因', async t => {
  const f = fixture(t), broken = '{"name":"需要保留的错误原文",';
  f.edit('previs-spec', broken);
  f.replies.push(sceneReply('第一份修复方案')); await f.send('修复场景。');
  f.replies.push(sceneReply('继续完善的方案')); await f.send('先解释哪里少了括号，再把镜头拉近。');
  const context = f.requests[1].body.messages.at(-1).content;
  assert.ok(context.includes(broken));
  assert.match(context, /编辑框检查错误/);
  assert.match(context, /第一份修复方案/);
  assert.equal(f.get('previs-spec').value, broken);
});
