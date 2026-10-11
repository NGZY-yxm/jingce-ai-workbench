import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWindowsProxy } from '../lib/download-proxy.mjs';

test('Windows proxy settings require an enabled proxy and select the HTTPS entry', () => {
  assert.equal(parseWindowsProxy('ProxyEnable    REG_DWORD    0x0\nProxyServer    REG_SZ    127.0.0.1:6480'), '');
  assert.equal(parseWindowsProxy('ProxyEnable    REG_DWORD    0x1\nProxyServer    REG_SZ    127.0.0.1:6480'), 'http://127.0.0.1:6480');
  assert.equal(parseWindowsProxy('ProxyEnable    REG_DWORD    0x1\nProxyServer    REG_SZ    http=localhost:80;https=localhost:6480'), 'http://localhost:6480');
  assert.equal(parseWindowsProxy('ProxyEnable    REG_DWORD    0x1\nProxyServer    REG_SZ    http=localhost:80'), '');
});
