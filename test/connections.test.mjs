import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server.mjs';
import { createProject } from '../lib/workflow.mjs';
test('连接中心：多个令牌按模型路由、验证、冲突和公开脱敏', async t => {
 const root = await mkdtemp(path.join(os.tmpdir(),'jingce-connections-'));
 const seen=[];
 const app=await createStudio({root,catalog:[],imageCatalog:[],textCatalog:[],tools:{ready:false},textFetcher:async(url,opts)=>{
  seen.push(opts.headers.Authorization);
  return new Response(JSON.stringify(url.endsWith('/models') ? {data:[{id:'text-a'},{id:'text-b'}]} : {choices:[{message:{content:'ok'},finish_reason:'stop'}]}),{status:200});
 }});
 const url=await app.start(0);
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const boot=await(await fetch(url+'/api/bootstrap')).json();
 const send=(route,method='GET',body)=>fetch(url+route,{method,headers:{'Content-Type':'application/json','X-Studio-Token':boot.token},body:body===undefined?undefined:JSON.stringify(body)});
 for(const [model,key] of [['text-a','secret-A'],['text-b','secret-B']]){
  const response=await send('/api/connections','PUT',{name:model,kind:'text',models:[model],apiKey:key});assert.equal(response.status,200);assert.ok(!(await response.text()).includes(key));
 }
 const list=await(await send('/api/connections')).json();assert.equal(list.length,2);assert.ok(!JSON.stringify(list).includes('secret-'));
 for(const model of ['text-a','text-b'])assert.equal((await send('/api/text-chat','POST',{model,messages:[{role:'user',content:'hello'}]})).status,200);
 assert.deepEqual(seen,['Bearer secret-A','Bearer secret-B']);
 assert.equal((await send('/api/connections','PUT',{kind:'text',models:['text-a'],apiKey:'conflict'})).status,409);
 assert.equal((await send('/api/connections/'+list[0].id+'/check','POST',{})).status,200);
 const tokenModels = await (await send('/api/connections/'+list[0].id+'/models')).json();
 assert.deepEqual(tokenModels.map(item=>item.name),['text-a','text-b']);
 assert.equal(seen.at(-1),'Bearer secret-A');
 assert.ok(!JSON.stringify(tokenModels).includes('secret-'));
 assert.ok(!(await(await send('/api/bootstrap')).text()).includes('secret-'));
 assert.equal((await send('/api/connections/'+list[0].id,'DELETE')).status,200);
 assert.equal((await send('/api/text-chat','POST',{model:'text-a',messages:[{role:'user',content:'hello'}]})).status,400);
});

