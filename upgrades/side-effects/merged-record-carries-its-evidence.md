# Side-Effects Review — a merged record that could not name what merged it

**Version / slug:** `merged-record-carries-its-evidence`
**Date:** `2026-07-26`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `author-applied lenses — see Phase 5 (reduced independence, disclosed)`

## Summary of the change

`/projects/:id/advance` validated a submitted artifact for `building → merged` — PR
state `MERGED`, a format-valid merge sha, that sha reachable from canonical main, CI
rollup green — and then wrote **only** `pipelineStage`. The validated evidence built
the validation context and was discarded. Measured on the live store: both Tier-1
children of `convergence-towards-coherence` read `pipelineStage: "merged"` with no
`prNumber`, no `mergeCommitOid`, no `ciCheckedAt`.

The root cause was a **type**. `StageTransitionResult`'s success case was `{ ok: true }`
— one bit — while every refusal carried `reason` + `code`. The validator explained
itself when it refused and said nothing when it approved, so the caller had nothing to
persist. The fix widens the success case to carry a `MergedEvidence` record and
persists it in the same `update()` as the stage.

**The consequential half:** two merged-state reconcilers select on `mergeCommitOid` —
`GET /projects/:id`'s lazy reconciler (documented "may mutate", runs on every read) and
`verifyMergedItemsViaGit`. With the field never written, the candidate set was always
empty, `verifyMergedItemsViaGit` was never called, and both reported nothing. A
regression detector that scans nothing is indistinguishable from one that finds no
regressions.

