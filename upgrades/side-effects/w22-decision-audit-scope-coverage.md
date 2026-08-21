# Side-Effects Review — decision-audit gate: scope coverage, not mere presence

**Change:** `scripts/decision-audit-presence-check.mjs` (+ its unit test)
**Tier:** 1 (declared). See "Tier declaration" at the bottom — the gate's advisory signal said 2.
**Branch:** `w22-b-audit-scope-coverage` · **Base:** `7d4076a53` (JKHeadley/main, v1.3.1182)

## Summary of the change

The decision-audit presence gate ran on every PR and asked one question: did *some* decision-audit
record change in this PR? It never asked whether that record's declared scope covered the in-scope
files the PR actually touched. Any unrelated or stale-scoped record satisfied it. The gate reported
"covered" while covering nothing — a known false positive, and the exact shape the Window-22 guard
survey was chartered to find.

The evaluator now accepts caller-supplied decision records, unions their readable `scope.files`, and
requires every in-scope changed path to be covered by that union. The pure function does no
filesystem I/O; the CLI reads the per-entry JSON records and passes parsed content in.

## Decision-point inventory

One decision point, already existing: pass/fail of the `decision-audit-gate` CI check on a PR. This
change does not create a decision point; it corrects the predicate of one that already blocks.

## 1. Over-block

**What it now rejects that it did not before:** a PR that carries a decision-audit record whose
`scope.files` does not list every in-scope changed path. In practice this is a PR where the gate ran
for *some* of the commits but not the one that touched the extra file, or where files were added
after the last gate run.

This is the intended new rejection, but it is a genuine behaviour change for authors: previously the
presence of any record was enough. The failure message names the uncovered paths and tells the
author to re-run the local gate so the record declares them. Cost of a false block is "re-run the
gate and re-commit" — recoverable, local, no data loss.

**Deliberate non-tightening:** directory strings do *not* count as covering their descendants. That
choice makes the gate stricter than a permissive reading. It is recorded here because it is the one
place a reasonable reviewer might want the opposite; the writer emits concrete staged file paths, so
descendant-coverage would only matter for hand-written records.

## 2. Under-block

Still missed, explicitly:

- A record whose `scope.files` lists the right paths but whose *content* is boilerplate. Coverage is
  a structural claim, not a quality claim; nothing here reads the reasoning.
- A PR that changes an in-scope file, reverts it in a later commit, and carries a record scoped to
  the intermediate state. The union is computed over declared paths, not over diff history.
- Files outside the in-scope predicate (`isInScopeFile`) are unaffected — this change does not widen
  what counts as in-scope, and should not be read as doing so.
- Bot-authored and release-cut PRs remain exempt, unchanged.

## 3. Level-of-abstraction fit

Correct layer. The check runs at the PR boundary, which is where the bypass it detects becomes
visible; the local pre-commit gate is the layer that *produces* the record, and it already does its
job. Pushing coverage down into the pre-commit writer would not help — the failure mode is commits
that never reached the writer at all.

No smarter gate exists that this should feed instead. The verdict is a set-membership fact, not a
judgment, so there is no authority for it to inform.

## 4. Signal vs authority compliance

`docs/signal-vs-authority.md` applies to **judgment** decisions — blocking on what a message *means*
or what an agent's *intent* appears to be. This is not one. "Do the record's declared paths cover the
diff's paths?" is set membership over enumerable inputs, with no context required to separate the
legitimate case from the illegitimate one. It sits in the document's own excluded category:
structural validation at a boundary.

The change also moves the check in the *safe* direction relative to the principle: the check already
held blocking authority with a brittle predicate; this narrows a false-positive **pass**. It does not
add brittle authority, and it does not add a new blocker.

**Fails closed** on an absent, malformed, or unreadable `scope.files` — that record contributes no
coverage. Justified by the same document: a guard whose false-pass is cheap to exploit and whose
false-block costs a re-run should fail closed.

## 5. Interactions

- **Legacy JSONL transition path** (`.instar/instar-dev-decisions.jsonl`) is checked *before* the
  coverage logic and still short-circuits to pass. In-flight PRs on the old format are unaffected.
