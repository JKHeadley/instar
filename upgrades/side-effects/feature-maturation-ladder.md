# Side-Effects Review — Feature maturation ladder

**Version / slug:** `feature-maturation-ladder`
**Date:** `2026-11-03`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent, appended below`

## Summary of the change

Adds the measured path to default-on: a shipped registry of per-rung thresholds (`src/data/feature-ladders.json`), a coverage test over a code-derived universe (`maturationUniverse`), pure parsing and state logic (`MaturationLadder`), a streaming evidence reader (`LadderEvidenceReader`), a rich-context log (`FeatureEvidenceLog`), a service that feeds D7 and raises commitments (`MaturationLadderService`), routes (`maturationLadderRoutes`), a board owner source and page block, a plan-gate line, and migration and template sections. D7 gains subject hooks and linear per-pass reads. Tier 2: about 2,000 lines of code and tests plus a large data file, 3 spec rounds, dev-gated.

## Decision-point inventory

- Rung derivation — add — pure read; gates nothing.
- Threshold evaluation — pass-through — D7's numeric comparison, unchanged.
- Raise a feature — add — records a commitment, deduped; decides nothing.
- `POST /maturation/moves` floors — add — exact-match checks in front of a decision a model already made; can only refuse.
- Plan gate — modify — also requires a `ladder` line in the instar source tree.
- Coverage test — add — a new dark flag with no entry fails the build.

---

## 1. Over-block

The coverage test refuses a new switched-off flag with no ladder entry; that is intended, and an entry with `tracking: needed` is cheap. The plan gate refuses a spec with no `ladder` line, in the instar source tree only: installed agents' own specs are unaffected, and existing specs are not re-stamped. The moves route refuses a sensitive or coherence-critical feature, which is intended: those take the code path.

## 2. Under-block

A feature can write rows while being wrong; thresholds on activity alone would pass. Enough-to-judge requires a quality or harm metric, and the review's model reads the evidence, but a poor metric can still pass the numeric floor. A bearer holder can post favourable grades; no count moves anything by itself. A concurrent config writer could be overwritten between check and write: accepted, one process, rare moves, model in the loop. Registry quality: model-drafted entries, parser-checked and read by a second family, can still mis-specify a bar; the review grades outcomes over time.

## 3. Level-of-abstraction fit

D7 stays the only scorer. The service adds subjects and projections rather than a second rule. The board stays a view. The review job stays the only decider. Raising is a signal; the mind holds authority, per *The Body and the Mind*.

## 4. Signal vs authority compliance

Compliant, and this is the main thing review changed. Reference: `docs/signal-vs-authority.md`. Numbers are signals. The first design auto-applied reversible moves; it was cut. The route's floors are exact-match checks that can only refuse, in front of a decision a model made.

## 5. Interactions

D7's `evaluateMaturation` now reads once per pass; existing D7 tests pass unchanged. Its 6-hour timer now awaits a `prepare` hook, with an overlap guard. In-memory subjects add rows to the D7 ledger: at 172 subjects and 4 passes a day, about 62k evaluation rows and up to about 139k observation rows at the 90-day retention, handled by existing pruning. A stuck evidence read is cut off after 10 minutes so it cannot stop the scorer for other features. Board D7 rows for ladder-only subjects are skipped so one feature stays one row. `maturation:<id>` commitments share the key the review job already uses, so a job-opened one is reused. Raised commitments have no beacon, so they cannot crowd the beacon cap. `StageAdvancer` stays the sole writer of the session-pool stage; the parser and `LiveConfig` both refuse it. `lint-state-registry` gets two new stores.

## 6. External surfaces

New routes under `/maturation` (Bearer; dev-gated). The board response gains an owner source and the page gains a line and a list. No operator messages. Schema `maturation-ladder/1` is a published interface for the job. Log contents never leave: only numbers do.

## 6b. Operator-surface quality

(1) The page still leads with its one answer sentence; this adds "N ready to move up" to the line under it, and a "Where it is" row plus a short list of numbers under a tapped row. No new primary action: the page changes nothing. (2) No raw internals as primary content: rungs and states read as plain words ("On for development agents", "Not recording anything yet"), and setting names stay under Technical details. (3) No destructive action on this surface; moves and reverts are API-only. (4) Plain language; the list is one line per number and wraps at phone width. The first view adds under ten words.

## 7. Multi-machine posture

Unified by derivation and proxied read: the registry is repo-tracked; D7 and the evidence logs are origin-local by D7's approved design and shown machine-tagged through the board's pool merge. Moves are per-machine, like `/guards`, and coherence-critical flags are refused. Raises run on the lease holder only; a lease move can produce a second record for a feature, which costs one report line. `reviewTopic` is per machine.

## 8. Rollback cost

Set `maturation.ladder.enabled` false, read live with no restart: routes 503, raising idles, D7 returns to spec-born subjects. No migration to undo. Applied moves stay as settings, each with a revert route and old values in the audit log. A bad registry is refused whole, and fixed by one release.

## Class-Closure Declaration

`unbounded-self-action`: closure `guard`, citing `tests/unit/self-action-convergence.test.ts` (ratchet), registered as `maturation-ladder-raise`. Raising is capped at 5 a pass with per-feature cooldowns. Evidence reads are bounded by file size and run once per 6-hour pass with an overlap guard. The review's build sessions are capped at 2 a run, with at most 3 retries in its job body. Moves are request-driven.

## Evidence

Unit, integration and E2E tests as listed in the spec; second-family read of the thresholds; live check on Echo recorded in the PR.

## Second-pass review

Independent subagent, first read: "Concern raised": a failed read counted as silence (false `harmed`); an unreadable config armed harm watches and raised false commitments; the off switch needed a restart; `prepare` had no timeout; the row estimate left out observations. It found the D7 linear change equivalent, no path that moves a feature without the route, and no board regression. All five fixed in this commit, with tests. Concur after fixes.
