# NEXT — upcoming release notes

Entries here ship in the next release. Move them into the versioned upgrade
note (`upgrades/<version>.md`) at release-cut time.

---

### test(scheduler): Seamless Migration Guarantee suite + 8 fixtures

The binding gate the INSTAR-JOBS-AS-AGENTMD spec §Seamless Migration Guarantee promises lands here: `tests/integration/migration-guarantee.test.ts` iterates 8 fixtures (`pristine`, `customized`, `body-edited`, `user-jobs`, `retired-defaults`, `mixed-state`, `multi-machine-drift`, `in-flight`) and asserts invariants 1, 2, 4, 5, 7, 9 + idempotency + dry-run on every shape under the CLI migration path. 50 test cases, all green. Fixtures live under `tests/fixtures/migration-agents/<shape>/shape.json` as declarative transformations on top of `getDefaultJobs()` output. New pre-commit gate `scripts/protect-migration-guarantee.js` refuses commits that delete the test file or any fixture's `shape.json`. Phase 5 auto-migrate (#193), Phase 6 deprecation (#194), and Phase 4 endpoints (#195) are held as drafts until this lands, per the spec's gate-wiring requirement.

## What Changed

### F-1 — RemediationKeyVault (Tier-1 foundation for Self-Healing Remediator)

- **Adds** `src/remediation/RemediationKeyVault.ts` — per-context, per-scope HKDF-SHA256 leaf-key derivation with a 4-backend secret store (OS keychain, hardware enclave stub, cloud KMS stub, env-passphrase + AES-256-GCM flatfile).
- Per amendments A20, A23, A39, A42, A51, A54, A58, A62 of `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md`.
- **No runtime consumers yet.** F-2+ wires capability tokens, probe authentication, in-flight lockfiles, the cross-process attempt ledger, and the audit-token writer onto the leaf-key surface.

### feat(instar-dev): ELI16 overview required for every approved spec

`/instar-dev`'s pre-commit gate and `/spec-converge`'s convergence-tag writer now both refuse to advance a spec that ships without a plain-English ELI16 overview. Topic 3079 on 2026-05-13 surfaced this directly: "I can't digest this without an ELI16 overview. That should be required for every spec."

This release adds a deterministic structural gate. The overview lives at `docs/specs/<slug>.eli16.md` by default (or any path declared via the spec's `eli16-overview:` frontmatter field) and must be at least 800 characters of real content. Stubs are refused. Both gates share `scripts/eli16-overview-check.mjs` so the rule is uniform across convergence-time and commit-time enforcement.

- New shared check module `scripts/eli16-overview-check.mjs` exposes `resolveEli16Path()` and `checkEli16Overview()` with `MIN_ELI16_CHARS = 800` floor.
- `scripts/instar-dev-precommit.js` adds Step 7 after spec-tag verification: refuses commit if the referenced spec has no ELI16 companion or the companion is a stub.
- `skills/spec-converge/scripts/write-convergence-tag.mjs` adds a pre-check before stamping `review-convergence`: refuses to mark a spec converged without an ELI16 companion.
- New template at `skills/instar-dev/templates/eli16-overview.md`. Updated `skills/instar-dev/SKILL.md` Phase 0 and `skills/spec-converge/SKILL.md` Phase 5.
- 11 new unit tests in `tests/unit/eli16-overview-check.test.ts` — all passing.

Side-effects review: `upgrades/side-effects/eli16-overview-required-gate.md`.

## What to Tell Your User

**F-1 — Cryptographic foundation for self-healing.** Nothing user-visible yet. Operators running on headless Linux without libsecret should set `INSTAR_REMEDIATION_KEY_PASSPHRASE` in their environment before any F-2+ feature ships. macOS and Linux+libsecret have nothing to do.

**ELI16-overview gate.** When your agent hands you a spec for approval, you'll now always get a plain-English overview alongside the dense technical document. The instar repo refuses to commit any code change whose driving spec lacks a readable companion file. The technical spec becomes the appendix; the overview is the entry point. No setup required; the new behavior takes effect on the next agent update.

## Summary of New Capabilities

- **`RemediationKeyVault`** (F-1) — HKDF-SHA256 leaf keys scoped to one of five contexts (`capability`, `probe`, `inflight`, `ledger`, `audit`) and an opaque scope id.
- **4-backend secret store** (F-1) — OS keychain preferred; hardware-enclave and cloud-KMS stubbed; env-passphrase + AES-256-GCM flatfile fallback.
- **Install nonce** (F-1) — 256-bit random anchor stored under `ai.instar.remediation.install-nonce`; auto-initialized on first boot, fail-closed if missing.
- **ELI16-overview gate** — Structural enforcement at both convergence-time and commit-time. Specs handed for approval always carry a plain-English companion.
- **Shared check module** at `scripts/eli16-overview-check.mjs` — `resolveEli16Path()` and `checkEli16Overview()` with 800-char minimum-length floor.
- **Template for ELI16 overviews** at `skills/instar-dev/templates/eli16-overview.md`.
- **Forward-only enforcement** — only specs newly committed-against after this ships have to satisfy the gate.