- **The "no record at all" branch** is preserved verbatim, including its long remediation message.
  Only the new "record present but scope does not cover" branch is added.
- **The local pre-commit gate** is the producer of these records; nothing in this change alters what
  it writes.
- No double-fire: the gate runs once per PR in one workflow.
- **Self-referential note:** this PR changes an in-scope file, so it must itself carry a record whose
  scope covers `scripts/decision-audit-presence-check.mjs`. The change is therefore exercised against
  itself at merge time.

## 6. External surfaces

CI-visible only. The check's failure output changes (it now prints "In-scope files lacking
decision-audit coverage" and lists uncovered paths rather than all in-scope paths). No route, no
message, no agent-visible behaviour, no user-visible surface. No timing or runtime-state dependence.

## 6b. Operator-surface quality

The failure message names the specific uncovered files and the concrete remedy (re-run the local
gate so the record declares the path). It does not require the reader to know the internals of the
record format. No operator action is required by this change itself.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design, and correctly so:** this runs in GitHub Actions against a PR, not on any
agent machine. There is no per-machine state, no replication path, and nothing to strand on a topic
transfer. The decision records it reads are repository content, identical on every checkout.

## 8. Rollback cost

Single-file revert of `scripts/decision-audit-presence-check.mjs` (plus its test). No migration, no
persisted state, no agent repair. A PR blocked by the new predicate is unblocked by reverting or by
adding a covering record. Worst realistic case: a burst of PRs fail the gate until authors re-run
the local gate — visible immediately, recoverable in minutes.

## Conclusion

Bounded correction of an existing gate's predicate, in the direction of fewer false passes, with a
recoverable false-block cost. No new decision point, no new authority, no runtime surface.

**Verdict is REVIEW-GRADE, not proven.** The five-property signature test that would let a guard be
called *fixed* does not exist — `scratchpad/phaseB/B0.1-THE-BAR.md` is marked `DRAFT-FOR-LANES` and
its B0.2 runner was never built. Nothing in this change may be described as fixing, verifying, or
proving the guard is effective.

## Tier declaration (recorded because the signal disagreed)

The gate's advisory printed `suggestedTier=2 (size=2, riskFloor=1, 86 LOC across 1 file(s))` — the
**risk** floor is 1; **size** raised the suggestion to 2, and the size is mostly added tests.
Observer-1 ruling ten (2026-08-21, topic 29723) declared this change tier 1, reasoning on the record:
the higher tier exists to force design convergence before code, and that convergence exists for this
change in the Window-22 causal map, the charter, and rulings eight through ten — mechanism proven,
predicted after-state stated, falsification condition stated. The ruling is void if the diff carries
new plumbing, a schema, config, or a protocol surface; it does not (one script, one test file).

This paragraph exists so the disagreement between the signal and the declaration is auditable rather
than suppressed.

## Evidence pointers

- 14/14 targeted tests pass: `npx vitest run tests/unit/decision-audit-presence-check.test.ts`
- Guard survey that identified the gap: `.instar/w22/branch-b-guard-ground-truth.md`
- Findings ledger entry 36: view `6e25dfa2-f374-409b-9e85-57aa210adfe0`

## Second-pass review

Concur with the review. I checked the artifact, docs/signal-vs-authority.md, and the actual git diff for the worktree: the diff is limited to scripts/decision-audit-presence-check.mjs and its unit test, and it changes the existing PR gate from per-entry record presence to exact in-scope-path coverage by the union of parsed scope.files. The over-block section is honest: absent, malformed, unreadable, different-file, and directory-only scopes now contribute no coverage and can reject the PR, while legacy JSONL still passes before coverage logic. The signal-vs-authority argument is sound because this is structural boundary validation over enumerable changed paths and declared record paths, not a judgment about message meaning or intent. I found no unmentioned behavioral surface in the diff and no new schema, config, protocol surface, or tier-voiding plumbing beyond local parsing/passing of the already-existing decision-record content.

Independent reviewer, 2026-08-21T01:10:23-07:00
