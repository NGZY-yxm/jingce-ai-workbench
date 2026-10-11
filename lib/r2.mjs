import { createHash, createHmac } from 'node:crypto';

const encode = value => encodeURIComponent(String(value)).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hash = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value, encoding) => createHmac('sha256', key).update(value).digest(encoding);
const queryString = query => Object.entries(query).map(([key, value]) => [encode(key), encode(value)])
  .sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
  .map(([key, value]) => `${key}=${value}`).join('&');
const objectPath = (config, key) => `/${[config.bucket, ...key.split('/')].map(encode).join('/')}`;

function timestamp(now) {
  return new Date(Number(now) * 1000).toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function signature(config, method, pathname, query, headers, payloadHash, dateTime) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) =>
    [key.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')]));
  const names = Object.keys(normalized).sort();
  const canonical = [method.toUpperCase(), pathname, queryString(query),
    names.map(name => `${name}:${normalized[name]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const date = dateTime.slice(0, 8), scope = `${date}/auto/s3/aws4_request`;
  const key = hmac(hmac(hmac(hmac(`AWS4${config.secretKey}`, date), 'auto'), 's3'), 'aws4_request');
  const value = hmac(key, ['AWS4-HMAC-SHA256', dateTime, scope, hash(canonical)].join('\n'), 'hex');
  return { value, scope, signedHeaders: names.join(';') };
}

export function r2Request(config, method, key, headers, now) {
  const endpoint = new URL(config.endpoint), pathname = objectPath(config, key);
  const signedHeaders = { ...headers, Host: endpoint.host, 'x-amz-date': timestamp(now),
    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' };
  const signed = signature(config, method, pathname, {}, signedHeaders, 'UNSIGNED-PAYLOAD', signedHeaders['x-amz-date']);
  return { url: `${endpoint.origin}${pathname}`, hostname: endpoint.hostname,
    headers: { ...signedHeaders, Authorization: `AWS4-HMAC-SHA256 Credential=${config.secretId}/${signed.scope}, SignedHeaders=${signed.signedHeaders}, Signature=${signed.value}` } };
}

export function r2SignedUrl(config, key, now) {
  const endpoint = new URL(config.endpoint), pathname = objectPath(config, key), dateTime = timestamp(now);
  const scope = `${dateTime.slice(0, 8)}/auto/s3/aws4_request`;
  const query = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${config.secretId}/${scope}`,
    'X-Amz-Date': dateTime, 'X-Amz-Expires': String(Math.floor(config.expiresHours * 3600)), 'X-Amz-SignedHeaders': 'host' };
  const signed = signature(config, 'GET', pathname, query, { host: endpoint.host }, 'UNSIGNED-PAYLOAD', dateTime);
  return `${endpoint.origin}${pathname}?${queryString({ ...query, 'X-Amz-Signature': signed.value })}`;
}
