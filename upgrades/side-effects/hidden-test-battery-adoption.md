# Side-Effects Review — hidden-test-battery-adoption (docs-only)

**Change:** appends one section — "The Hidden-Test Battery (regression
tripwires)" — to `docs/apprenticeship/PROGRAM-CONCEPTS.md`, recording the
operator-approved (2026-07-18) mechanism generically: undisclosed regression
tripwires over already-valued behaviors, scored retrospectively as one
necessary-not-sufficient input to ladder promotions, disposable, guardrailed.
Plus the standard artifacts (this review, the ELI16, the release fragment).
**No source, config, template, hook, job, or test files are touched.**
Documentation-only, no runtime surface.

## Phase 1 principle check (recorded)

Does this change involve a decision point? **No.** The section describes an
evaluation discipline whose verdicts are produced by humans (operator/overseer)
in retrospective review; it ships no validator, gate, sentinel, scorer, or any
code that evaluates anything. Signal-vs-authority is not implicated: nothing
here can block, allow, or judge — and the described mechanism itself is
explicitly bounded to "can block a rung, never earn one", a human-held
authority outside this repo's runtime.

## 1. Over-block

Nothing can be over-blocked: documentation-only, no runtime surface. The change
introduces no blocking surface of any kind — no CI check, no gate, no hook. The
described discipline explicitly forbids gating day-to-day work on tripwire
results, and even that prohibition is prose, not enforcement.

## 2. Under-block

Nothing can be under-blocked: documentation-only, no runtime surface. No
enforcement is promised by this change, so there is no enforcement to be
incomplete. If the battery discipline is ever mechanized (a scenario registry,
a scoring surface), that work arrives with its own spec and its own review.

## 3. Level-of-abstraction fit

Right layer. The mechanism is a program-level concept, and
`docs/apprenticeship/PROGRAM-CONCEPTS.md` is exactly the canonical home for
operator-ratified program framings (it already holds five). The section stays
generic by design — no concrete scenario, no agent name, no organization
specifics — because scenario content is operator-held and undisclosed by the
mechanism's own rules; putting scenarios in a public repo doc would break the
mechanism it documents.

## 4. Signal vs authority compliance

Compliant vacuously: documentation-only, no runtime surface. The change creates
no authority (nothing blocks) and no signal (nothing observes). The documented
mechanism is itself shaped by the signal-vs-authority principle — tripwire
results are a signal into a human promotion decision, never an authority that
gates work — but describing that shape is not implementing it.

## 5. Interactions

None at runtime: documentation-only, no runtime surface. No job, sentinel,
route, or hook reads this file. Repo-level interactions are benign: the new
section closes the "bounded adoption" left open by the same file's concept 5
(evaluation cautions), and coexists with it — concept 5 records the caution,
the new section records the adopted mechanism that satisfies it.

## 6. External surfaces

None: documentation-only, no runtime surface. No API route, no config key, no
message to any user, no notification, no npm-shipped runtime change (the file
rides the package inertly as documentation). The section was deliberately
written mechanism-only for this public repo — it names no scenario, agent,
person, or organization.

## 7. Multi-machine posture

**Unified-via-git.** The document is a repo-tracked file; every machine sees
the same content at the same SHA. No per-machine runtime state is created, so
there is nothing to strand, sync, or reconcile.

## 8. Rollback cost

Revert the doc (one revert of this commit). No data migration, no agent state,
no config, no deployed-behavior change to unwind. Cheapest possible rollback
class.

## Second-pass review

**Not required.** The second-pass trigger is for changes that wire block/allow
decisions, session-lifecycle, messaging, or dispatch behavior — this change
wires nothing: documentation-only, no runtime surface, no decision point, no
enforcement. There is no code for a second reviewer to contradict against the
artifact; the only reviewable claim ("the section says what the ELI16 and
fragment say it says") is verified by reading the three files side by side.
