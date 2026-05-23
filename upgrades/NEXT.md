# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- minor = new feature, requires meaningful user-visible behavior addition -->

## What Changed

**feat(topic-intent-layer): Layers 1-3 — per-topic confidence tracking + resume briefing + ArcCheck pre-send signal.**

A new three-layer feature that gives the agent a real sense of each conversation's arc. When you talk to the agent across many turns (or days, or after a context reset), it now keeps quiet track of what the topic is about, what's settled, and what's still tentative — without you ever typing a command. The agent does the bookkeeping in the background.

- **Layer 1** — a per-topic confidence tracker. Each candidate fact or decision the conversation establishes is tracked with confidence that rises with reinforcement (you re-reference, you affirm) and falls with contradiction or long silence. Authority requires user-authored evidence — the agent cannot silently promote its own guesses to "settled" by re-referencing itself.
- **Layer 2** — a briefing the agent reads at the top of every session resume. Telegram bootstrap automatically fetches it and prepends it to the recent-history block. Settled items shown unhedged; tentative items shown with confidence; observation tier (background noise) deliberately not surfaced.
- **Layer 3** — ArcCheck, a pre-send signal that fires when the agent's draft would either act on a tentative item without confirming OR contradict something already settled. Signal-only — the agent decides whether to redraft including a natural-language confirmation question. Never blocks.

Spec: `docs/specs/topic-intent-layer.md` (v14 CLEAN, approved 2026-05-22, 14 internal rounds plus 13 external rounds).

This build was also the test bed for evaluating whether to integrate GSD as a runtime dependency. Verdict: cherry-pick the methodologies into Instar primitives, do not try runtime composition. Comparison report archived at `.planning/SPIKE-FINDINGS.md` plus `.planning/phases/01-layer1/PLAN.md`.

## Evidence

The original failure modes that motivated the feature are documented as canonical incidents in the spec — qalatra topic 9235 (arc drift across a multi-turn investigation) and GCI/Luna topic 365 (decision amnesia where the agent proposed redesigning a settled OAuth architecture mid-debugging, contradicting an earlier decision).

96 tests across all three tiers, all green locally:
- Decay arithmetic at days 104, 105, 106 matches spec values to 3 decimal places.
- User-authored-episode authority gating clamps at 0.69 when no qualifying user-authored episode exists.
- Per-message dedup with larger-delta-wins on collision.
- Pending-confirm queue depth 3 with silent drop plus telemetry counter.
- Sharpen-retry up to 2 then abandoned.
- PII-safe diagnostics endpoint (raw evidence meta allowlist-filtered, never returns user message text).
- Framework-parity grep gate (zero Claude-Code or Codex-CLI specific tokens in any Layer 1/2/3 source).
- Tier-3 lifecycle test boots through the real production server path and observes tier transitions through HTTP.

Side-effects review artifact: `upgrades/side-effects/topic-intent-layer.md`.

## What to Tell Your User

In long, multi-day, or multi-topic conversations, the agent stays on-point. It resumes knowing the goal. It stops re-litigating things you already settled together. When it is about to do something based on an assumption that might be wrong, it asks first in plain English, as part of its reply. When you correct it, it actually updates.

In short, simple conversations, nothing changes. The layer only kicks in once a conversation has substance worth tracking, and stays quiet otherwise.

No commands to learn. No configuration to set. The agent does the bookkeeping; you just talk.

A diagnostics view per conversation tells you exactly what the agent is tracking, how confident it is, what signals built that confidence, and whether anything is in conflict.

## Summary of New Capabilities

- New core modules covering confidence tracking, pending-confirmation lifecycle, LLM-backed extraction, resume briefing rendering, and pre-send classifier.
- New HTTP routes for diagnostics, refs filter, pending state, telemetry, briefing, and ArcCheck.
- Telegram bootstrap hook auto-fetches the briefing on session resume. Degrades open on any failure.
- Production server boot path constructs the store and passes it to AgentServer. Mount unconditional (503 stub when store disabled).
- Out of v1: cross-conversation insight spreading, retroactive backfill of pre-shipped conversations, cross-machine CRDT collaborative state, automatic conversation renaming, rich dashboard editor, user-tunable confidence weights (operator may tune; end user cannot).

Layer 3's outbound-path wiring (the actual every-send-fires-ArcCheck plumbing into the tone-gate and response-review stack) is intentionally separated from this ship. The classifier IS the spec's Layer 3 mechanism; the rollout is best done with care under a dedicated follow-up since it touches the existing outbound gate authority.
