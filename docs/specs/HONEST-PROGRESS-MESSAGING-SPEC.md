---
title: Honest progress messaging — silent-freeze watchdog + promise-beacon truthfulness
date: 2026-06-12
author: echo
parent-principle: "Signal vs. Authority"
parent-principle-note: "Both systems are SIGNALS, not authority — they never block or gate. This change keeps them signal-only while making the signal itself honest: a session can be ALIVE yet working/failing, so surface the REAL state, never a falsely-confident guess. Extends the honest-standby (turn-receipts) work to the two remaining noise sources."
status: approved (pending review-convergence)
approved: true
approved-by: Justin
approved-via: "Telegram topic 25120 ('Topic UX') — Justin: 'Let's work on making them honest' (2026-06-12 21:58 PDT) then explicit wording sign-off 'yes, please proceed' (2026-06-12 22:38 PDT), after reviewing the two example messages in his screenshot and the exact proposed replacement strings."
eli16-overview: HONEST-PROGRESS-MESSAGING-SPEC.eli16.md
review-convergence: "2026-06-13T05:52:52.906Z"
review-iterations: 2
review-completed-at: "2026-06-13T05:52:52.906Z"
review-report: "docs/specs/reports/HONEST-PROGRESS-MESSAGING-SPEC-convergence.md"
cross-model-review: "gemini-cli:gemini-2.5-flash"
cross-model-review-note: "codex-cli unavailable on this machine (not installed); gemini-cli ran successfully on the iteration-2 spec (round 1 degraded, transient gemini-cli error). One genuine external pass earns the clean RAN flag."
frontloaded-decisions: 8
---

# Spec — Honest progress messaging

**Date:** 2026-06-12
**Author:** echo
**Status:** draft — to be tagged `review-convergence` via /spec-converge before /instar-dev build.

## Triggering report

Justin, in Telegram topic 25120 ("Topic UX"), reported a growing class of "confusing or not very helpful" messages appearing in topics — "inaccurate or false … just adding noise." His screenshot (Resource Limitation Mitigation topic) captured the two worst offenders:

1. **Silent-freeze escalation** — *"echo-resource-limitation-mitigation was working and went quiet about 16 minutes ago. I tried a gentle nudge and nothing came back. Want me to dig in?"* His verdict: "almost never accurate and certainly not helpful."
2. **Promise-beacon heartbeat (⌛)** — *"⌛ working on it — recent output observed — re: Digging into the evidence now…"* and *"⌛ still on it, no new output since last update — re: Digging into the evidence now…"* His verdict: "pops up randomly … I'm not even sure what it's referring to or what its purpose is."

Justin chose, of three offered options (silence / route-away / make-honest), to **make them honest**.

## Root cause (shared)

Both systems use **"the captured tmux frame stopped changing"** as a proxy for "something is wrong / nothing is happening." That proxy is false in the single most common case: a session running a long tool call, a sub-agent, or a long shell command shows a **static frame while genuinely working**. The systems then speak with **false confidence** ("went quiet", "no new output") about a session that is fine.

- `src/monitoring/sentinelWiring.ts` → `OutputActivityTracker.snapshot()` hashes the frame and records `lastOutputAt` = last time the hash changed; `looksActivelyWorking()` flags a frame as "working" if it shows a spinner / tool-call / `esc to interrupt` / `(running)` signature.
- `src/monitoring/ActiveWorkSilenceSentinel.ts` → escalates when `lastOutputAt` is older than `silenceThresholdMs` (15m) and a single Enter-nudge didn't change the frame within `verifyWindowMs` (30s).
- `src/monitoring/PromiseBeacon.ts` → fires every `cadenceMs` (10m) for any `beaconEnabled` pending commitment; an unchanged frame hash emits a templated "still on it / no new output" line (`TEMPLATED_VARIANTS`).

The dishonesty is concentrated in three places:
1. **ActiveWorkSilenceSentinel**: a session whose *current* frame still shows an active-work indicator (`esc to interrupt` / spinner present **right now**) is in an active turn — a long tool call — **not frozen**. The current candidate filter actually *requires* an active-work indicator to flag, so this false-positive class is exactly what it surfaces.
2. **PromiseBeacon**: the "still on it, no new output since last update" templated line carries **zero real information** — it is a heartbeat for its own sake. It also keeps firing because the commitment was never closed, quoting a task the user moved on from.
3. **Wording**: both assert a conclusion ("went quiet", "no new output") rather than reporting evidence with honest confidence.

