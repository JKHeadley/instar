# Upgrade Fragment — realcheck-utf8-macos-portability

<!-- bump: patch -->

## What Changed

The autonomous stop hook's real-check verification runner is now portable across the
timeout-ladder rungs on the exit-status contract for signal-death. On macOS (no GNU
`timeout`/`gtimeout`), the perl fallback rung mapped a check command killed by a signal to
exit 0 via `exit($?>>8)` — the signal lives in the LOW byte of the status word, so the
high byte is 0. The routine trigger is SIGPIPE: the capture pipeline byte-caps combined
output at the source (`head -c`), and a verbose check still writing when the cap closes
the pipe dies from signal 13. The failing check was then scored PASS and the hook
**allowed the autonomous session to exit early** — a cardinal-invariant violation
(any verification failure must route to keep-working). Linux was unaffected because GNU
`timeout` maps signal-death to 128+signal (141, non-zero → FAIL). The perl rung now uses
the same mapping: `exit(($?&127) ? 128+($?&127) : ($?>>8))`. Timeout (124), spawn-fail
(127), and normal exits are unchanged.

Same chain, second portability fix: macOS iconv `-c` emits the correctly-scrubbed UTF-8
prefix but exits non-zero when the byte cap truncated a trailing multibyte character; the
old exit-code `||` fallback then ALSO ran the C-locale printable filter and appended its
output (a text-duplication hazard). The fallback now triggers only when iconv produced no
output from non-empty input. The pinned sanitize → UTF-8 scrub → leak-scrub → clamp order
is unchanged.

This also fixes the deterministic macOS-only failure of
`tests/unit/autonomous-stop-hook-realcheck.test.ts` ("invalid-UTF-8 capture … → next
payload still builds") — the shipped hook was fixed; the test was not weakened.

## What to Tell Your User

Nothing visible changes in day-to-day use. On Macs, autonomous work sessions are now
stricter about proving they're really done: a verification check that gets cut off
mid-output can no longer be mistaken for a passing check, so a session can't slip out
early on a technicality. Sessions that genuinely finish and pass their checks behave
exactly as before.

## Summary of New Capabilities

- No new capabilities — a safety/portability fix. The autonomous completion guarantee
  ("a failing real check always means keep working") now holds identically on macOS and
  Linux.

## Evidence

- Instrumented reproduction on macOS 26 (Node 24): the shipped hook returned the
  allow-exit message for `printf "\xe4\xb8\xad%.0s" $(seq 1 100000); exit 1`
  (`PIPESTATUS[0]=0` from the perl rung) before the fix; after the fix it returns a valid
  JSON `block` decision carrying the DATA-labeled, scrubbed, clamped output.
- `tests/unit/autonomous-stop-hook-realcheck.test.ts`: 24/24 pass on macOS (previously
  1 deterministic failure); all sibling stop-hook suites (9 files, 95 tests) and the
  `PostUpdateMigrator` autonomous-hook suites (24 tests) pass.
- Full push suite (`vitest.push.config.ts`) run from the worktree: zero failures.
