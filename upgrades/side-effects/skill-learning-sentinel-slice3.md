# Side-Effects Review — Skill Learning Sentinel, slice 3 (reviewer patches, versions, bounded revert, retire, attention)

**Version / slug:** `skill-learning-sentinel-slice3`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** `echo (reviewer subagent) — required: self-heal gates + attention items; bounded revert with a breaker; retire as a reconciliation that moves renderings on every machine`

**Spec:** `docs/specs/skill-learning-sentinel.md` (approved by Justin, topic 139880, 2026-11-06). This slice is §6
"slice 3": §3.7 (reviewer patches with cited hunks, versions, bounded revert + breaker), §3.8 (retire as its own
reconciliation, archive first; lock/unlock/retire/restore/retire-all), the attention items 1–6 (§3.10 list) with
self-heal declarations. Built on slices 0–2.
**Tier:** 2 (new authority to change, revert, lock and retire learned skills; attention items that reach the
operator; renderings moved on every machine). Ships **dark** behind `monitoring.skillLearning.enabled` and the
`mode: live` switch; in shadow the reviewer, reverter and retirer only log what they would do.

## Summary of the change

1. `Reviewer` (new): on a `corrected` run (or a late flip) proposes a patch as cited hunks — each hunk must name
   the correction event it answers; uncited hunks are dropped; the patched document runs the same lint, semantic
   flags and cross-family review as a draft; a single reachable family holds the patch until
   `review.minCorrectedRunsSameFamily` corrected runs agree AND the operator confirms.
2. `VersionStore` extensions: bodies retained (last 20 inline, older content-addressed — moved, never deleted),
   per-version score with uncertainty, `rejectedBodyHash`, cited corrections, `revertOf`.
3. `Reverter` (new): bounded revert when N+1 has ≥3 corroborated runs, ≥2 corrected, and a corrected rate strictly
   above N's; a refused revert leaves N+1 pending; later patches matching a rejected body or cited set are refused;
   two agreeing corrected runs required after a revert; `review.revertBreakerPer30d` reverts lock the skill.
4. Lock retraction (carried from slice 2's re-review): a lock (`operator-owned`, from the protocol's conflict
   branch or the `versions` tick phase) stops further renders but retracts nothing; this slice archives any
   leftover rendering of a locked canonical on each machine's tick (same archive-first move as retire, into
   `retired/<name>/renderings/<machineId>/`), reports `lockLeftRendering` in `status()` and the lock log row,
   and the console's locked section says "still rendered on <machine>" until the archive lands.
5. `Retirer` (new): retire is its own reconciliation — the holder decides (floors: ≥ `retire.minCorroboratedRuns`
   on the current version; two misfire verdicts for a misfire retire; unused = one observed request with no use or
   silence for 3 × `windowDays`), moves the canonical to `skill-learning/retired/<name>/`; every machine's tick then
   ARCHIVES its own rendering byte-for-byte (edited or not) into the retired folder before removing it from the
   framework's discovery; a move that cannot complete reports `retire-blocked` and the skill stays active; retire
   for harm records a learning. Restore re-lints and re-reviews with a different family. `retire-all` audits an
   actor and a re-arm review date.
6. Routes `POST /skills/learned/:name/{lock,unlock,retire,restore}` and `POST /skills/learned/retire-all`
   (holder PIN, forwarded like the pending taps); console retired + locked sections.
7. `SkillLearningAttention` (new): items 1–4 behind `SelfHealGate` episodes (heal first: bounded revert; retire the
   lowest-scored unused skill; swap the drafter family once; the classifier failure swap) with `maxAttempts 3`,
   backoff 1 h / 6 h / 24 h, flap 3-in-7-days → escalate, a 120 s notification-latency ceiling, dedupe per key;
   items 5 (unmeasured / revert breaker / split-brain) and 6 (growth) notify only; cause-clear closes the item.

## Decision-point inventory

- Hunk citation (every hunk answers a named correction) — **add** — `invariant`: structural provenance, no
  meaning judged; uncited hunks dropped.
