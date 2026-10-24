import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const exec = promisify(execFile);
export async function transcribe(
  audio: ArrayBuffer,
  runtime = resolve("resources/voice"),
): Promise<string> {
  if (
    !(audio instanceof ArrayBuffer) ||
    audio.byteLength < 44 ||
    audio.byteLength > 1_920_044
  )
    throw new Error("Recording is empty or too large");
  const wavBytes = Buffer.from(audio);
  if (
    wavBytes.toString("ascii", 0, 4) !== "RIFF" ||
    wavBytes.toString("ascii", 8, 12) !== "WAVE" ||
    wavBytes.readUInt16LE(20) !== 1 ||
    wavBytes.readUInt16LE(22) !== 1 ||
    wavBytes.readUInt32LE(24) !== 16000 ||
    wavBytes.readUInt16LE(34) !== 16 ||
    wavBytes.readUInt32LE(40) !== wavBytes.length - 44
  )
    throw new Error("Invalid voice recording");
  const whisper = join(runtime, "whisper-cli.exe");
  const model = join(runtime, "ggml-tiny.bin");
  try {
    await Promise.all([access(whisper), access(model)]);
  } catch {
    throw new Error(
      "Cobble's included voice files are missing. Reinstall Cobble to restore them.",
    );
  }
  const directory = await mkdtemp(join(tmpdir(), "cobble-voice-"));
  try {
    const wav = join(directory, "recording.wav");
    const output = join(directory, "transcript");
    await writeFile(wav, wavBytes);
    await exec(
      whisper,
      ["-m", model, "-f", wav, "-l", "auto", "-otxt", "-of", output],
      {
        timeout: 120_000,
        windowsHide: true,
        maxBuffer: 1_000_000,
      },
    );
    return (await readFile(`${output}.txt`, "utf8")).trim().slice(0, 8000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
