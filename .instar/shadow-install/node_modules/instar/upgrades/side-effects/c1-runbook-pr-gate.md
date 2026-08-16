# Side-Effects Review — C-1: CI workflow for proposal-derived runbook PRs

**Version / slug:** `c1-runbook-pr-gate`
**Date:** `2026-05-13`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Ships C-1 of Tier-2 from `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` — the CI pre-merge gate that enforces A22's different-principal requirement on proposal-derived runbook PRs.

Per A22 / A41 / A32 / A50, a PR that touches `src/remediation/runbooks/` AND adds/modifies a runbook source file carrying a `__proposalDerivedFrom = '<proposalId>'` const MUST satisfy ONE of:

1. **GPG-signed HEAD commit by an approver** whose fingerprint is registered in `.github/keyrings/runbook-approvers.gpg`. (Sigstore is wire-compatible via the same path — the workflow step that resolves `%G?` accepts either provider.)
2. **Telegram-countersignature** in the PR body, of shape:
   ```
   <!-- telegram-approval -->
   proposalId: <id>
   runbookId: <id>
   action: approved
   userId: <integer>
   messageId: <id>
   signedAt: <ISO>
   signature: <base64>
   <!-- /telegram-approval -->
   ```
   The signature is Ed25519 over the canonical `key=value\n` payload (declaration order: proposalId, runbookId, action, userId, messageId, signedAt — no signature line). Verified against the pinned principal key at `.github/keyrings/telegram-principal-pub.pem`.

PRs touching no runbook sources OR touching only non-proposal-derived runbooks (no `__proposalDerivedFrom` const) pass through with zero work.

Files touched:
- `.github/workflows/runbook-pr-gate.yml` (new) — modelled on `worktree-trailer-sig-check.yml` per A50.
- `scripts/verify-runbook-pr-signature.js` (new) — pure-Node verifier (no deps beyond `node:crypto`). Exports `verifyRunbookPrSignature`, `findProposalDerivedRunbooks`, `parseTelegramApprovalBlock`, `verifyTelegramSignature`, `loadApproverFingerprints`. CLI mode reads `GITHUB_EVENT_PATH`, `CHANGED_FILES_PATH`, `HEAD_COMMIT_INFO_PATH`.
- `.github/keyrings/runbook-approvers.gpg` (new) — empty placeholder with deployment instructions. Workflow imports armored blocks into an ephemeral GNUPGHOME at run-time.
- `.github/keyrings/telegram-principal-pub.pem` (new) — empty placeholder with deployment instructions. Verifier reads PEM directly.
- `tests/unit/verify-runbook-pr-signature.test.ts` (new) — 8 cases covering the 7 scenarios from the spec + a parser-edge-case.
- `upgrades/NEXT.md` — C-1 entry added; existing entries preserved.

## Decision-point inventory

