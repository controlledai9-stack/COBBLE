import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { encodeMonoWav } from "../src/shared/audio";
import { transcribe } from "../src/main/voice";
const source = await readFile(resolve(".cobble/downloads/jfk.wav"));
assert.equal(source.toString("ascii", 0, 4), "RIFF");
let offset = 12;
let samples: Float32Array | undefined;
let channels = 1;
let rate = 16000;
while (offset + 8 <= source.length) {
  const name = source.toString("ascii", offset, offset + 4);
  const size = source.readUInt32LE(offset + 4);
  if (name === "fmt ") {
    assert.equal(source.readUInt16LE(offset + 8), 1);
    channels = source.readUInt16LE(offset + 10);
    rate = source.readUInt32LE(offset + 12);
    assert.equal(source.readUInt16LE(offset + 22), 16);
  }
  if (name === "data") {
    samples = new Float32Array(Math.floor(size / 2 / channels));
    for (let i = 0; i < samples.length; i++)
      samples[i] = source.readInt16LE(offset + 8 + i * channels * 2) / 32768;
  }
  offset += 8 + size + (size % 2);
}
assert.ok(samples);
assert.equal(rate, 16000);
const text = await transcribe(encodeMonoWav(samples), process.argv[2] ? resolve(process.argv[2]) : undefined);
assert.match(text.toLowerCase(), /country/);
assert.match(text.toLowerCase(), /ask/);
console.log(
  "COBBLE_VOICE_OK: bundled CPU engine and multilingual model transcribed the official sample offline.",
);