- Patch content — **add** — `judgment-candidate` (reviewer LLM) inside the same deterministic lint floor as a
  draft; default when it cannot decide: no change.
- Revert trigger — **add** — `invariant`: three counts on the ledger; the arbiter has no say (a revert is the
  safety direction).
- Retire verdict (`retire | keep | patch`) — **add** — `judgment-candidate` with the deterministic floors above
  and static defaults that act only when the reviewer is unavailable; the retire arbiter's shadow pair is judged
  on restore rate.
- Attention escalation — **add** — `invariant` gated on `selfHealAttempted && selfHealExhausted` (Standard B);
  flap auto-escalates; irreversible classes (none in this slice: every heal is a move or a bounded revert) would
  escalate immediately.
- No outbound message is gated; attention items are the only operator-facing output and all are heal-first
  except 5 and 6.

---

## 1. Over-block

- A patch with one uncited hunk loses that hunk; the reviewer sees the remainder. A patch whose target is locked
  is never applied, even for a correction the operator just made — the lock is theirs to lift.
- A retire for low score needs three corroborated runs on the current version; a skill used twice and corrected
  twice stays active until the third run.
- The revert breaker locks a skill after two reverts in 30 days even if the third version would have been right.

## 2. Under-block

- The reviewer's family is read from the answering provider; with the failure swap on, two providers can answer
  from the same family in one review — detected by the recorded family, held like a one-family review.
- Attention items live in the holder's adapter; a lease move leaves the old holder's open items until cause-clear
  runs there (recorded; the episode store is machine-local by declaration).
- A machine that is offline during a retire keeps its rendering until its next tick; nothing removes it remotely.

## 3. Level-of-abstraction fit

Versions, revert and retire are written through slice 2's `CommitProtocol` (one write path); renderings move
through the reconciler's mutex; attention goes through the existing `createAttentionItem` / `SelfHealGate` /
governor primitives — a thin declaration layer, never a new workflow engine (Standard B's "reuse the existing
P19 breakers").

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No deterministic check blocks a user-facing message or action; the only deterministic authority is over
  the sentinel's own files (lock / refuse-to-patch / refuse-to-revert) in the safety direction.
- [x] The LLM reviewer and retire arbiter act only inside deterministic floors, through the journaled protocol,
  and in shadow only log.

## 4b. Judgment-point check (Judgment Within Floors standard)

Every number is a floor with a stated irreversible consequence (a revert that discards a good version; a retire
that hides a skill the operator relies on; an escalation that pages the operator) or a brake (three heal attempts
with backoff; the flap window; the breaker). None caps how many skills, versions or patches exist; body retention
moves to content-addressed storage and never deletes.

---

## 5. Interactions

- **Commit protocol:** every write in this slice is a `write('patch'|'revert'|'confirm'|'reject'|'lock'|'unlock')`
  or `move('retire'|'restore')`; the journal recovery already handles half-done moves in both directions.
- **Reconciler:** retired renderings are archived and removed inside `reconcileAll` under the same mutex; pending
  and retired canonicals are never rendered (slice 2).
- **Outcomes:** a late correction enqueues the reviewer (slice 1 wrote the event row); the reviewer is idempotent
  by runId.
- **Attention:** `conditionKey` per item × key; the gate's dedupe key is the hashed procedure key; cause-clear uses
  `{reconcile: true}`.
- **Self-heal episode store:** shared `state/self-heal-gate.db` with a 256-episode cap — episodes are closed on
  cause-clear and keyed tightly so this feature cannot crowd out other consumers.

## 6. External surfaces

- Renderings REMOVED from `.claude/skills/` / `.agents/skills/` on every machine when a skill retires (after a
  byte-for-byte archive); the first destructive-looking operation of the feature, implemented as a move.
- Five new PIN-gated routes; two console sections; attention items in the operator's hub (needsUser on 1–5,
  silent on 6).
- New state: `skill-learning/retired/<name>/…`, `versions/<name>/bodies/`, `versions/_cas/`, self-heal episodes.

## 6b. Operator-surface quality

