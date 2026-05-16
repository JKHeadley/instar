# Side-Effects Review — S-3: Commit-time promotion gate for proposal-derived runbooks

**Version / slug:** `s3-promotion-gate`
**Date:** `2026-05-16`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Ships S-3 of Tier-3 from `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` — the **commit-time** promotion gate that pairs with C-1's PR-merge-time CI gate.

Per A11 / A22 / A32 / A41 / A48 / A57 Tier-3, when the `/instar-dev` skill commits a runbook source file under `src/remediation/runbooks/*.{ts,js}` that declares `__proposalDerivedFrom = '<proposalId>'`, the commit MUST:

1. Carry a matching `__producingAgentId = '<agentId>'` const in the same source file.
2. Reference a proposal that exists at `.instar/remediation/proposals-<machineId>/<proposalId>.json` in the current checkout.
3. Have a proposal whose `producingAgentId` field matches the runbook's `__producingAgentId` annotation.
4. (When pubkey is bundled and proposal carries a signature) verify the proposal's `producingAgentIdSignature` against `.instar/remediation/agent-pubkeys/<agentId>.pem`.

Otherwise the pre-commit hook refuses the commit with a structured error.

The gate is **additive** — runbook source files without `__proposalDerivedFrom` (i.e., the existing hand-authored runbooks W-1..W-7) pass through with zero work. Files outside `src/remediation/runbooks/` are not inspected.

