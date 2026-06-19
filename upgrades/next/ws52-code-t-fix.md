<!-- slug: ws52-code-t-fix -->
<!-- bump: patch -->

## What Changed

Fixes the account-follow-me login link showing a placeholder (a URL ending in `code=t`) instead of a working Claude sign-in link. The long verification URL from `claude auth login` hard-wraps across tmux pane lines with no inserted space; the scrape that reads it stopped at the first wrap and kept only the head fragment. The login was always real — the scrape cut it short. Now `FrameworkLoginDriver.parseArtifact` re-joins wrapped URL fragments before matching, and the capture uses `tmux capture-pane -J` to join wraps at the source.

## What to Tell Your User

The "let another machine use this subscription" login link now comes through complete and usable, instead of a broken placeholder.

## Summary of New Capabilities

- No new capability — a correctness fix so the follow-me device-code login link is the full, usable URL.

## Evidence

- `tests/unit/framework-login-driver.test.ts` — NEW test re-joins the REAL captured (wrapped) Mac Mini login pane into the full URL and asserts it is NOT the `code=t` head fragment; 14 driver tests green.
- `tsc --noEmit` clean.
