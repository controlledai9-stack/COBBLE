# UI integration 0.4.2

Merged Vyom's `b94d7c1eabb3b7643bb48c56454e8c8a3416d984` into the existing backend branch. This keeps his light/black themes, full-window Discussions, workspace dialog, sidebar profile placement and mini-chat design.

Integration repairs:

- Mounted the delivered hosting panel in Workspace & Hosting and restored initial hosting, invitation, project-folder and pairing controls.
- Connected Workspace & Hosting and Connected IDEs dialogs, with focus trapping, Escape dismissal and focus restoration. Starting plans remain required.
- Kept manager permissions separate from the current host. Local-only sessions cannot evaluate hosts; transfer/fencing locks disable submissions. Displayed endpoints follow the actual host rather than this laptop's candidacy address.
- Fixed native mini-chat minimum-size handling, state synchronization, reopening and whole-app shutdown. Team switches reset chat drafts. Voice capture cleans up on unmount and ambiguous recipients require a choice.
- Improved hosting contrast in both themes without replacing the mascot artwork or backend protocols.

Verification includes backend tests, hosting authority/rendering regression tests, real desktop interaction checks, light/dark screenshots, native mini-chat sending/minimizing/reopening, and companion/shutdown checks. See the release record for final package evidence.

Remaining validation: real cross-city laptops, physical microphone capture, different Windows display configurations and a clean Windows VM install. Backup/recovery and maintenance settings still need their own presentation work. Backend crash failover remains separate from planned handover.

The upstream hosting delivery note describes an isolated component handoff; the actual upstream commit also changed renderer, window code and tests. This record describes the integration of that complete commit.
