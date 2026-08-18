# Phase B Lane W5 — the two previously unrun wiring proofs

> **Append-only chronology:** entries are recorded in execution order.

## 2026-08-18 05:53:42 -0700 (PDT) — wiring-only measurement

### Measurement identity and dependency

Both measurements ran from branch `phaseb/w4-convert-wiring-proofs` at head
`97e3ccb878463229745a98607213dc0933ed1381`. This is the unmerged W4 amendment
that resolves both declared and observed entry spellings with `fs.realpathSync`
and requires exact equality of the resulting paths.

```text
e49d10fd4d98a93a8011efa6807d180cab56fdf5a7745744879bad7c0afb4897  scratchpad/phaseB/fix-verifier.mjs
6534ed0983b733311d343c23b60bc70d13648ca9d911a136875504d20d6e4817  scratchpad/phaseB/authenticated-execution-receipt.mjs
a3ae19ae23bae375f48de04d51aa9f17e674e20783bdfd0d9dd5b5815b864677  scratchpad/phaseB/fix-verifier.manifest.json
```

The instrument and the W4 comparison amendment are both under independent
judgement. These results are provisional on both; this report does not claim
that either has passed.

For both measurements, the instrument server-resolved and fetched protected
`refs/heads/main` at
`248ed7177f5bf416aa7bdad9763741478195e1fc`, with workflow SHA-256
`be9f8f5393854f15793424613fa46da4701b4808219cb173a0d9da1aa649ef71`.
Both target worktrees were clean at measurement start. The scope was
`wiring-only`.

### Fail-open guard — `testing-integrity-route-enforcement`

Target head:
`fbb4ec9d0e68a9a80d23f4df2413a7ac8e5c10cf`. The protected merge base was
`24f1bb4f76d8303f2124131743aa3b3d90bc972d`.

The positive and C3 pipeline passes each exited 1 before the declared
`scripts/lint-testing-integrity.mjs` child ran. Each pass produced zero observer
candidate lines, zero authenticated observer events, and zero receipts.

The instrument verdict line was, verbatim:

```text
    "outcome": "unknown",
```

The deciding pipeline line was the same in both passes (terminal color codes
removed, text otherwise verbatim):

```text
  FIND STALENESS: model registry last reviewed 2026-07-03 (46d ago) exceeds the 45d window. Re-review each capable/latest pin against current frontier, update frontierAllowlist if a model has moved, then bump lastReviewedAt.
```

Result: **UNKNOWN**. The instrument could not observe the declared guard child,
so this is not promoted to NOT-PROVEN. Per the lane brief, the run stopped on
this guard; nothing was changed to make the pipeline proceed.

### Checker-instrument guard — `checker-blind-input-coverage`

Target head:
`2f3cd8e16c7608fcd75c12f51623783f3da8824d`. The protected merge base was
`e5085f969d604cf067383ab3446f5f49c7dccf74`.

The positive and C3 pipeline passes each exited 1 before the declared
`scripts/lint-checker-blind-input-coverage.mjs` child ran. Each pass produced
zero observer candidate lines, zero authenticated observer events, and zero
receipts.

The instrument verdict line was, verbatim:

```text
    "outcome": "unknown",
```

The deciding pipeline line was the same in both passes (terminal color codes
removed, text otherwise verbatim):

```text
  FIND STALENESS: model registry last reviewed 2026-07-03 (46d ago) exceeds the 45d window. Re-review each capable/latest pin against current frontier, update frontierAllowlist if a model has moved, then bump lastReviewedAt.
```

Result: **UNKNOWN**. The instrument could not observe the declared guard child,
so this is not promoted to NOT-PROVEN. Per the lane brief, the run stopped on
this guard; nothing was changed to make the pipeline proceed.

The protected-main copy of the model registry is current, but neither guard is
present at protected main; the measurements necessarily execute their lane
heads, whose candidate trees still carry the stale review metadata shown by the
real lint pipeline. No approver key was created, no CI configuration, registry
manifest, gate, guard, instrument, adapter, or test was modified, and no branch,
commit, pull request, or merge was created.

