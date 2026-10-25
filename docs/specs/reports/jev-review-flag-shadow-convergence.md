# Convergence Report — Jev review-flag shadow

**Spec:** [docs/specs/jev-review-flag-shadow.md](../jev-review-flag-shadow.md)
**Slug:** `jev-review-flag-shadow`
**Converged at:** 2026-10-05
**Iterations:** 1 review round (80/20, operator rule 2026-09-17; same shape as jev-circles-shadow)

## Cross-model review: codex-cli:gpt-5.5

## Review

Three reads ran in parallel on the draft:

- **Internal reviewer** (fresh Opus subagent, read-only; security, integration,
  adversarial, decision-completeness and lessons-aware angles together),
  checked against the real code and the live Telegram history.
- **External reviewer** (codex-cli, gpt-5.5): verdict MINOR ISSUES.
- **Standards-conformance gate** (`POST /spec/conformance-check`): fit with the
  parent principle; four possible violations.

### What changed the build

1. **The Stop-hook trigger was replaced by a server-side tail of the Telegram
   history.** The internal reviewer found the history's `sessionName` is the
   topic's mapped session at log time, not `INSTAR_SESSION_NAME` (strict
   matching would silently empty the sample); the existing hook exits early
   when action-claim is off (the fleet default), so the new POST would need a
   restructure; and a reply logged after Stop would be missed. Codex raised
   the same ordering risk. The gate flagged the Claude-only trigger
   (Framework-Agnostic). A 60-second tail of the history removes all four: no
   hook change, no race, no session matching, every framework covered.
2. **Every reply is judged, not only a turn's last** (codex: the last reply
   may not be the one reviewed).
3. **Cuts are disclosed** in band to Jev and in the row (gate: Never Silently
   Cut the Data a Decision Depends On).
4. **The served model is recorded per row** (gate: Observable Intelligence).
5. **Scoring gains an `ambiguous` label and excludes desk messages sent
   through the operator's account** (codex; internal reviewer).

### Answered without a change

- **Decision Provenance (gate):** the log stays content-free; the judged
  input is fully recoverable from the durable Telegram history by message id
  plus the fixed cuts. Stated in the spec.
- **A second "why" question (codex):** not taken; the measurement is whether
  one label predicts corrections.
- **Deterministic detector features (codex):** not taken; claim verification
  and action-claim already exist, and this measures Jev alone.

## Convergence, stated honestly

One round. Its findings changed the trigger, then stopped changing the build:
the remaining items are local and each is covered by a test.

## ELI10 Overview

The server will quietly read each reply Echo sends to Justin on Telegram, ask
a small model "does this one need Justin to look at it?", and write down the
answer without showing it to anyone. After a week we check those answers
against the replies Justin really corrected.

## Decision

Log-only and dev-gated; proceeds under the operator's request for the
watch-only flag (topic 95267, 2026-10-05) and the standing rule that reviewed,
gated code merges without a separate approval.
