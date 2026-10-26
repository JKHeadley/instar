# Side-effects review: mark the telemetry-disable catch as a reported failure

- One-line comment change in `src/server/routes.ts`: adds `@silent-fallback-ok` to the
  telemetry-disable route's outer `catch`, which answers 500 with the error message.
- No runtime behaviour changes; the compiled output differs only by a comment.
- Restores `tests/unit/no-silent-fallbacks.test.ts` to its 494 baseline after #2367 moved the
  route so the catch's 20-line scan window reached the next route's `return null`.
- Signal vs authority: none involved; no gate, no message path, no state touched.
- Rollback: revert the commit; main returns to the red ratchet test, nothing else changes.
