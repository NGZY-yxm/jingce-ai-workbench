import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export function parseWindowsProxy(output) {
  if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(output)) return '';
  const value = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(output)?.[1]?.trim();
  if (!value) return '';
  const address = value.includes('=') ? /(?:^|;)https=([^;]+)/i.exec(value)?.[1] : value;
  return address ? (/^https?:\/\//i.test(address) ? address : `http://${address}`) : '';
}

async function configuredProxy() {
  const explicit = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (explicit) return explicit;
  if (process.platform !== 'win32') return '';
  try {
    const { stdout } = await run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { windowsHide: true, timeout: 3000, maxBuffer: 65536 });
    return parseWindowsProxy(stdout);
  } catch { return ''; }
}

// Pin the CONNECT destination to the already validated public address.
export async function videoProxyAgent(url, pinned) {
  const value = await configuredProxy();
  if (!value) return undefined;
  const proxy = new URL(value);
  if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('Unsupported HTTPS proxy protocol');
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (_options, callback) => {
    const address = pinned.family === 6 ? `[${pinned.address}]` : pinned.address;
    const headers = { Host: `${url.hostname}:443` };
    if (proxy.username || proxy.password) headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
    const request = (proxy.protocol === 'https:' ? https : http).request(proxy, {
      method: 'CONNECT', path: `${address}:443`, headers, timeout: 30000,
    });
    let finished = false;
    const finish = (error, socket) => {
      if (finished) return;
      finished = true;
      callback(error, socket);
    };
    request.on('timeout', () => request.destroy(new Error('Proxy connection timed out')));
    request.on('error', finish);
    request.on('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        finish(new Error(`Proxy CONNECT HTTP ${response.statusCode}`));
        return;
      }
      if (head.length) socket.unshift(head);
      const secure = tls.connect({ socket, servername: url.hostname, rejectUnauthorized: true });
      secure.setTimeout(30000, () => secure.destroy(new Error('Proxy TLS connection timed out')));
      secure.once('error', error => { secure.destroy(); finish(error); });
      secure.once('secureConnect', () => { secure.setTimeout(0); finish(null, secure); });
    });
    request.end();
  };
  return agent;
}
