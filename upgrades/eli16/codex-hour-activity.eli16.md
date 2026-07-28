# Codex hour-scale activity detection — plain-English overview

Codex displays a live timer while it works. Monitoring already understood the timer in seconds and minutes, but after a turn crossed one hour Codex changed the timer to a form like `10h 19m 44s`. The detector no longer recognized it, so genuinely active long work could look idle.

This change teaches the existing detector that exact hour format. It also prevents the ticking hour timer from looking like fresh model output by removing the duration before comparing successive terminal snapshots. Real new text still changes the comparison, so an unchanged, frozen working screen can still be recognized as stalled.

Nothing is enabled, configured, or migrated. It is a small parsing correction backed by the real hour-scale Codex display and focused tests for both live detection and stalled-output hashing.
