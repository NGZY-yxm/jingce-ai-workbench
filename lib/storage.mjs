import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { atomicJson } from './store.mjs';
import { InputError } from './workflow.mjs';
import { isPrivateAddress } from './media.mjs';

export const DEFAULT_STORAGE = Object.freeze({
  bucket: '', region: 'ap-guangzhou', prefix: 'jingce', enabled: false, expiresHours: 72,
  secretId: '', secretKey: '',
});

const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.mp3', '.wav']);
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'audio/mpeg', 'audio/wav']);
const camSafeUrlEncode = value => encodeURIComponent(String(value))
  .replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28')
  .replace(/\)/g, '%29').replace(/\*/g, '%2A');
const objectKeys = (object, encoded = false) => Object.keys(object || {}).map(key => encoded ? camSafeUrlEncode(key).toLowerCase() : key)
  .sort((left, right) => { const a = left.toLowerCase(), b = right.toLowerCase(); return a === b ? 0 : a > b ? 1 : -1; });
const objectString = (object, lowerCaseKey = false) => objectKeys(object).map(key => {
  const value = object[key] == null ? '' : String(object[key]);
  const encodedKey = camSafeUrlEncode(key);
  return `${lowerCaseKey ? encodedKey.toLowerCase() : encodedKey}=${camSafeUrlEncode(value)}`;
}).join('&');
export function cosAuthorization({ secretId, secretKey, method, pathname, headers = {}, query = {}, expires = 900, now = Math.floor(Date.now() / 1000) }) {
  if (!secretId || !secretKey) throw new InputError('腾讯云密钥尚未配置。');
  const start = Math.max(0, Math.floor(Number(now)) - 1), end = start + Math.max(1, Math.min(604800, Math.floor(Number(expires) || 900)));
  const signTime = `${start};${end}`;
  const signableHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower.startsWith('x-cos-') || lower.startsWith('x-ci-') || [
      'cache-control', 'content-disposition', 'content-encoding', 'content-length', 'content-md5',
      'content-type', 'expect', 'expires', 'host', 'if-match', 'if-modified-since',
      'if-none-match', 'if-unmodified-since', 'origin', 'range', 'transfer-encoding', 'pic-operations',
    ].includes(lower)) signableHeaders[key] = value;
  }
  const headerList = objectKeys(signableHeaders, true).join(';');
  const paramList = objectKeys(query, true).join(';');
  const signKey = createHmac('sha1', secretKey).update(signTime).digest('hex');
  const formatString = [String(method || 'get').toLowerCase(), pathname || '/', objectString(query, true), objectString(signableHeaders, true), ''].join('\n');
  const hashedFormat = createHash('sha1').update(Buffer.from(formatString, 'utf8')).digest('hex');
  const stringToSign = ['sha1', signTime, hashedFormat, ''].join('\n');
  const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex');
  return [
    'q-sign-algorithm=sha1', `q-ak=${secretId}`, `q-sign-time=${signTime}`, `q-key-time=${signTime}`,
    `q-header-list=${headerList}`, `q-url-param-list=${paramList}`, `q-signature=${signature}`,
  ].join('&');
}

function normalizeConfig(input = {}, previous = DEFAULT_STORAGE) {
  const next = { ...DEFAULT_STORAGE, ...previous };
  if (Object.prototype.hasOwnProperty.call(input, 'bucket')) next.bucket = String(input.bucket || '').trim().slice(0, 128);
  if (Object.prototype.hasOwnProperty.call(input, 'region')) next.region = String(input.region || '').trim().slice(0, 80);
  if (Object.prototype.hasOwnProperty.call(input, 'prefix')) next.prefix = String(input.prefix || '').trim().replace(/^\/+|\/+$/g, '').slice(0, 120);
  if (Object.prototype.hasOwnProperty.call(input, 'enabled')) next.enabled = Boolean(input.enabled);
  if (Object.prototype.hasOwnProperty.call(input, 'expiresHours')) next.expiresHours = Number(input.expiresHours);
  if (Object.prototype.hasOwnProperty.call(input, 'secretId') && String(input.secretId || '').trim()) next.secretId = String(input.secretId).trim().slice(0, 256);
  if (Object.prototype.hasOwnProperty.call(input, 'secretKey') && String(input.secretKey || '').trim()) next.secretKey = String(input.secretKey).trim().slice(0, 512);
  if (input.clearSecret) { next.secretId = ''; next.secretKey = ''; }
  validateStorageConfig(next, { allowDisabled: true });
  return next;
}

