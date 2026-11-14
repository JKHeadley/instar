# Side-Effects Review — stop registering the event reporter on Claude Code's worktree events

**Version / slug:** `worktree-reporter-hook-removal`
**Date:** `2026-10-27`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (settings migration touching every agent)`

## Summary of the change

Tier 1. Instar registered `hook-event-reporter.js` on every Claude Code event it reports, including `WorktreeCreate` and `WorktreeRemove`. In Claude Code a hook on those two events is not an observer: it **replaces** git's own worktree handling and must print the worktree path. The reporter prints nothing, so on every instar agent `claude --worktree` and Claude Code's worktree-isolated subagents fail with "WorktreeCreate hook failed: hook succeeded but returned no worktree path".

Reproduced 2026-10-27 on Claude Code 2.1.310 in a throwaway repo: with a silent `WorktreeCreate` command hook, `claude -p --worktree probe-a` failed with exactly that error and created no worktree; with the hook removed, `--worktree probe-b` succeeded and the worktree appeared in `git worktree list`.

The change removes the two events from `HOOK_EVENT_TEMPLATES` (new agents) and adds `PostUpdateMigrator.removeWorktreeReporterHooks()` to `migrateSettings()` (existing agents). It runs after `migrateHttpHooksToCommandHooks` and `ensureHttpHooksExist`, because the former rewrites a reporter HTTP hook on any event, including these, into a command hook. It removes only reporter entries (a command containing `hook-event-reporter.js`, or an HTTP hook whose URL contains `/hooks/events`); any other hook an operator put on those events is kept, and an event left empty is deleted. Idempotent.

Nothing consumed these events: the reporter read `input.hook_event` (Claude Code sends `hook_event_name`), so they were stored as `Unknown`, and no code subscribes to either name.

## Decision-point inventory

None (a settings correction; no gate).

## 1. Over-block
None.

## 2. Under-block
An operator-written hook on these events is kept on purpose; if it prints no path it will still break worktrees, which is the operator's own configuration.

## 3. Level-of-abstraction fit
The template is the source for new agents; the settings migration is the documented path for existing ones (Migration Parity).

## 4. Signal vs authority compliance
No authority involved (`docs/signal-vs-authority.md` reviewed).

## 5. Interactions
Ordering after the two existing http-hook migrations is required and tested end-to-end through `migrateSettings`. `ensureHttpHooksExist` builds from the template, so it no longer re-adds the entries.

## 6. External surfaces
Claude Code worktree creation starts working in instar sessions. The hook-events store loses nothing it ever recorded by name.

## 7. Multi-machine posture
Per-machine `.claude/settings.json`, migrated on each machine's update; machine-local by design.

## 8. Rollback cost
Revert. A revert restores the entries for new agents only (via the template at `init`); existing agents keep them removed, because `ensureHttpHooksExist` returns early whenever any reporter hook exists on any event. Re-adding them to existing agents would need its own migration, which would re-break Claude Code worktree creation.

## Second-pass review

**Reviewer:** independent second-pass subagent (Claude, read-only review of `git diff origin/main` plus the new test), 2026-10-27

**Verdict:** Concern raised: `tests/unit/hook-installation.test.ts` ("event reporter hooks exist for all required events", line ~452) still lists `WorktreeCreate` and `WorktreeRemove` as required reporter events and now fails ("Missing hook entries for event \"WorktreeCreate\""). Remove those two names from `requiredEvents` (and ideally assert they are absent) before this ships. Also correct section 8: a revert would NOT re-add the entries on existing agents, because `ensureHttpHooksExist` returns early whenever any reporter hook exists on any event; only new agents (init via the template) would get them back.

Evidence:
- Consumers: no code in `src` subscribes to `WorktreeCreate`/`WorktreeRemove` events. Only mentions are comments (`routes.ts:5632`, `providers/primitives/observability/hookEventReceiver.ts:11`), an optional `worktree_path` type field in `HookEventReceiver.ts`, and a doc comment in `AgentWorktreeDetector.ts` (which scans git, not hook events). The reporter sends `input.hook_event` (PostUpdateMigrator.ts:7197, init.ts:4631), so these events were stored as `Unknown` anyway. No dashboard reference.
- Template length/list: `HTTP_HOOK_TEMPLATES.length` is used only in an upgrade message string (PostUpdateMigrator.ts:6810). init.ts and ensureHttpHooksExist both build from `buildHttpHookSettings`, so neither can add the worktree events any more. No "N events" count found in src/docs/tests.
- Ordering: removal runs after `migrateHttpHooksToCommandHooks` (which would otherwise rewrite an HTTP reporter on these events into a command hook) and after `ensureHttpHooksExist` (template-built, and early-returns when any reporter exists). Correct.
- Predicate: matches only a command containing `hook-event-reporter.js` or an `http` hook whose URL contains `/hooks/events`; nested `hooks` arrays are filtered per-hook so a mixed entry keeps the operator's hook; flat non-reporter entries, non-object entries and non-array event values are kept untouched; empty events are deleted. Scoped to the two events only. Acceptable residual: an operator's own script named `hook-event-reporter.js` on these events would be removed (unlikely, and such a hook would print no path).
- Other installers: `installCodexHooks.ts` registers only Stop/PostToolUse/SessionStart/UserPromptSubmit; no other installer registers the worktree events.
- Tests run (TMPDIR=/home/echo/echo-test-tmp): http-hook-templates, the new PostUpdateMigrator-worktreeReporterHooks, http-to-command-hook-migration, migration-parity, hook-event-receiver all pass; hook-installation has 1 failure (above). 78/79 passed.

### Resolution of the concern (author)

- `tests/unit/hook-installation.test.ts`: the two worktree events removed from `requiredEvents`, and the test now asserts the reporter is absent from both.
- Section 8 corrected: a revert restores the entries for new agents only; existing agents keep them removed.

**Verdict (after resolution):** Concur with the review

- Re-checked: `hook-installation.test.ts` no longer requires WorktreeCreate/WorktreeRemove and asserts the reporter is absent from both; section 8 now states a revert restores entries for new agents only. `tests/unit/hook-installation.test.ts` run independently: 16/16 pass.
