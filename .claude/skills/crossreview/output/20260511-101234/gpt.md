# Cross-Model Review — GPT

- **Model**: gpt-5.4
- **Document**: PROJECT-SCOPE-SPEC.md (iteration 3 rewrite)
- **Iteration**: 3
- **Timestamp**: 2026-05-11 10:12:34
- **Prompt file**: `/tmp/crossreview-gpt-20260511-101234-prompt.txt`
- **Caller**: `node .claude/skills/crossreview/call-llm.cjs --model gpt --max-tokens 4000`

## Headline

- **Score**: 9/10
- **Verdict**: APPROVE
- **Material new issues**: NONE
- All four iter-2 critical items (state-model completeness, distributed consistency vs OCC, lazy reconciler side-effects, DELETE-vs-active-rounds) confirmed addressed.

## Raw Response

## 1. Overall Assessment

- **Score**: **9/10**
- **Status**: **APPROVE**

This iteration is materially stronger than iter-2 and, importantly, it closes the four previously critical concerns in a convincing way: the state model is now substantially complete, git-sync conflict handling no longer undermines OCC, lazy reconciler side-effects are bounded and specified, and DELETE-vs-active-round semantics are explicit. I do **not** see any **material new issues** introduced by this rewrite. What remains are mostly implementation-risk and operational-clarity items rather than spec-level blockers. The document is now coherent, internally cross-referenced, and much more disciplined about authority boundaries, ownership, and failure recovery.

---

## 2. Critical Issues (Must Fix)

**None.**

I do **not identify any material new must-fix issues** in this iteration.

---

## 3. Strengths

### 3.1 The prior critical concerns are genuinely addressed
- **State-model completeness** is much improved:
  - Canonical project status is defined.
  - Round statuses are enumerated.
  - Regression, partial completion, failure, pause, halt, and reconciliation states are all represented.
  - Section refs: **Phase 1.1, 1.2, 1.5, Migration, Threat model**.

- **Distributed consistency** is now much safer:
  - You explicitly reject silent field-wise merge on git-sync conflict.
  - Losing-side writes are surfaced into `awaitingReconciliation`.
  - Auto-advance is blocked while reconciliation is pending.
  - Section refs: **P4, Phase 1.12, Threat model**.

- **Lazy reconciler side-effects** are now constrained and documented:
  - `GET /projects/:id` may trigger lazy merged-state revalidation, but it is debounced and mirrored by a periodic job.
  - Regression semantics are explicit and tied to round rollback.
  - Section refs: **Phase 1.2, Surface, Success criteria**.

- **DELETE/archive semantics** are now explicit:
  - `DELETE /projects/:id` refuses if any round is `in-progress`; halt first.
  - Section ref: **Phase 1.3**.

### 3.2 Strong signal-vs-authority discipline
This is one of the best parts of the spec. The drift checker is clearly demoted to a signal source, and round start authority is tied to verifiable artifacts and deterministic checks. That sharply reduces the common anti-pattern of letting LLM output directly authorize workflow transitions.
- Section refs: **P1, Phase 1.4, Threat model**.

### 3.3 Artifact-bound transitions are unusually well specified
The transition table is concrete, testable, and tied to artifacts that can actually be checked. The squash/rebase handling via `mergeCommit.oid` is especially good and shows practical awareness of real GitHub workflows.
- Section refs: **P2, Phase 1.2, tests/integration/squash-merge.test.ts**.

### 3.4 Multi-machine ownership model is much more credible now
The combination of:
- machine-local lock,
- synced heartbeat,
- ownerMachineId,
- stale-owner claim protocol,
- commit/push/wait/re-read handover safety,

is a solid pragmatic design for a git-synced environment without introducing a full distributed coordinator.
- Section refs: **P5, Phase 1.5, 1.12, 1.13**.

### 3.5 Round runner is now a proper chokepoint
You corrected a classic workflow bug by centralizing all round-start checks in `ProjectRoundRunner.preflight()`. That reduces bypass risk across HTTP, skill, and auto-advance paths.
- Section refs: **Phase 1.3, 1.5, Success criterion #11**.

### 3.6 Good attention to operational failure modes
The spec is unusually strong on:
- stale PID recovery,
- post-restore reconciliation,
- timeout behavior,
- idempotency keys,
- partial completion handling,
- forced resume after retry cap.
- Section refs: **P3, Phase 1.5, 1.8, 1.11, 1.13, Threat model**.

