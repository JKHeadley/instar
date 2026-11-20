# Convergence Report — A queued or forwarded agent-signed message keeps its agent label (SEC-106)

## Verdict: CONVERGED in a scoped round 7 (decision 5a), authorized by the Chief of Staff brief of 2026-11-18 07:28 PST.

Rounds 1-6 ran with the same three reviewers each round: an internal security/adversarial/decision-completeness reviewer, an internal integration/multi-machine/lessons reviewer (both Claude, fresh context, re-asked each round to mark prior findings), and the cross-model reviewer codex-cli:gpt-6-astra (cross-family; spec-only, no repo access). The Standards-Conformance Gate ran every round; its one standing flag (Cross-Store Coherence, no cadence check) is answered in the spec's Constitution notes, and both internal reviewers judged that deviation sound (round 4).

Round 6: both internal reviewers at design 0 (one residual added). The cross-model raised one design finding: classifier READS were not bound to the message's text, so a cache entry replaced under the same key could, in principle, lend one message another's agent label. Fix written as decision 5a (every read passes the text hash; mismatch → null, counted). It is UNREVIEWED. Because the finding is security-class, the skill sends it to the operator at the cap instead of self-authorizing a seventh round.

## ELI10 Overview

When an agent sends a signed message through a person's Telegram account, the system labels it "written by an agent". The label was lost when the message waited in a queue, started a fresh session, went to another of the agent's computers, or was replayed after getting stuck, so the session thought the person wrote it. The spec makes the label travel with the message everywhere, and on the way the reviewers found that a restart could also let such a message make the person the conversation's "operator". That is fixed too.

## Original vs current

Originally: one envelope field, four ingress sites, a drain-time classifier fallback, five paths. Now: the field on three envelope types with four named writers; no drain fallback (unsafe key); a sixth path (stuck replay) carried through the durable processing ledger; lifeline reclaims after a restart carry the ledger label; both operator auto-bind sites honour it and replays never bind; the classifier never downgrades a resident verdict for the same text and skips app messages; reads are text-bound (5a, unreviewed); spawn framing (heading, reference line) labelled; per-path counters in authed /health.

## Iteration Summary

| Round | Design findings (sec / int / cross-model) | Spec changes |
|---|---|---|
| 1 | 6 / 3 / 0 | path F + third D site; spawn heading + reference line; fallback dropped; no-downgrade; two writers; counters moved to /health |
| 2 | 2 / 1 / 2 | replay label from the ledger, not the dedupe key; replay never binds; text-hash no-downgrade; app entries skipped |
| 3 | 1 / 1 / 2 (precision) | ledger label written at decideIngress and claimForwardedInbound; one reconciliation algorithm; undefined = absent |
| 4 | 0 / 0 / 1 | lifeline reclaims carry the ledger label (restart + re-forward); wording; mesh-owner gap filed fb-b017cbbd-638 |
| 5 | 1 / 0 / 1 | route auto-bind honours the ledger label; input-match before copy; strip in-process fields |
| 6 | 0 / 0 / 1 | text-bound classifier reads (5a) — written, unreviewed |
| 7 (scoped to 5a) | 0 / 0 / 0 | all three concur, including the cross-model reviewer that raised it. Precision folded in: name the polling photo/document log sites and how ingress recovers the caption; replay mismatches counted separately (`hashMismatchReplay`); parity tested from real Messages; broken test callers listed; duplicate sentence in decision 10 removed |

## Round 7
Scoped to decision 5a by the Chief of Staff (07:28 PST). Same three reviewer roles: the cross-model reviewer (codex-cli:gpt-6-astra, the one that raised the finding) returned CLEAN / CONCUR; the internal security reviewer and the internal integration reviewer each returned design 0, CONCUR. The internal reviewers were fresh instances with the same lenses: the round 1-6 subagents ended with the previous session. Its round-6 precision points (decision 10 overstated; name both reconciliation paths) were edited before round 7 launched.
