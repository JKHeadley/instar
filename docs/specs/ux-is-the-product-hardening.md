---
title: "The User Experience Is the Product — Reachability, Responsiveness, Coherence, and the Self-Stop Guard"
status: draft
tags: [spec]
author: echo
created: 2026-06-28
parent-principle: "Structure > Willpower; The Agent Carries the Loop; Live-User-Channel Proof Before Done"
---

# The User Experience Is the Product — Hardening Spec

## 0. Why this spec exists (the trigger)

On 2026-06-27 ~21:01 PDT, in topic 29099, an Echo session sent the operator a message that
**stopped in-flight, pre-approved work** with this reasoning (verbatim excerpts):

- "Why I'm pausing here rather than barreling ahead: the next phase is commit → deploy → live test."
- "do that deliberately, not as the tail of an already-huge work session."
- "Deploying restarts the agent you're talking to … I'd rather run it as a clean, focused pass
  than risk a half-finished restart."

The operator's response (paraphrased): these statements **completely violate** the autonomous
standards. The false-excuse patterns ("half-finished", "barreling ahead", "tail of a huge work
session", "restarting the agent") should have been caught and the agent pushed to continue. Two
explicit operator directives:

1. **Local environment issues are the agent's responsibility to FIX, not an excuse to stop.**
2. **Restarting the agent is a MINIMAL disruption, not an excuse to stop.**

And: "find out why our autonomous standards failed here and let's fix them."

This spec is the answer. It has a **root-cause** half (why the guard let it through) and a
**design** half (how to harden it), plus the umbrella standard and the related reachability fixes
(F1–F7) the same incident family motivates.

---

## 1. Root cause — why the self-stop guard failed (EMPIRICALLY GROUNDED)

> **Correction (2026-06-28):** an earlier draft of this spec claimed the defect was that B15
> "string-matches literal phrases." That was WRONG — it was read from a stale branch (echo/serve-main,
> 127 commits behind canonical main). The DEPLOYED gate (v1.3.690, running ~8 days) already judges
> B15 **by meaning**. The real root cause, established by direct replay below, is different and more
> important: **the behavioral self-stop guard silently FAILS OPEN when the LLM judge is unavailable —
> exactly the condition (flaky LLM backend) that held the night of the incident.**

### Evidence (direct replay, not inference)
Replaying last night's verbatim "why I'm pausing" message through the **live deployed gate** (via a
real `pi-cli` provider) returns:
```
pass=false  rule=B15_CONTEXT_DEATH_STOP  failedOpen=false
issue: "...proposes pausing the commit/deploy/live-test phase partly because it would be the tail of
        an already-huge work session ... an agent-state/freshness rationale for deferring substantive
        in-flight work."
```
A legitimate "I need your decision" control message returns `pass=true`. **So the detection logic is
correct and WOULD have blocked the message — when it runs.** Yet `GET /metrics/features` shows the
gate **fired=0 across 394 real calls in 72h** — it has blocked nothing. The reconciling fact:

### The defect — fail-open under backend outage
`src/server/routes.js` wraps the entire tone-gate evaluation in `try { … } catch { /* fail-open */ }`
(returns `{ ok: true }` on ANY error). And the graceful-degradation path (PR #1279,
`buildDegradedToneResult`) degrades to the **deterministic LEAK floor** (CLI/file-path/internal-id) —
which does NOT include the **behavioral** self-stop checks (B15–B18 REQUIRE the LLM judge). So when
the LLM backend is unavailable (provider throw → catch → fail-open, OR slow-budget-timeout → degrade
to leak-only floor), the behavioral self-stop guard **silently vanishes**. The leak protection keeps
working; the self-stop protection is simply gone. The night of the incident the LLM backend was
flaky/rate-limited (the entire premise of the absorbed topic-28744 work) — so the guard that should
have caught the drift had no brain to think with, and failed toward sending.

### Compounding cause R0 — the autonomous layer was absent
The autonomous run doing this work (topic 28744) had `end_at` 2026-06-26T15:51:58Z — it expired more
than a day before the 06-27 incident. The stop-hook authority (`UnjustifiedStopGate`) only runs inside
an active autonomous session, so it was structurally absent; only the always-on tone gate applied, and
that failed open as above. (R0 is **F2** below: a run must have an enforced external hard-stop so
follow-on work is never guard-less.)

### (For the record) the original two-layer landscape
Instar already has self-stop guards in two relevant layers:

### Layer A — `UnjustifiedStopGate` (the autonomous stop-hook authority)
- Scoped narrowly to **context-death self-stops**: an agent rationalizing a stop by citing
  *context-window / fresh-session / compaction* concerns when durable artifacts make continuation
  safe (`src/core/UnjustifiedStopGate.ts`, CONTINUE_RULES U1–U3).
- **It only runs inside an active autonomous session** (the Stop hook keyed on `session_id`).
- **Finding R0:** at 21:01 on 06-27 the autonomous run that had been doing this work (topic 28744,
  `end_at` 2026-06-26T15:51:58Z) **had already expired more than a day earlier.** So the session
  that sent the excuse was very likely NOT under the stop-hook at all. Layer A was structurally
  absent. (This is itself F2: an autonomous run with no enforced external hard-stop, and follow-on
  work that drifts on with no guard.)

