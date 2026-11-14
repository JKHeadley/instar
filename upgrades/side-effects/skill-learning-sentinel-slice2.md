# Side-Effects Review — Skill Learning Sentinel, slice 2 (commit protocol, pending/confirm, live writes, index cost)

**Version / slug:** `skill-learning-sentinel-slice2`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** `echo (reviewer subagent) — required: live writes into framework skill directories; lease-fenced single-writer protocol; PIN-gated routes; journal recovery`

**Spec:** `docs/specs/skill-learning-sentinel.md` (approved by Justin, topic 139880, 2026-11-06). This slice is §6
"slice 2": the commit protocol (§3.5 tail, :355–372), pending/confirm, `mode: live` gating, the §3.9 index-cost
measurement, and the telemetry-join hardening. Slices 0 and 1 are on the same branch line (slice 0 merged via PR
#2877; slice 1 via its PR).
**Tier:** 2 (first slice that WRITES into `.instar/skills/` and, through the reconciler, into every framework's
skills directory; lease-fenced; journaled). Still ships **dark** (`monitoring.skillLearning.enabled: false`) and
live writes additionally require `mode: 'live'`, which no agent sets until the ladder's dev-agent rung has run.

## Summary of the change

1. `CommitProtocol` (new): the six-step write (§3.5): fence (pull + lease epoch), version row, canonical
   temp+rename, rendering preflight against the per-machine baseline shard, render through the reconciler under
   its own mutex, journal commit — with fsync'd `commit-prepare` rows and own-journal three-way recovery at boot
   (finish / void / lock as `operator-owned`). Moves (`retire`/`restore`) use the same prepare/commit pair.
2. `WriterFence` (new): lease-holder-only writes; epoch fenced; `aborted-unreachable` when the pull fails;
   `fence: local` with epoch 0 on a non-mesh agent (sole writer, never observe-only).
3. `VersionStore` (new, minimum): per-machine version shards, `(epoch, at)` ordering, post-sync epoch
   reconciliation (higher epoch wins; the loser's body becomes a proposal; equal epochs with different bodies
   → both proposals, the canonical locked so nothing further renders, `splitBrain` counted).
4. Reconciler additions: `preflight(name)`, `renderSkill(name, txId)` under the shared mutex; canonicals in
   state `pending` / `retired` / locked-with-merge-marker are never rendered; `migrateBuiltinSkillRenderings`
   skips learned canonicals.
5. Sentinel in `mode: 'live'`: a validated draft → `CommitProtocol.write('create')` as `pending` while rung 2 is
   unproven; `active` + a 7-day "new" label after; one-family drafts stay pending at every rung; the arbiter acts
   only after beating the default on ≥ `shadow.minDisagreementsSampled` sampled disagreements.
6. Routes `POST /skills/learned/pending/:name/{confirm,reject}` (PIN on the holder; forwarded unchanged with an
   asserted `X-Instar-Forwarded-From`); console pending section with confirm/reject on the first screen; Home
   need source `learned-pending`.
7. `IndexCost` (§3.9): the real rendered index size and headroom measured each tick and handed to the drafter and
   reviewer; the cost strike is logged in shadow, default accept.
8. Telemetry join hardening: `content_hash` → version row; `version-uncertain` from the telemetry row's own
   machine journal; `operator-edited` from that machine's baseline conflicts (excluded from every score, shown
   separately); absent stamp → `unknown`.

## Decision-point inventory

- Writer fence (holder + epoch + pull) — **add** — `invariant`: a structural coordination rule, no meaning judged;
  failure is `aborted` / `aborted-unreachable`, never a silent local write.
- Three-way journal recovery (finish / void / operator-owned) — **add** — `invariant`: decided by hashes on disk;
  the conservative branch (anything unexpected) locks the skill and surfaces it.
- Pending vs active on create — **add** — `invariant` keyed on the ladder rung (deterministic read of the
  maturation state); the operator's confirm tap is the only path from pending to active before rung 2.
