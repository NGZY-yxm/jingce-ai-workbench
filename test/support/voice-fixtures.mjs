import { waveFixture } from './speech-fixtures.mjs';
export const previewFixture = () => ({ audio: waveFixture().toString('base64'), mime: 'audio/wav', extension: '.wav' });
export const customVoiceResult = request => ({ voiceId: request.voiceId, traceId: 'voice-fixture-trace', preview: previewFixture(), previewUrl: '', previewMessage: '' });
export function mp3Fixture(seconds = 12) {
  const frames = Math.ceil(seconds * 44100 / 1152), size = Math.floor(144 * 128000 / 44100), bytes = Buffer.alloc(frames * size);
  for (let offset = 0; offset < bytes.length; offset += size) bytes.writeUInt32BE(0xfffb9000, offset);
  return bytes;
}
const box = (name, bytes) => { const result = Buffer.alloc(8 + bytes.length); result.writeUInt32BE(result.length); result.write(name, 4); bytes.copy(result, 8); return result; };
export function m4aFixture(seconds = 12, video = false) {
  const header = Buffer.alloc(24); header.writeUInt32BE(32000, 12); header.writeUInt32BE(Math.round(seconds * 32000), 16);
  const handler = Buffer.alloc(24); handler.write(video ? 'vide' : 'soun', 8);
  return Buffer.concat([box('ftyp', Buffer.from('M4A \0\0\0\0M4A ')), box('moov', box('trak', box('mdia', Buffer.concat([box('mdhd', header), box('hdlr', handler)])))), box('mdat', Buffer.alloc(16))]);
}
