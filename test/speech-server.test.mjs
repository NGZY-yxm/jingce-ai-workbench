import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server.mjs';
import { waveFixture, speechReply, jsonReply, until } from './support/speech-fixtures.mjs';

test('本地 HTTP 语音流程：静态模块、私密配置、只读音色、连续提交、幂等重放、素材试听和 Range', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-speech-http-')), releases = [], requests = [];
  const app = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false, message: '模拟环境' },
    speechFetcher: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith('/get_voice')) return jsonReply({ base_resp: { status_code: 0 }, system_voice: [{ voice_id: 'fixture-voice', voice_name: '模拟音色' }] });
      await new Promise(resolve => releases.push(resolve)); return jsonReply(speechReply());
    } });
  const url = await app.start(0);
  t.after(async () => { releases.forEach(release => release()); await app.close(); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await (await fetch(url + '/api/bootstrap')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token };
  const send = (route, method = 'GET', body) => fetch(url + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const route of ['/speech.js', '/speech.css', '/speech-parameters.js']) assert.equal((await send(route)).status, 200);
  assert.equal((await fetch(url + '/api/connections', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const connectionResponse = await send('/api/connections', 'PUT', { name: 'MiniMax 国内语音', kind: 'speech', models: ['speech-2.8-hd', 'speech-2.8-turbo'], baseUrl: 'https://api.minimax.cn', apiKey: 'http-private-key' });
  assert.equal(connectionResponse.status, 200); const savedConnection = await connectionResponse.json();
  assert.equal(requests.length, 0, '保存配置不调用平台');
  const tokenModels = await (await send('/api/connections/models', 'POST', { id: savedConnection.id, kind: 'speech', baseUrl: savedConnection.baseUrl, apiKey: 'http-private-key', models: savedConnection.models })).json();
  assert.deepEqual(tokenModels.catalog.map(item => item.name), ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo']);
  const voices = await (await send(`/api/connections/${savedConnection.id}/check`, 'POST', {})).json(); assert.equal(voices.voices[0].id, 'fixture-voice');
  assert.equal(requests.length, 2, '读取令牌模型和验证连接都只读取音色');
  assert.ok(requests.every(request => request.url.endsWith('/get_voice')));
  assert.doesNotMatch(await (await send('/api/bootstrap')).text(), /http-private-key/);
  assert.match(await readFile(path.join(root, 'connections.private.json'), 'utf8'), /http-private-key/);
  for (const route of ['/runtime/connections.private.json', '/connections.private.json', '/speech-task-connections/x.private.json']) assert.equal((await send(route)).status, 404);
  const project = await (await send('/api/projects', 'POST', { title: '语音 HTTP 验证' })).json();
  const input = { operationId: 'http-operation-first', text: '第一段配音', format: 'wav', voiceId: 'fixture-voice' };
  const firstResponse = await send(`/api/projects/${project.id}/speech-jobs`, 'POST', input); assert.equal(firstResponse.status, 202);
  const first = await firstResponse.json();
  const second = await (await send(`/api/projects/${project.id}/speech-jobs`, 'POST', { ...input, operationId: 'http-operation-second' })).json();
  assert.notEqual(second.id, first.id); await until(() => releases.length === 2);
  const replay = await (await send(`/api/projects/${project.id}/speech-jobs`, 'POST', input)).json(); assert.equal(replay.id, first.id);
  assert.equal(requests.filter(request => request.url.endsWith('/t2a_v2')).length, 2);
  releases.forEach(release => release()); await until(() => app.speechJobs.list(project.id).every(job => job.state === 'done'));
  const job = await (await send('/api/speech-jobs/' + first.id)).json();
  assert.equal(job.state, 'done'); assert.equal(job.duration, 0.25);
  const saved = await (await send(`/api/projects/${project.id}`)).json(); assert.equal(saved.assets.length, 2);
  const audioResponse = await send('/api/assets/' + job.assetId); assert.equal(audioResponse.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await audioResponse.arrayBuffer()), waveFixture());
  const range = await fetch(url + '/api/assets/' + job.assetId, { headers: { Range: 'bytes=0-11' } }); assert.equal(range.status, 206);
  assert.equal(Buffer.from(await range.arrayBuffer()).toString('ascii', 0, 4), 'RIFF');
  assert.doesNotMatch(JSON.stringify(saved) + JSON.stringify(job), /http-private-key/);
  assert.equal((await send('/api/speech-jobs/' + first.id + '/save', 'POST', {})).status, 202);
  assert.equal(requests.filter(request => request.url.endsWith('/t2a_v2')).length, 2);
});


test('配音 HTTP 删除、已删除列表、恢复和彻底删除，清理后旧操作返回 410', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-speech-delete-http-')); let calls = 0;
  const app = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false, message: '模拟环境' },
    speechFetcher: async () => { calls++; return jsonReply(speechReply()); } });
  const url = await app.start(0);
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await (await fetch(url + '/api/bootstrap')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token };
  const send = (route, method = 'GET', body) => fetch(url + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  await app.store.saveSpeechSettings({ apiKey: 'delete-http-fixture-key', model: 'speech-2.8-hd', region: 'domestic' });
  const project = await (await send('/api/projects', 'POST', { title: '配音删除 HTTP 验证' })).json();
  const route = `/api/projects/${project.id}/speech-jobs`;
  const input = { operationId: 'http-operation-delete', text: '可删除的配音', format: 'wav', voiceId: 'fixture-voice' };
  const job = await (await send(route, 'POST', input)).json();
  await until(() => app.speechJobs.get(job.id).state === 'done' && !app.speechJobs.busy.has(job.id));
  const saved = app.store.get(project.id), asset = saved.assets[0], jobRoute = '/api/speech-jobs/' + job.id;
  assert.equal((await fetch(url + jobRoute, { method: 'DELETE' })).status, 403);
  assert.equal((await send(jobRoute + '/permanent', 'DELETE')).status, 409);
  const deletion = await send(jobRoute, 'DELETE'); assert.equal(deletion.status, 200); assert.ok((await deletion.json()).deletedAt);
  assert.deepEqual(await (await send(route)).json(), []);
  const deleted = await (await send(route + '?includeDeleted=1')).json(); assert.equal(deleted.length, 1); assert.ok(deleted[0].deletedAt);
  assert.ok((await (await send(jobRoute)).json()).deletedAt);
  assert.equal((await send('/api/assets/' + asset.id)).status, 200, '可恢复删除保留音频文件');
  assert.equal((await (await send(route, 'POST', input)).json()).id, job.id);
  assert.equal((await send(jobRoute + '/restore', 'POST', {})).status, 200);
  assert.equal((await (await send(route)).json()).length, 1);
  assert.equal(app.store.get(project.id).assets[0].deletedAt, null);
  assert.equal((await send(`/api/projects/${project.id}/assets/${asset.id}`, 'DELETE')).status, 200);
  assert.ok((await (await send(route + '?includeDeleted=1')).json())[0].deletedAt, '兼容原素材删除流程');
  const permanent = await send(jobRoute + '/permanent', 'DELETE'); assert.equal(permanent.status, 200);
  assert.equal((await permanent.json()).cleanupPending, 0);
  assert.deepEqual(await (await send(route + '?includeDeleted=1')).json(), []);
  assert.equal((await send(jobRoute)).status, 404);
  assert.equal((await send(jobRoute + '/restore', 'POST', {})).status, 404);
  assert.equal((await send('/api/assets/' + asset.id)).status, 404);
  assert.equal((await send(route, 'POST', input)).status, 410);
  for (const file of [path.join(root, 'assets', asset.file), app.speechJobs.resultFile(job.id), app.speechJobs.connectionFile(job.id)]) {
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  }
  assert.equal(calls, 1, '删除、恢复、彻底删除以及旧操作重放均不再次调用模型');
});