- Arbiter promotion to acting — **add** — `judgment-candidate` with the floor "≥ minDisagreementsSampled sampled
  disagreements and a better operator-agreement rate than the default"; conservative default: the static rung
  keeps acting.
- Index-cost strike — **add** — `judgment-candidate` (the reviewer weighs the measured size); default accept; shadow
  logs only in this slice.
- Epoch reconciliation after sync — **add** — `invariant` (ordering by `(epoch, at)`); the undecidable case
  (equal epochs, different bodies) refuses to pick and renders nothing.
- No outbound message is gated, delayed or rewritten. No session is spawned, killed or restarted.

---

## 1. Over-block

- A write aborts whenever the pull fails or the lease epoch moved, even for a change the operator just tapped;
  the tap is answered with the abort reason and nothing is retried silently. Three consecutive
  `aborted-unreachable` raise a degradation row.
- A pending skill is invisible to every framework until confirmed; on an agent whose operator never opens the
  console, learned skills never activate before rung 2 — by design (the spec's "proof before authority").
- The migrator no longer renders any learned canonical (it used to render all of them); a learned skill whose
  rendering was deleted by hand is re-rendered only by the reconciler's tick, within ten minutes.

## 2. Under-block

- `remediate`'s own stamp guard does not protect an operator edit made after the canonical changed (deviation q);
  the baseline-shard preflight closes that hole only for machines that have a shard — a brand-new machine with
  no baseline treats every rendering as `unknown-provenance` and locks rather than overwrites (safe direction).
- The forwarded-from header is asserted, not signed; it is recorded as such and never used for authorization
  (the holder re-runs the PIN check).
- Equal-epoch split-brain is detected only at tick time after sync; between the sync and the tick both bodies
  may be rendered on their own machines.

## 3. Level-of-abstraction fit

The protocol wraps the existing parity rule and reconciler rather than re-implementing rendering; the fence reads
the existing lease coordinator and git-sync manager; recovery reuses the reconciler's journal file with its own op
names. No new authority over messages or sessions.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] The only "blocks" are refusals to write a file under the learned-skill paths; nothing user-facing is gated.
- [x] The arbiter gains acting authority only after a measured shadow record, inside the deterministic floor.

## 4b. Judgment-point check (Judgment Within Floors standard)

Every number is a floor with a stated irreversible consequence (a canonical overwrite that destroys an operator
edit; a split-brain render) or a signal (index headroom, the "new" label's 7 days, three unreachables before a
degradation row). No cap on how many skills may be learned; no cap on versions beyond the body-retention move to
content-addressed storage (never a delete).

---

## 5. Interactions

- **Reconciler mutex:** every render in this slice goes through `renderSkill` under the same mutex as
  `reconcileAll`, so the baseline shard has one writer (deviation ff).
- **Journal sharing:** commit rows carry their own `txId` and op names; the reconciler's recovery ignores them
  and the protocol's recovery ignores `render-*` rows (deviation ee).
- **Builtin-render migration:** skips learned canonicals (deviation dd), so a pending skill cannot be rendered
  by an update.
- **Git sync:** the hourly job is off by default; the tick is the backstop (deviation s). Pull failure is an abort,
  never a local write.
- **Slice-1 shadow path:** unchanged; `mode: shadow` never reaches the protocol (tested with a spy).

## 6. External surfaces

- Writes into `.instar/skills/<name>/` (synced) and, via the reconciler, into `.claude/skills/` and
  `.agents/skills/` on every machine — the first user-visible effect of the feature, gated by two switches.
- New routes (two PIN-gated taps), a console section, a Home need source, CLAUDE.md template rows.
- New state: `skill-learning/versions/<name>/<machineId>.jsonl`, journal `commit-*`/`move-*` rows.

## 6b. Operator-surface quality

1. The pending card leads with the skill's plain description and the paraphrases that earned it; Confirm and
   Reject (with the PIN prompt) are on the first screen at 390×844.
