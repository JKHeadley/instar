# Side-Effects Review — Sentinel stale-uuid fallback + last-writer-wins bridge

**Version / slug:** `sentinel-stale-uuid-fallback`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `pending (Phase 3 review agents)`

## Summary of the change

Two-layer fix for the 2026-06-06 false-escalation incident (echo-api-errors: 6
futile resume nudges against an actively-answering session; echo-exo-3-0: false
"no jsonl growth after 6 attempts over 22m" escalation at 02:26 PDT):

1. `SessionManager.setClaudeSessionId` + the `/hooks/events` route guard change
   from write-once to last-writer-wins, so the claudeSessionId record follows
   conversation-UUID rotation (fresh respawn / `claude --resume`).
2. `RateLimitSentinel.readJsonlBaseline` + `CompactionSentinel.readJsonlBaseline`
   degrade a stale uuid (recorded transcript missing on disk) to the existing
   newest-jsonl heuristic instead of returning null (which made recovery
   verification permanently unable to succeed).

## Decision-point inventory

- Bridge update condition: `session.claudeSessionId !== payload.session_id`
  (route) / identical-id no-op (manager). Both sides tested.
- Sentinel baseline resolution: exact-uuid file exists → exact (unchanged);
  uuid recorded but file missing → newest-jsonl fallback (NEW); no uuid →
  newest-jsonl (unchanged). All three arms tested.

## 1. Over-block

Nothing new is rejected. The bridge accepts strictly MORE updates than before
(rotations were previously dropped). The sentinels accept strictly MORE
verification evidence than before.

## 2. Under-block / residual risk

- **Sibling false-positive on the fallback arm:** in a multi-session project
  root, the newest jsonl can belong to ANOTHER session, so a genuinely-stuck
  session with a stale pointer could be falsely marked "recovered" when a
  sibling produces output. This is the SAME accepted risk profile as the
  pre-existing no-uuid arm, it only applies while the pointer is stale (layer 1
  re-freshens it on the next hook event, typically within seconds on an active
  session), and the failure mode it replaces — guaranteed false escalation +
  6 wasted nudge-refires on healthy sessions — is strictly worse. A falsely
  "recovered" stuck session is still backstopped by ActiveWorkSilenceSentinel.
- **Stale event flip-back:** a late-arriving hook event from a dying old
  conversation could briefly flip the pointer backwards; the next event from
  the live conversation flips it forward again, and all consumers re-resolve
  per call (no cached snapshot), so the effect is transient.
- Sessions that emit no hook events (none expected — the reporter fires on
  every tool use/stop) keep whatever pointer they have; the sentinel fallback
  covers them.

## 3. Level-of-abstraction fit

The rotation fix lives at the single bridge chokepoint both consumers share
(`setClaudeSessionId` + its one route caller). The degrade-not-fail fix lives
inside each sentinel's existing `readJsonlBaseline`, the single resolution
point per sentinel; codex/gemini framework arms are untouched (they never used
the uuid path). No migration needed: the fix is pure server code; existing
stale records self-heal on the first post-deploy hook event per session.

## Rollback

Single revert of the PR restores write-once + null-on-missing exactly (no
state-shape changes, no config, no new files).

## Blast radius

Server-side only. No agent-installed files, no hook templates, no config
defaults, no CLAUDE.md template changes → no Migration Parity obligations.
Consumers of `claudeSessionId` (session resume save, reaper guards,
TopicResumeMap, sentinels) now see a FRESHER value — the value they were
always designed to expect.
