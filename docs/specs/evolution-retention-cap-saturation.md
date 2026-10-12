---
title: "The evolution-store retention cap is inert at saturation, and it was never a cap on the thing that grows"
slug: "evolution-retention-cap-saturation"
author: "Echo"
eli16-overview: "docs/specs/evolution-retention-cap-saturation.eli16.md"
origin: "EVO-022 (proposed 2026-08-30 from LRN-030), re-measured and widened 2026-08-30 by the evolution-proposal-implement job. The proposal named two prune sites; the live source carries the identical expression at four."
lessons-engaged:
  - "P20 Verify the State, Not Its Symbol — `maxActions` is the SYMBOL of a bounded queue; the measured state is 352 records against a max of 300. The symbol was read for months; the state was not."
  - "Read the denominator (EVO-023) — a retention surface that reports only a count cannot distinguish 'we kept too few' from 'nothing was ever eligible to prune'. Both print the same number."
  - "Expected Capacity Enforcement — a store that is read and rewritten whole on every write has a hard bound or it does not; 299,887 bytes per action save is the cost of not having one."
  - "Close the Loop — the pending-side policy (§4) is the half that actually bounds growth; shipping §3 alone is the trap this spec exists to name."
review-convergence: "pending"
approved: false
status: "draft — 2026-09-12 design correction; preservation and replication review unresolved"
---

# Evolution-store retention: a cap that cannot bind

## Current design correction — 2026-09-12

**This section supersedes conflicting assumptions in the original design below. This spec is
not converged or approved for implementation.** Fresh upstream main
`df491e6b8130e10014064c2733171cc1df7f2a35` (1.3.1237) still carries all four slice defects.
The current action queue has 300 records: 15 pending, 6 in progress, 5 completed and 274
cancelled (293,940 bytes). The historical 350-active example is a useful regression fixture,
not today's measured state.

The constitution inspection checked 91 standards and flagged **Archiving May Never Mean
Deleting**. Applied learnings remain memory: an applied flag is not permission to erase them.
Before activating the slice correction, preserve full content in a durable, accessible archive
and distinguish removal from an operational view from destruction of memory. A backup promise
or an emitted tombstone does not prove preservation. The current draft does not yet specify
that protocol and therefore cannot authorize the destructive correction in section 3.

The proposed pending-work policy is now concrete: **preserve active work and describe the
soft total retention target honestly**. Use `retentionTargets: {proposals, learnings, gaps,
actions}`, accepting the four existing `max*` settings as deprecated aliases. Explicit new
values take precedence, then existing values, then the current defaults. Validate finite
nonnegative integers; preserve zero via nullish defaulting; invalid input never authorizes
additional removal. Migration adds only missing values. This choice is proposed for review,
not a claim of operator approval.

`maxTerminalRetained`, suggested in the original proposal, would misdescribe the algorithm:
a target of 300 with 200 active entries allows 100 terminal entries. The target is shared
between active and terminal records, and active work can exceed it. This policy neither
provides a hard capacity bound nor bounds the whole-file rewrite cost.

Current upstream already implements opt-in, dry-run-first `runActionAutoExpirySweep()`.
The old assertion that nothing removes pending actions is false. Retention must not enable
that facility or change its critical/pinned/future-due protections.

Statistics must describe the population actually retained. All four save methods currently
compute their stats before pruning. Recompute from post-retention records, preserve existing
fields and add `total`, `active`, `terminalRetained`, `target`, `terminalAllowance` and
`overflow`. Read-side reports must handle stale cached stats in older files. An unreadable
store is unknown, never a healthy empty store. A read-only overflow signal is not evidence
that the proposal's requested alarm was delivered; that delivery remains a design requirement.

Initial independent review found two more foundation risks. Record allocators choose the
first unused local number, so removing an old record can let a stale reference target new
work. Also, local persistence precedes best-effort tombstone emission; an emission failure
has no proven durable retry. Increased pruning requires a compatible identity/reference
contract and crash-safe replication behavior before rollout. The original unconditional
claim that existing tombstones make this correction safe is withdrawn.

Review evidence: `.instar/reports/evolution-implementation-20260912/`, including the
constitution response and independent findings. These are initial design reviews, not a
completed convergence process. No source patch is authorized by this correction.

## Decision points touched

