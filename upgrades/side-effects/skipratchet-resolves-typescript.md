# Side-effects review — skip ratchet resolves `typescript` from the verified repo

Change: `src/localVerify/skipRatchet.ts` exports `loadTsFrom(resolveFrom?)`,
which resolves the TypeScript parser from `resolveFrom`'s `node_modules` before
falling back to this module's own resolution. `src/localVerify/orchestrator.ts`
passes the run directory through a new optional `loadTs` seam.

Measured defect it fixes (not inferred): the 2026-10-23 verify run of PR #2318
logged, in its own run log
(`.instar/state/local-verify/runs/a39ab6069f81918d15692615198b77fc.log`):

```
{"event":"classify-read-failure","detail":"Cannot find module 'typescript'\nRequire stack:\n- .../.instar/shadow-install/node_modules/instar/dist/localVerify/skipRatchet.js"}
```

The record therefore carried `harnessChanging: true` on a pull request whose
merge-base→head diff is 8 files, none of them in `HARNESS_GLOBS` and none a
lifecycle-script file. `classifyHarness` run directly over that exact diff in the
verifier's own bare clone returns `{harnessChanging: false, reasons: []}`. So the
flag came entirely from the catch-all, and it blocked a green PR on an operator
approval overnight.

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

Nothing new is rejected. The change only widens where one module is looked for.
The classifier's rules are untouched: `HARNESS_GLOBS`, the lifecycle-script
derivation, the `package.json`/`package-lock.json` toolchain comparisons and
`isProtectedPath` are byte-identical.

The over-block being REMOVED is larger than my first draft of this artifact
said, and the evidence was in the same directory I was already citing.
`evaluateSkipRatchet` resolves the parser on its first line, before it inspects
`changed`, and `orchestrator.ts` calls it unconditionally — the `.test.ts` filter
only decides what goes INTO the array. So the class is **every verify**, not
"every PR touching a test file".

Measured on this machine: 31 of the 44 run logs carry the failure, and those 31
are exactly the runs that reached classification (none of the other 13 has a
`run-finished` event). **10 of those 31 are `pr: 0` main verifies with an empty
diff** — proof that no file change is needed to trip it. The PRs affected were
2294, 2296, 2297, 2299, 2301, 2305, 2308, 2310, 2316, 2317, 2318, 2319, 2320.
All 20 records in `.instar/state/local-verify/journal.jsonl` carry
`harnessChanging: true`, not one `false`: the autonomous merge path has never
produced an unflagged record here, and the reason the flag STATED was this bug.

What that does NOT mean is that every operator approval was unnecessary. 4 of
the 20 records also carry `protectedPath: true` (PRs 2296, 2305 and 2316 twice),
and `protectedPath` is computed correctly inside the catch-all, independent of
the parser failure — those needed a review regardless. The claim is about the
flag's stated reason, not about whether a review was warranted.

**And the ratchet was not merely mis-flagging — it was blind.** The catch-all
leaves `skipsAdded` and `testsRemoved` at their initialised `false`, so all 20
records report "no skips added, no tests removed" without having counted
anything. What is proven is that the gate still held: `harnessChanging: true`
routed every one of those PRs to an operator approval, and 0 of the 20 records
carry `independentReview`, so the ratchet was never the thing that let anything
through. Whether a skip or a deleted test file actually slipped into one of those
merged PRs is unknown until re-measured, and this change makes that measurable
again rather than answering it.

## 2. Under-block — what failure modes does this still miss?

- **Both locations missing.** If neither the verified repo nor the module's own
  tree has `typescript`, `loadTsFrom` re-raises the last error and the
  orchestrator's catch-all fires exactly as before — harness-changing, operator
  approval, `classify-read-failure` logged. Deliberate: a ratchet that cannot
  parse must not report "no skips added". This branch is now asserted through the
  new seam in `tests/unit/localVerify/orchestrator.test.ts`.
- **Could the run directory itself lack the parser?** No, and the reason is
  stronger than "its dependencies are installed". `classify()` runs after
  `npm ci` and after the build step, and `package.json`'s `build` script IS
  `tsc …` — so any run that reaches classification has already executed
  `typescript` out of `<runDir>/node_modules`. The second `classify()` callsite
  is reachable only from the build-step failure, which is also post-`npm ci`.
- **A hostile repo's parser.** The verified repo's own `node_modules` is now
  preferred, so a pull request that vendored a malicious `typescript` could have
  its parser loaded by the verifier. Assessed and accepted: the verifier already
  runs that repo's `node_modules/.bin/vitest` with that repo's `node_modules` on
  `PATH` for all three lanes before classification happens, so arbitrary code
  from the merge result already executes in that directory. This change adds no
  new trust boundary, though it does change the DEGREE: a hostile parser moves
  from racing the result writer from a vitest child to running inside
  `runVerifyMain`, the process that mints the record. Same same-user code
  execution either way, and a change to `package-lock.json`'s toolchain entries
  is itself a harness-changing flag (`lockToolchain` compares `version`,
  `resolved` and `integrity`), which is the existing control for exactly this.
