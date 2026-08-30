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
status: "draft — awaiting /spec-converge, then operator approval"
---

# Evolution-store retention: a cap that cannot bind

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
