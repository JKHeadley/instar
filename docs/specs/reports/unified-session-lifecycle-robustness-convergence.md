# Convergence Report — Unified Session-Lifecycle Robustness

## ELI10 Overview

Your agent's sessions were vanishing without warning. The cause: a startup "cleanup crew" asks each
session "are you still alive?" and waits only one second for an answer. Right after a restart — when
the machine is busiest — a slow answer looks identical to a dead session, so live sessions got wiped.
One restart wiped all nine at once. Worse, when I went looking I found there isn't one cleanup crew but
**eight**, each deciding "alive or dead?" its own way, none coordinating, most sharing the same three
bad habits: treating slow as dead, killing things that are actually working, and doing it silently.

This spec gives the whole system **one shared brain**. Concretely: there's now a single front-door that
every shutoff must go through — a crew can *ask* to shut a session down, but the front-door, holding
the full picture, decides. The shared rules live in that front-door: "can't tell" never means "dead";
no positive proof a session is idle means no shutoff; a real shutdown tells you (a quick recovery
restart stays quiet); and nothing is immortal either — a session we genuinely can't verify escalates to
*you* for a decision rather than lingering forever or being killed on a guess.

What changes for you: sessions stop disappearing on slow restarts, you get told when one is genuinely
ended, you get a log page showing every shutoff and why, and if you run me on two machines they won't
fight over each other's sessions. The main tradeoff: the system is now deliberately *cautious* — in the
rare case a session is truly dead but unreachable, it waits one extra cycle (or asks you) rather than
risk killing a live one. That's the right trade: a lingering dead session is cheap; a killed live one
cost you work.

## Original vs Converged