1. The retired section leads with the plain reason and a Restore button; the locked section shows the conflict in
   words and where the archive is.
2. No raw internals as primary content.
3. Retire-all is de-emphasised and asks for the PIN with the re-arm date shown.
4. Verified at 390×844 before merge.

## 7. Multi-machine posture (Cross-Machine Coherence)

- Canonical, versions, retired folder: **replicated** (synced), single-writer on the holder.
- Renderings and their archives: **machine-local by design** (`physical-credential-locality`: the framework's
  skills directory on each box) — each machine archives and removes its own copy on its tick.
- Attention items and self-heal episodes: **machine-local by declaration** on the holder (`durable-machine-local`
  episode authority; a lease move restarts the episode) — recorded as a deviation and surfaced in status.

## 8. Rollback cost

`mode: shadow` stops every automatic write: the retire, revert and review phases still run their judgment (the
reviewer calls are measured) but append `would-retire` / `would-revert` / `would-patch` rows to
`logs/skill-learning.jsonl` and call neither `write` nor `move` on the protocol; the write-heals (items 1/2) answer
`governed: shadow` and nothing pages (`tests/unit/skill-learning-shadow-writes.test.ts`). The operator's own PIN taps
(confirm/reject/lock/unlock/retire/restore) stay live in shadow — they are the operator's writes, not the sentinel's.
`enabled: false` stops everything incl. attention. A code revert leaves retired
archives, version bodies and episodes in place (inert). A wrongly retired skill is restored from its archive through
the route; nothing in this slice deletes.

## Deviations from the spec text (continuing from (o) and slice 2's set)

(3C-1) `SelfHealGate.notificationLatencyCeilingMs` is a sustained-failure latch, not the spec's 120 s "notify
within" ceiling: the gate's field is pinned to the 3-day wall clock and the 120 s ceiling is enforced by the
attention controller itself (exhaustion and notice are one gate call; `latencyMs`/`withinCeiling` audited, a
miss reports a degradation). (3C-2) The self-heal episode store is a per-machine JSON file
(`skill-learning/self-heal-episodes.<machineId>.json`, cap 512, prunable) rather than the shared SQLite store,
whose 256-row cap has no delete and would fill permanently with per-skill keys; exhausted episodes are removed on
cause-clear so a recurrence heals again. (3C-3) A lease move restarts an episode (state and episodes are
machine-local by declaration). (3C-4) Attention ids use the procedure key verbatim only when it is a plain
slug; hostile keys become `h-<16 hex>`; item-5 keys carry a sub-kind. (3C-5) Items 3/4 swap once per episode;
the condition moving past the swap's marker notifies (terminal); item 2 persists 7 days after the last strike.
(3C-6) Item 1's signal reads `instar-learned-retire-reason: harm…` from the retired canonical. (3C-7) The
`attention` phase runs on every machine; the controller gates on `holdsLease` (standby → `governed:
fence-stale`, no store touch); the fence epoch is `local` until a coordinator seam is handed in.
(3B-1) `retire-all` also PAUSES drafting on the holder until its `reArmReviewAt` (now + 14 d, the audit row's
field; `skill-learning/retire-all.<machineId>.json` is the durable record and status shows the date) — beyond
§3.8's text: a bulk retire is the operator's signal that drafting is unwanted until it is reviewed, so the brake
is dated, owned by that review, and visible, never a static cap.
(z) `SelfHealGate` refuses pool-shared controllers and async remediation → used for episode / backoff / flap
accounting only, with a synchronous read of the previous tick's async heal outcome; (aa) attention items live in
the holder's adapter, dedupe via `conditionKey: skill-learning:<n>:<key>`, cause-clear needs `{reconcile:true}`;
(cc) no move primitive in `SafeFsExecutor` → `fs.renameSync` within one filesystem, else copy + verify +
`safeRmSync` with an operation label; (ii) learnings recorded in-process via `EvolutionManager.addLearning`;
(kk) families from the answering provider.

## Conclusion

