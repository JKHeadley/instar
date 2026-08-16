# Side-effects review — npm-pack templates smoke test

## What changed

New integration test `tests/integration/npm-pack-templates-smoke.test.ts` asserts that the published npm tarball contains the artifacts the runtime needs to install built-in jobs:

- ≥14 shipped prompt-type default templates under `src/scaffold/templates/jobs/instar/`
- `src/scaffold/keys/instar-release-pub.pem` (source-tree bundled public key)
- `dist/keys/instar-release-pub.pem` (build-output copy from the signer)
- `dist/jobs/instar.lock.json` ABSENT-or-nonzero — the signer's contract is "write a real signed file or skip; never write a malformed empty-signature placeholder."

The test uses `npm pack --dry-run --json` so no `.tgz` file is actually written.

Closes the spec §Security Model threat row "Build pipeline: source-tree templates not packaged."

## Side-effects review

### 1. Over-block / under-block

- **Over-block:** none. The test only fails when the tarball would actually ship without templates or with a malformed placeholder lock-file. Both are real release-quality issues.
- **Under-block:** the test does NOT validate the lock-file's signature — only that if present, it's nonzero. Signature roundtrip validation is covered by `tests/unit/scheduler/sign-instar-lockfile.test.ts` (Phase 1c-build, PR #183).

### 2. Level-of-abstraction fit

Integration-test layer. Reads what `npm pack` itself produces. No new build hooks, no new gates.

### 3. Signal-vs-authority compliance

The test consumes `npm pack` output as the signal. The publisher (CI release step) is the authority. The test fails the build BEFORE publish if the signal is wrong.

### 4. Interactions

- **Phase 1c-build signer** — the smoke test exercises the signer's contract (copy public key always; write lock-file conditionally).
- **Phase 2 installBuiltinJobs** — the smoke test validates the publish path the installer reads from.
- **package.json#files** — depends on the `src/scaffold` and `dist` entries; if either is removed, the test fails fast.

### 5. Rollback cost

Trivial. Single test file. Delete to revert.

## Test coverage

5 cases in `tests/integration/npm-pack-templates-smoke.test.ts`:

1. ≥14 shipped default-job templates present
2. Source-tree public key present
3. Build-output public key present (with informative warning if missing)
4. Lock-file present-and-nonzero OR cleanly absent
5. Source-tree template directory entry present (for installBuiltinJobs fallback)

All 5 pass locally after `npm run build`.
