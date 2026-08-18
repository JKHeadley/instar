# Phase B Lane W1 — Validated Pipeline-Wiring Proof

> **Append-only chronology:** This report preserves the evidence known at each step. Read entries from top to bottom: the newest entry is last and supersedes earlier status statements for the same claim.

## 2026-08-17 23:25:52 -0700 (PDT) — Brief read, design pinned, first failing test proven

### Ground

```text
model=GPT-5 Codex
tree=/Users/justin/Documents/Projects/instar-codey/.worktrees/phase-b-w1-validated-pipeline-wiring
branch=phaseb/w1-validated-pipeline-wiring
base=upstream/main
commit=4318a1e150e9a8304e6c2e7ad381bf66d03998e5
git status before implementation=clean
```

### C3 restatement before build

Deliberately bypass the declared guard entry while its wrapper still exits successfully; the envelope must then be invalid and wiring must be NOT-PROVEN or UNKNOWN, never PROVEN.

### Design decision

The core—not an adapter—mints a per-run token and controls a `node` process observer placed first on `PATH`. The observer records the exact manifest-pinned guard child only after that child exits. The core accepts the receipt only when the adapter command is anchored to the manifest-pinned protected workflow command. C3 runs the same wrapper command while the observer short-circuits only that exact child, and requires wrapper success with no receipt.

The isolation seed fetches the manifest-pinned protected remote/ref and installs that server-resolved commit as `origin/main` and `main` in every case. No `HEAD^` or candidate-chosen base is accepted as the protected reference.

### First failing test

```text
$ node --test scratchpad/phaseB/fix-verifier.test.mjs
exit=1
SyntaxError: The requested module './fix-verifier.mjs' does not provide an export named 'runPipelineWiringControls'
Subtest: scratchpad/phaseB/fix-verifier.test.mjs
not ok 1
# tests 1
# pass 0
# fail 1
```

This is the intended pre-implementation failure: the runtime relationship envelope does not exist yet.

## 2026-08-18 00:07:36 -0700 (PDT) — Core implementation and three settled live runs

### Implementation

- The manifest now pins the protected remote URL, branch ref, workflow path/job/command, real invocation prefix, and exact observed Node child for each fix-lane guard.
- The core resolves the protected ref with `git ls-remote`, fetches that exact SHA into an isolation seed, verifies the fetch matches the server answer, reads the workflow from that protected commit, and installs the commit as `origin/main`, `upstream/main`, and `main` in every isolated case.
- The core mints tokens itself and places its own `node` observer first on `PATH`. The token is not supplied through the candidate environment. The observer writes a receipt only after the manifest-pinned child exits.
- C3 uses the same wrapper command and an observer that skips only the exact child, records that short-circuit independently, exits the child as success, and emits no execution receipt.
- Static `adapter.pipelineRelevance` testimony is rejected. A runtime envelope must have `source=fix-verifier-core`, mode `core-minted-process-receipt`, a token-bound post-child receipt, all checks true, and a proven C3 with zero receipts.
- `--wiring-only` measures this relationship without rerunning the already-certified property mutations. It can render only WIRED/EXISTS for this scoped run; it never emits EFFECTIVE.

### Core tests

```text
$ node --test scratchpad/phaseB/fix-verifier.test.mjs
exit=0
tests 14
pass 14
fail 0

C3 behavioral fixture:
  positive wrapper exit=0; receipts=1
  C3 wrapper exit=0; exact-child short-circuit events=1; receipts=0

blocked-before-entry fixture:
  positive exit=1; receipts=0
  C3 short-circuit events=0
  C3 outcome=unknown; envelope status=unknown
```

### S5 standards direction — wiring PROVEN

```text
target=4318a1e150e9a8304e6c2e7ad381bf66d03998e5
protected=4318a1e150e9a8304e6c2e7ad381bf66d03998e5
mergeBase=4318a1e150e9a8304e6c2e7ad381bf66d03998e5
C1=proven C2=proven C3=proven wiring=proven rung=wired
positive exit=0 receipts=1
[fix-verifier-wiring] token=<per-run> guard=standards-direction-guard entry=scripts/standards-coverage.mjs childExit=0
C3 exit=0 short-circuit-events=1 receipts=0
[fix-verifier-C3] short-circuited guard=standards-direction-guard entry=scripts/standards-coverage.mjs
```

The wiring-only S5 preparation reads the protected registry and public pin from the server-resolved protected commit. It generated, rotated, installed, or wrote no approver key and did not run the key-generating property fixture.

### B1.2 Testing Integrity — merge-base fixed; wiring UNKNOWN behind an earlier real gate