### Evidence stamps

```text
50993c7f3255ae23115b8fb5fe6433ff097a22a6332876ded8d0527507736742  scratchpad/phaseB/evidence/W5-testing-integrity-route-enforcement.json
319e9bf70af676e47823db39ab28b468b2420b425362e6434545cda8552bea2b  scratchpad/phaseB/evidence/W5-checker-blind-input-coverage.json
```

## 2026-08-18 06:12:13 -0700 (PDT) — W5-B branch refresh and rerun

### Branch refreshes

The server-resolved protected base remained
`248ed7177f5bf416aa7bdad9763741478195e1fc`. Both guard worktrees were clean.
Each branch rebased cleanly onto that exact protected-main commit; no conflict
was resolved and no content edit was made.

- `phase-b1.2-testing-integrity` rebased from observed upstream head
  `fbb4ec9d0e68a9a80d23f4df2413a7ac8e5c10cf` to
  `e5a6eebad7fb04bfaac0f8e168dbf7e833ccfe32`. Its one stable patch ID remained
  `115510504fab0747fd289f32c93c3bd52cac3aca`. The push used
  `--force-with-lease=refs/heads/phase-b1.2-testing-integrity:fbb4ec9d0e68a9a80d23f4df2413a7ac8e5c10cf`,
  and a post-push `ls-remote` resolved the upstream branch to the new head.
- `phaseb/s3-no-blind-clean` rebased from observed upstream head
  `2f3cd8e16c7608fcd75c12f51623783f3da8824d` to
  `e1937a91aa2000b36a2c2177417125394b020263`. Its three stable patch IDs remained,
  in order, `c6b4db0ffb0bfef757d8f2d75bb2d095d2b9950c`,
  `971037a815fabb056de528b9568bf0ceb73cb629`, and
  `4b277be55bfffc6fe4a8d8f689b166914f809a49`. The push used
  `--force-with-lease=refs/heads/phaseb/s3-no-blind-clean:2f3cd8e16c7608fcd75c12f51623783f3da8824d`,
  and a post-push `ls-remote` resolved the upstream branch to the new head.

No manifest, freshness gate, CI configuration, guard, test, adapter, or
instrument was edited. No merge or new pull request was created.

### Unchanged measurement identity

Both reruns were `wiring-only` under W4 amendment branch head
`97e3ccb878463229745a98607213dc0933ed1381`, instrument SHA-256
`e49d10fd4d98a93a8011efa6807d180cab56fdf5a7745744879bad7c0afb4897`,
authenticated-receipt SHA-256
`6534ed0983b733311d343c23b60bc70d13648ca9d911a136875504d20d6e4817`,
and manifest SHA-256
`a3ae19ae23bae375f48de04d51aa9f17e674e20783bdfd0d9dd5b5815b864677`.
The instrument and W4 comparison amendment remain under independent judgement;
these results are provisional on both and do not claim either has passed.

### Fail-open guard after rebase — `testing-integrity-route-enforcement`

Target head: `e5a6eebad7fb04bfaac0f8e168dbf7e833ccfe32`. Protected base and
merge base: `248ed7177f5bf416aa7bdad9763741478195e1fc`.

The positive real lint wrapper exited 0. The exact declared
`scripts/lint-testing-integrity.mjs` child emitted three authenticated observer
events, exited 0, and produced exactly one authenticated child-exit receipt. C3
kept the real wrapper at exit 0, authenticated the exact-child short circuit,
and produced zero guard execution receipts.

The instrument verdict line was, verbatim:

```text
[fix-verifier-wiring] authenticated guard=testing-integrity-route-enforcement entry=scripts/lint-testing-integrity.mjs childPid=79986 childExit=0
```

Result: wiring **PROVEN**, wiring-only rung **WIRED**.

### Checker-instrument guard after rebase — `checker-blind-input-coverage`

