# preflight lint package-manager resolution

## What Changed

`instar dev:preflight` launched its lint step with a hardcoded `pnpm lint`. Environments
that install with `npm ci` and have no pnpm — GitHub Actions CI among them — could not
start that step at all: it died with `spawn pnpm ENOENT`, and the preflight summary
reported that as a **lint failure**. A missing tool was being reported as broken code.

The lint step now resolves the package manager it can actually use: pnpm when available,
`npm run lint` otherwise. Both execute the identical `scripts.lint` chain, so no check
changes. When neither manager is usable the run fails and states `check DID NOT RUN`,
rather than continuing or reporting a pass — "this check passed" and "this check could
not run" must not look alike.

The neighbouring discoverability step already spawned `npx` and was unaffected; only the
lint step hardcoded a manager.

## Evidence

- Built `dist/` and ran the real CLI under `env -i PATH=<pnpm absent, npm present>` — the
  exact CI condition. It selects `npm run lint` and exits **0**.
- The known-fail control is the production CI log itself, which recorded
  `lint failed to start: spawn pnpm ENOENT` before this change.
- New unit tests cover pnpm-present, pnpm-absent, both-present, and neither. The neither
  case asserts the run does not report a pass and never spawns a lint step.
- The existing integration test's exact-command assertion is preserved; the resolver is
  injected at both call sites so the test does not become host-dependent.
- `tsc --noEmit` clean; 7/7 tests on the changed surface.

## What to Tell Your User

Nothing changes in how your agent behaves — this is contributor tooling, not runtime.
There is no new command, setting, message, or surface, and nothing you need to do.

If you contribute to instar and have ever seen the pre-pull-request check report a
linting failure you could not reproduce, that was most likely this: the linter never
ran at all, and the tool called that a failure. It now runs using whichever package
manager your machine actually has.

## Summary of New Capabilities

None — no new user-facing capability. `instar dev:preflight` now works on machines that
have npm but not pnpm, and reports a check it could not run as exactly that rather than
as a pass or a false failure.
