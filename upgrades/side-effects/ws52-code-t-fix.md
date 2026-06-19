# Side-Effects Review — WS5.2: re-join line-wrapped verification URL (code=t fix)

**Version / slug:** `ws52-code-t-fix`
**Date:** `2026-06-18`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required (pure scrape-parse fix + a source-side capture flag; no decision/auth surface)`

## Summary
The follow-me device-code login link surfaced as a placeholder ending in `code=t`. Root cause: the long Claude OAuth URL from `claude auth login` hard-wraps across tmux pane lines with no inserted space (`...?code=t` then `rue&client_id=...`); `FrameworkLoginDriver`'s `URL_RE` stopped at the first wrap. Fix: `parseArtifact` re-joins wrapped URL fragments before matching (pure, unit-tested against the real captured pane); the injected `capture` now uses `tmux capture-pane -J` to join wraps at the source. Files: `src/core/FrameworkLoginDriver.ts`, `src/commands/server.ts`, `tests/unit/framework-login-driver.test.ts`.

## 1. Over-block / 2. Under-block
No block/allow surface. The de-wrap only affects which characters of a verification URL are captured. Under-block: a URL containing internal whitespace would not be a single wrapped token, but real URLs have none; the join stops at the first whitespace/blank line, so non-URL output is never absorbed.

## 3. Level-of-abstraction fit
Correct — the fix is in the pure scrape parser (where the bug is) + the source capture flag. No higher layer involved.

## 4. Signal vs authority compliance
No authority. Pure text parsing; reads only the PUBLIC verification URL (never a token). Strictly a correctness improvement.

## 5. Interactions
`parseArtifact` is also used for Codex device-code + already-unwrapped URLs — covered by existing + new idempotency tests (an unwrapped URL is unchanged). The `-J` capture is scoped to the enrollment login driver only; generic captures are untouched.

## 6. External surfaces
The operator now receives the full, usable login URL instead of a placeholder. No token exposure (unchanged). No new endpoint.

## 7. Multi-machine posture
Machine-local: each target machine scrapes its own login pane. No cross-machine state. Both machines get the fix via the normal deploy.

## 8. Rollback cost
Revert; ship a patch. Pure code, no persistent state.

## Conclusion
Small, pure, well-tested fix to the actual blocker that made the surfaced login link unusable. 14 driver tests green incl. the real wrapped-pane fixture; tsc clean.
