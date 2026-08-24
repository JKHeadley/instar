# Window 25 charter: CONVERSION — ACTIVE

**Status: ACTIVE.** Approved by Justin in topic 36966 at 2026-08-23 20:53Z ("yes, go."). Drafted
~20:40Z by Observer 1 per the joint tenet-9 recommendation (combined package delivered 20:39Z;
Observer 2 concurrence with three amendments on record in topic 43003 at 20:37:09Z). Window opened
2026-08-23 ~20:55Z. Roles: Pathway (topic 29723) orchestrates; Codey workers execute
integration/test/deploy mechanics; Observer 1 (topic 36966) observes and reports to Justin
3-hourly in plain language; Observer 2 (topic 43003) reviews independently on request.

## Headline (Observer 2's words, adopted verbatim in substance)
"Next window turns selected, already-proven repairs into one coherent live release, and it cannot
close until both the running system and the canonical plan prove the conversion happened."

## Opening act (before any lane starts)
Write Window 24's honest close onto the canonical plan document ("Where this project stands",
Mini view 3a08766f…): the 13/11/4 baseline as a 28-row vector (never summed), the five-state
separation (false / unmeasured / branch-demonstrated / live-activated / deployed-effective: ZERO),
and the W24 close date. Then make the tenet-12 gate STRUCTURAL: the window-close procedure
(`.instar/w24/recovery/WINDOW-CLOSE-PROCEDURE.md`) gains a step that refuses closure while the plan
doc's current-window section is stale.

## Named release contents (per O2 amendment 2 — no counts, no cherry-picking)
Every preserved ref below ends the window in exactly one state: **integrated+live**, **deferred
with reason and owner**, or **rejected with reason**. Nothing silently omitted.

| Ref (refs/w24-preserve/…) | SHA | Intended disposition |
|---|---|---|
| lane-a-fix-1 | ba83191dd | RELEASE — #19 decision-grading ingress fix; unblocks #24/#28. Live proof: settled grades > 0 on the running service with a `wrong` arm exercised. |
| lane-b2 | 06da09aca (+eb487f86b history) | RELEASE — authorship join at the re-read boundary (Justin's directly-named ask). Live proof: live HTTP surface returns the authorship column on real rows. |
| lane-e-sessions-read | 31c971836 | RELEASE — /sessions discrepancy probe. Live proof: probe active in the running server. |
| lane-f-reap-outcome | fb0531785 | RELEASE — reap-row exitCode/midWork/outcome legibility. Live proof: a controlled self-exit writes the three fields in the live reap log. |
| lane-a-fix-3 | 42288487c | RELEASE (small) — lying-instruments repair per its artifact. |
| lane-a-fix-2 | 462e09701 | VERIFY-ONLY — its two changes were live-activated in W24; window confirms still-live, no re-release needed. |
| lane-a-fix-4 | 8e5b0d2c1 | VERIFY-ONLY — live topic-binding repair (409→200) made in W24; confirm still-live. |
| lane-b1-repo | 1f1dafee4 | REJECT or DEFER — its consumed-only rule reverses behavior Justin explicitly ruled to KEEP (Aug 23 ~18:45Z). The correct successor is the notified+consumed two-fact design, which is named future design work, not this window. Decision recorded in charter, not silently dropped. |
| lane-c | 6da049107 | ASSESS at integration: include if it composes cleanly, else defer with reason. |
| lane-g-parity | 8e5b0d2c1 | NO RELEASE — measurement artifact (instrument #15 is right; the world diverges). Feeds the plan doc, not the build. |
| lane-h-integration | 9bc149c8b | MEANS, not content — the integration tree base. Superseded by the fresh candidate this window builds. |
| lane-k | 6b7f17a05 | ASSESS at integration (long-standing identifier mismatch — ownership per O2 correction). |
| lane-l | fae2c93e1 | NO RELEASE as-is — it PROVED the base64 relay bypass; the FIX is a named blocker item below. |

## Release blockers vs queued follow-ups (per O2 amendment 3)
BLOCKERS (release does not ship without them):
- B-1: Sentinel emergency-stop DELETES the live state file (destroyed two 200KB+ records in one
  day). Stop and delete become separate actions; kill preserves the file. It destroys continuity
  evidence, which is why it blocks.
- B-2: Guard-population verification with exact counts — enumerate the hook registrations actually
  LOADED in every running session (not on disk; both restarted sessions should carry 36) and record
  the population in the release evidence. Bounded proof, not a rebuild.
QUEUED (named, owned, not in this release): base64 relay bypass fix; advisory guard env-dependency;
coverage self-announcement (carry 12/12b); notified+consumed two-fact design; /sessions intermittent
root-cause; grounding-checkpoint turn cost.

## Mechanics
- Codey workers on the laptop perform integration/test/deploy; Pathway orchestrates only; observer
  observes, reports 3-hourly in plain language walking the plan path (manual fallback until the plan
  can generate it).
- Path: one integration candidate from the named RELEASE refs → zero-failure full suite →
  migration/config review → supervised deployment → live consumer verification per ref (the "live
  proof" column above).
- No new exploratory audits or scorecards. Closure measurements (combined tests, must-fail
  controls, post-deploy consumer verification, plan-close gate) are mandatory and exempt.
- Intervention vs role conversion (O2 boundary): wake/stop-false-claim/preserve-evidence/restore-loop
  is observer duty, reported briefly; investigating/building/operating Pathway-or-worker work is
  exceptional and recorded with reason, authority, start/end, return condition, displaced duty.
- Justin's ruling preserved: current delivery behavior stays; notified/consumed stays future design
  unless he names it in.

## Exit test
The window closes only when: every RELEASE ref verified live at the consumer; every other ref
carries its recorded disposition; the full suite is zero-failure on the deployed candidate; and the
plan document carries both the W24 close and the W25 result. If it achieves only this, it is the
first window whose product is a healthier system rather than a better-understood one.
