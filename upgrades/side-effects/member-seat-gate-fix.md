# Side-Effects Review — Member-seat permission-gate false-positive fix

**Slug:** `member-seat-gate-fix`
**Date:** 2026-07-03
**Author:** Echo (instar-dev)
**Defect:** fb-e5b8b021-b74 (member-seat conversational asks refused as "above what a member can authorize")
**Tier:** 1 (small, low-risk, reversible precision fix to an intent classifier)

## Summary of the change

With the Slack outbound/permission enforcement gate ON, an ordinary workspace
MEMBER's harmless conversational asks (e.g. "post a check-in note here in 5
minutes") were classified tier-2 "low-write", which exceeds the member ceiling
(tier 1), so the gate refused them with an authority challenge. Effect: ordinary
members effectively could not talk to the bot while enforcement was on.

Root cause (two-part):
- `HeuristicIntentClassifier` classified ANY write-verb message (`post`/`note`/
  `schedule`/…) as tier-2 low-write — including the bot posting a conversational
  note into the CURRENT conversation, which is not an organizational action.
- `LlmIntentClassifier.reconcile()` only escalates the tier (`Math.max`), never
  lowers it, so the production LLM path could not correct the over-classification.

Fix: recognize a harmless conversational self-post (note / check-in / reminder /
status update into the current conversation, with no floor/org-write/external/
operational marker) as tier 1 (read/draft level) which a member may direct. A
recognized conversational self-post also short-circuits the LLM (symmetric to the
floor short-circuit) so the judgment band cannot re-escalate it.

**Files changed (source):**
- `src/permissions/types.ts` — add `conversational?: boolean` to `RequestIntent`.
- `src/permissions/IntentClassifier.ts` — add `isConversationalSelfPost()` +
  regexes; new deterministic branch (ordered after floor + operational, before
  the generic WRITE_VERB branch) returns tier 1 / `conversational: true`.
- `src/permissions/LlmIntentClassifier.ts` — new `conversational-deterministic`
  degrade reason + short-circuit returning the deterministic conversational read
  as-is (LLM never consulted, never re-escalated).

**Files changed (tests):** `tests/unit/slack-permission-gate.test.ts`,
`tests/unit/slack-llm-intent-classifier.test.ts`,
`tests/integration/slack-permission-pipeline.test.ts` — both-sides boundary
coverage (member conversational ask allowed; member genuine tier-2/floor still
refused; guest still refused; LLM cannot re-escalate; enforce-path pipeline).

## Decision-point inventory

- Harmless conversational note/check-in/reminder self-post in the current channel
  → **downgrade** to tier 1 (member-allowed).
- Any org-write/external marker (ticket, record, `#channel`, calendar, email,
  outside party) → **keep** tier 2+ (unchanged).
- Any operational marker (run/deploy/job/pipeline) → **keep** operational tier
  (unchanged).
- Any floor signal → **unchanged** (floor detection runs first and always wins).
- Plain chatter that merely mentions "checking in" (no post verb) → **unchanged**
  (stays tier 0).

## 1–7. Analysis (behavioral / security / reversibility)

- **Behavioral:** the ONLY behavior change is that a narrow, deterministically
  recognized class of harmless conversational self-posts moves from tier 2 to
  tier 1 — allowing an ordinary member to direct them. Every other classification
  is byte-identical.
- **Security / not weakening the gate:** the fix cannot widen access to a
  privileged action. Floor detection (money / prod-deploy / credential-access /
  destructive-data / external-send / grant-authority) is ordered FIRST in the
  heuristic and short-circuits before the conversational branch, and the LLM
  reconcile still drops any LLM-asserted floor. The conversational path is
  additionally disqualified by any org-write, external, or operational marker.
  The "X said it's fine" name-in-content trap (`content-name-not-authority`) is on
  floor actions and is untouched. Guests still cannot direct actions (tier-1 needs
  the member ceiling). Unregistered principals are still refused. This is a
  precision fix, not a floor removal — verified by both-sides tests.
- **LLM injection surface:** because a recognized conversational self-post
  short-circuits the LLM, untrusted message content can neither raise nor lower
  the tier on that path; and on every other path the existing never-widen
  reconcile clamp is unchanged.
- **Reversibility:** fully reversible by reverting the commit. No migration, no
  config, no schema, no state format, no new dependency, no new failure mode.
- **Framework generality:** the change is pure classification logic in the
  permission module; it does not touch session launch/inject and is
  framework-agnostic (no Claude-specific assumption).

## Evidence pointers

- Typecheck: `tsc --noEmit` — 0 errors.
- Targeted tests: `slack-permission-gate`, `slack-llm-intent-classifier`,
  `slack-permission-pipeline`, `slack-permission-enforce`,
  `slack-permission-wiring`, `slack-scenario-audit-harness`,
  `slack-relationship-anomaly`, `permissions-routes`,
  `slack-testcast-principal-pipeline`, `intent-llm-judge*`, ambient gate — all
  green (both-sides boundary + enforce-path pipeline).
- Live re-drive from the member seat is driven post-merge/deploy by the operator.