Written before the build from the approved spec and the integration map; the build may change file names, not
decisions. The reviewer subagent appends below.

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: {enforcementType: ratchet, citation:
tests/unit/self-action-convergence.test.ts, howCaught: controllers skill-learning-revert (perTarget =
revertBreakerPer30d per key per 30 days, then the lock holds), skill-learning-review-retry (one review per
corrected run by runId), learned-skill-retire-reconcile (one archive+remove per skill × target × machine; the
moved directory is the brake), skill-learning-retire-judgment (one retire per skill per version) and
skill-learning-attention-notify (one notice per episode, flap-bounded) are registered; the ratchet fails if their
emits do not settle}`.

## Second-pass review

_(appended by the reviewer subagent)_

**Concern raised:** the "ships dark / `mode: shadow` stops every write" claim is false in the code — the retire, revert
and review phases and the two write-heals never read the mode, and the commit stack is built in every mode.

Verified independently and found as described: no `rmSync`/`unlinkSync`/`rmdirSync` outside `SafeFsExecutor`; no
TODO/stub; every removal of a rendering is a move (rename, or copy → `dirsByteIdentical` → `safeRmSync`), a partial
archive is removed only when `dirIsPartialCopyOf` proves it a prefix of the intact source; `removeOrphans` has no
caller in the learned path; a hand-written skill holding a learned name is never moved (`no-learned-marker`, reported);
the sweep runs first inside `reconcileAll` under the mutex (LearnedSkillReconciler.ts:344–357, :573–580); a patch
cannot land without a cited hunk (Reviewer.ts:260–277, :469–471), on a locked or non-origin canonical (:368–370), or
on a rejected body / cited set (:475–476); the five taps use the pending taps' forward-first + forwarded-bucket idiom
(skillLearningRoutes.ts:206–243, :266–304); items 1–4 notify only from `exhaust()` (SelfHealGate attempt :150–172,
after `attempts ≥ 3`) or a `terminal` heal outcome (the spec's own notify condition), items 5/6 are notify-only and 6
is silent; `retire-all` writes `{ actor, reArmReviewAt }` to the log and a durable file; the episode store is the
per-machine JSON file with a 512 cap and `remove` on cause-clear (3C-2 holds); a standby audits `governed:
fence-stale` and touches nothing (3C-7 holds); all nine controllers have registry entries. Findings:

1. **blocks-now** — Shadow mode does not stop the slice-3 writes. `wire.ts:146–149` builds the commit stack on every
   machine in every mode; `SkillLearningSentinel.ts:525–532` runs `retire` → `revert` → `review` on `holdsLease()`
   alone (`this.mode()` is read only at :574/:631 for drafting and :1473 for status); `Retirer.ts`, `Reverter.ts`,
   `Reviewer.ts` never read `cfg.mode`; `healRevertFirst` (:1406) and `healRetireLowestUnused` (:1417) write too. In
   `mode: shadow` with live canonicals present — the exact state after the §8 rollback — the holder retires, reverts
   and patches them through the protocol, and the retire reviewer is called (slice 1's "shadow never calls the
   arbiter"). Fix: gate the three phases and the two write-heals on `this.mode() === 'live'`; in shadow compute the
   decision and append `would-retire` / `would-revert` / `would-patch` rows with no protocol call (what the summary
   claims); skip gated items 1/2 in `conditions()` when a new `signals.live` is false so shadow neither heals nor
   pages; add a unit test that a shadow tick over a retirable, revertable and patchable canonical makes zero
   `write`/`move` calls; reword §8 (the operator taps may stay live in shadow — say so).
   **Resolved (3A, second pass):** the three phases take `dryRun = mode !== 'live'` (`SkillLearningSentinel.ts` tick),
   `Retirer.judge(…, {dryRun})`, `Reverter.tick({dryRun})` and `Reviewer.tick({dryRun})` log the would-* rows with no
   protocol call, `healRevertFirst`/`healRetireLowestUnused` answer `reason: 'shadow'`, and `SkillLearningSignals.live`
   makes the attention controller report items 1/2 as `governed: shadow`. Test:
   `tests/unit/skill-learning-shadow-writes.test.ts` (a shadow tick over a retirable + revertable + patchable canonical:
   zero `write`/`move` calls, the three would-* rows, items 1/2 governed).
2. **major** — A patch lands ACTIVE with no cross-family review and no confirm when the one reachable family is not
   the recorded author's. `Reviewer.ts:397–401`: `sameFamily` is `pickReviewer(families, authorFamily) === null`;
   with `families = [openai]` and `authorFamily = anthropic` (recorded while both were reachable) the reviewer is
   openai, `validator = pickReviewer([openai], 'openai') = null`, `state = 'active'` (:483) and the `else` branch
   (:532–535) checks only `policy-relaxation` before `write('patch')` (:542), stamping `reviewerFamily:
   same-as-author` on a row that is not. Fix: `const held = sameFamily || validator === null`; apply the `minSame`
   floor (:402–406) and the `pending` + sidecar path (:483, :554–559) to `held`, `pendingReason: 'one-family'`
   (already in `PendingSidecarInput`); unit test with a one-family roster whose author family differs.
3. **major** — `Reverter.tick()` can revert INTO a rejected body and past the breaker. (a) :114 picks `previous`
   without the `rejectedVersions` check `revertOne` makes at :159–161, so after revert N+2 = body(N), a later decline
   of N reverts to N+1 — the body the first revert rejected. (b) The breaker is read only after the revert (:216–218)
   with no pre-check like :162–164; when the lock write at :232 is refused (fence, conflict) the key stays `active`
   and the next trigger reverts again, exceeding `revertBreakerPer30d`. Fix: in `tick()` before `revert()`, skip with
   a `revert-skipped: reverted-to-rejected` log row when `previous.bodyHash` is rejected, and when
   `revertsSince(...) ≥ limit` do not revert — re-attempt `write('lock')` and append the `revert-breaker` event
   instead; tests for both (the :193 breaker test should also cover a refused lock).
4. **major** — The 3C-1 "120 s ceiling enforced by the controller" measures the wrong interval. `latencyMs =
   now - live.startedAt` (`SkillLearningAttention.ts:408, :469, :491`) spans one `gate.attempt` call, so
   `withinCeiling` is always true — a monitor with no positive control. The interval the spec names, last failed heal
   → notice, is unbounded by the controller: `recordOutcome` (:454) only stores the failure; exhaustion waits for the
   next tick's `attempt` (SelfHealGate :150), i.e. up to `tickMinutes` (default 10, `ConfigDefaults.ts:50`), five
   times the ceiling. Fix: when `recordOutcome` stores a non-healed outcome and the episode's `attempts ≥
   maxAttempts`, re-run `handleGated` for that condition in the same turn (exhaustion + notice follow the failure
   directly); compute `latencyMs` from `state.outcomes[dedupe].at`; change the :197–200 assertion so a 10-minute gap
   fails it; keep the degradation report for a miss.
5. **minor** — Set-aside leftovers after a crash. `Retirer.ts:918–930` renames `retired/<name>` (archives only) to
   `<name>.aside-xxxx` under `commitOp: 'retire'`; if the process dies before `mergeAside`, `recoverMove`
   (CommitProtocol.ts:531–546) sees `to` present / `from` absent → `completed`, and the aside directory stays forever,
   invisible to `listRetired` (:388 rejects the dot). Nothing is lost, but every machine's archive of that skill
   vanishes from the console. Fix: on `retireInner` entry and in `listRetired`, merge or report `retired/<name>.aside-*`.
6. **minor** — A learned-marker rendering with no canonical in `.instar/skills` or `retired/` (a hand-deleted
   canonical) survives the sweep silently: :472–481 iterate retired names and held canonicals only, so neither
   `lockLeftRendering` nor `retireBlocked` lists it. Fix: list such renderings as `orphanRendering[]` in the sweep and
   status (never moved — the spec's "unrelated orphans are never touched" still holds).
7. **minor** — `retire-all` pauses drafting until `reArmReviewAt` (`SkillLearningSentinel.ts:521–524`,
   `Retirer.ts:449–454`): a dated brake with a stated consequence, acceptable under Judgment Within Floors, but it is
   beyond §3.8's text and absent from the deviations. Record it as (3C-8) with the re-arm date as its owner.
8. **minor** — Retirer archive rows use `commitOp: 'retire'` with a fresh txId; a reversed/lost recovery calls
   `versions.markVoid(name, txId)` (CommitProtocol.ts:544) and appends a tombstone no row references. Harmless noise;
   give the rendering moves their own `commitOp` (`archive-rendering`) that recovery completes/reverses without
   touching the version store.

### Re-review

Re-verified read-only against the code after the fixes (same worktree):

1. Shadow writes — `SkillLearningSentinel.ts:530–537` computes `dryRun = this.mode() !== 'live'` and passes it to
   `judgeRetirements` / `reverter.tick` / `reviewer.tick`; `Retirer.judge` (:732–736) logs `would-retire` with no
   `retire()` call and memoises `:would` so live acts once; `Reverter.revert` (:230) and every `refuse` under dryRun
   (:210) return `wouldRevert` before `write`; `Reviewer.review` (:549–558) returns `would-patch` before `storeBody`/
   `write`; `healRevertFirst` (:1414) / `healRetireLowestUnused` (:1425) answer `reason: 'shadow'`; `signals.live`
   (:1127) gates items 1/2 to `governed: shadow` (`SkillLearningAttention.ts:391–396`); the new
   `tests/unit/skill-learning-shadow-writes.test.ts` asserts zero write/move calls and the once-on-flip; §8 reworded
   and names the operator taps as the exception. Closed.
2. One-family patch — `Reviewer.ts:411–418`: `held = sameFamily || validator === null` drives the `minSame` floor,
   `state = held ? 'pending' : 'active'` (:494), the sidecar with `pendingReason` (:578–581) and the `one-family` row
   label (:514). Closed.
3. Reverter — `:124–130` skips (`revert-skipped: rejected-body`, handled-set, evidence row) when the body before the
   live one was rejected; `:145–158` reads the breaker BEFORE reverting and re-attempts the lock (`breaker(...,
   'relock')`, event + log) instead of another revert, handled-set so a refused lock cannot loop on the same body.
   Closed.
4. Latency ceiling — `SkillLearningAttention.ts:470–481`: the last allowed heal's failure calls `attemptGate` in the
   same turn (exhaustion + notice follow the failure directly, outcome marked terminal so the next tick does not
   re-launch); `notify` (:501–504) measures `latencyMs` from `failedAt`; a refused store write is kept in
   `state.pendingNotices` (:513) and retried each tick with the original `failedAt` (:532–534), audited
   `withinCeiling: false` + degradation when late; the unit test now asserts `latencyMs: 0` same-turn and a
   10-minute-late retry fails the ceiling. The measurement now has a positive control. Closed.
5. Asides — `Retirer.recoverAsides` (:464–478) runs first in every sweep, puts the directory back or merges it,
   journaled, failures reported in `blocked`. Closed.
6. Orphans — `orphanLearnedRenderings()` (:484–497) reported through `lockLeftRendering` with state
   `orphan-learned-rendering` in the sweep (:539) and the read path (:431); never moved; unit test at
   `skill-learning-retirer.test.ts:325`. Closed.
7. Retire-all pause — recorded as deviation (3B-1) with its re-arm date; tested (`:344`, `:543`). Closed.
8. Archive rows — `commitOp: 'archive-rendering'` (`types.ts:317`); `recoverMove` (`CommitProtocol.ts:533, :546`)
   completes/reverses without `markVoid`. Closed.

No raw `rmSync`/`unlinkSync`/`rmdirSync` was introduced by the fixes. No remaining blocks-now or major findings.

**Concur with the review.**

**Follow-up (CI, 2026-11-07):** the ledger cache registers/unregisters its better-sqlite3 handle per the SqliteRegistry contract and is allowlisted in the wiring test (same fix as slices 1 and 2). No behaviour change.
