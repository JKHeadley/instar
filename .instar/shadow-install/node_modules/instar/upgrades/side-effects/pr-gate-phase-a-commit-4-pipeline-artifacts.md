# Side-Effects Review — migratePrPipelineArtifacts + shipped pipeline artifacts

**Version / slug:** `pr-gate-phase-a-commit-4-pipeline-artifacts`
**Date:** `2026-04-17`
**Author:** `Echo (instar-developing agent)`
**Second-pass reviewer:** `not required — no block/allow surface, no session lifecycle, no gate/sentinel/watchdog`

## Summary of the change

Adds `migratePrPipelineArtifacts()` to `PostUpdateMigrator` and ships four pipeline-artifact templates as module-level constants with content-hash verification. On next `npm update`, every migrated agent receives:

- `scripts/pr-gate/eligibility-schema.sql` — SQLite schema (live / archive / revoked_tokens tables + indexes)
- `.claude/skills/fork-and-fix/scripts/push-gate.sh` (mode 0o755) — Layer 2 push-gate script

And agents in the `JKHeadley/instar` source repo *additionally* receive:

- `.github/workflows/instar-pr-gate.yml` — Layer 3 GitHub Action
- `docs/pr-gate-setup.md` — branch-protection runbook

Echo-source detection is two-signal: normalized git remote (`origin` OR `upstream`) pointing at `github.com/JKHeadley/instar` AND `package.json.name === "instar"`. Both must match — the package-name check prevents writing to forks whose remotes happen to match but whose repo identity doesn't.

Each shipped file is gated by `sha256(content) === expectedHash`. A post-publish tamper that modifies only the content string (without updating the matching `*_SHA256` constant) halts migration for that file with a `[PR-GATE CRITICAL]` error logged to stderr and appended to `result.errors`.

Files touched:
- `src/data/pr-gate-artifacts.ts` — new file; four content constants + four SHA256 constants; self-verification tests assert consistency.
- `src/core/PostUpdateMigrator.ts` — imports from pr-gate-artifacts; adds `migratePrPipelineArtifacts()`, `writeShippedArtifact()`, `isInstarSourceRepo()`; inserts the step into `migrate()` immediately after `migrateConfig()` per the spec's insertion-order table.
- `tests/unit/PostUpdateMigrator-prPipelineArtifacts.test.ts` — new file; 14 tests covering hash self-consistency, always-ship files, Echo-repo gating (both signals), upstream-fallback, package-name rejection, missing package.json, idempotency, and drift-rewrite.

Phase A landing semantic: endpoints referenced by these artifacts are inert. `prGate.phase='off'` (commit 8) returns 404 for `/pr-gate/*`; `push-gate.sh` treats 404 as "gate disabled, allow push"; the GitHub Action treats 404 as "pending, no block." The artifacts ship now so commits can reference them in later phases without mid-rollout file additions.

## Decision-point inventory

