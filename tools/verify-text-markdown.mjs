import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStudio } from '../server.mjs';
import { createProject } from '../lib/workflow.mjs';

// Uses an isolated server and browser history; all API traffic is mocked.
const modulePath = process.env.JINGCE_PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const output = path.resolve(process.argv[2] || 'deliveries/text-markdown-ui-check');
const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-text-markdown-browser-'));
const app = await createStudio({ root, catalog: [], imageCatalog: [], textCatalog: [], tools: { ready: false } });
const url = await app.start(0);
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.JINGCE_BROWSER_CHANNEL ? { channel: process.env.JINGCE_BROWSER_CHANNEL } : {}) });
  await mkdir(output, { recursive: true });
  const project = createProject({ title: '雨夜书店 · 分镜表格' });
  const content = [
    '### 分镜方案',
    '',
    '| 镜头 | 时长 | 景别 | 画面动作 | 运镜 | 旁白 | 声音 |',
    '| :--- | ---: | :---: | --- | --- | --- | --- |',
    '| **01 开场** | 3 秒 | 全景 | 雨夜，书店橱窗亮着暖光。行人从画面右侧走过。 | 缓慢推近 | 每一盏灯，都在等一个故事。 | 雨声、脚步声 |',
    '| 02 相遇 | 5 秒 | 中景 | 女主推门进入，收起雨伞，抬头看向书架。<br>店主微笑示意。 | 跟随人物平移 | 今晚，故事从这里开始。 | 门铃、轻柔钢琴 |',
    '| 03 结尾 | 4 秒 | 特写 | 指尖停在一本旧书的书脊上，镜头慢慢抬起。 | 从手部向上摇镜 | 让相遇，有迹可循。 | 翻书声 |',
    '',
    '**重点**：人物、动作与光线保持连贯。',
    '',
    '- 保留雨夜氛围',
    '- 避免突然切换人物造型',
    '',
    '```markdown',
    '| 原始示例 | 保持代码 |',
    '|---|---|',
    '```',
  ].join('\n');
  const unsafe = '<script>window.markdownInjected=true</script>\n\n<img src="https://example.com/tracker.png" onerror="window.markdownInjected=true">\n\n[危险链接](javascript:alert(1))\n\n![不自动加载](https://example.com/pixel.png)';
  const history = [{ role: 'user', content: '请把这个故事整理成分镜表格。' }, { role: 'assistant', content }, { role: 'assistant', content: unsafe }];
  const bootstrap = { appId: 'jingce-ad-studio', token: 'a'.repeat(64), projects: [project], deletedProjects: [],
    settings: { text: { hasKey: true, textModel: 'local-preview' }, image: {} },
    catalog: [], imageCatalog: [], textCatalog: [{ name: 'local-preview' }], tools: { ready: false }, kinds: {} };
  const report = [];
  for (const [name, viewport] of [['desktop', { width: 1536, height: 1000 }], ['mobile', { width: 390, height: 844 }], ['small-mobile', { width: 320, height: 740 }]]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [], writes = [], external = [], badResponses = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(url)) external.push(request.url()); });
    page.on('response', response => { if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url() }); });
    await page.route('**/api/**', async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      if (request.method() !== 'GET') {
        writes.push({ pathname, method: request.method() });
        await route.fulfill({ status: 403, json: { error: 'Browser verification never submits generation or saves user data.' } });
        return;
      }
      const data = pathname === '/api/bootstrap' ? bootstrap : pathname === '/api/projects' ? [project]
        : pathname === `/api/projects/${project.id}` ? project : [];
      await route.fulfill({ json: data });
    });
    await page.addInitScript(({ projectId, messages }) => {
      localStorage.setItem('jingce-active-project', projectId);
      localStorage.setItem('jingce-text-chat-history:' + projectId, JSON.stringify(messages));
      localStorage.setItem('jingce-theme', 'night');
    }, { projectId: project.id, messages: history });
    await page.goto(url);
    await page.locator('#project-title').waitFor();
    await page.locator('.tab[data-view="text"]').click();
    const table = page.locator('#text-chat-messages table');
    await table.waitFor();
    assert.equal(await table.count(), 1);
    assert.equal(await table.locator('th').count(), 7);
    assert.equal(await table.locator('tbody tr').count(), 3);
    assert.equal(await page.locator('.text-chat-message-content pre code').count(), 1);
    assert.equal(await page.locator('.text-chat-message-content script, .text-chat-message-content img, .text-chat-message-content iframe').count(), 0);
    assert.equal(await page.locator('.text-chat-message-content a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => Boolean(window.markdownInjected)), false);
    const originalHistory = await page.evaluate(projectId => localStorage.getItem('jingce-text-chat-history:' + projectId), project.id);
    assert.deepEqual(JSON.parse(originalHistory), history);
    for (const theme of ['night', 'day']) {
      await page.locator('#theme-select').selectOption(theme);
      await page.evaluate(() => { document.querySelector('#text-chat-messages').scrollTop = 0; });
      await page.locator('#text-chat-card').scrollIntoViewIfNeeded();
      const metrics = await page.evaluate(() => {
        const scroll = document.querySelector('.text-markdown-table');
        const messages = document.querySelector('#text-chat-messages');
        const bubble = scroll.closest('.text-chat-message').getBoundingClientRect();
        const bounds = scroll.getBoundingClientRect();
        scroll.scrollLeft = scroll.scrollWidth;
        return { viewport: innerWidth, pageWidth: document.documentElement.scrollWidth,
          messagesWidth: messages.clientWidth, messagesScrollWidth: messages.scrollWidth,
          tableWidth: scroll.clientWidth, tableScrollWidth: scroll.scrollWidth, scrollLeft: scroll.scrollLeft,
          withinBubble: bounds.left >= bubble.left && bounds.right <= bubble.right,
          headerBackground: getComputedStyle(scroll.querySelector('th')).backgroundColor,
          bodyColor: getComputedStyle(scroll.querySelector('td')).color };
      });
      assert.ok(metrics.pageWidth <= viewport.width + 1, `${name} ${theme} page overflow: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.messagesScrollWidth <= metrics.messagesWidth + 1, `${name} ${theme} message overflow`);
      assert.ok(metrics.withinBubble, `${name} ${theme} table outside message`);
      if (metrics.tableScrollWidth > metrics.tableWidth) assert.ok(metrics.scrollLeft > 0, `${name} ${theme} table should scroll`);
      if (name !== 'desktop') assert.ok(metrics.tableScrollWidth > metrics.tableWidth, `${name} ${theme} wide table should scroll on mobile`);
      await page.evaluate(() => { document.querySelector('.text-markdown-table').scrollLeft = 0; });
      await page.locator('#text-chat-card').screenshot({ path: path.join(output, `${name}-${theme}.png`) });
      report.push({ viewport: name, theme, ...metrics });
    }
    const wide = await page.evaluate(async () => {
      const { renderTextMarkdown } = await import('/text-markdown.js');
      const columns = Array.from({ length: 16 }, (_, index) => '字段 ' + (index + 1));
      const markdown = [columns.join(' | '), columns.map(() => '---').join(' | '), columns.map(() => '长内容' + 'x'.repeat(300)).join(' | ')].join('\n');
      document.querySelector('.text-chat-message.assistant .text-chat-message-content').innerHTML = renderTextMarkdown(markdown);
      const scroll = document.querySelector('.text-markdown-table');
      scroll.scrollLeft = scroll.scrollWidth;
      return { pageWidth: document.documentElement.scrollWidth,
        tableWidth: scroll.clientWidth, tableScrollWidth: scroll.scrollWidth, scrollLeft: scroll.scrollLeft,
        messagesWidth: document.querySelector('#text-chat-messages').clientWidth,
        messagesScrollWidth: document.querySelector('#text-chat-messages').scrollWidth };
    });
    assert.ok(wide.pageWidth <= viewport.width + 1, `${name} 16-column page overflow`);
    assert.ok(wide.messagesScrollWidth <= wide.messagesWidth + 1, `${name} 16-column message overflow`);
    assert.ok(wide.tableScrollWidth > wide.tableWidth && wide.scrollLeft > 0, `${name} 16-column table cannot scroll`);
    report.push({ viewport: name, fixture: '16-column-long-content', ...wide });
    await page.evaluate(async content => {
      const { renderTextMarkdown } = await import('/text-markdown.js');
      document.querySelector('.text-chat-message.assistant .text-chat-message-content').innerHTML = renderTextMarkdown(content);
    }, content);
    await page.evaluate(() => {
      const cell = document.querySelector('.text-markdown-table td');
      const range = document.createRange(); range.selectNodeContents(cell);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await page.locator('#text-selection-actions').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => getSelection().toString()), '01 开场');
    assert.deepEqual(errors, [], `${name} browser errors`);
    assert.deepEqual(writes, [], `${name} unexpected POST/PUT`);
    assert.deepEqual(external, [], `${name} unexpected external request`);
    assert.deepEqual(badResponses, [], `${name} HTTP failures`);
    await context.close();
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, viewports: 3, themes: 2, paidRequests: 0, report: path.join(output, 'report.json') }));
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
