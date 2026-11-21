<!-- bump: patch -->
## What Changed

First piece of the context budget's Phase 2 (shadow folding, still switched off). Two new internal modules hold the deterministic half of a fold:

- **The handoff check** (`src/monitoring/foldHandoff.ts`): a strict parser for the note a session writes before a fold ("what I finished, what to keep word for word, what's open"). A verifier checks it without a model:
  - the finished stretches fall inside the conversation and don't overlap;
  - anything labelled as the operator's words is exactly one of the operator's messages, and otherwise it is relabelled as the session's own;
  - tool output points at a real transcript entry;
  - "no background work" doesn't contradict the evidence;
  - every message is accounted for exactly once.
- **The resume packet** (`src/monitoring/foldPacket.ts`): builds the restore bundle stable-first (purpose, the operator's recent words, the long view, decisions, phase, current work, the session's handoff, the verbatim tail, pointers). It opens with a marker saying this is restored context, not a new request. A verifier refuses a packet if:
  - an operator quote differs from its message;
  - tool output sits in a protected section;
  - derived text looks like an operator quote;
  - a kept item is missing;
  - the packet is too large.
  Only a verified packet is staged (private, single-use). A new `staged-fold-packet` fold carrier releases it when the fold ends, and the boot sweep releases it after a crash.

No route, config key or live behaviour changes. Nothing calls these modules yet except the boot sweep's carrier pass.

## What to Tell Your User

Nothing changes yet. This is groundwork for letting long conversations shrink their working memory safely. The first practice runs come in a later update, still switched off by default.

## Summary of New Capabilities

- None user-visible. Internal: the fold handoff verifier, the fold resume-packet renderer, verifier and stager, and the `staged-fold-packet` fold carrier.

## Evidence

- Unit: `tests/unit/fold-handoff.test.ts` (14) covers parser strictness, the relabel, tool-entry resolution, inverted, overlapping and outside spans, gaps kept as unclassified, background contradiction, and decision binding. `tests/unit/fold-packet.test.ts` (16) covers stable-first order, the marker, verbatim quotes, tool output framed outside A/G/U, changed, altered or missing rows refused, a forged frame line refused, a dropped kept item refused, the size limit at and over, staging 0600, torn reads, and carrier release.
- Integration: `tests/integration/fold-coordinator-boot-wiring.test.ts` checks that a staged packet is released by the boot abort and swept as an orphan with no record (14/14).
- E2E: `tests/e2e/fold-coordinator-crash-lifecycle.test.ts` checks a staged packet across a real process crash: freed before the point of no return, kept under quarantine past it (4/4).
