import { Marked } from './marked.js';

const markdown = new Marked({ gfm: true });

export function replyImageSource(value) {
  if (typeof value !== 'string') return '';
  const source = value.trim();
  if (/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/\s]+=*$/i.test(source)) return source;
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') ? url.href : '';
  } catch { return ''; }
}

export function markdownImages(content) {
  const images = [];
  const tokens = markdown.lexer(String(content || ''));
  markdown.walkTokens(tokens, token => {
    if (token.type !== 'image') return;
    const source = replyImageSource(token.href);
    if (source) images.push({ source, name: token.text || '对话图片' });
  });
  return images;
}

export function normalizeReply(message = {}) {
  message ||= {};
  let content = typeof message.content === 'string' ? message.content : '';
  const images = [];
  if (Array.isArray(message.content)) {
    content = message.content.filter(part => ['text', 'output_text'].includes(part?.type) && typeof part.text === 'string')
      .map(part => part.text).join('\n');
    for (const part of message.content) {
      if (['image_url', 'image', 'output_image'].includes(part?.type)) {
        const source = replyImageSource(part.image_url?.url || part.image_url || part.url
          || (part.b64_json ? `data:${part.mime_type || 'image/png'};base64,${part.b64_json}` : ''));
        if (source) images.push({ source, name: part.name || part.alt || '对话图片' });
      }
    }
  }
  for (const part of Array.isArray(message.images) ? message.images : []) {
    const source = replyImageSource(part?.image_url?.url || part?.image_url || part?.url
      || (part?.b64_json ? `data:${part.mime_type || 'image/png'};base64,${part.b64_json}` : ''));
    if (source) images.push({ source, name: part.name || '对话图片' });
  }
  const embedded = markdownImages(content);
  images.push(...embedded);
  if (embedded.length) markdown.walkTokens(markdown.lexer(content), token => {
    if (token.type === 'image' && replyImageSource(token.href)) content = content.replace(token.raw, token.text ? `[图片：${token.text}]` : '');
  });
  return { content, images: [...new Map(images.map(image => [image.source, image])).values()] };
}

export function imageHistoryContent(message) {
  return message.content?.trim() || (message.images?.length ? `[已返回 ${message.images.length} 张图片]` : '');
}
