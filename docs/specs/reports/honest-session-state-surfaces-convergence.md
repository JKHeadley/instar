# Convergence Report — Honest Session-State Surfaces

## Cross-model review: codex-cli:gpt-5.5

A real external (non-Claude) cross-model pass RAN on every round through the
agent's own installed CLIs — BOTH supported families on each round:
**codex-cli:gpt-5.5** and **gemini-cli:gemini-2.5-pro**. Both returned successful
(`status: ok`) passes on round 1 and round 2 (body hash changed between rounds, so
externals were mandatory and re-run, not delta-skipped). This is the clean RAN
state — the spec received genuine outside opinions from two distinct model
families. (The spec-level flag records `codex-cli:gpt-5.5` per the aggregate rule;
the gemini pass also ran and returned CLEAN on round 2.)

## ELI10 Overview

When one of my sessions goes quiet, two background helpers talk to you about it —
the "standby" helper (🔭) and the "your session was shut down" reap helper. Both
of them currently say something comforting that isn't always true. The standby
helper says "actively working" for the first few minutes even when the session is
really rate-limited or wedged (it only tells the truth at the 5-minute mark). The
reap helper sometimes promises "a restart is queued, I'll bring it back" even when
the restart queue is *paused* and won't bring anything back until it resumes. This
spec fixes both lies.

Both fixes only change what I *say*, never what I *do*. No session is restarted,
killed, or recovered any differently. Fix 1 (the standby honesty) ships dark on
the fleet and live only on my development self first, behind an off-by-default
flag — so with the flag off, the wording is byte-for-byte identical to today. Fix
2 (the paused-queue claim) is an unconditional correctness fix with no flag,
because there's no version of the world where promising a restart I can't deliver
is the right answer.

The main tradeoff the review wrestled with was *precision*: moving the honesty
detector earlier means a wrong "stuck" guess would now be seen sooner. The review
confirmed the detector is the exact same one already trusted at the 5-minute mark,
on the same tail-gated input, so its accuracy profile doesn't change — only the
timing of an honest message does. The dev-dark flag is the safety margin that lets
this dogfood before any fleet user ever sees it.

## Original vs Converged

**Originally**, Finding (c) was described as a one-line fix: make
`hasLiveQueuedEntryFor` return false while the queue is paused, and the spec
asserted that predicate had "exactly one consumer" used purely for user-facing
copy. **After review**, the adversarial reviewer (round 1) found — and code
verification confirmed — that the predicate actually has TWO consumers through a
shared closure, and the second one (`server.ts:11980`/`:11984`) is NOT copy: it's
the PromiseBeacon "I2" double-spawn coordination guard that makes a revive defer
to the ResumeQueue when the queue owns a topic. A paused-blind edit of the shared
predicate would have stopped that guard deferring while paused, re-opening a
double-spawn AND reviving work an operator's emergency-stop pause was meant to
hold. The converged spec **splits the predicate**: `hasLiveQueuedEntryFor` stays
unchanged (the *ownership* question, which the I2 guard needs and which is true
while paused), and a new `hasClaimableQueuedEntryFor` (= `hasLiveQueuedEntryFor &&
!isPaused()`) answers the *claimability* question that only the copy path needs.
Only the ReapNotifier copy consumer is re-pointed; the I2 guard is untouched and
pinned by a new regression test.

**Originally**, Finding (b)'s early-tier honest pre-check was to mirror the quota
short-circuit with a definitive-state `return`. **After review**, the cross-model
(Codex) and lessons-aware reviewers flagged that this would SKIP Tier 3 — the only
tier that runs the context-too-long auto-recovery — which would mean an early
honest *message* silently *gated a recovery* that happens today, a Signal-vs-
Authority violation of the spec's own "never gates recovery" claim. The converged
spec adds the explicit rule: **the honest pre-check NEVER alters the tier
schedule** — it only substitutes the message string (or sends nothing) and lets
the method fall through to its existing scheduling tail.