- **A version skew between the repo's parser and instar's.** A repo pinning a
  much older `typescript` could parse newer syntax differently. Not newly
  introduced in kind (the suite itself already runs on the repo's own toolchain),
  and bounded by the same `package-lock.json:toolchain` flag.
- **The record still stores a bare boolean.** `harnessChanging: true` carries no
  reason into the record, so the next false flag will again be invisible from the
  record alone. The reason IS durably logged — in the run's own log, which is
  where I eventually found it; what cost hours was searching the wrong file
  (`.instar/logs/local-verify.jsonl`, the service audit) rather than the run log.
  Observability is adequate; the operator-facing gap is a reader problem, and
  adding a `reasons` field would change the record schema, its validator and the
  status projection — a larger change than this defect warrants.

## 3. Level-of-abstraction fit

The resolution rule belongs in `skipRatchet.ts`, which is the only module that
needs the parser and already owns lazy loading; keeping it there means one
place, one cache and one testable function. The orchestrator owns the only fact
`skipRatchet` cannot know — which directory is under verification — so it
supplies it. The alternative, promoting `typescript` to a runtime dependency of
instar, was rejected: it would ship a ~25 MB compiler to every end-user install
for a maintainer-only code path, and `typescript` is itself in
`TOOLCHAIN_PACKAGES`, so moving it would permanently flag the very manifest
change that did it.

## 4. Signal vs authority compliance (`docs/signal-vs-authority.md`)

The skip ratchet is a deterministic signal consumed by the floor gate, which
holds the authority. This change does not move that line: it does not grant
authority to anything new, and it does not weaken the floor. The catch-all that
converts "cannot measure" into "route to the operator" — the conservative
authority behaviour — is preserved verbatim. What is fixed is an instrument that
could not read, reporting as though it had read something about the PR.

## 5. Interactions

- **Floor gate / `safe-merge.mjs`** — unchanged. It reads the same four boolean
  flags. PRs that were previously flagged for this reason will now pass the local
  floor, which is the intended effect.
- **`verifierVersion`** — `computeVerifierVersion` hashes the verifier's own
  source, so it changes with this commit. That is its designed behaviour on any
  verifier change; existing records keep their own recorded version.
- **No double-fire.** `loadTsFrom` is called once per run, inside `classify()`.
  The per-directory cache means repeated runs in the same directory reuse one
  module.
- **`countSkips`'s own default** was also moved onto `loadTsFrom()` with no
  argument, which is byte-equivalent to the previous `loadTs()` behaviour for
  every existing caller.

## 6. External surfaces

One, and my first draft wrongly said "none". `stateLabel` feeds
`statusDescription` (`src/localVerify/record.ts`), which `statusProjection.ts`
publishes as the `instar/local-verify` commit status on the pull request. Every
affected PR's visible status text therefore changes from
`awaiting-independent-review · harness-changing · …` to
`authorized · verified · …`. That is the intended effect of the fix and is
visible on GitHub to anyone reading the PR, so it is an external surface, not an
internal detail.

No route shape, no message, no config key and no file an agent or user reads
changes. The other observable differences are internal: fewer
`classify-read-failure` entries in verifier run logs, and `harnessChanging:
false` with real `skipsAdded`/`testsRemoved` values on records that previously
carried `true` and two unmeasured falses.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design.** Local verify is per-machine: each machine keeps its
own bare clone, run directories, queue, journal and records under
`<agentHome>/.worktrees/.verify/` and `.instar/state/local-verify/`. A verify
record is produced by the machine that ran it and consumed by that machine's
floor gate; `GET /local-verify/*` is not pool-scoped and a standby answers 409
naming the lease holder. Nothing here is replicated, proxied on read, or
transferred with a topic, and nothing generates a URL. The parser resolution is
by definition local — it reads that machine's own `node_modules`.

The defect's blast radius was, correspondingly, per-machine: every maintainer
agent whose verifier runs from a shadow install had it, independently.

## 8. Rollback cost

Low and self-contained. Reverting the two source files restores the previous
behaviour exactly (and with it the false flag). No data migration: records
already written keep their stored flags, and no state file, config key or route
shape changes. An operator who wants the old behaviour for one PR can still
approve it on GitHub, which is the same path that was being forced before.

## Second pass

Required — the change touches `src/localVerify/**`, the merge authority's own
server side, and alters how a gate's input is produced.

### Reviewer round 1 — CONCERN RAISED

The reviewer confirmed the fix itself against the code (call order relative to
`npm ci` and the build step, the preserved catch-all, that nothing gets looser,
and the trust-boundary argument via `lockToolchain`'s version+resolved+integrity
comparison), and raised five things. All five were correct; I verified each claim
myself rather than taking it on trust, and all are now fixed:

1. **The defect class was stated wrongly.** I wrote "every PR touching a
   `.test.ts` file"; the parser is resolved before any file is inspected, so it
   is every verify. The reviewer's proof — 10 of the 31 affected run logs are
   `pr: 0` main verifies with an empty diff — reproduces exactly. Section 1 is
   rewritten, and so is the overstated comment it had put into
   `tests/unit/localVerify/orchestrator.test.ts`.
2. **The ratchet was blind, not mis-flagging.** `skipsAdded`/`testsRemoved` sat
   at their initialised `false` on all 20 records, so the check reported "no
   skips added" without counting. Verified; stated in section 1.
3. **Section 6 wrongly claimed no external surface.** The published
   `instar/local-verify` commit-status text changes on every affected PR.
   Verified through `stateLabel` → `statusDescription` → `statusProjection.ts`;
   section 6 rewritten.
4. **The safety branch section 4 calls "preserved verbatim" had no test**, even
   though the new seam makes it five lines. Added: an unresolvable parser through
   the seam must still produce `harnessChanging: true` plus a logged
   `classify-read-failure`.
5. **A test name overstated its body** — "caches per directory" proved only the
   non-sharing half, and would pass with no cache at all. Split in two: the
   non-sharing assertion keeps its own name, and a real cache assertion was added
   that removes the fixture's `node_modules` between calls, so an uncached
   implementation would fall back to the real `typescript` and fail.

Also applied: the seam is typed `ReturnType<typeof loadTsFrom>` instead of
`unknown` plus a cast (the cast dropped type-checking at exactly the new seam),
and section 2 now states the run directory's guarantee in its strong form —
`tsc` IS the build step and the build precedes classification — rather than the
weaker "its dependencies are installed".

### Reviewer round 2 — CONCERN RAISED, then resolved

The reviewer confirmed the code and that both new tests discriminate — naming the
non-obvious reason the cache test works: after the fixture's `node_modules` is
removed, RESOLUTION throws before Node's own module cache can answer, so an
uncached implementation falls back to the real `typescript` and fails the marker
assertion. It then raised three overstatements in the rewritten §1, which is
round 1's error inverted. All three reproduce against the journal; all three are
fixed above:

1. **"every operator approval it ever asked for was this bug"** is false. 4 of
   the 20 records carry `protectedPath: true` (PRs 2296, 2305, 2316 twice),
   computed correctly inside the catch-all, so those needed a review anyway.
2. **"the other 12"** was 13 — there are 44 run logs, not 43.
3. **"There is no functional harm to point at"** was unproven. What is proven is
   that the gate held (0 of 20 records carry `independentReview`); whether
   anything slipped is unknown until re-measured, and §1 now says so.

§2's trust-boundary acceptance also gained the sentence naming the degree the
reviewer asked for.

Two further defects surfaced while applying this: the cache test's direct
`fs.rmSync` tripped the destructive-fs lint, and in fixing it I found my own
`afterAll` calling a non-existent instance method inside `try { } catch { }`, so
the fixture directories had been leaking silently since I wrote the file. Both
callsites now use the static `SafeFsExecutor.safeRmSync` API.

### Reviewer round 3 — CONCUR

The reviewer re-verified every number in §1 against the journal and the run logs
(the 4 protected-path records, the 31-of-44, the 10 `pr: 0`, the 0
`independentReview`, and that `isProtectedPath` runs on a non-null `rows` in
those runs so the value is the real one), and concurred, with two one-liners that
do not touch behaviour. Both applied:

1. The new test file's own header still carried the corrected-everywhere-else
   scope claim ("every PR that touched a `.test.ts` file"). Fixed — it is the
   primary explanation of the regression for the next reader, so it was the worst
   place to leave it.
2. **The fixture-leak fix was unproven as stated, and the reviewer was right to
   refuse the code reading.** Settled by measurement instead: 33 fixture
   directories in `$TMPDIR` before, one run of the file (which creates 6), 33
   after — so the created ones are now removed and the 33 were pre-fix residue.
   The residue is cleared. The silent `catch` that hid the original leak for the
   file's whole life now records each failure, warns, asserts the failure list is
   empty, and asserts every directory it created is gone — so this cleanup cannot
   fail quietly again.

