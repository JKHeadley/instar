# Convergence Report — The Operator Channel Is Sacred (operator-channel-sacred)

## ⚠ Cross-model review: SKIPPED (deliberate, load-safety)

External (non-Claude) cross-model passes were DELIBERATELY skipped for this convergence. Rationale:
the very incident this spec fixes was a machine-resource event (spawn-cap saturation), and the
machine was still recovering during this work — launching codex/gemini cross-model reviewers would
have risked re-triggering the exact overload under repair. Internal review was run instead:
the Standards-Conformance Gate + two bounded internal review rounds. Recommend a full cross-model
pass before/at PR time once the system is fully healthy.

## ELI10 Overview

A safety check could silently eat the operator's own messages when it guessed (or failed) — and
because the "how to recover" instruction went back through that same broken check, the operator got
locked out entirely. This adds the missing rule ("the operator channel is sacred — gates on it fail
toward DELIVERING your message, not eating it") and fixes the message-sentinel to it: a pause only
swallows a message on an unambiguous deterministic match, never on a brittle LLM guess or a
capacity-shed failure; a circuit-breaker auto-recovers from any lockout; and the genuine
emergency-stop path is preserved (its false-positive — a kill — is escapable, unlike the pause loop).

## Original vs Converged

Original draft: pause consumes on deterministic-match OR high-confidence LLM. Two review rounds
changed this materially: (1) a combined reviewer found the ACTUAL mechanism — the sentinel
capacity-sheds to `pause` (confidence 0.4) when its LLM call fails under spawn-cap saturation, which
is what consumed the operator's messages; the fix now routes that through. (2) It showed an LLM
"pause" verdict self-reports 0.8 confidence regardless of correctness, so NO threshold is safe →
pause now consumes on DETERMINISTIC-match ONLY. (3) A verification round caught that a >4-word genuine
stop also capacity-sheds and would be wrongly routed-through (re-creating the OpenClaw delete
incident) → added a non-word-count-gated stop-token scan that fails toward STOP before any
route-through. (4) The circuit-breaker was specified durable + topic-keyed + shared across both
consume paths. (5) The standard's route-through rule was scoped to message-CONSUMING/pause gates only,
never weakening destructive emergency-stop; the load-bearing property is RECOVERABILITY.

## Iteration Summary

| Iteration | Reviewers | Material findings | Resolution |
|-----------|-----------|-------------------|------------|
| 1 | Standards-Conformance Gate + combined internal (lessons/decision-completeness/adversarial/security) | 2 conformance + 6 combined (1 critical, 3 high, 2 med) | capacity-shed route-through; deterministic-only consume; durable shared circuit-breaker; emergency-stop recoverability reframe; observability + wiring test; standard asymmetry |
| 2 (verification) | combined verification reviewer | 1 high + 1 med + 2 low | >4-word-stop-under-capacity stop-token scan; purged threshold-framing contradictions; removed tautological corroboration clause; open-questions honest |

Standards-Conformance Gate: ran (2 flags → resolved). Cross-model: deliberately skipped (load-safety, documented above).

## Convergence verdict

Converged at iteration 2 (abbreviated, load-conscious): the verification round's findings were folded
and the remaining items were mechanical consistency cleanups. Open questions = none. Ready for build
(with a recommended full cross-model pass at PR time on a healthy system). The convergent audit of all
instar for the same blindspot is a tracked follow-up (heavy; paced to not re-overload).
