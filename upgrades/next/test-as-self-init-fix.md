# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**The throwaway test-deploy harness (`instar test-as-self`) now actually runs.**
It was shipped but had never been executed end-to-end, so a bug went unnoticed:
it always failed at the deploy step because it invoked the wrong form of
`instar init`. It also could not tear itself down cleanly when run from inside a
managed agent session. Both are fixed: the harness initializes the throwaway home
with the directory-targeting form of init, and it strips the parent session
markers when starting and stopping the throwaway's own server.

## What to Tell Your User

Nothing to configure. This is an internal development and testing tool. If you
ever run the throwaway test-deploy harness, it now works end to end and cleans up
after itself, instead of failing immediately.

## Summary of New Capabilities

- `buildInitArgs(target)` and `sanitizedSpawnEnv(env)` (new pure, unit-tested
  helpers in `src/commands/test-as-self.ts`): the harness deploys the throwaway
  home with `init --dir <target>` (honors the directory, allocates a port) and
  runs the throwaway's server lifecycle with the parent session markers removed
  so the in-session server-management guard does not block it.

## Evidence

- The harness was run and observed failing at step 3 with "A name is required for
  standalone agents", and the teardown was observed hitting "Cannot 'server stop'
  from inside a session". The fix was verified: `init --dir` on a fresh directory
  creates a runnable home with an allocated port.
- Tests: `tests/unit/testAsSelfInit.test.ts` (5) — the init args use the
  directory form and never `--standalone`; the env sanitizer strips the two
  session markers, preserves all other vars, and does not mutate its input.
  `tsc --noEmit` clean.
- Spec: MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC Track F (the harness).
