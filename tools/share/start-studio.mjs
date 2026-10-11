import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createStudio } from '../../server.mjs';
import { atomicJson } from '../../lib/store.mjs';

export const defaultRuntimeRoot = fileURLToPath(new URL('../../runtime/', import.meta.url));
const appId = 'jingce-ad-studio';
const sessionName = 'share-session.private.json';
const lockName = 'share-launch.lock';
const tokenPattern = /^[a-f0-9]{64}$/;
const filename = (root, name) => path.join(path.resolve(root), name);

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return null; }
}

function sameToken(left, right) {
  return typeof left === 'string' && typeof right === 'string' && tokenPattern.test(left) && tokenPattern.test(right)
    && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

/** A matching application name alone does not establish ownership of a service. */
export async function readOwnedSession({ runtimeRoot = defaultRuntimeRoot, timeoutMs = 1200 } = {}) {
  const root = path.resolve(runtimeRoot);
  const session = await readJson(filename(root, sessionName));
  if (session?.appId !== appId || session.runtimeRoot !== root || !tokenPattern.test(session.token || '')
    || !Number.isInteger(session.port) || session.port < 1 || session.port > 65535) return null;
  const url = `http://127.0.0.1:${session.port}`;
  try {
    const response = await fetch(`${url}/api/bootstrap`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok) return null;
    const bootstrap = await response.json();
    if (bootstrap.appId !== appId || !sameToken(session.token, bootstrap.token)) return null;
    return { ...session, url };
  } catch { return null; }
}

export async function removeOwnedSession(runtimeRoot, token) {
  const file = filename(runtimeRoot, sessionName);
  const saved = await readJson(file);
  if (saved?.runtimeRoot === path.resolve(runtimeRoot) && sameToken(saved.token, token)) {
    await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function openBrowser(url) {
  const child = process.platform === 'win32'
    ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore', detached: true })
    : spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

async function releaseLock(root, lockId) {
  const file = filename(root, lockName);
  const existing = await readJson(file);
  if (existing?.lockId === lockId) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

async function claimLock(root, waitMs) {
  const lockId = randomUUID();
  const lockFile = filename(root, lockName);
  const startedAt = Date.now();
  for (;;) {
    try {
      await writeFile(lockFile, JSON.stringify({ pid: process.pid, lockId, runtimeRoot: root }), { flag: 'wx', mode: 0o600 });
      return { lockId };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const existing = await readOwnedSession({ runtimeRoot: root });
    if (existing) return { existing };
    const lock = await readJson(lockFile);
    if (lock?.runtimeRoot === root && typeof lock.lockId === 'string' && !processExists(lock.pid)) {
      await releaseLock(root, lock.lockId);
      continue;
    }
    if (Date.now() - startedAt >= waitMs) {
      throw new Error('这一份工作台正在启动，或上次运行留下了无法确认的启动锁。请先关闭这一份启动窗口后重试；不要删除正在使用的数据目录。');
    }
    await delay(150);
  }
}

/** Start this distribution only; test callers may inject an offline studio factory/options. */
export async function startSharedStudio({ runtimeRoot = defaultRuntimeRoot, preferredPort = 18970,
  studioFactory = createStudio, studioOptions = {}, open = false, openUrl = openBrowser, startupWaitMs = 60000 } = {}) {
  const root = path.resolve(runtimeRoot);
  if (!Number.isInteger(preferredPort) || preferredPort < 0 || preferredPort > 65535) throw new Error('工作台端口无效。');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const existing = await readOwnedSession({ runtimeRoot: root });
  if (existing) {
    if (open) openUrl(existing.url);
    return { reused: true, url: existing.url, port: existing.port };
  }
  const claim = await claimLock(root, startupWaitMs);
  if (claim.existing) {
    if (open) openUrl(claim.existing.url);
    return { reused: true, url: claim.existing.url, port: claim.existing.port };
  }
  let app;
  let token;
  let cleanupPromise;
  const cleanup = () => cleanupPromise ||= (async () => {
    if (token) await removeOwnedSession(root, token);
    await releaseLock(root, claim.lockId);
  })();
  try {
    // Recheck after claiming the lock to cover a concurrent starter's completed write.
    const running = await readOwnedSession({ runtimeRoot: root });
    if (running) {
      await cleanup();
      if (open) openUrl(running.url);
      return { reused: true, url: running.url, port: running.port };
    }
    app = await studioFactory({ ...studioOptions, root });
    let url;
    try { url = await app.start(preferredPort); }
    catch (error) {
      if (error.code !== 'EADDRINUSE' || preferredPort === 0) throw error;
      url = await app.start(0);
    }
    const response = await fetch(`${url}/api/bootstrap`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    const bootstrap = await response.json();
    if (!response.ok || bootstrap.appId !== appId || !tokenPattern.test(bootstrap.token || '')) throw new Error('工作台启动身份验证失败。');
    token = bootstrap.token;
    const port = app.server.address().port;
    await atomicJson(filename(root, sessionName), { appId, runtimeRoot: root, port, pid: process.pid, token });
    app.server.once('close', () => { cleanup().catch(() => {}); });
    const close = async () => {
      if (app.server.listening) await app.close();
      await cleanup();
    };
    if (open) openUrl(url);
    return { reused: false, url, port, app, close };
  } catch (error) {
    if (app) {
      if (app.server.listening) await app.close().catch(() => {});
      else { app.jobs?.close(); app.imageJobs?.close(); }
    }
    await cleanup();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const started = await startSharedStudio({ open: process.argv.includes('--open') });
    console.log(`\n${started.reused ? '这一份工作台已经启动' : '镜策工作台已启动'}：${started.url}`);
    if (!started.reused) {
      console.log('工作台只在本机运行。请保留此窗口；关闭窗口或双击“停止工作台”可以停止。');
      const finish = () => started.close().then(() => process.exit(0)).catch(() => process.exit(1));
      process.once('SIGINT', finish);
      process.once('SIGTERM', finish);
    }
  } catch (error) {
    console.error(`启动失败：${error.message}`);
    process.exitCode = 1;
  }
}
