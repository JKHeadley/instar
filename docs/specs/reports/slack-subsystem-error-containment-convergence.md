# Convergence Report — Slack Subsystem Error Containment (Robustness Net #1)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's `codex` CLI in **both**
review rounds (gpt-5.5), and a Gemini-tier pass ran through the `gemini` CLI
(gemini-2.5-pro) in both rounds. Every external pass returned `status: ok`
(MINOR ISSUES — no blockers). This is the clean RAN state. The aggregate is the
freshest successful flag: `codex-cli:gpt-5.5`.

## ELI10 Overview

The agent talks to Slack over a always-on network pipe (a WebSocket). On
2026-06-14 that pipe hiccuped at a bad moment, the code tried to send a message
down a pipe that wasn't fully open, and the resulting error wasn't caught — so the
*whole* agent process crashed. Two newer safety nets (an in-process auto-respawn
and an OS-level watchdog) already bring a crashed agent back in about ten seconds,
so this was a short outage, not a long one. But the cleanest fix is to stop the
Slack pipe from being able to crash the whole agent in the first place. That's what
this change does.

The fix funnels every "send something to Slack" call through one small, careful
helper (`_safeSend`) that checks the pipe is open, wraps the send so an error can
never escape, and quietly reconnects when the pipe is the thing that's dead. A
companion change adds a second process-level safety catch for a category of error
(an "unhandled promise rejection") that the existing catch didn't cover — using the
*exact same* tight, audited list of "known-harmless" errors, so the agent still
crashes-and-restarts on anything genuinely unknown (a corrupted state should reset,
not limp along).

For users, nothing changes on a good day — there's no new button, no new setting,
no behavior difference when Slack is healthy. The only visible difference is on a
bad day: a transient Slack glitch that used to take the whole agent down now just
reconnects Slack and leaves everything else (your other chats, scheduled jobs,
memory) running. The main tradeoff the review debated was "how much should the
agent swallow vs. crash-and-restart?" — and the answer landed firmly on *swallow
only a tiny, named set of known-benign network errors; crash on everything else*,
because a crash now costs ~10 seconds and a wrongly-swallowed corruption could cost
much more.

## Original vs Converged

**Originally**, the spec described the fix as primarily rescuing the Slack
*acknowledgement* send (its "most likely trigger") and left the process-level guard
as an open "decide between a global swallow vs. per-subsystem boundaries" question.
It also left several mechanical decisions implicit.

**After review**, three things changed materially:

1. **The framing was corrected against the real code.** The acknowledgement send and
   the heartbeat probe are *already* guarded; the genuinely-unguarded sends today are
   `queueOutbound` and `_drainQueue`. So `_safeSend` is now framed as a *consistency +
   regression-prevention* funnel (one policy, one wiring ratchet), not an ACK rescue.

2. **Every open decision was frontloaded.** The decision-completeness reviewer found
   7+ decisions still parked on a human (whether to add an `unhandledRejection`
   handler, how the message queue behaves on a failed drain, the test seam, a config
   flag, etc.). All are now resolved in a `## Frontloaded Decisions` section
   (FD-1..FD-8) so the build is a single autonomous run with zero "stop and ask"
   points. `## Open questions` is empty.

3. **The riskiest details were pinned so they can't be implemented wrong.** The ACK
   path must NOT trigger a reconnect (a failed ack ≠ a dead socket; reconnecting
   per-message risks a storm). The queue drain must *retain* unsent messages on
   failure instead of silently dropping them. `_safeSend` must capture the socket
   once and re-check identity before reconnecting (so it never tears down a freshly
   replaced healthy socket). The process-guard backstop adds exactly one *anchored*
   error string (`'WebSocket is not open'`, never the bare `'is not open'`, which
   collides with live "registration is not open" / "database is not open" messages),
   and the new `unhandledRejection` handler shares the *identical* narrow allowlist
   via one extracted function so the two handlers can never drift.

The review also debated, and ultimately *kept narrow*, a tempting broader rewrite
(a single-writer socket "actor" that eliminates these races by construction). That
is recorded as future hardening — it solves a *different*, larger problem (message
ordering, send interleaving) than the one that crashed the agent, and bolting it on
here would widen the blast radius of an incident fix.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware, codex-cli, gemini-cli | 14 distinct (high consensus) | Full rewrite: corrected framing; added `## Frontloaded Decisions` (FD-1..FD-8); per-callsite `_safeSend` policy table; `unhandledRejection` handler decision; anchored allowlist entry; Signal-vs-Authority + Cross-Machine + Observability sections; named E2E seam; dual-form wiring ratchet |
| 2 | decision-completeness (0 parked), lessons-aware (0; reversed its marker stance after grounding), adversarial (F2 material + 2 precision), codex-cli (minor), gemini-cli (minor) | 1 material (F2: shared-handler cleanup/exit ownership) + several precision/refinement | Pinned `handleProcessLevelError` location + injected cleanup/exit callbacks; exact `_safeSend` sequence with `this.ws === sock` identity re-check; drain index-snapshot-slice mechanics; transport-level allowlist scope + residual risk; scoped the non-goal claim + recorded tracked deferral; ratchet reframed as supplemental to behavioral tests |
| 3 | final adversarial confirm | 0 | none — converged |

## Full Findings Catalog

### Round 1

**Security (3 material).**
- *Anchor the allowlist, don't use bare `'is not open'`* — collides with live
  `"<name> is not open for public registration"` (TelegramAdapter/AuthGate) + DB
  strings → could swallow a fatal error. **Resolved:** FD-3 uses anchored
  `'WebSocket is not open'` + a negative unit test.