- **`isInstarSourceRepo()`** — structural detection (not judgment): parses `git remote get-url`, normalizes, regex-matches `github.com/jkheadley/instar`, reads `package.json.name`. Outcomes deterministic from the two inputs. No LLM, no heuristic, no block/allow on user content. Modifies whether two FILES get written; does not gate any other behavior.
- **`writeShippedArtifact()`** — content-hash verification is a hard-invariant safety guard on an irreversible action (writing a poisoned template into every agent's project). Explicitly in the `docs/signal-vs-authority.md` carve-out bullet 2 (safety guards on irreversible actions). No judgment surface — pure structural check.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

`isInstarSourceRepo()` false-negatives would silently skip writing the workflow + setup doc. Concrete cases:

- An instar-source machine whose `origin` is a bare path / SSH host with unusual formatting that the normalizer fails to match. Tested cases pass: `https://github.com/JKHeadley/instar.git`, `https://github.com/JKHeadley/instar`, `git@github.com:JKHeadley/instar.git`. A custom host alias (e.g., `git@work-github:JKHeadley/instar.git`) would miss. Mitigation: the upstream fallback catches fork workflows; Justin can also `git remote add upstream https://github.com/JKHeadley/instar.git` if needed.
- A fresh clone with `package.json.name` renamed locally. Intentional over-block: a renamed package is NOT the instar source repo for the purpose of shipping a `.github/workflows/instar-pr-gate.yml` file that references `JKHeadley/instar`-specific secrets.
- A non-git directory that happens to be named `instar`. Correctly rejected (no origin remote → false).

`writeShippedArtifact()` over-block surface: only refuses to write when content hash mismatches its declared constant. If the declared constant is wrong in the source (e.g., Echo forgot to update the hash after editing the template), every agent's migration errors on that file. Mitigation: the 4-case self-consistency test in `PostUpdateMigrator-prPipelineArtifacts.test.ts` runs under `vitest` and the pre-commit hook type-checks, so a mismatched hash is caught at commit time, not runtime.

---

## 2. Under-block

**What failure modes does this still miss?**

- **Tampering both sides simultaneously.** If an attacker patches the published JS to replace both the content constant AND its matching hash, the verification passes. Realistic attack vector: supply-chain compromise of the npm registry or the build pipeline. Mitigation: npm package signing and provenance attestation (not in scope for this commit).
- **User file-system tamper between install and migrate.** An attacker with write access to the installed npm package's `dist/` could swap the `pr-gate-artifacts.js` file entirely. No defense at the migrator layer; npm package integrity is an operating-system / supply-chain concern.
- **Echo-repo detection via social engineering.** An agent running on a non-instar project could have its user rename `package.json.name` to `"instar"` and add `https://github.com/JKHeadley/instar` as `upstream` to force workflow/doc shipping. Only user-harm: extra files drop in that project, not cross-contamination. No security impact.
- **Race on concurrent migrations.** Two migrations running against the same project directory could both pass the `fs.existsSync` + content-equality check if scheduled tightly. PostUpdateMigrator uses a single-run lock elsewhere; this step doesn't introduce new concurrent-write surface beyond the existing `fs.writeFileSync` (last-write-wins, content-deterministic, idempotent).

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. `PostUpdateMigrator` is the existing location for shipped-file migrations (`migrateScripts`, `migrateHooks`, etc.). Adding `migratePrPipelineArtifacts` as another migrator step follows the established pattern. Separating the content constants into `src/data/pr-gate-artifacts.ts` mirrors the existing `src/data/http-hook-templates.ts` — the `data/` module keeps the migrator lean.

The content-hash verification lives at the migrator boundary — the exact moment content transitions from the published JS into the user's filesystem. Any higher would miss post-publish tamper; any lower (e.g., fs-level integrity checks) doesn't exist in Node.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no judgment-call block/allow surface. `isInstarSourceRepo()` answers a structural question (is this directory the JKHeadley/instar source repo based on two objective signals). `writeShippedArtifact()` answers a structural question (does sha256(content) equal the declared constant). Both are hard-invariant safety guards, explicitly carved out in signal-vs-authority.md section "When this principle does NOT apply" bullets 1 (hard-invariant validation) and 2 (safety guards on irreversible actions).

Narrative: the principle applies to judgment decisions about *meaning* or *intent*. "Does sha256 match" and "does this remote string match this regex" are structural facts. The cost of false pass is asymmetric (shipping a poisoned template to every agent vs. shipping a workflow to a non-instar project), favoring brittle structural checks.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** new `migratePrPipelineArtifacts` runs after `migrateConfig` and before `migrateGitignore` (per spec's insertion-order table). No shadow on either — `migrateConfig` sets up config keys; `migrateGitignore` adds/removes `.gitignore` entries. Independent concerns.
- **Double-fire:** none. Migration runs once per `npm update`. Idempotent on re-run.
- **Races:** `fs.writeFileSync` is atomic at the POSIX level; concurrent migrations would see last-write-wins on identical content. No data loss.
- **Feedback loops:** none.
- **Interaction with `migrateGitignore`** (commit 3): unrelated paths. Commit 3 adds `.instar/secrets/pr-gate/` to `.gitignore`; this commit writes to `scripts/pr-gate/`, `.claude/skills/fork-and-fix/scripts/`, `.github/workflows/`, and `docs/` — none under `.instar/secrets/`. No interaction.
- **Interaction with `BackupManager.BLOCKED_PATH_PREFIXES`** (commit 1): unrelated. None of the shipped files are written under `.instar/secrets/`. Commits 1+3 protect the secrets dir; this commit ships the pipeline scaffolding elsewhere.
- **Interaction with `installBuiltinSkills`:** the push-gate.sh is a SCRIPT inside an existing skill directory (`.claude/skills/fork-and-fix/scripts/`). It does not register a new skill; the existing `fork-and-fix` skill's presence is a precondition (created by `installBuiltinSkills` on init). If fork-and-fix is not installed, `fs.mkdirSync(..., { recursive: true })` creates the directory — a no-op for later skill installation.
- **Interaction with GitHub Actions CI:** on first migration of a JKHeadley/instar checkout, `.github/workflows/instar-pr-gate.yml` appears. It triggers on `pull_request`. Phase A logic: the workflow queries `/pr-gate/status`; Echo server returns 404 (phase=off → endpoint unregistered); workflow exits with status=pending. Reporting-only; no status-check block. Phase D flips branch protection per the runbook.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** none. Migrator runs per-agent.
- **Users of the install base:**
    - Non-instar-source agents: two new files (`scripts/pr-gate/eligibility-schema.sql`, `.claude/skills/fork-and-fix/scripts/push-gate.sh`) appear on first migration. Migration log includes two `upgraded` entries. Subsequent migrations skip (content-equality check).
    - Instar-source agents: four new files; log includes four entries.
- **GitHub:** first PR opened after the workflow lands triggers `instar-pr-gate` check. Phase A behavior: check reports `pending` (expected). No status-check block (branch protection not yet required per Phase D checklist).
- **External systems:** none on Phase A landing. Future phases will call GitHub API from the workflow (Layer 3).
- **Persistent state:** four files on disk, versioned by their `*_SHA256` constants. No database state change.
- **Git history:** the new files become part of the repo on first commit (user-initiated). The workflow + setup doc are intentionally tracked in `JKHeadley/instar` and show in `git status` as untracked after migration — Echo commits them as part of the Phase A landing PR.
- **Timing:** the migration step is O(4) file writes + 4 hash computations on small strings (<10KB each). Sub-millisecond.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code revert. Specifics:

- Migrator reverts to prior `migrate()` sequence without `migratePrPipelineArtifacts`.
- `src/data/pr-gate-artifacts.ts` deleted.
- Tests deleted.
- Already-migrated agents retain the four files on disk. Harmless:
    - `scripts/pr-gate/eligibility-schema.sql` — unused if no `/pr-gate/*` endpoint is active.
    - `push-gate.sh` — only invoked by fork-and-fix; behaves as pass-through on 404 (phase=off).
    - `.github/workflows/instar-pr-gate.yml` — runs on PR, queries 404, reports pending. Does not block merges (branch protection not required).
    - `docs/pr-gate-setup.md` — inert doc.
- Users who want a clean revert can `rm` the four files; future (post-revert) migrations will not re-install them.

Estimated rollback effort: one commit revert, one patch release. No migration cleanup, no user action required, no data loss.

---

## Conclusion

Ships the four pipeline-artifact templates with content-hash verification, an Echo-repo gate, and idempotent content-drift rewrites. 14 new tests cover the full behavioral surface. Adjacent migrator tests (33) unaffected. tsc clean. Second-pass review not required per `/instar-dev` Phase 5 criteria (no block/allow, no session lifecycle, no gate).

Clear to ship as Phase A commit 4 of 8.

---

## Second-pass review (if required)

Not required.

---

## Evidence pointers

- Source: `src/data/pr-gate-artifacts.ts` — 4 content constants + 4 sha256 constants + detailed docstring.
- Source: `src/core/PostUpdateMigrator.ts` — imports from pr-gate-artifacts; `migratePrPipelineArtifacts`, `writeShippedArtifact`, `isInstarSourceRepo` methods added; `migrate()` sequence extended.
- Tests: `tests/unit/PostUpdateMigrator-prPipelineArtifacts.test.ts` — 14 tests across 5 describe blocks.
- Test run: `npx vitest run tests/unit/PostUpdateMigrator-prPipelineArtifacts.test.ts` — 14 pass, 762ms.
- Regression sweep: `npx vitest run tests/unit/PostUpdateMigrator-*.test.ts` (4 suites) — 33 pass, unaffected.
- Type check: `npx tsc --noEmit` — clean.
