# Side effects — fix `instar test-as-self` (init invocation + teardown env)

## What was broken

`instar test-as-self` (the Track-F throwaway-deploy harness) **failed at step 3
on every run** — it was shipped but never actually executed end-to-end, so the
bug was never caught. Two defects, both in `src/commands/test-as-self.ts`:

1. **Step 3 used the wrong init invocation.** It called
   `init --standalone --dir <target>`, but `init --standalone` *requires a
   positional name* and routes to `~/.instar/agents/<name>` (ignoring `--dir`).
   Result: `init` exited with "A name is required for standalone agents" and the
   harness reported `VERDICT: FAIL (step 3)` unconditionally.
2. **Teardown's `server stop` was refused.** The teardown ran
   `server stop` inheriting the caller's `INSTAR_SESSION_ID`, tripping instar's
   "don't start/stop/restart the server from inside a managed session" guard
   ("Cannot 'server stop' from inside a session"). Step 4's spawn already
   stripped those markers; teardown did not.

## The fix

Two pure, exported, unit-tested helpers:
- `buildInitArgs(target)` → `['init', '--dir', target]` — non-standalone init,
  which honors `--dir`, allocates a port, and writes `<target>/.instar/config.json`
  (verified: `init --dir /tmp/fresh` created a runnable home with a port). Step 3
  uses it.
- `sanitizedSpawnEnv(env)` → env minus `INSTAR_SESSION_ID`/`INSTAR_JOB_SLUG`.
  Used by the step-4 spawn (replacing the inline delete) AND the teardown's
  `server stop`, so the throwaway's own server lifecycle is never blocked by the
  parent session's guard.

## Who is affected

- **Anyone running `instar test-as-self`:** it now gets past step 3 and can tear
  down cleanly. Before, it was unusable (failed immediately). No other behavior
  changes; no flags added/removed.
- **The Track-E two-machine proof:** this harness is its bring-up tool, so this
  is a prerequisite unblock.

## Blast radius

- 1 source file: `src/commands/test-as-self.ts` (two helpers + three call sites:
  step 3, step 4, teardown). No config/schema/migration. No other command
  touched (`init`/`server` unchanged — only how the harness invokes them).

## Failure modes considered

- **Does `init --dir` on a fresh empty dir work?** Yes — verified live: it
  allocates a port and writes `.instar/config.json` (no empty-dir rejection; the
  only `process.exit` in that path is the prerequisite check, met on a dev box).
- **Side effect of `init --dir`:** it registers the throwaway in the global agent
  registry + creates a machine identity. That is the existing `init` behavior,
  unchanged by this fix; teardown signals the server but does not unregister the
  global entry, so a throwaway leaves a registry row (harmless; under
  `~/.instar/test-deploys`).
- **Env sanitization too aggressive?** No — it strips only the two session
  markers that trip the guard; every other var (PATH, HOME, …) is preserved, and
  the input object is not mutated (both asserted in unit tests).

## Tests

`tests/unit/testAsSelfInit.test.ts` (5): `buildInitArgs` returns `init --dir`
(never `--standalone`); `sanitizedSpawnEnv` strips both markers, preserves other
vars, does not mutate input. `tsc --noEmit` clean. The step-3 premise (`init --dir`
yields a runnable home) was additionally verified by a live run.

## Scope boundary

This change covers the step-3 init invocation and the teardown env. The harness's
step-4 server-start runs the throwaway's server under whatever `node` invokes the
harness, so it is subject to the same native-module (better-sqlite3) node-ABI
matching as any instar server — a property of the runtime, orthogonal to this
change.