## Scope (one PR — A, B, C, D)

### A — ActiveWorkSilenceSentinel: corroborate before claiming a freeze

**Files:** `src/monitoring/ActiveWorkSilenceSentinel.ts`, `src/monitoring/sentinelWiring.ts`, `src/commands/server.ts` (deps wiring).

**A1 — "still actively working" suppression (the core fix).** Before escalating, re-capture the session's *current* frame. If it **still shows an active-work indicator** (`looksActivelyWorking()` true on the live frame — `esc to interrupt`, spinner, `(running)`, tool-call signature), the session is in an active turn; **do not escalate, do not nudge.** A static frame *with* a live work indicator is a long task, not a freeze. Re-arm and keep watching.

**A2 — corroborating wedge evidence.** Add a `corroborateWedge(sessionName, liveFrame)` dep returning `{ likelyWedged: boolean; reason: string }`. Escalate **only** when **all** of these hold (single conservative condition — see FD-2, FD-3):
- (a) the live frame shows **no active-work indicator** (`looksActivelyWorking()` false), AND
- (b) the live frame is **not** a clean idle prompt — the turn ended but output stopped in an indeterminate state, AND
- (c) **no live sub-agent** exists for the session (SubagentTracker — see FD-4 for what "live" means), AND
- (d) the nudge produced **no change**.

The earlier draft's "OR a known stuck/error signature is present" alternative path is **removed** (FD-3): enumerating "stuck signatures" per framework is an unbounded, drift-prone judgment call, and the conservative all-of-(a–d) condition is strictly safer (it never escalates on a working session). A genuine error that leaves the session at an indeterminate non-prompt frame is already caught by (b).

**The whole escalation path fails CLOSED** (FD-6): if *any* step throws — the live-frame re-capture, `looksActivelyWorking()`, or `corroborateWedge` itself (SubagentTracker I/O error, capture failure) — the sentinel **suppresses the escalation and re-arms**. Unreliable evidence never produces a user-facing "it's stuck" claim. Captured once: `escalate()` captures the live frame a single time and passes it into `corroborateWedge` (no double tmux capture — perf finding).

**A3 — honest wording, honest confidence.** Replace the asserted-conclusion template with an evidence-and-uncertainty template:
> `<name>'s screen hasn't changed in <N> min and a nudge didn't wake it — it may be stuck, or on a long task I can't see into. Want me to check?`

The yes/no CTA is preserved (MessagingToneGate rule B14 requires it). The claim "a nudge didn't wake it" is only included when a nudge was *actually* sent and *actually* produced no change. The session name is sanitized through `guardProxyOutput()` before embedding (FD-7).

**A4 — raise the default threshold.** `silenceThresholdMs` 15m → 30m. Combined with A1/A2 this collapses the false-positive rate; a genuine wedge survives 30m of corroborated silence easily.

**A5 — frozen-indicator hard timeout (closes the A1 blind spot honestly).** A1 means a session that keeps an active-work indicator frozen on screen is *never* escalated — which would permanently hide a genuine hang that froze mid-tool (adversarial finding). Backstop: if a frame **with** an active-work indicator stays **byte-identical** for `activeWorkMaxFrozenIndicatorMs` (default **90m**), escalate once with an extra-hedged message:
> `<name> has shown the same "working" frame for 90 min with zero change — could be a long task, or a hang that froze mid-step. Worth a look?`

This is the honest middle ground: A1 suppresses the common false positive, A5 ensures the rare frozen-indicator hang still surfaces (just later, and clearly hedged).

### B — PromiseBeacon: silent unless there's something true to say

**Files:** `src/monitoring/PromiseBeacon.ts`.

**B1 — kill the "nothing changed" filler (the core fix).** When the snapshot hash is **unchanged**, emit **nothing** — do not send a templated "still on it" line. Persist the unchanged-count (for atRisk/auto-pause accounting) but send no message. The beacon speaks only when: (a) there is **genuine new output** (changed hash → real LLM-summarized progress line), (b) the commitment transitions to **atRisk**, (c) the commitment is **delivered/closed**, (d) a **deadline-pressure** exception fires (B1a), or (e) a **sparse liveness** tick is due (B1b). Gated by `suppressUnchangedHeartbeats` (default `true`); set `false` to restore the old every-tick behavior.

