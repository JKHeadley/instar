# Side-Effects Review — local-verify: a PR that no longer merges into main says so

**Version / slug:** `local-verify-conflict-notice`
**Date:** `2026-10-26`
**Author:** `Echo`
**Second-pass reviewer:** `not required` (no block/allow, session-lifecycle, gate or sentinel authority changes; the required status already failed on this record — only its wording changes)

## Summary of the change

Tier 1 (6 src files, ~140 LOC, plus 2 new test files; one review pass, first commit attempt). When a local verify finds that a PR head no longer merges into its base (`error`, `errorStep: 'conflict'`), `LocalVerifyService` no longer auto-re-runs it (deterministic for (head, base)), keeps an in-memory map of open conflicts (rebuilt from the journal index at boot), exposes it as `conflicts` on `GET /local-verify` (`snapshot()`), and calls a new `onConflict` seam once per (pr, head) to open a notice and again to resolve it when a new head is queued, a non-conflict record lands for the PR, or the PR is found closed. `statusProjection.projectLocal` maps a conflict record to `failure` / `merge-conflict` / "no longer merges into main — rebase needed (base abc1234)". `localVerifyWiring` passes the seam through and builds the attention item (`conflictAttentionItem`, id `local-verify:conflict:<pr>:<head7>`, `sourceContext: 'agent'`). `server.ts` wires the seam to `telegram.createAttentionItem` / `updateAttentionStatus(DONE)`. CLAUDE.md template + `migrateClaudeMd()` sniff block (`local-verify:conflict:`) teach agents where to look. Files: `src/localVerify/LocalVerifyService.ts`, `src/localVerify/statusProjection.ts`, `src/localVerify/localVerifyWiring.ts`, `src/commands/server.ts`, `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`.

## Decision-point inventory

- `LocalVerifyService.onExit` error handling — modify — a conflict record skips the one automatic error re-run (other errors unchanged).
- `projectLocal` — modify — a conflict record still projects `failure`; only reason/description change.
- Conflict notice open/resolve — add — signal only (an attention item), no authority over merges or the queue.

---

## 1. Over-block

No block/allow surface added. The status was already `failure` for this record; a conflict that would have cleared on the dropped re-run is impossible (same head, same base ⇒ same merge result).

## 2. Under-block

- A stale-head run (the PR head moved but nobody re-requested yet) can raise a notice for the old head; it closes when the new head is queued. Acceptable: the statement "this head does not merge" is still true.
- A conflict item whose PR's later non-conflict record landed while the server was down stays open after restart (the rebuild only reconstructs the latest-record-is-conflict case). Rare; the item is still accurate history and can be closed by hand.
- An item resolved, then the SAME (pr, head) conflicting again, does not reopen (createAttentionItem returns the existing row). The status and `conflicts` list still show it.

## 3. Level-of-abstraction fit

The service owns the record and the queue, so it is the right place to know a conflict happened and when it stopped applying. Delivery stays in the server via the existing attention primitive; the service only emits a seam call (same shape as `onStarved`/`signal`). Status wording lives in the existing projection.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface (the notice is a signal; the projection's failure state is unchanged).

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. "Conflict ⇒ do not re-run" is an invariant (git's merge of the same two commits is deterministic).

## 5. Interactions

- **Shadowing:** none; the conflict branch replaces `handleErrorRetry` only for conflict records.
- **Double-fire:** one notice per (pr, head) — the map dedupes in-process; `createAttentionItem` is idempotent by id across restarts.
- **Races:** all in the service's single-threaded completion path and request path. Open PR #2370 (restart survival) edits the same files in other hunks (queue restore, starved signal, the server.ts signal block); this change was placed outside those hunks.
- **Feedback loops:** fewer automatic re-runs (one fewer per conflict); the `local-verify-error-rerun` self-action bound only gets tighter.

## 6. External surfaces

- GitHub commit status description for conflicting heads changes to plain words (same state).
- One new attention item kind, `sourceContext: 'agent'`, reaching the Attention hub: at most one per (PR, head).
- `GET /local-verify` gains a `conflicts` array (additive).
- Operator surface: no operator-facing action added; the fix is a rebase the agent does. The attention item is readable on the phone.

## 6b. Operator-surface quality

No operator surface (no dashboard file) — not applicable.

## 7. Multi-machine posture

Machine-local by design, like the verify queue itself: only the lease holder runs verifies (a standby answers 409), so the notice comes from one machine. The attention item uses the existing per-machine attention store. No URLs; no durable new state (rebuilt from the journal).

## 8. Rollback cost

Pure code revert, next patch. No new persistent state. Open attention items from this change stay as normal resolvable items. The CLAUDE.md migration line is one extra bullet; harmless after a revert.

## Conclusion

Clear to ship. Small signal-only fix to a silent failure; reuses the record, status, and attention primitives already in place.

## Class-Closure Declaration (display-only mirror)

- `defectClass: unbounded-self-action`, `closure: guard`
- `guardEvidence: {enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: the conflict notice fires at most once per (pr, head) — one open conflict per PR, an early return for the same head, and createAttentionItem idempotent by id across restarts; it is driven only by a finished verify record (no tick), so its steady state is zero emits with no new pushes. The change also removes the automatic re-run for conflict records, so the registered local-verify-error-rerun controller only emits less.}`

## Evidence pointers

- `tests/unit/localVerify/conflictNotice.test.ts` (12 tests): conflict → no re-run + one notice + snapshot entry; other errors keep the re-run; clean verify → nothing; rebase → resolves at queue time; new head conflicting → its own notice; clean re-verify of same head → resolved as verified; closed PR → resolved; restart rebuild → no second notice, still resolves; status wording; attention item shape.
- `tests/integration/local-verify-conflict.test.ts` (2 tests): over HTTP, `GET /local-verify` shows `conflicts`, record route serves the conflict record, POST of the rebased head resolves it.
- Live incident: PR #2363, `logs/local-verify.jsonl` 2026-10-26T03:19 and 11:00 (record error:conflict → error-auto-retry → nothing).
