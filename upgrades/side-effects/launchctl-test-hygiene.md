# Side-Effects Review — launchctl load test-hygiene guard (MM-Bootstrap Track C follow-up)

**Scope.** `src/commands/setup.ts` (new `launchctlLoadAllowed()` helper + guard
at the 2 install-path `launchctl bootstrap` sites: installMacOSLaunchAgent +
installFleetWatchdog), `tests/unit/launchctl-load-guard.test.ts` (new).

**Problem.** The Track C unit test (merged #470) writes a LaunchAgent plist via
`installAutoStart` to verify the Label-keyed-replace property. But
`installMacOSLaunchAgent` does a real `launchctl bootstrap` (load) after writing
— so the test loaded tmpdir-pointed plists into the operator's REAL launchd,
leaving stale `ai.instar.mmtesthandoff` / `ai.instar.mmteststandby` entries
(status 78, program gone) after the tmpdir was cleaned. Inert but real
test-pollution of the user's launchd, discovered 2026-05-28.

**Fix.** `launchctlLoadAllowed()` returns false under a test runner (vitest
auto-sets `VITEST`) or when `INSTAR_SKIP_LAUNCHCTL_LOAD` is set. The two
install-path bootout+bootstrap blocks are wrapped in it. The plist file is still
written/removed; only the LIVE load is gated — so the unit-under-test (plist
content) is unaffected, and production (neither flag set) loads normally.

**Side-effects review.**
- **No production behavior change** — in a normal environment neither VITEST nor
  INSTAR_SKIP_LAUNCHCTL_LOAD is set, so `launchctlLoadAllowed()` is true and the
  load happens exactly as before.
- **Tests no longer pollute real launchd** — verified: re-running the Track C
  test creates NO mmtesthandoff/mmteststandby entries (the guard skipped the
  load), and the test still passes (it asserts plist CONTENT, not live load).
- **uninstallAutoStart's bootout is intentionally NOT gated** — that's cleanup
  (removing a real entry), correct to keep even in tests; only the install-path
  LOAD is the pollution vector.
- **Minimal surface** — one helper + two wraps; no new dependency.

**Test coverage.** Unit `tests/unit/launchctl-load-guard.test.ts` (3): false
under VITEST, false under INSTAR_SKIP_LAUNCHCTL_LOAD, true when neither set
(production). Plus the existing Track C test now verifiably runs without
pollution.

**Migration parity.** Server source (setup.ts) — existing agents pick up on
auto-update. No agent-installed-file change; production load behavior unchanged.

**Rollback.** Revert. Tests would resume polluting real launchd (inert stale
entries). No production impact either way.