Target head: `e1937a91aa2000b36a2c2177417125394b020263`. Protected base and
merge base: `248ed7177f5bf416aa7bdad9763741478195e1fc`.

The positive real lint wrapper reached the exact declared
`scripts/lint-checker-blind-input-coverage.mjs` child. All three observer events
authenticated, including its signed child exit 1, but a successful child-exit
receipt could not be minted. C3 exited 0, authenticated the exact-child short
circuit, and produced zero guard execution receipts.

The instrument verdict line was, verbatim:

```text
    "outcome": "unknown",
```

The deciding checker line was, verbatim:

```text
checker-blind-input: NOT-PROVEN — executable blind cases exited 1
```

The named fixture failure was:

```text
     → expected '✖ empty population is not proof (11.2…' to contain '# tests 4'
```

Node 25 rendered the test-runner summary with `ℹ tests 4`, not the fixture's
legacy `# tests 4` spelling. Result: wiring **UNKNOWN**, wiring-only rung
**EXISTS**. The declared checker did run and authenticate, but exited 1; the
pipeline and checker were not adjusted, and the verdict is not promoted.

### W5-B evidence stamps

```text
184472d6ec3c6a3f28a2bd9e44fccd6fbbbdc30d5b48c5f9eeb5c72fc61b0c91  scratchpad/phaseB/evidence/W5B-testing-integrity-route-enforcement.json
fedc4a633edc0db816f923a4478b6247944532d192ed8fbee00c8c1114b5d31b  scratchpad/phaseB/evidence/W5B-checker-blind-input-coverage.json
```

## 2026-08-18 06:17:47 -0700 (PDT) — F3 diagnosis before repair

F3 independently reproduced the checker-instrument child failure at rebased target
`e1937a91aa2000b36a2c2177417125394b020263` before changing source. The focused
P3d case exited 1.

### Candidate 1 — genuine checker refusal because the property does not hold: ruled out

The P3d fixture deliberately hollows the guard into always returning a passing
verdict. The independent guard-own process correctly rejected that hollow: its
process exited 1, the three cases that must reject the hollow failed, and the one
genuinely covered control passed:

```text
P3_3d_TYPE_PRESERVING_HOLLOW mutationApplied=true guardOwnTestExit=1
✖ empty population is not proof
✖ unknown coverage id is rejected
✖ new uncovered checker is named and rejected
✔ genuinely covered population passes
ℹ tests 4
ℹ pass 1
ℹ fail 3
```

The outer test also accepted the required nonzero status before reaching its
summary assertions. This is the evidence that the checker property held; there
is no genuine guard finding to preserve as a red result.

### Candidate 2 — checker/harness output-format disagreement: ruled in

The only outer assertion failure was the legacy reporter spelling:

```text
AssertionError: expected '✖ empty population is not proof ...' to contain '# tests 4'
- # tests 4
+ ℹ tests 4
```

Source deciding lines:

```text
expect(result.status).not.toBe(0);
expect(output).toContain('# tests 4');
expect(output).toContain('# fail 3');
```

Node `v25.6.1` emitted the semantically identical counts as `ℹ tests 4` and
`ℹ fail 3`. The harness therefore could not read a successful P3 rejection.

### Candidate 3 — environment/dependency failure: ruled out

The W5-B full child run reached the declared checker, authenticated all three
observer events, executed the entire targeted file, and reported exactly one
failed outer test with twelve passed:

```text
Test Files  1 failed (1)
Tests  1 failed | 12 passed (13)
FIX_VERIFIER_OBSERVER_EVENT ... "kind":"child-exit" ... "childExitCode":1
```

The only environment notice was explicitly non-gating:

```text
This is a notice, not a gate: nothing was blocked or skipped because of it.
```

No deciding output named SQLite, an import failure, a missing dependency, a
timeout, or an observer/authentication error.

### Classification and scope decision

