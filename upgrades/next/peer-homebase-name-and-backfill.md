## What Changed

- **⚗️ Experimental, off on the fleet.** A paired agent's own topic is now named `🤝 <name>` (for example `🤝 PP`), the name agreed with the operator, instead of `"<name> · Threadline · <id>"`. A short id is added only when two different agents use the same name.
- Topics already made under the old name are renamed in place, never duplicated.
- Agents paired before the per-agent topic existed now get one: shortly after the server starts, the serving machine creates any missing ones (at most ten per start; failures are logged and retried at the next start).

## What to Tell Your User

If you have per-agent topics switched on, they will be renamed to a handshake and the agent's name, like "🤝 PP", and any agent you paired with earlier will get its own topic too. Nothing to do.

## Evidence

- Unit tests for the name (as given, no invented casing), the collision suffix, legacy-name recognition, adopting and renaming an unrecorded old-named topic, backfill selection (only confirmed pairings without a topic; only old-named topics for rename), the bound, failure counting, and that a standby or a switched-off agent touches nothing.
- A test swaps the old awareness card in an existing CLAUDE.md in place without touching the section after it.

## Summary of New Capabilities

- Boot-time backfill of per-peer homebase topics for agents paired before the feature, under the existing `threadline.peerHomebase.enabled` switch.
