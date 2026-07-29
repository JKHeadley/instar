# Side-Effects Review — Verify the State, Not Its Symbol review-check

**Version / slug:** `verify-state-review-check`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `Euler`

## Summary of the change

Adds the ratified P20 “Verify the State, Not Its Symbol” standard as a dedicated
integration-reviewer question in both the spec-converge skill declaration and
the template actually given to the reviewer. Every detector, metric, or gate
must declare its symbol, claimed state, independent corroboration, and
unmeasurable result. The reviewer contests the claim in both directions. A
contract-checked PostUpdateMigrator step surgically inserts the updated prompt
into existing installations at an exact unique anchor while preserving every
unrelated byte.

## Decision-point inventory

- Spec-converge integration-reviewer verdict — modified — gains a semantic
  evidence-quality question. The existing full-context reviewer keeps
  authority.
- Post-update installed-skill migration — added — deterministically decides
  whether an installed file lacks the exact hash-pinned bundled question and
  has one unambiguous insertion anchor.

## 1. Over-block

The reviewer can raise a material finding on a valid proxy relationship if it
misjudges causal independence or the least-harmful unknown direction. That
finding is review input, not a parser-level refusal: the author can supply the
missing evidence or close the finding with a written acceptance decision. The
prompt explicitly requires bidirectional contest rather than declaring all
strings, files, counts, or rates invalid.

The migration never performs a whole-file replacement. A stock-derived
customization retaining the exact unique insertion anchor receives the question
without losing its surrounding bytes. An unknown or ambiguous layout is
reported and left untouched.

## 2. Under-block

Customized installed spec-converge prompts are deliberately left untouched;
their owners must incorporate the standard themselves. The LLM reviewer can
also miss a subtle proxy relationship. This change does not add a deterministic
lint because the measured mechanical search produces clean false positives and
is not qualified to hold authority.

## 3. Level-of-abstraction fit

The integration reviewer already owns deployment, observability, and
cross-subsystem truth claims and already carries Standards A and B in this
shape. P20 belongs at the same full-context layer. The constitution and
lessons-aware reviewer remain the source principles; this question makes the
specific contest unavoidable without creating a parallel gate.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change adds no brittle blocking authority.

Strings, file checks, counts, rates, and any future static search remain
signals. The existing LLM integration reviewer sees the whole spec and holds
semantic authority over whether the evidence proves the state. The migration's
exact-line and unique-anchor checks govern mechanical insertion safety only, an
enumerable invariant; neither the heading nor a partial clause set can satisfy
them.

## 4b. Judgment-point check

No static heuristic is added at the evidentiary decision point. The new prompt
explicitly reserves the contested state-versus-symbol relationship for
full-context reviewer judgment.

## 5. Interactions

- **Shadowing:** the new question complements the lessons-aware P20 pass; it
  does not replace or suppress that reviewer.
- **Double-fire:** both reviewers may identify the same defect. The existing
  convergence synthesis groups duplicate findings.
- **Races:** post-update migration is synchronous and idempotent. It checks the
  installed file immediately before insertion and accepts only exact equality
  with the hash-pinned bundled question as the completed state.
- **Feedback loops:** a raised finding may cause a spec edit and another review
  round, which is the bounded convergence workflow already in place.

## 6. External surfaces

Existing agents with stock installed copies of the spec-converge skill receive
new reviewer instructions after update. New agents receive the bundled content
at install. Customized copies are reported as skipped. There is no new
operator action, dashboard surface, external API, message route, or persistent
application data.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**replicated.** The reviewer content ships in the package and is installed or
migrated independently on every agent machine. It holds no machine-local
runtime state, emits no user-facing notice, creates no URL, and cannot strand
durable work on topic transfer.

## 8. Rollback cost

Reverting the package source stops new installs from receiving the question,
but an existing installed skill that was already migrated retains the inserted
line. A fleet rollback therefore requires a compensating surgical migration
that removes the exact question line. No user data or application state needs
repair.

## Conclusion

The standard moves from general constitutional guidance to a dedicated,
judgment-bearing review question without granting authority to the mechanical
search that exposed the class. The separate migration contract closes
deployment parity for agents that already received Standards A/B, and applies
P20 to itself by verifying the exact hash-pinned bundled question instead of
trusting the heading symbol or a phrase-rich partial copy.

## Second-pass review

**Reviewer:** Euler
**Independent read of the artifact:** Concur with the review — exact-line
idempotence, pinned prompt hashes, unique-anchor insertion, and
preservation/refusal tests now verify the complete deployed prompt state
without overwriting custom content.

## Evidence pointers

- `tests/unit/PostUpdateMigrator-symbolStateReviewCheck.test.ts`
- `tests/unit/PostUpdateMigrator-threeStandardsReviewChecks.test.ts`
- Red proof: both bundled prompt checks and all migration checks failed before
  implementation.
- Green proof: the focused suites include a partial-prompt case whose heading
  exists while the evidentiary state does not, another case with every checked
  phrase except the required SYMBOL declaration, plus a stock-derived
  customization whose surrounding bytes must survive insertion.

## Class-Closure Declaration

No agent-authored-artifact defect — this adds a dedicated enforcement lens for
an already-ratified standard rather than repairing a malformed prompt instance.
