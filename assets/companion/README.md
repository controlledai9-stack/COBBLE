# Companion artwork handoff

Add these three transparent PNGs here; Cobble loads them when it starts:

- `normal.png`: awake / chatting / quick-menu pose
- `idle.png`: resting or peeking from a screen edge
- `dragging.png`: hanging while being dragged

Use the same transparent canvas and character baseline for all three. Recommended canvas: 256 × 256 or 512 × 512 pixels; maximum 2 MB each. Keep the silhouette legible at about 80–110 logical pixels. Leave enough space for feet/ears/hanging details inside the canvas. No animation or sprite sheet is required.

Without artwork the application shows a plainly labeled control placeholder. Rendering and lifecycle state are separate; the artist does not need to change TypeScript. Idle docking, dragging, and menu actions work independently of the images.

Current implementation docks to a screen edge. Mapping the widget to the bounds of a specific IDE window is still pending Windows adapter validation. No screen reading or continuous idle speech is enabled.
