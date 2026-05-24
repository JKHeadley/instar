---
slug: human-as-detector
title: HumanAsDetectorLog — treat a human-caught coherence break as a guardian-failure signal
author: echo
source: Dawn handoff (the-portal/.claude/instar-feedback/handoff-human-as-detector), 2026-05-24
review-convergence: "2026-05-24T20:23:19.780Z"
review-iterations: 2
review-completed-at: "2026-05-24T20:23:19.780Z"
review-report: "docs/specs/reports/human-as-detector-convergence.md"
approved: true
approved-by: justin
approved-at: "2026-05-24T20:53:00Z"
eli16-overview: human-as-detector.eli16.md
---

# HumanAsDetectorLog

## Problem statement

When the user has to surface something wrong — a stale claim, a contradiction, a state
incoherence, "why didn't you catch this" — Instar today treats it as a normal input to fix
quietly. That throws away the most valuable signal in the whole system.

A human correction is **evidence that some automated monitor/gate/guardian that should have
caught the break didn't.** Logged over time, these corrections form a heat map of "where the
human is doing the system's job" — which reveals exactly which automated layers are dead
weight and which coverage gaps are real. This is the *user-feedback facet* of the Continuous
Working Awareness north star (`docs/NORTH-STAR.md`): **never let a user correction go to
waste.**

Instar already has `CoherenceMonitor`, `CoherenceGate`, and `DegradationReporter` — but all of
those watch the system's OWN state. **None treat a human correction as a signal.** This spec
closes that gap.

The lesson is Dawn's (2026-04-26, "Justin Pointing Things Out = Guardian Failure"), handed off
for porting into Instar. Dawn's handoff explicitly routes ratification through Justin: "Echo
turns this into a formal spec, takes it to Justin for ratification, and ships via PR." This
document is that formal spec.

## Proposed design

A new monitor, `src/monitoring/HumanAsDetectorLog.ts`, mirroring the established
`DegradationReporter` shape:

- **Singleton.** `getInstance()`, `configure({ stateDir, agentName })` at startup,
  `resetForTesting()` for tests.
- **`classify(text)`** — pure, deterministic, no I/O. Lowercases the text, tests a
  conservative weighted regex signal set, returns
  `{ category, suspectedFailedLayer, confidence, matchedSignals }` or `null`. The
  unit-testable core. No LLM, no network.
- **`observe({ text, source, topicId?, messageId? })`** — calls `classify`; on a hit, records
  to an in-memory ring (capped 200) + appends one JSONL line + emits a single loud
  `console.warn`. **Best-effort; never throws into the caller.** Returns the signal or `null`.
- **`summarizeByLayer()`** — groups recorded signals by suspected failed layer, most-frequent
  first. The heat map.
- **`observeInboundMessage(log, entry, source)`** — the gating decision extracted from the
  server wiring so it is unit-testable: observe ONLY inbound HUMAN messages that carry text;
  agent-authored and empty entries are skipped.