### 3.7 Security posture is thoughtful for this class of system
Particularly good:
- path jail + realpath + symlink escape checks,
- safe YAML parsing,
- cache sanitization at write and read,
- no CORS,
- structured JSON validation for LLM output,
- explicit prompt hardening.
- Section refs: **Phase 1.4, 1.6, 1.9, Threat model**.

---

## 4. Gaps & Missing Elements

These are **not material blockers**, but they are the main residual gaps I see.

### 4.1 Minor terminology inconsistency around `awaiting-user` vs `awaitingUser`
The canonical project status enum is `awaiting-user`, but several sections refer to "`awaitingUser` populated" as if it is a field rather than a state/message bucket.
- Examples:
  - **Phase 1.2**: "surface via `awaitingUser`"
  - **Phase 1.5**: "Surface as `awaitingUser: ...`"
  - **Phase 1.11**: "`awaitingUser: 'round was in-progress...'`"
This is not conceptually harmful, but it creates implementation ambiguity: is there a distinct `awaitingUser` field, or should these become `status: 'awaiting-user'` plus a reason/message field?

### 4.2 Round/item mutation authority could be slightly sharper
You state the round runner is the only writer of round-status during an active round, but some user actions can still mutate item stages mid-round (`skipped`, `outline`) and the runner responds dynamically. That's fine, but the spec could be slightly clearer about which item-stage mutations are allowed while a round is `in-progress`, and which are forbidden.
- This is mostly a policy clarity issue, not a missing mechanism.
- Relevant sections: **P4, Phase 1.5, success criteria #25/#26**.

### 4.3 Cost-cap semantics are intentionally non-atomic cross-machine, but operator expectations should be highlighted more
You document this honestly, which is good. Still, because the spec says "per-agent ceiling" while also admitting worst-case `N machines x $1/day`, operators may over-read the guarantee. This should probably be called out more prominently in the API or admin docs, not just in the drift section.
- Section refs: **Phase 1.4, Non-goals, deferred items**.

### 4.4 Some read-path side effects remain non-ideal, even if now acceptable
`GET /projects/:id` can still cause state mutation via lazy merged-state reconciliation. You've bounded it enough that I no longer consider it a critical design flaw, but it remains a non-pure read path and should be implemented carefully to avoid surprising clients or introducing hidden contention.
- Section ref: **Phase 1.2**.

### 4.5 Plan-doc reparse behavior on existing children could use one more sentence of conflict policy
You say re-parsing updates the project record + children idempotently without duplicates. Good. But if a child initiative already progressed beyond `outline`, it would help to state explicitly which fields the parser may update and which it must never overwrite.
- Otherwise, "idempotent update" can be interpreted too broadly.
- Section ref: **Phase 1.6**.

---

## 5. Industry Comparison

### 5.1 Compared to existing solutions
This sits somewhere between:
- a lightweight portfolio/epic tracker,
- a spec-governed workflow engine,
- and a local-first/git-synced orchestration layer.

It is more rigorous than ad hoc "epics + checklists" in tools like Linear/Jira/Notion because:
- transitions are artifact-bound,
- merge verification is structural,
- drift is explicit,
- ownership and reconciliation are defined.

It is less infrastructure-heavy than systems that would solve this with:
- a central DB,
- durable queue,
- distributed locks,
- workflow engines like Temporal/Airflow/Argo.

For the stated environment, that tradeoff is reasonable.

### 5.2 Alignment with best practices
Strong alignment with:
- **optimistic concurrency control**
- **single chokepoint for business invariants**
- **idempotent event/send semantics**
- **signal vs authority separation**
- **fail-closed validation on state transitions**
- **machine-local locks plus shared ownership metadata**
- **post-crash reconciliation over in-memory timers**

These are all good patterns.

### 5.3 Anti-patterns avoided
The rewrite explicitly avoids several dangerous anti-patterns:
- LLM output directly authorizing transitions
- field-wise merge on shared state under OCC
- in-memory timers for durable workflow transitions
- using PR head SHA as merge truth in squash workflows
- relying on a synced lockfile for distributed exclusion

That's a meaningful improvement.

### 5.4 Remaining tradeoffs vs "industry-grade" orchestration
Compared to a fully centralized workflow/orchestration platform, this spec still accepts:
- eventual consistency via git-sync,
- non-atomic cross-machine cost caps,
- read-triggered reconciliation,
- file-based coordination.

