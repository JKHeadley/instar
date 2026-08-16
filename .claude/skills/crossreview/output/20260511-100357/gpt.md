# Cross-Model Review — GPT (gpt-5.4)

**Document**: PROJECT-SCOPE-SPEC.md (iteration 2)
**Reviewer**: GPT (alias `gpt`, model `gpt-5.4`)
**Date**: 2026-05-11
**Run ID**: 20260511-100357

## Summary

- **Score**: 8/10
- **Verdict**: CONDITIONAL
- **Material new issues found**: Yes (4 critical; clustered around state-model completeness and distributed-consistency semantics; not a flood)
- **Headline**: Iteration 1 concerns are largely addressed. Remaining blockers are narrow: undefined `paused`/`awaitingUser` states, git-sync field-level merge that undermines OCC, underspecified `claim-ownership`, and round-start authority split across multiple paths without a single canonical state machine.

---

## Raw Response

## 1. Overall Assessment
- **Score**: 8/10
- **Status**: CONDITIONAL

This rewrite is materially stronger than the prior version and clearly addresses most of the iteration-1 concerns called out in your prompt: auth is now explicit on `/projects/*`, signal-vs-authority is clarified, stage transitions are artifact-bound, OCC is present, ownership exists for multi-machine, path jails are specified, first-launch ack is added, and halt/kill-switch behavior is substantially better defined. I do **not** see a large volume of new issues. The remaining concerns are narrower but still material: a few state-model inconsistencies, one dangerous multi-machine conflict-resolution gap that can undermine OCC/ownership guarantees, and a couple of places where authority is still partially under-specified at key transitions. So: close, but not yet unconditional approval.

---

## 2. Critical Issues (Must Fix)

### Issue 1: State model is internally inconsistent (`paused` / `awaitingUser` used but not defined)
- **What**: The spec repeatedly transitions rounds/projects into states or fields that are not present in the declared schema.
  - `rounds[].status` only allows: `pending | ready | in-progress | partially-complete | complete`
  - But later sections say reconciler marks rounds `paused`, halt/restore flows surface `awaitingUser`, and threat model / success criteria also rely on pause semantics.
  - `awaitingUser` is referenced multiple times but is not defined on `Initiative` or project-only fields.
- **Why it matters**: This is not editorial; it creates implementation ambiguity in the exact places meant to be safety-critical: post-restore, partial-complete, regressed, and pause-after-two-unacked-advances. Different components could encode these conditions differently, causing broken gating, UI mismatch, or silent auto-advance when a project should be blocked.
- **Suggested fix**: Normalize the state model:
  - Add explicit project-level status and/or round-level status values including `paused`, `halted`, maybe `awaiting-user`.
  - Add a typed `awaitingUser?: { reason: ..., since: ..., details?: ... }` field if this is a first-class surfaced condition.
  - Update all gates, API responses, dashboard rendering, and reconciler logic to consume the same canonical state fields.
- **Section reference**:
  - Phase 1.1 (`rounds[].status`)
  - Phase 1.2 (`surface via awaitingUser`)
  - Phase 1.5 (`Surface as awaitingUser`)
  - Phase 1.11 (`marks them paused with awaitingUser`)
  - Phase 1.13 (`downgraded to paused, awaitingUser populated`)
  - Threat model / Success criteria (`project paused`, `returns 412 until user resumes`)

---

### Issue 2: Git-sync conflict resolution undermines OCC and ownership guarantees
- **What**: The spec introduces OCC (`If-Match`, version increments, 409 on mismatch), but then separately defines git-sync conflict resolution as:
  - last-writer-wins on `status` and `rounds[i].status`
  - union on `sourceDocs`
  - max on `version`
  - max on `unacknowledgedAdvanceCount`

  This is dangerous because `version` is being merged by `max`, not as a linearized source of truth, and status fields are being merged independently of the validated mutation path that OCC is supposed to protect.
