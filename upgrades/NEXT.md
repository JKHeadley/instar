# Upgrade Guide — NEXT (autonomous completion evaluator)

<!-- bump: minor -->
<!-- minor = new capability, backward compatible -->

## What Changed

**New: autonomous mode can decide "done" with an independent judge — not the agent's own say-so.**

Autonomous runs decided completion by scanning the transcript for a self-declared token
(`<promise>...</promise>`) — the agent grading its own homework. Now you can set a verifiable
**completion condition** and an INDEPENDENT small/fast model judges, each turn, whether the
condition is met against what the agent has surfaced — exactly how the framework `/goal`
feature works (Claude Code's `/goal` is itself a prompt-based Stop hook, the same mechanism as
ours). Not met → keep working, with the judge's reason fed back as next-turn guidance. Met →
the run exits. This is the loop's continue/stop authority, a full-context model judgment.

- Start with `--completion-condition "<measurable end-state>"` (e.g. "all tests in test/auth
  pass and `npm test` exits 0"). The self-declared `<promise>` path remains as a legacy
  fallback when no condition is set — fully backward compatible.
- **Fail-safe:** if the evaluator is unreachable, the run keeps working — a missing judge never
  causes a false "done"/premature exit.
- Endpoint: `POST /autonomous/evaluate-completion` `{condition, transcriptTail}` → `{met, reason}`,
  via the shared `IntelligenceProvider` (framework-aware), spend-capped by `LlmQueue`.

## What to Tell Your User

When I work autonomously now, I don't get to declare myself finished — a separate judge checks
a real finish-line you set (like "all tests pass") and only lets me stop when it's actually
true. If that judge can't be reached, I keep working rather than risk a false "done." It's the
same idea as the new `/goal` feature, built into our autonomous mode so it works on any
framework. Nothing to set up; existing agents get it on their next update.

## Summary of New Capabilities

- `--completion-condition` for autonomous runs: a verifiable end-state judged independently.
- `POST /autonomous/evaluate-completion` — independent /goal-style completion judge.
- `CompletionEvaluator` (small/fast tier, spend-capped) — judges condition vs transcript; fails
  safe (never a false "done").
- Stop hook feeds the judge's reason back as next-turn guidance (mirrors `/goal`).
- Legacy self-declared `<promise>` retained as fallback.

## Migration Notes

Existing agents receive the updated hook + setup script via
`PostUpdateMigrator.migrateAutonomousStopHookTopicKeyed` (marker bumped to the completion-evaluator
signature). The evaluator activates automatically wherever an `IntelligenceProvider` is configured;
where it isn't, the legacy promise path runs. No action required.

## Evidence

- **Unit:** `CompletionEvaluator.test.ts` (7) — MET/NOT_MET verdicts, NOT_MET-vs-MET substring
  guard, and **fail-safe** (empty/ambiguous/throwing provider → `met:false`, never a false done).
- **Integration:** `autonomous-sessions-api.test.ts` — `POST /autonomous/evaluate-completion`
  returns met:true when the transcript shows success, met:false otherwise, 400 without a condition.
- **Hook (behavioral):** `autonomous-completion-condition.test.ts` (4) — evaluator MET → exit +
  clear state; NOT-MET → block + keep working; **evaluator unreachable → block + keep working
  (no premature exit)**; legacy promise path preserved when no condition.

## Tracked follow-up

The enhancement to let the evaluator run real checks itself (`/verify-claim`: tests/build/grep)
rather than judging only what's surfaced is tracked as commitment **ACT-152** (high priority,
surfaced by the commitment-check job until done) — not an untracked note.