**Originally**, the one-voice handling said "fall through to the normal path" when
a recovery sentinel owns the voice. **After review** (Codex), that was corrected:
falling through would re-emit the very "actively working" lie this fix removes. The
converged spec uses a three-outcome helper (honest string / `SUPPRESS` sentinel /
`null`) that, on recovery-ownership, **emits nothing** (mirroring Tier 3's silent
`return`), never the hardcoded fallback.

**Also added in review**: a no-leak security contract + test at the new callsite
(emit only the classifier's verbatim plain-language message, never pane-derived
text); an Observability & Agent-Awareness section answering the conformance gate's
two flags as deliberate, proportionate decisions; and the parent-principle was
re-pointed to **Near-Silent Notifications** (which resolves to a registry
standard, where the original draft's "Honest Progress Messaging" string did not).

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | adversarial (material), codex+gemini (minor), lessons-aware/security/integration (minor), conformance (2 flags) | 1 material (+ minors) | Finding (c) split-predicate redesign; (b) no-leak security pin; Observability & Agent-Awareness section; parent-principle → Near-Silent Notifications; scheduling-never-gated + one-voice silent-suppress (resolved in-round). Standards-Conformance Gate: ran (2 flags) |
| 2 | codex (minor), lessons-aware (minor), security/integration (minor) | 0 material | none required (minor impl-detail suggestions noted, several already answered in-spec; the shared-closure caution is already in the spec body). Standards-Conformance Gate: ran (1 flag) |

## Full Findings Catalog

### Iteration 1

- **Adversarial — MATERIAL — Finding (c) caller analysis is wrong; a second,
  non-copy consumer exists.** `hasLiveQueuedEntryFor` is reached by a shared
  closure with TWO consumers; `server.ts:11980`/`:11984` is the PromiseBeacon I2
  double-spawn coordination guard (`refusalReason: 'resume-queue-owns'`), not
  display/copy. A paused-blind edit would stop the I2 deferral while paused →
  double-spawn + reviving paused-held work. **Resolution:** redesigned Finding (c)
  as a split predicate — `hasLiveQueuedEntryFor` unchanged (ownership), new
  `hasClaimableQueuedEntryFor` (claimability) for the copy consumer only; added an
  integration test asserting the I2 guard still refuses while paused. Verified
  against code in round 2 (server.ts:11984 ← resumeQueuedForSession ← :7501 ←
  hasLiveQueuedEntryFor; drainer skips paused at ResumeQueueDrainer.ts:236).

- **Codex (cross-model, GPT-5.5) — minor — definitive-state `return` skips Tier 3
  recovery.** Early-tier `return` would gate Tier 3's context-too-long
  auto-recovery. **Resolution:** added "Scheduling is never gated" — the pre-check
  never alters the tier schedule.

- **Codex — minor — one-voice fall-through re-introduces the lie.** Falling
  through to the fallback copy when a recovery sentinel owns the voice re-emits
  "actively working". **Resolution:** three-outcome `SUPPRESS` sentinel mirrors
  Tier 3's silent `return`.

- **Codex — minor — predicate naming / clarity / dev-gate weight.** Suggested a
  clearer `canClaimQueuedResumeFor` name + jargon definitions. **Resolution:** the
  new accessor is named `hasClaimableQueuedEntryFor` (claimability-explicit);
  remaining naming/typed-status-object suggestions noted as non-material
  implementation latitude.

- **Gemini (cross-model, 2.5-pro) — minor — snapshot capture cost at earlier
  tiers; classifier false-positive amplification.** **Resolution:** spec notes
  Tier1/Tier2 already capture+sanitize the snapshot and run `detectQuotaExhaustion`
  (no NEW capture); the lift reuses the same tail-gated classifier (identical
  false-positive profile), and the dev-dark flag dogfoods before any fleet flip.

- **Security — minor — pin the no-leak contract at the new callsite.**
  **Resolution:** added "No-leak contract at the new callsite (security pin)" +
  matching unit test (seed fake secret/path, assert emission is exactly
  `StuckClassification.message`, flows through the same sendMessage/Telegram escape
  path).

- **Integration — minor — make non-replication / multi-machine posture explicit.**
  **Resolution:** Multi-machine posture section retained and confirmed sound (both
  surfaces machine-local by design; PresenceProxy WS3 one-voice; ResumeQueue
  host-local lock; paused never replicated).

- **Lessons-aware — minor — parent-principle does not resolve.** "Honest Progress
  Messaging" string did not resolve to a registry standard. **Resolution:**
  re-pointed to **Near-Silent Notifications** (conformance gate confirms
  `parentResolved: true`).

- **Standards-Conformance Gate — ran (2 flags):** Observability
  (`possible-violation`) + Agent Awareness (`possible-violation`); fit verdict
  "none" (parent unresolved). **Resolution:** Observability & Agent-Awareness
  section added; parent re-pointed.

### Iteration 2

- **Standards-Conformance Gate — ran (1 flag):** Observability
  (`possible-violation`) remains; Agent Awareness CLEARED; fit verdict now "weak"
  with `parentResolved: true`. **Disposition:** the Observability flag is answered
  as a deliberate, proportionate decision (no bespoke metric for a two-string
  wording fix; both surfaces already write to existing audit trails —
  sentinel-events.jsonl / per-feature LLM metrics / ResumeQueue paused-unpaused
  audit / reap-log). Signal-only; non-blocking.

- **Adversarial — RESOLVED, no new material.** Verified against code: I2 guard
  preserved byte-for-byte; claimability scoping correct; pause/unpause race is
  cosmetic-only (in-memory boolean, self-corrects next fire); SUPPRESS one-voice
  correct. One caution (already in the spec at lines 228/295): implementation must
  add a second narrow closure / widen to expose both — not mutate the shared
  closure both consumers read.

- **Decision-completeness — clean.** 7 frontloaded decisions, 0 cheap-to-change
  tags, 0 contested-then-cleared. Open questions empty. Template-note deferral is
  the agent's own frontloaded future action (gated on the fleet flip), not a parked
  user-decision.

- **Lessons-aware — minor — design respects Signal-vs-Authority.** Both fixes
  confirmed signal-only (wording/boolean honesty, never gating). Parent-principle
  fit "weak but honest"; no-new-metric defensible. Non-material.

- **Security/Integration/Scalability — round-1 minors addressed; 1 minor.**
  Suggested a wiring-integrity assertion that the ReapNotifier dep points at
  `hasClaimableQueuedEntryFor`. Non-material (the existing wiring-integrity test
  family + the integration test already exercise the dep); noted as recommended
  implementation coverage. Scalability: net-neutral (one in-memory boolean read on
  user-facing copy path).

- **Codex (cross-model) — 5 minor.** Explicit `messageHandled` control-flow flag;
  helper rename to a typed union; graduation criteria/owner-date for the flag;
  typed `getQueuedEntryStatus` status object; observability detail. All
  implementation-latitude refinements; none require a spec change to converge
  (several are already answered: the accessor is claimability-named, the dev-dark
  graduation posture + rationale are in Frontloaded Decisions, the no-metric
  decision is documented).

- **Gemini (cross-model) — CLEAN.** Explicitly endorsed the split-predicate fix
  and the scheduling-never-gated defensive design; only a generic "dense jargon"
  observation (not a finding).

## Convergence verdict

**Converged at iteration 2.** Zero material findings in the final round; the
single round-1 material finding (the I2 double-spawn hazard) was resolved by the
split-predicate redesign and independently verified against code in round 2. The
`## Open questions` section is empty (`*(none)*`). Both cross-model families ran
real passes on both rounds (Gemini CLEAN, Codex MINOR-only on round 2). Remaining
items are non-material implementation refinements, several already answered in the
spec. The spec is ready for user review and approval.

**Approval provenance (disclosed):** `approved: true` is stamped under operator
Justin's standing topic-27515 pre-authorization ("pre-approval for any
decisions/specs needed; do NOT stop or wait") — Tier 2, dark-flagged, to be
disclosed in the PR. Same provenance as the four mesh PRs (#1257–#1260).
