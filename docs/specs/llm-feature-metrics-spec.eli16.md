# Per-feature LLM metrics — plain-English overview

## What this is

Instar runs a bunch of automatic "safety checks" — gates and sentinels that look
at messages, actions, and decisions and sometimes block or flag them. Many of them
ask an AI model to judge, which costs tokens and time. Right now we have **no idea,
per check, how much each one costs or how often it actually catches anything.** The
total cost only became visible when it added up to a rate-limit.

This change builds the **measuring tape**: for every check, record what it costs and
what it decides, so we can finally answer "is this check worth it, and should we run
it less, run it more, or change how it works?" with real numbers instead of guesses.

## The lucky shortcut

Every AI-powered check already flows through **one piece of code** (the shared model
provider that the circuit-breaker wraps). So we put the measuring tape at that *one*
spot and automatically get numbers for *all* the checks — no need to wire each one up.
That's the same trick Instar already uses for safe file/git operations.

## What gets recorded

Per check, per call: which check it was, tokens used, how long it took, and whether it
**fired** (blocked/flagged) or was a **no-op** (allowed). From that we compute each
check's cost and its "hit rate." Later we add **effectiveness** — was a block actually
right, or was it crying wolf — by seeing what happened after.

## What's new vs. what exists

- New: a small storage ledger (`FeatureMetricsLedger`, SQLite, read-only — it never
  blocks anything) and a read endpoint `GET /metrics/features`.
- Exists: Instar already tracks *token usage per session* (TokenLedger). This extends
  that idea from "per session" to "per check."

## How it's split (and why)

A separate Echo session is *also* working on the same one piece of code right now
(PR #638, making checks wait politely instead of failing when rate-limited). To avoid
two changes colliding in the same file:

- **This change (Phase 1a):** the ledger + endpoint + tests. It does **not** touch that
  shared file, so there's no collision. The ledger is fully tested by calling it directly.
- **Phase 1b (after #638 lands):** add the ~3 lines in that shared file that feed real
  data into the ledger — built on top of #638's final version, measuring its new
  wait-behavior too.

- **Phase 1b refinement (2026-06-03):** two honesty fixes once real data flowed in.
  (a) The breaker sometimes refuses a call entirely (the circuit is "open") — no LLM
  runs, no cost. That was being recorded the same as a *completed* call, so the
  numbers looked like "99% of calls did nothing" when really most calls never
  happened. Now those are tagged **`shed`** and reported separately, and **`realCalls`**
  (= calls − shed) is the honest count. (b) The two busiest callers weren't labeling
  themselves, so their spend showed up as "unlabeled" — now tagged (InputGuard,
  PresenceProxy). Still measurement-only.

## What the reader needs to decide

Justin already approved the plan and said proceed. If reviewing: confirm this is
**measurement only** — it reads and records, it never changes what any check decides
or blocks. That's the core safety property (same as the existing token ledger).
