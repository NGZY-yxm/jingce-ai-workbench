import { createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { InputError } from './workflow.mjs';
import { publicReferenceUrlIssue } from '../public/reference-api.js';

export function isPrivateAddress(ip) {
  const address = ip.toLowerCase().split('%')[0];
  if (address.startsWith('::ffff:')) return isPrivateAddress(address.slice(7));
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  return isIP(address) !== 6 || address === '::1' || address === '::'
    || /^(fc|fd|fe[89ab]|ff)/.test(address);
}

// DNS checks happen before recording a billable job. This does not promise CDN access.
export async function verifyPublicReferenceUrls(references, key = '', resolver = lookup) {
  const urls = [...new Set(references.map(reference => reference.publicUrl))];
  await Promise.all(urls.map(async value => {
    const issue = publicReferenceUrlIssue(value);
    if (issue) throw new InputError(issue);
    if (key && [key, encodeURIComponent(key)].some(secret => value.includes(secret))) {
      throw new InputError('素材链接不能包含本站 API Key，请重新获取不需要本站密钥的链接。');
    }
    const url = new URL(value), hostname = url.hostname.replace(/^\[|\]$/g, '');
    let timer, addresses;
    try {
      addresses = await Promise.race([resolver(hostname, { all: true, verbatim: true }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), 10000); timer.unref(); })]);
    } catch { throw new InputError('素材域名暂时无法解析，请检查链接或稍后重试；尚未提交生成。'); }
    finally { clearTimeout(timer); }
    if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
      throw new InputError('素材域名指向本机或内网，平台无法读取；请使用公网素材链接。');
    }
  }));
}

export function videoDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new InputError('平台返回的视频下载地址格式不正确。', 502); }
  // The platform returns this CDN over HTTP; its identical HTTPS resources were verified.
  // Preserve the signed path and query, and continue to require HTTPS for every request.
  if (url.protocol === 'http:' && url.hostname === 'v16-dola.dola.com' && !url.port && !url.username && !url.password) {
    url.protocol = 'https:';
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new InputError('视频结果必须使用公开 HTTPS 下载地址。', 502);
  }
  return url;
}

export async function downloadPublicVideo(value, destination, redirects = 0) {
  const url = videoDownloadUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
    throw new InputError('平台返回了不允许访问的视频下载地址。', 502);
  }
  const pinned = addresses[0];
  const response = await new Promise((resolve, reject) => {
    const request = https.get(url, { lookup: (_name, options, callback) => {
      if (options.all) callback(null, [pinned]); else callback(null, pinned.address, pinned.family);
    }, timeout: 30000, headers: { 'User-Agent': 'Jingce-Ad-Studio/0.1' } }, resolve);
    request.on('timeout', () => request.destroy(new Error('下载连接超时。')));
    request.on('error', reject);
  });
  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
    response.resume();
    if (redirects >= 3) throw new InputError('视频地址重定向次数过多。', 502);
    return downloadPublicVideo(new URL(response.headers.location, url).href, destination, redirects + 1);
  }
  if (response.statusCode !== 200) { response.resume(); throw new InputError(`视频下载失败，HTTP ${response.statusCode}。`, 502); }
  const limit = 300 * 1024 * 1024;
  if (Number(response.headers['content-length']) > limit) {
    response.destroy(); throw new InputError('视频文件超过 300 MB。', 502);
  }
  let bytes = 0;
  const timer = setTimeout(() => response.destroy(new Error('视频下载超过五分钟。')), 300000);
  timer.unref();
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > limit ? new Error('视频下载超过 300 MB。') : null, chunk);
  } });
  try { await pipeline(response, meter, createWriteStream(destination, { flags: 'wx' })); }
  catch (error) { await unlink(destination).catch(() => {}); throw error; }
  finally { clearTimeout(timer); }
  if (!(await stat(destination)).size) { await unlink(destination); throw new InputError('平台返回了空的视频文件。', 502); }
  return bytes;
}


function imageDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new InputError('平台返回的图片下载地址格式不正确。', 502); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new InputError('图片结果必须使用公开 HTTPS 下载地址。', 502);
  }
  return url;
}

export async function downloadPublicImage(value, destination, redirects = 0) {
  const url = imageDownloadUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
    throw new InputError('平台返回了不允许访问的图片下载地址。', 502);
  }
  const pinned = addresses[0];
  const response = await new Promise((resolve, reject) => {
    const request = https.get(url, { lookup: (_name, options, callback) => {
      if (options.all) callback(null, [pinned]); else callback(null, pinned.address, pinned.family);
    }, timeout: 30000, headers: { 'User-Agent': 'Jingce-Ad-Studio/0.1' } }, resolve);
    request.on('timeout', () => request.destroy(new Error('图片下载连接超时。')));
    request.on('error', reject);
  });
  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
    response.resume();
    if (redirects >= 3) throw new InputError('图片地址重定向次数过多。', 502);
    return downloadPublicImage(new URL(response.headers.location, url).href, destination, redirects + 1);
  }
  if (response.statusCode !== 200) { response.resume(); throw new InputError(`图片下载失败，HTTP ${response.statusCode}。`, 502); }
  const limit = 20 * 1024 * 1024;
  if (Number(response.headers['content-length']) > limit) {
    response.destroy(); throw new InputError('图片文件超过 20 MB。', 502);
  }
  let bytes = 0;
  const timer = setTimeout(() => response.destroy(new Error('图片下载超过两分钟。')), 120000);
  timer.unref();
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > limit ? new Error('图片下载超过 20 MB。') : null, chunk);
  } });
  try { await pipeline(response, meter, createWriteStream(destination, { flags: 'wx' })); }
  catch (error) { await unlink(destination).catch(() => {}); throw error; }
  finally { clearTimeout(timer); }
  if (!(await stat(destination)).size) { await unlink(destination); throw new InputError('平台返回了空的图片文件。', 502); }
  return bytes;
}

export function detectMedia(prefix) {
  if (prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { kind: 'image', mime: 'image/png', extension: '.png' };
  if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) return { kind: 'image', mime: 'image/jpeg', extension: '.jpg' };
  if (prefix.toString('ascii', 0, 4) === 'RIFF' && prefix.toString('ascii', 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp', extension: '.webp' };
  if (prefix.toString('ascii', 4, 8) === 'ftyp') return { kind: 'video', mime: 'video/mp4', extension: '.mp4' };
  if (prefix.toString('ascii', 0, 4) === 'RIFF' && prefix.toString('ascii', 8, 12) === 'WAVE') return { kind: 'audio', mime: 'audio/wav', extension: '.wav' };
  if (prefix.toString('ascii', 0, 3) === 'ID3' || (prefix[0] === 255 && (prefix[1] & 0xe0) === 0xe0)) return { kind: 'audio', mime: 'audio/mpeg', extension: '.mp3' };
  throw new InputError('暂时支持 PNG、JPEG、WebP、MP4、MP3 和 WAV，请上传原始媒体文件。');
}
