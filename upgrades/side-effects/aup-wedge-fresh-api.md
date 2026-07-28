# Side-Effects Review — AUP-Rejection Wedge Signature + Fresh-Respawn API

**Version / slug:** `aup-wedge-fresh-api`
**Date:** `2026-06-06`
**Author:** `Echo (instar-dev agent, session-robustness topic per Justin's "work on more robust ways to handle these scenarios")`
**Second-pass reviewer:** `self-adversarial pass over the one-off-vs-loop boundary (the only place this change could destroy user state)`

## Summary of the change

ContextWedgeSentinel learns a second wedge-signature family — the AUP-rejection
loop (2026-06-05 EXO incident) — via `classifyWedgeTail()`, which returns the
matching family for the live tail and tags every event/escalation with `kind`.
The AUP family requires the signature on >1 line of the capture (the loop
repeats every turn; a benign one-off rejection appears once). `POST
/sessions/refresh` forwards a validated `fresh` boolean to
`SessionRefresh.refreshSession` — the previously-internal-only fresh-mode.
CLAUDE.md migrator patch teaches deployed agents both additions. Files:
`ContextWedgeSentinel.ts`, `server.ts` (wiring detail strings), `routes.ts`,
`PostUpdateMigrator.ts`, spec doc, three test files.

## Decision-point inventory

- AUP tail classification — **add (detector)** — new signal only; same confirm
  window + same opt-in recovery policy as the existing family.
- One-line AUP occurrence — **deliberate non-detection** — a benign one-off
  rejection must never cost a session its conversation; the wedge always
  repeats, so the second occurrence arrives within one failed turn.
- `fresh` route param — **add (lever, validated)** — exposes an existing
  internal mode; same spawnLimiter + SessionRefresh rate-guard as every
  refresh.

## 1. Over-block

None added. Detection alone never kills anything (autoRecovery ships dark,
unchanged). The worst over-detection case — a session DISCUSSING the AUP error
with two quoted copies in its tail — is covered by the same two defenses as the
thinking-block family (tail gate + 45s no-progress confirm window): a working
session scrolls the signature out before confirm.

## 2. Under-block

(a) A genuinely-wedged session whose FIRST rejection is the only one on screen
is not detected until the next inbound message produces the second copy —
bounded by one message turn; accepted to protect one-off conversations.
(b) A wedge whose error text the provider rewords escapes both families —
inherent to signature-based detection; the turn-receipt structural close is
tracked separately (CMT-1115 follow-up design).

## 3. Level-of-abstraction fit

The family lives inside the existing sentinel (same lifecycle, confirm window,
recovery, veto integration) rather than a 5th sentinel — the failure shape is
identical; only the signature differs. `kind` is data on existing events, not
a new event vocabulary. The route param reuses `RefreshOptions.fresh` which
SessionRefresh already owned; the route stays a thin validated entry point.

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

- [x] No new authority. The detector is a signal; recovery policy (detect-only
  / dry-run / live) is unchanged and opt-in. The `fresh` param is operator/agent
  initiative through an already-rate-guarded lever; the route grants no new
  capability that the sentinel wiring didn't already exercise.

## 5. Interactions

- **SessionReaper veto:** `isRecoveryActive` covers AUP wedges identically
  (state machine is shared) — the reaper can't kill a session mid-recovery.
- **Sentinel audit:** `kind` lands in `logs/sentinel-events.jsonl` detail
  strings; existing consumers parse free-text detail, no schema break.
- **`fresh` + followUpPrompt:** unchanged interaction — fresh clears the resume
  entry after the kill persists it; respawner then spawns clean (SessionRefresh
  ordering, already tested).
- **Back-compat:** `signatureIsTail()` boolean wrapper preserved — all existing
  callers/tests pass unmodified (81 green pre-existing + new).

## 6. External surfaces / 7. Rollback

One new accepted body field on an existing authed route (400 on non-boolean);
response gains `fresh` echo. No schema/config/persistent state; migrator patch
is append-only + idempotent (marker: 'AUP-rejection wedge'). Rollback = revert;
the second family goes blind again and fresh-respawn returns to internal-only.
