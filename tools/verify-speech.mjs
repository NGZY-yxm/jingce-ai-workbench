import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { createProject, draftPlan } from '../lib/workflow.mjs';
import { speechReply, jsonReply, until } from '../test/support/speech-fixtures.mjs';

// Only local provider fixtures are used. The audio is a short test tone, not generated speech.
const require = createRequire(import.meta.url), { chromium } = require(process.argv[2] || 'playwright');
const output = path.resolve(process.argv[3] || 'outputs/speech-browser'); await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-speech-browser-'));
const requests = [], releases = [], errors = []; let app, browser, page;
try {
  const store = new Store(root); await store.init();
  const project = draftPlan(createProject({ title: '雨夜书店 · 配音创作', brief: { product: '雨夜书店', benefits: '街角灯光\n翻开旧书\n故事继续' } }));
  project.scenes[0].narration = '灯光落在书页上，故事从这一刻开始。';
  await store.mutate(state => state.projects.push(project));
  app = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false, message: '模拟环境' },
    speechFetcher: async (url, options) => {
      assert.ok(url.startsWith('https://api.minimax.cn/v1/'));
      assert.equal(options.headers.Authorization, 'Bearer browser-fixture-key');
      requests.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith('/get_voice')) return jsonReply({ base_resp: { status_code: 0 }, system_voice: [
        { voice_id: 'fixture-warm', voice_name: '测试音色 · 温暖旁白', description: ['本地验证音色', '中文'] },
        { voice_id: 'fixture-calm', voice_name: '测试音色 · 平静讲述', description: ['本地验证音色'] }] });
      assert.ok(url.endsWith('/t2a_v2')); await new Promise(resolve => releases.push(resolve)); return jsonReply(speechReply());
    } });
  const url = await app.start(0);
  browser = await chromium.launch({ headless: true, ...(process.argv[4] ? { executablePath: process.argv[4] } : { channel: 'msedge' }) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => document.querySelector('#save-state')?.textContent === '已保存到本机');
  await page.locator('#speech-tab').click(); await page.locator('#connections-center-button').click();
  await page.locator('#center-add').click();
  await page.locator('#connection-editor [name=name]').fill('MiniMax 国内语音');
  await page.locator('#connection-editor [name=kind]').selectOption('speech');
  await page.locator('#connection-editor [name=apiKey]').fill('browser-fixture-key');
  await page.locator('#center-read-models').click();
  await page.waitForFunction(() => document.querySelector('#center-editor-message').textContent.includes('音色读取验证通过'));
  assert.equal(requests.filter(request => request.url.endsWith('/t2a_v2')).length, 0);
  await page.locator('#center-model-choices input').evaluateAll(inputs => inputs.forEach(input => { if (!input.disabled) input.click(); }));
  await page.locator('#connection-editor [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#connections-list').textContent.includes('MiniMax 国内语音'));
  const speechRow = page.locator('#connections-list tbody tr').filter({ hasText: 'MiniMax 国内语音' });
  assert.equal(await speechRow.locator('td').nth(1).textContent(), '语音模型');
  assert.equal(await speechRow.locator('[data-edit-connection]').count(), 1);
  assert.equal(await speechRow.locator('[data-remove-connection]').count(), 1);
  assert.equal(await speechRow.locator('[data-check-connection]').count(), 1);
  assert.equal(await page.locator('#connections-center').evaluate(element => [...element.querySelectorAll('button')].some(button => button.textContent.trim() === 'MiniMax 语音')), false);
  await page.screenshot({ path: path.join(output, 'connections-speech-desktop.png'), fullPage: true });
  await page.locator('#connections-center-close').click();
  await page.locator('#speech-refresh-voices').click();
  await page.waitForFunction(() => [...document.querySelector('#speech-voice-picker').options].some(option => option.value === 'fixture-warm'));
  assert.equal(requests.filter(request => request.url.endsWith('/get_voice')).length, 2, '读取模型和读取音色都只调用 MiniMax 音色接口');
  await page.locator('#speech-voice-picker').selectOption('fixture-warm');
  await page.locator('#speech-form [name=format]').selectOption('wav');
  await page.locator('#speech-form [name=name]').fill('片头旁白');
  await page.locator('#speech-text').fill('灯光落在书页上，故事从这一刻开始。');
  await page.locator('#speech-submit').click();
  await until(() => requests.filter(request => request.url.endsWith('/t2a_v2')).length === 1);
  await page.waitForFunction(() => !document.querySelector('#speech-submit').disabled);
  assert.equal(app.speechJobs.list(project.id)[0].state, 'submitting');
  await page.locator('#speech-submit').click();
  await until(() => requests.filter(request => request.url.endsWith('/t2a_v2')).length === 2);
  await page.waitForFunction(() => !document.querySelector('#speech-submit').disabled);
  assert.equal(new Set(app.speechJobs.list(project.id).map(job => job.operationId)).size, 2);
  await page.locator('#speech-form [name=name]').fill('片尾旁白');
  await page.locator('#speech-text').fill('翻过这一页，下一段旅程才刚刚开始。');
  await page.locator('#speech-submit').dblclick();
  await until(() => requests.filter(request => request.url.endsWith('/t2a_v2')).length === 3);
  await page.waitForFunction(() => !document.querySelector('#speech-submit').disabled);
  assert.equal(app.speechJobs.list(project.id).length, 3, '双击不会产生两个任务');
  await page.screenshot({ path: path.join(output, 'speech-consecutive-submissions.png'), fullPage: true });
  releases.splice(0).forEach(release => release()); await until(() => app.speechJobs.list(project.id).every(job => job.state === 'done'));
  await page.locator('#speech-refresh-jobs').click(); await page.waitForFunction(() => document.querySelectorAll('#speech-job-list audio').length === 3);

  // Drop the local acknowledgement after the server accepted a request; reload must recover the same operation.
  let dropped = false;
  await page.route('**/api/projects/*/speech-jobs', async route => {
    if (!dropped && route.request().method() === 'POST') { dropped = true; await route.fetch(); await route.abort('connectionreset'); }
    else await route.continue();
  });
  await page.locator('#speech-text').fill('刷新后仍然保留这一条配音任务。');
  await page.locator('#speech-form [name=name]').fill('任务恢复验证');
  await page.locator('#speech-submit').click();
  await page.waitForFunction(() => !document.querySelector('#speech-pending').hidden);
  await until(() => requests.filter(request => request.url.endsWith('/t2a_v2')).length === 4);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#speech-submit').disabled && document.querySelectorAll('[data-speech-job]').length === 4);
  assert.equal(requests.filter(request => request.url.endsWith('/t2a_v2')).length, 4, '刷新找回原任务，不再次调用生成');
  assert.equal(await page.locator('#speech-text').inputValue(), '刷新后仍然保留这一条配音任务。');
  releases.splice(0).forEach(release => release()); await until(() => app.speechJobs.list(project.id).every(job => job.state === 'done'));
  await page.locator('#speech-refresh-jobs').click(); await page.waitForFunction(() => document.querySelectorAll('#speech-job-list audio').length === 4);
  const audio = page.locator('#speech-job-list audio').first();
  await audio.evaluate(async element => { await element.play(); element.pause(); });
  assert.equal(await audio.evaluate(element => element.error), null);
  assert.ok(await audio.evaluate(element => element.duration) > 0);
  const download = page.waitForEvent('download'); await page.locator('#speech-job-list a[download]').first().click();
  await (await download).saveAs(path.join(output, 'fixture-preview.wav'));
  await page.screenshot({ path: path.join(output, 'speech-workspace-day.png'), fullPage: true });
  await page.locator('#theme-select').selectOption('night');
  await page.screenshot({ path: path.join(output, 'speech-workspace-night.png'), fullPage: true });
  await page.locator('#theme-select').selectOption('day');
  await page.locator('#speech-job-list [data-speech-place]').first().click();
  await page.waitForFunction(() => document.body.dataset.view === 'canvas' && document.querySelectorAll('.node-kind-audio audio').length > 0);
  await page.locator('#results-tab').click(); await page.locator('#result-filter').selectOption('audio');
  await page.waitForFunction(() => document.querySelectorAll('#result-list .result-card').length === 4);
  await page.locator('#result-list [data-result-details]').first().click();
  assert.equal(await page.locator('#result-details-content audio').count(), 1);
  assert.ok((await page.locator('#result-details-content').textContent()).includes('配音文案'));
  await page.locator('#close-result-details').click();
  await page.locator('#speech-tab').click(); await page.locator('#speech-text').fill('');
  await page.locator('#speech-scene-picker').selectOption(project.scenes[0].id); await page.locator('#speech-import-narration').click();
  assert.equal(await page.locator('#speech-text').inputValue(), project.scenes[0].narration);
  assert.equal(requests.filter(request => request.url.endsWith('/t2a_v2')).length, 4, '试听、下载、放画布、查看结果与导入旁白均不重新生成');
  await page.locator('#connections-center-button').click();
  await page.locator('#connections-list [data-remove-connection]').click();
  await page.locator('#confirm-delete-connection').click();
  await page.waitForFunction(() => document.querySelector('#connections-center-message').textContent.includes('已删除'));
  await page.locator('#connections-center-close').click();
  assert.match(await page.locator('#speech-connection-status').textContent(), /未连接/);
  assert.equal(await page.locator('#speech-submit').isDisabled(), true);
  assert.equal(app.speechJobs.list(project.id).length, 4, '删除接口后已有任务仍保留');
  assert.deepEqual(errors, []);
  const report = { browser: 'Microsoft Edge', provider: 'local fixtures only', synthesisCalls: requests.filter(request => request.url.endsWith('/t2a_v2')).length,
    voiceReads: requests.filter(request => request.url.endsWith('/get_voice')).length,
    unifiedSpeechConnectionCenter: true, continuousSubmission: true, sameTextNewOperation: true, doubleClickDeduplication: true, reloadRecovery: true,
    audioPlayback: true, audioDownload: true, canvasPlacement: true, resultGallery: true, narrationImport: true,
    connectionDeletionKeepsJobs: true, pageErrors: errors };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  releases.forEach(release => release()); await browser?.close(); await app?.close(); await rm(root, { recursive: true, force: true });
}
