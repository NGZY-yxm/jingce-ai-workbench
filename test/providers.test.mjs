import test from 'node:test';
import assert from 'node:assert/strict';
// Preserve the old contract as coverage for tasks created before the v3 migration.
import { PLATFORM, DEFAULT_CONNECTION, VIDEO_REQUEST_MODE, submitVideo, pollVideo, normalizeTask, loadCatalog, checkConnection, UncertainSubmission } from '../lib/providers-legacy.mjs';
import { isPrivateAddress, downloadPublicVideo, videoDownloadUrl } from '../lib/media.mjs';
const settings = { ...DEFAULT_CONNECTION, apiKey: 'test-only-secret' };
const job = { model: 'model-a', duration: 5, resolution: '720p', ratio: '9:16', prompt: '原创视频提示词',
  requestMode: VIDEO_REQUEST_MODE, providerDefaults: { duration: 5, resolution: '720p' } };
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('视频时长契约：单次 POST 发送模型、提示词和整数秒数', async () => {
  let calls = 0;
  const result = await submitVideo(settings, job, undefined, async (url, options) => {
    calls++; assert.equal(url, `${PLATFORM}/v1/video/generations`); assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer test-only-secret');
    assert.deepEqual(JSON.parse(options.body), { model: 'model-a', prompt: '原创视频提示词', duration: 5 });
    return reply({ task_id: 'task-1', status: 'queued', progress: null });
  });
  assert.equal(calls, 1); assert.equal(result.taskId, 'task-1'); assert.equal(result.progress, null);
});

test('所选非默认秒数传给平台，不发送宽高、秒数别名或分辨率字段', async () => {
  let calls = 0;
  await submitVideo(settings, { ...job, duration: 30 }, undefined, async (_url, options) => {
    calls++;
    assert.deepEqual(JSON.parse(options.body), { model: 'model-a', prompt: '原创视频提示词', duration: 30 });
    return reply({ task_id: 'custom-duration', status: 'queued' });
  });
  assert.equal(calls, 1);
});

test('不完整的参考素材、无效秒数、非默认分辨率和旧版请求在发送前被拒绝', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return reply({ task_id: 'unexpected' }); };
  await assert.rejects(submitVideo(settings, job, 'data:image/png;base64,AAAA', fetcher), /参考/);
  for (const changes of [{ referenceAssetId: 'image-one' }, { references: [{ assetId: 'video-one', kind: 'video' }] }]) {
    await assert.rejects(submitVideo(settings, { ...job, ...changes }, undefined, fetcher), /参考/);
  }
  for (const duration of [0, 5.5, 31, NaN]) {
    await assert.rejects(submitVideo(settings, { ...job, duration }, undefined, fetcher), /整数秒数/);
  }
  for (const changes of [{ resolution: '1080p' }, { providerDefaults: undefined }]) {
    await assert.rejects(submitVideo(settings, { ...job, ...changes }, undefined, fetcher), /默认/);
  }
  await assert.rejects(submitVideo(settings, { ...job, requestMode: undefined }, undefined, fetcher), /刷新/);
  await assert.rejects(submitVideo(settings, { ...job, requestMode: 'platform-defaults' }, undefined, fetcher), /刷新/);
  assert.equal(calls, 0);
});

test('禁止向不同平台发送密钥，不跟随重定向', async () => {
  let calls = 0;
  await assert.rejects(submitVideo({ ...settings, baseUrl: 'https://other.invalid' }, job, null, async () => { calls++; }), /仅支持/);
  assert.equal(calls, 0);
  await assert.rejects(submitVideo(settings, job, null, async () => new Response('', { status: 302 })), UncertainSubmission);
});

test('网关故障、超时和无法解析的提交结果保留不确定性，明确拒绝隐藏密钥', async () => {
  for (const status of [408, 502]) await assert.rejects(submitVideo(settings, job, null, async () => reply({}, status)), UncertainSubmission);
  await assert.rejects(submitVideo(settings, job, null, async () => new Response('not json')), UncertainSubmission);
  await assert.rejects(submitVideo(settings, job, null, async () => reply({ error: { message: 'bad test-only-secret' } }, 401)), error => error.status === 401 && !error.message.includes(settings.apiKey));
});

test('查询异步结果兼容 data 包装，路径编码并隐藏平台回显密钥', async () => {
  const result = await pollVideo(settings, 'task/1', async (url, options) => {
    assert.equal(url, `${PLATFORM}/v1/video/generations/task%2F1`); assert.equal(options.method, undefined);
    return reply({ data: { task_id: 'task/1', status: 'completed', url: 'https://cdn.example.org/video.mp4', message: settings.apiKey } });
  });
  assert.equal(result.state, 'completed'); assert.equal(result.message, '[已隐藏密钥]');
  assert.equal(normalizeTask({ status: 'processing', progress: 52 }).state, 'running');
});

test('平台明确返回任务不存在时保留结构化错误码', async () => {
  await assert.rejects(
    pollVideo(settings, 'missing-task', async () => reply({ code: 'task_not_exist', message: 'task_not_exist', data: null }, 400)),
    error => error.code === 'task_not_exist' && error.status === 502 && /任务不存在/.test(error.message),
  );
  await assert.throws(
    () => normalizeTask({ code: 'task_not_found', data: null }),
    error => error.code === 'task_not_found' && /任务不存在/.test(error.message),
  );
});