Classification: **guard-owned harness-format bug**. The cause is the reporter-
specific assertions in `tests/unit/checker-blind-input-ratchet.test.ts`, which
belongs to this guard's own harness. Repair is in scope. The pre-repair wiring
result remains honest:

```text
checker-blind-input: NOT-PROVEN — executable blind cases exited 1
    "outcome": "unknown",
```

F3 will not change the checker predicate, declared cases, verifier instrument,
path comparison, authentication, signing, sequencing, receipt binding,
manifest, adapter, model registry, CI configuration, or another lane's work.

## 2026-08-18 06:21:34 -0700 (PDT) — F3 capacity checkpoint

The operator directed F3 to stand down because concurrent proof-lane test load
was repeatedly destabilizing the server and outbound messaging. This is a
capacity pause, not a code or diagnosis blocker.

Completed and durable in worktree branch `phaseb/f3-checker-instrument-harness`:

- Pre-repair diagnosis above is recorded.
- The only source edit is in the guard-owned
  `tests/unit/checker-blind-input-ratchet.test.ts` harness.
- It adds exact-line recognition for both TAP (`# tests 4`, `# fail 3`) and
  Node spec-reporter (`ℹ tests 4`, `ℹ fail 3`) summaries.
- It still requires the hollow guard-own process to exit nonzero and still
  requires assertion-failure output. The checker predicate and cases are
  unchanged.

Post-repair verification had entered the repository's single suite-lane queue
but never acquired the slot. The queue reported an active holder and explicitly
said it was not hung. At the operator's direction the waiting process was
interrupted with Ctrl-C before either the focused or full post-repair run began.
Therefore no post-repair pass claim is made.

Remaining work after an explicit restart:

1. Run the focused P3d fixture and the full checker-blind-input ratchet test.
2. If green, run normal lint/commit gates without bypass.
3. Re-run the checker-instrument wiring-only proof using the repaired W4-R
   verifier and the same target, record the verdict line verbatim, and append
   the evidence hash here.
4. Open a pull request only; do not merge or enable auto-merge.

No commit, push, pull request, merge, or new proof run was started after the
stand-down instruction.

## 2026-08-18 06:37:40 -0700 (PDT) — F3-R repair and property control

### Reader choice

F3-R chose exact dual-spelling recognition rather than changing the child
protocol: the harness now accepts either a complete TAP count line (`# tests 4`
and `# fail 3`) or the current Node spec-reporter equivalent (`ℹ tests 4` and
`ℹ fail 3`). It splits output into lines, trims each line, and requires exact
line equality; substrings, arbitrary prefixes, missing counts, and different
counts do not satisfy it.

This is the smallest guard-owned repair. A new structured child protocol would
change more of the independent control surface and create a second result
channel to authenticate. The dual exact-line reader handles the two observed
Node renderers while preserving the existing child process, four real tests,
exit status, expected failure count, and assertion evidence.

### WHAT-did-not-weaken control

The existing P3d control replaces the guard body with an always-passing verdict,
so the underlying blind-input property genuinely does not hold. After the
reader repair, that isolated guard-own process still failed exactly the three
required refusal cases and passed only the genuinely covered control. Deciding
output, verbatim apart from timing values omitted from the individual case
labels:

```text
P3_3d_TYPE_PRESERVING_HOLLOW mutationApplied=true guardOwnTestExit=1
✖ empty population is not proof
✖ unknown coverage id is rejected
✖ new uncovered checker is named and rejected
✔ genuinely covered population passes
ℹ tests 4
ℹ pass 1
ℹ fail 3
```

The output also retained the three underlying `AssertionError
[ERR_ASSERTION]` records. The repaired outer harness passed because it correctly
read this failed child; the child itself did not become green.

### Local verification before proof

```text
focused P3d: Test Files 1 passed (1); Tests 1 passed | 12 skipped (13)
full guard suite: Test Files 1 passed (1); Tests 13 passed (13)
```

The non-gating `better-sqlite3` notice remained unrelated and explicitly stated
that nothing was blocked or skipped because of it.

