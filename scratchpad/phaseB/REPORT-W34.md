# Phase B Lane W3.4 — Enforcement Measurement

> **Append-only chronology:** This report preserves the evidence known at each step. Read entries from top to bottom: the newest entry is last and supersedes earlier status statements for the same claim.

## 2026-08-18 01:15:39 -0700 (PDT) — Brief read, design pinned, first failing controls proven

### Ground

```text
model=GPT-5 Codex
tree=/Users/justin/Documents/Projects/instar-codey/.worktrees/phaseb-w34-enforcement-measurement
branch=phaseb/w34-enforcement-measurement
base=upstream/main
commit=4318a1e150e9a8304e6c2e7ad381bf66d03998e5
dependencies=npm ci exit 0
```

### C3a restatement before build

Deleting an unenforced rule must fail the measurement by surfacing a protected-population removal, and the headline score must not improve.

### Design decision

The closed article census and maximum reference strength come from a content-addressed merge base with canonical server-advertised protected main. Candidate bytes can preserve or lower an already-protected reference strength, never raise it. A candidate-only reference is unverified. Empty, unreadable, or structurally hollow candidate evidence drops to unverified. Certified EFFECTIVE/WIRED/EXISTS records, when present on the protected side, supersede the structural ladder. An absent/empty protected population is a measurement error, never `1` or `100%`.

### First failing controls — production entry, tests executed

```text
$ npx vitest run tests/unit/standards-coverage-ratchet.test.ts --reporter=verbose
exit=1
Test Files  1 failed (1)
Tests       3 failed | 35 passed (38)

C3a deciding output:
AssertionError: expected 1 to be less than or equal to 0.5
  expected after.enforcedRatio <= before.enforcedRatio
  received after=1, before=0.5

C3b deciding output:
AssertionError: expected 1 to be +0
  protected ratchet path remained credited after candidate file was emptied

C3c deciding output:
AssertionError: expected 2 to be 1
  new hollow test reference increased ratchet count from 1 to 2
```

These are behavioral assertion failures after all 38 tests executed, not compile failures.

## 2026-08-18 01:50:21 -0700 (PDT) — BUILT with hand evidence; independent certification pending

### C1 — pristine live baseline

```text
$ node scripts/standards-coverage.mjs --check
exit=0
[standards-coverage] registry=true total=88 continuity-total=88 enforced-ratio=0.6591 (ratchet 26 / gate 25 / lint 7 / spec-only 9 / gap 21) false-claims=0 dangling=0 unrecognized-sections=0
[standards-coverage] measurement=proven base=4318a1e150e9a8304e6c2e7ad381bf66d03998e5 source=canonical-server-content-addressed-merge-base protected-population=88 candidate-population=88 unverified-references=39
[standards-coverage] protected-strength-floor=58/88 ratio=0.6591 candidate-may-raise=false
✅ standards-coverage check passed.
```

The previous existence score was `65/88 = 0.7386`. The live protected-base result is `58/88 = 0.6591`; 39 cited references remain explicitly unverified instead of being rounded up because their path exists.

### C2/C3 — mutations landed and controls bite

```text
$ npx vitest run tests/unit/standards-coverage-ratchet.test.ts --reporter=dot
exit=0
W34_C3A before=0.5 after=0.5 removals=1 deciding="population shrank by 1 (direction: removal)"
W34_C3B landed=size-0 ratchet=0 deciding="candidate-reference-empty"
W34_C3C landed=hollow-addition ratchet=1 deciding="reference-not-in-protected-census"
Test Files  1 passed (1)
Tests       38 passed (38)
```

Mutation-landing assertions executed before each measurement: C3a reads the mutated registry and proves the protected heading is absent; C3b proves the cited candidate file remains present at exactly zero bytes; C3c reads the new rule and the new cited file and proves the file has no executable `it(...)` call.