export function validateStorageConfig(config, { allowDisabled = false } = {}) {
  if (config.bucket && !/^[a-z0-9][a-z0-9-]{1,58}-\d{6,20}$/.test(config.bucket)) {
    throw new InputError('COS 存储桶名称格式不正确，应包含末尾数字 AppId，例如 jingce-example-1250000000。');
  }
  if (!/^[a-z][a-z0-9-]{1,78}$/.test(config.region || '')) throw new InputError('COS 地域格式不正确，例如 ap-guangzhou。');
  if (config.prefix && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(config.prefix)) throw new InputError('COS 对象前缀只能包含字母、数字、点、下划线、斜杠和短横线。');
  if (!Number.isFinite(config.expiresHours) || config.expiresHours < 1 || config.expiresHours > 168) throw new InputError('临时链接有效期请选择 1–168 小时。');
  if (!allowDisabled && (!config.enabled || !config.bucket || !config.secretId || !config.secretKey)) throw new InputError('请先完整填写 COS 存储桶、地域和密钥，并启用自动上传。');
  if (config.secretId && /[\r\n]/.test(config.secretId) || config.secretKey && /[\r\n]/.test(config.secretKey)) throw new InputError('腾讯云密钥不能包含换行。');
  return config;
}

export function publicStorageSettings(config = DEFAULT_STORAGE) {
  return { bucket: config.bucket || '', region: config.region || 'ap-guangzhou', prefix: config.prefix || 'jingce',
    enabled: Boolean(config.enabled), expiresHours: Number(config.expiresHours) || 72,
    hasCredentials: Boolean(config.secretId && config.secretKey),
    ready: Boolean(config.enabled && config.bucket && config.secretId && config.secretKey),
    message: config.enabled && !(config.bucket && config.secretId && config.secretKey)
      ? '自动上传已开启，但腾讯云密钥尚未完整配置。' : '只在点击生成时上传选中的图片、视频和音频参考。' };
}

