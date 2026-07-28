# Side-Effects Review — Deterministic self-stop floor (degraded-path behavioral backstop)

**Spec:** docs/specs/ux-is-the-product-hardening.md (Tier 1 — staged ELI16 + this artifact; no converged spec). **ELI16:** docs/specs/ux-is-the-product-hardening.eli16.md
**Parent:** The User Experience Is the Product — Reachability/Responsiveness/Coherence Are Sacred; Structure > Willpower.
**Files:** src/core/self-stop-floor.ts (new), src/core/MessagingToneGate.ts (wire into buildDegradedToneResult + B15 illustrative clause), tests/unit/self-stop-floor.test.ts (new), tests/unit/MessagingToneGate.test.ts (4 new degraded-path cases).

## What changed

1. **self-stop-floor.ts (new):** a pure, synchronous `detectSelfStopShape(text)` — recognizes the
   self-stop SHAPE = a stop/defer ACTION marker conjoined with a self-protective REASON marker
   (context/fatigue/volume, restart-avoidance, environment-as-stop), with a strong legitimate-stop
   override (external dependency clearing, credential/approval). No LLM, no subprocess.
2. **MessagingToneGate.buildDegradedToneResult:** after the existing deterministic LEAK check, run
   the self-stop floor; if it fires → HOLD (rule `B15_CONTEXT_DEATH_STOP`, `failedClosed:true`,
   `degradedToDeterministic:true`). This is the shared degrade site, so BOTH degrade manifestations
   (provider-throw inside review() AND slow-budget-timeout at the route seam) are covered identically.
