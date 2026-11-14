# Side-Effects Review — same-machine agent trust: would-refuse evidence and the next rung's bar

**Version / slug:** `local-route-trust-maturation-bar`
**Date:** `2026-11-11`
**Author:** `Echo`
**Second-pass reviewer:** `not required (evidence and measurement only; no block/allow behaviour changes)`

## Summary of the change

Tier 1. 4 source files (~85 lines), 1 ladder entry, 1 new unit test file, 1 integration test added, 1 drill script. One build pass, no spec review rounds (Tier 1; the PR is the review surface). Feature maturation retry 2 of 3 for `threadline.localRouteTrust` (CMT-1141); the Nov 9 attempt left no PR or branch.

- `src/monitoring/FeatureEvidenceLog.ts`: optional top-level `subject` on evidence rows (scrubbed, at most 96 chars) so a ladder metric can count distinct values with `dedupe: "subject"`.
- `src/threadline/localRouteTrust.ts`: `localRouteTrustSubject()` (fingerprint, else the log-safe claimed name) and `localRouteTrustEvidence()` (the row for one verdict). Would-refuse and refuse rows: one per sender + operation per minute, with `suppressedSinceLast`; context gains `sender` and `refuseReason`. Allowed rows stay hourly. Kind/reason values are unchanged (`fired`/`would-refuse`, `error`/`*-registered-sender`), so the existing `fired` and `error-rate` metrics read the same rows as before.
- `src/server/routes.ts`: the relay-agent route records the row from `localRouteTrustEvidence()` instead of building it inline.
- `src/data/feature-ladders.json`: the `dev-agent-live` rung gains `distinct-senders` (quality, ≥ 3, dedupe subject), `would-refuse` (quality, ≥ 1 row with reason `would-refuse`) and `would-refuse-graded-wrong` (harm, ratio ≤ 0 over outcome rows with reason `would-refuse`, dedupe `gradesEventId`, min 1 sample). Tracking plan updated (≤ 400 chars; the first draft was 438 and made the whole ladder file invalid — caught by the drill, now covered by a unit test).
- `scripts/drills/local-route-trust-drill.mjs`: two throwaway agents, 9 steps; passed 9/9 on the Studio 2026-11-11.

## Decision-point inventory

- Local-route trust verdict — unchanged. Only what is written to the evidence log changes.
- Maturation ladder `dev-agent-live` bar for this feature — modify — three more conditions; the ladder is advisory and the move to enforcing is a separate config step.

## 1. Over-block

The bar can hold the feature longer: it needs three distinct senders, a real would-refuse, and at least one graded would-refuse. On an agent with few same-machine peers this may take a while. That is the reviewers' intent (they asked for evidence the check meets its real case before it enforces).

## 2. Under-block

- Distinct senders without a fingerprint are counted by claimed name. One caller holding this agent's token could claim three names. This only counts evidence; it grants nothing. The grading bar still needs a reviewer to look at the rows.
- A grade posted without `reason: "would-refuse"` is not counted. The bar then reads "no samples" (not a pass), so the failure is safe; the tracking plan names the exact fields.
- A registry-known sender refused is an `error` row (the existing harm metric), not counted in the `would-refuse` quality bar. That case is meant to hold the feature, not help it.
- On a machine whose evidence log has rotated past the 14-day window, ratio metrics read `evidence-cut` (already true for `error-rate` on Echo today). The new harm bar behaves the same way: no number, not a pass.

## 3. Level-of-abstraction fit

Right layer. The route already records one row per verdict; the change keeps the decision where it was and moves the row shape into the trust module next to the log-line builder, so the route and the tests share one definition. The ladder evaluator and evidence reader are unchanged; `subject` is a plain field their existing `dedupe` option already supports.

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow surface.

Evidence rows are signals. The ladder is advisory (`advisory: true`) and never moves a feature by itself; the move to enforcing stays a recorded config step.

## 4b. Self-action convergence

`unbounded-self-action`: closure `n/a`. The drill is a one-shot, operator-run script that starts and stops two throwaway servers once; it is not a self-triggered loop. The `src/` changes add no restart, retry, spawn or kill: only the shape and rate of evidence rows.

## 4c. Tier declaration

Declared Tier 1, below the gate's risk-signaled floor (recorded `belowFloor: true`). Reason: the floor is raised by touching the trust route file and a gate's ladder, but no decision on that route changes, the ladder is advisory, and a revert fully undoes the change.

## 5. Interactions

- `recordAtMostEvery` rate state is shared per process; the would-refuse key includes the subject, so different senders never suppress each other's rows.
- The existing `fired` metric counts all `fired` rows; would-refuse rows can now be up to 60× more frequent per sender than before. With the token-gated route this is bounded by local callers; log rotation is 10 MB × 8 segments shared with every feature. A sender looping at full speed writes at most one row a minute per operation.
- Changing the rung's metrics changes its contract hash, so the 3-day soak restarts from zero. Intended: the soak should be counted against the new bar.

## 6. External surfaces

- Evidence rows carry the sender's display name (log-safe, ≤ 48 chars). These rows stay in the agent's own `logs/feature-evidence.jsonl` (mode 0600); they are not sent anywhere.
- `GET /maturation/ladder` shows three more metrics for this feature.
- The drill runs only on throwaways in a temp folder with their own HOME, feedback forwarding off, scheduler off, no messaging adapters, and the receiver's relay pointed at a dead loopback port. An early drill draft, before `feedback.enabled: false` was set, forwarded 2–3 automatic degradation reports (macOS keychain timeout in the fake HOME) to the maintainers' feedback inbox; the final drill sends none (checked: 0 "Forwarded to webhook" lines in both logs).

## 7. Multi-machine posture

Machine-local by design, same as the ladder: each machine reads its own evidence log and the bar is judged per machine. The route's decision is per machine already.

## 8. Rollback cost

Revert the PR. Rows already written with `subject` stay valid (extra field, ignored by older readers). No migration, no state repair.

## Agent awareness

No new endpoint or capability: grading uses the existing `POST /maturation/evidence`, already in the CLAUDE.md template's maturation-ladder section. The grading fields are named in the feature's ladder tracking plan, which `GET /maturation/ladder` shows.
