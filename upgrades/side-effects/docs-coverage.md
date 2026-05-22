# Side-effects review — docs-coverage

Spec: `docs/specs/docs-coverage.md`
ELI16: `docs/specs/docs-coverage.eli16.md`

## Surface map

| Change | File(s) | Type |
|---|---|---|
| New script | `scripts/docs-coverage.mjs` | Pure-Node CLI, no dependencies, runnable from any cwd containing `src/` |
| New CI job | `.github/workflows/ci.yml` (added `docs-coverage` job) | Runs the script in `--check` mode, uploads report as artifact |
| New tests | `tests/unit/scripts/docs-coverage.test.ts` | 7 unit tests against a mock repo |
| gitignore | `.gitignore` (added `.instar/docs-coverage.{json,md}`) | Generated artifacts excluded from commits |

No production code touched. No agent behavior changes. No state migrations.

## Over-block analysis

**Could the CI check block a legitimate PR?**

Yes, in three scenarios:

1. **A PR introduces a new capability without a doc mention.** This is the desired behavior — the gate exists to require doc updates alongside feature work. Authors fix by adding a mention in the relevant doc.
2. **A PR removes a documented capability and the floor drops below threshold.** Calibrated initial floors are set 2–3 percentage points below current coverage so normal churn doesn't trip them. A capability removal that drops 5+ percentage points in a single category would trip — and arguably should, because removing a feature is itself a doc-update event.
3. **A PR adds many capabilities in a category that's already at floor.** A PR adding 10 new routes when the route category is at 13% would drop the category to ~12.5% and fail. The author would have to add doc mentions for at least some of the new routes. Again, desired behavior.

**Escape hatches:**
- Per-category env overrides allow temporarily relaxing a floor for a one-off PR.
- The check can be removed from the workflow if it ever creates more friction than value (the spec lists this as a rollback path).

## Under-block analysis

**What does the check NOT catch?**

- **Stale doc claims.** A capability can be mentioned with completely wrong information. The script only checks for the substring, not for semantic correctness. This is a genuine limitation — but it's a limitation any automated tool faces, and the manual audit work surfaced these specifically (e.g. configuration.md "all top-level" claim). The agent-driven audit and this script are complementary, not substitutes.
- **Renamed capabilities.** If a capability is renamed and the doc still references the old name, the doc's mention won't match. This produces a false positive (capability looks undocumented) but the right fix is renaming the doc reference anyway.
- **Conceptual coverage.** A doc page can describe a feature in detail without ever using the canonical class name or route path. The script would miss this. This is a deliberate trade-off — we'd rather flag a documented-in-spirit capability as missing than under-detect coverage gaps.
- **Internal capabilities.** The script doesn't enumerate `utils/`, `data/`, `types/` — these are correctly excluded as not-user-facing. If we ever move a user-facing thing into one of those directories, the script wouldn't catch the move.

## Level-of-abstraction fit

The script lives at the right layer:

- Not inside the `pre-commit` gate — that's for per-commit author concerns, and coverage is a PR-level concern.
- Not inside individual feature workflows — that would scatter the logic across the codebase.
- In CI as a dedicated job — runs in parallel with other checks, easy to find when it fails, easy to skip when investigating an unrelated failure.

The script's enumeration logic is centralized rather than duplicated: every capability type uses the same coverage-scoring function. Adding a new capability type (say, MCP tools or runbooks) is one new `enumerate*()` function, not a separate script.

## Signal-vs-authority compliance

The script is **authoritative on enumeration** (it walks the source tree, no ambiguity) but **a signal on coverage** (substring matching is approximate; a single mention scores half, two or more score full). The signal-vs-authority separation is respected: the script can refuse a push but it doesn't claim to be the final word on whether docs are good — it just claims to know whether they exist. Quality remains the author's responsibility.

The initial floors are calibrated loose so the script doesn't usurp judgment by being too strict on day one. As the doc-update PRs land, the floors ratchet up, and the script's signal becomes louder. This is the right progression.

## Interactions with existing systems

- **Pre-commit hooks.** No interaction — the script runs in CI, not pre-commit.
- **pre-push gate** (`scripts/pre-push-gate.js`). No interaction — the script doesn't touch upgrade-notes validation.
- **Pre-push fixture guard** (`scripts/pre-push-fixture-guard.mjs`). No interaction — different concern.
- **PostUpdateMigrator.** No interaction — the script doesn't ship to agents, only runs at CI time.
- **Working-tree integrity check** in CI. No interaction — that check runs after tests; this one runs as its own job in parallel.
- **Future weekly audit job (Phase 5 of this sprint).** The job will execute this script and surface the report via Telegram. The JSON output is the contract.
- **lint-no-direct-destructive.js.** No interaction — the script doesn't perform git or fs writes outside `.instar/`.

## Rollback cost

Trivially reversible. Remove three files (script, test, the workflow job block) plus the two `.gitignore` lines. No data migration, no schema change, no agent-state mutation. Reverting leaves the repo at exactly its pre-change state.

## Risk summary

- **Low risk of regression.** Pure-Node script, deterministic enumeration, no side effects outside writing two files under `.instar/`. Cannot break any production code path.
- **Moderate friction risk.** Authors who add features without docs will hit the gate. This is the intended behavior, but it will surprise people the first few times. Mitigation: the spec + ELI16 are checked in alongside the script, so the failure message has a clear pointer to "what's going on and how to fix it."
- **No risk of data loss.** The script reads only; the only writes are the two artifact files in `.instar/`, both git-ignored.

## Verification done before commit

- Script enumerates 880 capabilities across six types on current main.
- `--check` exits 0 with floors calibrated to current state.
- `--check` exits 1 with a high floor (verified in test `--check fails when any category is below floor`).
- All seven unit tests pass.
- `npm run lint` passes (TypeScript, destructive-ops lint, LLM-HTTP lint, Codex Rule 1 drift).
- The mock-repo test mocks the same six capability types and verifies coverage classification.
- Spec carries `approved: true` per direct principal authorization in Telegram topic 11235 (the autonomous-mode instruction was "Complete option 3", referring to the documentation-coverage script described as option 3 in the audit report shared minutes earlier).