## 2026-08-18 06:38:16 -0700 (PDT) — F3-R second capacity checkpoint

The operator again directed all controlled proof work to stand down because the
server supervisor was restarting the server before boot could complete under
concurrent load. This is solely a capacity pause.

Durable state on branch `phaseb/f3-checker-instrument-harness`:

- Diagnosis, reader choice, and the WHAT-did-not-weaken control are recorded
  above.
- The guard-owned dual-spelling repair is complete.
- Focused P3d verification passed 1/1; its intentionally hollow child still
  exited 1 with `ℹ tests 4`, `ℹ pass 1`, `ℹ fail 3`, and three assertion errors.
- The full guard suite passed 13/13.
- The repair and this existing W5 record were staged for commit.
- The normal commit gate had started but was interrupted with Ctrl-C immediately
  on the stand-down instruction. No commit was created and no hook was bypassed.

Remaining work after another explicit restart:

1. Re-run the normal commit gate to completion without bypass.
2. Run the checker-instrument wiring-only proof against the committed F3-R head
   using the current repaired W4-R instrument.
3. Append the exact proof verdict line and evidence hash to this report, then
   commit through normal hooks.
4. Push and open a pull request only; do not merge or enable auto-merge.

No wiring proof, push, pull request, merge, or auto-merge action was started in
this resumed interval.

## 2026-08-18 06:46:07 -0700 (PDT) — F3-R authenticated wiring result

The normal commit gate completed without bypass and ran the real guard lint to
success:

```text
checker-blind-input: executable blind cases passed
```

F3-R then ran the checker-instrument wiring-only proof against clean committed
target `52bc14b6b26044a431d22e8608f017d05c7d95cf`, using the current repaired W4-R
instrument SHA-256
`c9fab8034effc8f64c525073f85c7c04c1fd5cca9c0b2324203632ea34145b3a`.
Protected main resolved to
`248ed7177f5bf416aa7bdad9763741478195e1fc`, and the target remained unchanged
by measurement.

The real positive lint run authenticated three signed observer events, exited
0, and minted exactly one authenticated post-child receipt. C3 authenticated
the observer short-circuit and minted zero guard execution receipts. The proof
verdict line, verbatim, was:

```text
[fix-verifier-wiring] authenticated guard=checker-blind-input-coverage entry=scripts/lint-checker-blind-input-coverage.mjs childPid=6097 childExit=0
```

After verdict: wiring **PROVEN**, wiring-only rung **WIRED**.

Evidence:
`scratchpad/phaseB/evidence/F3R-checker-blind-input-coverage.json`, SHA-256
`f800130157168f2d3871e8d6c2e140b94cd1b734c61730b234aa9ddefa83d35d`.

## 2026-08-18 07:05:36 -0700 (PDT) — F4 structured reader repair

The independent F4 judgment accepted the F3-R scope, negative control, and
repaired-boundary wiring, but found the reader still coupled to cosmetic Node
test-runner decoration. F4 removed all TAP/spec summary-line matching from the
decision path.

The guard-owned child now runs with two independent reporters. A custom
machine reporter emits schema `checker-blind-input/guard-own-results-v1` from
Node's `test:complete` events; TAP or spec remains a human-only presentation
channel. The reader rejects malformed JSON, the wrong schema, unknown root or
test fields, invalid test numbers, missing identities, invalid outcomes, and
invalid failure codes. Node also emits a synthetic file aggregate to custom
reporters; it is excluded by its structural event identity (`name === file`),
leaving the complete leaf-test population. No rendered text participates in
the verdict.

The hollow-body control requires exact ordered identity and outcome equality:

```json
{"schema":"checker-blind-input/guard-own-results-v1","tests":[{"testNumber":1,"identity":"empty population is not proof","outcome":"fail","failureCode":"ERR_ASSERTION"},{"testNumber":2,"identity":"unknown coverage id is rejected","outcome":"fail","failureCode":"ERR_ASSERTION"},{"testNumber":3,"identity":"new uncovered checker is named and rejected","outcome":"fail","failureCode":"ERR_ASSERTION"},{"testNumber":4,"identity":"genuinely covered population passes","outcome":"pass","failureCode":null}]}
```

