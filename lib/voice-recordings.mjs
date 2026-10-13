import { InputError } from './workflow.mjs';
import { VOICE_RECORDING_LIMIT } from '../public/voice-parameters.js';

function invalid() { throw new InputError('录音文件无法解析，请上传原始 MP3、M4A 或 WAV 音频。'); }
function waveDuration(bytes) {
  let rate = 0, data = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4), end = offset + 8 + size;
    if (end > bytes.length) invalid();
    const tag = bytes.toString('ascii', offset, offset + 4);
    if (tag === 'fmt ') {
      if (size < 16 || ![1, 3, 65534].includes(bytes.readUInt16LE(offset + 8))) invalid();
      rate = bytes.readUInt32LE(offset + 16);
    }
    if (tag === 'data') data += size;
    offset = end + (size % 2);
  }
  return rate > 0 ? data / rate : 0;
}
function mp3Duration(bytes) {
  let offset = 0, duration = 0, frames = 0;
  if (bytes.toString('ascii', 0, 3) === 'ID3') {
    if (bytes.length < 10 || bytes.subarray(6, 10).some(value => value > 127)) invalid();
    offset = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]) + (bytes[5] & 16 ? 10 : 0);
  }
  const rates = [44100, 48000, 32000], mpeg1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], mpeg2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  while (offset + 4 <= bytes.length) {
    if (bytes.toString('ascii', offset, offset + 3) === 'TAG' || bytes.toString('ascii', offset, offset + 8) === 'APETAGEX') break;
    const header = bytes.readUInt32BE(offset), version = (header >>> 19) & 3, layer = (header >>> 17) & 3, bitrateIndex = (header >>> 12) & 15, rateIndex = (header >>> 10) & 3;
    if ((header & 0xffe00000) >>> 0 !== 0xffe00000 || version === 1 || layer !== 1 || !bitrateIndex || bitrateIndex === 15 || rateIndex === 3) invalid();
    const rate = rates[rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4), bitrate = (version === 3 ? mpeg1 : mpeg2)[bitrateIndex] * 1000;
    const length = Math.floor((version === 3 ? 144 : 72) * bitrate / rate) + ((header >>> 9) & 1);
    if (offset + length > bytes.length) invalid();
    duration += (version === 3 ? 1152 : 576) / rate; frames++; offset += length;
  }
  return frames ? duration : 0;
}
function boxes(bytes, start, end) {
  const result = [];
  for (let offset = start; offset + 8 <= end;) {
    let size = bytes.readUInt32BE(offset), header = 8;
    if (size === 1) { if (offset + 16 > end) invalid(); size = Number(bytes.readBigUInt64BE(offset + 8)); header = 16; }
    if (size === 0) size = end - offset;
    if (!Number.isSafeInteger(size) || size < header || offset + size > end) invalid();
    result.push({ type: bytes.toString('ascii', offset + 4, offset + 8), start: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}
function m4aDuration(bytes) {
  const moov = boxes(bytes, 0, bytes.length).find(box => box.type === 'moov');
  if (!moov) invalid();
  let duration = 0;
  for (const track of boxes(bytes, moov.start, moov.end).filter(box => box.type === 'trak')) {
    const media = boxes(bytes, track.start, track.end).find(box => box.type === 'mdia');
    if (!media) invalid();
    const children = boxes(bytes, media.start, media.end), handler = children.find(box => box.type === 'hdlr'), header = children.find(box => box.type === 'mdhd');
    if (!handler || handler.start + 12 > handler.end) invalid();
    const kind = bytes.toString('ascii', handler.start + 8, handler.start + 12);
    if (kind === 'vide') throw new InputError('复刻录音不能包含视频轨道，请先导出 M4A 音频。');
    if (kind !== 'soun') continue;
    if (!header) invalid();
    const version = bytes[header.start], rateOffset = header.start + (version === 1 ? 20 : 12);
    if (![0, 1].includes(version) || rateOffset + (version === 1 ? 12 : 8) > header.end) invalid();
    const rate = bytes.readUInt32BE(rateOffset), ticks = version === 1 ? Number(bytes.readBigUInt64BE(rateOffset + 4)) : bytes.readUInt32BE(rateOffset + 4);
    if (!rate || !Number.isSafeInteger(ticks)) invalid();
    duration = Math.max(duration, ticks / rate);
  }
  return duration;
}
export function inspectVoiceRecording(bytes, name) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > VOICE_RECORDING_LIMIT) throw new InputError('复刻录音最大支持 20 MB。', 413);
  const extension = /\.(mp3|m4a|wav)$/i.exec(String(name))?.[1]?.toLowerCase();
  if (!extension) throw new InputError('复刻录音支持 MP3、M4A 和 WAV。');
  let duration;
  if (extension === 'wav' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') duration = waveDuration(bytes);
  else if (extension === 'mp3' && (bytes.toString('ascii', 0, 3) === 'ID3' || bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0)) duration = mp3Duration(bytes);
  else if (extension === 'm4a' && bytes.toString('ascii', 4, 8) === 'ftyp') duration = m4aDuration(bytes);
  else invalid();
  if (!Number.isFinite(duration) || duration <= 0) invalid();
  if (duration < 10 || duration > 300) throw new InputError(`录音时长为 ${duration.toFixed(2)} 秒；复刻要求 10 秒至 5 分钟。`);
  return { duration, extension: `.${extension}`, mime: { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav' }[extension] };
}
