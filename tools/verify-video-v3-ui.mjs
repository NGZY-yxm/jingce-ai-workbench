import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStudio } from '../server.mjs';
import { CARD_SIZE_VERSION } from '../public/canvas-layout.js';

// A temporary studio, fake credentials and a mock video platform. Never reads
// the user's runtime or submits a real image/video/text generation request.
const { chromium } = await import(process.env.JINGCE_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.JINGCE_PLAYWRIGHT_MODULE).href : 'playwright');
const output = path.resolve(process.argv[2] || 'deliveries/video-v3-ui-20261010');
const root = await mkdtemp(path.join(tmpdir(), 'jingce-video-v3-ui-'));
const ids = ['seedance-2.0-933-720P（秒）', 'seedance-2.0-fast-933-720P（次）',
  'seedance-2.0-mini-903-720P（次）', 'seedance-2.5-301010-1K（秒）', 'minimax-h3-933-2K（次）'];
const catalogCalls = [], submissions = [], errors = [], external = [];
const report = { checks: [], screenshots: [], mockSubmissions: 0, realGenerationRequests: 0 };
const checkpoint = name => { report.checks.push(name); console.log('PASS ' + name); };
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const app = await createStudio({ root, imageCatalog: [], textCatalog: [], tools: { ready: false },
  videoFetcher: async (url, options) => {
    if (url.endsWith('/v1/models')) {
      catalogCalls.push(options.headers.Authorization);
      return response({ data: (options.headers.Authorization.includes('second') ? ids.slice(0, 3) : ids).map(id => ({ id })) });
    }
    if (options.method === 'POST') {
      submissions.push(JSON.parse(options.body));
      return response({ id: 'mock-ui-task', status: 'queued' });
    }
    return response({ id: 'mock-ui-task', status: 'running', progress: 50 });
  }, integrations: { verifyReferences: async () => {} } });
