import { readFile } from 'node:fs/promises';
try {
  const info = JSON.parse(await readFile(new URL('../runtime/server.json', import.meta.url), 'utf8'));
  if (info.appId !== 'jingce-ad-studio' || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535) throw new Error();
  const url = `http://127.0.0.1:${info.port}`;
  const response = await fetch(`${url}/api/bootstrap`, { signal: AbortSignal.timeout(3000) });
  const bootstrap = await response.json();
  if (bootstrap.appId !== 'jingce-ad-studio') throw new Error();
  await fetch(`${url}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000),
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': bootstrap.token }, body: '{}' });
  console.log('工作台已停止。');
} catch { console.log('工作台未运行，或无法连接。可以关闭启动窗口停止服务。'); }
