# Side-Effects Review — Codex session-resume via subcommand

**Version / slug:** `feat-codex-session-resume` (v0.28.115)
**Date:** 2026-05-18
**Author:** Echo

## Summary of the change

When `frameworkSessionLaunch.buildInteractiveLaunch('codex-cli', { resumeSessionId })` was called with a session id, the prior implementation logged a console warning and started a fresh session — Codex's `--resume` flag was never accepted. New implementation inserts `resume <SESSION_ID>` as a subcommand right after the binary path. All flags (`--model`, `--sandbox`, `--ask-for-approval`, `--dangerously-bypass-approvals-and-sandbox`, `--oss`, `--local-provider`) continue to be appended; they are accepted by the `codex resume` subcommand identically to a fresh `codex` invocation (verified against `codex resume --help` on Codex 0.130).

**Files changed (source):**
- `src/core/frameworkSessionLaunch.ts` — codexCliBuilder restructured to insert `resume <id>` prefix when resuming; warning removed; JSDoc updated.

**Files changed (tests):**
- `tests/unit/frameworkSessionLaunch.test.ts` — 1 existing test updated, 3 new tests added.

**Files changed (release notes):**
- `upgrades/NEXT.md` — v0.28.115 release notes.
- `package.json` — version bump 0.28.114 → 0.28.115.

## Decision-point inventory

- **Argv shape when resuming**: `[binary, 'resume', id, '--model', ..., ...sandbox]` vs `[binary, '--model', ..., 'resume', id, ...sandbox]` — chose the former because `resume` is a subcommand-style invocation in Codex's CLI grammar; subcommands must come before option flags. Verified via `codex resume --help` accepting the same options.
- **Whether to pass `--model` when resuming** — yes. Codex's `resume` subcommand accepts `--model`; the original session's model might be retired or unavailable on the current auth path. Passing the configured model overrides safely (Codex documents this as supported).
- **Whether to validate the session id exists before launch** — no. Pre-validating would couple this helper to Codex's on-disk session layout (`~/.codex/sessions/YYYY/MM/DD/<uuid>.json`) and any change to that layout would break us. Instead, rely on Codex's own startup-time error reporting via the tmux pane + SessionManager's existing dead-pane respawn logic.
- **Whether to clear stale resume ids on detected failure** — out of scope here. PR #248 established the pattern for the route handler (`/route` cmd clears resume ids on framework swap); a separate "Codex resume id stale" detection path can reuse the same `_topicResumeMap.remove(topicId)` pattern. Tracked but not in this PR.

## 1. Over-block

None. The change makes resume actually work where it was previously silently disabled.

## 2. Under-block

None. The launch helper has no gating responsibility; it only constructs argv.

## 3. Level-of-abstraction fit

Correct. Change lives entirely in the framework-specific builder for codex-cli. `buildInteractiveLaunch` dispatch and the claude-code builder are untouched. The shared `InteractiveLaunchOptions` shape is unchanged — `resumeSessionId` was already part of the contract.

## 4. Signal vs authority

Not applicable — pure argv construction. No LLM gate, no policy decision.

## 5. Interactions

- **SessionManager.spawnInteractiveSession** — consumer of the launch spec. Receives the new argv shape transparently. No code change needed there.
- **TopicResumeMap** — already stores Codex session ids per topic; was previously written to but the resume path ignored them. Now actually consumed. No store change needed.
- **`/route` framework-swap path** — already clears resume ids on framework swap (PR #248); behavior unchanged.
- **Claude Code builder** — independent codepath, untouched.
- **codexCliBuilder used by buildHeadlessLaunch** — `buildHeadlessLaunch` uses a different builder path (`codex exec --json ...`); not affected by this change. Headless resume on Codex is a separate question.

## 6. External surfaces

- **Public API**: `InteractiveLaunchOptions.resumeSessionId` still accepts a string; semantics changed from "logged + ignored on codex" to "actually used."
- **CLI surface**: None directly.
- **Process surface (the actual side-effect)**: A Codex tmux session for a topic with a tracked resume id now spawns as `codex resume <uuid> --model ... --dangerously-bypass-approvals-and-sandbox` instead of `codex --model ... --dangerously-bypass-approvals-and-sandbox`. Process arguments visible in `ps`/tmux capture-pane change accordingly.

## 7. Rollback cost

Trivial. Revert the commit:
- argv returns to fresh-launch shape
- The warning re-appears
- Sessions silently start fresh again (the prior bug)

No persistent state migration, no data loss. Existing tracked Codex session ids in `TopicResumeMap` remain valid — Codex stores them indefinitely (within reason); they'll just stop being consumed.

## Tests

- Updated: `tests/unit/frameworkSessionLaunch.test.ts` — 1 test renamed and inverted (was "does NOT pass --resume because subcommand not supported", now "inserts `resume <id>` as a subcommand right after the binary"); 3 new tests added covering fresh launch is unchanged, sandbox flags preserved when resuming, `--oss --local-provider` preserved when resuming a local-model session.
- Total: 38/38 in `tests/unit/frameworkSessionLaunch.test.ts`. Typecheck (`tsc --noEmit`) clean.

## Evidence

The bug was reproducible by tracing the prior code path: any topic with a stored Codex session id that respawned would log:

```
[frameworkSessionLaunch] Codex resume requested (id=<uuid>) but codex CLI's "resume" is a subcommand, not a flag — starting fresh.
```

…and start a fresh session. The user's prior conversation context in that Codex session was therefore not restored even though the id was tracked.

After the fix, the same code path produces argv that begins with `[binary, 'resume', <uuid>]`. The shape was verified against `codex resume --help` on Codex 0.130, which documents `[SESSION_ID]` as a positional argument and accepts `--model`, `--sandbox`, `-a/--ask-for-approval`, `--dangerously-bypass-approvals-and-sandbox`, `--oss` as options.

Live end-to-end verification (a real Codex resume successfully recovering a real prior session's context) is queued as a follow-up that needs a Codex agent with a session that has built up context. The argv-shape correctness is verifiable via unit tests; the model's actual continuity-of-context depends on Codex's session store correctness, which is Codex's responsibility, not Instar's.
