# Side-Effects Review — decision-audit presence PR gate (task #81 close-out)

**Version / slug:** `decision-audit-presence`
**Date:** `2026-06-05`
**Author:** `echo`
**Second-pass reviewer:** `self-review under the Tier-1 lite lane; over-block analysis below covers every legitimate-PR shape considered`

## Summary of the change

New PR-boundary check (`scripts/decision-audit-presence-check.mjs` + `.github/workflows/decision-audit-gate.yml`): a PR whose diff touches gate-scoped files (src/, scripts/, .husky/, skills/ code — the same `inScope` predicate as the pre-commit gate) must also carry gate evidence: an added `.instar/instar-dev-decisions/*.json` per-entry file (post-#827) or a modified legacy `.instar/instar-dev-decisions.jsonl` (transition grace). Otherwise it fails with an actionable message naming the husky-shim cause and the `npm run prepare` fix. Plus: `.gitignore` `node_modules/` → `node_modules` so the worktree node_modules SYMLINK is ignored too (trailing-slash patterns match only directories; the symlink slipped into a commit once tonight).

## Decision-point inventory

- `evaluateDecisionAuditPresence` — add — pure; exemptions mirror the eli16 PR gate (Bot authors, `chore: release` titles).
- `isInScopeFile` — add — duplicated from `scripts/instar-dev-precommit.js` `inScope()` with a sync comment; drift only weakens detection, never blocks a PR the local gate doesn't also cover.
- Workflow — add — `pull_request` types opened/synchronize/reopened/ready_for_review, `contents: read`, full-depth checkout for the three-dot diff.
- `.gitignore` — modified — one-line pattern fix.

## 1. Over-block analysis (can this fail a legitimate PR?)

- **Docs/tests/upgrades-only PRs** — pass (no in-scope files).
- **In-flight pre-#827 PRs** — pass via the legacy-jsonl grace path (their gate appended a line).
- **Gated code PRs** — pass: the gate stages an audit record into every evaluated commit (post-#814), so evidence is present by construction.
- **The genuinely-blocked shape** — in-scope changes with NO record — is exactly the bypass this exists to surface. The failure message gives the one-command fix.
- **Bots + release-cut** — exempt, mirroring the eli16 gate.
- **Squash-merge interaction** — none: the check runs on the PR diff (base...head), not on merged history.
- Residual risk: an operator hand-editing in-scope files via the GitHub web UI would fail the check — correctly, since the gate never evaluated that change; the fix message applies (commit locally through the gate).

## 2. Under-block

Evidence is presence-based, not per-commit: one gated commit in a PR vouches for the PR even if a sibling commit bypassed. Accepted for this slice — the common failure mode (a WHOLE worktree without hooks) produces zero evidence and is caught. Per-commit matching would need trace↔commit correlation; noted as a possible tightening, not promised.

## 3. Signal vs authority

Deterministic file-presence check — no LLM, no semantic classification. Authority shape matches existing required CI (eli16 gate, repo invariants).

## 4. Migration parity

None — repo CI infrastructure, not agent-installed files.

## 5. Token/cost impact

One ubuntu CI job per PR event, seconds long. No LLM calls.

## 6. Rollback

Delete the workflow file (or revert); the script is inert without it.
