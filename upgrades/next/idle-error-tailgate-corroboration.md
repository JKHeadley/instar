<!-- bump: patch -->

## What Changed

CMT-1785: the idle-error detector that decides "did this paused session stall on a transient API
error (nudge it) or stop normally (leave it)?" is migrated from a brittle bare-substring scan to a
tail-gated, frame-discriminated SIGNAL.

- New pure modules `src/core/paneTail.ts` (shared `liveTail`/`stripLineLead`/`wasGlyphLed` — ONE
  definition of "the live tail", extracted so it is no longer copied per consumer) and
  `src/core/IdleErrorClassifier.ts` (`classifyIdleError`).
- The old gate `TERMINAL_ERROR_PATTERNS.some(p => recentOutput.includes(p))` (a bare `.includes()`
  over the whole capture) is replaced by `classifyIdleError`, which fires only when a terminal-error
  token sits in the live tail (last 20 non-empty lines) on a Claude-EMITTED error frame — a two-tier
  begins-with rule: **Tier A** the line begins with `API Error:`; **Tier B** the line is glyph-led
  (`⏺`/`⎿`/…) and begins with one of the 11 patterns. The match set is a strict subset of the old
  buffer-wide match, so the change can only SUPPRESS spurious fires, never add one.
- The idle-error capture is widened 30→45 rows (`RATE_LIMIT_SETTLED_CAPTURE_LINES`): Claude Code's
  input box + footer render 15-25 rows BELOW the error, so a 30-row capture could miss it entirely.
- `StuckSignatureClassifier` is migrated onto the shared `liveTail` (behavior-preserving via
  `.join('\n')`; its existing test corpus is the characterization guard).
- A once-per-idle-episode structured record (`{event:'idle-error-classify', result:'fired'|'suppressed', …}`)
  lands in `logs/server.log` so a wave of suppressions on genuine errors (the under-fire risk) is
  observable. Cleared in both the re-arm block and `sessionComplete` (no leak on the death path).

The signal still feeds the existing `apiErrorAtIdle` → `rateLimitSentinel` recovery actuator and gains
no blocking authority (Signal vs Authority).

## What to Tell Your User

Nothing you need to do. Under the hood, the agent got more reliable at telling a session that genuinely
stalled on an API error (which it nudges back to life) apart from one that's merely *showing* an old or
quoted error on screen. The old check was a blunt text search that sometimes kicked off a needless
recovery on a healthy session, and — more importantly — sometimes read too little of the screen and
missed a real stall. The new check looks at the live bottom of the screen, reads enough of it to clear
the input box, and only counts a line the tool actually emitted as an error. Net: fewer false recoveries
AND fewer missed real ones, so paused sessions get the right treatment faster. No new setting; behavior
is otherwise unchanged, and it's a one-line revert if ever needed.

## Summary of New Capabilities

- `paneTail` + `IdleErrorClassifier` — a precise, tail-gated, frame-discriminated idle-error signal
  replacing the bare buffer-wide substring scan; widened capture (45 rows) so the input-box chrome can
  no longer hide a real error; structured once-per-episode observability of fired-vs-suppressed
  decisions. Internal robustness improvement to session-stall recovery; no user-facing surface to
  configure.

## Evidence

- `tests/unit/IdleErrorClassifier.test.ts` (28) — both sides of every boundary, pinned to REAL captured
  render fixtures: fires on `⏺ API Error:` / `  ⎿  API Error:` / glyph-led network tokens / wrapped
  errors; suppresses stale-scrollback, prose mentions, quoted source literals (the self-collision case),
  a tool's own `Error: …ECONNREFUSED`; the 45-vs-30 input-box-chrome capture test; parametrized over all
  11 patterns; bounded audit fields; paneTail helpers.
- `tests/integration/idle-error-classifier-production-wiring.test.ts` (7) — the REAL exported
  `TERMINAL_ERROR_PATTERNS` produce correct decisions on real panes; the SessionManager call-site is
  wired to the classifier, the 45-row capture, the dual once-per-episode clears, and the structured record.
- `tests/e2e/idle-error-classifier-lifecycle.test.ts` (2) — the real SessionManager constructs and the
  `apiErrorAtIdle` recovery handoff is attachable; the production-pattern live decision is correct.
- `tests/unit/monitoring/StuckSignatureClassifier.test.ts` (13) — unchanged, the characterization guard
  proving the shared-`liveTail` migration is behavior-preserving.
- `npm run build` + `tsc --noEmit` clean; full unit suite green.
- Driven by the converged + approved spec; convergence report at
  `docs/specs/reports/idle-error-tailgate-corroboration-convergence.md` (4 rounds; the review caught a
  CRITICAL under-fire-on-the-common-error-form flaw before any code).
