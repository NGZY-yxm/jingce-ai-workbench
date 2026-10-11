import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toolStatus, compose } from '../lib/compose.mjs';
const execute = promisify(execFile);
const binary = name => {
  const local = fileURLToPath(new URL(`../runtime/tools/ffmpeg/bin/${name}${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
  return process.env[name === 'ffmpeg' ? 'JINGCE_FFMPEG' : 'JINGCE_FFPROBE'] || (existsSync(local) ? local : name);
};
test('实际 MP4 合成：混合有声与无声片段，补帧、比例统一并添加背景音乐', async t => {
  const tools = await toolStatus(); if (!tools.ready) { t.skip('本机未安装 FFmpeg'); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), 'jingce-compose-')); await mkdir(path.join(root, 'assets')); await mkdir(path.join(root, 'exports'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = args => execute(binary('ffmpeg'), ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true, timeout: 30000 });
  await run(['-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=0.4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', '-c:v', tools.encoder, '-threads', '2', '-c:a', 'aac', '-shortest', path.join(root, 'assets', 'a.mp4')]);
  await run(['-f', 'lavfi', '-i', 'color=c=green:s=180x320:d=0.3', '-c:v', tools.encoder, '-threads', '2', path.join(root, 'assets', 'b.mp4')]);
  await run(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=0.2', path.join(root, 'assets', 'bg.wav')]);
  const project = { brief: { ratio: '9:16' }, scenes: [{ order: 1, duration: .8, videoAssetId: 'a' }, { order: 2, duration: .6, videoAssetId: 'b' }],
    assets: [{ id: 'a', file: 'a.mp4', kind: 'video' }, { id: 'b', file: 'b.mp4', kind: 'video' }, { id: 'bg', file: 'bg.wav', kind: 'audio' }] };
  const output = await compose(project, root, 'test-cut', 'bg'); const filename = path.join(root, 'exports', output.file);
  assert.ok((await stat(filename)).size > 1000);
  const { stdout } = await execute(binary('ffprobe'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename], { windowsHide: true });
  const actual = JSON.parse(stdout), video = actual.streams.find(stream => stream.codec_type === 'video');
  assert.equal(video.width, 720); assert.equal(video.height, 1280); assert.equal(video.avg_frame_rate, '30/1');
  assert.ok(actual.streams.some(stream => stream.codec_type === 'audio'));
  assert.ok(Number(actual.format.duration) >= 1.35 && Number(actual.format.duration) < 1.6, actual.format.duration);
});