test('实际平台包装格式：识别百分比进度、生成时间和外层任务编号', async () => {
  const result = await pollVideo(settings, 'gateway-task', async () => reply({ code: 'success', message: '', data: {
    id: 117, task_id: 'gateway-task', status: 'IN_PROGRESS', progress: '50%',
    submit_time: 1791184812, start_time: 1791184835, finish_time: 0,
    data: { id: 'upstream-task', status: 'in_progress', progress: 50, result_urls: [] },
  } }));
  assert.equal(result.state, 'running'); assert.equal(result.progress, 50);
  assert.equal(result.taskId, 'gateway-task'); assert.equal(result.providerStatus, 'IN_PROGRESS');
  assert.equal(result.providerSubmittedAt, '2026-10-05T07:20:12.000Z');
  assert.equal(result.providerStartedAt, '2026-10-05T07:20:35.000Z'); assert.equal(result.providerFinishedAt, null);
});

test('平台包装格式：提取 result_urls、使用内层进度并显示已脱敏的失败原因', async () => {
  const running = normalizeTask({ data: { task_id: 'gateway-task', status: 'IN_PROGRESS', progress: '',
    data: { status: 'in_progress', progress: 50, result_urls: [] } } });
  assert.equal(running.progress, 50); assert.equal(running.url, '');
  const complete = await pollVideo(settings, 'gateway-task', async () => reply({ data: {
    task_id: 'gateway-task', status: 'SUCCESS', progress: '100%', finish_time: 1791186900,
    data: { status: 'completed', result_urls: ['https://cdn.example.org/video.mp4'] },
  } }));
  assert.equal(complete.state, 'completed'); assert.equal(complete.progress, 100);
  assert.equal(complete.url, 'https://cdn.example.org/video.mp4');
  assert.equal(complete.providerFinishedAt, '2026-10-05T07:55:00.000Z');
  const failed = await pollVideo(settings, 'gateway-task', async () => reply({ data: {
    task_id: 'gateway-task', status: 'FAILURE', fail_reason: `platform rejected ${settings.apiKey}`,
  } }));
  assert.equal(failed.state, 'failed'); assert.match(failed.message, /platform rejected/);
  assert.doesNotMatch(JSON.stringify(failed), /test-only-secret/);
});

test('成功响应回显的密钥不进入任务编号，也不随下载 URL 发往其他地址', async () => {
  const result = await submitVideo(settings, job, null, async () => reply({ task_id: settings.apiKey,
    status: 'completed', url: `https://other.example.org/video?key=${settings.apiKey}`, message: settings.apiKey }));
  assert.equal(result.taskId, ''); assert.equal(result.url, '');
  assert.doesNotMatch(JSON.stringify(result), /test-only-secret/);
});

test('目录筛选视频端点、保留余额单位；只读令牌检查不生成', async () => {
  const catalog = await loadCatalog(async () => reply({ data: [
    { model_name: 'text', supported_endpoint_types: ['openai'] },
    { model_name: 'video', supported_endpoint_types: ['openai-video'], video_pricing: {
      default_duration: 15, default_resolution: '480p', tiers: [{ duration: 15, resolution: '480p', price: 1 }] } },
  ] }));
  assert.deepEqual(catalog.map(model => model.name), ['video']); assert.equal(catalog[0].priceUnit, '平台余额单位');
  assert.equal(catalog[0].defaultDuration, 15); assert.equal(catalog[0].defaultResolution, '480p');
  const result = await checkConnection(settings, async url => { assert.equal(url, `${PLATFORM}/v1/models`); return reply({ data: [{ id: settings.videoModel }] }); });
  assert.equal(result.selectedModelVisible, true);
});

test('视频下载拒绝内网、HTTP、带凭据的地址', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fc00::1', '::ffff:127.0.0.1']) assert.equal(isPrivateAddress(address), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  for (const url of ['http://example.org/video', 'https://127.0.0.1/video', 'https://[::1]/video', 'https://user:password@example.org/video']) await assert.rejects(downloadPublicVideo(url, 'unused.mp4'));
});

test('已核对的视频 CDN 自动使用 HTTPS，保留签名路径和查询，其他 HTTP 地址仍拒绝', () => {
  const original = 'http://v16-dola.dola.com/video/path%2Fname?sign=a%2Fb%2Bc&download=1';
  const url = videoDownloadUrl(original);
  assert.equal(url.href, 'https://v16-dola.dola.com/video/path%2Fname?sign=a%2Fb%2Bc&download=1');
  assert.equal(url.search, new URL(original).search); assert.equal(url.pathname, new URL(original).pathname);
  for (const value of ['http://other.dola.com/video', 'http://v16-dola.dola.com.attacker.org/video',
    'http://v16-dola.dola.com:8080/video', 'http://user:secret@v16-dola.dola.com/video', 'file:///video.mp4', 'not-a-url']) {
    assert.throws(() => videoDownloadUrl(value));
  }
});