The **original draft** correctly diagnosed the bug and proposed shared primitives, but kept all eight
killers able to shut a session down *on their own*, with the shared safety-guard only advisory ("a
floor"). It deferred the question of a single decision-maker, left the audit log as an open question,
didn't address running on multiple machines, and — done naively — its careful new probing would have
blocked startup for ~100 seconds, re-creating the very pile-up it was fixing.

The **converged version** is materially stronger:

- **One real authority, not eight.** Every shutdown now routes through the existing single-writer
  `terminateSession()`, which holds the safety-guard. Killers became *signals* that request a kill; the
  authority decides and can refuse. This turned a deferred standards-violation into a solved problem.
- **Multi-machine safety.** Only the "awake" machine may autonomously reap; a standby can't reach over
  and kill the active machine's work, and can't double-notify you.
- **Fast startup.** One "who's here?" query for everyone, individual re-checks only for the missing,
  bounded concurrency, and a hard 8-second cap — careful *and* quick.
- **Nothing immortal.** A session that fakes work (or that we can't verify) escalates to a single
  Attention-queue decision for you — never an auto-kill, never a silent leak — and can't clog the spawn
  limit so badly you're locked out.
- **The audit log ships now** (was an open question), with auth and injection-safe encoding.
- **Hardening:** input from user-renamed topics is sanitized before it reaches Telegram or the log;
  config is validated at startup so a zero-timeout can't silently recreate the bug; supervision tiers
  are declared; session matching is exact-id (no dangerous prefix matching).

## Iteration Summary

| Iteration | Reviewers who flagged material findings | Material findings | Spec changes |
|-----------|------------------------------------------|-------------------|--------------|
| 1 | conformance-gate, security, adversarial, integration, scalability, lessons-aware | ~18 (2 HIGH: signal-vs-authority deferral, missing supervision tier; plus terminateSession-funnel, lease-gating, boot latency, unkillability, sanitization, exact-id, config validation, …) | Full coherent rewrite around `terminateSession()` as single authority; added P5 backstop, multi-machine section, supervision tiers, reap-log; performance contract on the oracle |
| 2 | adversarial | 2 MED (staleness-clock gameable; lease-gate drops operator kill) + 2 LOW | No-forward-progress staleness signal; explicit unforgeable `origin` flag + skipped-kill logging; re-entrancy ordering; coalesce-count message |
| 3 | (converged) | 0 | `origin` defaults to `'autonomous'` (free hardening) |

Lessons-aware verdict at iteration 2: **CONVERGED** (both HIGH blockers genuinely resolved — real
structural authority collapse, not relabeling; supervision tiers properly justified). Adversarial
verdict at iteration 3: **CONVERGED — no material findings.** Conformance gate at iteration 2+:
**0 findings** across 22 standards (signal-vs-authority and observability both cleared).

## Full Findings Catalog

### Iteration 1

**Conformance gate (code, reads the constitution):**
- Signal-vs-Authority — *possible-violation*: killers keep independent kill authority, guard only a
  floor (SE-10). → Resolved by routing all kills through the single `terminateSession()` authority.
- Observability — *possible-violation*: reap-log left as an open question, absent from the conformance
  pass. → Resolved by committing the reap-log to ship in Phase 1 (P4).

**Security:**
- HIGH: positive-evidence guards = unkillability oracle (fake-work session immortal across all 8). →
  P5 backstop: stale-but-unkillable escalates to a human, never immortal.
- MED: `indeterminate` is a cheap unkillability lever (time out the probe). → P5 global
  server-unreachable escalation (one item, not a flood).
- MED: `dead` rests on parsing tmux exit/message; version drift / name collision / prefix match could
  reap a healthy sibling. → P1 exact full-id match against `list-sessions`; orphan reaper de-prefixed.
- MED: session names + reasons flow to Telegram + log unsanitized (topic-rename is user-controlled). →
  P3 mandatory Telegram HTML-escape; P4 JSON-encoded log lines.
- MED: `/sessions/reap-log` auth. → P4 Bearer-required, read-only, explicit.
- MED: race coverage single-machine only. → multi-machine lease-holder gate at the authority.
- LOW: SE-5 idempotency deferred to impl. → asserted in a wiring test.

**Adversarial:**
- HIGH: SE-2 escalation underspecified (no N/M, no dedupe, indeterminate counts toward absolute spawn
  cap → user lockout). → P5 defines N=15 / M=30m, per-episode dedupe, spawn-cap exclusion.
- HIGH: wake-reaper sleep math wrong for multiple sleeps. → gate through P1/P2; sleep-subtraction
  advisory + cumulative.
- MED: indeterminate→occupied projection could freeze scheduling. → bounded staleness window then
  re-probe (SE-3 projection split).
- MED: positive-evidence gaming leaves frozen sessions immortal. → P5 no-forward-progress clock.
- MED: same-tick recovery-vs-reap ordering race. → recovery flag written synchronously/CAS before
  kill-eligible evaluation; in-flight reap lock in the guard.

**Integration:**
- HIGH: spec ignored the existing `terminateSession()` single-writer funnel; routing through
  `killSession()` would drop `sessionComplete` + bypass CAS. → redesigned around `terminateSession()`.
- HIGH: boot purge not lease-gated; standby runs it. → moved behind the awake-only gate.
- MED: extracting ReapGuard risks splitting stateful transcript-growth logic. → ReapGuard scoped to
  stateless guards; transcript-growth/positive-idle stay in `SessionReaper.evaluate()`; wiring test on
  `keptBy` parity.
- MED: new config knobs unvalidated. → startup validation (reject sub-floor/0ms timeout).
- MED: recovery-bounce disposition inferred from ambient flag. → explicit `disposition` parameter.
- LOW: reap-log = Agent-Awareness item. → template + capabilities same phase.
- LOW: land inline-removal + funnel as one atomic commit. → adopted.

**Scalability:**
- HIGH: boot purge serial+sync; ≥5s+retry × 9 = ~100s blocked = death-spiral by latency. → async, one
  `list-sessions`, bounded concurrency N=6, 8s boot cap, 3s shared liveness cache.
- MED: no per-tick oracle budget. → bounded concurrency + per-tick deadline + shared cache.
- MED: ReapGuard fork cost now paid by every killer. → consulted only immediately before a kill,
  memoized per-tick, cheap-first ordering (in-memory before subprocess forks).
- LOW: coalesce buffer cap + single timer; don't use sync `listRunningSessions` on hot path. → adopted.

**Lessons-aware:**
- HIGH: Signal-vs-Authority violated + P10 Comprehensive-First (recurrence-risking deferral without
  approval). → resolved via single authority (deferral removed).
- HIGH: P7 LLM-Supervised Execution not engaged. → supervision tiers declared + justified.
- (honored: evidence bar, own-the-lifecycle, A-Wall-Is-a-Hypothesis, three-tier, near-silent.)

### Iteration 2 (adversarial)
- MED: staleness clock gameable by a 1-byte append every 29 min (any growth resets window). → P5
  no-forward-progress = meaningful delta (≥512B, non-repeat) OR CPU OR prompt-state change.
- MED: lease-gate silently drops a legitimate operator kill during handoff (origin inferred from
  reason). → explicit unforgeable `origin` flag at HTTP layer; skipped kills logged.
- LOW: guard-inside-authority re-entrancy. → ordering stated (guard reads lock as-of-entry; authority
  acquires after guard clears).
- LOW: coalesce drop-oldest silent. → consolidated message states total count + points to reap-log.

### Iteration 3 (adversarial)
- Non-material hardening: `origin` should default to `'autonomous'` when omitted. → adopted.

## Convergence verdict

**Converged at iteration 3.** No material findings in the final adversarial round; lessons-aware
converged at iteration 2; conformance gate clean (0/22). The spec is ready for user review.

**Note on approval:** Justin approved the *draft*. Convergence then materially strengthened the design
(single authority, multi-machine lease-gating, unkillability backstop, reap-log now shipping). Per the
process, `approved` is reset to `false` pending Justin's re-confirm against this converged design after
reading this report. Two open questions remain for him (notify-on-by-default; quota-vs-lost-work
tradeoff at 95%).