- **Persistence (metadata only):** append-only `<stateDir>/metrics/human-as-detector.jsonl`,
  wrapped in try/catch (the `console.warn` is the safety net if disk write fails). **The
  on-disk record carries metadata only — never `messagePreview` (the user's raw words).** A
  secret or PII a user types mid-correction must not leak into a long-lived append-only audit
  trail; the preview stays in the in-memory ring for the live session's heat map and is
  dropped before persistence. The file is created `0600` and the `metrics/` dir `0700` as
  defense-in-depth on the metadata that remains. *(Both hardenings added during spec
  convergence — the security reviewer flagged the cleartext-preview-on-disk leak.)*
- **Restart durability:** `configure()` hydrates the in-memory ring from the last 200
  persisted records (best-effort, try/catch). The heat map (`summarizeByLayer` + `recent`)
  reads only the ring, and instar restarts often (auto-update, lifeline coordination) — without
  hydration the heat map would silently empty on every restart even though the history is on
  disk. Hydrated entries have an empty preview (it was never persisted); the per-layer counts —
  the point of the heat map — are fully restored. *(Added during spec convergence — the
  scalability reviewer flagged the volatile-ring-empties-on-restart gap.)*

**Categories** (each signal rule maps to the guardian layer that should plausibly have caught
that class of break): `factual-correction`, `staleness`, `contradiction`,
`source-of-truth-drift`, `repeat-ask`, `meta-failure`.

**Precision over recall (deliberate).** Signals are weighted; a lone weak signal (e.g.
"actually,") is below the `totalWeight >= 2` threshold and ignored, because a false positive
pollutes the heat map while a miss only loses one data point. Confidence: `>=5` high, `>=3`
medium, else low.

### Wiring (server.ts, additive — ~10 lines)

1. Configure the singleton at startup, next to `DegradationReporter` (`stateDir`, `agentName`
   = `config.projectName`).
2. Chain `observeInboundMessage(log, entry)` onto `telegram.onMessageLogged`, **preserving any
   prior callback** (TopicMemory dual-write, PresenceProxy, keep-watching) by capturing and
   calling the existing callback first. Only inbound human messages are observed.

### Observability surface

Read-only `GET /human-as-detector/summary` returns `{ byLayer, recent }` (the heat map grouped
by suspected failed layer, plus recent signals). The route is singleton-backed (always
available; no 503 path). It is classified in `INTERNAL_PREFIXES` (operator-only observability,
matching `quota`, `watchdog`, `telemetry`, `scope-coherence`, `rate-limit`) — the heat map is a
diagnostic surface, not an agent-discoverable capability. Agent-side surfacing (e.g.
"you've corrected me on staleness three times") is a future Usher/evolution rung, not this PR.

## Scope — Telegram-first (deliberate, tracked)

This PR wires the observer onto the **Telegram** inbound path only. Slack, WhatsApp, and
iMessage each have their own `onMessageLogged` chain and are **not** observed yet, so a
correction made over those adapters produces no signal and the heat map under-counts for
multi-adapter agents. This is a deliberate v1 boundary, not a silent omission: the classifier
and `observeInboundMessage` gate are adapter-agnostic, so extending to the other adapters is a
small, mechanical follow-up <!-- tracked: cwa-multi-adapter-capture --> (chain
`observeInboundMessage` onto each adapter's `onMessageLogged`, inbound-human only). Tracked as
a same-effort follow-up <!-- tracked: cwa-multi-adapter-capture -->, not an orphan note.
*(Raised by the lessons-aware reviewer as a multi-entry-point trap — engaged explicitly here
per the No-Deferrals standard.)*

## Side-effects review

- **Over-block:** none — the module gates nothing; it cannot block any action.
- **Under-block / false negatives:** the conservative `totalWeight >= 2` threshold means some
  genuine corrections won't register. Accepted by design: a missed signal loses one data
  point; a false positive pollutes the heat map. Precision over recall is the right bias for a
  diagnostic that informs (not gates) evolution.
- **False positives / poisoning:** a user can trivially skew counts by repeating correction
  phrases. Accepted because the signal **gates nothing** — poisoning degrades a diagnostic, not
  a control. `source`/`topicId` are recorded so an operator can spot single-source flooding.
- **Level-of-abstraction fit:** a singleton monitor mirroring `DegradationReporter`, chained on
  the existing `onMessageLogged` callback — the same seam other message observers use. No new
  abstraction introduced.
- **Interactions:** chains (not replaces) the prior `onMessageLogged` callbacks (TopicMemory
  dual-write, PresenceProxy, keep-watching) by capturing and invoking the predecessor first —
  verified across all four chain links. The new route is classified in `INTERNAL_PREFIXES`, so
  the discoverability gate is satisfied.
- **Privacy:** raw user text never reaches disk (metadata-only persistence, `0600`); a future
  consumer that feeds `messagePreview` (in-memory) into an LLM would reintroduce a
  prompt-injection surface — flagged here for that future rung.
- **No kill-switch (deliberate):** there is no `enabled` config flag. Justified: `observe`
  never throws, I/O is gated behind a classifier hit (rare, human-paced), and the blast radius
  of a misfire is a noisy JSONL line + one `console.warn`. A flag can be added later if the
  classifier proves noisy in production; it is not warranted for a signal-only, never-throws v1.
- **Rollback cost:** trivial (see *Risk and rollback*).

## Why this is signal, not authority

The log only **records** and **summarizes**. It has no blocking authority and gates nothing.
Consumers — a human reading the heat map, or future evolution tooling — decide what to do.
This conforms to the signal-vs-authority standard (`docs/signal-vs-authority.md`): a brittle,
low-context regex detector emits signals only; it never vetoes.

## Risk and rollback

Low. Additive, isolated module. Worst case on a logic bug: a spurious JSONL line or a missed
signal — neither affects message delivery, because `observe` never throws into the caller. The
classifier's false-positive risk is bounded by the `totalWeight >= 2` threshold. Rollback is
trivial: drop the module, the endpoint, the `INTERNAL_PREFIXES` entry, and the ~10 wiring
lines — no schema, no migration, no config default.

## Migration parity

The feature is server-side code (the wiring lives in `server.ts`, which every agent runs on
update) plus a new read-only route. There is **no** agent-installed-file change — no hook, no
`.claude/settings.json`, no config default, no CLAUDE.md template entry (the route is internal,
so adding it to the agent-facing template would be inconsistent). Therefore no
`PostUpdateMigrator` work is required: agents receive the behavior with the server code on
their next update.

## Build-on-current-main caveat (from the handoff)

Dawn's reference module + tests are correct, but her **local Instar checkout is 405 commits
behind `origin/main` with 719 staged changes (138 deletions of real upstream files).** Building
from it would silently revert the `SafeFsExecutor` destructive-operation containment (PRs
#98/#99) and the iMessage `[image:/path]` attachment inlining (commit 2d4deb73). This spec is
implemented **fresh on current main**; the ~10 wiring lines are re-applied by hand, never
copied from her staged `server.ts`. (The irony is noted: blindly committing her tree would
cause exactly the silent regression this module exists to detect.)

## Testing (all three tiers — Testing Integrity Standard)

- **Tier 1 (unit, 22):** `classify` across every category + both sides of the
  weight-threshold boundary; `observe` records/persists/never-throws; `summarizeByLayer`
  ordering; `observeInboundMessage` wiring-integrity (inbound-human observed; agent / empty /
  non-correction skipped); and the convergence-added privacy/durability tests (preview never
  hits disk; the heat map hydrates from disk on a fresh instance; hydration is a safe no-op
  with no file).
- **Tier 2 (integration, 3):** `GET /human-as-detector/summary` through the real `createRoutes`
  pipeline — empty before any signal, surfaces a recorded correction, ignores a non-correction.
- **Tier 3 (e2e, 2):** boots `createRoutes` on a live HTTP server — endpoint alive (200, not
  503), and an observed correction flows to the live endpoint AND to the JSONL on disk
  (cross-session audit trail).
- `npx tsc --noEmit` clean; `npm run lint` clean (destructive-tool + LLM-HTTP + codex-rule1).

## Acceptance criteria

1. A human correction over Telegram produces exactly one signal in
   `.instar/metrics/human-as-detector.jsonl`, mapped to a plausible failed layer.
2. A non-correction message produces no signal.
3. `GET /human-as-detector/summary` returns the heat map and recent signals; never 503.
4. Message delivery is never blocked or slowed by the observer (best-effort, never throws).
5. No existing upstream feature is reverted; all three test tiers and lint are green.