const url = await app.start(0), bootstrap = await (await fetch(url + '/api/bootstrap')).json();
const send = async (route, method, body) => {
  const result = await fetch(url + route, { method, headers: { 'X-Studio-Token': bootstrap.token,
    'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.ok(result.ok, await result.clone().text()); return result.json();
};
let browser;
try {
  await mkdir(output, { recursive: true });
  let project = await send('/api/projects', 'POST', { title: '新版视频 · 界面验证' });
  const references = [];
  const fixtures = [
    ['image', '人物参考.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6AAAAABJRU5ErkJggg==', 'base64')],
    ['video', '运镜参考.mp4', (() => { const b = Buffer.alloc(128); b.write('ftyp', 4); return b; })()],
    ['audio', '声音参考.wav', (() => { const b = Buffer.alloc(80); b.write('RIFF', 0); b.writeUInt32LE(72, 4); b.write('WAVEfmt ', 8);
      b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
      b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(36, 40); return b; })()],
  ];
  for (const [kind, name, bytes] of fixtures) {
    const result = await fetch(url + '/api/projects/' + project.id + '/assets', { method: 'POST',
      headers: { 'X-Studio-Token': bootstrap.token, 'X-File-Name': encodeURIComponent(name) }, body: bytes });
    assert.equal(result.status, 201); const uploaded = await result.json(); project = uploaded.project;
    references.push({ assetId: uploaded.asset.id, kind, name, refId: 'ref-' + kind,
      publicUrl: 'https://media.example.org/' + kind + (kind === 'image' ? '.png' : kind === 'audio' ? '.wav' : '.mp4'),
      role: 'reference_' + kind, note: '' });
  }
  project = await send('/api/projects/' + project.id, 'PATCH', { revision: project.revision,
    scenes: [
      { id: 'main', title: '新版参考镜头', videoPrompt: '原创人物沿海边行走。', videoModel: ids[1], generationDuration: 5, generationCount: 1,
        resolution: '720p', ratio: '16:9', references },
      { id: 'old', title: '历史模型镜头', videoPrompt: '保留旧镜头。', videoModel: 'seedance-2.5-900', references: [] },
    ], graph: { cardSizeVersion: CARD_SIZE_VERSION, groups: [],
      links: references.map(reference => ({ id: 'link-' + reference.kind, from: 'source-' + reference.kind, to: 'shot-main' })),
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        ...references.map((reference, index) => ({ id: 'source-' + reference.kind, kind: reference.kind,
          assetId: reference.assetId, assetName: reference.name, label: reference.name,
          x: 40, y: 40 + index * 345, width: 260, height: 300 })),
        { id: 'shot-main', kind: 'video', label: '新版参考镜头', sceneId: 'main', x: 400, y: 80, width: 340, height: 320 },
      ] } });
  assert.equal(project.scenes[0].references.find(reference => reference.kind === 'audio').nodeId, 'source-audio');
  assert.equal(project.scenes[0].references.find(reference => reference.kind === 'audio').role, 'reference_audio');
  browser = await chromium.launch({ channel: process.env.JINGCE_BROWSER_CHANNEL || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  const page = await context.newPage(); page.setDefaultTimeout(9000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(url) && /^https?:/.test(request.url())) external.push(request.url()); });
  const screenshot = async name => {
    await page.waitForFunction(() => !document.querySelector('#toast').classList.contains('visible'), null, { timeout: 12000 });
    const filename = name + '.png'; await page.screenshot({ path: path.join(output, filename), fullPage: true }); report.screenshots.push(filename);
  };
  await page.goto(url); await page.locator('#connection-button').click();
  await page.locator('#settings-form [name=apiKey]').fill('mock-first-key');
  await page.locator('#refresh-models').click();
  await page.waitForFunction(() => document.querySelector('#connection-message').textContent.includes('已读取 5 个'));
  assert.equal(catalogCalls.length, 2); assert.ok(catalogCalls.every(key => key === 'Bearer mock-first-key'));
  assert.equal(await page.locator('#settings-form [name=apiKey]').inputValue(), '');
  await screenshot('connection'); await page.locator('#close-settings').click();
  checkpoint('输入密钥后刷新目录使用刚保存的密钥，完整 ID 可见且不回显密钥');

  await page.locator('#videos-tab').click();
  const main = page.locator('[data-scene-id="main"]'), old = page.locator('[data-scene-id="old"]');
  assert.equal(await main.locator('.cost-line strong').textContent(), '费用待平台确认');
  assert.equal(await main.locator('[data-scene-action="generate"]').isEnabled(), true);
  assert.match(await old.locator('[data-scene-field="videoModel"] option:checked').textContent(), /已不可选，请重新选择/);
  assert.equal(await old.locator('[data-scene-action="generate"]').isDisabled(), true);
  assert.equal(await main.locator('audio').count(), 1);
  const prompt = main.locator('[data-reference-prompt]'); await prompt.fill('沿海边行走，参考@');
  await main.locator('[role="option"]').filter({ hasText: '@音频1' }).click();
  assert.match(await prompt.inputValue(), /@音频1/);
  checkpoint('视频页显示音频播放器和 @音频1 菜单，未知报价允许提交，历史模型需重新选择');
  await main.locator('[data-reference-role="0"]').selectOption('first_frame');
  assert.equal(await main.locator('[data-scene-action="generate"]').isDisabled(), true);
  assert.match(await main.locator('[data-reference-validation]').textContent(), /音频|首尾帧/);
  await screenshot('first-frame-audio-conflict');
  await main.locator('[data-reference-role="0"]').selectOption('reference_image');
  await main.locator('[data-scene-field="videoModel"]').selectOption(ids[2]);
  assert.equal(await main.locator('[data-scene-field="resolution"]').inputValue(), '480p');
  assert.equal(await main.locator('[data-scene-field="generationDuration"]').inputValue(), '5');
  await main.locator('[data-scene-field="videoModel"]').selectOption(ids[1]);
  await screenshot('video-page');
  checkpoint('首帧与音频冲突在提交前阻止，Mini 默认 480p / 5 秒，模型切换同步参数');

  await page.locator('#canvas-tab').click();
  const card = page.locator('[data-node-id="shot-main"]');
  await card.hover(); await card.locator('[data-reference-prompt]').focus();
  await card.locator('[data-canvas-reference-role]').waitFor({ state: 'visible' });
  assert.match(await card.locator('.shot-references').textContent(), /音频1/);
  assert.equal(await card.locator('.shot-estimate strong').textContent(), '费用待平台确认');
  const bounds = await card.locator('.canvas-reference-role').evaluate(element => {
    const row = element.getBoundingClientRect(), list = element.closest('.shot-reference-list').getBoundingClientRect();
    return { right: row.right, listRight: list.right, width: row.width };
  });
  assert.ok(bounds.width > 160 && bounds.right <= bounds.listRight + 1, JSON.stringify(bounds));
  await card.locator('[data-canvas-reference-role]').selectOption('last_frame');
  assert.equal(await card.locator('[data-card-action="generate"]').isDisabled(), true);
  await screenshot('canvas-conflict');
  await card.locator('[data-canvas-reference-role]').selectOption('reference_image');
  await screenshot('canvas-ready');
  checkpoint('画布音频引用、图片用途和未知费用显示正确，角色行无横向溢出，尾帧音频冲突阻止生成');

  await page.waitForFunction(() => document.querySelector('#save-state').textContent === '已保存到本机');
  await page.reload(); await page.locator('#videos-tab').click();
  await main.locator('audio').waitFor();
  assert.match(await main.locator('[data-reference-prompt]').inputValue(), /@音频1/);
  const saved = await (await fetch(url + '/api/projects/' + project.id)).json();
  const savedAudio = saved.scenes?.find(scene => scene.id === 'main')?.references;
  assert.ok(Array.isArray(savedAudio));
  const voice = savedAudio.find(reference => reference.kind === 'audio');
  assert.equal(voice.nodeId, 'source-audio'); assert.equal(voice.role, 'reference_audio');
  assert.equal(voice.assetId, references[2].assetId);
  checkpoint('图片视频音频素材连线经服务校验保存，刷新后音频连接、角色和 @ 引用仍绑定原素材');

  await main.locator('[data-scene-action="generate"]').click();
  await page.waitForFunction(() => document.querySelector('[data-scene-id="main"] [data-scene-action="generate"]').textContent.includes('再次生成'));
  for (let i = 0; i < 200 && submissions.length !== 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(submissions.length, 1); assert.equal(submissions[0].model, ids[1]); assert.equal(submissions[0].content.length, 4);
  assert.deepEqual(submissions[0].content.slice(1).map(item => item.type), ['image_url', 'video_url', 'audio_url']);
  assert.equal(submissions[0].content[3].name, '音频1');
  assert.equal(app.store.state.jobs[0].estimate, null);
  checkpoint('浏览器生成动作通过本地服务发送一次模拟 POST，图片视频音频均进入 content，未知费用保留 null');
  await page.locator('#connection-button').click();
  await page.locator('#settings-form [name=apiKey]').fill('mock-second-key'); await page.locator('#refresh-models').click();
  await page.waitForFunction(() => document.querySelector('#connection-message').textContent.includes('已读取 3 个'));
  assert.ok(catalogCalls.slice(-2).every(key => key === 'Bearer mock-second-key'));
  const original = await app.store.videoTaskSettings(app.store.state.jobs[0]); assert.equal(original.apiKey, 'mock-first-key');
  assert.equal((await (await fetch(url + '/api/bootstrap')).json()).catalog.length, 3);
  checkpoint('更换密钥后目录随当前密钥刷新，已提交任务保留原密钥');
  await page.locator('#close-settings').click();
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  report.mockSubmissions = submissions.length; report.browserErrors = errors; report.externalRequests = external;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, ...report }));
} finally {
  await browser?.close(); await app.close(); await rm(root, { recursive: true, force: true });
}
