<!-- bump: patch -->
## What Changed

Compaction recovery now fits within the size Claude Code passes to the model (context-budget-layered-summaries §9.1; found by the Phase 0 verification run).

Claude Code hands a hook's output to the model in full only up to 10,000 characters. Above that, the model sees a ~2,000-character preview plus a file path. Instar's post-compaction recovery block was ~45 KB, so after a compaction the session received only its first lines.

The session-start hook now pipes the recovery block through a new helper, `fit-recovery-output.mjs`, installed beside the other built-in hooks. When the block is over the limit, the helper:

- saves the full block privately (0600, under the never-served layer root);
- prints a condensed block of at most 9,000 characters, in this order:
  1. the recovery marker;
  2. the conversation context (its head and its newest messages);
  3. the Telegram session;
  4. the heads of the identity and memory files;
  5. an explicit instruction to Read the saved file.

A block under the limit passes through unchanged.

The compaction canary is also corrected. It used to count a recovery that Claude Code cut to its preview as recovered. Such a compaction now counts as `recoveryTruncated` and makes the canary read `diverged`. Saved blocks are never backed up.

## What to Tell Your User

I found and fixed a gap in how I recover after Claude compresses a long conversation. My briefing had grown too big to be passed through whole, so only its first few lines were reaching me. It now fits, with the most important part first: what we were just talking about. The full version is saved, and I'm told to read it straight away.

## Summary of New Capabilities

- The post-compaction recovery block fits Claude Code's hook-output limit; the full block is saved, and the session is told to read it.
- The compaction canary reports truncated deliveries (`truncated` per group, `recoveryTruncated` per detection).

## Evidence

- Unit: `tests/unit/recovery-output-fit.test.ts` covers the fitter, the rendered hook end to end, and the canary.
- Integration: `tests/integration/recovery-truncation-canary-route.test.ts`.
- E2E: `tests/e2e/recovery-output-fit-lifecycle.test.ts`, which runs the real `migrate()` and then the installed hook.
- Measurement: `docs/specs/reports/context-budget-phase0-results.md`, check 4 (branch `cb-phase0-results`).
