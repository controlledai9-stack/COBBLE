# Pebble — reference motion edition (v3)

Eight separate animations adapted from the three Google-generated MP4 videos supplied by the user. This package preserves the source's actual fluid deformation and expressive character motion. It is an edited/matted adaptation of the supplied footage, not newly generated 3D animation.

## Files and states

All standard animations have a 512 × 512 transparent canvas at 24 fps. `animations/` contains VP9 WebM and animated WebP. `lite/` contains 256 × 256 / 12 fps WebP. `stills/` holds aligned PNG fallbacks; `posters/` holds final frames for one-shot completion. `manifest.json` provides paths, exact source ranges, duration, loop behavior, and provenance. `preview.html` provides a local player with light/dark/checker backgrounds, individual state playback, still mode, and half-speed inspection.

| State | Playback | Suggested trigger |
| --- | --- | --- |
| idle | Loop | Available and waiting |
| doze-off | Once | Inactivity transition |
| sleep | Loop | Inactive/quiet state |
| curious-bounce | Once | Attention, discovery, or a playful response |
| drag-right | Loop | Pull toward the right |
| drag-left | Loop | Pull toward the left |
| elastic-swoop | Once | Exaggerated elastic response |
| release-settle | Once | Release, squash, and recovery |

The two horizontal drag clips share source motion; left is mirrored. The source footage does not provide a matching four-direction drag set, so no upward/downward clips are labeled as such. The earlier v2 four-direction clips remain in their original package if needed.

## Integration

Use a muted inline video and set `loop` from the manifest, not globally. On one-shot completion, hold the last frame or switch to the corresponding end poster; then transition to the next state. Suggested sequence: idle → doze-off → sleep. Reactions can return to idle after a short blend. The separate source videos have different poses/proportions, so instantaneous cross-state cuts are not guaranteed to match. Position the outer player using the app's pointer/edge logic. These assets provide motion, not pointer tracking, collision detection, or live gaze control.

`drag-right` and `drag-left` are stabilized around the character so source-stage translation does not move the UI element around. There is no frame-by-frame size normalization: each clip uses a fixed scale so the stretching remains visible. Scale differs between states to fit the full silhouette. Final UI sizing may need state-specific adjustment.

The original stage, audio, floor shadow, floating punctuation and most detached particles have been excluded. Bright reflections are baked into the source RGB; alpha is a foreground cutout, not physically accurate glass transmission/refraction. White-lit glass naturally has bright rims on dark surfaces. Fine contours may retain small compression/matting artifacts, especially when enlarged beyond the target size.

Loops use forward/reverse motion with no duplicated endpoint frames. These deliberately reversible loops retain the supplied motion without inventing intermediate poses; they are not continuous physics simulations. One-shots retain their forward source timing. For performance use one active decoder, unload/pause hidden videos, and choose a PNG fallback for reduced motion. File size alone does not determine playback cost; test on the minimum target hardware.

## Source mapping

- `WhatsApp Video 2026-10-26 at 5.07.29 PM (1).mp4`: idle, doze-off, sleep.
- `WhatsApp Video 2026-10-26 at 5.07.29 PM (2).mp4`: curious-bounce.
- `WhatsApp Video 2026-10-26 at 5.07.29 PM.mp4`: directional pull, elastic-swoop, release-settle.

Exact source frame ranges and source filenames are recorded in the manifest. Supplied originals are not modified or included in the ZIP. `build.py` and `matte.py` contain the reproducible edit/export recipe; they require Python with NumPy, Pillow, OpenCV, plus FFmpeg. Adjust INPUTS in build.py when rebuilding on another machine. No Cobble application source was changed.

## Revision 3.1 — sleep ring repair

The sleep animation's nearly white ring glow was mistaken for background by the original color key, occasionally removing the lower ring and body. `repair_sleep.py` propagates complete alpha outlines from neighbouring clear frames using optical flow; the colour in every frame still comes from the original footage. This restores the ring/body through the glow. Standard WebM, animated WebP, lite WebP and sleep posters are updated. Other animations are unchanged.

To rebuild this repair from scratch: run `python build.py`, then `python repair_sleep.py`, then `python build.py sleep`. The repair script uses the rest video path in SOURCE. It creates a separate repaired frame cache and retains the previous cache for comparison.