async function connectionApp(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-delete-connections-'));
  const app = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false }, ...options });
  const url = await app.start(0);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await (await fetch(url + '/api/bootstrap')).json();
  const send = (route, method = 'GET', body) => fetch(url + route, {
    method, headers: { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { app, url, send };
}

test('连接中心：绑定接口不冒充原有配置，删除原配置仅清除对应令牌', async t => {
  const { app, url, send } = await connectionApp(t);
  for (const kind of ['video', 'image', 'text']) {
    assert.equal((await send('/api/connections', 'PUT', { name: kind, kind, models: [kind + '-bound'], apiKey: kind + '-bound-key' })).status, 200);
  }
  assert.deepEqual(await (await send('/api/existing-connections')).json(), []);
  await app.store.saveSettings({ ...await app.store.settings(), apiKey: 'video-default-key', baseUrl: 'https://direct.beibeihai.xyz' });
  await app.store.saveImageSettings({ ...await app.store.imageSettings(), apiKey: 'image-default-key' });
  await app.store.saveTextSettings({ ...await app.store.textSettings(), apiKey: 'text-default-key', textModel: 'text-default' });
  const existing = await (await send('/api/existing-connections')).json();
  assert.deepEqual(existing.map(item => item.kind), ['video', 'image', 'text']);
  assert.equal(existing[0].baseUrl, 'https://direct.beibeihai.xyz');
  assert.ok(!JSON.stringify(existing).includes('-key'));

  const project = createProject({ title: '保留工程' });
  await app.store.mutate(state => { state.projects.push(project); });
  for (const kind of ['image', 'text', 'video']) {
    assert.equal((await fetch(url + '/api/existing-connections/' + kind, { method: 'DELETE' })).status, 403);
    assert.equal((await send('/api/existing-connections/' + kind, 'DELETE')).status, 200);
    const settings = kind === 'video' ? await app.store.settings() : kind === 'image' ? await app.store.imageSettings() : await app.store.textSettings();
    assert.equal(settings.apiKey, '');
    assert.equal((await app.store.connections()).length, 3);
    assert.deepEqual(app.store.get(project.id), project);
    const bootstrap = await (await send('/api/bootstrap')).json();
    assert.equal(kind === 'video' ? bootstrap.settings.hasKey : bootstrap.settings[kind].hasKey, true, '其余绑定接口仍可使用');
    assert.ok(!JSON.stringify(bootstrap).includes('-key'));
  }
  assert.deepEqual(await (await send('/api/existing-connections')).json(), []);
  assert.equal((await app.store.textSettings()).textModel, '');
});

test('连接中心：删除后清除失效的语言模型目录，其余接口的模型和令牌保留', async t => {
  const { app, send } = await connectionApp(t, { textCatalog: [{ name: 'text-a' }, { name: 'text-b' }] });
  const items = [];
  for (const model of ['text-a', 'text-b']) {
    items.push(await (await send('/api/connections', 'PUT', { name: model, kind: 'text', models: [model], apiKey: model + '-key' })).json());
  }
  assert.equal((await send('/api/connections/' + items[0].id, 'DELETE')).status, 200);
  let bootstrap = await (await send('/api/bootstrap')).json();
  assert.deepEqual(bootstrap.textCatalog.map(model => model.name), ['text-b']);
  assert.equal(bootstrap.settings.text.hasKey, true);
  assert.equal((await app.store.connections())[0].apiKey, 'text-b-key');
  assert.equal((await send('/api/connections/' + items[1].id, 'DELETE')).status, 200);
  bootstrap = await (await send('/api/bootstrap')).json();
  assert.deepEqual(bootstrap.textCatalog, []);
  assert.equal(bootstrap.settings.text.hasKey, false);
  assert.deepEqual(await app.store.connections(), []);
});

test('连接中心：删除默认视频连接保留旧任务连接和已有记录，清空视频目录', async t => {
  let modelReads = 0;
  const { app, send } = await connectionApp(t, { catalog: undefined, videoFetcher: async () => {
    modelReads += 1;
    return new Response(JSON.stringify({ data: [{ id: 'seedance-2.0-fast-933-720P（次）' }] }), { status: 200 });
  } });
  await app.store.saveSettings({ ...await app.store.settings(), apiKey: 'old-video-key', baseUrl: 'https://direct.beibeihai.xyz' });
  const loaded = await (await send('/api/bootstrap')).json();
  assert.ok(loaded.catalog.length > 0);
  const job = { id: 'old-video-job', state: 'done', model: 'seedance-2.0-fast-933-720P（次）', taskId: 'old-task' };
  await app.store.mutate(state => { state.jobs.push(job); });
  const readsBeforeDeletion = modelReads;
  assert.equal((await send('/api/existing-connections/video', 'DELETE')).status, 200);
  assert.deepEqual(await app.store.videoTaskSettings(job), { apiKey: 'old-video-key', baseUrl: 'https://direct.beibeihai.xyz' });
  assert.deepEqual(app.store.state.jobs, [job]);
  assert.equal((await app.store.settings()).apiKey, '');
  const bootstrap = await (await send('/api/bootstrap')).json();
  assert.equal(bootstrap.settings.hasKey, false);
  assert.deepEqual(bootstrap.catalog, []);
  assert.equal(modelReads, readsBeforeDeletion, '无接口时不发起平台请求');
  assert.ok(!JSON.stringify(bootstrap).includes('old-video-key'));
});

test('连接中心：首次添加三类接口时用未保存令牌读取模型，不保存令牌或提交生成', async t => {
  const calls = [];
  const ids = { image: 'gpt-image-2.5-flare', text: 'language-new', video: 'seedance-2.0-fast-933-720P（次）' };
  const fetcher = kind => async (url, options = {}) => {
    calls.push({ kind, url, method: options.method || 'GET', auth: options.headers?.Authorization });
    return new Response(JSON.stringify(url.endsWith('/model-plaza') ? {} : { data: [{ id: ids[kind] }] }), { status: 200 });
  };
  const { app, send } = await connectionApp(t, { imageFetcher: fetcher('image'), textFetcher: fetcher('text'), videoFetcher: fetcher('video') });
  const before = JSON.stringify(app.store.state);
  for (const kind of ['image', 'text', 'video']) {
    const response = await send('/api/connections/models', 'POST', { kind, apiKey: kind + '-draft-secret' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.catalog.map(model => model.name), [ids[kind]]);
    assert.ok(!JSON.stringify(result).includes('-draft-secret'));
    assert.equal(calls.find(call => call.kind === kind && call.url.endsWith('/models')).auth, 'Bearer ' + kind + '-draft-secret');
  }
  assert.ok(calls.every(call => call.method === 'GET'), '上游只收到目录 GET');
  assert.deepEqual(await app.store.connections(), []);
  assert.equal(JSON.stringify(app.store.state), before);
  await assert.rejects(readFile(path.join(app.store.root, 'connections.private.json')), { code: 'ENOENT' });
});

test('连接中心：读取目录需要本机授权和有效输入，编辑时可复用保存令牌而不回显', async t => {
  const calls = [];
  const { app, url, send } = await connectionApp(t, { textFetcher: async (url, options) => {
    calls.push({ url, auth: options.headers.Authorization });
    return new Response(JSON.stringify({ data: [{ id: 'text-new' }] }), { status: 200 });
  } });
  const input = { kind: 'text', apiKey: 'private-saved-text-key' };
  assert.equal((await fetch(url + '/api/connections/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 403);
  for (const invalid of [{ kind: 'text' }, { kind: 'audio', apiKey: 'key' }, { kind: 'text', apiKey: 'key\nbad' }, { ...input, baseUrl: 'https://other.example' }]) {
    assert.equal((await send('/api/connections/models', 'POST', invalid)).status, 400);
  }
  assert.equal(calls.length, 0);
  const saved = await (await send('/api/connections', 'PUT', { ...input, models: ['text-new'] })).json();
  const before = await readFile(path.join(app.store.root, 'connections.private.json'), 'utf8');
  const response = await send('/api/connections/models', 'POST', { id: saved.id, kind: 'text', apiKey: '' });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(!body.includes(input.apiKey));
  assert.deepEqual(JSON.parse(body).catalog.map(model => model.name), ['text-new']);
  assert.equal(calls[0].auth, 'Bearer ' + input.apiKey);
  assert.equal(await readFile(path.join(app.store.root, 'connections.private.json'), 'utf8'), before);
});

test('连接中心：读取目录对返回记录和平台错误中的原始或编码密钥脱敏', async t => {
  const secret = 'credential/+private';
  let fail = false;
  const { send } = await connectionApp(t, { imageFetcher: async () => new Response(JSON.stringify(fail
    ? { error: { message: secret + ' ' + encodeURIComponent(secret) } }
    : { data: [{ id: 'gpt-image-2.5-flare' }, { id: secret }, { id: encodeURIComponent(secret) }] }), { status: fail ? 401 : 200 }) });
  for (const failure of [false, true]) {
    fail = failure;
    const response = await send('/api/connections/models', 'POST', { kind: 'image', apiKey: secret });
    assert.equal(response.status, failure ? 401 : 200);
    const body = await response.text();
    assert.ok(!body.includes(secret)); assert.ok(!body.includes(encodeURIComponent(secret)));
    if (!failure) assert.deepEqual(JSON.parse(body).catalog.map(model => model.name), ['gpt-image-2.5-flare']);
  }
});

test('连接中心：保存后按类型刷新使首次语言模型和视频模型立即进入创作目录', async t => {
  const textCalls = [], videoCalls = [];
  const videoModel = 'seedance-2.0-fast-933-720P（次）';
  const { send } = await connectionApp(t, { catalog: undefined,
    textFetcher: async (url, options) => {
      textCalls.push({ url, method: options.method || 'GET' });
      return new Response(JSON.stringify({ data: [{ id: 'language-first' }, { id: 'language-unbound' }] }), { status: 200 });
    }, videoFetcher: async (url, options = {}) => {
      videoCalls.push({ url, method: options.method || 'GET' });
      return new Response(JSON.stringify(url.endsWith('/model-plaza') ? {} : { data: [{ id: videoModel }] }), { status: 200 });
    } });
  await send('/api/connections', 'PUT', { kind: 'text', apiKey: 'first-language-key', models: ['language-first'] });
  const refresh = await (await send('/api/connections/refresh', 'POST', { kind: 'text' })).json();
  assert.equal(refresh.message, '模型目录已刷新。');
  let bootstrap = await (await send('/api/bootstrap')).json();
  assert.deepEqual(bootstrap.textCatalog.map(model => model.name), ['language-first']);
  assert.equal(bootstrap.settings.text.hasKey, true);
  assert.equal(videoCalls.length, 0, '语言刷新不访问未配置的视频接口');
  await send('/api/connections', 'PUT', { kind: 'video', apiKey: 'first-video-key', models: [videoModel] });
  const textReads = textCalls.length;
  await send('/api/connections/refresh', 'POST', { kind: 'video' });
  bootstrap = await (await send('/api/bootstrap')).json();
  assert.deepEqual(bootstrap.catalog.map(model => model.name), [videoModel]);
  assert.equal(bootstrap.settings.hasKey, true);
  assert.equal(textCalls.length, textReads, '视频刷新不重复查询语言接口');
  assert.ok([...textCalls, ...videoCalls].every(call => call.method === 'GET'));
});
