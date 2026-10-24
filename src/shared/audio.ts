// Browser-native conversion avoids shipping a second audio-transcoding program.
export function encodeMonoWav(
  samples: Float32Array,
  rate = 16000,
): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(
      44 + i * 2,
      Math.round(value * (value < 0 ? 32768 : 32767)),
      true,
    );
  }
  return buffer;
}
export async function recordingToWav(
  recording: ArrayBuffer,
): Promise<ArrayBuffer> {
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(recording);
    const length = Math.min(Math.ceil(audio.duration * 16000), 60 * 16000);
    if (!length) throw new Error("No audio captured");
    const offline = new OfflineAudioContext(1, length, 16000);
    const source = offline.createBufferSource();
    source.buffer = audio;
    source.connect(offline.destination);
    source.start();
    const mono = await offline.startRendering();
    return encodeMonoWav(mono.getChannelData(0));
  } finally {
    await context.close();
  }
}
