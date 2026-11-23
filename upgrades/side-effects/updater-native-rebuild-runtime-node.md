# Side-Effects Review — Self-updater rebuilds better-sqlite3 with the runtime Node

**Version / slug:** `updater-native-rebuild-runtime-node`
**Date:** `2026-11-21`
**Author:** `echo`
**Second-pass reviewer:** `not required` (no block/allow authority; no session lifecycle; no gate, sentinel, guard or watchdog logic)

## Summary of the change

Tier 1 (small, reversible). Two source files, four test files, ~130 LOC of source. One commit, one review round.

`src/core/UpdateChecker.ts`: `applySelectedUpdate` and `rollback` ran `npm install --ignore-scripts` and `npm rebuild better-sqlite3` through `execFile('npm', …)` with the server's inherited environment. `npm` is a `#!/usr/bin/env node` script, so npm, node-gyp and prebuild-install ran under whichever `node` was first on PATH, and node-gyp compiled for THAT node's ABI. `validateCandidate` then loaded the binding with the agent runtime (`.instar/bin/node`, else `process.execPath`). On the Echo Studio (2026-11-20/21) PATH's node was Homebrew Node 22 (ABI 127) and the runtime was Node 24 (ABI 137): every rebuild produced an unloadable binding, every candidate was refused, the machine stayed on 1.3.1944 (feedback fb-962cbcf0-0ae, fb-843b9795-666). New private helpers: `resolveRuntimeNode()` (the validator's lookup, now shared), `npmForRuntime()` (computes the invocation: the runtime node running its bundled `npm-cli.js`, PATH with the runtime node's directory first, `npm_config_nodedir` set when the install ships `include/node/node_version.h`; falls back to `npm` from PATH under the same PATH prefix with a `console.warn`), `findBundledNpmCli()`, and `npmExec(args, timeoutMs)` as the single npm seam. `execAsync` gains an optional `env` parameter.

`src/server/middleware.ts`: `buildRequestTimeoutOverrides` gains `'/updates/apply': UPDATE_APPLY_TIMEOUT_MS` (15 min). The route awaits the whole install (up to 3 × (120 s + 60 s) plus 5 s/15 s pauses, validation, migration); under the 30 s default the middleware answered 408 and the handler's real `res.json` was then logged as "Suppressed duplicate response send: POST /updates/apply". The routes.ts handler itself sends once; the duplicate came from the timeout middleware, so that is where the fix is.

## Decision-point inventory

No decision-point surface. The accept/refuse decision for an update (validateCandidate's startup + SQLite probe) is untouched; this change only makes the build target the Node that probe uses. The timeout override changes when a 408 is sent, not whether the update is applied.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The one input shape this could reject that it did not before: none. With a bundled npm the invocation is `<runtime node> <npm-cli.js> …`; without one it is `npm …` as before (plus a PATH prefix). If the runtime node's directory contains no `node` executable (impossible for a real node binary's realpath directory), the PATH prefix is inert.

---

## 2. Under-block

No block/allow surface. Residual failure modes this does not fix:
- A machine with NO C++ toolchain and NO prebuilt for the runtime ABI still fails the rebuild — the validator refuses it as before (correct, and the NativeModuleHealer's prebuilt-first path is a separate layer).
- `npm view instar version` in `check()` still uses PATH's npm; it has no ABI surface, so it is left alone. If `npm` is absent from PATH entirely, update checks fail as they do today (noted, out of this bug's shape).
- `npm_config_nodedir` is set only for the official-tarball layout (`<prefix>/include/node/node_version.h`). For other layouts node-gyp downloads headers for the running node's version — which is now the runtime node, so the ABI is still right.

---

## 3. Level-of-abstraction fit

Right layer. The updater owns the candidate build and already owns the validator's choice of Node; sharing that one lookup (`resolveRuntimeNode`) between build and probe is the minimal fix at the place the two diverged. The same class of fix already exists at the lower self-heal layer (`scripts/fix-better-sqlite3.cjs`, NativeModuleHealer, boot preflight — specs `fix-better-sqlite3-execpath.md`, `NATIVE-MODULE-HEAL-ABI-CORRECT-SPEC.md`); the updater was the remaining PATH-node callsite. The timeout override is in the single production override map (`buildRequestTimeoutOverrides`) that every long-running route uses, asserted by the existing wiring test.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It changes how a child process is invoked (binary, args, PATH, one env var) and one route's timeout budget. It neither produces nor consumes a signal and holds no authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The choice "bundled npm-cli.js if present, else PATH npm" is enumerable (a file exists or it does not), and the choice of Node is the validator's existing invariant.

---

## 5. Interactions

- **Shadowing:** none. The validator's probe still runs after the rebuild and still refuses a bad binding.
- **Double-fire:** none. `npmExec` is the only npm path in applySelectedUpdate and rollback; the existing fake-npm tests now spy that seam instead of matching `cmd !== 'npm'`.
- **Races:** none new. Same single sequential attempt loop and retry delays.
- **Feedback loops:** the AutoUpdater's `decideUpdatePause` (Local Verify pause while an update is pending) is fed by apply failures; fixing the apply removes a source of permanent pauses. fb-843b9795 also asks that an update which has already failed to install stop pausing Local Verify — that is a separate behavior in AutoUpdater, not changed here, and is left to that feedback record. <!-- tracked: fb-843b9795-666 -->
- **Timeout override:** `/updates/apply` is exact-or-child matched; `/updates/auto` and `/updates/rollback` keep the default (asserted in the test).

---

## 6. External surfaces

- Other agents on the same machine: each agent's updater builds against its own runtime node; no shared state.
- Install base: on every update after this one ships, the rebuild runs under the agent runtime. On machines where PATH's node already matched the runtime, the built binding is byte-for-byte the same ABI; only the invocation differs. On machines whose runtime node bundles no npm (version-manager installs usually do bundle one), a `console.warn` line appears once per npm call.
- External systems: none. No network behavior change (nodedir avoids a header download when headers are bundled).
- Persistent state: none new.
- Timing: `/updates/apply` callers now wait for the real answer (up to 15 min) instead of a 408 at 30 s. The dashboard and curl callers that previously received a 408 and polled `GET /updates/auto` keep working; they now may receive the status directly.
- Operator surface: no operator-facing actions added or touched.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design.** Which Node runs an agent, and which npm is bundled beside it, are machine-specific truths; the build must target the local runtime and nothing else. The pool effect is positive: a machine that could not update now rejoins the version line the pool is on (the Studio was the designated spender for the Gemini pay-per-use lane and could not run 1.3.1946). No user-facing notices are emitted by this change (the existing AutoUpdater "update didn't work out" notice fires less often). No durable state, no URLs. No `/status`, `/health`, `/capabilities` or `/channels` answer changes.

---

## 8. Rollback cost

Pure code change — revert and ship a patch. No persistent state, no migration, no agent state repair. If the new invocation were wrong on some layout, the validator would refuse the candidate exactly as it does today and the agent would keep running its current version; the log would name the Node and npm used.

---

## Conclusion

The review found the right layer (the updater's own build step) and confirmed the fix adds no authority: it aligns the build's Node with the validator's Node and otherwise leaves the accept/refuse logic alone. The one design adjustment made during review: route all npm calls through a single `npmExec` seam so the existing tests fake npm at that seam instead of matching on the literal command `npm`, which would have silently passed the rebuild through to a real npm. The duplicate-response log line was traced to the request-timeout middleware rather than routes.ts, so the fix landed in the production override map with a wiring test. Clear to ship.

Proportion: Tier 1; 2 source files + 4 test files; 1 review round; 1 commit attempt expected.

---

## Second-pass review (if required)

Not required.

---

## Evidence pointers

- Before the fix (src stashed): `tests/unit/update-checker-apply.test.ts` 3 new tests fail ("expected 'npm' to be '<runtime node>'", "expected '' to be '<runtime node dir>'"); `tests/unit/AgentServer-outbound-timeout.test.ts` 1 fails ("expected 30000 to be undefined"). After: 50/50 pass across both files.
- `tests/unit/UpdateChecker.test.ts -t "explicit version pinning"` and `tests/integration/native-update-preflight.test.ts` (real CLI + real SQLite probe) pass with the fake-npm seam moved to `npmExec`.
- Local Verify on a88b58b5d failed one e2e test, `tests/e2e/update-native-candidate-lifecycle.test.ts` ("keeps the old install and does not request a restart"): its npm fake keyed on `args[0] === 'install' | 'rebuild'` at the exec seam, and with the runtime node's `npm-cli.js` now first in args neither branch fired. Moved to the `npmExec` seam like the other two; the file passes.
- Second Local Verify run (723d23427) failed `tests/unit/development-artifact-update.test.ts` ("installs a verified snapshot and executes the real validation and promotion pipeline"): deterministic 3/3 on the PR head, 1/1 pass with origin/main's sources swapped in — real, same class. That test records every exec call (it asserts on the node `-e … SELECT 1` probe too), so it stays at the `execAsync` seam and now views each call from its npm subcommand onward, tolerating the leading `npm-cli.js`. 3/3 pass after. A repo-wide sweep of tests faking npm by the literal command or `args[0]` found no further instance.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. (The defect is in TypeScript source, not in a prompt, hook, config, skill or standards text; no self-triggered controller is added or modified.)
