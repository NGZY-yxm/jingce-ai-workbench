export function waveFixture(seconds = 0.25) {
  const rate = 32000, samples = Math.round(seconds * rate), audio = Buffer.alloc(44 + samples * 2);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(rate, 24); audio.writeUInt32LE(rate * 2, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) audio.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 2000), 44 + i * 2);
  return audio;
}
export const speechReply = (audio = waveFixture(), extra = {}) => ({ base_resp: { status_code: 0, status_msg: 'success' },
  data: { status: 2, audio: audio.toString('hex') }, extra_info: { audio_length: 250, usage_characters: 12 }, trace_id: 'fixture-trace', ...extra });
export const jsonReply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
export async function until(check, timeout = 5000) {
  const started = Date.now();
  while (!await check()) {
    if (Date.now() - started > timeout) throw new Error('等待模拟配音任务超时。');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