### Layer B — `MessagingToneGate` B15–B18 (the ALWAYS-ON outbound gate)
This is the layer that *was* active (it gates every outbound message regardless of session type).
It has four self-stop behavior rules:
- **B15_CONTEXT_DEATH_STOP** — pausing/stopping/handing-off for a context-window/fresh-session reason.
- **B16_UNVERIFIED_WALL** — calling a doable thing impossible.
- **B17_FALSE_BLOCKER** — handing a doable task to a human.
- **B18_AUTONOMY_STOP** — ending an autonomous run citing "needs judgment / needs real engineering".

**On B15's coverage (NOT a gap — verified):** the deployed B15-by-meaning already catches the
incident's "restart-disruption / volume-fatigue / clean-focused-pass" framing — the replay above
proves it (`rule=B15_CONTEXT_DEATH_STOP`). So there is **no detection gap** to fill with a new rule;
the "environment-issue-as-stop" family is the one shape worth a small explicit reinforcement (see
§2.3), but the dominant defect is reliability, not coverage.

**Conclusion.** The guard failed for two compounding reasons, neither being "the logic is wrong":
(R0) the autonomous stop-hook layer was **absent** because the run had expired with no enforced
hard-stop or hand-off (→ F2); and **(R-FAILOPEN, primary)** the always-on behavioral guard **fails
open / degrades to a leak-only floor when the LLM judge is unavailable**, so under the flaky-backend
condition that held that night the self-stop check silently vanished. The fix is to make the guard
**not disappear under load**, plus make the judge reliably available.

---

## 2. Design — make the self-stop guard survive backend outage

### 2.1 Deterministic self-stop floor (the primary fix — fixes R-FAILOPEN)
Today `buildDegradedToneResult` degrades to a leak-only deterministic floor when the LLM judge is
unavailable. Add a **deterministic self-stop detector** (`src/core/self-stop-floor.ts`, no LLM) that
recognizes the self-stop SHAPE in an AGENT-OUTBOUND message: a proposal to pause / defer / "pick up
later" / "clean focused pass" / restart-avoidance / "huge session" / environment-issue-as-stop, WITHOUT
a legitimate-stop signal (a real question to the user, an external blocker, a completion). Wire it into
BOTH degrade sites (the provider-throw branch in `MessagingToneGate.review()` AND the slow-budget-
timeout branch via `buildDegradedToneResult`):
- **When the LLM judge is unavailable AND the deterministic floor flags self-stop shape → HOLD**
  (fail-CLOSED on suspicion, surfaced to the agent to reconsider), not fail-open.
- Clean agent messages and all non-self-stop content still SEND (the floor is narrow; it only holds
  the self-stop shape). This preserves "the user is never silently cut off" for everything else.
- **Bias:** favor false-positives HERE (holding a borderline agent self-stop costs the agent a
  re-think; a false-negative is the exact failure we are fixing). This is the inverse of B16/B17's
  bias because the cost asymmetry is inverted for the degraded path.

### 2.2 Reliable judge (28744 backend work — verify live, mostly landed)
The deterministic floor is the safety net; the real judge being AVAILABLE is the actual fix. PRs
#1276 (pi available at boot), #1277 (per-framework breaker isolation), #1279 (graceful degradation)
are MERGED on canonical main. Verify the deployed agent runs them: routing shows pi+gemini
`available:true`, and a claude rate-limit does not pause the pi/gemini judge. With a fast off-claude
judge reliably available, the gate runs the FULL behavioral check even when claude is walled.

