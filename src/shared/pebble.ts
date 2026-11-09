export type PebbleMotion = "auto" | "full" | "lite" | "off";
export type PebbleClip =
  | "idle"
  | "doze-off"
  | "sleep"
  | "curious-bounce"
  | "drag-left"
  | "drag-right"
  | "release-settle";

export const PEBBLE_MOTION_KEY = "cobble.pebble.motion";
export function parsePebbleMotion(value: string | null): PebbleMotion {
  return value === "full" || value === "lite" || value === "off"
    ? value
    : "auto";
}
export function pebbleQuality(
  setting: PebbleMotion,
  reducedMotion: boolean,
  cores: number,
): Exclude<PebbleMotion, "auto"> {
  if (setting !== "auto") return setting;
  if (reducedMotion || (cores > 0 && cores <= 2)) return "off";
  return cores > 0 && cores <= 4 ? "lite" : "full";
}
export const pebbleLoops = (clip: PebbleClip) =>
  ["idle", "sleep", "drag-left", "drag-right"].includes(clip);
