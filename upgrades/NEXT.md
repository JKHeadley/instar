# Upgrade Notes (Unreleased)

### feat(build): Phase 1c-build — release-time signing of the instar-default lock-file

Two new build-pipeline scripts wire up release-time signing of `.instar/jobs/instar.lock.json`, the structural trust authority consumed by Phase 1c-runtime (#179):

- `scripts/sign-instar-lockfile.mjs` walks `src/scaffold/templates/jobs/instar/*.md`, parses YAML frontmatter + body, hashes both via the same canonicalization the runtime verifier applies (CRLF→LF, ZWSP/ZWNJ/ZWJ/BOM strip, trimEnd + single trailing newline), and emits a signed lock-file at `dist/jobs/instar.lock.json`. The public key is copied to `dist/keys/instar-release-pub.pem` for bundling. Runs after `tsc` in the `build` script.
- `scripts/generate-instar-release-key.mjs` generates an Ed25519 keypair. Private key lands at `.instar-release-keys/private.pem` (gitignored, mode 0600); public at `src/scaffold/keys/instar-release-pub.pem` (committed). Use `--force` to rotate.

Key resolution order: `INSTAR_RELEASE_PRIVATE_KEY_PEM` env (raw PEM, for GHA secret) → `INSTAR_RELEASE_PRIVATE_KEY_PEM_PATH` env → `.instar-release-keys/private.pem` (local dev fallback). If no key is found, the signer SKIPS lock-file generation (no stale file written) and exits 0. Builds and releases keep working in this mode; existing agents stay on `lockTrust=untrusted-no-lockfile` (the documented transitional state preserved by the Phase-1b-gap carve-out).

Tests: 4 roundtrip cases in `tests/unit/scheduler/sign-instar-lockfile.test.ts` proving the signer and runtime verifier agree on canonicalization, hash format, signature format, and the no-key-available skip path.

To enable production signing: add `INSTAR_RELEASE_PRIVATE_KEY_PEM` to GitHub Actions Secrets. The release workflow's `npm run build` will then sign every published release.

### feat(scheduler): Phase-1b-gap closure — lockTrust gates tool elevation

`JobScheduler.resolveAllowlist` now refuses tool elevation for `origin:instar` agentmd jobs whose `lockTrust` signals real tamper (`untrusted-bad-signature`, `untrusted-not-in-lockfile`, `untrusted-hash-mismatch`). When the gate fires, the resolution kind is `'lock-untrusted-clamped'`, the allowlist clamps to `['Read']`, and both a Dashboard event (`job_lock_untrusted_clamped`) and a degradation event surface.

Two values intentionally do NOT trigger the clamp:

- `'trusted'` — proceed normally.
- `'untrusted-no-lockfile'` — the documented transitional state. Until Phase 1c-build signs lock-files at release time, every existing agent's `origin:instar` job carries this value on the first boot after applying the update. Clamping here would break working agents on the seamless-migration path, violating the Seamless Migration Guarantee invariants (see PR #180).

A new pure classifier `JobScheduler.isLockUntrustedTamper` is exported for reuse by other gates (grounding audit, future Dashboard "degraded trust" indicators).

Tests: 12 new cases in `tests/unit/scheduler/JobScheduler.tool-allowlist.test.ts`. Total file: 27 tests, all passing.

## What Changed

This release adds the runtime consumer for the signed instar-default lock-file described in the INSTAR-JOBS-AS-AGENTMD spec §Trust Model. The lock-file at `.instar/jobs/instar.lock.json` is the structural trust authority for "is this slug a real instar default": a separate build-time pipeline (Phase 1c-build, follow-up PR) signs it at release time; the corresponding public key is bundled at `dist/keys/instar-release-pub.pem`. This PR ships the loader-side consumer (Ed25519 signature verification using `node:crypto`, hash-equality check on body and frontmatter, four-state load result, skip-until-ack on per-slug hash mismatch) and a new `JobDefinition.lockTrust` field that downstream consumers will use to refuse trust elevation when not `'trusted'`. The build pipeline and the Phase-1b-gap closure (allowlist resolver consuming `lockTrust`) are explicitly out of scope and will land in their own PRs.

### feat(scheduler): lock-file runtime consumer (Phase 1c-runtime of jobs-as-agentmd spec)

- **New module `src/scheduler/AgentMdLockFile.ts`** — schema definition, four-state reader (`absent` | `malformed` | `present-untrusted` | `present-trusted`), Ed25519 verification via `node:crypto`, the shared `normalize()` + `hashBody()` + `hashFrontmatter()` functions used both at build-time signing and at runtime verification.
- **`normalize()` is canonical** — CRLF → LF, ZWSP/ZWNJ/ZWJ/BOM stripped, `trimEnd()`, single trailing newline. Same transformation runs at sign-time so checkouts under `core.autocrlf` round-trip cleanly.
- **`JobDefinition.lockTrust`** — additive optional field, closed-set five-value enum (`trusted` | `untrusted-no-lockfile` | `untrusted-bad-signature` | `untrusted-not-in-lockfile` | `untrusted-hash-mismatch`). Set by the loader for `origin:instar` agentmd entries; absent on legacy and `origin:user`.
- **Skip-until-ack on hash mismatch** — when a slug IS in the trusted lock-file but the on-disk body/frontmatter hash does not match, the entry is EXCLUDED from `jobs[]` and a `lock-mismatch` load-problem is emitted. Phase 4 Dashboard will surface this with `Show diff` / `Reset to shipped default` / `Acknowledge and run anyway` actions.
- **No-lock-file → silent untrusted** — until Phase 1c-build ships, every install runs with `lockTrust=untrusted-no-lockfile` on every `origin:instar` entry. No behavioral change to today; the field is observed by tests and observability paths.
- **What is still NOT done (follow-up PRs):** release-key generation pipeline; build-time signing automation; public-key bundling automation; custom git merge drivers; `JobScheduler.resolveAllowlist` reading `lockTrust` to refuse the Phase-1b-gap full-tools elevation. The follow-ups will land within a release cycle to avoid the field becoming a documentation-only artifact.

### Evidence

New test file: `tests/unit/scheduler/AgentMdLockFile.test.ts` — 17 cases covering:

- normalize/hash determinism: CRLF and LF produce identical hashes; ZWSP and BOM are stripped; trimEnd + trailing newline applied; sha256:<64-hex> format enforced; frontmatter hash is order-stable; differing content produces differing hashes; `normalize()` is idempotent.
- `readLockFile` state machine: `absent` when no file exists; `malformed` on bad JSON, missing schema fields, oversized file, malformed sha256 hashes; `present-untrusted` when no bundled public key OR signature does not verify; `present-trusted` when a real Ed25519 keypair signs the canonical payload and the bundled key verifies (full sign-then-verify roundtrip in-test).
- Integration with `loadAgentMdJobs`: `untrusted-no-lockfile` set when lock-file is absent; `untrusted-bad-signature` set when signature fails; problem of kind `lock-mismatch` surfaces in the result.

Test highlights (verified locally on this worktree):

```
 ✓ tests/unit/scheduler/AgentMdLockFile.test.ts (17 tests) 68ms
 ✓ tests/unit/scheduler/JobLoader.agentmd.test.ts (68 tests)
 ✓ tests/unit/scheduler/JobScheduler.agentmd-dispatch.test.ts (5 tests)
 ✓ tests/unit/scheduler/JobScheduler.run-record.test.ts (13 tests)
 ✓ tests/unit/scheduler/JobScheduler.tool-allowlist.test.ts (15 tests)

 Test Files  5 passed (5)
      Tests  118 passed (118)
```

The full pre-existing scheduler test suite (101 tests) continues to pass — the new lock-file consumer is purely additive on top of Phase 1a and Phase 1b.

Side-effects review: `upgrades/side-effects/jobs-as-agentmd-phase-1c-runtime.md` — covers over-block (hash mismatch is the intended over-block on tampered `origin:instar` slugs; no legitimate input rejected), under-block (no-lock-file state is the documented transitional gap until Phase 1c-build), level-of-abstraction fit (consumer lives in a new module so the build-time signer can import the same `normalize` + hash functions), signal-vs-authority compliance (both new gates are hard-invariant cryptographic and structural checks; no brittle blocking authority added), interactions (sequential after `loadAgentMdBody`; one lock-file read per loader pass; no double-fire; no feedback), external surfaces (no schema changes; one new optional field on `JobDefinition`; tolerated by all current consumers; observable behavior only kicks in when the build pipeline starts shipping signed lock-files), and rollback (revert + patch release; the `rm` lock-file fallback degrades to `untrusted-no-lockfile`).

## What to Tell Your User

Phase 1a let instar READ the new markdown-based job format. Phase 1b lets it RUN those jobs with the tool allowlist enforced. This release adds the CHECK side: when a signed lock-file is present, every `origin:instar` job's body and frontmatter are hashed and compared against the locked entry before the job is allowed to run. If something has tampered with the file on disk (a corrupted sync, a rogue local process, a misconfigured update), the job is held back with a clear explanation and a path forward — instar will not silently fire a tampered system job. The build-pipeline side that actually signs the lock-file lands in a follow-up release; until then, every `origin:instar` job loads with a `untrusted-no-lockfile` marker that downstream code uses to refuse trust elevation. No setup required; the new behavior takes effect on the next agent update.

## Summary of New Capabilities

- **Signed lock-file runtime consumer** — `readLockFile()` reports four states (`absent` / `malformed` / `present-untrusted` / `present-trusted`) so callers can route their behavior. Ed25519 verification uses the bundled `dist/keys/instar-release-pub.pem`.
- **`JobDefinition.lockTrust` field** — closed-set five-value enum recording per-`origin:instar` agentmd entry's trust outcome. Downstream consumers (allowlist resolver, grounding audit, dashboard) read this to refuse trust elevation when not `'trusted'`.
- **Skip-until-ack on hash mismatch** — `origin:instar` entries whose body or frontmatter hash does not match the lock-file are excluded from the loaded job set and surface as a `lock-mismatch` load-problem.
- **Shared `normalize()` + `hashBody()` + `hashFrontmatter()`** — exported from `AgentMdLockFile.ts` so the future build-time signer round-trips with the runtime verifier byte-for-byte.
