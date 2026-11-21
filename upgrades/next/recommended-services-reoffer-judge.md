<!-- bump: patch -->
## What Changed

Recommended services, re-offers for reasons 2 and 3 (a change that matters, a long cool-off), built in shadow (`src/recommended/reofferJudge.ts`). A model judges whether a declined service should be asked about again, inside a floor written in code: never after 3 nos or 3 re-asks, a change must be dated after the no and is spent once, a cool-off is 90 days after one no and 180 after two. It sees categories only (the saved reason, counts, person-written change lines in the catalog, fixed facts), answers offer or hold from a closed set, and anything else is a failure that holds and is reported. On each regular check, on the machine that can reach the person, it judges at most one row and records the verdict. It sends nothing. `GET /recommended-services` reports `reofferShadow`. Off behind `recommendedServices.reoffers.enabled`.

## What to Tell Your User

Nothing changes: this only watches. Later, once it has shown it judges well, the agent may ask once more about a service you declined if it changed in a way that answers your reason (for example, it got cheaper and you'd said no because of cost).

## Summary of New Capabilities

- Re-offer judge in shadow; `reofferShadow` on `GET /recommended-services`; catalog rows may carry `changes`.

## Evidence

- Live bench on the real shared provider (2026-11-20): the balanced tier passed three runs (6/6, 5/6, 5/6 offer cases found, 0 false offers, 0 failures); the fast tier found 2 of 6, so the judge uses balanced. It stays in shadow until the dev-agent shadow records are reviewed.

- Unit: `tests/unit/reoffer-judge-bench.test.ts` (floor, hash, strict parse, attribution and provenance, backoff, bench gate; opt-in `INSTAR_LIVE_REOFFER_JUDGE=1` live run). Integration: shadow verdicts recorded once, nothing sent, re-asked only when inputs change, failure backoff, never when off, unreachable or inside the floor. E2E: the judge is wired to the shared provider and an unreachable machine never asks it. Census ratchets updated.