Those would be questionable at larger scale, but are acceptable for the current scope.

---

## 6. Scalability Assessment

### Phase 1 (MVP, 10-50 users)
Yes, it should work well for the intended scale, and likely with margin. The design is optimized for a small number of active projects, low mutation rates, and a single principal operator with occasional multi-machine execution. The file-backed digest and OCC approach are sufficient here.

### Phase 2 (Growth, 50-500 users)
This starts to strain if "users" means many simultaneous projects/machines rather than just human viewers.
Likely pressure points:
- git-sync conflict frequency
- reconciliation burden
- periodic scans / lazy revalidation overhead
- lock/ownership operational complexity
- append-only ledgers and JSON file growth
- dashboard polling if project counts rise significantly

At this stage, a stronger event log or central state store would become attractive.

### Phase 3 (Scale, 500-5000 users)
This architecture would need substantial evolution:
- central durable store instead of JSON/git-sync as canonical coordination
- explicit job queue / workflow engine for round execution
- centralized distributed locking / leases
- push-based updates instead of polling
- separate read and write paths with clearer event sourcing
- stronger observability and audit indexing

The current design is not intended for that scale, and the spec mostly acknowledges that implicitly.

### Spike handling
Under sudden load:
- drift-check spend cap helps protect LLM cost
- mutexes and OCC prevent some corruption
- dashboard polling at 15s is conservative
- file-first hooks are cheap

But spikes in concurrent mutations across machines would increase:
- 409s,
- reconciliation events,
- ownership transfer races,
- git-sync merge pressure.

For current scope, acceptable.

---

## 7. Recommendations (Prioritized)

1. **Normalize `awaiting-user` semantics into a single explicit model**
   - Add a dedicated field like `attentionReason?: string` or `awaitingUserReason?: string`, and stop using `awaitingUser` informally in prose.
   - Keep `status: 'awaiting-user'` as the canonical state.
   - This removes implementation ambiguity.

2. **Specify parser overwrite rules for re-imported plan docs**
   - State exactly which child/project fields a re-parse may mutate and which are immutable once workflow has progressed.
   - Example: parser may update title/source metadata/round membership, but must not downgrade `pipelineStage` or clear PR metadata.

3. **Clarify allowed mid-round item mutations**
   - Define which stage transitions are allowed while a round is `in-progress` (e.g. `approved -> skipped`, maybe `skipped -> outline` forbidden until halted, etc.).
   - This will reduce edge-case ambiguity around runner stop-condition recomputation.

4. **Document read-side reconciliation behavior as "may mutate" in API contract**
   - Since `GET /projects/:id` can trigger lazy reconciliation, state this explicitly in endpoint docs and client expectations.
   - That avoids surprise for consumers and preserves observability clarity.

5. **Elevate the non-atomic multi-machine spend-cap caveat**
   - Keep the current implementation, but make the "worst-case N machines x $1/day" limitation more visible in operator/admin documentation so it is not mistaken for a true global cap.

---

### Final verdict

**No material new issues found.**
**Score: 9/10**
**Verdict: APPROVE**

## Brief Analysis (Echo's notes)

- **Convergence signal**: APPROVE with zero material new issues. Score moved 8 -> 9 vs iter-2. This is a strong convergence signal for cross-model agreement; once Gemini and Grok land, if both also report no new material issues, the spec converges.
- **Residual items are all clarifications, not blockers**:
  - `awaitingUser` field vs `awaiting-user` status — naming/shape ambiguity in prose vs schema. Cheap fix: add `attentionReason?: string` to the schema and rewrite prose references.
  - Mid-round item mutation policy — table of allowed/forbidden transitions while round is `in-progress`.
  - Plan-doc reparse overwrite rules — explicit immutability list for fields beyond `outline`.
  - `GET /projects/:id` "may mutate" notice in API contract docs.
  - Cross-machine cost cap caveat — elevate to admin/API docs, not just drift section.
- **All five recommendations are doc/clarity-grade**, addressable in the same PR without architectural change. None gate APPROVE.
- **Validation of iter-2 corrections**: GPT explicitly cites the corrected items (P4 reconciliation-event semantics, P2 squash-merge `mergeCommit.oid`, single-chokepoint runner preflight, DELETE-active-rounds refusal, bounded lazy reconciler) as strengths — confirms the rewrite landed the intended changes.
