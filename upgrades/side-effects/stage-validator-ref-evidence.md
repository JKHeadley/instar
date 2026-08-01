# Side-Effects Review — Canonical repository evidence for project stage validation

**Version / slug:** `stage-validator-ref-evidence`
**Date:** `2026-08-01`
**Author:** `instar-codey`
**Second-pass reviewer:** `Codex independent reviewer (stage_validator_review)`

## Summary of the change

Project stage transitions now read specs and convergence reports from one
immutable snapshot of the live canonical-main head instead of the branch checked out at
`targetRepoPath`. `src/core/StageTransitionContext.ts` becomes the single
production assembly point for canonical repository identity/freshness resolution, the repository-blob reader,
GitHub PR reader, and merge-ancestry helper. `StageTransitionValidator` retains
the stage authority but distinguishes exact absence from unverifiable evidence
and loud wiring failure. The Projects API route delegates context assembly to
that factory. Tests cover stale-checkout reads, exact absence, non-regular Git
entries, incomplete wiring, and the real route.

## Decision-point inventory

- **Spec existence and frontmatter gate** (`StageTransitionValidator`) —
  **modify** — reads one regular blob from the request's canonical-main OID and refuses only an
  exact absence as `SPEC_FILE_MISSING`; an unreadable evidence source has a
  distinct unverifiable verdict.
- **Convergence-report gate** (`StageTransitionValidator`) — **modify** — reads
  the report from the same canonical ref as its spec and refuses symlink, tree,
  and submodule entries as unverifiable rather than filesystem evidence.
- **Merged-PR gate** (`StageTransitionValidator`) — **pass-through** — retains
  the existing GitHub and merge-ancestry checks while sharing the same
  `canonicalMainRef` field used by the spec gates.
- **Production dependency completeness** (`StageTransitionContext`) — **add** —
  assembles every validator dependency in one factory, resolves GitHub through
  an absolute launchd-safe binary path, selects a fork's parent repository,
  queries the live remote head, and throws a typed wiring error if assembly is incomplete.

---

## 1. Over-block

An artifact that exists only as an uncommitted or branch-only working-tree file
is no longer accepted by the live Projects API. That is intentional: project
stage state is durable and shared, so the claimed evidence must exist on the
canonical ref rather than on whichever checkout happens to serve the request.
Git symlinks, trees, and submodules at an artifact path are also refused even if
they ultimately expose markdown bytes; only regular blobs qualify as durable
spec evidence. No other legitimate input shape was identified.

---

## 2. Under-block

The reader performs a read-only live remote-head query but does not fetch
objects during an API request. If the live head's object is not already present
in the local object store, validation is explicitly unverifiable until normal
repository synchronization catches up. A repository whose canonical branch is
not named `main` is likewise unverifiable under this Project Scope contract.
This change also deliberately does not invent verification
for `taskFlowRecordId`, because no TaskFlow store exists in this subsystem; the
approved-to-building gate still checks only that an identifier is present.

---

## 3. Level-of-abstraction fit

The Git plumbing belongs in a production context factory, while the validator
owns stage-domain meanings such as missing, unverifiable, and approved. One
reader returning text or exact absence replaces the prior split existence and
frontmatter filesystem reads, eliminating time-of-check and evidence-world
drift. The route now supplies project inputs to the factory rather than
reimplementing infrastructure dependencies beside domain fields.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design. Brittle detectors must not own block authority.

None of those message-judgment boxes describes this authority. The stage gate
is the document's explicit hard-invariant exception: it verifies enumerable
artifact facts, not conversational meaning or inferred intent. Exact Git-tree
absence, a regular-blob mode, deterministic frontmatter fields, and merge
ancestry are valid structural blockers. The change reduces false authority by
separating “absent” from “could not inspect” and never lets an infrastructure
refusal masquerade as a domain fact.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic is added at a competing-signals decision point. Repository
entry type, exact absence, YAML fields, and Git ancestry are enumerable
invariants named by the approved Project Scope spec. There are no competing
liveness, ownership, recency, or urgency signals to arbitrate inside this gate.

---

## 5. Interactions

- **Shadowing:** markdown/frontmatter validation runs only after the canonical
  blob is read. An unreadable ref cannot be shadowed by a misleading missing or
  malformed-spec verdict.
- **Double-fire:** the factory is called once per advance request and performs
  read-only Git/GitHub operations; no adjacent component acts on the read.
- **Races:** one live `ls-remote` result is memoized as an immutable commit OID
  for the request. Both `ls-tree` and `cat-file` resolve content-addressed
  objects from that snapshot, so spec and report checks cannot span moving heads.
- **Feedback loops:** no state is written by evidence resolution. Successful
  validation feeds the existing Initiative Tracker update exactly once.
- **Existing merge gate:** PR state and merge ancestry retain their prior
  behavior, but the ancestry ref and artifact ref now come from the same
  context field.

---

## 6. External surfaces

The Projects API can now advance an item whose spec is present on live canonical main
but absent from the serving checkout. Failures caused by unavailable Git
evidence return a distinct 409 unverifiable code; missing production wiring is
a 500 wiring error rather than a plausible project refusal. Existing successful
response shapes and persisted project records do not change. No external API is
mutated, no new database or ledger is introduced, and no user-facing notice or
operator action is added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design:** each machine confirms the same remote head but reads
the Git object store belonging to the project's configured local repository,
because object availability is machine-specific. The durable project stage
continues to use the existing Initiative Tracker replication behavior; this
change creates no new durable state. It emits no user-facing notices, so
one-voice gating is not needed, and it generates no URLs. On topic transfer, no
new state can strand because the only new operation is a read against the target
repository configured for the serving machine.

---

## 8. Rollback cost

This is a pure code and documentation change. Rollback is a revert followed by
a patch release. There is no data migration, no agent-state repair, and no
credential or external-system cleanup. During rollback propagation, stale
checkouts would again produce false missing-spec refusals; no durable data would
be corrupted.

---

## Conclusion

The review found one intentional compatibility boundary: branch-only draft
files no longer qualify as durable project-stage evidence. The independent pass
also found and drove three corrections before trace signing: canonical resolution
moved inside the factory and off bare `gh`; live remote freshness now resolves to
one immutable OID; and factory construction moved inside the route's structured
error boundary. Central assembly plus exact absence/unverifiable
separation closes the observed split-world wiring class without expanding into
the unrelated TaskFlow-store gap. The required independent second pass concurs;
the change is clear to ship.

---

## Second-pass review (if required)

**Reviewer:** Codex independent reviewer (`stage_validator_review`)
**Independent read of the artifact:** Concur with the review.

All three initial concerns are resolved: canonical resolution is factory-owned
and launchd-safe; live remote main is pinned to one immutable OID while failures
remain unverifiable; and factory construction is inside the structured wiring
error boundary. Path safety and exact-absence semantics remain sound.

---

## Evidence pointers

- Live before-state from the mentor report: item 7 returned
  `SPEC_FILE_MISSING` even though its spec existed on local `origin/main` and in
  none of the 39 checked-out worktrees.
- `tests/unit/StageTransitionContext.test.ts` proves the canonical blob is read
  after the checked-out file is removed and distinguishes exact absence.
- `tests/unit/StageTransitionValidator.test.ts` proves missing wiring and
  unverifiable evidence cannot become `SPEC_FILE_MISSING`.
- `tests/integration/projects-api.test.ts` exercises the production factory
  through the actual Projects API route.
- Focused validation: 109 tests green; package completeness: 7 tests green;
  build, lint, release-fragment validation, and pre-push gate green.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller change — not applicable.
