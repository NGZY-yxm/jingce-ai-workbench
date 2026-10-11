import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputError } from './workflow.mjs';

const execute = promisify(execFile);
const options = { windowsHide: true, timeout: 300000, maxBuffer: 4 * 1024 * 1024 };
const localBin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'tools', 'ffmpeg', 'bin');
const localTool = name => path.join(localBin, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
const ffmpeg = process.env.JINGCE_FFMPEG || (existsSync(localTool('ffmpeg')) ? localTool('ffmpeg') : 'ffmpeg');
const ffprobe = process.env.JINGCE_FFPROBE || (existsSync(localTool('ffprobe')) ? localTool('ffprobe') : 'ffprobe');

export async function toolStatus() {
  try {
    const [{ stdout }, probe] = await Promise.all([
      execute(ffmpeg, ['-hide_banner', '-encoders'], { ...options, timeout: 5000 }),
      execute(ffprobe, ['-version'], { ...options, timeout: 5000 }),
    ]);
    const encoder = /\blibx264\b/.test(stdout) ? 'libx264' : /\blibopenh264\b/.test(stdout) ? 'libopenh264' : '';
    return { ready: Boolean(encoder && probe.stdout), encoder, message: encoder ? '本机视频合成工具可用。' : 'FFmpeg 缺少 H.264 编码器。' };
  } catch { return { ready: false, message: '尚未安装 FFmpeg / ffprobe。可先生成视频片段并下载，成片合成需要这两个工具。' }; }
}

export function compositionClips(project) {
  if (!project.scenes.length) throw new InputError('工程还没有可合成的视频生成项。');
  return project.scenes.map(scene => {
    const asset = project.assets.find(item => !item.deletedAt && item.id === scene.videoAssetId && item.kind === 'video');
    if (!asset) throw new InputError(`视频 ${scene.order} 尚未选择用于成片的素材，请先生成或上传视频。`);
    return { scene, asset };
  });
}

export function compositionAudio(project, audioAssetId = '') {
  if (!audioAssetId) return null;
  const audio = project.assets.find(item => !item.deletedAt && item.id === audioAssetId && item.kind === 'audio');
  if (!audio) throw new InputError('背景音乐已删除或不属于当前工程，请重新选择。');
  return audio;
}

export async function compose(project, root, exportId, audioAssetId = '') {
  const clips = compositionClips(project), audio = compositionAudio(project, audioAssetId);
  const tools = await toolStatus();
  if (!tools.ready) throw new InputError(tools.message);
  const temp = path.join(root, 'exports', `${exportId}.work`);
  await mkdir(temp, { recursive: true });
  const edge = 720;
  const [a, b] = project.brief.ratio.split(':').map(Number);
  const width = a >= b ? Math.round(edge * a / b / 2) * 2 : edge;
  const height = b >= a ? Math.round(edge * b / a / 2) * 2 : edge;
  try {
    for (let index = 0; index < clips.length; index++) {
      const { scene, asset } = clips[index];
      const source = path.join(root, 'assets', asset.file);
      const { stdout } = await execute(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', source], options);
      const streams = JSON.parse(stdout).streams || [];
      if (!streams.some(stream => stream.codec_type === 'video')) throw new InputError(`视频 ${scene.order} 的素材没有视频轨道。`);
      const hasAudio = streams.some(stream => stream.codec_type === 'audio');
      const args = ['-y', '-i', source];
      if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
      args.push('-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0',
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=${scene.duration}`,
        '-af', 'apad', '-t', String(scene.duration), '-c:v', tools.encoder, '-threads', '2',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', path.join(temp, `clip-${index}.mp4`));
      await execute(ffmpeg, args, options);
    }
    await writeFile(path.join(temp, 'clips.txt'), clips.map((_, index) => `file 'clip-${index}.mp4'`).join('\n'), 'utf8');
    const intermediate = path.join(temp, 'joined.mp4');
    await execute(ffmpeg, ['-y', '-f', 'concat', '-safe', '1', '-i', path.join(temp, 'clips.txt'),
      '-c', 'copy', '-movflags', '+faststart', intermediate], options);
    const destination = path.join(root, 'exports', `${exportId}.mp4`);
    if (audio) {
      await execute(ffmpeg, ['-y', '-i', intermediate, '-stream_loop', '-1', '-i', path.join(root, 'assets', audio.file),
        '-filter_complex', '[1:a]volume=0.18[bg];[0:a][bg]amix=inputs=2:duration=first:normalize=0[a]',
        '-map', '0:v:0', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', destination], options);
    } else {
      await execute(ffmpeg, ['-y', '-i', intermediate, '-c', 'copy', '-movflags', '+faststart', destination], options);
    }
    return { file: `${exportId}.mp4`, duration: clips.reduce((sum, item) => sum + item.scene.duration, 0), width, height };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