Because that path had never executed, three defects sat in it unexercised — all three
already fixed in the advance path a few hundred lines away: (1) `SafeGitExecutor.run`
without `sourceTreeReadOk`, so SourceTreeGuard refuses the read against an instar
source tree (the #1641 defect); (2) a hardcoded `origin/main`, which on a dev-agent
home is the agent's FORK; (3) `catch {}` → not verified → caller marks `regressed`,
i.e. a refusal rendered as "it was reverted". Writing the evidence is what ARMS that
path, so the two halves ship together.

## Decision-point inventory

| point | classification | note |
|---|---|---|
| success-case evidence on `StageTransitionResult` | `invariant` | Pure data carriage. Adds no branch and cannot change a verdict — the same four checks decide `ok`. |
| evidence persistence in `/advance` | `invariant` | Conditional on `result.evidence` presence only. Same single write as the stage, so no window exists where `merged` has no evidence. |
| `verifyMergedItemsViaGit` three-state outcome | `invariant` | Deterministic on git's documented exit status: 1 ⇒ regressed, everything else ⇒ unverifiable. No judgment. |
| reconciler unverifiable branch | `invariant` | Deterministic on set membership. Strictly *removes* an authority — the old code demoted on absence-from-`verified`. |

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Nothing new is rejected. `/advance` accepts exactly what it accepted before — the four
checks and their refusal codes are untouched; only the success return widened. No
artifact field became required.

The reconciler now demotes **strictly fewer** items: previously anything absent from
`verified` became `regressed`; now only git exit 1 does. So the change cannot introduce
a false demotion, only remove them.

Real cost, stated plainly: an item that genuinely regressed but whose check cannot be
run stays at `merged` rather than being demoted. That is a deliberate trade — the old
behaviour "caught" it only by demoting everything it could not verify, which is not
detection. The item keeps taking the `ciCheckedAt` backoff, so it is re-asked, and its
unverifiable reason is returned to the caller rather than swallowed.

## 2. Under-block

**What failure modes does this still miss?**

- **No new regression detection is added.** This makes the existing reconcilers
  *possible* (they now have evidence to select on) and *safe* (they can no longer guess).
  Whether they catch a real revert is unproven until one occurs — recorded rather than
  implied.
- **Items merged BEFORE this change carry no evidence**, so they remain invisible to the
  reconcilers. They surface as `unverifiable` with the reason "no mergeCommitOid
  recorded on the item" rather than silently dropping out of the candidate set. No
  backfill is attempted: reconstructing which PR merged a historical item would mean
  guessing, and a fabricated evidence row is worse than an absent one.
- The `GET /projects/:id` reconciler still selects only `pipelineStage === 'building'`
  children, so an item that went straight to `merged` via `/advance` is not revalidated
  by it. `verifyMergedItemsViaGit` is reachable for any child id the caller passes.
  Widening that selection is a behavioural change to which items get demoted and is NOT
  attempted here.
- `defaultVerifyMergedItems` remains a deliberate no-op stub for the injected
  `verifyMergedItems` seam (returns an empty Set). Its own comment says production
  callers should pass a real verifier; the one production caller does.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The evidence originates in the validator (the only place that proves it), is
carried on the validator's own result type, and is persisted by the route that owns the
write. No new store, no new field on the wire, no new endpoint — `prNumber`,
`mergeCommitOid` and `ciCheckedAt` are pre-existing declared `Initiative` fields, and
`mergeCommitOid`'s own comment already said "recorded at building → merged". The fix
makes the comment true rather than inventing a mechanism.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

It **reduces** brittle authority. The reconciler holds real authority (it demotes items
to `regressed` and clears a round's future `autoAdvanceAt`), and it was exercising that
authority on the brittle ground of "absent from a set that could be empty for any
reason, including a permission refusal". Demotion now requires git's single documented
negative exit status. Nothing in this change blocks, delays, or alters a message or an
action.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point is introduced. Every new branch is a deterministic comparison (a
`status === 1` test, a set-membership test, a presence test on `result.evidence`). The
change *retires* a pseudo-judgment — treating an unanswerable question as a negative
answer — and makes the asymmetry explicit in the type: `unverifiable` is a first-class
outcome carrying its reason, never folded into either verdict.

## 5. Interactions

- **`GET /projects/:id` lazy reconciler** — the one production consumer. Now receives a
  three-state result and a resolved canonical-main ref. An unverifiable candidate takes
  the `ciCheckedAt` backoff and keeps its stage; only `regressed` membership triggers a
  demotion and the round's `autoAdvanceAt` clearing (that downstream logic is unchanged).
- **`verifyMergedItemsViaGit` signature** — return type widened
  (`Set<string>` → `MergedVerificationResult`) and a fourth optional parameter added.
  Grepped all callers: exactly one production callsite (`routes.ts`), updated. The
  injected `verifyMergedItems` seam on `RunRoundInput` is a DIFFERENT type
  (`Set<string>`) and is untouched, so `ProjectRoundExecution`'s own callers and its 8
  unit tests are unaffected — verified by running them.
- **`StageTransitionResult`** — the widened success case is an optional property, so
  every existing `if (!result.ok)` caller and every `expect(r.ok).toBe(true)` assertion
  keeps working. Confirmed: 48 pre-existing validator tests pass unchanged.
- No persistence migration: the three fields already exist in the `Initiative` type,
  the create/update allowlists, and the JSON store.

## 6. External surfaces

`POST /projects/:id/advance`'s 200 body gains `item.prNumber`, `item.mergeCommitOid`,
`item.ciCheckedAt` and an `evidence` object on a merged transition. Additive only — no
field removed, no shape changed, no status code changed. `GET /projects/:id` children
now carry those fields once written. Refusal responses are byte-identical.

## 6b. Operator-surface quality

The operator previously read `merged` with no way to ask "merged by what?" — and got a
silent all-clear from a regression detector that had never examined anything. They now
see the PR, the merge commit and the check time on the record itself, and an
unverifiable item names its reason instead of being demoted. Items merged before this
change honestly report "no mergeCommitOid recorded" rather than appearing clean.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: `unified` by construction — no new state.** No new field, file, store, or
surface is introduced; three already-declared fields on an existing per-machine store
start being written. The evidence is a pure function of a PR's GitHub state plus the
target repo's git history, both of which are machine-independent facts. The
canonical-main ref is resolved per-machine from that machine's remotes, which is
correct: it names the same upstream commit graph whatever the local remote is called —
and resolving it (rather than assuming `origin/main`) is precisely what makes the check
give the same answer on a fork-origin home as on a canonical one. No replication path
is required and no `machine-local-justification` marker is needed.

## 8. Rollback cost

Three source files, one commit, no migration and no persisted-state change. Reverting
restores a `merged` record that cannot name its evidence and two reconcilers that
select nothing — and re-arms the "could not check ⇒ regressed" mistranslation the
moment anything writes `mergeCommitOid`. Written-but-unread evidence fields are inert,
so a revert leaves no corrupt data behind.

## Phase 5 — Second-pass review (independent reviewer subagent)

**Disclosure, per Truthful Provenance:** no independent reviewer subagent was spawned —
a standing instruction in this session prohibits it unless the operator requests it.
The review lenses were applied by the author. That is **reduced independence**, recorded
as such rather than presented as a concurring second pass.

What author-applied review caught and changed:

1. **The first instinct was to persist the evidence and stop** — a two-line change that
   would have armed a code path carrying three unexercised defects, turning silent
   blindness into confident false regressions. The consumer had to be read before the
   producer was fixed. This is the same "fix one site, leave its twin" mistake flagged
   on #1647 and again on #1650 earlier the same night; third occurrence, caught before
   shipping this time.
2. **The hardcoded `origin/main` would have mis-fired specifically on this machine.**
   The advance path had already resolved it via `resolveCanonicalMainRef` for exactly
   this reason. Passing the resolved ref through was not optional — without it a
   dev-agent home demotes every healthy item.
3. **The unverifiable branch initially bumped nothing**, which would have re-asked an
   unanswerable question on every read (a hot loop). It now takes the `ciCheckedAt`
   backoff while explicitly leaving `pipelineStage` alone.
4. **Consumers were grepped, not assumed** — establishing that the widened return type
   has exactly one production caller and that the similarly-named injected
   `verifyMergedItems` seam is a distinct type that must NOT change.
5. **One new test passed for the wrong reason and was fixed:** a fixed-size text window
   ran past the branch it meant to inspect and matched the next block's
   `pipelineStage`. Now bounded at the branch's own `continue`. A test measuring
   adjacent text is the same defect class as the subject of this change.

## Phase 6 — What CI refused, and why the fix went in the prose

The first push was refused by the empty-catch ratchet
(`tests/unit/no-empty-catch-blocks.test.ts`): count 1 against a baseline of 0. The
offending occurrence was at `ProjectRoundExecution.ts:506` — **inside this change's own
doc comment**, on the line quoting the forbidden bodyless-catch shape while explaining
that it had been removed. The lint scans `src/` as text and does not strip comments, so
it cannot distinguish an example from an instance.

Noted rather than glossed, because it is the same failure mode this change is about,
one layer out: a checker built to catch "errors turning into nothing" was tripped by a
sentence *about* errors turning into nothing. It is also the third occurrence of that
shape in a single session (twice in the outbound-message checker, once here), and the
sibling test `tests/unit/projects-advance-mergebase-wiring.test.ts` already documents
the identical trap for its own assertions — it strips comments before asserting,
precisely because an earlier version of it matched the helper's own explanatory prose.

**The prose was reworded; the lint was NOT touched.** Weakening a safety check to
unblock one's own change is the wrong instinct even when the check is imprecise, and
this lint's stated history (a bare catch in a 5-second loop causing a real cost
incident) earns it the benefit of the doubt. Making the lint comment-aware is a
legitimate improvement, but it belongs in its own change with its own review — not
smuggled in as a side-effect of needing this PR to go green.

**Re-verification scope, corrected.** The refusal proved my local scope was wrong: I
had run the tests covering the changed module, but this failure came from a test that
scans the whole source tree and whose subject my change never touched. The right scope
for a source change is therefore *every tree-scanning test*, located by grep rather
than guessed: 99 files, 8,370 tests, exit 0, `tsc --noEmit` clean.
