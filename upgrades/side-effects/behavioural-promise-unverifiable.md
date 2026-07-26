# Side-Effects Review — a promise was "kept" if a text field was filled in

**Version / slug:** `behavioural-promise-unverifiable`
**Date:** `2026-07-26`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `author-applied lenses — see Phase 5 (reduced independence, disclosed)`

## Summary of the change

`CommitmentTracker.verifyBehavioral` decided whether a behavioural promise had been
kept by checking `content.includes(commitment.id)` against the behavioural rules file.
That file is written **by this same class** from its own active list, and — verified
across the whole agent home — **nothing else reads it**. So the check verified that the
system had successfully written its own file, and its outcome was decided entirely by
whether the optional `behavioralRule` field was populated.

Measured on the live store: **74 behavioural commitments WITH the field all read
`verified`; 24 WITHOUT it all read `violated`. 98 of 98, no exceptions in either
direction.** Not one status observed conduct. `verified` was false comfort; `violated`
was a false alarm (a missing optional field is not a broken promise). Both accumulated a
counter tick on every sweep — CMT-068 reached **162,344**, and four commitments created
in the same minute held **identical** counts (80,425), which individual behaviour cannot
produce.

Behavioural commitments now take the same path this file already gives an unverifiable
`one-time-action`: the sweep is a **no-op**, the promise stays `pending`, and closure
stays explicit (`deliver()` / `markDelivered()` / `expiresAt`). The rules file still
self-heals, but repairing bookkeeping is no longer mistaken for evidence.

## Decision-point inventory

| point | classification | note |
|---|---|---|
| behavioural early-return in `verifyOne` | `invariant` | Deterministic on `type`. Mirrors the adjacent unverifiable-one-time-action return, which carries the same reasoning and history. |
| `ensureBehavioralRulesFile` | `invariant` | Pure repair, returns nothing. It cannot influence a status — that conflation *was* the defect. |
| `getHealth` message | `invariant` | Counts actual `verified` rows instead of inferring verification from the absence of violations. |

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Nothing is blocked; this is a status computation with no gating authority. The nearest
analogue is **withholding a `verified` status from a promise genuinely being honoured** —
and that is the point: nothing here can observe conduct, so the status was never earned.
74 rows move from `verified` to `pending`, which is a loss of *false* reassurance only.

Real cost, stated plainly: an operator who read `verified` as "Echo is complying" loses
that signal. It was never true, so the honest replacement is silence rather than a
number — but the change does remove something people may have been relying on.

## 2. Under-block

**What failure modes does this still miss?**

- **Behavioural compliance is still unverified.** This change makes that visible; it does
  not solve it. Genuine verification would need an observation of conduct (e.g. grading
  outbound turns against the rule), which is a much larger piece of work and is NOT
  attempted here. Recorded rather than silently implied.
- `config-change` verification is untouched and still genuinely checks live state.
- The rules file remains written-and-read-by-nobody. Removing it entirely is a separate
  question (its `getBehavioralContext` sibling *is* served over HTTP, so the content has
  a consumer even though the file does not).
- `writeBehavioralRules`' comment still claims "remove the file so hooks skip injection",
  describing a consumer that does not exist. Left in place rather than edited blind;
  noted as a candidate.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes, and deliberately at the *same* layer as the existing precedent: an early return in
`verifyOne`, ten lines below the one that handles unverifiable one-time-actions, sharing
its rationale. No new status was introduced — `pending` already means "not determined",
and adding an `unverifiable` state would have required touching the status union, three
terminal-status guards, `getActive`, and auto-expiry eligibility for no semantic gain.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

No. It *removes* an authority that was exercised on brittle grounds: the old path
asserted a verdict on the operator's promises from a filesystem read. Nothing here
blocks, delays or alters any message or action. `getHealth` no longer reports `degraded`
from 24 false violations, which strictly reduces false authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point is introduced; the new branch is a `type` comparison. The change
*retires* a pseudo-judgment (file presence standing in for conduct). The asymmetry is
explicit in code: absence of a verdict is reported as absence, never as either outcome.

## 5. Interactions

