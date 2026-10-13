import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createStudio } from '../server.mjs';
import { createProject } from '../lib/workflow.mjs';
import { createBlenderHelper } from './blender-helper.mjs';
import { detectPrevisTools, previsArtifacts } from '../lib/previs.mjs';
import { parsePrevisSpec } from '../public/previs-spec.js';

// The UI fixture uses already rendered media. The HTTPS helper run invokes real Blender.
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(process.env.JINGCE_BROWSER_MODULES || directory, 'package.json'));
const { chromium } = require('playwright');
const output = path.resolve(process.argv[2] || path.join(directory, 'outputs', 'previs-browser-verification'));
const media = path.join(directory, 'outputs', 'blender-previs-verification');
const spec = JSON.parse(await readFile(path.join(media, 'scene_spec.json'), 'utf8'));
const mediaReport = JSON.parse(await readFile(path.join(media, 'report.json'), 'utf8'));
const detected = await detectPrevisTools(path.join(directory, 'runtime'));
assert.equal(detected.ready, true, 'Install Blender and an H.264 encoder before this smoke check.');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.join(os.tmpdir(), 'jingce-previs-browser-'));
const remoteOrigin = 'https://jingce-previs.example.test';
let browser, localPage, remotePage, helper, app;
const errors = [], modelRequests = [], bridgeRequests = [], failures = [];
let localRenderCount = 0, invalidReply = false;
async function copiedRender(folder, scene, _tools, { progress }) {
  assert.equal(scene.duration, spec.duration); assert.equal(scene.fps, spec.fps);
  localRenderCount++;
  await progress('rendering', .5, '浏览器验证复用已通过真实渲染的媒体。');
  await delay(600);
  for (const artifact of previsArtifacts(scene).filter(item => !['spec', 'prompt'].includes(item.key))) {
    await mkdir(path.dirname(path.join(folder, artifact.file)), { recursive: true });
    await copyFile(path.join(media, artifact.file), path.join(folder, artifact.file));
  }
  return mediaReport;
}
async function until(check, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(150); }
  throw new Error('Browser verification timed out.');
}
const monitor = page => {
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => {
    if (!request.failure()?.errorText.includes('ERR_ABORTED')) failures.push({ url: request.url(), error: request.failure()?.errorText });
  });
};
try {
  app = await createStudio({ root: path.join(temporary, 'website'), publicOrigin: remoteOrigin,
    catalog: [], imageCatalog: [], textCatalog: [{ name: 'previs-test-text' }], tools: { ready: false },
    previs: { detectTools: async () => detected, render: copiedRender },
    textFetcher: async (_url, options) => {
      const request = JSON.parse(options.body); modelRequests.push(request);
      const last = request.messages.at(-1)?.content || '';
      let content;
      if (modelRequests.length === 1) content = '{"scene_spec":';
      else if (modelRequests.length === 2) content = JSON.stringify({ reply: '故事已整理，请检查后应用。', scene_spec: spec });
      else if (last.includes('本轮问题或修改要求')) {
        if (last.includes('先解释为什么')) content = JSON.stringify({ reply: '当前第 1 秒镜头与人物间距较远，可以再靠近。', scene_spec: null });
        else {
          const match = last.match(/当前场景（本轮请以此为准）：\n([^\n]+)/);
          const revision = match ? JSON.parse(match[1]) : structuredClone(spec);
          revision.name = '庭院相遇 · 对话修订'; revision.camera.lens = 42;
          if (last.includes('再向左移动')) revision.camera.keys[1].position[0] -= 1;
          if (last.includes('模拟不支持字段')) { revision.script = 'import bpy'; invalidReply = true; }
          content = JSON.stringify({ reply: '保留原有人物和道具，调整摄影机焦距。', scene_spec: revision });
        }
      } else content = modelRequests.length === 1 ? '场景草稿需要人工修改' : JSON.stringify(spec);
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } });
    } });
  await app.store.saveTextSettings({ baseUrl: 'https://sub.beibeihai.xyz/v1', apiKey: 'offline-previs-fixture', textModel: 'previs-test-text' });
  const project = createProject({ title: 'Blender 网页预演验证' }), second = createProject({ title: '另一工程的独立草稿' });
  await app.store.mutate(state => state.projects.push(project, second));
  const url = await app.start(0);
  const saved = () => fetch(`${url}/api/projects/${project.id}`).then(response => response.json());
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(id => { localStorage.setItem('jingce-active-project', id); localStorage.setItem('jingce-active-view', 'previs'); }, project.id);
  localPage = await context.newPage(); monitor(localPage);
  await localPage.goto(url);
  await localPage.waitForFunction(() => !document.querySelector('#previs-start')?.disabled);
  const initialScene = await localPage.locator('#previs-spec').inputValue();
  await localPage.locator('#previs-chat-input').fill('庭院相遇，先跟拍再绕到侧面，最后两人同框。');
  await localPage.locator('#previs-chat-send').click();
  await localPage.waitForFunction(() => document.querySelector('#previs-chat-status').textContent.includes('回复未包含'));
  assert.equal(await localPage.locator('#previs-spec').inputValue(), initialScene, 'Invalid AI output must preserve the editor.');
  assert.equal(app.previs.list(project.id).length, 0, 'Chatting must not start rendering.');
  await localPage.locator('#previs-chat-input').fill('请修复上次场景回复，给出完整场景。');
  await localPage.locator('#previs-chat-send').click();
  await localPage.locator('#previs-chat-apply').waitFor({ state: 'visible' });
  await localPage.locator('#previs-chat-apply').click();
  await localPage.waitForFunction(() => document.querySelector('#previs-message').textContent.includes('场景修改已应用'));
  assert.equal(app.previs.list(project.id).length, 0);
  assert.deepEqual(JSON.parse(await localPage.locator('#previs-spec').inputValue()), JSON.parse(JSON.stringify(parsePrevisSpec(JSON.stringify(spec)))));
  await localPage.locator(`#project-list [data-project-id="${second.id}"]`).click();
  await localPage.locator('#previs-tab').click();
  await localPage.locator('#previs-story-details > summary').click();
  await localPage.locator('#previs-story').fill('此工程独立保留的故事。');
  await localPage.locator(`#project-list [data-project-id="${project.id}"]`).click();
  await localPage.locator('#previs-tab').click();
  assert.match(await localPage.locator('#previs-story').inputValue(), /庭院相遇/);
  assert.equal(JSON.parse(await localPage.locator('#previs-spec').inputValue()).duration, 2);
  // A deliberate edit is retained across validation, navigation and reload.
  const edited = { ...spec, name: '网页确认后的庭院相遇' };
  await localPage.locator('#previs-spec-details > summary').click();
  await localPage.locator('#previs-spec').fill(JSON.stringify(edited, null, 2));
  await localPage.locator('#previs-validate').click();
  await localPage.waitForFunction(() => !document.querySelector('#previs-load-example').disabled);
  await localPage.locator('#previs-start').click();
  await until(() => app.previs.list(project.id)[0]?.state === 'done');
  await localPage.locator('#previs-job-list .previs-state.done').waitFor({ timeout: 15000 });
  await localPage.locator('[data-previs-preview-video]').click();
  const video = localPage.locator('#previs-job-list video');
  await localPage.waitForFunction(() => document.querySelector('#previs-job-list video')?.readyState >= 2);
  const playback = await video.evaluate(async element => { element.muted = true; await element.play(); return { width: element.videoWidth, height: element.videoHeight, duration: element.duration }; });
  assert.deepEqual(playback, { width: 640, height: 360, duration: 2 });
  await localPage.locator('[data-previs-action="discuss"]').click();
  await localPage.locator('#previs-chat-input').fill('先解释为什么第 1 秒人物看起来太远，不要修改。');
  await localPage.locator('#previs-chat-send').click();
  await localPage.waitForFunction(() => document.querySelector('#previs-chat-history').textContent.includes('当前第 1 秒镜头'));
  assert.equal(await localPage.locator('#previs-chat-proposal').isHidden(), true);
  await localPage.locator('#previs-chat-input').fill('现在请把镜头适当拉近，保留原有人物路线和最后同框。');
  await localPage.locator('#previs-chat-send').click();
  await localPage.locator('#previs-chat-proposal').waitFor({ state: 'visible' });
  const revisionRequest = modelRequests.at(-1);
  assert.match(revisionRequest.messages.at(-1).content, /网页确认后的庭院相遇/);
  assert.match(revisionRequest.messages.at(-1).content, /现在请把镜头适当拉近/);
  assert.ok(revisionRequest.messages.some(item => item.role === 'assistant' && item.content.includes('镜头与人物间距较远')));
  assert.equal(JSON.parse(await localPage.locator('#previs-spec').inputValue()).name, edited.name, 'Conversation must not replace the edited scene before approval.');
  assert.equal(app.previs.list(project.id).length, 1, 'Text dialogue must not trigger a Blender render.');
  await localPage.locator('#previs-chat-input').fill('还没有应用，请在刚才方案上再向左移动镜头一米。');
  await localPage.locator('#previs-chat-send').click();
  await localPage.waitForFunction(() => !document.querySelector('#previs-load-example').disabled);
  const pendingInput = modelRequests.at(-1).messages.at(-1).content;
  assert.match(pendingInput, /\"lens\":42/, 'A follow-up on a pending proposal uses that proposal.');
  assert.match(await localPage.locator('#previs-chat-changes').innerText(), /摄影机焦距/);
  assert.match(await localPage.locator('#previs-chat-changes').innerText(), /摄影机路线或注视点/, 'The visible difference includes all changes since the editor.');
  await localPage.locator('#previs-spec').fill(JSON.stringify({ ...edited, name: '用户正在手工修改' }, null, 2));
  assert.equal(await localPage.locator('#previs-chat-apply').isDisabled(), true, 'A proposal for an older editor state must not overwrite later edits.');
  await localPage.locator('#previs-spec').fill(JSON.stringify(edited, null, 2));
  await localPage.locator('#previs-chat-apply').click();
  assert.equal(JSON.parse(await localPage.locator('#previs-spec').inputValue()).name, '庭院相遇 · 对话修订');
  assert.ok(await localPage.locator('#previs-version-select option').count() > 0);
  assert.equal(app.previs.list(project.id).length, 1, 'Applying scene JSON must not render until the user starts it.');
  await localPage.reload();
  await localPage.locator('#previs-chat-history .assistant').first().waitFor();
  assert.equal(JSON.parse(await localPage.locator('#previs-spec').inputValue()).camera.lens, 42, 'Applied scene and dialogue survive a reload.');
  await localPage.locator('#previs-versions').evaluate(element => element.open = true);
  const originalVersion = await localPage.locator('#previs-version-select option').evaluateAll(elements => elements.find(element => element.textContent.includes('应用对话修改前')).value);
  await localPage.locator('#previs-version-select').selectOption(originalVersion);
  await localPage.locator('#previs-version-restore').click();
  assert.equal(JSON.parse(await localPage.locator('#previs-spec').inputValue()).name, edited.name, 'Version restoration returns the pre-revision scene.');
  const revisedVersion = await localPage.locator('#previs-version-select option').evaluateAll(elements => elements.find(element => element.textContent.includes('恢复旧版本前')).value);
  await localPage.locator('#previs-version-select').selectOption(revisedVersion);
  await localPage.locator('#previs-version-restore').click();
  assert.equal(JSON.parse(await localPage.locator('#previs-spec').inputValue()).camera.lens, 42);
  await localPage.locator('#previs-chat-input').fill('模拟不支持字段，请调整姿态。');
  await localPage.locator('#previs-chat-send').click();
  await localPage.waitForFunction(() => document.querySelector('#previs-chat-status').textContent.includes('场景检查未通过'));
  assert.equal(await localPage.locator('#previs-chat-proposal').isHidden(), true, 'Invalid scene data cannot be applied.');
  assert.equal(JSON.parse(await localPage.locator('#previs-spec').inputValue()).camera.lens, 42);
  assert.equal(app.previs.list(project.id).length, 1);
  await localPage.locator('#previs-versions').evaluate(element => element.open = false);
  await localPage.locator(`#project-list [data-project-id="${second.id}"]`).click();
  await localPage.locator('#previs-tab').click();
  assert.equal(await localPage.locator('#previs-job-list video').count(), 0, 'Switching project clears the prior playing preview.');
  await localPage.locator(`#project-list [data-project-id="${project.id}"]`).click();
  await localPage.locator('#previs-tab').click();
  await localPage.locator('#previs-job-list .previs-state.done').waitFor();
  assert.equal(JSON.parse(await localPage.locator('#previs-spec').inputValue()).name, '庭院相遇 · 对话修订', 'Revision survives project switching.');
  assert.match(await localPage.locator('#previs-chat-history').innerText(), /镜头与人物间距较远/);
  await localPage.locator('#previs-spec-details').evaluate(element => element.open = false);
  await localPage.screenshot({ path: path.join(output, 'local-desktop.png'), fullPage: true });
  const downloadPromise = localPage.waitForEvent('download');
  await localPage.getByRole('link', { name: '下载 Blender 工程', exact: true }).click();
  const download = await downloadPromise; await download.saveAs(path.join(output, 'downloaded-scene.blend'));
  assert.equal((await readFile(path.join(output, 'downloaded-scene.blend'))).subarray(0, 7).toString(), 'BLENDER');
  await localPage.locator('[data-previs-action="place"]').click();
  await until(async () => (await saved()).graph.nodes.some(node => node.assetId === app.previs.list(project.id)[0].videoAssetId));
  await localPage.locator('#previs-tab').click();
  await localPage.locator('[data-previs-action="reference"]').click();
  await until(async () => (await saved()).scenes.some(scene => scene.references.some(reference => reference.assetId === app.previs.list(project.id)[0].videoAssetId)));
  assert.equal(app.store.state.jobs.length, 0, 'Creating a video reference must not submit a paid video job.');
  await localPage.locator('#previs-tab').click();
  await localPage.locator('#theme-select').selectOption('night');
  await localPage.screenshot({ path: path.join(output, 'local-desktop-night.png'), fullPage: true });
  await localPage.setViewportSize({ width: 390, height: 844 });
  await localPage.screenshot({ path: path.join(output, 'local-mobile.png'), fullPage: true });
  assert.ok(await localPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile previs overflows.');
  await localPage.close();

  // Only website resources are proxied. Loopback requests go directly from Edge to
  // the real helper with the HTTPS page's Origin and the normal CORS/LNA rules.
  helper = await createBlenderHelper({ root: path.join(temporary, 'helper'), previs: { detectTools: async () => detected } });
  // Use an isolated port so this check never interrupts an already running helper.
  // Replace only the helper address in the served module and its matching CSP.
  const helperEndpoint = await helper.start(0);
  const remoteContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let localNetworkPermission = 'browser default';
  try { await remoteContext.grantPermissions(['local-network-access'], { origin: remoteOrigin }); localNetworkPermission = 'granted through Edge browser permission'; }
  catch { /* Older Edge versions allow loopback using ordinary secure-context rules. */ }
  await remoteContext.addInitScript(id => { localStorage.setItem('jingce-active-project', id); localStorage.setItem('jingce-active-view', 'previs'); }, project.id);
  await remoteContext.route(remoteOrigin + '/**', async route => {
    const request = route.request(), parsed = new URL(request.url()), headers = await request.allHeaders();
    delete headers.host;
    try {
      const response = await route.fetch({ url: url + parsed.pathname + parsed.search, headers }), responseHeaders = response.headers();
      if (responseHeaders['content-security-policy']) responseHeaders['content-security-policy'] = responseHeaders['content-security-policy'].replaceAll('http://127.0.0.1:18973', helperEndpoint);
      await route.fulfill({ response, headers: responseHeaders, ...(parsed.pathname === '/previs.js' ? { body: (await response.text()).replaceAll('http://127.0.0.1:18973', helperEndpoint) } : {}) });
    }
    catch (error) { failures.push({ url: request.url(), error: error.message }); await route.abort(); }
  });
  remotePage = await remoteContext.newPage(); monitor(remotePage);
  remotePage.on('request', request => { if (request.url().startsWith(helperEndpoint + '/api/')) bridgeRequests.push({ route: new URL(request.url()).pathname, method: request.method() }); });
  await remotePage.goto(remoteOrigin);
  await remotePage.locator('#previs-helper-panel').waitFor();
  assert.equal(await remotePage.locator('#previs-use-helper').isChecked(), true);
  assert.equal(await remotePage.locator('#previs-use-helper').isDisabled(), true);
  const popupEvent = remotePage.waitForEvent('popup');
  await remotePage.locator('#previs-connect').click();
  const popup = await popupEvent; monitor(popup);
  await popup.locator('#approve').waitFor();
  assert.equal(await popup.locator('#website').innerText(), remoteOrigin);
  await popup.locator('#approve').click();
  await remotePage.waitForFunction(() => !document.querySelector('#previs-start').disabled, { timeout: 20000 });
  await popup.screenshot({ path: path.join(output, 'helper-authorized.png'), fullPage: true });
  await popup.close();
  await remotePage.locator('#previs-spec-details').evaluate(element => element.open = true);
  await remotePage.locator('#previs-spec').fill(JSON.stringify(spec, null, 2));
  await remotePage.locator('#previs-start').click();
  await until(() => app.previs.list(project.id).some(job => job.mode === 'helper' && job.localJobId));
  const remoteJobId = app.previs.list(project.id).find(job => job.mode === 'helper').id;
  await remotePage.reload();
  await until(() => app.previs.get(remoteJobId).state === 'done', 240000);
  await remotePage.locator(`[data-previs-job="${remoteJobId}"] .previs-state.done`).waitFor({ timeout: 15000 });
  const remoteJob = app.previs.get(remoteJobId), localJob = helper.previs.get(remoteJob.localJobId);
  assert.equal(localJob.state, 'done'); assert.equal(localJob.report.decodedFrames, 24);
  assert.equal(localJob.attempts, 1, 'Reload must recover the original render.');
  assert.equal(app.previs.list(project.id).filter(job => job.mode === 'helper').length, 1);
  assert.equal((await readFile(app.previs.artifact(remoteJobId, 'video').filename)).equals(await readFile(helper.previs.artifact(localJob.id, 'video').filename)), true);
  await remotePage.locator(`[data-previs-preview-video="${remoteJobId}"]`).click();
  await remotePage.waitForFunction(id => document.querySelector(`[data-previs-job="${id}"] video`)?.readyState >= 2, remoteJobId);
  const remotePlayback = await remotePage.locator(`[data-previs-job="${remoteJobId}"] video`).evaluate(async element => { element.muted = true; await element.play(); return { width: element.videoWidth, height: element.videoHeight, duration: element.duration }; });
  assert.deepEqual(remotePlayback, playback);
  await remotePage.locator(`[data-previs-job="${remoteJobId}"] [data-previs-action="discuss"]`).click();
  await remotePage.locator('#previs-chat-input').fill('第 1 秒镜头太远，请收紧构图，保留其它部分。');
  await remotePage.locator('#previs-chat-send').click();
  await remotePage.locator('#previs-chat-proposal').waitFor({ state: 'visible' });
  assert.match(modelRequests.at(-1).messages.at(-1).content, /第 1 秒镜头太远/);
  assert.equal(app.previs.list(project.id).filter(job => job.mode === 'helper').length, 1, 'Website dialogue must not create another Blender task.');
  await remotePage.reload();
  await remotePage.locator('#previs-chat-proposal').waitFor({ state: 'visible' });
  await remotePage.locator('#previs-chat-apply').click();
  assert.equal(JSON.parse(await remotePage.locator('#previs-spec').inputValue()).camera.lens, 42);
  await remotePage.locator('#previs-start').click();
  await until(() => app.previs.list(project.id).filter(job => job.mode === 'helper').length === 2);
  const revisedJobId = app.previs.list(project.id).find(job => job.mode === 'helper' && job.id !== remoteJobId).id;
  await until(() => app.previs.get(revisedJobId).state === 'done', 240000);
  await remotePage.locator(`[data-previs-job="${revisedJobId}"] .previs-state.done`).waitFor({ timeout: 15000 });
  const revisedJob = app.previs.get(revisedJobId);
  assert.equal(revisedJob.spec.camera.lens, 42);
  assert.equal(app.previs.get(remoteJobId).spec.camera.lens, spec.camera.lens, 'Original result keeps its original scene.');
  assert.equal(revisedJob.report.decodedFrames, 24);
  await remotePage.locator('#previs-job-list video').evaluateAll(elements => elements.forEach(element => element.pause()));
  await remotePage.screenshot({ path: path.join(output, 'website-https-desktop.png'), fullPage: true });
  await remotePage.locator('#theme-select').selectOption('night');
  await remotePage.screenshot({ path: path.join(output, 'website-https-night.png'), fullPage: true });
  await remotePage.setViewportSize({ width: 390, height: 844 });
  await remotePage.screenshot({ path: path.join(output, 'website-https-mobile.png'), fullPage: true });
  assert.ok(await remotePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile website overflows.');
  assert.deepEqual(errors, []);
  assert.equal(localRenderCount, 1); assert.equal(modelRequests.length, 7); assert.equal(invalidReply, true); assert.equal(app.store.state.jobs.length, 0);
  assert.ok(bridgeRequests.some(request => request.route === '/api/previs/jobs' && request.method === 'POST'));
  const report = { browser: browser.version(), origin: remoteOrigin, helperEndpoint, localNetworkPermission,
    actualHelperRender: localJob.report, actualRevisedHelperRender: revisedJob.report, websiteJobCount: app.previs.list(project.id).length,
    assets: (await saved()).assets.length, copiedMediaUiRuns: localRenderCount, simulatedTextRequests: modelRequests.length,
    paidVideoRequests: app.store.state.jobs.length, errors, requestFailures: failures, bridgeRequests,
    verified: ['AI raw reply editing and confirmation', 'per-project drafts', 'multi-turn discussion, cumulative proposal differences, stale edit protection', 'draft reload, scene version restoration and invalid reply rejection', 'real Blender render from revised scene through HTTPS helper', 'local result playback and Blender download', 'canvas and editable video reference',
      'HTTPS browser origin authorization', 'direct browser-to-helper CORS', 'real Blender rendering through helper', 'reload recovers original task',
      'binary upload to website and asset registration', 'desktop/mobile and day/night layout'],
    limitation: 'The HTTPS website origin is intercepted locally by Playwright. A deployed domain and production reverse proxy still require acceptance testing.' };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  for (const [name, page] of [['local', localPage], ['website', remotePage]]) if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(output, name + '-failure.png'), fullPage: true }).catch(() => {});
    console.error(name, JSON.stringify(await page.locator('#previs-message').textContent().catch(() => ''), null, 2));
  }
  console.error(JSON.stringify({ errors, failures }, null, 2)); throw error;
} finally {
  await browser?.close(); await helper?.close(); await app?.close();
  assert.ok(temporary.startsWith(path.join(os.tmpdir(), 'jingce-previs-browser-')));
  await rm(temporary, { recursive: true, force: true });
}
