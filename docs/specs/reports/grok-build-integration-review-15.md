# Convergence round 20 — re-measurement

**5 refutations, 11 confirmations.** The first round whose METHOD was chosen from
the evidence rather than from the process.

## Why the shape changed

Rounds 14-19 each concentrated their defects inside the previous round's fixes,
and three times a fix was reasoned from a correct measurement and then never
re-measured against itself. Another broad sweep would have been the fifth
consecutive application of a method the data said was mis-aimed.

So each reviewer got ONE job: take a claim, construct the state it denies, check.
Two constraints carried as much weight as the targets:

- **Every claim needs a control that produces a DIFFERENT result.** A probe that
  cannot distinguish working from broken is the thing that created this pattern.
- **A hard budget on live grok calls (4), with explicit permission to report
  "unverifiable within budget"** rather than guess — the billing sink is unknown.

Confirming a claim was declared a valid result in advance, so a quiet lane would
be evidence rather than an absence of effort.

## Refutations

1. **`lock-unavailable` was produced and never consumed.** The round-19 fix made
   `reserveGrokBudgetSlot` genuinely refuse and write no reservation — verified.
   But `review()` branched on `corrupt` and `exhausted` only, so the verdict fell
   through to the spawn with `reservationId = null`. Measured: with a foreign
   lock held, the review spawned and spent while holding no reservation, so
   concurrent admissions could not see it. Round 18 failed because a fact could
   not cross a function boundary; round 19 carried it across and dropped it one
   boundary later. **A verdict nothing consumes is not a refusal.**
2. **A sixth spawn site** (`PipeSessionSpawner`) kept the metered key, invisible
   to the round-19 membership test on two independent grounds: template-string
   spawn rather than argv array, and shell `unset` rather than tmux `-e`. That
   test's comment names the failure class it was built to fix.
3. **The same spawner discarded `launchSpec.envOverrides`** — the composed
   billing invariant — referencing it zero times.
4. **The carrier ledger was UNTRACKED**, so in a fresh checkout the existence
   check skipped silently and the fabricated-marker bypass passed clean, while
   the header claimed the ledger was "checked in".
5. **The CI scoping inverted**: at default checkout depth a pull_request has no
   merge base, so the gate fails every PR unconditionally. A vacuous pass traded
   for an unconditional red. Separately, the ratchet and symmetry checks — both
   mine, same round — disagreed about a shared set.

## Confirmations (each with a control proved able to fail)

`--deny` binds (canary unreadable with real rules, leaked verbatim with bogus
ones, `num_turns` corroborating a client-side tool round-trip); the lane still
returns text under the shipped argv; `--deny` VALUES are unvalidated and fail
open SILENTLY; grok runs model-native server-side X search under full production
argv with zero client tool dispatch (nonsense-query control returning
ZERO_RESULTS proves a real search); the structural `finally` closes the leak
class per-return handling could not (24 systematic throws leave the ceiling
open, control settles correctly); pre-spawn auth refusals consume no slots while
a genuine post-spawn failure does; settle-by-id spares a foreign reservation;
double-count could not be produced across four outcome classes and 8 concurrent
reviews; table↔marker symmetry in all three states; the ratchet tolerates
pre-existing markers; the membership scrub catches the duplicate-scrub case a
count-based check would pass; both directions of the identity fix; the
classification controls.

## Two method notes worth carrying

- **A reviewer nearly filed a false defect** because another hand was writing to
  this worktree mid-session: three independent readers caught the same file
  mid-write and AGREED on the wrong content. Only a checksum-stable snapshot
  settled it. Concurrent edits defeat agreement between tools.
- **A test file can over-credit its own coverage.** The classification tests
  verify the type-first behaviour, but the *narrowness* decision the file
  documents at length is pinned by a pre-existing sibling test, not by itself. My
  comment saying "an existing test pins this" is accurate; a reader of that file
  alone would over-credit it.

## Round verdict

Asking *does this claim survive re-measurement* found in one pass what four broad
sweeps missed — not because the reviewers were better, but because "what else
might be wrong?" and "is what I already said true?" are different questions, and
only the second catches a fix that stopped one boundary short.
