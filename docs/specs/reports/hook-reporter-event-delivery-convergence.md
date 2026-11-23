# Convergence report: hook-reporter-event-delivery

## ELI10 summary

The little script that tells the server what happened in a Claude Code session read the event's name from the wrong
label, so every "turn ended", "helper started/stopped", "session ended" and "about to compact" event arrived as
"Unknown", and the parts of Instar that listen for those events never heard them. This change fixes the label, adds
the session id, bounds every new field (in the script and again at the server) and sends no message text.

## Iteration summary

This spec was split on 2026-11-21 from a broader draft (`command-hook-reporter-event-names`) that reached its six-round
cap. Its remaining findings were all in the practice-fold reply handling, which moves to its own spec; the reporter and
route part drew no new finding after round 3 of that draft. Rounds below are this spec's own.

| Round | Cross-model (codex-cli:gpt-6.2-astra) | Findings | Disposition |
| ----- | ------------------------------------- | -------- | ----------- |
| 1 | MINOR ISSUES | invalid route id used twice; Codex bodies untested; parity compared stored not sent JSON; scoped transcript_path | all fixed (validated id used once; Codex fixtures; wire-level parity; P20 text) |
| 2 | MINOR ISSUES | Codex PostToolUse claim; graduation vs Codex Unknown; P20 circularity; shared generator | fixed with Echo measurements (981/981 Codex tool events named; 32 prompt events named); graduation scoped; P20 rewritten; shared generator declined with reason (byte parity test) |
| 3 | MINOR ISSUES | script should bound fields before sending; continuous tally; provenance wording; parity claim scope | all fixed (script-side bounds; parity fixtures for legacy, unnamed, malformed) |
| 4 | MINOR ISSUES | session id serialized unbounded; trim-safe tally; Codex wording | all fixed |
| 5 | MINOR ISSUES | retained-rows claim; subagent stop path untested; Codex wording; invariant wording | all fixed (start/stop test with transcript path) |
| 6 | MINOR ISSUES | query id unvalidated; graduation trim detection; per-session count wording | all fixed after the round (id validated once before query and body; snapshot-based graduation); not re-reviewed: round cap reached |

Every round's verdict was MINOR ISSUES (never SERIOUS). Disclosure: the round-6 fixes were made after the final round
and were not re-reviewed by the cross-model reviewer; they are covered by tests that pass.

Standards-Conformance Gate: rounds 1-5 not run (omission, disclosed); final run 2026-11-22 01:53 UTC (6 flags, signal
only): Judgment Within Floors x2 (field limits are the native path's existing bounds; review caps are skill process),
Never Silently Cut (the 200-character tail is the native path's existing, ratified projection, unchanged here),
Iterative Audit (the split's open findings are tracked in the follow-up spec), Remove What Demands Attention (two
generators pinned by a byte-parity test), Multi-Machine (posture unchanged from the native spec's ratified
machine-local justification).

## Experience fit

The operator's outcome is that features already built (practice folds, subagent tracking, compaction recovery) receive
the events they were designed for. No new approval or notice reaches the operator.