- **Why it matters**: This can create impossible states after sync:
  - Machine A and B both mutate based on version 7.
  - Both write version 8 with different semantic changes.
  - Git-sync merges to version 8 (max), but with one side's `rounds[i].status` and maybe the other side's related fields missing.
  - Now the record appears current, but no client ever observed or reconciled the semantic conflict.

  That breaks the core safety claim of P4 and can also violate P5 ownership if a stale non-owner write wins via file merge.
- **Suggested fix**: Pick one authority model:
  1. **Preferred**: declare the server/API as sole mutator and git-sync replicas as transport only; project records must not be field-merged semantically by git. On conflict, mark record conflicted and require reconciler/manual repair.
  2. If git-level merge must exist, define a proper operation log / tombstone / monotonic event stream, not field-wise LWW + max(version).

  At minimum, remove `max on version` and forbid automatic merge of ownership/status-critical fields.
- **Section reference**:
  - P4 Optimistic concurrency
  - Phase 1.12 (`Git-sync conflict resolution`)
  - Threat model (`Concurrent writes lose user PATCH under runner`, `Two machines fire auto-advance`)

---

### Issue 3: Ownership claim endpoint is specified but not secured by concurrency/authority rules
- **What**: `POST /projects/:id/claim-ownership` appears in Phase 1.12, but it is not listed in the endpoint table, and no preconditions/OCC semantics are defined for it. It is also not clear whether it requires `If-Match`, whether it validates owner liveness against a persisted heartbeat, or whether claiming is blocked during active lock/TaskFlow presence.
- **Why it matters**: Ownership is load-bearing for preventing duplicate auto-advance and round execution across machines. An underspecified claim path is a direct hole in that guarantee. A machine could incorrectly seize ownership during transient git-sync lag or while the original owner is still active but heartbeat visibility is stale.
- **Suggested fix**: Fully specify `claim-ownership`:
  - Add it to the endpoint list.
  - Require `If-Match`.
  - Define exact liveness proof source and heartbeat freshness threshold.
  - Require no active round lock / no live TaskFlow / or explicit fencing token semantics.
  - Return 409/412 when claim preconditions fail.
- **Section reference**:
  - Phase 1.12 (`Leader election ... may claim ownership via POST /projects/:id/claim-ownership`)
  - Missing from Phase 1.3 endpoint table

---

### Issue 4: Round-start/advance authority is still split across endpoints without a single normative state machine
- **What**: The spec says `POST /projects/:id/advance` can "advance one item one stage OR the active round," while `/project run-round` also starts a round by delegating to `/autonomous`, and auto-advance polling can fire round pre-flight directly. The actual authoritative transition for `round.status` and ownership assignment is therefore spread across multiple paths without one canonical transition table.
- **Why it matters**: Safety properties depend on all start paths enforcing the exact same checks:
  - first-launch ack
  - drift verdict freshness/acceptability
  - approved-or-later for all items
  - halt status
  - ownerMachineId
  - unacknowledgedAdvanceCount
  - active lock absence

  If one path omits one check, the system can bypass the intended gate.
- **Suggested fix**: Add a normative "Round State Machine" section:
  - Enumerate allowed round transitions and the single function/module that performs them.
  - Make `/advance`, `/run-round`, and auto-poller all call the same server-side transition.
  - Explicitly state which endpoint is allowed to set `round.status = in-progress`, `complete`, `partially-complete`, `paused`, `halted`.
- **Section reference**:
  - Phase 1.3 (`/advance`)
  - Phase 1.5 (runner lifecycle)
  - Phase 1.7 (`/project run-round`)
  - Phase 1.12 (ownership/auto-advance)

---

## 3. Strengths

1. **The signal-vs-authority separation is much improved**
   - P1 is clear and consistently repeated.
   - The drift checker is demoted to signal, while authority depends on artifacts and deterministic checks.
   - This directly fixes a common LLM-gate anti-pattern.

2. **Artifact-bound transitions are now concrete and testable**
   - Phase 1.2 is one of the strongest parts of the spec.
   - The edge table makes transitions auditable.
   - Requiring verifiable repo artifacts and rejecting with 409 is a good discipline.

3. **Persistence and crash semantics are thoughtfully handled**
   - P3 and the reconciler behavior are solid improvements.
   - Persisted `autoAdvanceAt`, startup reconciliation, and lock cleanup show good operational thinking.

