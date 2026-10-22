# Side-Effects Review — local-verify status projection, reconcile loop and main health

**Version / slug:** `local-verify-status`
**Date:** `2026-10-21`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent, three rounds — concur (see below)`

## Summary of the change

Piece 3a of `docs/specs/local-verify-merge-authority.md`, plus the integration of pieces 2 and 3b. New in `src/localVerify/`: `statusProjection.ts` (pure: the projected `instar/local-verify` state for a PR/head, local floor per §3 "What success requires, in full", or the Actions-floor mirror over `ACTIONS_FLOOR_CONTEXTS` using safe-merge's own `evaluateRequiredContexts`, excluding the context itself; a shared head is success only if every open PR to main on it is authorized), `StatusReconciler.ts` (the 60-second loop on the lease holder: lists every open PR to main, posts only when the projection differs from what GitHub reports, one serialized writer per head shared with event-driven withdrawal and the verify-completion path, cache rebuilt from GitHub after a restart, lease and epoch re-checked before every post, stuck-status and mirror-pending signals, `foreign-status` logging), `mainHealth.ts` (the `main` verify queue entry, 10-minute debounce capped at 30, re-run once, `main-suspect`/`main-red`, the durable watermark, red→green re-runs), `floorGate.ts` (the `local` floor is effective only when GitHub's ruleset requires `instar/local-verify` and classic protection requires nothing; `awaiting-edit-a`/`awaiting-edit-b` otherwise; `current_user_can_bypass` must be `never`), `reconcilerSeams.ts` (gh through the agent's explicit identity), and `GET /local-verify/status`. Integration seams: the watcher's floor and main health come from the loop; the projection's approver acceptance uses safe-merge's `approverAcceptanceFromExecutorStatus`; eligibility is one implementation (`isMergeEligible`).

**Posting is off by default:** `monitoring.localVerify.postStatuses` defaults to false, and then the loop only logs the statuses it would post.

## Decision-point inventory

- `projectStatus` — add — the state the server would post. Deterministic.
- `effectiveFloor` / `floorFor` — add — whether the local floor is in force, from GitHub's own settings. Deterministic.
- main-health state machine — add — healthy / main-suspect / main-red. Deterministic over verify outcomes.

---

## 1. Over-block

With posting on and the check required, a PR waits (`pending`) whenever the server cannot prove the conditions: no record yet, `main` unhealthy, an approval-path PR without a matching acceptance. First enablement starts in `main-suspect` (no watermark yet), so the watcher requests no PR verifies until the first `main` verify is green, about 45 minutes. A server outage leaves new heads without a status, so they wait (deliberate).

---

## 2. Under-block

- A head that drops out of the listing (head moved, retargeted away from `main`) while holding a `success` this server posted gets `pending` once; that memory of what was posted is in-process, so a restart forgets it (the next pass re-projects every listed head; an unlisted one keeps its old status).
- A `success` already posted stays mergeable on GitHub until the next reconcile pass withdraws it (about 60 seconds), or for the whole time the server is down (stated in the spec).
- A forged `success` with the shared login is overwritten within one pass but can be used in that window (spec threat model). A forged status that already matches the projection is not logged as `foreign-status`, because the PR list's rollup carries no creator (it is harmless, since it matches).
- The spec's "compare the floor the previous holder posted under" on lease takeover is not built: the audit log it names is machine-local. The status route reports `takeoverFloorCheck: 'not-built'`.

---

## 3. Level-of-abstraction fit

The projection is a pure function over the same inputs safe-merge uses, with safe-merge's own evaluation function passed in, so there is no second implementation of the Actions floor. The loop is separate from the watcher (not gated by its breaker or latches), as the spec requires.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but the logic is a deterministic invariant over a test record and GitHub's own state.
- [ ] ⚠️ Yes, with brittle logic — STOP.

Once posting is on and the check is required, the posted status is the authority GitHub enforces. It is a projection of structured server state, never a judgement over prose; every unreadable input projects to `pending`.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point (spec Supervision: tier0).

---

## 5. Interactions

- **The loop is constructed whenever there is a source checkout and an `expectedGhLogin`**, even with `monitoring.localVerify.enabled` false, because the spec keeps the Actions-floor mirror on whenever GitHub requires the check. With the check not required it only reads settings: about three GitHub reads a minute on Echo today, posting nothing.
- **Standbys** read GitHub's settings on every pass so their safe-merge sees the real floor; only the lease holder posts.
- **Watcher:** reads the effective floor and main health from the loop; without the loop it reads `actions`.
- **Restart hold** (spec §2 Restarts) is not wired in this piece; with posting off it has no effect.
- **GitHub API load:** the 60-second pass is the only retry path; a head whose post failed is skipped until its backoff time; posts are capped at 30 a minute (the rest wait a pass); an unreadable settings read is treated as "check required" (floor stays `actions`, the mirror stays on) and never pauses listing, withdrawals or `pending` posts; only the mirror's per-head check-run reads back off after read failures (2 minutes, doubling, up to 15), and a PR-list failure backs off the pass because nothing can be posted without the list. A withdrawal (a post away from `success`) is exempt from the cap and goes first.
- **Required but not posting:** if GitHub requires `instar/local-verify` while `postStatuses` is false, every PR would wait forever, so the lease holder raises ONE HIGH item (`local-verify:required-but-not-posting`) and the status route shows it.
- **Watcher disarm:** with `postStatuses` false, the actions→local transition only logs `would-disarm`; the real disarm happens once posting is on.

---

## 6. External surfaces

With `postStatuses` true: commit statuses on PR heads in `JKHeadley/instar` (context `instar/local-verify`). With it false (default): nothing at all is written to GitHub — no statuses, and the watcher logs `would-disarm` instead of disarming armed merges. New route `GET /local-verify/status`.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not applicable — no dashboard or approval surface.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Only the lease holder posts; every post re-checks the lease and epoch, and the audit records machine and epoch. A different machine taking the lease starts in `main-suspect`; the watermark stores the lease epoch and holder, and an epoch gap (another holder in between) is treated the same way. A watermark that cannot be updated to a stricter state is deleted, so the next boot is `main-suspect`. Journals and the watermark are machine-local by design (spec Multi-machine posture). Not built: the takeover floor comparison (above).

---

## 8. Rollback cost

`monitoring.localVerify.postStatuses: false` (the default) stops all posting at once. After the check is required on GitHub, the operator's emergency pair in the spec (re-add the classic checks, then remove `instar/local-verify` from the ruleset) is the full rollback. Reverting the commit removes the loop.

---

## Conclusion

The piece that turns a verify record into the status GitHub enforces, off by default, and the wiring that joins it to safe-merge and the watcher.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (three rounds)
**Independent read of the artifact: concur (after fixes)**

Round 1 raised: a stale rollup overwriting a newer post (two guards added, `withdrawAll` submits every head); dropped heads keeping a server-posted success (now withdrawn once); a failed main-head read leaving an old head for the repair check (cleared); `protected: true` without a `protection` block read as "nothing required" (now unreadable); no real retry backoff and no post cap (single retry path, per-head backoff, 30/minute cap); a failed stricter watermark write leaving a laxer one (now deleted); the different-machine flag living only in memory (epoch and holder now in the watermark); no warning when GitHub requires the check while posting is off (HIGH item); the watcher's disarm writing while posting is off (now `would-disarm`). Round 2 raised that the whole-pass backoff on unreadable settings stopped withdrawals, and that the cap could delay them; both fixed. Round 3 verified both and concurred; no further artifact changes.

## Evidence pointers

- `tests/unit/localVerify/statusProjection.test.ts`, `StatusReconciler.test.ts` (including the serialized-writer interleaving, checked to fail without the serialization), `mainHealth.test.ts`, `floorGate.test.ts`
- `tests/integration/local-verify-routes.test.ts` (status route; safe-merge's `selectSafeMergeFloor` against the real route)
- `tests/e2e/local-verify-lifecycle.test.ts`

## Class-Closure Declaration (display-only mirror)

- **Defect class:** `unbounded-self-action`
- **Closure:** `gap`, tracked as **ACT-147** (register the local-verify controllers in `src/testing/selfActionRegistry.ts` with a convergence model).
- **Why it settles today:** one reconcile pass per 60 seconds; one serialized writer per head; a post only when the projected state differs from GitHub's; at most 30 posts a minute (withdrawals exempt and first); per-head retry backoff and a pass backoff after a PR-list failure (2 to 15 minutes); the `main` verify is debounced 10 minutes, capped at 30, with at most one pending.
