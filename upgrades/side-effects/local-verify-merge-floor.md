# Side-Effects Review — safe-merge and the green-PR watcher learn the `local` floor

**Version / slug:** `local-verify-merge-floor`
**Date:** `2026-10-21`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent, two rounds — concur (see below)`

## Summary of the change

Piece 3b of `docs/specs/local-verify-merge-authority.md` (approved 2026-10-21). Three parts:

1. **Protection fixes (apply under today's floor too).** `fetchProtectionContexts` reads `GET /branches/<b>` (`protection.required_status_checks`), which a non-admin can read; a 404 from `/protection` no longer means "no protection" (that misread hid `main`'s 12 required Actions contexts and is the root cause in the spec). `ACTIONS_FLOOR_CONTEXTS` = `REQUIRED_CONTEXTS_FLOOR` plus the 12 classic contexts pinned with their producer, excluding `instar/local-verify`; the synchronous Actions path now enforces it. A required `instar/local-verify` is read from the combined-status API, never among check runs.
2. **The `local` floor in safe-merge** (synchronous path only; `--auto` unchanged). Chosen only when the agent config's `monitoring.greenPrAutoMerge.floor` is `local`, the repo matches, the PR is eligible (agent or operator login, same repository), and the server reports `effective: 'local'`. It skips the three Actions waits and applies the spec's predicate against the server's record (head, base, outcome, gating lanes, body checks, the harness / protected / skips / removed flags or an operator approval of that exact head with a matching approver acceptance, and the main-health repair rule). Unmeasurable → `refused:verify-record-unmeasurable`; no record → it queues one and answers `refused:verify-pending`. It never falls back to the Actions floor on its own. `INSTAR_MERGE_FLOOR=actions` can force actions, never local. Port and token come only from the agent's config file. New shared module `scripts/local-verify-floor.mjs` (floor selection, eligibility, the one `approvedAtHead`, the review precheck).
3. **Watcher and MergeRunner.** `sync` strategy (neither `--auto` nor `--admin`, 25-minute deadline), used for every local merge; the candidate filter under `local` requires a record for the current (pr, head, base) instead of `statusRollup === 'SUCCESS'`; the namespace filter stays; the actions→local transition disarms armed merges once; the watcher requests verifies for review-ready candidates, oldest first, only while `main` is healthy (inert until the status piece supplies main health, see §5); the boot timeout check accounts for `sync`; the probe-time hash pin now covers every repo module safe-merge imports.

With the default config (`floor` absent or `actions`) the only behaviour changes are part 1.

## Decision-point inventory

- `selectSafeMergeFloor` / `selectMergeFloor` — add — which floor a merge uses. Deterministic.
- safe-merge local predicate — add — whether a PR may merge under `local`. Deterministic over a test record and GitHub reads.
- `fetchProtectionContexts` — modify — reads protection the way a non-admin can.
- `evaluateRequiredContexts` — modify — `instar/local-verify` from commit statuses; floor extended with the 12 pinned contexts.
- `classifyCandidate` — modify — under `local`, record-gated instead of rollup-gated.
- MergeRunner strategy — add `sync`.

---

## 1. Over-block

Under today's floor, the synchronous Actions path now requires the 12 classic contexts by name with their producer. For a non-admin merge GitHub already requires them, so nothing changes there. **For an `--admin` merge it is a change:** classic protection's enforcement is `non_admins`, so an admin merge used to bypass the unit shards, and safe-merge (which read protection as "none") did too. It now refuses unless every pinned context is green from `ci.yml`. That is the spec's intent (§3: the unit shards have only ever been required through classic protection, and the shared floor keeps them), but it is a stricter `--admin` path than today. Also: a malformed `.instar/config.json` now refuses every safe-merge run instead of being ignored. A renamed CI job refuses until the pin is updated (the watcher's floor-drift canary covers this). Under `local`: a PR with no record is refused until a verify finishes (`verify-pending`); a server outage refuses every local merge (deliberate — the spec forbids falling back).

---

## 2. Under-block

Under `local`, five merge-time body checks that need a checkout of the head (standards-coverage, ux-impact, class-closure, runbook, trailer) are not run by safe-merge; eli16, decision-audit and release-fragment are. This is not a regression: today safe-merge requires only eli16 and decision-audit among them, and the others are advisory GitHub workflows. The base is not pinned at merge time (spec §3; the post-merge `main` verify compensates). While the agent server is down, anything else listening on its port would receive the bearer token from safe-merge's request; it cannot authorize a merge GitHub itself does not allow once the status check is required, but the token exposure is a stated residual. Found by the second pass and fixed before commit: `resolveAgentHome` ran git with the inherited environment, so a `GIT_DIR`/`GIT_COMMON_DIR` could have pointed safe-merge at another config file, server and token; git now runs with every `GIT_*` variable removed (test). Also fixed: a record flag that is missing or not a boolean is unmeasurable rather than "unflagged"; a review with an unparseable `submittedAt` is skipped so the ordering can never be NaN; the server's environment can no longer pass `INSTAR_MERGE_FLOOR` into the watcher's merges.

---

## 3. Level-of-abstraction fit

One floor-selection function and one eligibility check, shared by safe-merge and the watcher; one `approvedAtHead` (moved into the shared module, re-exported by `reviewGate.ts`). safe-merge stays the act-time authority; the watcher only pre-filters.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but the logic is a deterministic invariant over a test record and GitHub's own state, the same kind of authority as today's required checks.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The predicate holds merge authority, as the Actions floor does today. It is not a detector over prose: every input is a structured record field or a GitHub API value, and every unreadable input refuses.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point; the floor and predicate are enumerable invariants (spec: Supervision, tier0).

---

## 5. Interactions

- **Classic protection:** until the operator removes the 12 classic required contexts (Decision 19), GitHub still refuses a non-admin merge without them, and the server reports `effective: 'actions'`, so safe-merge stays on the Actions floor. The local floor cannot take effect before GitHub's settings allow it.
- **Feedback executor:** uses `--auto`, unchanged.
- **Hash pin:** widened to the import closure, so a mid-run swap of the new shared module is refused like a swap of safe-merge itself.
- **Not yet live in the watcher:** `server.ts` wires `mainHealth` as `() => null` until the status piece supplies it, so the watcher requests no verifies yet. Its record lookup also does not apply the main-health rule, so it can pick a candidate that safe-merge then refuses (`main-red`); harmless, since safe-merge decides.
- **Auto-merge arming:** the actions→local transition disarms the watcher's own armed merges once; merges armed directly on GitHub by someone else are not touched.

---

## 6. External surfaces

Merge behaviour for this repo only, and only when the config floor is `local`. `--capabilities` gains `floorModes`. No new routes (it reads `GET /local-verify/status` and `GET /local-verify/record` and may `POST /local-verify`).

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not applicable — no dashboard or approval surface.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

safe-merge asks the local server; a standby's server answers 409 for verify requests, which safe-merge treats as unmeasurable under `local`. Pool-wide floor settings and takeover rules belong to the status piece (spec §4 "Settings are pool-wide").

---

## 8. Rollback cost

`monitoring.greenPrAutoMerge.floor: 'actions'` (or absent) restores today's merge path except part 1: the protection read, and the pinned 12 contexts that the `--admin` path now also requires. Reverting the commit removes those too.

---

## Conclusion

Merge-path changes that let safe-merge and the watcher trust a server-run verify instead of waiting on Actions, gated so they take effect only when the config and GitHub's real settings both allow it.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (two rounds)
**Independent read of the artifact: concur (after fixes)**

Round 1 raised: an inherited `GIT_DIR`/`GIT_COMMON_DIR` could redirect safe-merge to another config, server and token (fixed: git runs with `GIT_*` removed); missing record flags counted as unflagged (fixed); an unparseable review timestamp could make the ordering NaN (fixed); the server env could pass `INSTAR_MERGE_FLOOR` into the watcher (fixed); the artifact understated the `--admin` change and the inert main-health wiring (corrected). Round 2 confirmed every fix against the diff and concurred.

## Evidence pointers

- `tests/unit/safe-merge-hardening.test.ts` (protection read, pinned floor, combined-status read)
- `tests/unit/safe-merge-local-floor.test.ts`, `tests/integration/safe-merge-local-floor.test.ts` (stub server)
- `tests/unit/green-pr-local-floor.test.ts`, `tests/unit/merge-runner.test.ts`, `tests/unit/green-pr-logic.test.ts`
