import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultRuntimeRoot, readOwnedSession, removeOwnedSession } from './start-studio.mjs';

/** Never terminate a process or shut down a service identified by appId alone. */
export async function stopSharedStudio({ runtimeRoot = defaultRuntimeRoot, shutdownWaitMs = 5000 } = {}) {
  const session = await readOwnedSession({ runtimeRoot });
  if (!session) return { stopped: false, reason: 'not_running' };
  const response = await fetch(`${session.url}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000),
    redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': session.token }, body: '{}' });
  if (!response.ok) throw new Error('工作台没有接受停止请求。请关闭这一份启动窗口。');
  const began = Date.now();
  while (Date.now() - began < shutdownWaitMs) {
    await delay(100);
    if (!await readOwnedSession({ runtimeRoot, timeoutMs: 500 })) {
      await removeOwnedSession(runtimeRoot, session.token);
      return { stopped: true };
    }
  }
  return { stopped: false, reason: 'shutdown_pending' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await stopSharedStudio();
    console.log(result.stopped ? '这一份工作台已停止。' : result.reason === 'shutdown_pending'
      ? '已发送停止请求，请稍后关闭这一份启动窗口。'
      : '这一份工作台未运行，或记录与服务不一致；其他工作台没有被停止。');
  } catch (error) {
    console.error(`停止失败：${error.message}`);
    process.exitCode = 1;
  }
}