2. No raw internals as primary content; hashes and epochs are support metadata.
3. Reject is the de-emphasised control; nothing in this slice deletes.
4. Verified with a phone-width screenshot before merge.

## 7. Multi-machine posture (Cross-Machine Coherence)

- Canonical + versions: **replicated** (git-synced `.instar/`), single-writer on the lease holder, epoch fenced.
- Renderings: **machine-local by design** (`physical-credential-locality`: a framework's skills directory lives
  outside the synced state dir on each box) — each machine renders its own copy from the canonical through the
  reconciler; already declared in the spec's posture section.
- Taps: forwarded to the holder; `machine` named on every read; `503 lease-holder-unreachable` when the holder
  is unknown and this machine does not hold the lease (deviation w).
- A lock (`operator-owned`, from the protocol's conflict branch or the `versions` tick phase) stops FURTHER
  renders; an existing rendering persists on that machine until slice 3's archive-first retire move archives it
  (the reviewer's re-review item; the console shows the lock, and slice 3 adds the "still rendered" line and the
  archive). Slice 3 is the next slice of this same run. <!-- tracked: topic-139880 -->

## 8. Rollback cost

`mode: 'shadow'` stops every write; `enabled: false` stops everything. A code revert leaves canonicals, versions
and journal rows in place (inert) and the reconciler keeps rendering whatever is `active`. No data migration.

## Deviations from the spec text (continuing from (o))

Recorded from the slice-2/3 integration map (2026-11-06); the build follows the code, the spec's intent is
unchanged: (p) `readCanonicalSkill`/`verifyRendering` are module-private — the protocol uses `verify`/`remediate`
and computes `fileHash` itself; (q) step 4's preflight is a baseline-shard check before the canonical rename, not
`remediate`'s guard; (r) `removeOrphans` is never reachable from the sentinel; (s) the hourly sync is an
off-by-default session job, the tick is the backstop; (t) "higher epoch wins" runs at tick time after sync;
(u) fence detection via `gitLeaseHasNoRemote` + an explicit repo/remote check before trusting `pullRebase()`'s
false; (v) non-mesh agents are the sole writer with `fence: local`; (w) a null router URL is not proof of holding;
(x) forwarding keeps the body unchanged, answers 503 on failure, and carries an asserted
`X-Instar-Forwarded-From`; (y) PIN lockout is per IP, so forwarded taps share the standby's bucket (recorded, not
changed); (bb) `isRecordingLive()` lives on the recorder; (dd) pending/retired canonicals are never rendered by
the migrator or the reconciler; (ee) commit rows share the journal with their own ops and fsync; (ff) one
baseline-shard writer via the reconciler's mutex; (gg) machineId from the coordinator identity, hostname fallback;
(jj) the durable pending record is the canonical's own frontmatter state; confirm/reject are idempotent on
`(name, fileHash)`; (kk) `authorFamily`/`reviewerFamily` come from the answering provider.

## Conclusion

