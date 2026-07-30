# Side-Effects Review — Commit the pnpm dependency build allowlist

**Version / slug:** `pnpm-build-allowlist`
**Date:** `2026-07-30`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `not required — no decision-point surface (see inventory)`

## Summary of the change

`pnpm install` exits non-zero on a fresh checkout of current `main` (reproduced on v1.3.1071 / pnpm 11.5.1: `exit 1`, `ERR_PNPM_IGNORED_BUILDS`, 13 ignored build scripts) because pnpm >= 11 refuses to run a dependency's install script without an explicit allowlist, and no allowlist was committed. This adds `pnpm-workspace.yaml` recording an explicit boolean per package — 9 `true` (native binding compiled or platform binary downloaded), 3 `false` (engine check / printed notice / no artifact this project needs) — plus `tests/unit/pnpm-build-allowlist.test.ts` as a regression guard. Files touched: `pnpm-workspace.yaml` (new), `tests/unit/pnpm-build-allowlist.test.ts` (new), `docs/specs/pnpm-build-allowlist.eli16.md` (new), `upgrades/next/pnpm-build-allowlist.md` (new), this artifact.

Verified: install `exit 0` (native builds genuinely ran — ssh2 compiled its optional crypto binding), idempotent re-run `exit 0` in 152ms, `pnpm build` `exit 0`.

## Decision-point inventory

This change adds **no** instar decision point. It does not gate information flow, block an action, filter a message, or constrain agent behavior. It is build-time dependency configuration consumed by pnpm, plus a test.

- `pnpm-workspace.yaml` → `allowBuilds` — **add** — build-time allowlist read by pnpm at install; no runtime surface, no instar code reads it.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface over inputs — over-block not applicable in the messaging/gating sense.

The nearest analogue is the three `false` entries, which decline a build that *could* have run. Assessed individually against what each script actually does: `baileys` (`preinstall: node ./engine-requirements.js`) only asserts a minimum Node version; `es5-ext` (`postinstall: node -e "try{require('./_postinstall')}..."`) prints a notice and is written to swallow its own failure; `protobufjs` (`postinstall: node scripts/postinstall`) produces nothing this project consumes. If any of those judgements is wrong the symptom is a runtime failure in that specific package, and the remedy is a one-line flip to `true` with no migration. That is the residual risk and it is small and cheaply reversible.

---

## 2. Under-block

**What failure modes does this still miss?**

- **The real question is untouched.** The documented package manager (CLAUDE.md Quick Reference says `pnpm`) is not the one CI validates (`ci.yml` runs `npm ci` with `cache: npm` across all six jobs), and both `package-lock.json` and `pnpm-lock.yaml` are committed and can drift. This change makes the documented path *work*; it does not make it *tested*. A green pipeline still proves nothing about the pnpm route. <!-- tracked: ACT-1613 -->
- **No version pin.** `packageManager` is deliberately not added. Adding it would make corepack authoritative and could change behavior for the `npm ci` jobs that CI depends on — a real regression risk for zero benefit to this fix. So a contributor on a pnpm older than 11 sees different (though not failing) behavior. <!-- tracked: ACT-1613 -->
- **New dependencies won't be caught by the guard test.** A dependency added later with its own install script will re-trigger `ERR_PNPM_IGNORED_BUILDS` for whoever installs with pnpm. The guard asserts the current nine are present; it cannot know about a package that does not exist yet. Detecting that properly needs the pnpm path to run in CI, which is the item above.

---

## 3. Level-of-abstraction fit

Correct layer. The allowlist is pnpm's own configuration mechanism at its documented location, not an instar abstraction over it.

One placement finding worth recording: the same allowlist expressed as `pnpm.onlyBuiltDependencies` in `package.json` is **silently ignored** by pnpm 11.5.1 — tried it directly, and the install still exited 1 with all 13 scripts still reported ignored. Dead config that reads as authoritative is worse than no config, so the guard test asserts `package.json` does **not** carry that field. This is the sort of thing that would otherwise be "fixed" by a later tidy-up and silently regress.

---

## 4. Signal vs authority compliance

Not applicable — no authority and no signal. Per `docs/signal-vs-authority.md` the principle governs decision points that gate agent behavior; this is build configuration with no brittle logic and no blocking power over anything at runtime.

The one test added is an assertion over a committed file, which holds no authority over agent behavior either.

---

## 5. Interactions

- **npm is unaffected.** `pnpm-workspace.yaml` is a pnpm-specific filename; npm does not read it. CI's `npm ci` path is byte-for-byte unchanged.
- **No shadowing or double-firing.** Nothing else in the repo reads `allowBuilds`; no other check governs dependency build approval.
- **Adjacent postinstall preserved.** The repo's own root `postinstall` (`fix-better-sqlite3`) still runs and reported the native binary working. `prepare$ husky` still runs. Neither is affected by the dependency-level allowlist.
- **Pre-existing untracked placeholder.** A generated `pnpm-workspace.yaml` full of `set this to true or false` placeholders existed untracked in the local checkout. It was moved aside (preserved, not deleted) to reproduce true fresh-checkout state before measuring. Anyone carrying that local file will have it replaced by the committed one on merge, which is the desired outcome — the placeholder version does not resolve the error.

---

## 6. External surfaces

- **Visible to contributors and to agents onboarding to this repo**: the documented install command starts working. That is the entire user-facing effect.
- **No runtime behavior change** for any running agent. Nothing in `src/` is touched; no route, hook, template, scaffold, or gate changes. An already-installed agent is unaffected.
- **Timing / runtime conditions**: none. The file is read only at install time.
- **Supply-chain surface**: approving a build script permits that package to execute code at install time. Net effect versus today is a *reduction*: CI installs via npm, which runs all 13 with no gate, so 9-approved-3-declined leaves strictly less executing, with per-entry reasoning recorded inline.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN**, and correctly so. This is a file in the git repository consumed by a package manager on whichever machine performs an install. It is not agent state, so there is nothing to replicate, proxy on read, or merge; every machine gets the identical committed file by cloning. There is no notice, no durable per-machine state that could strand on topic transfer, and no generated URL.

Stated explicitly because the question exists to catch silent single-machine assumptions in *features*: this is not a feature, and the machine-local answer is structural rather than an oversight.

---

## 8. Rollback cost

Near-zero and immediate. `git revert` the commit: the file disappears and pnpm returns to its prior failing-but-harmless state. No release required beyond the normal one, no data migration, no agent state repair, nothing to un-migrate. Already-installed `node_modules` trees are unaffected either way.

If a specific approval turns out wrong, the narrower rollback is flipping that one entry to `false` (or the reverse) — a one-line change with no other consequence.
