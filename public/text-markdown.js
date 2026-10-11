import { Marked, Renderer } from './marked.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function externalHref(value) {
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

class ChatRenderer extends Renderer {
  html({ text }) {
    // Only a bare line break is allowed; model-supplied HTML stays literal.
    return /^<br\s*\/?>$/i.test(text) ? '<br>' : escapeHtml(text).replace(/\r\n?|\n/g, '<br>');
  }

  link({ href, title, tokens }) {
    const label = this.parser.parseInline(tokens);
    const target = externalHref(href);
    if (!target) return label;
    return `<a href="${escapeHtml(target)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${escapeHtml(title)}"` : ''}>${label}</a>`;
  }

  image({ text }) {
    // Text chat must not silently load remote images or local API URLs.
    return escapeHtml(text);
  }

  table(token) {
    return `<div class="text-markdown-table" tabindex="0" role="region" aria-label="表格">${super.table(token)}</div>`;
  }

  tablecell({ header, align, tokens }) {
    const tag = header ? 'th' : 'td';
    const alignment = ['left', 'center', 'right'].includes(align) ? ` class="text-markdown-align-${align}"` : '';
    return `<${tag}${header ? ' scope="col"' : ''}${alignment}>${this.parser.parseInline(tokens)}</${tag}>\n`;
  }
}

const markdown = new Marked().setOptions({ gfm: true, breaks: true, async: false, renderer: new ChatRenderer() });

export function renderTextMarkdown(value) {
  const source = String(value ?? '');
  try { return markdown.parse(source); }
  catch { return escapeHtml(source).replace(/\r\n?|\n/g, '<br>'); }
}
