# Side-Effects Review — CommitmentSentinel bare-continuation guard

**Version / slug:** `commitment-bare-continuation-guard`
**Date:** `2026-06-04`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier-1: signal-only, favors false-negatives)`

## Summary of the change

The CommitmentSentinel registered a false-positive "commitment" for nearly every
user message — including bare approvals/continuations ("please proceed", "yes") —
because its LLM detector ran on every user→agent exchange. A deterministic
pre-filter (`isBareContinuation`) now drops bare-approval exchanges before the LLM
sees them. Reinforced with one line in the detection prompt.

## Decision-point inventory

One pure decision: `isBareContinuation(text)` — drop the exchange (true) or keep it
(false). Unit-tested on both sides (50 cases).

## 1. Over-block (what legitimate commitments could it wrongly DROP?)

A genuine durable request phrased as a bare phrase under 30 chars with no
imperative verb. Mitigated by the verb guard: any message containing a durable
verb (change/set/turn/deploy/restart/report/…) is KEPT, so "go ahead and deploy",
"sure, set the model to opus", "ok now restart the gemini server" all pass through
(tested). The residual risk is a one-word durable instruction with no verb, which
is vanishingly rare and favors the SAFE direction (a missed detection, not a false
commitment) — the infrastructure `POST /commitments` path still registers explicit
commitments regardless.

## 2. Under-block (what false positives does it still MISS?)

Substantive-but-non-committal exchanges (a real question the agent answered) still
reach the LLM; the prompt reinforcement is the second line of defense there. This
PR targets the dominant, deterministic false-positive class (bare approvals).

## 3. Reversibility / blast radius

Signal-only. The sentinel only DETECTS unregistered commitments; dropping an
exchange cannot delete or alter an existing commitment. No persistent state, no
migration, no route change. Fully reversible by reverting the filter.