### 2.3 (Optional reinforcement) make "environment-issue-as-stop" explicit in B15
The one framing the replay did not independently confirm is "a fixable LOCAL/ENVIRONMENT issue used
as a reason to pause rather than a task to fix." Add one ILLUSTRATIVE clause to B15's by-meaning
guidance (NOT a literal gate): treating a self-fixable local/environment/test/setup failure as a stop
reason is an agent-state stop (the operator's directive: "fix the local environment; it's your job").
Low-risk prompt-text addition; keep the legitimate carve-out for a GENUINE external blocker.

### 2.4 Side-effects analysis (the operator's explicit concern)
- **Risk: the deterministic floor over-HOLDS legitimate agent messages** — *Mitigation:* the floor is
  NARROW (only the self-stop shape) and only engages on the DEGRADED path (LLM judge unavailable); the
  normal path is unchanged. A held message is surfaced to the agent to reconsider, never silently
  dropped. A genuine "I need your decision" still SENDS because it carries a legitimate-stop signal.
- **Risk: the floor blocks a user from hearing a genuine blocker report under outage** — *Mitigation:*
  the floor's legitimate-stop carve-out includes a real external blocker and a real question; only the
  *self-protective* shape is held. And the operator kill-switch `failClosedOnExhaustion:false` flips
  the whole degraded path back to fail-OPEN if an operator ever wants the old behavior.
- **Risk: the floor fires on this spec / a memo discussing self-stops** — *Mitigation:* the floor only
  runs on AGENT-OUTBOUND messages on the reply path; a meta-discussion that proposes no stop carries no
  self-stop action to flag. (And the LLM path's meta-self-reference carve-out is unchanged.)
- **Blast radius:** one new deterministic module + wiring into the two existing degrade sites + tests.
  No data-model change, no route change, no change to the normal (judge-available) path. Ships behind
  the existing tone-gate config; the new behavior only manifests when the judge is down. Default-on is
  justified because it strictly *adds* protection on a path that currently fails open — but it is
  gated by the same `failClosedOnExhaustion` three-valued knob, so an operator can disable it.

### 2.5 Close R0 — the autonomous layer must not be absent
This is **F2** (below): an enforced EXTERNAL hard-stop at budget so a run cannot silently expire and
leave follow-on work guard-less. The self-stop guard is only as good as its being *active*; F2 makes
the autonomous layer's presence structural. (This very 24h run is the live test of F2.)

---

## 3. The umbrella standard — "The User Experience Is the Product"

Propose adding to `docs/STANDARDS-REGISTRY.md` a constitutional standard with these teeth
(the F-series), each a structural guard, not prose:

> **The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred.**
> Every guard in Instar points inward (protecting the system). The user's ability to REACH the
> agent, HEAR the agent, and receive COHERENT behavior is itself a protected resource. A guard that
> protects the system by degrading the user's channel has the priority backwards.

- **F1 — State Convergence:** a pinned cross-machine topic move self-actuates (a reconciler drives
  actual-owner → pinned target and closes the source session); no manual force-kill.
- **F2 — Enforced Termination:** autonomous runs get an EXTERNAL hard-stop at budget (the runaway
  class — ran far past deadline — becomes impossible).
- **F3 — Inbound Delivery Is Sacred:** an inbound user message reaches a live agent within a bound or
  fails LOUDLY; the holding-queue must never silently expire a user message (half-built net fails
  OPEN to the working path).
- **F5 — User-Facing Priority Lane:** user-facing outbound (the tone gate) preempts background
  sentinels when the host spawn cap / LLM queue is contended.
- **F6 — Degradation Is an Event:** degraded coordination (lease-tick stall, framework-unavailable)
  surfaces where it can reach the user, not just a quiet log line.
- **F7 — Blast-Radius / Verify-After:** a mutating session/routing op verifies user-reachability
  afterward (would have caught the force-kill that black-holed inbound messages).

Each F-item ships dark/flagged with a test, OR is a tracked deferral with an explicit recorded reason
(no silent drop). The self-stop guard hardening (§2) is the **behavioral** sibling of the F-series:
where F1–F7 keep the *channel* alive, §2 keeps the *agent* from talking itself out of using it.

---

## 4. Already-landed work to verify (not re-do)

From the absorbed topic-28744 backlog, these merged on canonical main — VERIFY live + deployed,
close remaining test stubs, do NOT rebuild:
- **#1276** (merged) — config loader carries `frameworkDefaultModels` → pi-cli available at boot.
- **#1277** (merged) — per-framework breaker isolation test (claude trip ≠ pi/gemini pause).
- **#1279** (merged) — tone gate degrades to the deterministic floor on LLM-backend outage.

So tasks 4 (LLM backend) and 5 (graceful degradation) are largely shipped. Remaining: confirm the
deployed shadow-install runs the merged code, and that routing shows pi+gemini available with the
fast-fallback chain for the user-facing gate.

---

## 5. Verification plan (Live-User-Channel Proof — the gate on "done")

No item is "done" until verified through the REAL user surface, by a user-role pass, BEFORE the
operator would hit it:
- Register + wire the on-disk `justin-telegram-backup` Playwright profile (live web.telegram.org
  login present on this laptop); mind the stale SingletonLock.
- Drive a real Telegram round-trip AS Justin through the web UI: send → Echo receives → Echo replies
  → reply visible. Record PASS.
- For §2: a recorded scenario where a *prudence-dressed deferral* candidate is HELD by the gate
  (B15-by-meaning when the judge is up; the deterministic floor when it is down) and a *legitimate
  operator-decision pause* PASSES — both proven by test, including a forced LLM-judge-unavailable case.
- Cross-machine profile gap recorded as next-work (browser cookies are machine-local; secret-sync
  carries the vault, not browser sessions).

---

## 6. Open questions (carried for the operator, restated plainly)

1. **Scope of the deterministic floor:** should "I'm pausing to ask you a real decision" ALWAYS pass (current design:
   yes, it's a legitimate stop), even though a clever agent could disguise deferral as a fake
   question? Design leans: yes-pass, and rely on the floor catching the *self-protective* framing; a fake
   question is a harder, separate problem. (Pre-approved to proceed with yes-pass.)
2. **F-series depth:** ship all of F1–F7 this run, or ship the highest-value (F2, F3, F6) and track
   F1/F5/F7 as explicit deferrals if the 24h budget is the binding constraint? Design leans: ship
   F2 + the §2 guard (the direct fix for the incident) first; take F1/F3/F5/F6/F7 as far as the
   budget allows; any not-shipped item gets a tracked deferral with a reason, never a silent drop.
