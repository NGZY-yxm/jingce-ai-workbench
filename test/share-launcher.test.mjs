import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startSharedStudio, readOwnedSession } from '../tools/share/start-studio.mjs';
import { stopSharedStudio } from '../tools/share/stop-studio.mjs';
import { createStudio } from '../server.mjs';

const studioOptions = { catalog: [], imageCatalog: [], tools: { ready: false, message: '测试没有合成工具' } };
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-share-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function launch(t, runtimeRoot, options = {}) {
  const running = await startSharedStudio({ runtimeRoot, preferredPort: 0, studioOptions, ...options });
  if (!running.reused) t.after(() => running.close());
  return running;
}
async function occupied(t) {
  const server = http.createServer((_request, response) => { response.end('other service'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
}

test('便携启动：中文和空格目录、空工程、自带存储与重复启动复用', async t => {
  const root = await temporary(t);
  const runtimeRoot = path.join(root, '朋友的工作台 中文 space', 'runtime');
  let builds = 0;
  const options = { studioFactory: async options => { builds++; return createStudio(options); } };
  const opened = [];
  const first = await launch(t, runtimeRoot, { ...options, open: true, openUrl: url => opened.push(url) });
  const bootstrap = await (await fetch(first.url + '/api/bootstrap')).json();
  assert.deepEqual(bootstrap.projects, []);
  assert.deepEqual(bootstrap.deletedProjects, []);
  assert.equal(first.app.store.root, runtimeRoot);
  assert.equal(first.app.server.address().address, '127.0.0.1');
  const second = await startSharedStudio({ runtimeRoot, preferredPort: 0, studioOptions, ...options,
    open: true, openUrl: url => opened.push(url) });
  assert.equal(second.reused, true);
  assert.equal(second.url, first.url);
  assert.equal(builds, 1);
  assert.deepEqual(opened, [first.url, first.url]);
  const session = JSON.parse(await readFile(path.join(runtimeRoot, 'share-session.private.json'), 'utf8'));
  assert.equal(session.token, bootstrap.token);
  assert.equal(session.runtimeRoot, runtimeRoot);
  const created = await fetch(first.url + '/api/projects', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token }, body: JSON.stringify({ title: '朋友的新工程' }) });
  assert.equal(created.status, 201);
  await first.close();
  assert.equal(await readOwnedSession({ runtimeRoot }), null);
  const restart = await launch(t, runtimeRoot);
  const resumed = await (await fetch(restart.url + '/api/bootstrap')).json();
  assert.equal(resumed.projects[0].title, '朋友的新工程');
});

test('便携启动：端口被其他程序占用时选择空闲端口，停止不会影响对方', async t => {
  const root = await temporary(t);
  const other = await occupied(t);
  const running = await launch(t, path.join(root, 'runtime'), { preferredPort: other.port });
  assert.notEqual(running.port, other.port);
  assert.equal(await (await fetch(other.url)).text(), 'other service');
  assert.deepEqual(await stopSharedStudio({ runtimeRoot: path.join(root, 'runtime') }), { stopped: true });
  assert.equal(await (await fetch(other.url)).text(), 'other service');
});

test('合并工作台：从数据目录的不同入口启动和停止仍复用同一实例', async t => {
  const root = await temporary(t);
  const runtimeRoot = path.join(root, 'shared-data');
  const aliasRoot = path.join(root, '旧入口 runtime');
  let builds = 0;
  const studioFactory = async options => { builds++; return createStudio(options); };
  const first = await launch(t, runtimeRoot, { studioFactory });
  await symlink(runtimeRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const second = await startSharedStudio({ runtimeRoot: aliasRoot, preferredPort: 0, studioOptions, studioFactory });
  assert.equal(second.reused, true);
  assert.equal(second.url, first.url);
  assert.equal(builds, 1);
  assert.equal((await readOwnedSession({ runtimeRoot: aliasRoot })).url, first.url);
  assert.deepEqual(await stopSharedStudio({ runtimeRoot: aliasRoot }), { stopped: true });
  assert.equal(await readOwnedSession({ runtimeRoot }), null);
});

test('便携多副本：同一偏好端口分别运行，停止 B 不会停止 A', async t => {
  const root = await temporary(t);
  const first = await launch(t, path.join(root, 'A', 'runtime'));
  const secondRoot = path.join(root, 'B', 'runtime');
  const second = await launch(t, secondRoot, { preferredPort: first.port });
  assert.equal(second.reused, false);
  assert.notEqual(second.port, first.port);
  assert.deepEqual(await stopSharedStudio({ runtimeRoot: secondRoot }), { stopped: true });
  assert.equal((await fetch(first.url + '/api/bootstrap')).status, 200);
});

test('便携停止：复制的记录和错误 token 都不能关闭其他工作台', async t => {
  const root = await temporary(t);
  const firstRoot = path.join(root, 'A', 'runtime');
  const secondRoot = path.join(root, 'B', 'runtime');
  const first = await launch(t, firstRoot);
  await mkdir(secondRoot, { recursive: true });
  const session = JSON.parse(await readFile(path.join(firstRoot, 'share-session.private.json'), 'utf8'));
  const record = path.join(secondRoot, 'share-session.private.json');
  await writeFile(record, JSON.stringify(session));
  assert.deepEqual(await stopSharedStudio({ runtimeRoot: secondRoot }), { stopped: false, reason: 'not_running' });
  await writeFile(record, JSON.stringify({ ...session, runtimeRoot: secondRoot, token: randomBytes(32).toString('hex') }));
  assert.deepEqual(await stopSharedStudio({ runtimeRoot: secondRoot }), { stopped: false, reason: 'not_running' });
  assert.equal((await fetch(first.url + '/api/bootstrap')).status, 200);
  const second = await launch(t, secondRoot, { preferredPort: first.port });
  assert.notEqual(first.port, second.port);
});

test('便携并发启动：启动锁防止同时创建两份服务', async t => {
  const root = await temporary(t);
  const runtimeRoot = path.join(root, 'runtime');
  let builds = 0;
  const studioFactory = async options => {
    builds++;
    await new Promise(resolve => setTimeout(resolve, 200));
    return createStudio(options);
  };
  const results = await Promise.all([1, 2].map(() => startSharedStudio({ runtimeRoot, preferredPort: 0, studioOptions, studioFactory })));
  const started = results.find(result => !result.reused);
  t.after(() => started.close());
  assert.equal(builds, 1);
  assert.equal(results.filter(result => result.reused).length, 1);
  assert.equal(results[0].url, results[1].url);
});

test('便携停止：无记录或畸形记录不访问、不停止其他服务', async t => {
  const root = await temporary(t);
  const runtimeRoot = path.join(root, 'runtime');
  assert.deepEqual(await stopSharedStudio({ runtimeRoot }), { stopped: false, reason: 'not_running' });
  await mkdir(runtimeRoot);
  await writeFile(path.join(runtimeRoot, 'share-session.private.json'), JSON.stringify({ appId: 'jingce-ad-studio', port: 18970, token: 'bad' }));
  assert.equal(await readOwnedSession({ runtimeRoot }), null);
  assert.deepEqual(await stopSharedStudio({ runtimeRoot }), { stopped: false, reason: 'not_running' });
});

test('便携启动：已退出进程的陈旧锁可恢复，活进程的启动锁不被删除', async t => {
  const root = await temporary(t);
  const runtimeRoot = path.join(root, 'runtime');
  await mkdir(runtimeRoot);
  const lockFile = path.join(runtimeRoot, 'share-launch.lock');
  const child = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { windowsHide: true });
  const oldPid = Number(child.stdout);
  assert.throws(() => process.kill(oldPid, 0));
  await writeFile(lockFile, JSON.stringify({ pid: oldPid, lockId: 'exited-test-process', runtimeRoot }));
  const started = await launch(t, runtimeRoot);
  assert.equal(started.reused, false);
  await started.close();
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, lockId: 'live-test-owner', runtimeRoot }));
  await assert.rejects(startSharedStudio({ runtimeRoot, preferredPort: 0, studioOptions, startupWaitMs: 150 }), /正在启动/);
  const unchanged = JSON.parse(await readFile(lockFile, 'utf8'));
  assert.equal(unchanged.lockId, 'live-test-owner');
});

test('便携启动：工厂启动失败后释放本次锁，可以正常重试', async t => {
  const root = await temporary(t);
  const runtimeRoot = path.join(root, 'runtime');
  await assert.rejects(startSharedStudio({ runtimeRoot, studioFactory: async () => { throw new Error('local startup failure'); } }), /local startup failure/);
  await assert.rejects(readFile(path.join(runtimeRoot, 'share-launch.lock')), { code: 'ENOENT' });
  const started = await launch(t, runtimeRoot);
  assert.equal(started.reused, false);
});