```text
target=fbb4ec9d0e68a9a80d23f4df2413a7ac8e5c10cf
protected=4318a1e150e9a8304e6c2e7ad381bf66d03998e5
mergeBase=24f1bb4f76d8303f2124131743aa3b3d90bc972d
former no-merge-base output=ABSENT
positive exit=1 receipts=0
C3 exit=1 short-circuit-events=0 receipts=0
C1=unknown C2=unknown C3=unknown wiring=unknown rung=exists
FIND STALENESS: model registry last reviewed 2026-07-03 (46d ago) exceeds the 45d window.
```

The real `npm run lint` command now has a genuine protected merge base but stops at `lint-model-registry-freshness.mjs`, before `scripts/lint-testing-integrity.mjs`. No bypass or pipeline weakening was applied. Because the guard child was never reached, both the positive wiring claim and C3 are UNKNOWN, not NOT-PROVEN.

### S3 blind checkers — merge-base fixed; wiring UNKNOWN behind the same earlier real gate

```text
target=2f3cd8e16c7608fcd75c12f51623783f3da8824d
protected=4318a1e150e9a8304e6c2e7ad381bf66d03998e5
mergeBase=e5085f969d604cf067383ab3446f5f49c7dccf74
former no-merge-base output=ABSENT
positive exit=1 receipts=0
C3 exit=1 short-circuit-events=0 receipts=0
C1=unknown C2=unknown C3=unknown wiring=unknown rung=exists
FIND STALENESS: model registry last reviewed 2026-07-03 (46d ago) exceeds the 45d window.
```

The adapter no longer writes `HEAD^` into a purported protected ref. It validates the three core-installed refs against the server-resolved SHA. The real lint command still cannot reach `scripts/lint-checker-blind-input-coverage.mjs` because the earlier staleness guard refuses first; the honest wiring result is UNKNOWN.

### Discarded S4 run

One S4 rerun was discarded after its targeted Vitest child slept for more than nine minutes without output. It was interrupted through the observer's signal-forwarding path; no conclusion rests on it, no process survived, and its 148 MB isolated directory was moved to Trash as `instar-fix-verifier-UUBEGe-discarded-W1` (recoverable). A fresh S4 run is in progress.

## 2026-08-18 00:27:27 -0700 (PDT) — Final builder evidence

### S4 operator binding — wiring PROVEN after a legitimate queued wait

```text
target=4318a1e150e9a8304e6c2e7ad381bf66d03998e5
protected=4318a1e150e9a8304e6c2e7ad381bf66d03998e5
mergeBase=4318a1e150e9a8304e6c2e7ad381bf66d03998e5
positive durationMs=612133
Test Files  3 passed (3)
Tests       34 passed (34)
[fix-verifier-wiring] token=<per-run> guard=topic-operator-evidence entry=node_modules/vitest/vitest.mjs childExit=0
positive exit=0 receipts=1
[fix-verifier-C3] short-circuited guard=topic-operator-evidence entry=node_modules/vitest/vitest.mjs
C3 exit=0 short-circuit-events=1 receipts=0
C1=proven C2=proven C3=proven wiring=proven rung=wired
```

The 612-second duration is the deciding confirmation that the earlier silence was legitimate waiting, not a guard failure. No host limit was raised or disabled.

### Discarded-run correction and boundary

The earlier “one discarded S4 run” paragraph is incomplete and is superseded by this accounting. Three attempts produced no usable verdict: one hit the former five-minute caller timeout and then exposed a cleanup race (`p1FXLn`); two were manually interrupted while diagnosing detached observer process groups (`UUBEGe`, `oS1yRq`). No final claim uses them. Their exact temporary directories were moved to Trash and are recoverable. No matching process survived. The final non-detached run `daZkpG` completed normally and is the sole S4 verdict source.

### Final per-guard builder state

| guard | protected command reached exact child | C1 | C2 | C3 | wiring-only rung | deciding boundary |
|---|---:|---:|---:|---:|---|---|
| S4 operator binding | yes | PROVEN | PROVEN | PROVEN | WIRED | 34/34 tests; one post-child receipt; C3 zero receipts |
| S5 rulebook direction | yes | PROVEN | PROVEN | PROVEN | WIRED | standards coverage child exit 0; one receipt; C3 zero receipts |
| B1.2 Testing Integrity | no | UNKNOWN | UNKNOWN | UNKNOWN | EXISTS | real lint stops first at model-registry staleness |
| S3 blind checkers | no | UNKNOWN | UNKNOWN | UNKNOWN | EXISTS | real lint stops first at model-registry staleness |

