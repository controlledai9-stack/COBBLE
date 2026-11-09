# Pebble reference media integration

Source update after 0.4.2, 28 October 2026. Merges Vyom's six commits through `9066470`, keeping native discussions, menu controls, screen bounds and the provided celestial design. Adds the user's `pebble-reference-v3.1.zip` motion assets.

Only runtime WebM clips, PNG fallbacks/end posters, manifest and provenance README were extracted into `assets/pebble/reference-v3.1`. Archive scripts were read as supporting material, not executed. Vite imports media into its production output, so the existing installer packaging includes them on a future rebuild without any user downloads.

Playback mapping:

- Available: looping idle.
- Inactive: doze-off once, then looping sleep.
- New local notice while available: curious bounce once, then idle.
- Dragging: elastic swoop once, then left/right drag loop. Direction follows horizontal pointer movement; vertical dragging uses the last horizontal direction because the pack has no vertical clips.
- Release: settle once, then idle.

One active player, muted audio, pause when hidden, static PNG for reduced-motion preferences or playback failure. A fixed invisible coordinate plane preserves native drag anchoring across video changes. The supplied motion is preserved; visual transition tuning is deferred until the user's feedback. Old reference footage and vector source remain available.

Integration fixes also scope local message deletion to the selected team, make local-copy semantics explicit, validate workspace deletion before changing connections, preserve hosting when deleting an unrelated workspace, and block workspace deletion during handover/main integration.

The existing 0.4.2 installer predates this update. Test current source with `npm run dev`; use Electron for native windows and dragging. These are local-first deletions, not a distributed message retraction protocol.

Validation: production assets include eight WebM clips and eight PNG fallbacks. Electron decoded the reference video; companion checks passed native anchoring at 100/125/150% zoom, release/cancel behavior and no window wandering. Desktop workflow checks passed the hosting dialog, themes, native discussions and backup flows. A queue-priority test now compares queued chat/receipt requests, excluding independent hosting heartbeats that can arrive first; production queue behavior was unchanged.
