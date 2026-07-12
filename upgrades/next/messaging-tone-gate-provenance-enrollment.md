## What Changed

The always-on outbound **MessagingToneGate** is now enrolled as a wired LLM-decision provenance point, executing the pending→wired expansion the LLM-Decision Quality Meter (#1458) already defined. The tone gate is the highest-volume decision point in the fleet, so it records at a hard `budget:500/day` count ceiling (never `full`) and stores its content as **identity only** — a `sha256` of the candidate plus byte/char bounds and code-derived features (channel, message kind, recent-message count, gate-signal kinds). The outbound message body and any plaintext slice of it are **never** stored. Enrolling a fourth wired point activated the per-point round-robin grading sub-budget so grading capacity is shared fairly across points. Recording is observability-only — the tone gate's PASS/BLOCK verdict is byte-identical whether the provenance write succeeds, fails, or is disabled — and is dark-gated behind `provenance.uniformSeam` (enabled on the development agent, dark on the fleet).

## Evidence

- Side-effects review: `upgrades/side-effects/messaging-tone-gate-provenance-enrollment.md` (independent second-pass review concurred; verified critical-path inertness and no body-leak).
- Tests: `tests/unit/messaging-tone-gate-provenance-enrollment.test.ts`, `tests/integration/messaging-tone-gate-provenance.test.ts`, plus the updated `tests/unit/provenance-coverage-ratchet.test.ts` and `tests/unit/decision-grading-pass.test.ts` sub-budget cases — 49 targeted tests green; full lint chain (typecheck + dark-gate + attribution + ratchet) clean.
- Driven by the converged + approved spec `docs/specs/llm-decision-quality-meter.md` (§5.5 sub-budget, §5.6 volume valve + content classes).

## What to Tell Your User

None — internal, dev-gated observability with no user-facing surface. The change is dark on the fleet: it does not alter how the agent behaves, what it sends, or what a user sees. When enabled on a development agent it only records (machine-local, identity-only) what the always-on message-safety gate decided, so those decisions can later be graded. A user's messages, and the gate's block/allow behavior, are completely unaffected.

## Summary of New Capabilities

None user-facing. Internally: the outbound tone/leak gate now contributes to the LLM-decision quality record (dev-agent only, dark on fleet), giving the periodic grading pass its highest-volume data source while storing message identity only, never content.
