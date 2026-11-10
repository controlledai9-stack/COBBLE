# Pebble runtime assets

Transparent video and still exports adapted from the user's Google-generated
reference videos, with the v3.1 sleep ring/body alpha repair. These are the approved
cinematic motion assets, not the earlier procedural wobble studies.

Standard: 512px, 24fps VP9 WebM with alpha. Lite: 256px, 12fps VP9 WebM
with alpha. PNG files are static fallbacks. The renderer uses Vite asset URLs so
the clips ship inside dev and packaged builds without referring to output/ or
the original Downloads videos.

idle, sleep, drag-left and drag-right loop. doze-off, curious-bounce and
release-settle play once, then transition in the Pebble component. Sleep follows
doze-off after the existing 45-second idle timeout, at its user-placed location. Hardware concurrency
and reduced-motion preferences inform Auto; explicit Full, Lite and Off choices
are saved locally and synchronized across the app windows. Hidden windows unload
video playback, and failed decodes fall back to a still.
