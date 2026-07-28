---
title: "Honest Session-State Surfaces — Tier1/Tier2 standby honesty + paused-queue notice correctness: Spec"
slug: honest-session-state-surfaces
author: echo
parent-principle: "Near-Silent Notifications"
eli16-overview: honest-session-state-surfaces.eli16.md
status: draft
created: 2026-06-24
review-convergence: "2026-06-24T15:43:04.779Z"
review-iterations: 2
review-completed-at: "2026-06-24T15:43:04.779Z"
review-report: "docs/specs/reports/honest-session-state-surfaces-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-provenance: "operator Justin standing topic-27515 pre-authorization (Tier 2, dark-flagged) — disclosed in PR; same as mesh PRs #1257-#1260"
---

# Honest Session-State Surfaces

> Two small honesty fixes to the standby/reap user-facing surfaces, grounded against canonical `JKHeadley/main` HEAD `03f360cb9` (v1.3.654, includes merged #1257–#1260).

## Problem statement

When a session goes quiet, two background surfaces speak to the user about its
state. Both currently lie in specific, reproducible cases:

**Finding (b) — Tier1/Tier2 standby "actively working" lie.**
`PresenceProxy` has an honest stuck-state classifier (`classifyStuckSignature`)
that surfaces the REAL reason a live-but-failing session has gone silent —
rate-limited, AUP-policy-wedged, thinking-block context-wedged, or
context-window-exhausted. But that classifier is invoked **only at Tier 3**
(`fireTier3`, the 5-minute check). At Tier 1 (~immediate) and Tier 2 (~2 minutes)
the fallback paths HARDCODE "is actively working" / "is still working" copy —
so for the first several minutes a session that is genuinely rate-limited or
permanently wedged is reported to the user as "actively working". This is the
exact lie the honest-turn-receipts work set out to kill; it was fixed at Tier 3
but not the earlier, more-frequently-seen tiers.

**Finding (c) — paused resume-queue claims "restart is queued".**
`ResumeQueue.hasLiveQueuedEntryFor` feeds `ReapNotifier`'s "A restart is queued:
… I'll bring it back" line. That predicate gates on `dryRun`, `disabledReason`,
and `enabled` — but NOT on whether the queue is **paused** (e.g. by an emergency
stop). When the queue is paused, a queued entry will NOT be revived until the
queue resumes, yet the notice still tells the user "A restart is queued … I'll
bring it back to pick the work up." That is a false promise of revival.

**Out of scope (explicit):** Finding (a) — split-brain demote — is an
operator-decision item and is NOT addressed here.

## Grounded anchors (verified in worktree)

| Anchor | Path | Line(s) | Verified note |
|---|---|---|---|
| `classifyStuckSignature` import | `src/monitoring/PresenceProxy.ts` | 22 | matches |
| Tier1 LLM-guard fallback ("is actively working") | `src/monitoring/PresenceProxy.ts` | **1154** | matches prompt |
| Tier1 LLM-failure fallback ("is actively working on something") | `src/monitoring/PresenceProxy.ts` | **1157** | matches prompt |
| Tier1 method body | `src/monitoring/PresenceProxy.ts` | 1072–1170 | `fireTier1`; already calls `detectQuotaExhaustion` (1089) but NOT `classifyStuckSignature` |
| Tier2 LLM-guard fallback ("is still working") | `src/monitoring/PresenceProxy.ts` | **1253** | matches prompt |
| Tier2 LLM-failure fallback ("is still working") | `src/monitoring/PresenceProxy.ts` | **1255** | matches prompt |
| Tier2 method body | `src/monitoring/PresenceProxy.ts` | 1182–1265 | `fireTier2`; already calls `detectQuotaExhaustion` (1213) but NOT `classifyStuckSignature` |
| Tier3 honest classification block | `src/monitoring/PresenceProxy.ts` | 1371–1424 (`classifyStuckSignature` call at **1382**) | matches prompt (:1382) |
| `StuckClassification` type | `src/monitoring/StuckSignatureClassifier.ts` | 41–47 | `{ kind, message, detail? }` |
| `classifyStuckSignature` signature | `src/monitoring/StuckSignatureClassifier.ts` | 107 | `(capture: string, tailLines=12) => StuckClassification \| null` |
| `PresenceProxyConfig` interface | `src/monitoring/PresenceProxy.ts` | 30 | where the new optional config flag is added |
| PresenceProxy construction (server) | `src/commands/server.ts` | 11428–11567 | where the flag is wired from config |
| `hasLiveQueuedEntryFor` | `src/monitoring/ResumeQueue.ts` | **945–950** | matches prompt; checks `dryRun \|\| disabledReason \|\| !enabled`, NOT `paused` |
| `isPaused()` | `src/monitoring/ResumeQueue.ts` | **268–270** | matches prompt; returns `this.state.paused` |
| ReapNotifier "restart is queued" caller | `src/monitoring/ReapNotifier.ts` | **506** | matches prompt; gated by `safeResumeQueued` (304) → `resumeQueuedFor` dep |
| `resumeQueuedFor` wiring | `src/commands/server.ts` | 7244, 7501 (`rq.hasLiveQueuedEntryFor`) | dep delegates straight to `hasLiveQueuedEntryFor` |

**Corrections vs the prompt's stated numbers:** none material. All cited
anchors resolve at (or within ±0 lines of) the stated locations in canonical
HEAD `03f360cb9`. The two `classifyStuckSignature`-call regions stated by the
prompt (Tier3 :1382, import :22) are exact; the four hardcoded-copy lines
(1154/1157/1253/1255) are exact; ResumeQueue (945–950, 268–270) and ReapNotifier
(:506) are exact. (One nuance worth recording: both Tier1 and Tier2 ALREADY call
`detectQuotaExhaustion` before their LLM call — so the honest-state precedent
exists at all three tiers for *quota*; this fix extends the SAME precedent to the
full `classifyStuckSignature` set, which today lives only in Tier 3.)

## Proposed design

### Finding (b) — lift the honest stuck-classification into Tier 1 and Tier 2

**Approach: a shared honest-state pre-check, gated by a dev-dark flag.**

Both `fireTier1` and `fireTier2` already capture and sanitize the live tmux
`snapshot` near the top of the method, and both already run
`detectQuotaExhaustion(snapshot)` as a definitive-state short-circuit BEFORE the
LLM call. The fix mirrors that exact shape for the broader stuck set:

1. Add a private helper on `PresenceProxy`, e.g.
   `private maybeStuckMessage(snapshot: string | null, tierLabel: 1 | 2): string | null`.
   When the honesty flag is OFF it returns `null` (no behavior change). When ON
   and `snapshot` is non-null, it calls `classifyStuckSignature(snapshot)`; if a
   classification is returned it formats the honest one-liner using the SAME
   tier prefix the existing copy uses (Tier 1: bare `${this.prefix} <msg>`;
   Tier 2: `${this.prefix} 2-minute update — <msg>`), reusing
   `StuckClassification.message` (already plain-language, no jargon/no localhost
   — see classifier contract).

2. In `fireTier1` (after the existing quota short-circuit at ~1089–1099, before
   the LLM block at ~1136): if `maybeStuckMessage(snapshot, 1)` returns a
   message, send it as the Tier-1 message — but **DO NOT change the tier
   schedule**. The early-tier honest pre-check ONLY substitutes which message
   string is sent; it then proceeds exactly as today (the normal-path tier
   scheduling still runs, so Tier 2 and Tier 3 still fire on their existing
   cadence). It does NOT do a definitive-state `return` that skips later tiers.
   (See "Scheduling is never gated" below — this is the round-1 correctness fix.)

3. In `fireTier2` (after the existing quota short-circuit at ~1211–1221): same
   pattern — if `maybeStuckMessage(snapshot, 2)` returns a message, send it and
   then proceed exactly as today, INCLUDING the existing
   `scheduleTier(topicId, 3, remainingToTier3)` call (PresenceProxy.ts:1268–1270).
   Tier 3 is never skipped by the honest pre-check.

4. **The fallback-copy lines (1154/1157/1253/1255) are NOT deleted.** They remain
   the LLM-failure / unsafe-output fallback for sessions that are genuinely
   working but produced no LLM-safe summary. The honest pre-check sits ABOVE the
   LLM call, so a session that is NOT stuck still flows to the LLM path and (on
   failure) to the unchanged fallback copy. This keeps the flag-OFF path
   byte-identical and the flag-ON path additive.

**Scheduling is never gated (round-1 correctness fix — Codex #1).** The earlier
draft had the Tier1/Tier2 honest path do a definitive-state `return` (mirroring
the quota short-circuit), which would have SKIPPED `scheduleTier(3)` — and Tier 3
is the ONLY tier that runs the `context-too-long` auto-recovery
(`recoverContextExhaustion`, PresenceProxy.ts:1397–1411). Skipping Tier 3 from an
early-tier classification would therefore have GATED a recovery that happens
today — a real Signal-vs-Authority violation of this spec's own "never gates or
initiates recovery" claim. The corrected rule: **the honest pre-check NEVER alters
the tier schedule.** It only substitutes the message string and otherwise lets the
method fall through to its existing scheduling tail. So the `quota` short-circuit's
`return` is NOT the template to copy here; the template is "emit the honest line in
place of the would-be LLM/working line, then continue exactly as today." Tier 3's
own honest block remains the authoritative recovery point (rate-limited →
`waiting`, wedges → `dead`, context-too-long → auto-recover-then-report), and the
early tiers' honest lines are pure REPORTING that converges on the same Tier-3
behavior — never a substitute for it.

**Respect the one-voice rule (round-1 correctness fix — Codex #2).** Tier 3's
honest block, when a recovery sentinel owns the voice
(`isStuckRecoveryActive(sessionName)` true), does a **silent `return`**
(PresenceProxy.ts:1389–1393) — it does NOT fall through to any "working" copy.
The Tier1/Tier2 pre-check MUST mirror THAT exact behavior, not "fall through to
the normal path": when `maybeStuckMessage` would classify the session as stuck
AND `this.config.isStuckRecoveryActive?.(...)` (or
`this.config.hasActiveRateLimitRecovery?.(...)`) reports recovery ownership, the
pre-check **emits nothing AND suppresses the normal-path message for this fire**
(so the user hears the recovery sentinel's single voice) — it does NOT fall
through to the LLM/hardcoded "is actively working" fallback, which would
re-introduce the very lie this fix removes. Concretely: `maybeStuckMessage`
returns one of three outcomes — (i) a string (stuck, no recovery owner → send it,
keep scheduling), (ii) the sentinel `SUPPRESS` (stuck, but a recovery owner holds
the voice → send no message this fire, keep scheduling), or (iii) `null` (not
stuck → normal LLM path, unchanged). Scheduling is unaffected in all three
(per the rule above). Tier 3's context-too-long auto-recovery branch is NOT
replicated into the early tiers — early tiers only REPORT or stay silent;
recovery remains Tier-3/sentinel territory (signal-only: this change only alters
which message string is sent, or sends none — it never schedules, gates, or
initiates recovery).

**Tail-gating is inherited.** `classifyStuckSignature` is already tail-gated
internally (the same property that fixed the stale-scrollback "conversation too
long" false fire). Tier1/Tier2 reuse it as-is — no new detector, no new parse
surface, so no new State-Detector-Registry entry is required (the registry entry
for the stuck signatures already exists via the Tier-3 usage). Because the lift
reuses the same classifier on the same tail-gated snapshot, its false-positive
profile at Tier1/Tier2 is identical to the established Tier3 usage — the early
tiers do not widen the classifier's input surface, only the timing of its honest
output.

**No-leak contract at the new callsite (security pin).** The lift emits ONLY
`StuckClassification.message` verbatim (with the existing tier prefix). The
Tier1/Tier2 code MUST NOT concatenate any pane-derived substring into the
outbound line — the message is the classifier's plain-language string and nothing
else (the classifier contract already guarantees no jargon / no localhost / no
secret-or-path interpolation). The honest line then flows through the SAME
`sendMessage` dep and Telegram formatting/escape path as the existing Tier1/2
copy — no raw send, no new outbound surface. A unit test pins this by seeding a
fake secret/path into the stuck pane and asserting the emitted message contains
neither (see Tests).

### Finding (c) — paused-aware "restart is queued" claim (split-predicate correctness fix)

Honesty correctness fix. The goal is unchanged: while the queue is paused, the
user-facing **"A restart is queued … I'll bring it back"** claim
(ReapNotifier.ts:506) must be suppressed, because a paused queue will not revive
the entry until it resumes — so the claim is a promise the queue cannot currently
keep.

**Caller-behavior check (CORRECTED — there are TWO consumers, and one is NOT
copy):** `hasLiveQueuedEntryFor` is reached through a single shared closure,
`resumeQueuedForSession` (defined at `server.ts:7501` →
`rq.hasLiveQueuedEntryFor(tmuxSession)`), and that closure has **two** consumers:

1. **`server.ts:7244`** — `ReapNotifier`'s `resumeQueuedFor` dep. **User-facing
   copy.** This consumer wants the **claimability** question: *"can I honestly
   tell the user a revival is coming?"* — which is FALSE while paused.
2. **`server.ts:11980`** — PromiseBeacon escalation's `requestRevive` **I2
   double-spawn coordination guard** (`refusalReason: 'resume-queue-owns'`).
   **NOT copy** — it is a control-flow guard that makes the escalation/revive
   path DEFER to ResumeQueue when the queue owns the topic, so the two paths
   cannot both spawn a revive. This consumer wants the **ownership** question:
   *"does the ResumeQueue hold this topic?"* — which stays TRUE while paused (the
   entry is frozen-in-place, still owned by the queue; the drainer skips it at
   `ResumeQueueDrainer.ts:236` precisely because it is paused).

**Why a single paused-blind `hasLiveQueuedEntryFor` would be WRONG (the original
one-liner's defect):** if `hasLiveQueuedEntryFor` simply returned false while
paused, the I2 guard at :11980 would stop deferring during a pause — so a
PromiseBeacon escalation could spawn a revive for a topic whose paused-frozen
ResumeQueue entry was meant to own it. The `isSessionAlive` backstop blocks
reviving a *live* session, but for a genuinely-dead session with a paused-frozen
entry the escalation path would proceed — re-opening exactly the double-spawn I2
exists to prevent, AND reviving work an operator's emergency-stop pause was meant
to hold. Conflating "is it claimable as copy?" with "does the queue own it?" onto
one predicate is the bug.

**The fix — split the two questions, keep the existing predicate paused-BLIND for
the coordination guard:**

- `hasLiveQueuedEntryFor(tmuxSession)` is left **unchanged** (still
  `dryRun || disabledReason || !enabled`, NOT paused) — it answers the
  **ownership** question, which the I2 guard at :11980 needs and which is
  unaffected by pause. (This preserves the I2 deferral byte-for-byte.)
- Add a new sibling accessor on `ResumeQueue`, e.g.
  `hasClaimableQueuedEntryFor(tmuxSession): boolean`, that is
  `hasLiveQueuedEntryFor(tmuxSession) && !this.isPaused()` — it answers the
  **claimability** question.
- Re-point ONLY the ReapNotifier copy consumer at the new accessor: the
  `resumeQueuedFor` dep at `server.ts:7244` is wired to
  `hasClaimableQueuedEntryFor` (a second narrow closure, or by widening
  `resumeQueuedForSession` to expose both and pointing each consumer at the right
  one). The I2 guard at :11980 stays on `hasLiveQueuedEntryFor`.

Result: the false "restart is queued" claim is suppressed while paused (the
ReapNotifier path now reads claimability), and the PromiseBeacon I2 coordination
guard keeps deferring to the queue while paused exactly as today (it reads
ownership). The entries remain in the queue and revive normally once the queue is
unpaused (the documented stale-emergency-pause auto-resume and the explicit
`unpause()` lever are both unaffected). No entry is dropped, cancelled, or
double-spawned.

(`this.isPaused()` is the public accessor at `ResumeQueue.ts:268–270` returning
`this.state.paused`.)

## Decision points touched

- **Standby copy at Tier 1 / Tier 2** (PresenceProxy) — flag-ON changes
  user-facing wording for a genuinely-stuck session from "working" to the honest
  reason. Flag-OFF: unchanged.
- **Reap notice "restart is queued" line** (ReapNotifier via ResumeQueue) —
  suppressed while the queue is paused, via a NEW claimability accessor
  (`hasClaimableQueuedEntryFor`). No flag; pure correctness. The existing
  `hasLiveQueuedEntryFor` (ownership) is left unchanged so the PromiseBeacon I2
  double-spawn coordination guard is unaffected.
- **One-voice ownership** — the Tier1/Tier2 pre-check defers to the same
  recovery-ownership checks Tier 3 already honors.

## Frontloaded Decisions

- **Finding (b) flag:** `monitoring.standbyHonestyTiers.enabled`, a nested
  `monitoring.*` block. It is **OMITTED from `ConfigDefaults`** so it resolves via
  `resolveDevAgentGate('monitoring.standbyHonestyTiers.enabled', config)` (live on
  a development agent, dark on the fleet — the standard
  `standard_development_agent_dark_feature_gate` convention, matching e.g.
  `monitoring.bootHealthBeacon`). A **`DEV_GATED_FEATURES` entry** is added in
  `src/core/devGatedFeatures.ts`:
  - `name: 'standbyHonestyTiers'`
  - `configPath: 'monitoring.standbyHonestyTiers.enabled'`
  - `description`: "Tier1/Tier2 standby honest-stuck classification — surface the
    REAL reason a live-but-failing session is silent (rate-limited / policy-wedge
    / context-wedge / context-too-long) instead of 'actively working'."
  - `justification`: "Signal-only — only changes the standby MESSAGE TEXT; never
    gates, blocks, initiates recovery, spends, or egresses. Reuses the existing
    tail-gated `classifyStuckSignature` and defers to the same one-voice
    recovery-ownership checks Tier 3 already honors. Flag-OFF = Tier1/2
    byte-identical to today."
  This satisfies the `devGatedFeatures-wiring.test.ts` both-sides assertion
  (live under a dev-agent config, dark under a fleet config) and the dark-gate
  golden-map lint (no hardcoded `enabled: false`).
- **Default posture (b):** dark on the fleet / live on a dev agent. Rationale:
  it changes user-facing standby wording, so it dogfoods on the dev agent first
  before any fleet flip — the same posture used for every prior user-wording
  honesty change.
- **Signal-only (b):** the change ONLY alters which message string is sent. It
  never blocks, delays, rewrites, or initiates recovery. Every error path /
  uncertainty (no snapshot, classifier returns null, a recovery sentinel owns the
  voice) falls through to the EXISTING behavior — fail toward "no honest override",
  never toward a fabricated honest claim.
- **Fail-direction (b):** toward today's behavior. If `classifyStuckSignature`
  throws or returns null, or the snapshot is absent, the honest pre-check returns
  null and the tier proceeds exactly as it does today.
- **Finding (c): no flag.** It is an unconditional correctness/honesty fix — the
  same posture as a validation one-liner (e.g. PR2's priority-key validation).
  Suppressing an inaccurate "restart is queued" claim has no behavioral downside
  in any configuration. A flag would only let an agent opt INTO lying.
- **Finding (c): split predicate, NOT a paused-blind edit of the shared one.**
  The decision (made here, not parked) is to add a NEW `hasClaimableQueuedEntryFor`
  (= `hasLiveQueuedEntryFor && !isPaused()`) and re-point ONLY the ReapNotifier
  copy consumer (server.ts:7244) at it, leaving `hasLiveQueuedEntryFor` (the
  ownership predicate the PromiseBeacon I2 guard at server.ts:11980 reads)
  unchanged. Rationale: the I2 guard needs the ownership answer (true while
  paused — the queue still owns the frozen entry); only the copy needs the
  claimability answer (false while paused). See Finding (c) design above for the
  double-spawn hazard the naïve single-predicate edit would re-open.
- **Fail-direction (c):** toward honesty/silence on the copy path, toward
  PRESERVED coordination on the guard path. If `isPaused()` is somehow unreadable
  inside `hasClaimableQueuedEntryFor`, it returns false (omit the claim — fail
  toward silence, never toward a false claim); the pre-existing try/catch in
  `ReapNotifier.safeResumeQueued` (`@silent-fallback-ok`, ReapNotifier.ts:304–311)
  is a second belt toward cosmetically OMITTING the queued line. The I2 guard's
  `hasLiveQueuedEntryFor` is untouched, so the double-spawn deferral cannot
  regress.

## Multi-machine posture

Both surfaces are **per-machine-local honesty surfaces** — no cross-machine
replication, no pool-scope, no mesh fan-out.

- **(b)** `PresenceProxy` already runs under the WS3 one-voice speaker election:
  only the topic's OWNER machine speaks 🔭. The honest classification reads the
  LIVE local tmux pane of a session that runs on THIS machine — there is no
  remote session to classify. So this is correctly machine-local: the machine
  serving the topic reports honestly about the session it is actually running.
- **(c)** `ResumeQueue` is a durable PER-MACHINE queue (it holds a host-local
  lock precisely to forbid two machines sharing its state). Its `paused` flag and
  its entries are machine-local; the reap notice is emitted by the machine that
  reaped the session. So the paused-guard is correctly local: it suppresses the
  claim on the only machine that could (or could not) honor it.

No multi-machine replicated-store work, no `multiMachine.*` config, no pool
routes are touched.

## Open questions

*(none)*

## Tests (3-tier)

### Tier 1 — Unit

**(b) honest-classification lift — `tests/unit/PresenceProxy-standby-honesty.test.ts`:**
- **Flag-ON, rate-limited pane at Tier 1:** seed a tmux snapshot carrying a
  rate-limit signature; assert `fireTier1` sends the classifier's honest message
  (e.g. usage-limit copy) and does NOT send "is actively working". Assert the tier
  schedule is UNCHANGED — Tier 2/3 still fire on their existing cadence (the honest
  pre-check substitutes the message string only; it NEVER gates scheduling — see
  "Scheduling is never gated").
- **Flag-ON, stuck pane + recovery sentinel owns the voice at Tier 1:** with
  `isStuckRecoveryActive` true, `maybeStuckMessage` returns the `SUPPRESS`
  sentinel; assert `fireTier1` sends NO message this fire (no honest line AND no
  "is actively working" fallback — one-voice silent-suppress) while the tier
  schedule still proceeds.
- **Flag-ON, policy-wedge / context-wedge / context-too-long at Tier 2:** for
  each `StuckKind`, assert `fireTier2` sends the honest message (prefixed
  "2-minute update — …") and not "is still working".
- **Flag-ON, NOT stuck:** a normal working pane → the honest pre-check returns
  null, the LLM path runs, and (on LLM failure) the UNCHANGED fallback copy
  ("is actively working" / "is still working") is sent. Proves the lift is
  additive, not a replacement.
- **Flag-ON, recovery sentinel owns the voice:** with
  `isStuckRecoveryActive` (or `hasActiveRateLimitRecovery`) returning true on a
  stuck pane → the honest line is NOT emitted (one-voice rule).
- **Flag-OFF (default-fleet config):** for a stuck pane at Tier 1 and Tier 2,
  assert the EXACT pre-change strings are produced ("…is actively working…",
  "…is still working…") — byte-identical-to-today assertion.
- **Flag-ON, no-leak contract at the new callsite:** seed a tmux snapshot whose
  stuck region also contains a fake secret token and an absolute filesystem path;
  assert the emitted Tier-1/Tier-2 honest message is EXACTLY
  `StuckClassification.message` (the verbatim classifier string with the existing
  tier prefix) and contains NONE of the seeded secret/path substrings. Pins the
  no-leak contract at the lifted callsite — the Tier1/2 code emits only the
  classifier's plain-language message and never concatenates pane-derived text.

**(c) split predicate — `tests/unit/ResumeQueue-paused-claimable.test.ts`:**
- A live queued entry exists; queue NOT paused → BOTH `hasLiveQueuedEntryFor`
  (ownership) and `hasClaimableQueuedEntryFor` (claimability) return true.
- Same entry, queue paused (`pause('emergency-stop')`) →
  `hasClaimableQueuedEntryFor` returns **false** (copy suppressed) while
  `hasLiveQueuedEntryFor` still returns **true** (ownership preserved — the I2
  guard regression assertion: the queue still owns the frozen topic).
- After `unpause()` → both return true again (entry preserved across the pause).
- `dryRun` / `disabledReason` / `!enabled` → both return false (existing guards
  unbroken on both predicates).

**(c) I2 coordination guard not regressed — covered in the integration test
below:** a paused queue holding a topic's entry must STILL make PromiseBeacon's
`requestRevive` refuse with `resume-queue-owns` (the deferral relies on
`hasLiveQueuedEntryFor`, which is unchanged) — proving the copy fix did not
re-open the double-spawn the naïve single-predicate edit would have.

### Tier 2 — Integration

`tests/integration/standby-honesty-reap-notice.test.ts` (HTTP pipeline):
- **(c) copy path** Drive a reap event through `ReapNotifier` against a real
  paused `ResumeQueue` holding a queued entry; assert the emitted notice text does
  NOT contain "A restart is queued"; then unpause and a fresh equivalent reap
  notice DOES contain it. Confirms the dep wiring (`resumeQueuedFor` →
  `hasClaimableQueuedEntryFor`) honors the paused state end-to-end.
- **(c) I2 guard path (double-spawn regression)** Against the SAME paused
  `ResumeQueue` holding the topic's entry, drive PromiseBeacon escalation's
  `requestRevive` for a DEAD bound session and assert it still refuses with
  `refusalReason: 'resume-queue-owns'` (the guard reads the unchanged
  `hasLiveQueuedEntryFor`). Proves the copy fix did not bypass the I2 deferral
  while paused.
- **(b)** Exercise PresenceProxy through its message-logged → tier-fire path
  against a stub `captureSessionOutput` returning a stuck pane, flag ON, and
  assert the sent message (via the `sendMessage` dep) carries the honest reason
  at Tier 1 / Tier 2.

### Tier 3 — E2E / Wiring

`tests/unit/devGatedFeatures-wiring.test.ts` (extended by the registry entry):
- The new `standbyHonestyTiers` `DEV_GATED_FEATURES` entry resolves **live**
  under a dev-agent config and **dark** under a fleet config (both-sides
  assertion the registry test already enforces for every entry).

`tests/e2e/standby-honesty-flag-default.test.ts` (production init path):
- Boot the server through the real init path with the SHIPPED defaults (no
  `monitoring.standbyHonestyTiers` in config). Assert
  `resolveDevAgentGate('monitoring.standbyHonestyTiers.enabled', config)` is
  false on a fleet config (so a fleet agent's Tier1/2 copy is byte-identical to
  today) and true on a dev-agent config.

**Wiring-integrity (required for the DI flag):**
- A unit test asserting the new `PresenceProxyConfig` flag is threaded from
  `server.ts`'s construction (resolved via `resolveDevAgentGate`) into the
  `maybeStuckMessage` decision — i.e. the dep is not null, not a no-op, and the
  ON path actually reaches `classifyStuckSignature`. (Mirrors the existing
  PresenceProxy config-wiring tests.)

## Observability & Agent Awareness

(Addresses the two Standards-Conformance Gate flags — Observability and Agent
Awareness — both folded as deliberate, proportionate decisions for a signal-only
wording change.)

- **Observability.** No NEW metric or audit channel is added, by design — both
  surfaces already write to the existing audit trails the honest-messaging family
  uses. (b) PresenceProxy tier-fires (and which message variant was emitted) are
  already visible via the existing standby-event logging and the per-feature
  LLM-metrics surface (feature key `presence-proxy`); the honest-stuck variant
  reuses the same emission path, so "did standby say the honest reason or
  'working'?" is already auditable in `logs/sentinel-events.jsonl` / the existing
  standby event stream. (c) Suppressing a copy line and the I2 deferral are both
  already covered by the ResumeQueue audit (`paused`/`unpaused` events at
  ResumeQueue.ts:875/891) and the reap-log. Adding a bespoke metric for a
  two-string wording fix would be disproportionate; the existing trails answer
  every "why did it say that?" question. This is a conscious decision, not an
  oversight.
- **Agent Awareness.** (b) ships dark on the fleet, so no fleet agent's behavior
  changes until a deliberate flip — a CLAUDE.md template change now would document
  behavior no fleet agent has yet. The migration-parity note below schedules the
  one-line addition under the existing "Honest standby (turn-receipts)" section to
  land WITH the fleet flip (so the template never describes a dark behavior as
  live). (c) is an unconditional honesty correctness fix with no new
  agent-visible capability — it removes a false claim; there is nothing for an
  agent to learn to "use." No template entry is warranted.

## Migration parity

- **(b)** No agent-installed-file change (config OMITS the flag → resolved at
  runtime by the dev gate). New agents and existing agents both pick it up at the
  next session start with no migration — the dev gate reads live config. No
  CLAUDE.md template change is strictly required (signal-only wording change,
  dark on the fleet), but a one-line note may be added under the existing "Honest
  standby (turn-receipts)" section so the agent can answer "why did standby say
  'rate-limited' at the 1-minute mark?" once the fleet flip happens.
- **(c)** Pure code fix to a shipped module; no agent-installed-file change, no
  migration needed.