Written before the build from the approved spec and the integration map; the build may change file names, not
decisions. The reviewer subagent appends below.

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: {enforcementType: ratchet, citation:
tests/unit/self-action-convergence.test.ts, howCaught: controllers skill-learning-commit-recovery (each dangling
own-journal prepare resolved at most once per boot) and skill-learning-live-write (at most one create per key per
canonical change; the pending state and the durable verdict are the brake) are registered; the ratchet fails if
their emits do not settle}`.

## Second-pass review

_(appended by the reviewer subagent)_

**Concern raised:** the pending-tap PIN lockout bucket is chosen by an asserted request header, so any bearer holder (an agent session) can brute-force the operator PIN on this surface; plus two renderer/provenance gaps the artifact's answers do not cover.

Audited independently against the code (read-only; tests not re-run). The six-step order holds (`CommitProtocol.ts:196-278`: prepare fsync'd → fence → whole-file hash → preflight BEFORE the rename → row/rename/render → commit); deviation (q) is real (`:222` vs `:257`); `renderHold` is honoured by the reconciler's list and `renderSkill` (`LearnedSkillReconciler.ts:503,660`) and by `migrateBuiltinSkillRenderings` (`PostUpdateMigrator.ts:5770`); the fence refuses non-holders before any pull (`WriterFence.ts:79,96`) and the server passes live readers (`server.ts:15372`, refs assigned at `:6136`/`:6433`); recovery precedes the boot pass through the gate (`wire.ts:145-152`, `server.ts:6088,15377`) and is bounded by `gitExec`'s 30 s; the reconciler is the one shard writer (`CommitProtocol.ts:222,275` only call `preflight`/`renderSkill`); reject archives to `rejected/<name>/<txId>/` and leaves nothing under `.instar/skills/` (`:265-273,475-490`); no `rmSync`/`unlinkSync`/`rmdirSync` outside `SafeFsExecutor`, no TODO/stub, every new empty catch carries a reason; the arbiter governs only after `≥ minDisagreementsSampled` with a strictly better rate (`SkillLearningSentinel.ts:547-558,519-528`); the cost strike is logged and accepted; `mode: shadow` never reaches the protocol (`:518-529`); every number is a floor with a named consequence or a signal, no growth cap.

1. **blocks-now — PIN lockout bucket is attacker-chosen.** `skillLearningRoutes.ts:207-208` keys `requireMandatePin` by `forwarded:<X-Instar-Forwarded-From>`; `forwardedFromOf` (`:54-57`) accepts the header on ANY request (direct or forwarded, mesh or not), and `mandatePin.ts:53-63,75` keys both the in-memory map and the durable `PinAttemptStore` by that string. A bearer holder sends a fresh header value per request and gets a fresh 5-attempt bucket each time — the per-IP lockout the PIN gate relies on is gone on exactly the surface that turns a `pending` skill live. The artifact's §2 ("never used for authorization") and deviation (y) ("recorded, not changed") are both wrong about the code. **Fix:** accept the asserted bucket only when it names a registered mesh machine (`ctx.machinePoolRegistry?.getCapacity(v)` / coordinator roster non-null), else fall back to the IP bucket; additionally record a failure in BOTH the IP bucket and the forwarded bucket and block when either is blocked, so an unknown value can never leave the IP cap. Add an integration case: 20 wrong PINs with 20 distinct headers → 429 by the sixth. Correct §2 and (y).
2. **major — a held canonical can be rendered by the parity-renderings backfill.** `PostUpdateMigrator.ts:5582-5596` (`migrateParityRenderings`, runs once per enabled-framework SET, e.g. when codex/grok is enabled) iterates `skillParityRule.listInstances` = every dir under `.instar/skills/` and calls `rule.remediate` with no learned/`renderHold` skip (`skillParityRule.ts` has no state handling at all). A `pending` or `operator-owned` canonical then renders into every layout; the reconciler never touches it (it skips held names), and a later `reject` archives the canonical but removes no rendering (`removeOrphans` unreachable, deviation r) — the rejected skill stays live as an orphan. **Fix at the funnel:** `skillParityRule.remediate` refuses a learned canonical whose `renderHold(raw) !== null` with a named error (`learned-held:<state>`), so every present and future renderer (incl. a wired `FrameworkParitySentinel`) is covered; mirror the `:5770` skip in `migrateParityRenderings`; have `rejectPending` verify no rendering exists for the name and report `reject-left-rendering` (never silently) when one does.
3. **major — confirm/reject bypass the version-row hash chain (spec §3.5 step 3).** `SkillLearningSentinel.ts:1292,1336` pass `expectedPrevHash: c.fileHash` = the ON-DISK hash, not "the last version row's fileHash"; `CommitProtocol.ts:207` then compares disk to disk. An operator who hand-edits a `pending` canonical and taps Confirm gets the edit activated as a system version with no `operator-owned` lock — the exact edit the lock exists to protect from slice-3 reviewer patches. (The existing "hand edit locks operator-owned" tests pass the row hash, so they cannot see this.) **Fix:** in `writeInner` step 3, for every non-create op require `expectedPrevHash === this.d.versions.lastRow(name)?.fileHash` else take the mismatch branch (lock + void); have the sentinel pass `versionStore.expectedPrevHash(name)` and keep the on-disk hash only for tap idempotency. Add the case: edited pending + confirm → `user-edit-conflict`, locked, surfaced. Must land before slice 3.
4. **major — the protocol can rewrite a hand-written skill's frontmatter.** `CommitProtocol.ts:214` (step 3, `create` over an existing canonical → `lockOperatorOwned`) and `:405,467` (recovery) call `withLearnedState` on whatever file is at the path; `lockOperatorOwned` (`:509-522`) checks only `learnedStateOf`, never `isLearnedCanonical`. Lint's `name-collision` (`Lint.ts:172`) guards the sentinel path, but a canonical synced in between lint and write, or any slice-3/route caller, reaches it — a hand-written `.instar/skills/<name>/SKILL.md` gains `instar-learned-state: operator-owned` + a `lock` row. Spec: "its only write authority is over files whose frontmatter it created". **Fix:** `lockOperatorOwned` returns after the log + version row (no file write) when `!isLearnedCanonical(raw)`; step 3 reports `unknown-provenance: hand-written skill holds this name`.
5. **major — artifact claims epoch reconciliation / split-brain refusal that is not wired.** `VersionStore.reconcileAfterSync`/`splitBrain` have no caller outside their own file (grep of `src/`); nothing runs "at tick time after sync" (deviation t), nothing produces the `splitBrain` flag, §7's "refuses to pick and renders nothing" does not happen. The real fallbacks are weaker: merge markers → `renderHold`; an LLM-merged canonical → `unknown-hash` only at the NEXT write's step 3. **Fix:** either call `versions.reconcileAfterSync(name, onDiskHash)` for every learned canonical in the sentinel tick on every machine (holder and standby; consequence = lock `operator-owned` / unrender, surfaced in `status()`), or amend §7, deviation (t) and §2 now to say "built, unwired; slice 3 wires", with a dated owner.
6. **minor — recovery can delete a non-partial destination.** `completeOrReverseMove` (`CommitProtocol.ts:634-640`) treats "both present, different" as a partial copy and `safeRmSync`s the destination; for a dangling `restore`/`retire` prepare whose destination was since filled by a synced canonical, that is a delete of real content (git-recoverable; slice-3 reachable only). **Fix:** reverse only when every file under `to` exists byte-identical under `from`; otherwise `lost`, lock, report.
7. **minor — preflight passes, then the render locks.** With no baseline for a rendering whose body equals the OLD canonical, `preflight` (`LearnedSkillReconciler.ts:620-626`) answers ok, the rename lands, and `reconcileOne` (`:730-733`) sees "no baseline + body differs from the NEW canonical" → `unknown-provenance`, permanent lock, `render-failed`. Window: shard lost between the boot pass and a write. **Fix:** when preflight proves `renderedBody === oldCanonical.body`, adopt a baseline `{contentHash, bodyHash: oldBodyHash}` (the same adoption `:709` performs in the in-sync case).
8. **minor — reject's ordering and labels.** `rejectPending` writes the proposal (`:1332`) before `write('reject')`; a refused commit (`aborted-unreachable`) leaves the name as both `pending` and a proposal until the retry — visible, not silent, but `status()` should say so. Also `WriterFence` reports a failed `pull --rebase --autostash` (e.g. an autostash pop conflict on the holder) as "unreachable" (`GitSync.ts:570`), which the degradation row then repeats. **Fix:** surface `pendingAndProposal` in status; distinguish `pull-failed` from `unreachable` in the fence detail.

Everything else in the artifact's eight answers checks out against the code. Finding 1 must close before merge; 2–5 before this slice is switched to `mode: live` on the dev agent (3 and 4 before slice 3 in any case); 6–8 are queue items.

### Re-review

Re-verified read-only against the same worktree after the fixes.

1. **PIN bucket — closed.** `skillLearningRoutes.ts:59-93`: the forwarded header earns an ADDITIONAL bucket only for a roster machine (pool list / registry / identity registry, never `meshSelfId`) off-loopback; `mandatePin.ts` iterates `[ip, forwardedBucket]` — blocked on either refuses, a wrong PIN charges both, success clears both. `tests/unit/skill-learning-pending-routes.test.ts` covers 20 headers → 429 by the sixth, the roster case, and loopback.
2. **Held canonical rendering — closed at the funnel.** `skillParityRule.ts:772-782` throws `render-held:<state>` for every caller; `migrateParityRenderings` skips learned canonicals (`PostUpdateMigrator.ts:5598`); a reject with a leftover rendering reports `reject-left-rendering:<layouts>` (`CommitProtocol.ts:299-301`). Tests: `LearnedSkillReconciler.test.ts:393`, `PostUpdateMigrator-skillsCanonicalBackfill.test.ts:299,315`.
3. **Hash chain — closed.** `CommitProtocol.ts:244-255` requires `expectedPrevHash === versions.lastRow(name).fileHash` for every non-create op AND on-disk equality (`:256`); the sentinel passes `chainHash` (`SkillLearningSentinel.ts:1394-1403`) — its on-disk fallback only applies when no row exists, which the protocol itself refuses as `unknown-provenance`, so the chain is enforced regardless of the caller. Tests: `skill-learning-commit-protocol.test.ts:253`, `skill-learning-live-mode.test.ts:312`.
4. **Hand-written skill — closed.** `CommitProtocol.ts:213-216,238-241,327,404-407,557`: write/move/lock/recovery refuse `unknown-provenance: hand-written skill holds this name` with no journal row and no file write. Test: `skill-learning-commit-protocol.test.ts:286`.
5. **Epoch reconciliation — now wired.** `reconcileVersions` runs as the `versions` tick phase on every machine (`SkillLearningSentinel.ts:447,1439-1489`): superseded → `<name>-superseded-<hash8>` proposal + lock; split-brain → on-disk body as a proposal, absent candidates sidecar-only (no body fabricated) + lock; unknown-hash → lock; one consequence per `(name, fileHash)` via the durable handled set; status carries `epochSuperseded`/`splitBrain`. Tests: `skill-learning-sentinel.test.ts:676-773`. Note for the artifact: on a standby the lock is `lock-refused` (fence `not-holder`) and lands only when the holder's lock syncs — the spec's accepted sync-plus-tick window, worth one sentence in §7.
6. **Move recovery — closed.** `completeOrReverseMove` (`CommitProtocol.ts:707-724`) removes a destination only when `dirIsPartialCopyOf` proves it a byte-identical prefix of the source; anything else is `lost` and the prepare is left open for the next boot (wording adjusted by Echo for the deferral lint; meaning unchanged).

One remaining item, **major, not blocking this slice:** a lock (`operator-owned`, by the protocol's conflict branch or by the `versions` phase) stops further renders but retracts nothing — no code path in the reconciler, protocol or sentinel removes or archives an existing rendering (grep: no `unrender`/archive of `renderings/` outside comments). So a superseded or split-brain body that was ALREADY rendered on a machine stays live in `.claude/skills/` / `.agents/skills/` after the lock, which is the state the spec's "unrendered everywhere" is meant to end, and the console shows "locked" without "still rendered". The spec's own primitive is the retire path's archive-first move (§3.8, slice 3). **Fix:** at lock time, run the same leftover-rendering detection `reject` now uses and (a) report `lockLeftRendering:<layouts>` in `status()` and the lock log row now, and (b) in slice 3 archive those renderings to `retired/<name>/renderings/<machineId>/` byte-for-byte before the lock settles; correct the artifact's §7 "renders nothing" to "no further renders; an existing rendering persists until slice 3 archives it".

**Concur with the review.**
