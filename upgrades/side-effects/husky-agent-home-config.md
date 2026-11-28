# Side-Effects Review — pre-commit reads requireConvergenceReport from the agent home

**Version / slug:** `husky-agent-home-config`
**Date:** `2026-11-23`
**Author:** `Dawn (workstation), self-repair instar-husky-convergence-report-flag-unreachable-20261102`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1. One runtime file: `.husky/pre-commit`. The config probe that decides whether to export `INSTAR_DEV_REQUIRE_CONVERGENCE_REPORT=1` now checks `$INSTAR_AGENT_HOME/.instar/config.json` before the main-checkout and local-checkout paths. Spec `audit-convergence-enforcement.md` §6 pinned the main-checkout read on the assumption that the live config sits in the main checkout ("worktree → main checkout, where the live config sits"). On this fleet the dev agent's live config is at `~/.instar/agents/echo/.instar/config.json` and the checkout at `~/Projects/instar` has no config, so all four candidate paths were absent (measured 2026-11-02 and again 2026-11-23) and the §6 flip could not take effect. The fix keeps §6's intent, which is that the flag is read where commits happen, and uses the variable the launcher already exports (`SessionManager` passes `-e INSTAR_AGENT_HOME=${config.projectDir}` on every spawn path). Size: 1 file, +9/−4 lines, most of it comment.

## Decision-point inventory

- `.husky/pre-commit` config probe — modify — adds one candidate path in front of the existing four; the decision rule (`requireConvergenceReport === true` → export) is unchanged.

---

## 1. Over-block

The probe itself never blocks. It can now export the variable in one case where it could not before: the agent home config has `requireConvergenceReport: true`. That is the case the operator asked for. With the flag `false`, absent, or the file unreadable, the result is the same as today. Measured: none of the agent configs on the workstation (`~/.instar/agents/*/.instar/config.json`) set it `true`, so no commit is blocked by this change until someone sets the flag.

---

## 2. Under-block

A commit made outside an agent session (no `INSTAR_AGENT_HOME`, e.g. a human at a terminal) still falls back to the checkout paths, which is today's behaviour and fails open when they are absent. This is unchanged, not introduced here. A per-machine fallback that scans `~/.instar/agents/*` was rejected: it would have to guess which agent owns the checkout, and a wrong guess would apply another agent's policy.

---

## 3. Level-of-abstraction fit

Right layer. The hook is the only place the flag can be read (the precommit runs pre-compile and reads no config). Using the launcher's existing `INSTAR_AGENT_HOME` matches the convention used by the other installed hook scripts (`PostUpdateMigrator` hook templates read `$INSTAR_AGENT_HOME/.instar/config.json` first, too).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No new authority. The blocking authority (report-backed convergence in `instar-dev-precommit.js`) already exists and was approved in spec #4 / PR #1052. This change only lets the existing operator switch reach it.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new heuristic. The rule is a boolean read of an operator-set flag.

---

## 5. Interactions

- **Precedence:** the agent home config wins over a checkout config. If both exist and disagree, the agent's own config is the live one and the one the operator edits. A checkout-level config is a fallback for setups whose agent home is the checkout, in which case both paths point at the same file.
- **Fail-open:** any read or parse error on the new path moves on to the next candidate; no path that used to load stops loading.
- **Races / feedback loops:** none; read-only, once per commit.

---

## 6. Rollback

Revert the commit. No state to repair.
