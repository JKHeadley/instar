# Side-effects review — Phase 6 (deprecation cycle start)

## What changed

`JobLoader.loadJobs` now runs a deprecation audit (new `auditLegacyPromptDeprecation` helper) after the existing merge step. The audit emits a single boot-time warning per affected slug when:

- A legacy `jobs.json` entry has `execute.type: 'prompt'` AND
- The same slug also appears as an agentmd default (in `.instar/jobs/schedule/`) with `origin: 'instar'` AND
- `.instar/jobs/.migration-complete.json` is absent (operator hasn't confirmed migration).

The legacy entry is structurally inert in this case (already shadowed by the per-slug manifest), but its presence indicates the operator hasn't run "Confirm migration complete" via Dashboard yet. The warning is the operator-facing nudge that the legacy entry will be removed two releases after Phase 4 Dashboard ships.

## Side-effects review

### 1. Over-block / under-block

- **Over-block:** the warning is silenced once `.migration-complete.json` exists, so a confirmed-migrated agent does NOT emit it. Also silenced for slugs that don't have an agentmd shadow (those are genuine user jobs).
- **Under-block:** the warning is loud but non-blocking — boot proceeds normally. The actual removal happens in a future release when the spec's two-release deprecation window expires.

### 2. Level-of-abstraction fit

Trivial pure-function helper inside `JobLoader.ts`. Reads only legacy + agentmd arrays + checks one file. No state, no events, no side effects beyond `console.warn`.

### 3. Signal-vs-authority compliance

The warning is a signal ("legacy entries detected"). The authority that REMOVES legacy entries is the release-cut gate (the spec's two-release timer). This PR ships the signal, NOT the removal.

### 4. Interactions

- **Phase 5 auto-migrate** — after the auto-migrate runs, the slugs appear in BOTH `jobs.json` (legacy) and `.instar/jobs/schedule/` (migrated). The warning fires for these UNTIL operator confirms via Dashboard.
- **Phase 4 Dashboard** — provides the "Confirm migration complete" button that writes `.migration-complete.json`, silencing the warning.
- **Release-cut gate** — already refuses to delete `jobs.json` without `.migration-complete.json`. The deprecation warning is the operator-facing prompt that closes the loop.

### 5. Rollback cost

Revert one function. Zero on-disk state. The warning is purely advisory.

### 6. Phase 6 deprecation window

Per spec §Rollout step 6: "execute.type: 'prompt' for instar default jobs deprecated; removed two releases later." Phase 6 START is this PR; Phase 6 REMOVAL is two minor releases after Phase 4 Dashboard ships. The removal will be a separate PR that:
- Adds a gate to `JobLoader.loadLegacyJobsJson` that hard-errors on `execute.type: 'prompt'` for slugs in the shipped agentmd defaults.
- Bumps the deprecation warning's URL to point at the removal release notes.

## Test coverage

`tests/unit/scheduler/JobLoader.deprecation.test.ts` — 4 cases:

1. Emits warning when legacy prompt shadows agentmd default
2. Does NOT emit when `.migration-complete.json` exists
3. Does NOT emit for user-slug entries
4. Does NOT emit for legacy script entries

All 4 pass locally.