4. **Security posture is materially better**
   - Auth on all endpoints.
   - Path jail with realpath + symlink escape checks.
   - Prompt hardening and JSON-schema validation for drift checker.
   - Dashboard text rendering via `textContent`.
   - Session-start sanitization.

5. **The spec addresses forgotten deferred work structurally**
   - Registering out-of-scope items as child initiatives is a strong anti-forgetting mechanism.
   - This is a smart response to the actual root problem.

6. **Good attention to partial completion and regressions**
   - "Never mass-advance" is the right call.
   - `regressed` state plus reconciler is a practical safeguard against reverted/invalid merged assumptions.

---

## 4. Gaps & Missing Elements

### A. No canonical definition of project-level status
The spec uses concepts like halted, paused, active, awaiting user, first-launch-pending-ack, but only partially encodes them. There should be an explicit project state model separate from round state.

### B. `DELETE /projects/:id` archive semantics are underdefined
The endpoint says "archives the project," but delete semantics, recoverability, effect on timers/ownership/locks, and whether active rounds must be halted first are not specified. This is especially important because delete is not just cosmetic if timers or auto-advance exist.

### C. `GET /projects/:id` causing lazy reconciler writes is a side-effectful read
The spec says merged-state reconciler runs on GET (lazy). That means a read can mutate state. This is sometimes acceptable, but it should be explicit in API semantics and likely should still obey concurrency/fencing rules. Otherwise dashboards or hooks can trigger writes unexpectedly.

### D. Drift verdict freshness at round start is not fully explicit
There is caching and rerun-on-hash-change, but the gate does not clearly define whether a stale cached `no-drift` older than some threshold is acceptable for starting a round when files have not changed. TTL exists for cache reuse, but authority should state what freshness is required at round start.

### E. Locking model is per-machine file lock, not obviously cross-machine safe
The spec relies on `ownerMachineId` for cross-machine coordination, which is good, but `.instar/round-runner.lock` is per-machine only. That's fine if ownership is always authoritative, but then ownership fencing must be stronger than currently specified. As written, the local lock may create false confidence.

### F. Child membership mutation semantics remain a little loose
`parentProjectId` mutation validation checks that parent rounds contain the child, but the spec does not fully define whether moving items between rounds is allowed after creation, and if so under what conditions. That matters for auditability and gate correctness.

---

## 5. Industry Comparison

### Compared to existing solutions
This sits somewhere between:
- a lightweight portfolio/epic tracker,
- a CI-aware workflow engine,
- and an agent-orchestration control plane.

It is more artifact-grounded than many AI-agent planning systems, which is good. Most agent frameworks fail exactly where this spec is strong: they treat model outputs as authority and lack durable lifecycle state. This spec avoids that.

### Compared to best practices
Strong alignment with best practices in:
- **stateful workflow orchestration**: persisted timers, reconciliation, explicit gating
- **secure LLM integration**: untrusted content delimiting, schema validation, signal-only outputs
- **deployment safety**: merged SHA verification, CI checks, regression detection

Weaker alignment in:
- **distributed systems correctness**: the git-sync merge strategy is not compatible with strong OCC semantics
- **API design**: side-effectful GET and underspecified ownership-claim path
- **formal state modeling**: multiple implied states without a single state machine

### Anti-patterns avoided
- LLM as sole gatekeeper
- in-memory timers for critical workflow
- silent summarization under token pressure
- mass-advancing items without per-item evidence

### Anti-patterns still present
- field-wise conflict resolution on shared mutable state
- incomplete canonical state machine
- read endpoints with mutation side effects

---

## 6. Scalability Assessment

### Phase 1 (MVP, 10-50 users): Will it work?
Yes, likely. For a local/small-scale single-agent environment, this is implementable and should materially improve reliability over the current tracker. The architecture is modest and appropriately leverages existing infra.