3. **B15 prompt:** one ILLUSTRATIVE clause added (restart-disruption avoidance, "tail of a huge work
   session", environment-as-stop) — NOT a literal gate; the rule still judges by meaning.

## Phase 1 — Principle check (signal vs authority)

This change DOES touch a decision point (it can HOLD an outbound message). Per
`docs/signal-vs-authority.md`: the detector is a SIGNAL producer (`detectSelfStopShape` returns a
boolean shape verdict); the AUTHORITY remains `buildDegradedToneResult` / the gate. The brittle
deterministic check is given blocking authority ONLY on the already-degraded path where the
alternative is a blind fail-open — i.e. it strictly improves on "no check at all". On the normal
(judge-available) path, the smart LLM authority is unchanged and owns the decision. So the brittle
detector never parallels or shadows the smart gate; it backstops it only when the smart gate is
absent. This is the sanctioned use of a brittle check (a floor under outage), not a brittle check
holding primary authority.

## Side-effects review (the 8 questions)

1. **Over-block** — Could hold a legitimate agent message that happens to pair a stop-word with a
   self-protective-sounding word, ONLY while the LLM judge is down. Mitigated by: requiring BOTH an
   action AND a reason marker (conjunction → high precision), the legitimate-stop override (external
   blocker / credential), and the fact it only runs on the degraded path. A held message is surfaced
   to the agent to revise, never dropped. Bias is intentionally toward over-hold here (the safe
   direction under outage) per the operator's explicit "never let this slip again."
2. **Under-block** — A self-stop phrased with NO word in either list (a wholly novel euphemism) still
   slips on the degraded path. Accepted: the deterministic floor cannot match the full semantic space
   — that is what the LLM judge is for, and the real fix for availability is the backend-reliability
   work (pi/gemini fallback, already merged) so the judge is actually present. The floor reduces, it
   does not eliminate, the degraded-path gap. No silent claim of completeness.
3. **Level-of-abstraction fit** — Correct layer: it lives beside the existing deterministic leak floor
   (`detectDeterministicLeak`) and wires into the same `buildDegradedToneResult`, so the slow and fast
   degrade manifestations get it identically. It does NOT duplicate B15's LLM logic; it is explicitly
   the degraded-path-only backstop. A higher layer (the LLM judge) already owns the normal path.
4. **Signal vs authority compliance** — Compliant (see Phase 1). The detector is a signal; the gate is
   the authority; the brittle check holds authority only where the smart authority is unavailable.
5. **Interactions** — Runs AFTER the leak check in `buildDegradedToneResult` (a leak still HOLDs
   first, with its own rule). It does NOT run on the normal path, so it cannot shadow or double-fire
   with the LLM B15. It inherits the `failClosedOnExhaustion` three-valued knob automatically: when
   `false`, review() fails open before reaching `buildDegradedToneResult`, so the floor is skipped
   (proven by test); when `true`, review() pure-holds before reaching it; the floor only manifests on
   the DEFAULT (unset) degrade disposition. No race with cleanup.
6. **External surfaces** — Only changes what the user sees on the narrow degraded+self-stop case (they
   now do NOT receive a bail-out message during an outage; the agent is told to continue). No new
   route, no new config key, no cross-agent surface, no data model change. Depends on no timing or
   runtime state beyond the text itself (pure function).
7. **Multi-machine posture** — **Machine-local BY DESIGN, and correctly so.** The tone gate runs on
   whichever machine is sending the message; the floor is a pure function of the message text with no
   state. There is nothing to replicate or proxy — every machine that runs the gate runs the same
   deterministic floor identically. No single-machine assumption, no durable state to strand, no URL.
8. **Rollback cost** — Trivial. The whole degraded path is already gated by
   `messaging.toneGate.failClosedOnExhaustion: false` (operator kill-switch → fail-open, skips the
   floor). To fully revert: drop the `detectSelfStopShape` call in `buildDegradedToneResult` + the
   new module. Additive, no migration, no state repair.

## Tests

- tests/unit/self-stop-floor.test.ts (10): the 2026-06-27 slip detects; restart/context/environment
  framings detect; legitimate operator-decision question, external-blocker wait, normal progress
  report, action-without-reason, reason-without-action, and empty input do NOT detect.
- tests/unit/MessagingToneGate.test.ts (+4): on a provider throw — the slip HOLDs (B15), a legit
  decision question SENDs, and the `failClosedOnExhaustion:false` kill-switch fails open (floor
  skipped). 86 related tests green; `tsc --noEmit` clean.

## Rollback

Set `messaging.toneGate.failClosedOnExhaustion: false` (existing operator knob) → the floor is skipped
(pure fail-open restored). Full revert: remove the `detectSelfStopShape` wiring + module. Additive
throughout; no data or state migration.

## Phase 5 — Second-pass review (required: touches the message gate)

An independent reviewer subagent audited this change against the code (not the artifact's claims).
**Verdict: Concur with the review**, with one non-blocking over-block concern.

Verified independently: (1) signal-vs-authority — `detectSelfStopShape` has exactly one caller,
`buildDegradedToneResult`, reached only on the two degrade sites; the normal path returns before it.
(2) Kill-switch inheritance confirmed on BOTH degrade sites (`failClosedOnExhaustion===false` fails
open before the floor is reached in `review()`, and `budgetDegrade` is `undefined` unless the
disposition is unset at the route seam). (3) No double-fire/shadow with the leak floor (leak runs
first, self-stop only when leak is null). (4) Tests prove the claims (drive real `gate.review()` with
an error provider), not tautological.

**Concern raised (addressed in-change, NOT deferred):** several markers were over-broad substrings
that would hold legitimate degraded-path messages (e.g. "come back to this … the tail of the array",
"as a follow-up; a local environment concern", "wrap up here — the compact dashboard layout",
"handoff doc covering this long work session"). Fixed by tightening both marker lists: dropped the
generic action phrases ("come back to this", "as a follow-up", bare "handoff", bare "defer/park"),
dropped the generic reason substrings (bare "compact" → "compact the conversation"; bare "tail of" →
"tail of this run/session / an already / a huge"; dropped bare "long/big work session", "local
environment"/"environment issue"/"environment failures" → kept only "environment-only failures"). The
four flagged false positives + one extra are now locked in as passing regression tests
(`self-stop-floor.test.ts` → "over-block regressions"); the 2026-06-27 incident still detects. 55
tests green after the tightening, `tsc` clean.