- **`getHealth`** was the one consumer that read `violated`: 24 false violations made the
  component permanently `degraded`. Now it reports counts it can defend. Verified by grep
  that no code outside this class reads `status === 'violated'`.
- **`isAutoExpiryEligible`** treats `pending` and `violated` identically, so moving rows
  between them causes no change in expiry behaviour — checked before editing.
- **PromiseBeacon / overdue surfacing** operate on open commitments; `pending` keeps them
  visible, which is the stated intent of the precedent ("should NAG, not vanish").
- No persistence change, no migration, no config key.
- ~~Existing rows re-evaluate to `pending` on the next sweep without a data rewrite.~~
  **CORRECTED 2026-07-26 — this was FALSE and is struck rather than deleted.** The
  behavioural branch returns BEFORE the `switch` in `verifyOne`, so `mutateSync` never runs
  and a pre-existing row is never touched. **The change is FORWARD-ONLY.**
  Verified on the live store after deploy: 98 behavioural rows still read **74 `verified` /
  24 `violated`**, unchanged. What the change DID do, measured over two reads 75s apart:
  tick accumulation stopped dead (one row frozen at 163,135 where it had been climbing every
  minute). What it did NOT do: clear the 98 stale verdicts — so the false comfort this change
  set out to remove is still displayed for every row that predates it, and `getHealth`, which
  now counts actual `verified` rows, will report those 74 stale stamps as verified.
  Remedy is an open operator decision, not a reflex: either a migration resetting behavioural
  rows to `pending` (a data rewrite this very section claimed was unnecessary) or a read
  surface that refuses a verdict for a never-verifiable row whatever is stored.
  **Found by reading the live surface for the exact case the change fixed** — no test caught
  it, and the suite was green. An artifact that over-claims is the same defect class as the
  bug it documents, which is why the wrong sentence stays visible above.

## 6. External surfaces

`GET /commitments` and `GET /commitments/:id` will show behavioural promises as `pending`
rather than `verified`/`violated`, with both counters at 0. `GET /health` reports the
commitment component's message differently. No route shape changes; no field is removed.

## 6b. Operator-surface quality

The operator previously saw either a reassuring `verified` that meant nothing, or a
`violated` (with a five-figure count) that meant nothing — and, because 24 rows were
falsely violated, a permanently `degraded` health component. They now see `pending` with
honest zeroes, and a health line naming how many promises are simply not automatically
checkable. `pending` is deliberately not alarming: nothing is wrong, nothing is known.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: `unified` by construction — no new state.** This changes how an existing
per-machine store's rows are evaluated; it introduces no new field, file, or surface.
Each machine already keeps its own commitment store (existing posture, unchanged by this
work), and the evaluation is a pure function of a row plus that machine's rules file. No
replication path is required and no `machine-local-justification` marker is needed,
because no new machine-local state is introduced.

## 8. Rollback cost

One commit touching one source file and its test file. No migration, no persisted state,
no config. Reverting restores the old semantics — and with them 98-of-98 statuses decided
by a text field, plus the tick accumulation documented above.

## Phase 5 — Second-pass review (independent reviewer subagent)

**Disclosure, per Truthful Provenance:** no independent reviewer subagent was spawned — a
standing instruction in this session prohibits it unless the operator requests it. The
review lenses were applied by the author. That is **reduced independence**, recorded as
such rather than presented as a concurring second pass.

What author-applied review caught and changed:

1. **The first instinct was to fix only the missing-field half** (stop marking a promise
   violated for an absent optional field). That would have left the *false-comfort* half —
   74 rows still reading `verified` — which is the more dangerous direction, and would have
   repeated the "fix one site, leave its twin" mistake flagged on PR #1647 earlier tonight.
   Both halves are addressed.
2. **`getHealth`'s success message had to change too.** With behavioural rows at `pending`,
   "all verified" would have become a *new* false claim introduced by this very fix — the
   defect migrating one line sideways.
3. **The rules-file self-heal was nearly lost.** The old method regenerated the file when
   missing; deleting the method wholesale would have dropped that. Preserved as
   `ensureBehavioralRulesFile`, which deliberately returns nothing.
4. **Consumers were checked, not assumed** — establishing that `getHealth` was the only
   reader of `violated` and that auto-expiry treats `pending`/`violated` alike.
