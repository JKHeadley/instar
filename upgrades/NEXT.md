# Unreleased

## What Changed

Threadline notifications no longer spam your chat list with a new topic per event (CMT-519).

- **One routing rule, never a per-event topic.** A conversation tied to a parent topic shows its real replies there (already working). Everything else — a cold peer reaching out, plus all housekeeping notices (loop-gate "I stopped a loop", etc.) — goes to a single, SILENT "Threadline" hub topic. The loop-gate wind-down now routes through the hub instead of creating its own attention topic, and `POST /attention` redirects any threadline/agent-messaging-class item to the hub so ad-hoc posts can't regress into topic spam either.
- **The Threadline hub is calm and silent.** Agent-to-agent chatter doesn't buzz you and isn't framed as "waiting for you" — it isn't your job by default. The hub is a browsable record you check when you want.
- **"Open this" finally works.** When you're in the Threadline hub and say "open this" (or "tie this to <an existing topic>"), the agent calls the new `POST /threadline/hub/bind` endpoint, which creates+binds a fresh topic (or binds to the one you named) and authoritatively records it. From then on that conversation's updates flow to the bound topic automatically.

## What to Tell Your User

Your chat list won't fill up with throwaway "Threadline conversation loop" / "spawn-storm" topics anymore. Background agent activity lands quietly in one "Threadline" topic instead — no buzzing, because two agents talking isn't your problem by default. When you glance in there and want to pull a conversation into its own space, just say "open this" (or "tie this to <topic>") and I'll set it up. No action needed; this just declutters and makes background collaboration calm.

## Summary of New Capabilities

- `CollaborationSurfacer.notify()` — a silent-hub status lane that threadline subsystems use instead of the per-event attention queue.
- `POST /attention` auto-redirects threadline-class items to the hub (structural anti-spam guard).
- `POST /threadline/hub/bind` (`action: open|tie`) — promote/bind a surfaced conversation to a topic; authoritative (sets `boundTopicId` + the commitment's `topicId`).
- Hub surface-state is record-shaped (peer/subject/surfacedAt/bound) with a read-time migration from the legacy `string[]`.

## Evidence

- Verified against v1.2.81 source; design converged by two reviewers (collapse into the existing surfacer; content→parent via TopicLinkageHandler, status→silent hub, no double-notify).
- 3-tier tests: new unit coverage for `notify()` (silent hub, no per-thread dedupe), `mostRecentUnbound`/`markBound`, and the legacy→record migration; full threadline suite green (1553 unit/integration + 329 e2e, zero regressions). Typecheck + build clean.
- Independent second-pass review of the diff; live test-as-self on Codey (a real agent conversation lands quietly in the hub, "open this" promotes it to its own topic).