### Phase 2 (Growth, 50-500 users): What breaks?
- Git-sync as shared-state substrate becomes increasingly fragile.
- 15s dashboard polling and lazy GET reconciliation can create noisy write/read amplification.
- Drift-check spend cap and mutexing may become bottlenecks across many active projects.
- Ownership/heartbeat semantics need to be formalized to avoid duplicate execution.

### Phase 3 (Scale, 500-5000 users): Architecture changes needed?
Yes.
- Move from git-merged JSON ledger semantics to a proper transactional store or append-only event log.
- Replace field-level merge rules with server-authoritative state transitions.
- Introduce distributed locks/fencing tokens for runner ownership.
- Likely separate read models (dashboard) from reconciliation writers.

### Spike handling: What happens under sudden load?
- Hook budgets and caching help.
- Drift checks degrade reasonably via budget cap and `manual-review-required`.
- Biggest risk under spike is contention and inconsistent state, not raw CPU: multiple machines or clients hitting stateful endpoints while git-sync races can produce semantic conflicts.

---

## 7. Recommendations (Prioritized)

1. **Define a canonical project/round state machine**
   - Add explicit statuses (`paused`, `halted`, `awaiting-user`, etc.) and one normative transition table used by all code paths.

2. **Remove or radically tighten git-sync field-level conflict resolution**
   - Do not auto-merge ownership/status/version-critical fields. Treat conflicts as reconciliation events, not silent merges.

3. **Fully specify `claim-ownership`**
   - Add endpoint contract, OCC requirements, liveness proof, fencing behavior, and active-run exclusion rules.

4. **Make round start a single server-side authority path**
   - Ensure manual start, auto-advance, and resume all call the same transition function and enforce identical preconditions.

5. **Clarify side-effectful read and archive semantics**
   - Either move lazy reconciliation off `GET` or explicitly document it; define `DELETE/archive` preconditions and effects on active rounds/timers/locks.

---

### Bottom line

This is a strong revision. I do **not** see a fresh flood of material issues; the prior major weaknesses appear largely addressed. The remaining blockers are concentrated in **state-model completeness** and **distributed consistency semantics**. If those are tightened, this would move to APPROVE.

---

## Brief Analysis (Echo synthesis)

**Convergence signal**: Positive. GPT explicitly affirms iteration 1 issues are addressed and characterizes the remaining work as narrow, not a flood. Score jumped to 8/10 CONDITIONAL — one step shy of APPROVE.

**The 4 critical findings cluster into two themes**:

1. **Distributed-consistency hygiene** (Issues 2 + 3, gaps D/E): Git-sync field-level merge contradicts OCC; `claim-ownership` underspecified; round-runner lock is per-machine only. These are real and they share a root cause — the spec treats git-sync as a passive transport but defines field-wise merge rules that can silently overwrite OCC-protected state. Fix path: declare server as sole semantic mutator; treat git-merge conflicts on these fields as reconciliation events.

2. **State-machine completeness** (Issues 1 + 4, gaps A/B/F): `paused`, `awaiting-user`, `halted` are used in prose but not in the declared enums; round-start authority is split across `/advance`, `/run-round`, and the auto-poller without one canonical transition table. Fix path: add a normative "Round State Machine" section with the full enum and a single server-side transition function all entry points call.

**Side issues worth folding in**:
- `GET /projects/:id` triggering lazy reconciliation is a side-effectful read — should be moved off GET or explicitly documented.
- `DELETE /projects/:id` archive semantics underdefined w.r.t. active rounds/timers.
- Drift-verdict freshness threshold at round-start (not just cache TTL) needs a normative statement.

**No new security findings** beyond what iteration 1 covered. The hardening work landed.

**Recommended action for next iteration**: Two additions to the spec resolve most of GPT's CONDITIONAL items —
1. A "Round State Machine" section with the full enum (`pending | ready | in-progress | partially-complete | complete | paused | halted | awaiting-user`) and a single canonical transition function.
2. A rewrite of Phase 1.12's git-sync conflict resolution that removes field-wise merge on OCC-protected fields and instead flags conflicts for reconciler review.

Plus three smaller clarifications (claim-ownership endpoint contract, GET side-effect documentation, DELETE preconditions).