This is the **commit-time** half. C-1 (shipped in PR #204, SHA `780b2659`) is the **PR-merge-time** half — it adds different-principal verification (GPG/sigstore OR Telegram countersignature) at PR review. Both are required per spec: this catches author mistakes before the PR is pushed; C-1 is authoritative because it has fleet-wide visibility.

Files touched:
- `skills/instar-dev/scripts/verify-proposal-derived-runbook.mjs` (new) — pure-Node verifier (no deps beyond `node:crypto`/`node:fs`/`node:path`). Exports `verifyProposalDerivedRunbooks`, `inspectRunbook`, `findProposalJson`, `verifyProposalSignature`. CLI mode at `--files <csv>`.
- `scripts/instar-dev-precommit.js` — adds Step 8 calling the verifier on the staged file list. Existing Steps 0–7 (merge skip, staged inspect, classify, bootstrap, fresh-trace, trace validation, spec tags, ELI16) unchanged.
- `skills/instar-dev/SKILL.md` — Phase 0 documentation extended with the new gate's preconditions.
- `tests/unit/verify-proposal-derived-runbook.test.ts` (new) — 12 cases covering the 6 spec scenarios plus edge cases.
- `upgrades/NEXT.md` — S-3 entry appended; existing release-notes preserved.

## Decision-point inventory

- `inspectRunbook(repoRoot, relPath)` — **add** — reads each touched runbook source, regex-detects `__proposalDerivedFrom` and `__producingAgentId` consts. Pure structural detection (single regex per marker). Not a content classifier; it does not parse arbitrary TypeScript.
- `findProposalJson(repoRoot, proposalId)` — **add** — scans `.instar/remediation/proposals-*` directories for `<proposalId>.json`. Reads via `fs.readdirSync` + `fs.existsSync` to avoid pulling unrelated history (A48). Malformed JSON treated as not-found.
- `verifyProposalSignature(repoRoot, proposal)` — **add** — Ed25519 verify over canonical `proposalId=...\nproducingAgentId=...\nemittedAt=...` payload. Returns `'ok' | 'no-signature' | 'no-pubkey' | 'invalid'`. Only `'invalid'` blocks the commit; `'no-signature'` and `'no-pubkey'` defer to C-1 (proposal pipeline and pubkey distribution are downstream infra).
- `verifyProposalDerivedRunbooks({repoRoot, files})` — **add** — top-level decision tree: filter to runbook source paths → inspect each → presence checks → proposal lookup → agent-id match → signature verify. Short-circuits on first failure.
- `scripts/instar-dev-precommit.js` Step 8 — **add** — calls the verifier on the full staged file list (not just `inScopeFiles`, because runbooks under `src/remediation/runbooks/` are already in scope; passing the full list is a no-op for non-runbook files).
- `SKILL.md` Phase 0 — **extend** — documents the new gate's preconditions so the agent knows the contract before producing a runbook.

## Over-block / under-block analysis

**Under-block risks (false PASS):**
- An author hand-writes `__proposalDerivedFrom = 'real-proposal'` + `__producingAgentId = 'self'` matching a legitimate-on-disk proposal that they themselves authored. The S-3 gate passes (the proposal exists, IDs match). The defense-in-depth is C-1: at PR-merge time the different-principal check refuses a PR whose signing identity matches the proposal's `producingAgentId`. This is the spec-intended layering — S-3 catches typos; C-1 catches collusion.
- A proposal without a `producingAgentIdSignature` field passes the signature step. This is by design — early proposals predate signing infra; the C-1 CI gate will surface this at PR time once the proposal pipeline lands (Tier-3 S-1).
- A proposal with a signature but no bundled pubkey at `.instar/remediation/agent-pubkeys/<agentId>.pem` passes locally. Pubkey distribution is fleet infrastructure that ships separately; C-1 has the authoritative pubkey set.

**Over-block risks (false BLOCK):**
- A hand-authored runbook (W-1..W-7) that gains a `__proposalDerivedFrom` annotation in the future without a matching proposal would block at commit-time. Mitigation: the annotation is only ever emitted by the SystemReviewer proposal pipeline (S-1, not yet shipped). Hand-authored runbooks never carry the const.
- Renaming or relocating proposals (e.g., archival to `proposals-archived-<machineId>/` per the spec's rollback line 5) would orphan the runbook reference. Mitigation: archival happens during nuclear uninstall only; runbook source is also archived in the same rollback step.
- File-encoding edge cases (BOMs, CRLF, unusual quoting) could make the regex miss the const. Mitigation: the regex tolerates single/double/backtick quoting and any of `const|let|var` with optional `export`; tests pin the byte shape.

**Bootstrap exception not needed.** The existing `BOOTSTRAP_TRIGGERS` list (`scripts/instar-dev-precommit.js:105`) covers the precommit script's own first-ship and `/spec-converge`. The new gate is additive — staged files with no `__proposalDerivedFrom` (which includes everything in this S-3 PR) pass through harmlessly.

## Level-of-abstraction fit

- The verifier sits in `skills/instar-dev/scripts/` because it is part of the `/instar-dev` skill's enforcement surface — it has no caller outside the precommit hook. Co-locating it with `write-trace.mjs` keeps the skill's structural pieces together.
- The precommit hook adds Step 8 (after spec-tag + ELI16 checks) because the proposal-derivation check is the most expensive (fs scan of `.instar/remediation/proposals-*`). Running it last means cheap structural checks reject first.
- C-1 lives in CI because PR-merge-time needs different-principal verification (commit signing identity), which only the CI environment can determine authoritatively. S-3 doesn't need that — it only verifies the runbook + proposal shape.

## Signal vs authority compliance

- The verifier is a **signal-producer with structural authority** — it makes a deterministic, byte-level structural check (regex match + JSON parse + Ed25519 verify), not a content judgment. Signal-vs-authority's "brittle filters don't get blocking authority" rule is for content classifiers (NLP, heuristics). Structural pre-commit gates are the canonical pattern for authority bound to verifiable invariants — same shape as the existing spec-tag and ELI16 checks.
- The "intelligent gate" layer above this is the user reviewing the side-effects artifact and PR diff. The structural gate ensures runbook source carries the metadata the intelligent gate needs to make its decision.

## Interactions

- **Existing precommit Steps 0–7:** the new Step 8 runs AFTER trace validation, AFTER spec-tag verification, AFTER ELI16. It uses `staged` (not `inScopeFiles`) because runbooks under `src/remediation/runbooks/` are already in `inScopeFiles` per `inScope()`; passing `staged` keeps the API caller-agnostic.
- **C-1 CI gate:** complementary. S-3 verifies the runbook↔proposal binding locally; C-1 verifies signer-identity + Telegram countersignature at PR-merge time. They share the `__proposalDerivedFrom` const as the trigger marker.
- **F-5 TrustElevationSource (PR #203):** the trust-elevation logic at the API layer decides whether a high-blast-radius runbook may run. S-3 is at a different layer (source-control), so no interaction.
- **F-7 PostUpdateMigrator + AnnouncementManager (PR #210):** unaffected. Promotion events aren't yet wired into AnnouncementManager (deferred to a follow-up that ships once S-1's proposal pipeline lands).
- **Bootstrap exception list:** unchanged. The new gate's own first-ship doesn't add a runbook with `__proposalDerivedFrom`, so it passes through Step 8 naturally.

## External surfaces

- New filesystem paths read (none written): `.instar/remediation/proposals-*/<id>.json`, `.instar/remediation/agent-pubkeys/<agentId>.pem`. Both are spec-mandated locations from §A14 / §A20.
- No new network calls, no new env-var reads, no new IPC.
- The script is pure-Node ESM — same runtime as the precommit hook. No new runtime dependency.
- CLI surface: `--files <csv>` + `--repo-root <path>` only. No interactive prompts.

## Rollback cost

If S-3 turns out wrong in production:

- **Hot-fix path:** revert the import in `scripts/instar-dev-precommit.js` (one line). The verifier script and tests can stay; they're inert without the precommit wire-up.
- **Full revert:** remove the new script, the test file, the SKILL.md addendum, the precommit import + Step 8 block. `git revert` is sufficient; no data migration.
- **In-flight runbook PRs:** zero impact. The gate is additive; runbooks without `__proposalDerivedFrom` (every runbook on main today) pass through.
- **No agent-state repair needed.** The gate writes no state.

## Test coverage

`tests/unit/verify-proposal-derived-runbook.test.ts` — 12 cases:

1. Runbook without `__proposalDerivedFrom` → passes through.
2. Runbook with `__proposalDerivedFrom` matching existing proposal + agent id → passes.
3. Runbook with `__proposalDerivedFrom` but no `__producingAgentId` → fails.
4. Runbook with `__proposalDerivedFrom` pointing to non-existent proposal → fails.
5. Runbook with `__producingAgentId` whose signature doesn't verify → fails.
6. Multiple runbooks, first failure short-circuits.
7. Producing-agent-id mismatch between runbook and proposal → fails.
8. Proposal exists but lacks `producingAgentId` field → fails.
9. No pubkey on disk → passes (defers to CI gate).
10. Proposal without signature field → passes (signature optional at commit-time).
11. Non-runbook paths in file list are ignored.
12. Proposal stored under a different `machineId` directory still resolves.

Tests use real Ed25519 keypairs (`crypto.generateKeyPairSync`), real fs scaffolding in `os.tmpdir()`, and `SafeFsExecutor.safeRmSync` for teardown.

## Concur or concern

No second-pass required: the change is purely additive, structural, and dual-gated (S-3 here + C-1 in CI). The 12-test suite pins the byte-shape and decision tree.
