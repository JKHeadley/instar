# Side-Effects Review — five modules that threw at load, and a guard that could not see it

**Version / slug:** `ssh2-cjs-named-imports`
**Date:** `2026-07-26`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `see Phase 5`

## Summary of the change

`ssh2` is CommonJS. Five files took named VALUE imports from it
(`import { Server, utils } from 'ssh2'`). Node's ESM loader cannot statically detect
CJS named exports, so each of those modules threw at load. Observed at every server
boot, warning-level, surfaced nowhere:

```
[mutual-ssh] initialization blocked: The requested module 'ssh2' does not provide
  an export named 'Server'                                    (server.ts:21596)
[peer-execution] disabled-grant cleanup blocked: Named export 'utils' not found.
                                                              (server.ts:21491)
```

Fix: default-import the namespace, destructure at runtime, keep the type import
type-only (types are erased, so `import type { Connection }` is safe and unchanged).

Verified against the built output under Node's real loader — all five previously
threw, all five now load:

```
$ npm run build && node --input-type=module -e "…await import('./dist/core/'+m+'.js')…"
  LOADS   PeerAuthorizedKeys / MachineSshEndpoint / MutualSshVerifier
  LOADS   StandingSshVerifier / SshBootstrapAdvert
```

## The guard is a source scan, and that was not the first attempt

The obvious regression guard — import each module, assert no throw — was written,
passed, and was **wrong**. Reverting one file to the broken form left it fully green:

```
$ npx vitest run tests/unit/ssh2-modules-load-under-esm.test.ts   # BROKEN source
  ✓ (8 tests) — Tests  8 passed (8)
$ npx tsc --noEmit                                                # BROKEN source
  tsc exit=0
$ node --input-type=module -e "import { Server } from 'ssh2';"
  SyntaxError: Named export 'Server' not found…
```

Vitest transforms through Vite, which rewrites CJS interop; production runs the
compiled output under Node's loader, which does not. An in-process import assertion
is **structurally incapable** of observing this class — it does not merely miss it.
`tsc` is blind for a different reason: the types are genuinely correct.

The replacement scans source text for named value imports from a CJS allowlist. It
refuses correctly:

```
$ npx vitest run …   # after reverting src/core/MutualSshVerifier.ts
  × REGRESSION: no source file takes a named value import from a CJS-only package
    → core/MutualSshVerifier.ts: import { Client, utils } from 'ssh2'
  Tests  1 failed | 5 passed (6)
```

## Decision-point inventory

| point | classification | note |
|---|---|---|
| import form per file | `invariant` | Mechanical; no runtime branch introduced. |
| scan allowlist (`CJS_ONLY_PACKAGES`) | `invariant` | Explicit list, currently `['ssh2']`. Deliberately not auto-derived — see §2. |
| comment/string stripping before match | `invariant` | Asserted by a test using this file's own prose. |

No judgment points. No model call. Nothing gates or blocks at runtime.

## 1. Over-block

The scan is the only thing that can refuse, and it refuses at test time, never at
runtime. Its over-block risk is flagging an innocent file whose *prose* contains the
forbidden shape — the known weakness of text checks, and one this codebase has been
bitten by three times. Closed by stripping comments and string literals first, with a
test that feeds it this very file's description of the bug and asserts zero matches.
Both safe forms (`import ssh2 from 'ssh2'`, `import type { … }`) are asserted to pass.

## 2. Under-block

**The allowlist is manual.** A named value import from some *other* CJS package is
not caught. Auto-deriving it (reading every dependency's `package.json` type field)
was considered and rejected for this change: it turns a two-line list into a
resolution problem with its own failure modes, and would have shipped untested. The
list is the honest, visible limit. <!-- tracked: CMT-1044 -->

**It scans `src/` only.** Scripts, hooks, and templates are not covered.

**Loading is not working.** This proves five modules load. Whether `mutualSshRuntime.start()`
then binds, finds keys, and reaches a peer is untested here and is NOT claimed. The
precise claim: the channel could not have worked before, and one specific blocker is gone.

**The guard cannot see the compiled reality.** A source scan infers the runtime
failure from the source shape. The direct check — importing built output under Node —
runs in this review but is not wired into CI, because it requires a build step the
unit shard does not have.

## 3. Level-of-abstraction fit

The fix is at the only possible layer: the import statements themselves. The guard sits
in the unit shard, which is where a cheap always-runs check belongs. A lint rule
(`eslint-plugin-import`) would be the more conventional home; it is not adopted here
because the repo has no such plugin configured and adding one is a larger change than
the bug warrants.

## 4. Signal vs authority compliance

No runtime authority is introduced or moved. The change removes a load-time crash; it
adds no gate, no branch, no decision. The test-time scan holds authority over CI only,
which is the appropriate place for a brittle text check per `docs/signal-vs-authority.md`
— brittleness is acceptable when the blast radius is a red build, not a blocked action.

## 4b. Judgment-point check (Judgment Within Floors standard)

None introduced.

## 5. Interactions

- **`MutualSshRuntime` / mesh transport** — unchanged. This only lets its dependencies load.
- **`guardRegistry`** — see §6b. Not modified here.
- **Type imports** — `import type { Connection, Server as SshServerType }` retained in
  `MachineSshEndpoint.ts`; `Server` needed splitting into a value binding and a type
  alias because it is used as both. Caught by `tsc`, not by me.

## 6. External surfaces

None. No route, no config key, no log line, no user-visible message, no persisted state.

## 6b. Operator-surface quality — the finding this change does NOT fix

`multiMachine.mutualSsh.enabled` registers itself with `guardRegistry` **inside** the
try block that threw. So the failure removed itself from the inventory built to catch
exactly this. Confirmed against the live pre-fix server:

```
total guard rows: 88
mutualSsh/peerExecution rows: 1   →  multiMachine.peerExecution.enabled
```

`mutualSsh` has no row at all — not "off", not "errored", absent. This is the same
shape as tonight's relay defect (a dropped connection left "connected" as the only
record): **the defect deletes its own evidence.** Registering guards before the
fallible construction, so a crashed subsystem still appears as `errored`, is a real
change to a shared registry and is deliberately not bundled here. <!-- tracked: CMT-1044 -->

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design — a module either loads in this process or does not. No
replication, no lease interaction, no shared state, no generated URL. The *feature*
being repaired is cross-machine, but this change to it is not.

## 8. Rollback cost

Low. Five import statements and one test file. No migration, no persisted state, no
config default, nothing installed into an agent home. Reverting restores the previous
behaviour exactly — a warning at boot and a dead channel — and the guard would fail
loudly on the way, which is the intended announcement.

## Phase 5 — Second-pass review

Touches no block/allow decision, no session lifecycle, no trust level, no gate or
sentinel, so the high-risk trigger list is not engaged. Author-applied lenses, disclosed:

**Adversarial — "how would I make this useless?"** By writing a guard that cannot
observe the failure. I did exactly that on the first attempt, and only caught it
because the refusal step is mandatory rather than optional. Recorded in §2 as the
central lesson rather than quietly replaced.

**"Did I fix the symptom or the cause?"** The cause, for the load failure. Not for the
invisibility — §6b is the cause of *why nobody noticed for so long*, and it is left
open and tracked rather than half-done.

**"Would it have caught the incident?"** The guard would have failed the build the day
the named import was introduced. It would not have surfaced the boot warning; nothing
here changes observability.

**Weakest point:** §2's last item. The scan infers a runtime property from source
text. The direct check exists and passes, but runs by hand in this review rather than
in CI — so the thing CI actually enforces is one inference removed from the thing that
broke.
