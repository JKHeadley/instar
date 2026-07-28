# Side-Effects Review — Standby live-signal precedence

**Date:** 2026-07-16  
**Author:** instar-codey  
**Second-pass reviewer:** independent lifecycle review — concern resolved, then concurred

## Summary

Codex's live timer switches from `Working (NNs` to `Working (Nm NNs` after one minute, but the framework detector recognized only the first form. PresenceProxy then treated its empty child-process scan as permission for a tier-3 model verdict to override the terminal's affirmative live signal. The fix recognizes both timer forms and makes direct live evidence authoritative.

## Interaction review

- Idle Codex panes still do not match: the model name and composer remain excluded.
- Persistent action history such as `Ran` remains excluded from the live-only detector.
- A live-looking but unchanged pane is not treated as fresh; it retains the existing tier-3 model classification and deterministic fallback.
- Long-running and active child-process branches retain their existing higher-priority behavior.
- The change removes a tier-3 model call only when the live terminal already proves active work, reducing cost without weakening stuck detection.

## Rollback

Code-only revert. No state, schema, endpoint, or migration changes.

## Independent second pass

The reviewer caught that a single live-looking snapshot can itself be frozen. The first implementation would therefore have hidden a wedged pane forever. The precedence rule now additionally requires the tier-3 snapshot hash to differ from tier 2, and the E2E suite covers both changing and unchanged minute-form panes. With that correction, the reviewer concurred.
