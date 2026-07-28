# Side-Effects Review - PromptGate blank pane capture

**Version / slug:** `promptgate-blank-pane-capture`
**Date:** `2026-06-05`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary

PromptGate now removes terminal-height padding from the bottom of a captured pane before applying its detection window. This lets the existing Gemini and package-runner prompt matchers see modal text that is followed by blank fill rows in a default-sized pane.

## Signal Versus Authority

This change improves the signal handed to existing prompt handlers. It does not add a new handler, does not change any safe-default or safe-reject policy, and does not expand what PromptGate is allowed to answer. The same modal patterns and dismissal keys are used after the capture is normalized.

## Runtime Side Effects

- Known Gemini safe-reject modals and `npx instar` package-runner prompts can be detected when the prompt text is above trailing blank terminal rows.
- Fingerprints are based on meaningful pane content instead of blank padding, which should reduce duplicate misses for the same visible prompt.
- Interior blank lines remain intact, so modal structure and command extraction are not flattened.

## Non-Effects

- No route, schema, persistence, API, or dashboard behavior changes.
- No session lifecycle behavior changes outside PromptGate detection.
- No new external service calls or credential handling paths.
- No change to the existing auto-dismiss keys for safe-default or safe-reject prompts.

## Nearby Sentinel Check

`RateLimitSentinel` does not appear to directly parse pane captures for this blank-fill shape. The rate-limit settled path in `SessionWatchdog` already filters blank lines before taking its tail sample. `StuckInputSentinel` uses a different prompt-text extraction path that scans for the prompt marker rather than only slicing the last few captured rows. Those nearby paths were noted but not changed in this fix.

## Rollback

Revert the PromptGate capture normalization helper and its regression tests. The pre-existing prompt matchers will continue to behave as they did before this patch.
