# Side-Effects Review — Built-in Skill Install (bundled dev toolkit)

**Version / slug:** `builtin-skill-install-single-source`
**Date:** `2026-06-09`
**Author:** `echo`
**Second-pass reviewer:** `not required (3-round /spec-converge with 5 internal reviewers + gemini external already performed; see convergence report)`

## Summary of the change

Ships the developer-skill toolkit (`spec-converge`, `instar-dev`, `systematic-debugging`,
`smart-web-fetch`, `knowledge-base`, `instar-scheduler`, `agent-memory`, `agent-identity`,
`instar-identity`, `credential-leak-detector`) to every agent. These skills lived in the
git-tracked `skills/` dir but no code installed them and the dir was not in `package.json
files[]`, so they reached no agent. The fix: an authored `BUNDLED_DEV_SKILLS` allowlist + a
generic `installBundledDevSkills()` copy-loop in `init.ts` (install-if-missing, recursive for
subdirs), `skills/` added to `files[]` so the sources ship, the 3 port-hardcoded files rewritten
to `${INSTAR_PORT:-4040}`, and a ratchet test locking the "tracked-but-never-shipped" class shut.

This is the bounded, lowest-risk slice of the converged spec; the full single-source
consolidation (materialize the 16 inline skills, generator-validates-against-allowlist, files
glob) is the documented follow-on.

## Decision-point inventory

No new block/allow/route gate. The only decision is install-if-missing vs overwrite (chosen:
install-if-missing, preserving user customizations — verified by an idempotency test).

## 1. Over-block

None — the change adds files; it rejects no inputs. An agent that already has a same-named
custom skill keeps it untouched (install-if-missing), verified by the idempotency test.

## 2. Under-block

The ratchet test covers the 10 allowlisted skills (source-present, ships, materializes, no bare
port, idempotent) but does NOT yet assert `npm pack --dry-run` contents directly (it asserts
`skills` ∈ `files[]` as the ship-proxy). The full generator-validation ratchet is the documented
follow-on. No safety-relevant under-block.

## 3. Level-of-abstraction fit

Right layer: `installBuiltinSkills` is the existing install entry point; `installBundledDevSkills`
sits beside `installBuildSkill`/`installAutonomousSkill` (same proven bundled-copy pattern).
`skills/` stays the single source (referenced by SourceTreeGuard/crossModelReviewer) — relocating
would have broken those references.

## 4. Signal vs authority compliance

N/A — no new gate, no blocking authority, no LLM judgment. Pure deterministic file install.

## 5. Interactions

- Reuses the existing `migrateBuiltinSkills` → `installBuiltinSkills` path (PostUpdateMigrator:1776),
  so existing agents receive the skills on update with NO new migrator (Migration Parity mechanism #5).
- Preserves the `claudeEnabled` gate (codex-only agents still skip `.claude/skills/`).
- `installBundledDevSkills` resolves bundled source via `__dirname/../../skills` — correct in both
  the published package (dist/ + skills/ are siblings at package root) and vitest.

## 6. External surfaces

Adds 10 slash commands to every agent's `.claude/skills/`. `skills/` is now shipped in the npm
package (size: ~250KB of markdown). No new HTTP route, no message surface, no auth change.

## 7. Rollback cost

Low and clean. The change is additive + install-if-missing. Back-out = revert the commit; already
installed skill dirs are inert markdown (an agent simply has extra slash commands). No state
migration, no destructive op, no irreversibility.

## Conclusion

Low-risk, additive, fleet-wide install of the dev toolkit, behind a ratchet test, reusing the
established bundled-skill pattern and the existing migrator. Operator-approved (D6 = fleet-wide).

## Evidence pointers

- Converged spec: `docs/specs/BUILTIN-SKILL-INSTALL-SINGLE-SOURCE.md` (review-convergence + approved).
- Convergence report (3 rounds, 4 bugs caught): `docs/specs/reports/builtin-skill-install-single-source-convergence.md`.
- Ratchet test: `tests/unit/builtin-dev-skills.test.ts` (6 assertions, green).
- `tsc --noEmit` clean; CI push suite green except 1 unrelated environmental E2E flake (LLM-unavailable in local run).
