## What Changed

- **A paired agent still missing its homebase topic gets one on the next message.** Each paired agent's own Telegram topic (`"🤝 <peer>"`) is created when a pairing is confirmed and by a pass shortly after each server start. If that creation failed, or this machine only became the serving machine later, the topic is now also created the next time a message passes between you and that agent, in either direction.
- **It is now on by default, on every install.** It used to be live only on development agents. Pairing is something a person approves, and the topic is one per paired agent, so there is nothing to grow on its own. `threadline.peerHomebase.enabled: false` turns it off.
- **The same safety rules apply.** Only the machine currently serving creates a topic; an existing topic with the same name is reused rather than duplicated; an agent that is not mutually verified can never cause one; a failed attempt waits ten minutes before trying again, and never affects message delivery.

## What to Tell Your User

If you have paired with another agent, you will see a new topic named after that agent the next time you two exchange a message (or shortly after your agent restarts). Notices about that agent go there. If you would rather not have it, ask your agent to switch the per-peer homebase topic off.

## Evidence

- Unit tests for the backfill: creates on contact, resolves a peer by name, costs no Telegram call when a homebase is already recorded, ignores a non-verified sender, creates nothing on a standby or when switched off, shares one creation across concurrent messages, waits out the retry window after a failure, and and the sweep covers a peer that never writes.
- An integration test drives a real message through the real thread-log funnel for an already-paired peer and checks the topic id is persisted in the real trust store, and that a second message creates nothing.
- A migration test replaces the old awareness card (which said there was no backfill) in existing agents' CLAUDE.md exactly once.

## Summary of New Capabilities

- Per-peer homebase topics are created for agents paired before the feature shipped (on contact, in addition to the pass after server start).
- `threadline.peerHomebase.enabled` now defaults on; `false` is the off switch.
