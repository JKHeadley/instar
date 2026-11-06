# Side-Effects Review — maturation ladder: graded-wrong bars and on-in-code features

**Version / slug:** `maturation-quality-bars`
**Date:** `2026-11-05`
**Author:** `Echo`
**Second-pass reviewer:** `not required (registry data + a read-only rung derivation; no gate, sentinel, session or messaging decision)`

## Summary of the change

Tier 1. 3 files changed in src/tests plus docs (registry JSON: 3 entries; `MaturationLadder.ts`: ~20 lines; tests: ~70 lines). One review round, one commit attempt.

The 2026-11-05 maturation review (topic 128732) found three wrong bars in `src/data/feature-ladders.json`:

1. `monitoring.crashLoopPauser` and 2. `threadline.relayUnknownSenderTrust` passed their dev-agent-live bars on activity alone (fired count + error rate) while their decisions are wrong: the pauser would pause `bugs-intake` (63 of 69 runs succeeded), and the trust check would refuse Luna, a verified paired peer. Both got the `graded-wrong-rate` quality metric the registry already uses (e.g. `monitoring.biasToAction`): wrong outcome rows over all outcome rows in `logs/feature-evidence.jsonl`, deduped by `gradesEventId`, at most 5%, at least 5 graded, 30-day window. Added to both rungs of each.
3. `monitoring.autonomousHeartbeat` is started live on every machine by `src/commands/server.ts` since PR #2788 and ignores its `enabled`/`dryRun` settings, but the ladder derived its rung from those settings and reported it `dark` / `not-started`. New optional registry field `shippedOn: { ref }`: when present, `deriveLadderRung` returns `fleet`. The parser allows it only on a default-on ladder without a `start` block. The heartbeat entry gets `shippedOn` and loses its now-meaningless `start`.

## Decision-point inventory

- `computeLadderState` is unchanged. Adding a quality metric can only move the two features from `soaking`/`ready-to-advance` to `hold` or `collecting`. This is the more conservative direction.
- `deriveLadderRung`: a new early return for `shippedOn` entries. Only the heartbeat uses it.

## 1. Over-block

The pauser and trust check cannot advance until at least 5 decisions are graded and at most 5% are wrong. A pauser that is actually right but rarely graded stays `collecting`. That is the intended cost: the review grades through `POST /maturation/evidence`.

## 2. Under-block

Other ladder entries that still judge on fired + error rate alone can still pass on activity. This PR fixes the two found by the review. Requiring a graded-wrong bar on every config-advance rung is a wider registry change. It is reported to the review as a found problem, not added here.

## 3. Level-of-abstraction fit

Right layer. The registry is where bars live, and rung derivation is where "what runs" is read. `shippedOn` states the shipped truth once in reviewed data, instead of a special case in the service.

## 4. Signal vs authority compliance

The ladder is a signal. D7 says `ready` and the review job's model decides moves. Neither change adds blocking authority. A stricter bar only makes the signal say "not yet", and `shippedOn` only corrects a reported rung.

## 5. Interactions

- On first pass after update, the service records a `rung-observed` audit row (dark → fleet) for the heartbeat. This starts the 14-day post-move harm watch on its fleet rung's harm metrics (error-rate, wrong-graded-count). That is correct for a feature that is now live everywhere.
- The heartbeat leaves `not-started`, so the ladder stops raising it. The open commitment CMT-1297 is not closed by code; the review closes it.
- `applyMove` refuses the heartbeat (`not-ready`, at-final), so no config write can target it.
- Changing a rung's metric list changes its D7 contract hash, so the soak for the two features restarts. That is correct, because the bar changed.

## 6. External surfaces

`GET /maturation/ladder` shows a new metric row for two features and `fleet`/`at-final` for the heartbeat. There are no new routes or config keys.

## 7. Multi-machine posture

The registry ships with the package, so every machine reads the same bars. Evidence is per machine through the existing reader; this PR does not change that. `shippedOn` matches the code, which runs the heartbeat on every machine.

## 8. Rollback cost

Revert the PR. The data and pure-function changes leave no state behind except audit rows.
