import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTextMarkdown } from '../public/text-markdown.js';

const table = '| 镜头 | 时长 |\n| :--- | ---: |\n| **开场** | 3 秒 |\n| 转场 | 5 秒 |';

test('标准 Markdown 表格生成可访问的表头、数据行和横向滚动容器', () => {
  const html = renderTextMarkdown(table);
  assert.match(html, /<div class="text-markdown-table" tabindex="0" role="region" aria-label="表格"><table>/);
  assert.match(html, /<thead>[\s\S]*<th scope="col" class="text-markdown-align-left">镜头<\/th>/);
  assert.match(html, /<th scope="col" class="text-markdown-align-right">时长<\/th>/);
  assert.match(html, /<tbody>[\s\S]*<td class="text-markdown-align-left"><strong>开场<\/strong><\/td>/);
  assert.equal((html.match(/<tr>/g) || []).length, 3);
  assert.equal((html.match(/<td\b/g) || []).length, 4);
  assert.doesNotMatch(html, /\| :---|---: \|/);
});

test('表格支持无外围竖线、居中、转义竖线、代码和单元格内换行', () => {
  const html = renderTextMarkdown('字段 | 内容\n:---: | ---\n编号 | a\\|b 与 `x\\|y`<br>下一行');
  assert.match(html, /class="text-markdown-align-center">字段/);
  assert.match(html, /a\|b 与 <code>x\|y<\/code><br>下一行/);
  assert.equal((html.match(/<td\b/g) || []).length, 2);
});

test('缺少分隔行、全角竖线和普通竖线文本保持为文字', () => {
  for (const source of ['| 镜头 | 时长 |\n| 开场 | 3 秒 |', '｜镜头｜时长｜\n｜---｜---｜', 'A | B 不代表表格']) {
    const html = renderTextMarkdown(source);
    assert.doesNotMatch(html, /<table\b/);
    assert.match(html, /镜头|A \| B/);
  }
});

test('围栏和缩进代码块内的表格不解析，代码中的 HTML 不执行', () => {
  for (const source of ['```markdown\n' + table + '\n<script>alert(1)</script>\n```',
    table.split('\n').map(line => '    ' + line).join('\n')]) {
    const html = renderTextMarkdown(source);
    assert.match(html, /<pre><code/);
    assert.doesNotMatch(html, /<table\b|<script\b/);
    assert.match(html, /\| 镜头 \| 时长 \|/);
  }
});

test('普通段落换行、紧凑标题、粗体、列表、引用和任务清单仍正常显示', () => {
  const html = renderTextMarkdown('# 创作方案\n\n第一行\n第二行 **重点** *补充* ~~删除~~ `原文`\n\n- 镜头一\n- 镜头二\n\n1. 准备\n2. 拍摄\n\n> 备注\n\n- [x] 已确认');
  for (const expected of ['<h1>创作方案</h1>', '第一行<br>第二行', '<strong>重点</strong>', '<em>补充</em>',
    '<del>删除</del>', '<code>原文</code>', '<ul>', '<li>镜头一</li>', '<ol>', '<blockquote>', 'type="checkbox"']) {
    assert.ok(html.includes(expected), expected);
  }
  assert.match(html, /disabled[^>]*type="checkbox"|type="checkbox"[^>]*disabled/);
});

test('HTML、事件属性、脚本、嵌入媒体和原始 HTML 表格只能显示为文字', () => {
  const sources = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<svg onload=alert(1)><foreignObject>test</foreignObject></svg>',
    '<iframe src="https://example.com"></iframe>', '<style>body{display:none}</style>',
    '<table><tr><td onclick="alert(1)">内容</td></tr></table>', '<br onmouseover="alert(1)">',
    '文字 <a href="javascript:alert(1)">链接</a>', '<textarea><img src=x onerror=alert(1)></textarea>',
  ];
  for (const source of sources) {
    const html = renderTextMarkdown(source);
    assert.doesNotMatch(html, /<(?:script|img|svg|foreignObject|iframe|style|table|textarea|a)\b|<br\s+on/i, source);
    assert.match(html, /&lt;/, source);
  }
  assert.match(renderTextMarkdown('内容<br/>换行'), /内容<br>换行/);
  assert.match(renderTextMarkdown('| 字段 |\n|---|\n| <img src=x onerror=alert(1)> |'), /&lt;img/);
});

test('危险链接、本地 API 链接和带凭据链接不生成可点击地址', () => {
  for (const href of ['javascript:alert(1)', 'java&#x73;cript:alert(1)', 'data:text/html,test', 'vbscript:test',
    'file:///C:/secret.txt', '/api/assets/private', '//example.com/path', 'https://user:password@example.com/',
    'https://example.com/\u0009bad', 'https://example.com/"onclick="alert(1)']) {
    const html = renderTextMarkdown(`[**链接**](<${href}>)`);
    assert.doesNotMatch(html, /<a\b[^>]*href="(?:javascript|data|vbscript|file|\/)|<a\b[^>]*\s(?:onclick|onerror)=/i, href);
    if (!href.includes('"')) assert.doesNotMatch(html, /<a\b/, href);
  }
});

test('外部 HTTP/HTTPS 链接在新标签页打开并隔离来源与窗口权限', () => {
  const html = renderTextMarkdown('[**官网**](https://example.com/a?q=1&v=2 "说明\\\"文字")');
  assert.match(html, /href="https:\/\/example.com\/a\?q=1&amp;v=2"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /<strong>官网<\/strong>/);
  assert.match(html, /title="说明&quot;文字"/);
  assert.doesNotMatch(html, /title="说明"文字/);
});

test('模型输出的 Markdown 图片只保留说明，不加载远程图片或本地资源', () => {
  for (const href of ['https://example.com/tracker.png', '/api/assets/private', 'data:image/svg+xml,test']) {
    const html = renderTextMarkdown(`![人物参考](<${href}>)`);
    assert.match(html, /人物参考/);
    assert.doesNotMatch(html, /<(?:img|video|audio)\b|src=/);
  }
});

test('空文本、特殊字符和重复渲染不修改源文字或污染下一条回复', () => {
  assert.equal(renderTextMarkdown(null), '');
  assert.equal(renderTextMarkdown(''), '');
  assert.match(renderTextMarkdown('A < B & C > D'), /A &lt; B &amp; C &gt; D/);
  const before = renderTextMarkdown(table);
  renderTextMarkdown('<script>bad</script>');
  assert.equal(renderTextMarkdown(table), before);
  assert.equal(table, '| 镜头 | 时长 |\n| :--- | ---: |\n| **开场** | 3 秒 |\n| 转场 | 5 秒 |');
});
