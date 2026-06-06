# Sentinel recovery verification survives conversation-UUID rotation

## What Changed

The claudeSessionId bridge (instar session record ↔ Claude Code conversation
UUID) was write-once: the first hook event froze the UUID forever. A fresh
respawn or `claude --resume` rotates the conversation UUID, so after any
respawn the record pointed at a transcript that never grew — or never existed
(6 of 7 inspected records on the dev box were phantom). Both sentinels that
verify recovery by transcript growth (RateLimitSentinel, CompactionSentinel)
resolved that exact file, got null, and could NEVER observe a recovery: the
result was 6 futile resume nudges against actively-answering sessions and a
false "no jsonl growth after 6 attempts" escalation (2026-06-06 echo-api-errors
and echo-exo-3-0 incidents).

Fixes, root cause first:

1. The bridge is now last-writer-wins — every hook event carries the live
   conversation UUID, and the record updates on rotation (logged old → new).
   This also freshens every other claudeSessionId consumer (topic resume saves,
   reap guards) that always wanted the live conversation's id.
2. Both sentinels degrade a stale uuid (recorded transcript missing) to the
   newest-jsonl heuristic the no-uuid case already uses, instead of returning
   null — guaranteed-unverifiable is strictly worse than the shared accepted
   heuristic. Exact-uuid behavior when the file exists is byte-for-byte
   unchanged (sibling growth still doesn't count).

Regression tests replay the live incident on both sentinels plus the bridge
rotation; the sibling-precision guard is tested on the valid-uuid arm.

## What to Tell Your User

Nothing — housekeeping. The visible effect is the ABSENCE of noise: no more
repeated "throttle should have cleared — please continue" nudges landing in a
session that's already working, and no more false "still can't get through
after 6 tries" alerts on sessions that recovered fine.

## Summary of New Capabilities

- claudeSessionId bridge follows conversation rotation (last-writer-wins, logged).
- RateLimitSentinel + CompactionSentinel: stale-uuid → newest-jsonl fallback in
  recovery verification; false-escalation class on healthy sessions closed.

## Evidence

Reproduced live in production on 2026-06-06 (the bug was diagnosed FROM the
affected session):

- **Before:** `logs/sentinel-events.jsonl` 16:47:12Z→17:11Z — `throttle-detected`
  on echo-api-errors, then the full resume-nudge ladder (attempts 1–6, each
  "resume nudge injected via internal recovery channel") against a session that
  was actively answering its operator the entire time; the episode ends
  `throttle-escalated: "no jsonl growth after 6 attempts"`. The session record
  held `claudeSessionId = 563a7027-…` with NO such transcript on disk while the
  live transcript `a538d58f-….jsonl` grew throughout. Same morning, 09:26Z:
  echo-exo-3-0 falsely escalated `"no jsonl growth after 6 attempts over 22m"`.
  6 of 7 inspected exo-family session records pointed at phantom transcripts.
- **After (mechanism):** with the fallback, `readJsonlBaseline` resolves the
  growing live transcript (logged "stale claudeSessionId … falling back to
  newest jsonl"), so the first nudge's verify window observes growth and the
  episode finalizes `recovered` — regression tests replay exactly this shape on
  both sentinels (phantom uuid + growing sibling file ⇒ recovered, never
  escalated; verified to FAIL on pre-fix code). The bridge fix is additionally
  proven on the real SessionManager: rotation `first-uuid → second-uuid`
  persists (previously refused by the write-once guard).
- Post-deploy wild proof: the next real throttle on a respawned session should
  log `throttle-recovered` instead of a false escalation; the rotation log line
  (`claudeSessionId rotated for "<session>": old → new`) will appear on the
  first hook event after any respawn.
