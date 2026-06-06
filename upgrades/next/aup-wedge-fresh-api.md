---
bump: patch
---

## What Changed

Second wedge-signature family + the API fresh-respawn lever, from the
2026-06-05 EXO 3.0 incident. A session whose transcript accumulated literal
red-team test payloads (generated during MTP security-harness work) got EVERY
reply rejected by the API's Usage Policy classifier — `API Error: … appears to
violate our Usage Policy` on each turn, because every turn re-sends the full
conversation. Same permanent-death shape as the thinking-block 400 (still
emitting output, so the silence + socket sentinels miss it), but the
ContextWedgeSentinel only knew the thinking-block signature, so it watched the
session die for an hour and said nothing. Recovery required hand-editing
`topic-resume-map.json` because `/sessions/refresh` did not forward `fresh`.

Now: `classifyWedgeTail()` recognizes both families and tags every sentinel
event with `kind` (`thinking-block-400` | `aup-rejection`) in the audit trail
and escalation wording. The AUP family carries an extra discriminator — the
signature must appear on MORE THAN ONE line (the loop always repeats; a benign
one-off rejection must not cost the session its conversation). And
`POST /sessions/refresh` accepts `fresh: true`, reaching the same
SessionRefresh fresh-mode the sentinel uses internally.

## What to Tell Your User

If a conversation ever dies the way the EXO session did — every reply
instantly refused by the AI provider because of what's accumulated in the
transcript — I now notice it, can recover it automatically with a fresh
restart (when auto-recovery is enabled), and explain what happened instead of
leaving you staring at "delivered" receipts with no answers.

## Summary of New Capabilities

- ContextWedgeSentinel detects the AUP-rejection loop (second signature
  family) with a repetition discriminator against benign one-off rejections;
  audit events + escalations carry the wedge kind. No configuration change —
  rides the existing `monitoring.contextWedgeSentinel` settings.
- `POST /sessions/refresh` accepts `fresh: true` — kill + respawn WITHOUT
  `--resume` (clears the topic's resume UUID), the recovery lever for any
  poisoned transcript.
- CLAUDE.md template + migration: existing agents learn about the second
  family, the API lever, and the prevention rule (adversarial payloads live in
  files on disk, never pasted into conversation transcripts).

## Evidence

Live incident recovery (2026-06-05, topic 19437): manual kill + resume-map
clear + fresh spawn verified end-to-end — fresh session answered immediately
where the wedged one had failed every turn for ~1h. Unit: 32 sentinel tests
(incl. both sides of the one-off-vs-loop boundary, kind tagging, escalation
wording per family) + 8 route tests (fresh validation, forwarding, 202 shape)
+ 3 migrator tests (fresh install carries the note; existing-section patch;
idempotency). Integration + e2e wedge suites green; tsc clean; preflight PASS.
