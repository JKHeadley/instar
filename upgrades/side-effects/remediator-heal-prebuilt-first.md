# Side-effects — Remediator better-sqlite3 heal: prebuilt-first

## 1. What files/state does this touch at runtime?
Only the better-sqlite3 native module under the agent's install prefix
(`<prefix>/node_modules/better-sqlite3/...`), and ONLY when the W-1
`supervisor-preflight` remediation runbook invokes
`NativeModuleHealer.healBetterSqlite3FromRemediator` — i.e. when a genuine
NODE_MODULE_VERSION ABI mismatch is detected. No config keys, no schema, no other
files. The post-rebuild sha256 is recorded in the existing in-line heal log
(unchanged behavior).

## 2. Does it change any functional behavior?
Yes, narrowly: the remediator heal now attempts the **prebuilt** (`npm install
better-sqlite3@<pinned> --no-save`) BEFORE the from-source compile (`npm rebuild
--build-from-source --ignore-scripts`), and pins the toolchain PATH to the running
Node's directory. Outcome on success is identical (a loadable, correct-ABI
module). The change makes the path able to heal on a box without a C++ toolchain,
which it previously could not.

## 3. What happens on failure / unwritable path / non-toolchain box?
- No toolchain: the prebuilt attempt heals it (the whole point). If the prebuilt
  fetch also fails (e.g. no network / no prebuild for that ABI yet), it falls back
  to the from-source compile exactly as before.
- Both attempts fail: returns `{outcome: 'failure', ...}` with the last npm
  stderr tail — identical failure contract to before (the verify step decides
  next action; nothing is bricked).
- Abort signal fires mid-heal: honoured at the top of each attempt; an
  already-aborted signal short-circuits.

## 4. Migration parity — do existing agents get it?
Yes, automatically. This is shipped code in `dist/` — every agent picks it up on
its next instar update via the normal shadow-install. No PostUpdateMigrator change
needed (no agent-installed file/config/hook/skill is touched).

## 5. Could it spam / flood / burn resources?
No — the opposite. The prebuilt fetch (~2s) replaces a ~30s+ node-gyp compile as
the first attempt, and the path only runs on a real ABI mismatch (gated by the
remediator runbook + once-per-process guard). It does LESS CPU work than before,
and it stops the multi-hour launchd restart-loop that a non-healable path caused.

## 6. Rollback / off-switch?
Revert the PR. The two sibling heal paths are unaffected. No new flag, no residual
state. The whole remediator path is already gated behind the SelfHealingRemediator
(largely dark by default), so blast radius is small even before rollback.

## 7. Concurrency / ordering?
Unchanged from the prior implementation: a single spawnSync loop inside the
existing async method, honouring `ctx.abortSignal`. The once-per-process heal
guard (`healAttempted`) still prevents re-entry. No new shared state.

## Blast radius
Minimal + consistency-increasing. One method body in
`src/memory/NativeModuleHealer.ts` (+ two docstring corrections), mirroring two
already-shipped heal paths. Two unit tests updated/added; 96 healer/remediator
tests green. No route, sentinel, schema, config, or migration surface changes.
Spec note: relaxes the aspirational (unimplemented) §A45/§7.1 "build-from-source
preferred" stance — documented in the spec + V3 spec annotation for review.