| Decision | Classification | Justification / conservative floor |
|---|---|---|
| Preserve active work during retention | invariant | A size target grants no authority to abandon a commitment. |
| Compute terminal allowance | invariant | Deterministic arithmetic over a valid target and inspected population. |
| Resolve aliases and validate settings | invariant | New value, old value, default; invalid data cannot license removal. |
| Preserve content and propagate view eviction | judgment-candidate | Preserve content/references on error; protocol and arbiter require further design. |
| Escalate overflow | judgment-candidate | A signal grants no cleanup or messaging authority; ownership and escalation floor require further design. |

## Frontloaded Decisions

1. Preserve active records and use an honestly named soft total target.
2. Preserve legacy settings through explicit precedence and idempotent migration.
3. Do not enable or modify the independent pending-action auto-expiry facility.
4. Report post-retention counts; keep unavailable measurements explicit.
5. Preserve memory content before evicting operational records; local write success is not replication success.

These are proposed decisions for eventual review, not an approval claim.

## Multi-machine posture

Default to unified state. Actions and learnings already have distinct replication seams;
local `ACT-NNN` and `LRN-NNN` labels are not their cross-machine identities. Archive content
must remain accessible when work transfers between machines. A declaration of locality or
a read proxy is not a substitute for a valid memory replication contract. Operational
diagnostics may report per-machine observations with explicit coverage, without claiming
those counts describe an unmeasured unified population.

## Open questions

1. Define durable archive/readback, crash recovery, backup/restore and cross-machine availability
   before applied learnings or other memory-bearing records leave the live store.
2. Define durable removal emission and retry behavior using the real replicated-store consumer;
   do not rely on a successful mock emitter or treat a peer's view eviction as erasure authority.
3. Define nonreusable identities or compatible reference validation across allocation, TaskFlow,
   PATCH routes and materialization so a stale reference cannot act on new work.
4. Define the overflow alarm's owner, legitimate self-heal actions, deduplication, bounded
   retries and escalation through existing authorities. Do not invent a destructive cleanup.
5. Complete unified read contracts for proposals, gaps and archive content, including unavailable peers.

These are agent-owned design tasks. This draft is not a request for operator sign-off.

## Original design (historical; subject to the correction above)

## 1. The claim, and the measurement behind it

`EvolutionManager` keeps four durable queues, each with a configured maximum and a prune step that
runs on every save. **None of the four maxima bounds the population that actually grows, and the
prune expression additionally inverts at exactly the threshold it exists to defend.**

Measured live 2026-08-30 against this agent's stores:

| store | file | total | active (prune-exempt) | max | bytes |
|---|---|---|---|---|---|
| actions | `.instar/state/evolution/action-queue.json` | 352 | 350 pending | 300 | 299,887 |
| proposals | `.instar/state/evolution/evolution-queue.json` | 24 | 21 not implemented/rejected | 200 | 148,646 |
| learnings | `.instar/state/evolution/learning-registry.json` | 33 | 0 unapplied | 500 | 63,731 |
| gaps | `.instar/state/evolution/capability-gaps.json` | absent | — | 200 | — |

Only the action queue has crossed its cap. The other three are latent: they carry the same defect
and have not yet reached the threshold that expresses it.

## 2. Two defects. The second one decides the shape of the fix.

### 2.1 The slice inverts at saturation

All four prune sites are the same expression:

```
src/core/EvolutionManager.ts:878   proposals  max 200  active = !implemented && !rejected
src/core/EvolutionManager.ts:1040  learnings  max 500  active = !applied
src/core/EvolutionManager.ts:1170  gaps       max 200  active = status === 'identified'
src/core/EvolutionManager.ts:1308  actions    max 300  active = !completed && !cancelled
```

each written as:

```ts
const keep = terminal.slice(-Math.max(0, max - active.length));
```

`Math.max(0, …)` reads as "never ask for a negative count". It is correct arithmetic feeding an
operator that cannot express its result. Once `active.length >= max` the inner expression is `0`,
and **`arr.slice(-0)` is `arr.slice(0)` — a copy of the whole array, not an empty one.** Verified
live:

```
node -e "console.log(['a','b','c'].slice(-Math.max(0,300-350)).length)"   →  3
```

So the guard reads "keep zero terminal records" and does the opposite, at exactly and only the
condition the clamp was written for. Below the cap the expression is correct, which is why the
site survived every test and every reading: the failing case is the one nobody exercised.

### 2.2 The cap's eligible set excludes the population that grows

At all four sites the prune may only remove **terminal** records. Open work is exempt by
construction. With 350 pending actions against a max of 300, a *correct* slice computes
`keep = []`, removes the 2 terminal records, and leaves **350** — still above the cap, and
permanently so, because nothing in the system removes a pending action.