The known `no-merge-base` blocker is cleared for both B1.2 and S3 with real server-resolved merge bases. A different live pipeline gate now prevents both exact children from running. This lane did not change that gate, bypass it, modify `.github/**`, or widen into model-registry maintenance.

Nothing here is called FIXED or EFFECTIVE by the builder. The B0.3 judge must re-gate the implementation and decide whether/how to combine validated wiring with the earlier property-complete records. At this builder boundary, two wiring relationships are PROVEN and two are honestly UNKNOWN.

### Final hashes

```text
92425be2ecec5969f650c23851153c7e3396ef27582acc141cc6c45d88d116d2  scratchpad/phaseB/fix-verifier.mjs
08af9989637bc1acb2342101a5fb3d66d91343f125d188a440534f1f644f6b03  scratchpad/phaseB/fix-verifier.test.mjs
a3ae19ae23bae375f48de04d51aa9f17e674e20783bdfd0d9dd5b5815b864677  scratchpad/phaseB/fix-verifier.manifest.json
4b154729282c2dc7f237290c5d34e645a12f357a857442cff5dd66e731d96ec2  scratchpad/phaseB/evidence/W1-topic-operator-evidence.json
a9149512c85438d56a913dc583fe3d0270cb9e700d8c686d734981afc020e867  scratchpad/phaseB/evidence/W1-standards-direction-guard.json
d34f8f1e309c9364577a524870f4d1f93580808d01a172c4946ea8bdc842fe63  scratchpad/phaseB/evidence/W1-testing-integrity-route-enforcement.json
ecd163ff2ed35166a945f235a064d783d759aedd34836f461d782ed7d085ad4a  scratchpad/phaseB/evidence/W1-checker-blind-input-coverage.json
1f4ce83e270a1a89f20aaa39fff25be9556f876ddaa356c5e4888369df6394ab  scratchpad/phaseB/evidence/W1-evidence-stamps.json
```

## 2026-08-18 00:31 PDT — Repository lint and artifact integrity

```text
$ npm run lint
exit=1
tsc --noEmit completed and the lint chain reached lint-model-registry-freshness.mjs.
FIND STALENESS: model registry last reviewed 2026-07-03 (46d ago) exceeds the 45d window.
FAIL — 1 finding(s) under strict enforcement.
```

This reproduces on the untouched `upstream/main` base and is unrelated to the W1 scratchpad-only paths, but it is a real blocking gate. It was not bypassed, disabled, or “refreshed” by this lane.

```text
stdout/evidence byte comparison:
topic-operator-evidence cmp_exit=0
standards-direction-guard cmp_exit=0
testing-integrity-route-enforcement cmp_exit=0
checker-blind-input-coverage cmp_exit=0

W1-evidence-stamps.json verification:
11/11 recorded SHA-256 values match the current files
exit=0
```

## 2026-08-18 00:36 PDT — Whitespace-only import cleanup and restamp

`git diff --cached --check` identified extra blank EOF lines introduced while mechanically importing seven pre-existing adapter files into the PR worktree. Those blank lines were removed without semantic changes. Because one affected file is the B1.2 adapter, its wiring-only UNKNOWN run was repeated on the unchanged target and produced the same deciding outcome and merge base.

The earlier B1.2 adapter/evidence/stamp hashes are superseded by:

```text
21bf4fa7c026fcbb3d0f745945af163884e7496ce4455fbf55b315f79c4c4337  scratchpad/phaseB/adapters/testing-integrity-route-enforcement.mjs
3a556c7f639267c16160a7dbb7ba1675ee7c001465d8762a783982447c20aa2d  scratchpad/phaseB/evidence/W1-testing-integrity-route-enforcement.json
f2afd386bf36967ee82145afb217d7a241353d06de25e210944f6569ef86af08  scratchpad/phaseB/evidence/W1-evidence-stamps.json
```

## 2026-08-18 00:40 PDT — Landing blocked by the live fail-closed hook

```text
$ git commit -m 'test: validate live pipeline wiring receipts'
exit=1
husky - pre-commit script failed (code 1)
FIND STALENESS: model registry last reviewed 2026-07-03 (46d ago) exceeds the 45d window.
FAIL — 1 finding(s) under strict enforcement.
```

No commit was created. No hook, test, or gate was bypassed. The W1 changes remain staged on `phaseb/w1-validated-pipeline-wiring`. Opening a PR is genuinely blocked until an authorized model-registry re-review makes the repository's own lint green, or the orchestrator explicitly authorizes a different landing procedure. The lane does not claim a PR exists.
