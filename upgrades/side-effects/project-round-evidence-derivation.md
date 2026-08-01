# Side-Effects Review — Project round evidence derivation

**Version / slug:** `project-round-evidence-derivation`
**Date:** `2026-07-31`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `not required`

## Summary of the change

`ProjectRoundDerivation.ts` makes evidence-bearing child initiatives the
authority for terminal round status. `GET /projects/:id` renders that derived
status, `/next` selects the first non-terminal derived round and emits
`repair-merge-evidence` for historical evidence holes, `/advance` supports a
validated same-stage re-attestation, and `ProjectRoundExecution` refuses to
respawn work for an evidence-empty row that already claims `merged`. The lazy
integrity read now selects those `merged` rows rather than the pre-merge
`building` stage.

## Decision-point inventory

- `deriveProjectRound` — add — deterministically decides whether member state earns a terminal conclusion.
- `GET /projects/:id/next` — modify — cached round status no longer authorizes a run; member derivation does.
- `ProjectRoundExecution.runRound` — modify — historical merged claims without evidence are unverifiable, not runnable.
- `POST /projects/:id/advance` — modify — a same-stage merged request can re-attest missing historical evidence through the existing validator.
- `GET /projects/:id` lazy integrity selector — modify — revalidates the evidence-bearing terminal stage it is documented to protect.

## 1. Over-block

A deliberately hand-edited `merged` row with no PR, commit, or verification
timestamp no longer permits its round to complete or run. That is intentional:
the row cannot distinguish completed work from a mistaken label. Legitimate
fresh items at `outline`, `approved`, or `building` remain runnable because the
runner distinguishes them from a row that already claims `merged`.

## 2. Under-block

An explicit `skipped` stage counts as terminal without revalidating the skip
reason fields. That preserves the existing skip contract and avoids turning
this merged-evidence repair into a new skip migration. Merge evidence is
structurally present but is not re-queried on every `/next`; the existing lazy
and periodic integrity checks remain responsible for later regression.

## 3. Level-of-abstraction fit

The pure derivation sits between durable member records and all consumers of a
round conclusion. It does not duplicate GitHub validation: the existing
`StageTransitionValidator` remains the artifact authority. The HTTP routes
consume derivation for read/next behavior, and the lower execution layer carries
the independent no-redo safety floor so direct invocation cannot bypass it.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this is hard-invariant structural validation, not conversational judgment.

The domain is enumerable: member missing, non-terminal, skipped, merged with
three fields, or merged with one or more fields absent. The validator, not a
brittle semantic detector, establishes the fields. No LLM judgment or message
classification is added.

## 4b. Judgment-point check

No competing-signals heuristic is added. Terminal status is a deterministic
invariant over typed member state; cached status is expressly a conclusion and
therefore cannot outrank the records that support it.

## 5. Interactions

- **Shadowing:** derivation runs after the lazy project integrity read, so any real regression found there is visible to it.
- **Double-fire:** the read path is pure and does not persist derived status; it cannot race another writer or fire work twice.
- **Races:** `/advance` keeps the existing child OCC write and project version bump. Re-attestation persists evidence in the same child write as the stage.
- **Feedback loops:** a repaired child causes the next read to derive completion; it does not enqueue work or recursively mutate the project.

## 6. External surfaces

Project API readers may see a round's displayed `status` differ from its stored
cache; `storedStatus` is included only when they differ. `/next` adds one action
verb and its evidence diagnostics. The existing `/project advance` skill is the
phone/conversation-completable repair surface; no new operator-only form, raw
shell workflow, external send, URL, or external-system write is introduced.

## 6b. Operator-surface quality

No dashboard or operator form is changed. The conversational skill presents a
named repair action and a concrete item command, while raw evidence field names
remain in the machine API for agent diagnosis.

## 7. Multi-machine posture

**Replicated:** project and child initiative records already use the Initiative
Tracker's existing replication/coherence path. Every machine derives the same
round result from the same replicated members; no new durable state exists.
The change emits no user-facing notices, holds no additional state that can
strand on topic transfer, and generates no URLs.

## 8. Rollback cost

Pure code and documentation change. Reverting it restores cached-status reads
and removes same-stage re-attestation. It creates no migration or new persisted
schema. Evidence attached through re-attestation uses existing fields and
remains valid after rollback.

## Conclusion

The review moved status correction to a pure read derivation and kept artifact
verification in the established validator. It also added a lower execution
floor because fixing `/next` alone would leave a direct-run bypass. The change
is bounded, reversible, and ready to ship with focused integration and unit
coverage.

## Second-pass review

Not required: this changes a deterministic project-state invariant, not
outbound messaging, session lifecycle, dispatch, or a gate/watchdog surface.

## Evidence pointers

- `tests/unit/ProjectRoundDerivation.test.ts`
- `tests/integration/projects-api.test.ts`
- `tests/unit/ProjectRoundExecution.test.ts`

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable. The trace carries an
explicit `unbounded-self-action` negative declaration because this change
narrows an existing runner's respawn behavior and adds no self-triggered action.
