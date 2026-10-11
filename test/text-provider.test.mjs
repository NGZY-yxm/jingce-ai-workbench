import test from 'node:test';
import assert from 'node:assert/strict';
import { chatText, checkTextConnection, loadTextCatalog, DEFAULT_TEXT_CONNECTION, TEXT_PLATFORM } from '../lib/text-provider.mjs';

const settings = { ...DEFAULT_TEXT_CONNECTION, apiKey: 'text-secret-key', textModel: 'model-a' };
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('语言模型目录使用 /v1/models，并只返回模型 ID 和归属方', async () => {
  const result = await loadTextCatalog(settings, async (url, options) => {
    assert.equal(url, `${TEXT_PLATFORM}/models`);
    assert.equal(options.headers.Authorization, 'Bearer text-secret-key');
    assert.equal(options.redirect, 'error');
    return reply({ object: 'list', data: [
      { id: 'model-a', owned_by: 'provider', secret: 'should-not-be-exposed' },
      { id: 'model-b' },
      { id: '' },
    ] });
  });
  assert.deepEqual(result, [
    { name: 'model-a', owner: 'provider' },
    { name: 'model-b', owner: '' },
  ]);
});

test('语言模型对话发送最小 Chat Completions 请求并读取回复', async () => {
  const result = await chatText(settings, { model: 'model-a', messages: [
    { role: 'system', content: '你是一个简洁的创作助手。' },
    { role: 'user', content: '请给我一句开场白。' },
  ] }, async (url, options) => {
    assert.equal(url, `${TEXT_PLATFORM}/chat/completions`);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer text-secret-key');
    assert.deepEqual(JSON.parse(options.body), {
      model: 'model-a',
      messages: [
        { role: 'system', content: '你是一个简洁的创作助手。\n\n请直接给出最终结果，不要反问，不要要求用户选择方案，不要调用工具。回复必须包含文本内容；若任务要求 JSON，请严格返回指定格式的 JSON。' },
        { role: 'user', content: '请给我一句开场白。' },
      ],
      stream: false,
    });
    return reply({ choices: [{ message: { role: 'assistant', content: '雨落下来的时候，城市才开始说话。' }, finish_reason: 'stop' }], usage: { total_tokens: 12 } });
  });
  assert.equal(result.content, '雨落下来的时候，城市才开始说话。');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage.totalTokens, 12);
});

test('没有系统消息时统一补充回复要求，并保留 JSON 请求和原始历史', async () => {
  const messages = [{ role: 'user', content: '请只返回 JSON：{"scenes":[]}' }];
  const original = structuredClone(messages);
  await chatText(settings, { messages }, async (url, options) => {
    const sent = JSON.parse(options.body).messages;
    assert.equal(sent[0].role, 'system');
    assert.match(sent[0].content, /不要要求用户选择方案/);
    assert.match(sent[0].content, /若任务要求 JSON，请严格返回指定格式的 JSON/);
    assert.deepEqual(sent.slice(1), original);
    return reply({ choices: [{ message: { content: '{"scenes":[]}' } }] });
  });
  assert.deepEqual(messages, original);
});

test('语言模型错误会脱敏，不接受空消息或不支持的角色', async () => {
  await assert.rejects(chatText(settings, { messages: [{ role: 'tool', content: 'x' }] }, async () => reply({})), /角色/);
  await assert.rejects(chatText(settings, { messages: [{ role: 'user', content: '' }] }, async () => reply({})), /不能为空/);
  await assert.rejects(chatText(settings, { messages: [{ role: 'user', content: 'x' }] }, async () => reply({ error: { message: 'bad text-secret-key' } }, 401)), error => {
    assert.equal(error.status, 401);
    assert.match(error.message, /\[已隐藏密钥\]/);
    assert.doesNotMatch(error.message, /text-secret-key/);
    return true;
  });
});

test('语言模型空白回复不会被当作成功', async () => {
  await assert.rejects(chatText(settings, { model: 'model-a', messages: [{ role: 'user', content: '写一个剧本' }] }, async () => reply({
    choices: [{ message: { role: 'assistant', content: '  \n' }, finish_reason: 'stop' }],
  })), error => {
    assert.equal(error.status, 502);
    assert.equal(error.code, 'TEXT_EMPTY_RESPONSE');
    assert.match(error.message, /空白回复/);
    return true;
  });
});

test('只读连接检查区分已选模型是否在当前目录', async () => {
  const result = await checkTextConnection(settings, async () => reply({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
  assert.equal(result.selectedModelVisible, true);
  assert.equal(result.modelCount, 2);
});

test('文字模型超时给出明确诊断且不暴露原始网络错误', async () => {
  await assert.rejects(chatText(settings, { model: 'model-a', messages: [{ role: 'user', content: '写一个剧本' }] }, async () => {
    throw Object.assign(new Error('socket details should not be shown'), { name: 'TimeoutError', code: 'UND_ERR_HEADERS_TIMEOUT' });
  }), error => {
    assert.equal(error.status, 504);
    assert.equal(error.code, 'TEXT_REQUEST_TIMEOUT');
    assert.match(error.message, /120 秒/);
    assert.doesNotMatch(error.message, /socket details/);
    return true;
  });
});
