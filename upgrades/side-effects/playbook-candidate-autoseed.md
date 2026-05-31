# Side-Effects Review — Playbook none→candidate auto-seed (§13.6)

**Version / slug:** `playbook-candidate-autoseed`
**Date:** 2026-05-31
**Author:** echo

## Summary of the change

`FrameworkIssueLedger` gains the §13.6 `none→candidate` auto-suggestion that was
specified but never implemented, so the onboarding playbook
(`GET /framework-issues/playbook?targetFramework=X`) actually populates for the
next framework instead of always returning `[]`.

**Files changed (source):**
- `src/monitoring/FrameworkIssueLedger.ts`:
  - `updateIssue()` — when a generalizable issue (bucket ∈ {framework-limitation,
    instar-integration-gap}) transitions to a terminal-resolved status
    (`fixed` | `wont-fix`) while `playbook_status === 'none'`, bump it to
    `'candidate'` in the same transaction. Skipped if the caller set
    `playbookStatus` explicitly; never downgrades a non-`none` row.
  - new `backfillPlaybookCandidates()` — idempotent, self-limiting `UPDATE` that
    seeds already-terminal generalizable rows still stuck at `'none'`.
  - constructor calls the backfill once (after DDL migrations), wrapped so a
    failure can never block construction.

**Files changed (tests):**
- `tests/unit/FrameworkIssueLedger.test.ts` — +10 tests (auto-suggest matrix,
  backfill eligibility/idempotency/no-downgrade, constructor self-seed on a
  reopened on-disk db).
- `tests/integration/framework-issues-routes.test.ts` — +1 end-to-end test
  (`POST observe status:fixed` → `GET playbook` contains it, no manual promote).

## Blast radius

Confined to `FrameworkIssueLedger`. The ledger is read-mostly mentor-system infra;
it never gates a job, blocks a message, or constrains a session. The playbook is
served only via `GET /framework-issues/playbook` and consulted by Stage A when a
NEW framework is onboarded — there is no live consumer for codex itself (the
playbook for X excludes X's own issues). So the immediate live effect is: the
playbook for cursor/aider/gemini changes from empty to 11 seeded codex candidates;
nothing in the running codex/echo flow changes behavior.

## Behavior delta

| Scenario | Before | After |
|---|---|---|
| generalizable issue → `fixed` / `wont-fix` | stays `playbook_status='none'` | auto-bumps to `'candidate'` |
| generalizable issue → `open` / `spec'd` | `'none'` | `'none'` (unchanged — not terminal) |
| `generic-agent-mistake` → `fixed` | `'none'` | `'none'` (unchanged — not generalizable) |
| caller passes explicit `playbookStatus` | honored | honored (auto-bump skipped) |
| issue already `extracted` → `fixed` | `'extracted'` | `'extracted'` (never downgraded) |
| existing terminal generalizable rows at `'none'` | invisible to playbook forever | seeded to `'candidate'` on next ledger construction |
| `GET /playbook?targetFramework=cursor` (live: 11 eligible codex lessons) | `[]` | 11 candidates, impact-ranked |
| `candidate → extracted` promotion | requires non-Echo attestation | requires non-Echo attestation (UNCHANGED) |

## Risks considered

- **Over-eager candidates?** Auto-seeding populates only the *candidate* tier
  (proposed lessons). The `candidate→extracted` step — the one that makes a lesson
  canonical — still requires a non-Echo attestation (`promotePlaybook` guard
  untouched). So an over-eager candidate is a proposal a human still curates, not a
  canonized lesson. This is the intended §13.6 behavior.
- **Self-canonization bypass?** No. The auto-bump uses the internal write path
  (the "Stage B auto-suggest" §13.6 explicitly permits any actor to automate), not
  `promotePlaybook`, and stops at `candidate`. Echo still cannot reach `extracted`
  on its own lessons.
- **Construction-time mutation?** The constructor already runs DDL migrations; a
  one-time idempotent data backfill is consistent with "bring the DB to current
  shape." It is try/wrapped so it can never block ledger construction, and
  self-limiting so it is a no-op after the first run.
- **Existing tests / other consumers?** No other test or code path references
  `playbookStatus` after a terminal transition (verified by grep). All 192
  ledger/mentor/route/E2E tests pass.
- **No new dependencies, routes, network, or persisted config.**

## Migration parity

No `PostUpdateMigrator` entry required. The change is runtime server code, not an
agent-installed file (no hook / `.instar/config.json` default / CLAUDE.md template
section / skill changed). Existing ledgers across the fleet pick up the data
seeding via the constructor backfill on their next server boot after this code
deploys — which is the migration path for ledger *data*. The CLAUDE.md template
already documents the playbook route; its description ("generalizable lessons from
PRIOR frameworks") is now simply accurate, so no Agent-Awareness template change is
needed.

## Test evidence

`npx vitest run` on the ledger unit, routes integration, ledger E2E lifecycle, and
all mentor suites → 192 passed. `npm run lint` (tsc --noEmit + the destructive/LLM/
URL-log/codex-drift linters) clean.
