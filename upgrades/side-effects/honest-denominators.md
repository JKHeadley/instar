# Side-Effects Review — honest denominators: a gate that discards its verdict, and a ratio that reports 1 over nothing

## Summary of the change

Two related honesty defects, both found by the convergence-towards-coherence audit (2026-07-25).

**A. `.husky/pre-commit` discarded its own blocking verdict.** The hook was a plain command
sequence with no `set -e`, so its exit status was the LAST command's.
`scripts/instar-dev-precommit.js` exits 1 and prints a full "commit BLOCKED" banner; three checks
then run after it, each exiting 0, so git saw 0 and accepted the commit. Verified by landing a
commit through a printed block (`b2efded2f`, reverted). Every blocking check in the hook except
the final one was advisory. Fix: `set -e`, with the reasoning recorded inline.

**B. `freshRatio` reported a perfect `1` when there was nothing to divide by.** Explicit in code
(`ratioDenom === 0 ? 1`), not an oversight. The CI ratchet compares `freshRatio < FLOOR`, so 1
passed every possible floor — the guard was structurally unable to fail on an empty map, the exact
case it exists to catch. Fix: all five producers return `null` with no denominator; the ratchet
distinguishes *no authored state* (legitimate CI case → still exit 0, but prints
`NOT ASSESSED — this check gated on nothing`) from *an authored index with zero nodes*
(→ hard failure).

## Decision-point inventory

- `.husky/pre-commit` — a commit-time authority. Change makes its existing verdict effective; it
  adds no new verdict of its own.
- `scripts/cartographer-freshness.mjs --check` — a CI-time authority. Change adds one failure
  condition (authored index with zero nodes) and one explicit non-assessment notice.
- The five `freshRatio` producers are pure reporters; no decision logic changed.

## 1. Over-block

**A.** `set -e` means the FIRST failing check aborts, so later checks do not run and a developer
sees one problem at a time rather than all of them. Accepted: that is standard hook behaviour and
strictly better than the previous state (no check could block at all). Every command in the
sequence is intended to block; the only conditional (`if node -e … fi`) is a shell condition,
which `set -e` deliberately does not trip on.

**B.** The narrow risk was failing a legitimately-not-yet-assessable index. Caught during build:
my first version failed a freshly-scaffolded tree whose nodes are all within grace, breaking two
pre-existing tests. Narrowed to `nodeCount === 0`. A scaffold within grace is a pass, and the
existing `neverAuthoredPastGrace` ceiling still guards the backlog case.

## 2. Under-block

**A.** `--no-verify` still bypasses everything — unchanged and out of scope; the skill already
names bypass as an anti-pattern. Server-side CI remains the backstop.

**B.** A *populated but stale* map is still governed only by the configured floor, which ships at
`0` by default and therefore still gates weakly. This change does not raise that floor — doing so
is a separate judgement about desired strictness, and bundling it would hide which change caused
which effect. Named here rather than silently left.

## 3. Level-of-abstraction fit

Both fixes are at the layer that already owns the decision. **A** repairs how an existing verdict
is propagated — it does not move authority. **B** repairs what a reporter reports and how its
existing consumer reads "no evidence". Neither adds a parallel checker beside a smarter one.

## 4. Signal vs authority compliance

Compliant, and the change moves *toward* the principle.

- **A** adds no new authority. The authority (`instar-dev-precommit.js`) already existed and
  already computed the right answer; the defect was that its signal was discarded. Making an
  existing verdict effective is the opposite of granting brittle logic new blocking power.
- **B** the producers remain pure signals (`number | null`). The one authority (the CI ratchet)
  gains a failure condition that is *deterministic and evidence-based* — it fires only on the
  objective state "an index exists and contains zero nodes". Crucially it fails toward "cannot
  assess", never toward a fabricated pass, which is the direction the principle asks for.

## 4b. Judgment-point check

No LLM judgement involved. Both are deterministic checks over objective state (exit codes; node
counts). No string-matching heuristic gains authority.

## 5. Interactions

- **A** interacts with every check in the hook: `npm run lint`,
  `lint-migration-consumer-completeness`, `instar-dev-precommit`, `check-rule3-coverage`,
  `protect-migration-guarantee`, `check-e2e-pairing`. All six become genuinely blocking. Verified
  each currently exits 0 on a clean tree with real dependencies installed, so this does not turn a
  currently-green repo red. **This was checked only after a false alarm**: I first measured a lint
  failure and reported that the fix would block every developer — that failure was an artifact of
  my own worktree pointing at an 85-commit-stale `node_modules` that predated the `undici`
  dependency. With a real `npm ci`, lint exits 0. The false alarm is recorded because the
  generalisation-from-local-artifact is the more instructive error.
- **B** does not shadow the `neverAuthoredPastGrace` or `authorFailed` ceilings; they are
  evaluated independently and unchanged.

## 6. External surfaces

`GET /cartographer/health` now returns `freshness.freshRatio: null` instead of `1` in the
no-data case. Any external consumer doing arithmetic on it must handle null. Type-checked across
the tree: zero errors, because the only pipeline consumer is the `.mjs` ratchet, which is updated
here. The dashboard renders the freshness block; `null` displays as absent rather than as a
fabricated 100%, which is the intended user-visible effect.

## 6b. Operator-surface quality

The ratchet's new no-assessment line is plain English and states the consequence:
`NOT ASSESSED — no authored cartographer state; this check gated on nothing.` The failure line
says what could not be done and explicitly that it is not a pass, rather than emitting a bare
code. No file paths or config syntax are surfaced to a user; both lines are developer/CI-facing.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design, both.** `.husky/pre-commit` is a per-checkout git hook — there is no
cross-machine surface and no replication path is meaningful. The cartographer index is per-machine
state and its freshness is a property of that machine's checkout; `GET /cartographer/health` is
already a machine-local read. No durable state strands on topic transfer, no generated URL crosses
a machine boundary, and no user-facing notice is emitted that would need one-voice gating.

## 8. Rollback cost

Cheap and total, for both. **A**: delete one line (`set -e`) — restores the previous behaviour
exactly. **B**: revert the commit; the producers return to `1` and the ratchet to its prior
comparison. No data migration, no agent state repair, no released artifact depends on the shape.
The `null` value is additive to a type, not a schema change with stored records behind it.

## Conclusion

Both changes make an existing mechanism do what it already claimed to do. Neither adds authority;
one restores authority that was being silently discarded, the other stops a reporter from
manufacturing a passing grade out of an absence of evidence.

The honest note for reviewers: I got the second one wrong twice during the build (over-broad
failure condition caught by pre-existing tests; a false blast-radius claim caught by checking my
own environment), and one existing E2E assertion had to be corrected because it was protecting
the old behaviour. That history is in the commit message and the test comments so it cannot be
quietly reverted.

**Second-pass review: not required.** Per the skill's Phase 5 list, this touches no runtime
agent-behaviour gate — no outbound/inbound message block/allow, no session lifecycle, no
compaction/respawn, no coherence gate or trust level. It touches a git hook and a CI script, both
build-time. The PR is the review surface, per Tier 1.