**B1a — deadline-pressure exception (honesty cuts both ways).** Total silence near a hard deadline is itself dishonest — the user is owed a signal when time matters. If the commitment has a `hardDeadlineAt` within `2 × cadenceMs`, an unchanged tick is **not** suppressed; it emits a low-confidence, honest line:
> `⏳ no visible new output on '<excerpt>', but still within your deadline (<time> left) — watching closely.`

**B1b — sparse liveness (don't go fully dark on a genuinely long task).** A multi-hour task with a static frame would, under B1 alone, produce zero signal between start and finish — trading noise for invisibility (adversarial finding). Backstop: at most **one** liveness line per `beaconLivenessIntervalMs` (default **60m**) while a session is still present and the turn is *not* finished:
> `⏳ still watching '<excerpt>' — <N> min in, no new output yet.`
This is ~6× quieter than today's 10-min spam, but a long task is never fully dark. Suppressed entirely once B2 detects the turn finished.

**B2 — tie liveness to the real session, not the frame.** If the session that made the promise has **finished its turn** (live frame is a clean idle prompt, no active-work indicator) or the **session is gone** (already handled via session-epoch → `violated:session-lost`), the promise is either done or abandoned. On "turn finished + still pending" for **N = 3 consecutive checks** (FD-1; ≈60m at 20m cadence — enough to rule out a momentary prompt-like frame mid-task), stop beaconing and emit **one** honest close-out prompt:
> `<name>: I said I'd follow up on "<excerpt>" but that work's session has wrapped. Want me to pick it back up, or close this out?`
…then auto-pause. The `<excerpt>` is sanitized through `guardProxyOutput()` before embedding (FD-7). No clockwork heartbeats into a finished room.

**B3 — milestone cadence, not clockwork.** Raise default `cadenceMs` 10m → 20m. The timer still ticks at 20m to *check*, but (with B1) only speaks on a real event, a deadline, or a sparse-liveness tick.

**B4 — drop the stale excerpt when it adds confusion.** Keep the `— re: <excerpt>` suffix only on the *first* real progress line and the close-out; omit it from subsequent lines (context is established).

**B5 — sanitize all quoted commitment text.** `promiseExcerpt()` derives from `userRequest` / `agentResponse` (LLM- or user-originated) and is embedded in every beacon message; today it is only whitespace-normalized + truncated. Route it through `guardProxyOutput()` (the same guard already applied to tmux-derived status lines) before embedding in *every* surface — heartbeat, close-out, auto-pause, and `transitionViolated` (FD-7, security finding). Unsafe content falls back to a neutral placeholder (`this task`).

### C — Docs alignment (the documented-vs-wired mismatch)

**Files:** `CLAUDE.md` template section (`src/scaffold/templates.ts` → `generateClaudeMd()`), `docs/specs/silently-stopped-trio.md` (note), this agent's `CLAUDE.md`.

CLAUDE.md states sentinel Telegram escalation is "OFF by default" behind `monitoring.sentinelTelegramEscalation`. The wired reality (server.ts:5100–5146, PR #334/#340) routes the trio's escalations through the tone-gated `/attention` path with **no such gate** — controlled only by `monitoring.{socketDisconnectSentinel,activeWorkSilenceSentinel}.enabled` (both default `true`). Correct the documentation to describe the actual control surface so the next reader isn't misled. Concretely: `generateClaudeMd` gains a short "silent-freeze watchdog + promise beacon: what they are, their defaults, how to tune/disable" subsection, and a content-sniffed `migrateClaudeMd` entry appends it to existing agents (Migration Parity).

### D — Config surface + migration parity

**Files:** `src/config/ConfigDefaults.ts`, `src/core/PostUpdateMigrator.ts`, `src/scaffold/templates.ts` (`generateClaudeMd`).

New/changed defaults (all added to `ConfigDefaults.ts` as the single source of truth; the hardcoded class defaults in the monitors are updated to match):
- `monitoring.activeWorkSilenceSentinel.silenceThresholdMs`: **30m** (was 15m).
- `monitoring.activeWorkSilenceSentinel.activeWorkMaxFrozenIndicatorMs`: **90m** (new, A5).
- `monitoring.promiseBeacon.cadenceMs`: **20m** (was 10m).
- `monitoring.promiseBeacon.suppressUnchangedHeartbeats`: **true** (new flag, B1).
- `monitoring.promiseBeacon.beaconLivenessIntervalMs`: **60m** (new, B1b).

**Migration mechanism (Migration Parity Standard — existing agents must get this).** Add a `PostUpdateMigrator` step `honest-progress-messaging-defaults` that, for each key above, sets the new default **only if the key is absent** from the agent's config (existence-checked, idempotent). A key the operator has explicitly set — including `suppressUnchangedHeartbeats: false` — is **never** overwritten. This is the rollback path: the old behavior is fully recoverable by setting the keys explicitly. The step logs which keys it backfilled for audit.

**Wiring-order fix (blocker).** `server.ts` constructs `SubagentTracker` (~line 5206) *after* the silence-sentinel wire-up block (~line 5139). `corroborateWedge` needs the tracker. The build moves `SubagentTracker` construction **above** the sentinel block so it can be injected. (Verified ordering issue — integration finding.)

**SubagentTracker O(1) liveness getter (perf).** `corroborateWedge` must not read the JSONL file per check. Add `SubagentTracker.hasActiveSubagents(sessionId): boolean` backed by the existing in-memory `activeAgents: Map<string, Set<string>>` — O(1). "Live" = any tracked sub-agent for the session with no `stoppedAt` (FD-4).

### E — Observability (you can't tune what you can't see)

The whole premise is "frame-hash is a noisy proxy." We must be able to *measure* that the fix reduced false positives without hiding real wedges (Observability standard — lessons finding). Meter the full funnel, not just fires:
- ActiveWorkSilenceSentinel counters: `detected`, `suppressed_active_indicator` (A1), `suppressed_subagent_live` (A2c), `suppressed_corroborate_error` (FD-6), `escalated_indeterminate` (A2), `escalated_frozen_indicator` (A5).
- PromiseBeacon counters: `heartbeat_suppressed_unchanged` (B1), `heartbeat_deadline_pressure` (B1a), `heartbeat_liveness` (B1b), `progress_sent`, `closeout_sent` (B2).
- Surface: append each transition to the existing `logs/sentinel-events.jsonl` (sentinel) and the beacon's existing hot-state/audit path; expose aggregates read-only via the existing per-feature metrics surface (`/metrics/features`) under feature keys `active-work-silence` and `promise-beacon`. No new endpoint, no gating — observe-only.

## Frontloaded Decisions

Every mid-build decision is resolved here (Autonomy Principle 2) so the build never stops to ask:

- **FD-1 — B2 turn-finished threshold N = 3 consecutive checks** (≈60m at 20m cadence). Rules out a momentary prompt-like frame on live work without leaving a finished promise beaconing for long.
- **FD-2 — A1 suppression is signal-only.** Suppression = "don't speak"; it never blocks the session, mutates state authoritatively, or gates another subsystem. corroborateWedge is a read. Preserves Signal vs. Authority.
- **FD-3 — Removed the "known stuck/error signature" escalation path.** The conservative all-of-(a–d) condition in A2 is the sole escalation trigger; no per-framework signature enumeration. Resolves the decision-completeness blocker by deletion, not guesswork.
- **FD-4 — "Live sub-agent" = any SubagentTracker entry for the session with no `stoppedAt`,** regardless of sleep/pause state. Conservative: a dormant-but-not-stopped sub-agent counts as live and **suppresses** escalation (better a missed alert than a false "stuck" on a session whose sub-agent is mid-work).
- **FD-5 — `escalate()` becomes async;** `verifyNudge()` fires-and-forgets it (`void this.escalate(...)`). State already tracks status, so a fire-and-forget is safe.
- **FD-6 — the entire escalation path fails CLOSED** (suppress + re-arm on any throw — from the frame re-capture, `looksActivelyWorking()`, or `corroborateWedge`). Unreliable evidence never produces a "stuck" claim.
- **FD-7 — All quoted dynamic text is sanitized** through `guardProxyOutput()` before embedding: session name (A3), promise excerpt (B5) on every beacon surface. Unsafe → neutral placeholder.
- **FD-8 — Per-machine posture (Cross-Machine Coherence).** Both monitors are **machine-local BY DESIGN**: the silence sentinel only ever sees this machine's sessions (`listRunningSessions()` is local), and PromiseBeacon already has an `ownerMachineId` ownership gate (fires only on the owning machine). No cross-machine replication or one-voice concern — each monitors local sessions only. (Stated explicitly per the multi-machine mandatory check.)

## Non-goals

- Not removing either system — both close real gaps (a genuinely wedged session; a genuinely long silent task). The fix is **precision + honesty**, not deletion.
- Not changing the routing/topic/`/attention` layer or introducing any blocking authority — purely detection, cadence, and wording.
- Not re-architecting the frame-hash progress proxy (foundation finding): the proxy stays, but A1/A2/A5 + corroboration make it honest about its own uncertainty. A full progress-truth source (structured turn-state from the framework) is noted as future work, out of scope here.

## Known limitations (honest, acknowledged)

- **29-minute oscillation evasion.** A session emitting a one-line blip every <30m resets `lastOutputAt` and never escalates. Acceptable: such a session is producing output, i.e. not wedged. Documented, not fixed.
- **FNV-1a frame hash (sentinel) is 32-bit;** a collision could mask a frame change. Vanishingly unlikely for the "static enough to be flagged" case; if a collision is ever observed, upgrade to the SHA-256 the beacon already uses. Accepted known limitation, remedied on recurrence.
- **A5 frozen-indicator hang surfaces at 90m, not sooner** — the deliberate cost of A1 killing the common false positive.

## Testing (all three tiers — non-negotiable)

**Unit (`tests/unit/`):**
- ActiveWorkSilenceSentinel — **reproduce the reported bug** (Bug-Fix Evidence Bar): static frame **with** a live `esc to interrupt` indicator at 35m → **no escalation, no nudge** (A1). Counter-test: same frame loses the indicator (indeterminate, no sub-agent, nudge no-op) → escalation with the A3 template. corroborateWedge throws → **no** escalation (FD-6). Frozen indicator byte-identical 90m → A5 escalation. Threshold default 30m. Both sides of every boundary.
- PromiseBeacon — unchanged hash + `suppressUnchangedHeartbeats:true` → **zero** `sendMessage` (B1); deadline within 2×cadence → B1a line fires despite unchanged (B1a); liveness due at 60m → one B1b line, and not again before 60m; changed hash → one progress line; turn-finished × 3 → one close-out then auto-pause (B2/FD-1); excerpt with injection content → sanitized/placeholder (B5/FD-7).
- SubagentTracker.`hasActiveSubagents` — true for a no-`stoppedAt` entry, false after stop (FD-4).

**Integration (`tests/integration/`):**
- Server wiring: SubagentTracker is constructed before the sentinel block; `corroborateWedge` dep is non-null and delegates to the **real** SubagentTracker (wiring-integrity). Config defaults (all five keys) flow from ConfigDefaults into the live monitors.
- Observability: a suppressed escalation and a silenced heartbeat each write their counter/event (E).

**E2E (`tests/e2e/`):**
- "Feature is alive" mirroring server.ts: sentinel + beacon instantiate and run a tick without throwing; the honest templates are the ones emitted; `/metrics/features` returns the two feature keys.

**Migration:**
- Existing agent on old config → receives all five new defaults. Agent with explicit `suppressUnchangedHeartbeats:false` (or a custom threshold) → preserved, not overwritten. Idempotent re-run.

## Side effects (enumerated; full version in the instar-dev staged side-effects artifact)

- Behavioral change to user-facing messaging cadence/content (intended; operator-approved wording).
- Config default changes affecting every fleet agent on update (migration-gated, existence-checked, reversible).
- `server.ts` wiring-order change (SubagentTracker constructed earlier) — verify no other consumer depended on the old ordering.
- `escalate()` sync→async (FD-5) — audit callers (only `verifyNudge` + `runNudge`'s immediate-escalate path).
- CLAUDE.md template change (Agent Awareness + Migration Parity).
- New `SubagentTracker.hasActiveSubagents` public method (additive).
- No destructive git/fs ops; no new external egress; no new blocking authority.

## Open questions

*(none — all resolved into Frontloaded Decisions above.)*
