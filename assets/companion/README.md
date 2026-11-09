# Pebble companion

The desktop companion uses the approved cinematic Pebble assets in `pebble/`.
See [runtime asset notes](pebble/README.md) for formats and playback behavior.

The renderer bundles the transparent standard/lite WebM clips and PNG fallbacks
using Vite asset URLs. It does not depend on preview exports in output/ or files
in Downloads. The sleep video includes the repaired ring/body alpha.

Pebble waits, stretches left/right during dragging, settles after release,
greets interactions, and dozes before sleeping after the existing 45-second
idle timeout. Profile and companion controls expose Auto, Full, Lite,
and Off motion settings. Auto considers reduced motion and CPU concurrency;
hidden playback is unloaded and decoding failures use still fallbacks.

The current UI preserves the location where the user places Pebble, including
when it becomes idle. Specific IDE-window anchoring and live gaze tracking are
separate from these pre-rendered animations.
