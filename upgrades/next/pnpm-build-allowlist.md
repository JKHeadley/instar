# Upgrade Guide — vNEXT

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

`pnpm install` failed on a fresh checkout of `main` and had done for some time. pnpm >= 11 refuses to run a dependency's install script without an explicit allowlist and exits non-zero while any remain unresolved; no allowlist was ever committed. Reproduced on v1.3.1071 with pnpm 11.5.1 from a branch off current `origin/main`: `exit 1`, `ERR_PNPM_IGNORED_BUILDS`, 13 ignored build scripts, nothing built.

This commits `pnpm-workspace.yaml` with an explicit boolean decision per package, and a unit-test guard.

Nine are allowed because their install step produces a real runtime artifact — a compiled native binding or a downloaded platform binary: `better-sqlite3`, `bufferutil`, `cloudflared`, `cpu-features`, `esbuild`, `onnxruntime-node`, `sharp`, `ssh2`, `utf-8-validate`. Three are declined because they produce nothing this project needs: `baileys` (engine-requirements check), `es5-ext` (prints a notice), `protobufjs`. Each entry carries an inline comment naming what its script actually does.

Two findings recorded while fixing it:

- **The failure was invisible to CI.** `ci.yml` installs with `npm ci` across all six jobs, so the pipeline never exercised the pnpm path that the bundled CLAUDE.md Quick Reference tells every agent to use. A green build proved nothing about it. The guard test exists because of this: without the pnpm path in CI, deleting the file or flipping a required entry to `false` would re-break the documented route without turning anything red.
- **The same allowlist in `package.json` under `pnpm.onlyBuiltDependencies` is silently ignored** by pnpm 11.5.1 — tried directly, install still exited 1 with all 13 still refused. The guard asserts that field is absent, so a later tidy-up cannot move the list somewhere that reads as configuration while doing nothing.

Deliberately not changed: which package manager this project standardises on. The docs say pnpm, CI uses npm, and both lock files are committed. That is an operator decision with consequences for contributors and the pipeline, and making the install work does not settle it. `packageManager` is also not added, because pinning it would make corepack authoritative over the `npm ci` jobs CI depends on — a regression risk for no benefit here. <!-- tracked: ACT-1613 -->

## Evidence

- **Reproduced before fixing**, on a branch off freshly-fetched `origin/main` (3c90a8a65, v1.3.1071), with the pre-existing untracked placeholder file moved aside so the measurement reflected true fresh-checkout state: `pnpm install --frozen-lockfile </dev/null` → `exit=1`, `ERR_PNPM_IGNORED_BUILDS` listing all 13.
- **After the fix:** `exit=0`, and the native builds genuinely ran — ssh2 compiled and linked its optional crypto binding (`SOLINK_MODULE(target) Release/sshcrypto.node`, "Succeeded in building optional crypto binding").
- **Idempotent:** immediate re-run `exit=0` in 152ms.
- **Build unaffected:** `pnpm build` → `exit=0`.
- **Guard test red-green verified on every failure mode rather than assumed:** passes as written (4/4); with `pnpm-workspace.yaml` hidden → 3 failures, first being "pnpm-workspace.yaml is required"; with `sharp: true` flipped to `false` → 1 failure naming sharp specifically; restored → 4/4 again.