async function collectResponse(response, limit = 128 * 1024) {
  const chunks = []; let bytes = 0;
  for await (const chunk of response) { bytes += chunk.length; if (bytes > limit) { response.destroy(); throw new InputError('COS 返回内容过大，已停止读取。', 502); } chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export class CosStorage {
  constructor(root, store, options = {}) {
    this.root = root; this.store = store; this.inflight = new Map(); this.addressCache = new Map();
    this.lookup = options.lookup || lookup; this.requestImpl = options.requestImpl || https.request; this.now = options.now || (() => Math.floor(Date.now() / 1000));
  }
  async settings() {
    try { return normalizeConfig(JSON.parse(await readFile(path.join(this.root, 'storage.private.json'), 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return { ...DEFAULT_STORAGE }; throw new InputError('素材云存储配置无法读取，请保留 runtime 目录后重试。'); }
  }
  async saveSettings(input) {
    const previous = await this.settings(); const next = normalizeConfig(input, previous);
    await atomicJson(path.join(this.root, 'storage.private.json'), next, 0o600); return next;
  }
  publicSettings() { return this.settings().then(publicStorageSettings); }
  hostname(config) { return `${config.bucket}.cos.${config.region}.myqcloud.com`; }
  async resolvedAddress(hostname) {
    if (this.addressCache.has(hostname)) return this.addressCache.get(hostname);
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await this.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new InputError('COS 域名解析到了内网地址，已停止上传。', 502);
    const pinned = addresses[0]; this.addressCache.set(hostname, pinned); return pinned;
  }
  async request(config, method, key, headers = {}, body = null) {
    validateStorageConfig(config);
    const hostname = this.hostname(config), pathname = `/${key}`;
    const requestHeaders = { ...headers, Host: hostname };
    const authorization = cosAuthorization({ secretId: config.secretId, secretKey: config.secretKey, method, pathname, headers: requestHeaders, expires: 900, now: this.now() });
    const address = await this.resolvedAddress(hostname);
    const url = `https://${hostname}${pathname}`;
    return new Promise((resolve, reject) => {
      const req = this.requestImpl(url, { method, headers: { ...requestHeaders, Authorization: authorization, 'User-Agent': 'Jingce-Ad-Studio/0.1' }, timeout: 30000,
        lookup: (_name, opts, callback) => opts.all ? callback(null, [address]) : callback(null, address.address, address.family) }, async response => {
        try { const data = await collectResponse(response); resolve({ statusCode: response.statusCode || 0, headers: response.headers, body: data }); }
        catch (error) { reject(error); }
      });
      req.on('timeout', () => req.destroy(new Error('COS 连接超时。'))); req.on('error', reject);
      if (body && typeof body.pipe === 'function') { body.on('error', reject); body.pipe(req); } else { if (body) req.write(body); req.end(); }
    });
  }
  keyFor(config, asset, sha256) {
    const extension = path.extname(asset.file || '').toLowerCase();
    if (!MEDIA_EXTENSIONS.has(extension)) throw new InputError('参考素材文件类型不受支持，无法上传到 COS。');
    const prefix = config.prefix ? `${config.prefix}/` : '';
    return `${prefix}assets/${asset.id}/${sha256}${extension}`;
  }
  async hashFile(filename) {
    const md5 = createHash('md5'), sha256 = createHash('sha256'); let size = 0;
    for await (const chunk of createReadStream(filename)) { size += chunk.length; md5.update(chunk); sha256.update(chunk); }
    return { size, md5: md5.digest('base64'), sha256: sha256.digest('hex') };
  }
  async ensureUploaded(asset) {
    const config = await this.settings(); validateStorageConfig(config);
    // Register the promise before hashing so concurrent candidates that reference
    // the same local asset share the whole hash, HEAD and PUT sequence.
    const cacheKey = `${config.bucket}|${config.region}|${asset.id || ''}|${asset.file || ''}`;
    if (!this.inflight.has(cacheKey)) {
      this.inflight.set(cacheKey, (async () => {
        const filename = path.resolve(this.root, 'assets', asset.file || '');
        const assetsRoot = path.resolve(this.root, 'assets');
        if (!filename.startsWith(`${assetsRoot}${path.sep}`)) throw new InputError('参考素材路径不安全，已停止上传。');
        const info = await stat(filename).catch(() => null); if (!info?.isFile()) throw new InputError('参考素材文件不存在，请重新上传。');
        const hashed = await this.hashFile(filename); const key = this.keyFor(config, asset, hashed.sha256);
        await this.uploadIfNeeded(config, filename, key, asset.mime, hashed);
        return this.signedUrl(config, key);
      })().finally(() => this.inflight.delete(cacheKey)));
    }
    return this.inflight.get(cacheKey);
  }
  async uploadIfNeeded(config, filename, key, mime, hashed) {
    const head = await this.request(config, 'HEAD', key, {});
    if (head.statusCode === 200) {
      const length = Number(head.headers['content-length']); if (Number.isFinite(length) && length !== hashed.size) throw new InputError('COS 中已有同名对象但大小不一致，已停止覆盖。', 502);
      return;
    }
    if (head.statusCode !== 404) throw new InputError(`COS 检查素材失败（HTTP ${head.statusCode}）。`, 502);
    const response = await this.request(config, 'PUT', key, { 'Content-Length': String(hashed.size), 'Content-MD5': hashed.md5, 'Content-Type': MIME_TYPES.has(mime) ? mime : 'application/octet-stream' }, createReadStream(filename));
    if (![200, 201, 204].includes(response.statusCode)) throw new InputError(`COS 上传素材失败（HTTP ${response.statusCode}）。`, 502);
  }
  signedUrl(config, key) {
    validateStorageConfig(config);
    const hostname = this.hostname(config), pathname = `/${key}`;
    const authorization = cosAuthorization({ secretId: config.secretId, secretKey: config.secretKey, method: 'get', pathname, headers: { Host: hostname }, expires: config.expiresHours * 3600, now: this.now() });
    return `https://${hostname}${pathname}?${authorization}`;
  }
  async prepareReferences(job) {
    const config = await this.settings(); validateStorageConfig(config);
    const project = this.store.get(job.projectId, true); const references = structuredClone(job.references || []);
    for (const reference of references) {
      const asset = project.assets.find(item => !item.deletedAt && item.id === reference.assetId && item.kind === reference.kind);
      if (!asset) throw new InputError('参考素材已删除或尚未关联本工程的有效文件，请先补选素材。');
      if (reference.publicUrl) continue;
      reference.publicUrl = await this.ensureUploaded(asset);
    }
    return references;
  }
  async testConnection() {
    const config = await this.settings(); validateStorageConfig(config);
    const key = `${config.prefix ? `${config.prefix}/` : ''}tests/${randomUUID()}.png`;
    const body = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const response = await this.request(config, 'PUT', key, { 'Content-Length': String(body.length), 'Content-MD5': createHash('md5').update(body).digest('base64'), 'Content-Type': 'image/png' }, body);
    if (![200, 201, 204].includes(response.statusCode)) throw new InputError(`COS 测试上传失败（HTTP ${response.statusCode}）。`, 502);
    const url = this.signedUrl(config, key); const fetched = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!fetched.ok) throw new InputError(`COS 测试读取失败（HTTP ${fetched.status}）。`, 502);
    const data = Buffer.from(await fetched.arrayBuffer()); if (!data.length) throw new InputError('COS 测试读取为空。', 502);
    const deleted = await this.request(config, 'DELETE', key, {}); if (![200, 204].includes(deleted.statusCode)) throw new InputError(`COS 测试清理失败（HTTP ${deleted.statusCode}）。`, 502);
    return { ok: true, message: 'COS 上传、临时链接读取和清理测试成功；没有提交视频生成。' };
  }
}

export function storageConfigForTests(overrides = {}) { return normalizeConfig({ ...DEFAULT_STORAGE, bucket: 'jingce-example-1250000000', region: 'ap-guangzhou', secretId: 'AKIDtest', secretKey: 'test-secret', enabled: true, ...overrides }); }

