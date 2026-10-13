import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { createProject } from '../lib/workflow.mjs';
import { waveFixture, speechReply, jsonReply, until } from '../test/support/speech-fixtures.mjs';
import { parseVoiceJson } from '../lib/voice-provider.mjs';

// Local fixtures only. All audio is a test tone; this script never contacts a real voice provider.
const require = createRequire(import.meta.url), { chromium } = require(process.argv[2] || 'playwright');
const output = path.resolve(process.argv[3] || 'outputs/voice-browser'); await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-voice-browser-'));
assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
const calls = [], releases = [], pageErrors = []; let app, browser, page, previewAttempts = 0;
try {
  const store = new Store(root); await store.init();
  const project = createProject({ title: '自定义音色 · 页面验证' }); await store.mutate(state => state.projects.push(project));
  await store.saveConnections([{ id: 'fixture-voice-connection', name: 'MiniMax 国内语音', kind: 'speech', baseUrl: 'https://api.minimax.cn', models: ['speech-2.8-hd', 'speech-2.8-turbo'], apiKey: 'voice-browser-fixture' }]);
  app = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false }, speechFetcher: async (url, options) => {
    calls.push({ url, body: options.body instanceof FormData ? { purpose: options.body.get('purpose') } : options.body ? parseVoiceJson(options.body) : null });
    if (url.startsWith('https://filecdn.minimax.chat/')) { previewAttempts++; assert.equal(options.headers, undefined); return previewAttempts === 1 ? new Response('temporary', { status: 503 }) : new Response(waveFixture()); }
    assert.equal(options.headers.Authorization, 'Bearer voice-browser-fixture');
    if (url.endsWith('/get_voice')) return jsonReply({ base_resp: { status_code: 0 }, system_voice: [{ voice_id: 'male-qn-qingse', voice_name: '系统示例音色' }] });
    if (url.endsWith('/files/upload')) { assert.equal(options.body.get('purpose'), 'voice_clone'); return new Response('{"base_resp":{"status_code":0},"file":{"file_id":1768987900000051201}}'); }
    if (url.endsWith('/voice_clone')) { assert.equal(parseVoiceJson(options.body).file_id, '1768987900000051201'); await new Promise(resolve => releases.push(resolve)); return jsonReply({ base_resp: { status_code: 0 }, demo_audio: 'https://filecdn.minimax.chat/fixture-voice.wav' }); }
    if (url.endsWith('/voice_design')) { const body = JSON.parse(options.body); assert.equal(body.model, undefined); await new Promise(resolve => releases.push(resolve)); return jsonReply({ base_resp: { status_code: 0 }, voice_id: body.voice_id, trial_audio: waveFixture().toString('hex') }); }
    if (url.endsWith('/t2a_v2')) return jsonReply(speechReply());
    throw new Error('unexpected fixture request');
  } });
  const url = await app.start(0);
  browser = await chromium.launch({ headless: true, ...(process.argv[4] ? { executablePath: process.argv[4] } : { channel: 'msedge' }) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1080 } }); page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === '已保存到本机');
  await page.locator('#speech-tab').click(); await page.locator('#theme-select').selectOption('day'); await page.locator('#speech-new-voice').click();
  assert.equal(await page.locator('#voice-studio').evaluate(dialog => dialog.open), true);
  const form = page.locator('#voice-create-form');
  await form.locator('[name=name]').fill('复刻测试旁白');
  await page.locator('#voice-recording-file').setInputFiles({ name: '太短.wav', mimeType: 'audio/wav', buffer: waveFixture(1) });
  await page.waitForFunction(() => document.querySelector('#voice-recording-info').textContent.includes('10 秒'));
  assert.equal(calls.filter(call => call.url.endsWith('/files/upload')).length, 0);
  await page.locator('#voice-recording-file').setInputFiles({ name: '清晰人声样本.wav', mimeType: 'audio/wav', buffer: waveFixture(12) });
  await page.waitForFunction(() => document.querySelector('#voice-recording-info').textContent.includes('已保存到本机'));
  assert.equal(calls.filter(call => call.url.endsWith('/files/upload')).length, 0, '选择文件仅本地保存');
  await page.locator('#voice-recording-player').evaluate(async audio => { await audio.play(); audio.pause(); });
  assert.equal(await page.locator('#voice-recording-player').evaluate(audio => audio.duration), 12);
  await page.screenshot({ path: path.join(output, 'voice-upload-desktop-day.png'), fullPage: true });
  const clonedId = await form.locator('[name=voiceId]').inputValue();
  await page.locator('#voice-create-submit').click();
  await page.waitForFunction(() => !document.querySelector('#voice-create-submit').disabled && document.querySelectorAll('[data-voice-job]').length === 1);
  await until(() => calls.filter(call => call.url.endsWith('/voice_clone')).length === 1);
  assert.notEqual(await form.locator('[name=voiceId]').inputValue(), clonedId);
  await page.locator('#voice-kind-design').click(); await form.locator('[name=name]').fill('设计测试旁白'); await form.locator('[name=prompt]').fill('温暖清晰的女声，语气自然从容，适合品牌旁白。');
  await page.locator('#voice-create-submit').dblclick();
  await page.waitForFunction(() => !document.querySelector('#voice-create-submit').disabled && document.querySelectorAll('[data-voice-job]').length === 2);
  await until(() => calls.filter(call => call.url.endsWith('/voice_design')).length === 1);
  assert.equal(app.store.state.voiceJobs.length, 2, '创建任务未完成时可继续创建，双击只接收一次');
  releases.splice(0).forEach(release => release()); await until(() => app.store.state.voiceJobs.every(job => job.state === 'done'));
  await page.waitForFunction(() => Boolean(document.querySelector('[data-voice-preview]')));
  const cloneJob = app.store.state.voiceJobs.find(job => job.request.kind === 'clone');
  assert.equal(cloneJob.voiceId, clonedId); assert.equal(cloneJob.previewState, 'pending');
  await page.locator('[data-voice-preview]').click(); await page.waitForFunction(() => document.querySelectorAll('#voice-job-list audio').length === 2);
  assert.equal(previewAttempts, 2); assert.equal(calls.filter(call => call.url.endsWith('/voice_clone')).length, 1, '重试试听仅下载原结果');
  const preview = page.locator('#voice-job-list audio').first(); await preview.evaluate(async audio => { await audio.play(); audio.pause(); }); assert.equal(await preview.evaluate(audio => audio.error), null);
  const downloadEvent = page.waitForEvent('download'); await page.locator('#voice-job-list a[download]').first().click(); await (await downloadEvent).saveAs(path.join(output, 'fixture-voice-preview.wav'));
  await page.screenshot({ path: path.join(output, 'voice-created-desktop-day.png'), fullPage: true });
  await page.locator('#voice-studio-close').click(); await page.locator('#theme-select').selectOption('night'); await page.locator('#speech-new-voice').click();
  await page.screenshot({ path: path.join(output, 'voice-created-desktop-night.png'), fullPage: true });
  await page.locator(`[data-voice-use="${cloneJob.id}"]`).click();
  assert.equal(await page.locator('#speech-voice-id').inputValue(), clonedId); assert.equal(await page.locator('#voice-studio').evaluate(dialog => dialog.open), false);
  assert.match(await page.locator('#speech-voice-description').textContent(), /自定义音色/);
  await page.locator('#speech-text').fill('使用我创建的声音，为这段旁白配音。'); await page.locator('#speech-form [name=format]').selectOption('wav'); await page.locator('#speech-submit').click();
  await until(() => app.store.state.speechJobs[0]?.state === 'done'); assert.equal(calls.find(call => call.url.endsWith('/t2a_v2')).body.voice_setting.voice_id, clonedId);
  await page.reload(); await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === '已保存到本机'); await page.locator('#speech-tab').click();
  assert.equal(await page.locator('#speech-voice-id').inputValue(), clonedId, '刷新保留所选音色');
  await page.locator('#speech-refresh-voices').click(); await page.waitForFunction(() => document.querySelector('#speech-voice-picker').options.length === 4);
  await page.locator('#speech-new-voice').click(); await page.locator('#voice-kind-design').click(); await form.locator('[name=name]').fill('刷新恢复测试音色');
  let dropped = false;
  await page.route('**/api/voice-jobs', async route => {
    if (!dropped && route.request().method() === 'POST') { dropped = true; await route.fetch(); await route.abort('connectionreset'); } else await route.continue();
  });
  await page.locator('#voice-create-submit').click(); await until(() => calls.filter(call => call.url.endsWith('/voice_design')).length === 2);
  await page.reload(); await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === '已保存到本机'); await page.locator('#speech-tab').click(); await page.locator('#speech-new-voice').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-voice-job]').length === 3 && !document.querySelector('#voice-create-submit').disabled);
  assert.equal(calls.filter(call => call.url.endsWith('/voice_design')).length, 2, '浏览器响应丢失后刷新只恢复原任务');
  releases.splice(0).forEach(release => release()); await until(() => app.store.state.voiceJobs.every(job => job.state === 'done'));
  await page.locator('#voice-refresh-jobs').click(); await page.waitForFunction(() => document.querySelectorAll('#voice-job-list audio').length === 3);
  await page.locator('#voice-studio-close').click(); await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#speech-new-voice').click();
  assert.equal(await page.locator('#voice-studio').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), true);
  await page.screenshot({ path: path.join(output, 'voice-created-mobile-night.png'), fullPage: true });
  assert.deepEqual(pageErrors, []);
  const report = { provider: 'local fixtures only', browser: 'Microsoft Edge', recordingValidation: true, localRecordingPlayback: true,
    cloneAndDesign: true, continuousSubmission: true, doubleClickDeduplication: true, previewFailureRecovery: true, previewPlayback: true, previewDownload: true,
    selectForSpeech: true, choicePersisted: true, reloadRecovery: true, mobileNoOverflow: true,
    uploadCalls: calls.filter(call => call.url.endsWith('/files/upload')).length, cloneCalls: calls.filter(call => call.url.endsWith('/voice_clone')).length,
    designCalls: calls.filter(call => call.url.endsWith('/voice_design')).length, speechCalls: calls.filter(call => call.url.endsWith('/t2a_v2')).length, pageErrors };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) { if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
finally { releases.forEach(release => release()); await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true }); }
