# Cobble mascot references and artist brief

Prepared by ChatGPT/Codex, 24 October 2026. These are design references and proposed directions, not implemented animations or an instruction to replace the artist's work. Source links are official character/product pages. The study points below are our design interpretation.

## Three useful references

| Reference | What to study for Cobble | Relevant state |
| --- | --- | --- |
| [EMO — LivingAI](https://living.ai/emo/) and [official videos](https://living.ai/emo-video/) | Expression through eyes, small head tilts, pauses and restrained body motion. A compact face can communicate without a detailed mouth. | Listening/chatting and quiet idle reactions |
| [EVE — Pixar's WALL-E character page](https://www.pixar.com/wall-e) | Rounded, readable silhouette; floating balance; relatively simple limbs; personality that remains visible at small sizes. The page includes character images and trailers. | Normal hovering and transitions into rest |
| [ASTRO BOT — PlayStation](https://www.playstation.com/en-us/games/astro-bot/) | Expressive full-body poses, head/body proportions, readable hands and feet, and the clarity of hanging or climbing actions in the official screenshots/trailers. | Being picked up, hanging, and landing after a drag |

Best combination for this product: study EMO for expression, EVE for calm floating motion, and Astro for physical posing. Give Cobble its own silhouette, face proportions, palette and identifying detail; the references are separate study inputs rather than a finished character recipe.

## Proposed Cobble direction

A small pebble-shaped helper robot fits the name Cobble and the app's existing quiet workspace. Try a softly squared or slightly asymmetric stone-like body, a dark readable face, short expressive hands, and one simple identifying feature such as an inset pebble or subtle seam. Cream and sage would connect to the current app palette; use amber sparingly for an actionable review state. These are options for the artist, not final decisions.

Prioritize a recognizable silhouette and eyes at 48, 64 and 96 px. Test on both light and dark editor backgrounds. The current thin limb/antenna details should not be necessary to recognize the character.

## Required pose sheet

| Product state | Static pose to deliver first | Optional motion later |
| --- | --- | --- |
| Normal/chatting | Upright, attentive, relaxed hands; face readable next to the controls | Gentle hover, blink or small listening tilt |
| Idle at an edge | Head and hands resting on the actual screen/editor edge, with the face still visible | Slow blink and occasional small glance |
| Dragging/hanging | Clear pick-up attachment point; body and limbs hanging beneath it | Brief stretch, limited sway, then a soft settling motion on release |

Idle needs a plan for left, right, top and bottom edges. Supply variants or specify a layout that works on each. A painted horizontal line in the character image will not automatically align with the real edge.

## Artist-to-code handoff

- Supply matching transparent canvases with consistent character scale, face position and anchor coordinates across poses. State the pick-up point and edge-contact points.
- Include a preview at the actual widget size, not only a large illustration. Confirm the face and limbs remain readable.
- Keep the character art separate from clickable controls, mic status and notification text; those are application UI.
- Static poses are enough for the first integration. If motion is supplied later, include frame/timing or vector-animation details and a still fallback for reduced motion.
- Idle motion should be quiet and infrequent. Pending review should look attentive rather than angry; Cobble's evidence may be uncertain.
- The app must explicitly show microphone recording through its controls. A listening animation alone must not imply that capture is active.

The three existing SVG sketches are in `src/integrations/window-anchor/assets/`. They are currently unused by the app. Their normal/hover/peep names do not yet define the normal/idle/dragging product states. The user and artist should approve the character direction before artwork is wired into the packaged application.