This preserves and strengthens all three substantive checks: both real child
runs exit 1; the exact array contains four tests; and exactly the three named
refusal tests fail with `ERR_ASSERTION`. An unrelated added, removed, renamed,
reordered, or outcome-changed test makes exact equality fail.

### Decoration-invariance control

The same hollow guard ran once with the old TAP renderer and once with the
current spec renderer. Both independent structured results were byte-for-byte
equivalent after schema validation and produced the same rejection verdict.
Deciding excerpts, verbatim:

```text
P3_3d_TYPE_PRESERVING_HOLLOW mutationApplied=true tapChildExit=1 specChildExit=1
F4_DECORATION_CONTROL renderer=tap structuredVerdict=reject structured={"schema":"checker-blind-input/guard-own-results-v1","tests":[{"testNumber":1,"identity":"empty population is not proof","outcome":"fail","failureCode":"ERR_ASSERTION"},{"testNumber":2,"identity":"unknown coverage id is rejected","outcome":"fail","failureCode":"ERR_ASSERTION"},{"testNumber":3,"identity":"new uncovered checker is named and rejected","outcome":"fail","failureCode":"ERR_ASSERTION"},{"testNumber":4,"identity":"genuinely covered population passes","outcome":"pass","failureCode":null}]}
# tests 4
# pass 1
# fail 3
F4_DECORATION_CONTROL renderer=spec structuredVerdict=reject structured={"schema":"checker-blind-input/guard-own-results-v1","tests":[{"testNumber":1,"identity":"empty population is not proof","outcome":"fail","failureCode":"ERR_ASSERTION"},{"testNumber":2,"identity":"unknown coverage id is rejected","outcome":"fail","failureCode":"ERR_ASSERTION"},{"testNumber":3,"identity":"new uncovered checker is named and rejected","outcome":"fail","failureCode":"ERR_ASSERTION"},{"testNumber":4,"identity":"genuinely covered population passes","outcome":"pass","failureCode":null}]}
ℹ tests 4
ℹ pass 1
ℹ fail 3
```

Local verification:

```text
focused decoration control: Test Files 1 passed (1); Tests 1 passed | 12 skipped (13)
full guard suite: Test Files 1 passed (1); Tests 13 passed (13)
```

The non-gating `better-sqlite3` notice remained unrelated and explicitly said
nothing was blocked or skipped because of it.

## 2026-08-18 07:12:35 -0700 (PDT) — F4 authenticated wiring result

F4 measured clean committed target
`e64e3a2497d59a4d3aec0f8eb4e04589e4912f58` with the current W4-R
regular-file instrument SHA-256
`c9fab8034effc8f64c525073f85c7c04c1fd5cca9c0b2324203632ea34145b3a`.
Protected main remained
`248ed7177f5bf416aa7bdad9763741478195e1fc`, and target porcelain was
unchanged by measurement.

The real protected-workflow lint exited 0. Its observer authenticated the
ordered ready, child-start, and child-exit events for the declared regular-file
entry and minted exactly one post-child receipt. The C3 wrapper authenticated
its own short-circuit event, exited 0, and minted zero guard-execution receipts.
The verdict line, verbatim, was:

```text
[fix-verifier-wiring] authenticated guard=checker-blind-input-coverage entry=scripts/lint-checker-blind-input-coverage.mjs childPid=27613 childExit=0
```

After verdict: wiring **PROVEN**, wiring-only rung **WIRED**.

Evidence:
`scratchpad/phaseB/evidence/F4-checker-blind-input-coverage.json`, SHA-256
`9e4c5b82810b06792fafe3d1b85fe0a0a86d49b1ba110ba8841ee4a3fcbb9627`.
