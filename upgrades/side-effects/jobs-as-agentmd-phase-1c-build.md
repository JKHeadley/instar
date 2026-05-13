# Side-effects review — Phase 1c-build (signing pipeline)

## What changed

Two new scripts and one new directory wire up release-time signing of `.instar/jobs/instar.lock.json` — the structural trust authority for "is this slug a real instar default" consumed by Phase 1c-runtime (PR #179).

- `scripts/generate-instar-release-key.mjs` — generates a fresh Ed25519 keypair. Writes private to `.instar-release-keys/private.pem` (gitignored, mode 0600). Writes public to `src/scaffold/keys/instar-release-pub.pem` (committed). One-time invocation per key rotation.
- `scripts/sign-instar-lockfile.mjs` — walks `src/scaffold/templates/jobs/instar/*.md`, parses YAML frontmatter + body for each, hashes both via the canonicalization defined in `src/scheduler/AgentMdLockFile.ts` (CRLF→LF, ZWSP/ZWNJ/ZWJ/BOM strip, trimEnd + single trailing newline), and emits a signed lock-file at `dist/jobs/instar.lock.json`. Copies the public key into `dist/keys/instar-release-pub.pem` for bundling.
- `src/scaffold/keys/instar-release-pub.pem` — the bundled public key. This is a dev keypair until the production key is wired into the GHA secret pipeline (operator action; the file is overwritten by `--force` rotation).
- `.gitignore` — `.instar-release-keys/` directory (private key never enters git).
- `package.json#scripts.build` — `tsc` now followed by `node scripts/sign-instar-lockfile.mjs`. Every build emits a signed lock-file.

Key resolution order in the signer (highest to lowest precedence):
1. `INSTAR_RELEASE_PRIVATE_KEY_PEM` env (raw PEM, for GHA secret injection)
2. `INSTAR_RELEASE_PRIVATE_KEY_PEM_PATH` env (path to a PEM file)
3. `.instar-release-keys/private.pem` (local dev fallback)

If no key is found, the signer SKIPS lock-file generation entirely (no stale file written) and exits 0. The bundled public key is still copied so that a future signed lock-file can be verified. The runtime treats absence as `state: 'absent'` → `lockTrust: 'untrusted-no-lockfile'` — the documented transitional state per Phase-1b-gap.

## Side-effects review (mandatory gate)

### 1. Over-block / under-block

- **Over-block:** none. The signer never blocks a build. Missing-key path is non-fatal (warns and skips). The runtime is the gate, not the build.
- **Under-block:** the signer DOES NOT validate that the slugs it sees in `src/scaffold/templates/jobs/instar/` match what `installBuiltinJobs()` actually writes to agent disk (Phase 2 will introduce `installBuiltinJobs` and this check). For Phase 1c-build the templates directory is empty (only `.gitkeep`), so this is a documented Phase 2 follow-up, not a gap.

### 2. Level-of-abstraction fit

The signer is a standalone build script (CommonJS-flavored ESM .mjs) that imports zero runtime modules. The hash + canonicalization functions are **literally duplicated** from `src/scheduler/AgentMdLockFile.ts` so the signer can run before TypeScript compilation finishes. The duplication is justified because:

- The runtime module is what the bundled npm package ships. If the signer imported from a compiled `dist/` artifact, every build would have to wait for `tsc` to finish, AND the signer's own bugs could only be caught after `tsc` succeeded.
- The roundtrip test asserts they agree. If either side drifts, the test fails.

If a future refactor extracts the normalize/hash functions to a no-TypeScript shared module, the duplication can be collapsed. Not worth doing now (4 lines of duplication, fully tested).

### 3. Signal-vs-authority compliance

The signer is the AUTHORITY for "what's in the released set of instar defaults" — by signing, it stamps a release. The runtime is the GATE that enforces "only run jobs whose body+frontmatter hash matches what was signed." Authority is held by the entity that controls the private key (release pipeline + Justin); the gate is enforced at every agent. Clean separation. The dev key currently committed CAN be used locally to sign test lock-files, but the test workspace generates its own keypair per-run so the dev key is never load-bearing in tests.

### 4. Interactions

- **`AgentMdLockFile.ts` runtime verifier** — receives the signed lock-file. The roundtrip test `produces a present-trusted lock-file from empty templates dir` asserts the verifier accepts the signer's output. The `hashes match runtime verifier for a populated template` test asserts byte-identical hashes between signer and runtime for the same input.
- **`installBuiltinJobs()`** — does NOT exist yet (Phase 2). The signer's output lands at `dist/jobs/instar.lock.json`; Phase 2 will wire `installBuiltinJobs` to copy this onto agent disk during `PostUpdateMigrator`.
- **GHA release workflow** — needs `INSTAR_RELEASE_PRIVATE_KEY_PEM` as a secret. Until that's added by Justin, every published release will ship without a signed lock-file → agents will continue running in `untrusted-no-lockfile` mode (the documented transitional state, preserved by the Phase-1b-gap carve-out). This is the seamless-migration property of the rollout: nothing breaks during the wire-up window.
- **npm pack** — `dist/` is in `package.json#files`, so `dist/jobs/instar.lock.json` (when signed) and `dist/keys/instar-release-pub.pem` (always present once Phase 2 lands a fixture) will be in the published tarball.
- **Key rotation / compromise** — `generate-instar-release-key.mjs --force` rotates. Existing agents with the previous bundled public key treat the new lock-file as `present-untrusted` (degraded mode, no behavioral break) until they update. This is the emergency procedure documented in §Trust Model of the spec.

### 5. Rollback cost

Trivial. Delete the two scripts + the dev keypair file + revert `package.json#scripts.build`. No on-disk state on user agents (the signed lock-file only appears at runtime if Phase 2's `installBuiltinJobs` copies it; until Phase 2, no agent has one).

### 6. Seamless Migration Guarantee compliance

Phase 1c-build is structurally compatible with the Migration Guarantee landed in PR #180 because:

- No-key-available path is non-fatal — the build succeeds, the release ships, agents keep working with `lockTrust=untrusted-no-lockfile` (Phase-1b-gap carve-out).
- Once the GHA secret is wired and the next release is signed, agents that update get the signed lock-file via `installBuiltinJobs` (Phase 2). Their `origin:instar` jobs transition from `untrusted-no-lockfile` to `trusted` without any behavioral disruption.
- Body/frontmatter hash mismatches on update produce `lockTrust=untrusted-hash-mismatch` → entry excluded from `jobs[]` + Issues-card surface (Phase 4). The exclusion path was already shipped in Phase 1c-runtime.

## Test coverage

`tests/unit/scheduler/sign-instar-lockfile.test.ts` — 4 cases:

- Empty templates dir → signer emits a lock-file that the runtime verifier accepts as `present-trusted`.
- Populated template (1 file) → signer's `bodyHash` and `frontmatterHash` match `hashBody()` and `hashFrontmatter()` from the runtime module on the same input. **This is the canonical "signer and verifier agree" assertion.**
- No signing key available → signer SKIPS lock-file generation (no file written), still copies the public key for forward-compat, runtime sees `state: 'absent'`.
- `--dry-run` prints JSON to stdout and does NOT touch `dist/`.

All 4 tests pass locally.

## What is NOT in this PR

- `installBuiltinJobs()` — Phase 2.
- The actual production private key in GHA Secrets — operator action (Justin adds `INSTAR_RELEASE_PRIVATE_KEY_PEM` to the repo's secrets; the signer will then sign every CI release).
- Custom git merge drivers for `instar.lock.json` cross-machine merge — separate concern, can ship in a small follow-up once Phase 2 produces real entries to potentially conflict.
- The `significantChanges` field population (drift classifier) — Phase 2 / Phase 4.
