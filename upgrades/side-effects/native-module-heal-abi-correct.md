# Side-effects review — native-module heal: ABI-correct, prebuilt-first, no-brick

**Spec:** `docs/specs/NATIVE-MODULE-HEAL-ABI-CORRECT-SPEC.md`
**Changes:** `src/lifeline/ServerSupervisor.ts` (preflight), `src/memory/NativeModuleHealer.ts` (runtime) + unit tests
**Class:** fleet self-heal correctness fix (better-sqlite3 ABI rebuild).

## What changed

Both better-sqlite3 rebuild paths now:
1. **PATH-pin** the rebuild env to the server/running Node's dir (+ `npm_node_execpath`) so node-gyp / prebuild-install target the correct ABI regardless of PATH ordering.
2. **Prefer the prebuilt**: try `npm install better-sqlite3@<ver> --no-save --prefix <dir>` (runs prebuild-install → correct-ABI prebuilt, no compiler) before falling back to `npm rebuild --build-from-source --ignore-scripts`.
3. **Preflight only:** back up the existing binary and restore it if no attempt yields a loadable module (no-brick).

## Blast radius

- **Healthy agents:** unchanged — the rebuild is still gated on the existing load-test (a loadable module → no rebuild). The fix only changes HOW a genuine ABI mismatch is repaired.
- **`NativeModuleHealer.healBetterSqlite3Sync` return contract:** unchanged (boolean; caller retries the open). Now succeeds via the prebuilt where it previously failed to compile.
- **Preflight rebuild outcome:** unchanged when already healthy; on mismatch, now produces a correct-ABI binary (or restores the prior one on total failure) instead of a wrong-ABI / deleted binary.
- **Public API / DB schema / config:** none changed.

## What could break (and why it doesn't)

- **Supply chain:** the prebuilt attempt runs better-sqlite3's install script (the standard way the package is obtained), version-pinned, single package. The from-source fallback keeps `--ignore-scripts`.
- **Extra packages under the prefix:** `npm install better-sqlite3` may add prebuild-install's dep tree under the prefix's node_modules. Benign (those are better-sqlite3's own install deps) and only on the mismatch path.
- **`npm install --prefix shadow-install`:** adds/updates better-sqlite3 in the existing tree; does not prune `instar` or its deps.

## Security

No new external input / network / auth / fs surface beyond the npm install of a pinned, well-known package (already a transitive dep of instar). The PATH change is scoped to the rebuild subprocess env only.

## Migration parity

Server-internal lifeline/monitoring code — every agent gets the corrected self-heal by running the new build. No PostUpdateMigrator entry required.

## Rollback

Revert the commit. No persisted state or schema affected; the load-test gate is unchanged.

## Tests

`tests/unit/server-supervisor-preflight.test.ts` (+3: PATH-pin, prebuilt-first, restore-on-failure) and `tests/unit/NativeModuleHealer.test.ts` (+1: prebuilt-first + PATH-pin). 32 tests across the two files green; existing 37 healer tests + preflight tests still pass; `tsc --noEmit` clean. At-scale: `npm install better-sqlite3@12.10.0` (PATH-pinned) fetched the ABI-141 prebuilt in ~2s on the affected box.

## Fix-forward note (CI green-up)

The first cut of this change (shipped functionally in v1.3.100) tripped two CI
checks that are non-functional: (1) the destructive-tool-containment lint —
the backup cleanup/restore used direct `fs.unlinkSync` instead of
`SafeFsExecutor.safeUnlinkSync`; and (2) a stale source-text test
(`version-skew-recovery.test.ts`) that asserted the rebuild "uses
--build-from-source" as its only strategy — the exact policy this change
replaces with prebuilt-first. This follow-up swaps the `fs.unlinkSync` calls for
`SafeFsExecutor.safeUnlinkSync` and updates that test to assert the new
invariants (ABI-pinned + prebuilt-first, with `--build-from-source` retained as
the compile fallback). Pure compliance/test correctness — no runtime behavior
change beyond what v1.3.100 already shipped.