- *Prefer a structured marker over message-substring* — **Resolved with grounded
  counter** (FD-3): `_safeSend` swallows at source, so a marker can't reach the
  backstop; the backstop only sees un-funneled escapes that carry no marker → an
  anchored substring is the correct primitive. (Both round-2 lessons-aware and the
  externals concurred after grounding.)
- *`unhandledRejection` handler must reuse the same narrow predicate + default-crash*
  — **Resolved:** FD-2 shares one `isNonFatalUncaught` decision via
  `handleProcessLevelError`.
- (minor) reconnect-storm guard; no payload in logs — **Resolved:** FD-4 storm
  guard + FD-5 message-only logging.

**Scalability (3 material).**
- *`_safeSend` reconnect-on-failure must collapse to one reconnect/epoch-bump per
  tick* — **Resolved:** FD-4 ACK path does not reconnect; reconnect path is guarded
  by `!this.reconnecting` + identity re-check.
- *`_drainQueue` break-and-retain semantics + cap* — **Resolved:** FD-4 drain breaks
  on first failure, retains the tail (remove-only, ≤ MAX).
- *Log-flood: skip the expected not-OPEN branch + dedup* — **Resolved:** FD-5 logs
  nothing on the not-OPEN precheck (the flood source); only the rare OPEN→threw race
  logs.
- (minor) ACK hot-path overhead is provably nil (same guard relocated); no per-call
  object allocation — **Resolved:** signature uses positional args, not an opts
  object.

**Adversarial (4 material).**
- *ACK path must NOT reconnect-on-failure* — **Resolved:** FD-4.
- *`_drainQueue` must retain unsent items* — **Resolved:** FD-4.
- *Backstop must match the Node built-in WebSocket message* — **Resolved:** FD-3
  anchored entry.
- *`unhandledRejection` must reuse the tight allowlist, never swallow DB/state
  rejections* — **Resolved:** FD-2 (crash-by-default on anything unrecognized).
- (minor) stale-socket no-op correctness; spec line-number drift — **Resolved:**
  Goal 1 reads `this.ws` at call time + identity re-check; framing corrected.

**Integration (4 material).**
- *Name the E2E seam so it can't false-green* — **Resolved:** FD-8 child-process
  survival test of the real escaped-to-process path (not boot path).
- *Declare multi-machine posture* — **Resolved:** Cross-Machine Coherence section
  (all three artifacts machine-local-by-design).
- *`unhandledRejection` is the more-important half + must route through the same
  authority* — **Resolved:** FD-2.
- *Net #2/#3 interaction — containment removes the crash-and-reset; state it + test
  reconnect IS triggered* — **Resolved:** Observability section + heartbeat as the
  Slack-liveness guard; FD-8/integration tests assert survival.
- (minor) migration parity; rollback posture; wiring ratchet must match `?.send(` —
  **Resolved:** Migration/Rollback sections + dual-form ratchet.

**Decision-Completeness (7+ parked).** All frontloaded into FD-1..FD-8; `## Open
questions` emptied.

**Lessons-aware (3 material).** Fail-toward-crash default preserved (FD-1);
brittle-substring foundation smell addressed (FD-3 + funnel/ratchet as the real
guarantee); observability / no-new-masking-surface (Observability section).

**codex-cli:gpt-5.5 (MINOR).** Spec/code drift; Goal 3 "decide" → "verify/extend";
substring is weak; single-writer alternative; ratchet brittleness. All folded in.

**gemini-cli:gemini-2.5-pro (MINOR).** Obsolete framing; `unhandledRejection` gap;
custom-error-type pattern; authority interprets structured signal. Folded in (with
the grounded counter on the marker for *escaped* errors).

### Round 2

- **F2 (material):** the extracted `handleProcessLevelError` must own the
  cleanup+exit or the two handlers can drift. **Resolved:** function owns the full
  sequence; cleanup+exit are injected callbacks (keeps `uncaughtExceptionPolicy.ts`
  pure + unit-testable); the existing inline body becomes the function body.
- **codex#1 / adversarial F3 (precision):** identity re-check `this.ws === sock`
  before reconnect. **Resolved:** exact `_safeSend` sequence in Goal 1.
- **F1 (precision):** drain mutate-during-iterate. **Resolved:** index-over-snapshot
  + single `slice` assignment.
- **codex#2 (refinement):** allowlist entry is transport-level, not Slack-scoped.
  **Resolved:** FD-3 scope + residual-risk paragraph.
- **codex#3 / gemini#1 (refinement):** scope the single-writer non-goal claim + track
  it. **Resolved:** Non-goals rewritten + `tracked_deferrals` entry.
- **gemini#2 (refinement):** cite the Node origin of the error message. **Resolved:**
  noted as an implementation comment requirement in FD-3.

### Round 3
Final adversarial confirm: 0 material findings.

## Convergence verdict

Converged at iteration 3. No material findings in the final round. All round-1/2
findings are addressed; the decision-completeness gate is clean (0 decisions parked
on the user; `## Open questions` empty); both external families ran successfully in
both rounds. Spec is ready for build.

**Approval note (decoupled autonomous build).** This convergence runs inside a
decoupled instar-dev session launched by the operator's build brief (commitment
CMT-1351), which pre-authorized net #1 and pre-resolved the Goal 3 direction. The
`approved: true` tag is applied under that delegated authority and recorded
transparently here and in the Telegram milestone, rather than waiting on an
interactive click the decoupled run cannot receive.