The score cannot improve under C3a: the protected article remains in the continuity denominator, contributes documented-only strength, and the check records a removal error. C3b loses the prior ratchet contribution while the path still exists. C3c leaves the original ratchet count at one and records the candidate-only hollow reference as unverified.

### Additional verification

```text
$ npx vitest run tests/unit/standards-enforcement-measurement.test.ts --reporter=verbose
exit=0
Test Files  1 passed (1)
Tests       5 passed (5)

$ npx tsc --noEmit
exit=0

$ git diff --check
exit=0
```

The focused suite proves prose/comments are not executable evidence, candidate evidence cannot raise the protected article/reference census, a protected content-bound certified verdict supersedes structural inference while candidate-authored replacement ledgers are ignored, removing a certified candidate reference drops it to unverified, and zero-of-zero is NOT-PROVEN.

### Repository lint — unchanged external blocker

```text
$ npm run lint
exit=1
[lint-model-registry-freshness] enforcement=strict
FIND STALENESS: model registry last reviewed 2026-07-03 (46d ago) exceeds the 45d window.
FAIL — 1 finding(s) under strict enforcement.

$ git diff --exit-code upstream/main -- scripts/lint-model-registry-freshness.mjs src/core/ModelRegistry.ts docs/model-registry.json package.json package-lock.json
exit=0
```

Type-check and every earlier lint entry completed. W3.4 does not change the model-registry manifest or staleness implementation; the brief prohibits touching it. This is an upstream time-based failure and remains visible.

### Evidence stamps and state

```text
scratchpad/phaseB/evidence/W34-controls.json sha256=cf082e89522b35f4d34774000dd6d2328d7a5dc36b63d8a00748d41bef0c8e75
scripts/lib/standards-enforcement-measurement.mjs sha256=8916035029237c595c95c9274fb8e73f8036fe1e6a150eda40079c05e29c36f8
scripts/standards-coverage.mjs sha256=774d83d11863756f91d8e4612d0ad171970c85ea1313e9dc1e1e854d89eb7102
tests/unit/standards-enforcement-measurement.test.ts sha256=bcdd562ccff196b7bfa77ac1ae24318385dc527619552afaae0ee678c6302473
tests/unit/standards-coverage-ratchet.test.ts sha256=8755cbb96b975f3283ce42adc5c22833b747dcd45fde210ba7761e91d969a53d
```

State: **BUILT WITH HAND EVIDENCE, NOT MACHINE-CERTIFIED**. The builder does not call this FIXED or EFFECTIVE; the independent judge must re-gate it.

## 2026-08-18 02:11:50 -0700 (PDT) — Branch published; PR open and unmerged

```text
implementation-commit=a4ec1719968c949d28f6b5532de201aa1f91ebd5
branch=phaseb/w34-enforcement-measurement
fork-push=origin/phaseb/w34-enforcement-measurement
pull-request=https://github.com/JKHeadley/instar/pull/1925
pull-request-number=1925
pull-request-state=OPEN
base=JKHeadley/instar main
merge=NOT PERFORMED
```

First normal push attempt, deciding output:

```text
Test Files  no tests
Tests       no tests
TestRunnerCapacityTimeoutError: [test-runner-bound] could not START within budget (600000ms, suite lane) — this is NOT a test failure; 1 holder(s): [pid 61347]
Serialized Error: { code: 'INSTAR_TEST_CAPACITY_TIMEOUT', exitCode: 75 }
```

The holder was a live Vitest process in another agent worktree. The limit was not raised, disabled, or reclaimed. Because the exact affected set had already passed as 38/38 plus 5/5 on the current source, the unchanged retry used the repository-documented `INSTAR_PRE_PUSH_SKIP=1` test-only opt-out. The pre-push release and fixture-pollution gates still ran and passed; CI remains authoritative.

PR body states **BUILT WITH HAND EVIDENCE, NOT MACHINE-CERTIFIED**, records the unrelated model-registry staleness finding and capacity-only push result, and reserves FIXED/EFFECTIVE for the independent judge.
