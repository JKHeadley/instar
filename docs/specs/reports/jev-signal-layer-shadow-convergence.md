# Convergence Report — Jev shadow comparison for the B1–B7 signal layer

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the codex CLI (clean RAN state). The
Standards-Conformance Gate ran degraded (`error`, 0 findings) — recorded honestly;
non-blocking per protocol. Convergence was run in **abbreviated 80/20 form on the
operator's standing directive** (Justin, 20 Sep 22:28): one full parallel round —
a six-perspective internal panel plus the codex external — findings folded in one
edit, closed at that. The two extra confirmation rounds were deliberately skipped;
the non-skippable lessons-aware and decision-completeness perspectives ran inside
the panel.

## ELI10 Overview

Before the agent's messages go out, hand-written patterns look for dangerous
things (paths, commands, keys) and a judge decides what to do. Yesterday's
research showed Jev matches those patterns exactly on real traffic and is much
harder to fool. This spec builds a *shadow*: Jev watches the same messages and we
record whether it agrees with the patterns — while it decides nothing, blocks
nothing, and cannot slow anything down. After a bounded two-week trial (which
only starts if the operator explicitly approves sending message text to this new
vendor), we read the record and make a separate decision about actually using it.

## Original vs Converged

- "Fire-and-forget so latency is untouched **by construction**" became a *bounded
  and measured* claim: single-flight (one call in flight per process), hard abort
  at timeout, key cached once, and an explicit enabled-vs-disabled latency
  acceptance bound measured at test-agent-live. Not-awaiting proves no waiting; it
  never proved zero overhead, and the spec no longer claims it does.
- The 14-day soak stopped being a promise and became a mechanism: `soakEndsAt` in
  config, checked on every dispatch, inert past expiry across restarts.
- The comparison contract was frozen: rule↔detector mapping, p > 0.5 threshold,
  a closed two-shape row schema (`compared` / `not-compared` with an enumerated
  reason set, never a vendor error body), model-mismatch rows excluded, and the
  soak report defined as per-rule confusion matrices + coverage — because a
  blended 99% agreement can hide total failure on rare positives.
- The call was made visible to the Token-Audit standard: one FeatureMetricsLedger
  row per call, so the shadow's spend and latency land in `/metrics/features`
  rather than a private log (a raw fetch would have been the codebase's first
  unmetered LLM call).
- The machine-local log posture now carries its Standard-A justification key
  (`physical-credential-locality`, observation-locality framing) instead of
  citing a convention the deterministic gate does not accept.
- The call site was pinned to one named point (top of `review()`, post-floor) —
  the referenced detector runs at three sites and "after detectGateSignals" would
  have triple-fired.

## Iteration Summary

| Round | Reviewers | Design-class | Precision-class | SCG |
|---|---|---:|---:|---|
| 1 | six-perspective internal panel + codex external | 6 (codex 4: unbounded concurrency, undefined comparison contract, no expiry mechanism, incoherent failure schema; panel 2: Standard-A key, token-audit invisibility) | 3 | ran degraded (error, 0 findings) |
| close | operator 80/20 directive; all findings folded in one edit; zero unresolved | 0 remaining | 0 remaining | — |

Panel and closure ran under Fable 5; external `gpt-6-astra`.

## Convergence verdict

Closed after one full parallel round with every finding folded and zero open
questions. Eight frontloaded decisions; the one live decision — content egress to
the vendor for the soak — is deliberately the operator's, outside convergence,
and the flag cannot be flipped without it. Ready for operator review and approval.
