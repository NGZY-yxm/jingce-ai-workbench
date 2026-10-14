// Only bounded, sanitized diagnostic fields leave the provider adapter.
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const scalar = value => ['string','number'].includes(typeof value) ? String(value) : '';
export function safeVideoDiagnostic(value, key = '', limit = 800) {
  let text = scalar(value);
  for (const secret of new Set([key, encodeURIComponent(key)])) if (secret) text = text.split(secret).join('[已隐藏密钥]');
  text = text.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [已隐藏密钥]')
    .replace(/\bsk-[\w.+/=-]+/gi, '[已隐藏密钥]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, value => {
      try { const url = new URL(value); return url.origin + url.pathname + (url.search ? '?[已隐藏链接参数]' : ''); }
      catch { return '[已隐藏链接]'; }
    })
    .replace(/((?:api[_-]?key|secret(?:[_-]?key)?|token|password|authorization|x-amz-(?:signature|credential))\s*[=:]\s*)[^\s,;"'<>]+/gi, '$1[已隐藏]')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  return text.slice(0, limit);
}
export function videoErrorDiagnostics(data, response, body = '', key = '') {
  const nodes = [data?.error, data?.data?.error, data?.data, data].filter(object);
  const first = field => nodes.map(node => node[field]).find(value => scalar(value));
  const clean = (value, limit) => safeVideoDiagnostic(value, key, limit);
  let code = scalar(first('code') || first('type'));
  if (['0','success','ok'].includes(code.toLowerCase())) code = '';
  let message = scalar(first('message') || first('msg') || first('detail'))
    || scalar(data?.error) || scalar(data?.detail) || scalar(data);
  let param = scalar(first('param') || first('field'));
  const details = Array.isArray(data?.detail) ? data.detail : Array.isArray(data?.error?.details) ? data.error.details : [];
  if (!message && details.length) {
    message = details.slice(0, 5).map(item => {
      if (!object(item)) return scalar(item);
      const location = Array.isArray(item.loc) ? item.loc.map(scalar).join('.') : scalar(item.field || item.param);
      if (!param) param = location;
      return [location, scalar(item.msg || item.message)].filter(Boolean).join(': ');
    }).filter(Boolean).join('；');
  }
  let format = data !== undefined ? 'json' : !body.trim() ? 'empty' : /^\s*</.test(body) ? 'html' : 'text';
  if (!message && format === 'text') message = body;
  if (!message && format === 'html') {
    // Never retain arbitrary HTML, scripts, or a proxy debug page.
    message = body.match(/<title[^>]*>([^<]{0,300})<\/title>/i)?.[1] || '平台返回了 HTML 错误页，未提供结构化错误说明';
  }
  message ||= '平台未提供具体错误说明';
  const requestId = first('request_id') || first('requestId') || first('trace_id')
    || response?.headers?.get('x-request-id') || response?.headers?.get('x-correlation-id') || response?.headers?.get('cf-ray');
  const diagnostics = { errorCode: clean(code, 200), errorParam: clean(param, 200),
    providerResponseRequestId: clean(requestId, 200), providerResponseFormat: format,
    providerErrorMessage: clean(message, 1200), providerHttpStatus: response?.status || null };
  return diagnostics;
}
export function videoErrorMessage(diagnostics) {
  const d = diagnostics;
  return [d.providerHttpStatus ? 'HTTP ' + d.providerHttpStatus : '', d.providerErrorMessage,
    d.errorCode ? '错误码：' + d.errorCode : '', d.errorParam ? '字段：' + d.errorParam : '',
    d.providerResponseRequestId ? '请求编号：' + d.providerResponseRequestId : ''].filter(Boolean).join('；');
}
