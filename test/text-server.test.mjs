import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server.mjs';

const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('文本 Markdown 模块与本地解析器可通过静态白名单获取', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-text-markdown-http-'));
  const app = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false } });
  const url = await app.start(0);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  for (const route of ['/text-markdown.js', '/marked.js']) {
    const response = await fetch(url + route);
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.ok((await response.text()).length > 0);
  }
});

test('HTTP 语言模型连接保存到独立私有文件，公开响应不回显密钥', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-text-http-'));
  const app = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false } });
  const url = await app.start(0);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
  const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token };
  const send = (route, method = 'GET', body) => fetch(url + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

  const noKey = await send('/api/text-chat', 'POST', { model: 'model-a', messages: [{ role: 'user', content: '你好' }] });
  assert.equal(noKey.status, 400);

  const save = await send('/api/text-settings', 'PUT', { apiKey: 'text-secret-in-http', textModel: 'model-a' });
  assert.equal(save.status, 200);
  assert.match(await readFile(path.join(root, 'text-connection.private.json'), 'utf8'), /text-secret-in-http/);
  assert.doesNotMatch(await save.text(), /text-secret-in-http/);

  const refreshed = await (await send('/api/bootstrap')).text();
  assert.doesNotMatch(refreshed, /text-secret-in-http/);
  assert.match(refreshed, /model-a/);

});

test('HTTP 语言模型失败返回请求编号，并保存脱敏诊断元数据', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-text-error-http-'));
  const app = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [{ name: 'model-a', owner: 'test' }], tools: { ready: false },
    textFetcher: async () => { throw Object.assign(new Error('private socket detail'), { name: 'HeadersTimeoutError', code: 'UND_ERR_HEADERS_TIMEOUT' }); } });
  const url = await app.start(0);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
  const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token };
  const save = await fetch(`${url}/api/text-settings`, { method: 'PUT', headers, body: JSON.stringify({ apiKey: 'text-secret-in-error-test', textModel: 'model-a' }) });
  assert.equal(save.status, 200);
  const response = await fetch(`${url}/api/text-chat`, { method: 'POST', headers, body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: '写一个剧本' }] }) });
  assert.equal(response.status, 504);
  const body = await response.json();
  assert.equal(body.code, 'TEXT_RESPONSE_TIMEOUT');
  assert.match(body.error, /等待语言模型平台回复超时/);
  assert.match(body.error, /请求编号：[a-f0-9]{8}/);
  assert.doesNotMatch(body.error, /private socket detail|text-secret-in-error-test/);
  const audit = JSON.parse(await readFile(path.join(root, 'text-last-request.json'), 'utf8'));
  assert.equal(audit.status, 'error');
  assert.equal(audit.code, 'TEXT_RESPONSE_TIMEOUT');
  assert.equal(audit.model, 'model-a');
  assert.doesNotMatch(JSON.stringify(audit), /写一个剧本|text-secret-in-error-test|private socket detail/);
});

test('HTTP 语言模型成功诊断只记录回复长度，不记录正文', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-text-success-http-'));
  const app = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [{ name: 'model-a', owner: 'test' }], tools: { ready: false },
    textFetcher: async (url) => url.endsWith('/chat/completions')
      ? reply({ choices: [{ message: { role: 'assistant', content: '测试回复' }, finish_reason: 'stop' }] })
      : reply({ data: [{ id: 'model-a' }] }) });
  const url = await app.start(0);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
  const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token };
  const save = await fetch(`${url}/api/text-settings`, { method: 'PUT', headers, body: JSON.stringify({ apiKey: 'text-secret-success-test', textModel: 'model-a' }) });
  assert.equal(save.status, 200);
  const response = await fetch(`${url}/api/text-chat`, { method: 'POST', headers, body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: '你好' }] }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.content, '测试回复');
  const audit = JSON.parse(await readFile(path.join(root, 'text-last-request.json'), 'utf8'));
  assert.equal(audit.status, 'done');
  assert.equal(audit.answerLength, 4);
  assert.doesNotMatch(JSON.stringify(audit), /测试回复|你好|text-secret-success-test/);
});