- `findProposalDerivedRunbooks(repoRoot, changedFiles)` — **add** — reads each touched `src/remediation/runbooks/*.{ts,js}` file and looks for a `__proposalDerivedFrom` const declaration. Pure structural detection (regex on a single const-name token); not a content classifier.
- `parseTelegramApprovalBlock(prBody)` — **add** — locates the `<!-- telegram-approval -->` ... `<!-- /telegram-approval -->` block, parses `key: value` lines, returns `{fields, canonical}`. Returns null on missing required fields.
- `verifyTelegramSignature(canonical, sigB64, pubkeyPem)` — **add** — Ed25519 verify via `crypto.verify(null, ...)`. Returns false (not throw) on any parse/verify failure.
- `loadApproverFingerprints(keyringPath)` — **add** — reads sidecar lines of shape `fingerprint: <40-hex>` from the keyring file. The armored-key path is handled in the workflow step (gpg import → git's `%G?` resolution).
- `verifyRunbookPrSignature(input)` — **add** — top-level decision tree: scope → proposal-derived? → Telegram block? → GPG path? → block.
- `findAgentEmailConflict(repoRoot, derived, authorEmail)` — **add** — A32 extension: if the runbook source declares `__producingAgentEmail` and the commit author email matches, reject. (Belt-and-suspenders on top of the keyring check; if you're an approver, you still can't approve your own agent-emitted runbook.)
- Workflow `paths:` filter — **add** — restricts the workflow run to PRs that actually touch the gate-relevant paths. Saves CI minutes on unrelated PRs.

## Over-block / under-block analysis

**Under-block risks (false PASS):**
- Empty `.github/keyrings/telegram-principal-pub.pem` makes the Telegram path fail-closed (rejected as `telegram-principal-pubkey-missing`). Good.
- Empty `.github/keyrings/runbook-approvers.gpg` (only comments, no armored blocks, no `fingerprint:` lines) → `loadApproverFingerprints` returns `[]` → any GPG-signed commit fails as `gpg-fingerprint-not-in-approver-keyring`. Good (fail-closed).
- Non-proposal-derived runbook changes pass through — by design (A22 scope). Authors can still slip non-proposal runbooks through without different-principal signature; this is intentional, since A22 only governs the proposal-derived path.
- A PR with NO Telegram block AND NO GPG signature on HEAD → blocked as `no-valid-approval`. Good.

**Over-block risks (false BLOCK):**
- A legitimate non-proposal runbook change with no signature is **not** blocked (passes through). The risk is the opposite — that an author forgets to add `__proposalDerivedFrom` to a proposal-derived runbook and slips past. Mitigation: the SystemReviewer / `/instar-dev` proposal pipeline (Tier-3 S-1..S-3) is responsible for adding the const when it emits the runbook PR. C-1 is the verification half of that contract.
- Telegram canonical-form mismatch (signing side uses different order or separator) → all signatures fail. Mitigation: the canonical form is documented in this side-effects review AND in the script's JSDoc; the proposal-emit side (Tier-3) MUST use the same canonicalization. The 8 tests pin the exact byte-shape.

**Level-of-abstraction fit:** The gate runs at PR pre-merge in CI, which is the right layer — it's a structural verification, not a runtime authorization. The script is dependency-free Node so it can be invoked from anywhere (workflow, local hook, dashboard preview), not coupled to GitHub-Actions-specific features.

**Signal vs authority compliance:** The script is the **authority** here (blocks merge), but it's a deterministic verifier (signature math + structural regex) — not a brittle filter. The "signals" feeding it are git's `%G?` (which is gpg's own signature verdict — authoritative), the PR body content (a string the workflow extracts from the event payload — structural), and the proposal-derived marker (a const in source — structural). No string-matching over user-controlled free text is used for decisions.

## Interactions

- **F-1..F-8** (already on main): no interaction. The gate consumes the runbook source artifact those PRs ship, but nothing in F-* is on the verifier's read path.
- **W-1** (already on main): the only currently-shipped runbook is `node-abi-mismatch`, which has NO `__proposalDerivedFrom` const (it's an instar-dev-authored runbook, not a SystemReviewer proposal). C-1 passes it through unchanged.
- **S-1..S-3** (future): the SystemReviewer-emitted PR pipeline MUST add the `__proposalDerivedFrom` const + ship the Telegram countersignature block in the PR body. C-1 is the structural enforcement at the merge boundary.
- **`worktree-trailer-sig-check.yml`** (already on main): independent — that workflow verifies commit trailers; this workflow verifies a different artifact set (PR body + commit GPG signature). They can both fire on the same PR without conflict.
- **`instar-dev-precommit.js`**: NOT in scope for `.github/workflows/`. IS in scope for `scripts/verify-runbook-pr-signature.js` — handled by this trace artifact.

## Rollback cost

Reverting C-1 is trivial: delete `.github/workflows/runbook-pr-gate.yml` and the script. The keyrings are empty placeholders with no live data, so deleting them leaks nothing. Test file deletion is idempotent. Released-side rollback (after merge) is also one-line: `git revert <merge-sha>`.

## NEXT.md

Entry added under "What Changed" preserving F-1..F-8, W-1, Phase 4/5, ELI16, API-safety entries.

## Trace

`node skills/instar-dev/scripts/write-trace.mjs --artifact upgrades/side-effects/c1-runbook-pr-gate.md --files ".github/workflows/runbook-pr-gate.yml,scripts/verify-runbook-pr-signature.js,tests/unit/verify-runbook-pr-signature.test.ts,upgrades/NEXT.md" --spec docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md --second-pass not-required`