`maxActions` is therefore not a cap on the queue. It is a cap on terminal residue, wearing the
name of a queue cap. **Fixing §2.1 alone recovers 2 records out of 352, changes nothing about the
growth, and makes the code look correct while the bound stays unenforceable.** That is the trap
this spec exists to name.

### 2.3 Why it was invisible

The store looks exactly like the predicted end-state of *aggressive* eviction: 350 open records
and 2 survivors. Two opposite mechanisms — over-pruning and no pruning — produce the same file.
Nothing in the retention surface reports the eligible-set size, so the count alone cannot tell
them apart. This is EVO-023's rule applied to retention: read the denominator.

## 3. Fix part one — make the slice express "none"

Replace the negative-index slice at all four sites with an explicit non-negative count:

```ts
const budget = max - active.length;
const keep = budget > 0 ? terminal.slice(-budget) : [];
```

**Test requirement (the load-bearing one).** Existing coverage exercises `active.length < max`,
which already works. The new tests must cover the two cases that are wrong today:

- `active.length === max` → `keep` is empty
- `active.length > max` → `keep` is empty, and the resulting store is `active` exactly

per store, at all four sites — this is a defect *class*, and a fix that patches only the two sites
EVO-022 originally named leaves two more that fail identically on the same threshold.

**Replication interaction (must not regress).** The actions and learnings sites emit `op:delete`
tombstones for records that leave the queue (`EvolutionManager.ts:1322-1341`; the resurrection
guard added for WS2.5/WS2.2). Today the inverted slice removes nothing at saturation, so no
tombstone is emitted. The corrected slice *will* remove the terminal records on the next save,
and the existing removal path emits their tombstones correctly — this is the intended behavior,
not a new one, but it is the first time that path fires at saturation and it belongs in the
side-effects review.

## 4. Fix part two — bound the thing that grows, or stop calling it a cap

Exactly one of these, chosen deliberately and stated in the config surface:

- **(a) Rename to what it bounds.** `maxActions` → `maxTerminalRetained` (with migration parity
  for the existing key), and add a distinct signal when `records.length > max` with an empty
  eligible set. An unenforceable cap must not read as an enforced one.
- **(b) Give open work a real bound.** An age-out, an archive-to-cold-file, or a per-status
  sub-cap. This is the only option that actually stops the file growing, and it is the one that
  needs the most care: pending evolution actions are the agent's own open loops, and silently
  deleting them is the failure EVO-018 was raised about.

**This spec does not choose.** The choice is a policy decision with a user-visible consequence
(what happens to open work the agent committed to) and belongs to the convergence review and the
operator, not to the author. What the spec does require is that **one of them ships in the same
change as §3** — see §6.

## 5. Fix part three — the retention surface must report the denominator

Whatever §4 chooses, the retention report must carry three numbers, not one:

```
total, active (prune-ineligible), terminalRetained (prune-eligible)
```

A surface reporting only `total` against `max` cannot distinguish "we kept too few" from "nothing
was ever eligible", which is precisely why this defect ran for months in plain sight.

## 6. Non-deferral

§3, §4 and §5 ship together. §3 alone is a *worsening*: it converts a visibly-broken cap into an
invisibly-inert one, because the code then reads correct while the store keeps growing. If
convergence concludes §4(b) is too large for one change, the resolution is §4(a) — the honest
rename plus the alarm — not a deferral.

## 7. Independent, cheap, and not addressed by this change

The 299,887-byte whole-file read-and-rewrite on every action save is a real and linearly growing
cost, but it is a *consequence* of §2.2, not a separate defect: bound the population and the cost
bounds itself. No incremental-write work is proposed here.

**Cross-reference, not a deferral: EVO-018's premise no longer holds.** It is `in_progress` on
the claim that "the retention policy protects open work and prunes closed work, so it deletes
exactly the record you need". The prune has been inert since saturation, so that premise did not
hold while EVO-018 was written. Re-measuring it is EVO-018's own precondition, tracked on that
proposal; this spec neither depends on it nor postpones it.

## 8. The rule worth carrying past this file

Two, and they are separable:

1. **A clamp of the form `Math.max(0, budget - used)` feeding a negative-index slice fails exactly
   at saturation** — the one condition the clamp exists for — because negative-index slicing reads
   `0` as "from the start", never as "none". Any `slice(-n)` where `n` can reach zero is this bug.
2. **A cap whose eligible set excludes the growing population is not a cap.** Before trusting a
   bound, check what it is allowed to remove against what is actually accumulating.
