import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server.mjs';
import { waveFixture, jsonReply, speechReply, until } from './support/speech-fixtures.mjs';
import { parseVoiceJson } from '../lib/voice-provider.mjs';

test('HTTP 音色流程：本地录音、复刻、设计、连续提交、试听下载、选用配音、连接删除保留结果', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-voice-http-')), calls = [];
  const app = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false }, speechFetcher: async (url, options) => {
    calls.push({ url, method: options.method });
    if (url.startsWith('https://filecdn.minimax.chat/')) { assert.equal(options.headers, undefined); return new Response(waveFixture()); }
    assert.equal(options.headers.Authorization, 'Bearer voice-http-secret');
    if (url.endsWith('/files/upload')) return new Response('{"base_resp":{"status_code":0},"file":{"file_id":1768987900000051201}}');
    if (url.endsWith('/voice_clone')) { assert.equal(parseVoiceJson(options.body).file_id, '1768987900000051201'); return jsonReply({ base_resp: { status_code: 0 }, demo_audio: 'https://filecdn.minimax.chat/voice-fixture.wav' }); }
    if (url.endsWith('/voice_design')) return jsonReply({ base_resp: { status_code: 0 }, voice_id: JSON.parse(options.body).voice_id, trial_audio: waveFixture().toString('hex') });
    if (url.endsWith('/get_voice')) return jsonReply({ base_resp: { status_code: 0 }, system_voice: [] });
    if (url.endsWith('/t2a_v2')) return jsonReply(speechReply());
    throw new Error('unexpected request');
  } });
  const url = await app.start(0); t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const { token } = await (await fetch(url + '/api/bootstrap')).json();
  const send = (route, method = 'GET', body) => fetch(url + route, { method, headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const module of ['/voice-studio.js', '/voice-parameters.js']) assert.equal((await send(module)).status, 200);
  assert.equal((await fetch(url + '/api/voice-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const connection = await (await send('/api/connections', 'PUT', { name: 'MiniMax 语音', kind: 'speech', models: ['speech-2.8-hd'], baseUrl: 'https://api.minimax.cn', apiKey: 'voice-http-secret' })).json();
  const upload = bytes => fetch(url + '/api/voice-recordings?model=speech-2.8-hd&operationId=http-upload-operation', { method: 'POST', headers: { 'X-Studio-Token': token, 'X-File-Name': encodeURIComponent('本地录音.wav') }, body: bytes });
  const short = await upload(waveFixture(1)); assert.equal(short.status, 400); assert.equal(calls.length, 0);
  const uploaded = await upload(waveFixture(12)); assert.equal(uploaded.status, 201); const recording = await uploaded.json();
  assert.equal(calls.length, 0, '本地上传和原录音试听不调用 MiniMax'); assert.equal(recording.duration, 12);
  assert.equal((await fetch(url + recording.previewUrl)).status, 200);
  const cloneInput = { operationId: 'http-voice-clone-a', kind: 'clone', name: '复刻旁白', voiceId: 'jc_http_clone_a', recordingId: recording.id, model: 'speech-2.8-hd', previewText: '试听。' };
  const firstResponse = await send('/api/voice-jobs', 'POST', cloneInput); assert.equal(firstResponse.status, 202); const first = await firstResponse.json();
  const second = await (await send('/api/voice-jobs', 'POST', { ...cloneInput, operationId: 'http-voice-design-a', kind: 'design', name: '设计旁白', voiceId: 'jc_http_design_a', prompt: '温柔女声' })).json();
  assert.equal((await (await send('/api/voice-jobs', 'POST', cloneInput)).json()).id, first.id);
  await until(() => app.voiceJobs.get(first.id).state === 'done' && app.voiceJobs.get(second.id).state === 'done');
  assert.equal(calls.filter(call => call.url.endsWith('/voice_clone')).length, 1); assert.equal(calls.filter(call => call.url.endsWith('/voice_design')).length, 1);
  const list = await (await send('/api/voice-jobs?model=speech-2.8-hd')).json(); assert.equal(list.length, 2); assert.doesNotMatch(JSON.stringify(list), /voice-http-secret|1768987900000051201|filecdn/);
  const job = list.find(item => item.id === first.id), range = await fetch(url + job.previewUrl, { headers: { Range: 'bytes=0-11' } });
  assert.equal(range.status, 206); assert.equal(Buffer.from(await range.arrayBuffer()).toString('ascii', 0, 4), 'RIFF');
  const download = await send(job.previewUrl + '?download=1'); assert.match(download.headers.get('content-disposition'), /attachment/);
  const voices = await (await send('/api/speech-voices', 'POST', { model: 'speech-2.8-hd' })).json(); assert.equal(voices.voices.length, 2); assert.equal(voices.voices.find(voice => voice.id === cloneInput.voiceId).type, 'cloned');
  const project = await (await send('/api/projects', 'POST', { title: '新音色配音测试' })).json();
  const speech = await (await send(`/api/projects/${project.id}/speech-jobs`, 'POST', { operationId: 'http-custom-speech', text: '正式文案。', voiceId: cloneInput.voiceId, model: 'speech-2.8-hd', format: 'wav' })).json();
  await until(() => app.speechJobs.get(speech.id).state === 'done'); assert.equal(calls.filter(call => call.url.endsWith('/t2a_v2')).length, 1);
  assert.equal((await send(`/api/connections/${connection.id}`, 'DELETE', {})).status, 200);
  assert.equal((await send(`/api/voice-jobs/${first.id}`)).status, 200); assert.equal((await send(job.previewUrl)).status, 200);
  for (const privateRoute of ['/voice-task-connections/private.json', '/voice-results/private.json', '/voice-recordings/private.wav', '/runtime/projects.json']) assert.equal((await send(privateRoute)).status, 404);
});
