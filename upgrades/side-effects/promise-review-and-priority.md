# Side-Effects Review — the agent reviews its own promises; every promise has a priority

**Version / slug:** `promise-review-and-priority`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (spec-converge round 2, all lenses)`

## Summary of the change

Tier 2 (schema change + new scheduled job). Adds an optional `priority` (high / normal / low, absent = not assessed) and review bookkeeping fields to `Commitment`; `?priority=` filtering on `GET /commitments`; priority on POST/PATCH (also forwarded to the owning machine); `evidence` on deliver (also forwarded); a bounded review floor (`src/monitoring/PromiseReview.ts`) behind `GET /commitments/review/queue`, `POST /commitments/review/apply` and `POST /commitments/:id/reopen`; a built-in `promise-review` job (sonnet, every 6 h, gated); priority-first start-up context; phone and dashboard priority display/filter/counts and "Undo — reopen"; sentinel duplicate suppression at creation; auto-expiry honoring reviews/reopens and never aging out a high row; CLAUDE.md template + migration; dev-gate + ladder entries. Files: CommitmentTracker.ts, PromiseReview.ts (new), CommitmentsSync.ts, CommitmentMutation.ts, routes.ts, mobileOpsRoutes.ts, CapabilityIndex.ts, ConfigDefaults.ts, types.ts, devGatedFeatures.ts, feature-ladders.json, templates.ts, PostUpdateMigrator.ts, the job template, dashboard promises-model.js/promises.js/console.css, tests in all three tiers. Proportion: ~1,500 changed lines across ~20 files; 2 spec rounds.

## Decision-point inventory

- `POST /commitments/review/apply` floor — **add** — refuses review closures lacking an assessed priority, evidence/reference, live targets, cap room; can only refuse (leave open).
- Review judgment (which action/priority) — **add** — the job session's model; the floor above bounds it.
- `GET /commitments/review/queue` due/runnable — **add** — ordering/thresholds over stored fields.
- `POST /commitments/:id/reopen` — **add** — own, review-closed, in-window rows only.
- `GET /commitments/active-context` selection — **modify** — high rows join beacon rows, sub-capped at 8.
- `CommitmentTracker.record()` — **modify** — sentinel captures with identical normalized text in the same topic within 24 h return the open row.
- `autoExpiryDisposition` — **modify** — review stamps/reopens count as activity; high rows never age out.
- Owner-routed `patch-beacon` / `deliver` — **modify** — owner applies `priority` / `evidence`; caller maps an owner no-op on a priority-only PATCH to 409.

---

## 1. Over-block

- A genuine delivery whose proof is only a conversation message is accepted (kind `message`) but stored `evidenceRefResolved: false` — not refused.
- A commit sha that lives in another repository is stored unresolved, not refused. Only a commit that exists here and PRE-DATES the promise is refused — correct: it cannot be the fulfilment.
- A closure on a never-assessed row is refused until the decision states a priority — intentional (forces "who is waiting?" before closing); costs one field, not a run.
- The third closure in one batch with identical reason text is refused (`evidence-reused`) even if three genuinely identical cadence rows were obsolete for the same reason; they return next run (stamped, so not repeatedly). Accepted: the brake is against boilerplate.
- A capped closure waits for the next run. Intended.

## 2. Under-block

- The floor checks shape, ownership, caps and resolvable references; it cannot prove a promise was kept. A model can cite a real, later, unrelated commit. Mitigations: shadow phase with contradiction measurement, the `evidenceRefResolved` honesty flag shown in the dashboard story, 30-day reopen.
- `POST /commitments/:id/deliver` and `/withdraw` remain available to every session (unchanged pre-existing authority). The job prompt forbids it from using them; that is a prompt rule, not a structural barrier.
- A promise originating on a standby machine is not reviewed until that machine holds the lease (tracked: fb-a281e6b8-059).
- The sentinel dedupe matches exact normalized text only; paraphrased duplicates still land (the review's `duplicate` kind handles them).

## 3. Level-of-abstraction fit

Judgment lives in a job session (it needs evidence from conversations, git, feedback); the server holds only a deterministic floor. It feeds the existing tracker/beacon/sync machinery rather than paralleling it: archive is the existing `withdrawn`, closes go through tracker mutations, replication is the existing CommitmentsSync, routing is the existing owner-mutation path. The existing autoExpiry and graveyard reconciler are untouched except that review activity now counts as activity.

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

No brittle blocking authority over messages, sessions or user actions. The floor is an authority only over review closures and can only refuse; a refusal leaves the promise open (the safe direction). Judgment is the model's.

## 4b. Judgment-point check (Judgment Within Floors standard)

The competing-signals point ("is this done / obsolete / still wanted, and who is waiting?") is a judgment point with a floor: bounded action space (keep / prioritize / deliver / archive), conservative default `keep`, fallback to "nothing happens" and then to the unchanged deterministic sweepers. The deterministic checks only read facts the deciding model does not set in the same decision (stored priority, everHigh, checkInAt, target status, store counts).

## 5. Interactions

- PromiseBeacon: `closeByReview` emits `delivered`/`withdrawn` (beacon stops); reopen emits `resumed` (beacon re-arms a pending beacon row).
- Conversation bindings on minted ids are released on close by the existing mutateSync path; reopen refuses minted rows rather than half-restoring them.
- Auto-expiry: review stamps/reopens are activity; high rows never age out — so the two sweeps cannot fight.
- Graveyard reconciler: review archives write `supersededBy` on superseded/duplicate closes, the same evidence field the reconciler reads.
- Replication: every keep stamps a row, which bumps its replication seq; at ≤ 120 decisions/day that is a small re-send.
- Events from review closures fire inside the save batch, before the save — the same pattern `sweepAutoExpiry` already uses.
- Check-in reminder still posts its fixed template; tracked separately (fb-bf335cac-94f).

## 6. External surfaces

- `GET /commitments` gains an optional query param; default response unchanged.
- `/mobile/commitments` gains additive fields (`priority`, `closedBy`, `counts`) and ordering by priority; old apps ignore the fields.
- `/commitments/active-context` may show high rows and a `priority` field per row — visible to every session at start.
- A new job on every agent; it opens no session where the feature is dark or nothing is due. Sonnet spend on development agents: at most one session per 6 h.
- No user-facing message is ever sent by this change.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes — "Waiting on you" first, then the new "High priority" section open by default; the filter chips (names + counts, no descriptions) sit above the sections; each row opens the sheet with its actions.
2. **Zero raw internals as primary content?** Yes — rows show plain promise text and plain priority words ("High priority", "closed by my review"); ids stay in the sheet's support area only.
3. **Destructive actions de-emphasized?** Yes — "Undo — reopen" is a quiet button with a confirm and a reason; "Drop this promise" keeps its existing danger-quiet placement below.
4. **Plain language + phone width?** Labels are plain ("Not assessed", "Undo — reopen", "The proof could not be checked automatically"); the chip row wraps (`flex-wrap`), no tables. Verified by the jsdom model tests; a live phone-width render of the shipped console is part of the dev-agent-live rung after merge.

## 7. Multi-machine posture (Cross-Machine Coherence)

Unified. New fields replicate through CommitmentsSync (text redacted, enums and lengths clamped on receive); mesh reads show every machine's priorities; priority writes and deliver evidence forward to the owner. Review and reopen act on own rows (the existing single-writer ownership); caps are counted from those replicated rows. Standby-originated rows wait for their owner's next lease (tracked: fb-a281e6b8-059). No notices.

**Status surfaces:** `/capabilities` lists the three new endpoints; `GET /commitments/review/queue?peek=1` reports enabled/due/runnable.

## 8. Rollback cost

- **Hot-fix release:** revert; new fields stay as inert keys on rows.
- **Data migration:** none required. Review closures are reopenable for 30 days by runId from `logs/promise-review.jsonl`.
- **Agent state repair:** `commitments.promiseReview.enabled: false` (live) stops the job; `closureDryRun: true` (default) stops closures.
- **User visibility:** priority ordering on phone/dashboard reverts to the previous order.

## Conclusion

Ship, live on the development agent with closures shadowed, dark on the fleet. The two known gaps (standby-originated rows; the check-in reminder template) are tracked as fb-a281e6b8-059 and fb-bf335cac-94f.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (spec-converge round 2)
**Independent read of the artifact:** see the convergence report docs/specs/reports/promise-review-and-priority-convergence.md.

## Evidence pointers

- tests/unit/PromiseReview.test.ts, tests/unit/promise-priority-surfaces.test.ts, tests/unit/console-promises.test.ts
- tests/integration/promise-review-routes.test.ts
- tests/e2e/promise-review-lifecycle.test.ts
- Echo's 2026-11-06 backlog pass: 735 → 197 pending (logs/promise-backlog-pass-2026-11-06.jsonl in Echo's home)

## Addendum — Local Verify fixes (2026-11-06)

The first Local Verify run on head eda906b6a failed four unit tests. Each failure was diagnosed from its actual assertion and fixed:
- **write-domain ratchet:** the two new mutating routes had no declaration. They are now classified `cluster-shared` in `WriteDomainRegistry`, matching the other commitment mutations.
- **template agent-id lint:** three local API calls in the job template lacked `X-Instar-AgentId`. They now send it.
- **dark-gate golden line map:** the 13-line `promiseReview` defaults block shifted two hand-authored rows. The map was updated by hand, as that test requires.
- **no-silent-fallbacks ratchet:** three catch blocks in the evidence checks were not annotated. Each outcome is already visible in the result and the audit, so they now carry `@silent-fallback-ok`.

A local full unit run also showed a timing-dependent test of mine: it compared two separately computed `Date.now()` values for equality. That test now uses one instant. No runtime behaviour changed. The fixes do not change the decision-point inventory above.
