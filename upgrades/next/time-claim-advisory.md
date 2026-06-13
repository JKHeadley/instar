# TIME_CLAIM outbound advisory — accurate time reporting is structural (operator mandate)

## What Changed

- **New `TIME_CLAIM` advisory code in the outbound preflight** (`POST /messaging/preflight`):
  when the sending topic has an ACTIVE time-boxed (autonomous) session, anchored
  elapsed/remaining/percent claims in the candidate text ("~7h elapsed", "2h 40m left",
  "8% through") are verified against the live session clock (`readSessionClocks`).
  A claim contradicting the clock beyond tolerance (max(15 min, 20%) for durations,
  15 points for percent) returns a TIME_CLAIM advisory → the relay script's standard
  NOT-SENT loop (fix and re-run, or `--ack-advisory`). Pure deterministic detector at
  `src/core/time-claim.ts`; quoted claims (a correction citing the wrong number) and
  unanchored durations never match.
- **The relay preflight now covers unstamped senders** (`telegram-reply.sh` template):
  every non-script sender runs the preflight — an interactive session running an
  autonomous run (exactly the founding mis-report path) defaults to kind `reply`,
  where the server applies ONLY the clock check (jargon/path/link detectors still
  never run for conversational sends; no active clock → no advisories). Fail-open
  end-to-end, version-skew safe in both directions. Prior shipped template SHA added
  to `TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS` so deployed stock scripts auto-upgrade.
- **Ships dark behind the development-agent gate** at
  `messaging.outboundAdvisory.timeClaim.enabled` (registered in `DEV_GATED_FEATURES`);
  master advisory off-switch (`messaging.outboundAdvisory.enabled`) still wins.
- CLAUDE.md template + PostUpdateMigrator bullet-insert migration so new AND deployed
  agents learn the TIME_CLAIM rule (Agent Awareness + Migration Parity).

## Evidence

- `tests/unit/time-claim.test.ts` (15 new): extraction decision table (anchored,
  composites, minutes-only, percent), both sides of every tolerance boundary, the
  founding incident shape fires, quoted-claim and future-tense "in 2 hours" never
  match, unbounded-run skip, lenient multi-clock.
- `tests/unit/outbound-advisory-routes.test.ts` +8: automated + reply kinds fire,
  reply kind runs ONLY the clock check, accurate report passes, inactive run never
  fires, dev-gate dark-on-fleet / explicit-enable / force-dark, audit row keyed
  `interactive-session`.
- `tests/unit/telegram-reply-advisory-script.test.ts` +1/±2: unstamped sender NOT-SENT
  loop, preflight kind degrades to `reply` under an injection-shaped kind env,
  script-class senders still skip.
- `tests/e2e/outbound-advisory-alive.test.ts` +1: TIME_CLAIM alive on the production
  init path (explicit-enable fires; dark by default on a non-dev config).
- `tests/unit/devGatedFeatures-wiring.test.ts` auto-covers the new registry entry
  (live-on-dev / dark-on-fleet, both sides). `tsc --noEmit` clean.

## What to Tell Your User

When I'm running a long autonomous job for you, my progress reports state how long
I've been running and how much time is left. Previously I could (and once did) guess
those numbers wrong — saying "7 hours in" when the run was 1.5 hours old. Now there's
a structural check: before a report reaches you, any time claim in it is compared
against the run's real clock, and a wrong number stops the message until I correct it.
You'll simply notice that the times in my reports are right.

## Summary of New Capabilities

- Time claims in outbound messages are verified against the live session clock
  before delivery (TIME_CLAIM advisory; dark by default, dev-agents live, fleet flip
  via `messaging.outboundAdvisory.timeClaim.enabled: true`).
- The outbound advisory preflight now also covers interactive sessions running
  autonomous jobs — the clock check only; conversational text gets no new friction.
