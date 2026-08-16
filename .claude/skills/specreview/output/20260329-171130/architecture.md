# Architecture Review: GitHub Collaboration Monitor (Sentinel)

**Review ID**: 20260329-171130
**Round**: 2
**Reviewer Role**: Systems Architect
**Spec Version**: Revision 2 (2026-03-29)
**Prior Synthesis**: 20260329-153418

---

## Approval Status

**CONDITIONAL APPROVE** — Score: 8.5 / 10

Round 2 spec represents a substantial and coherent revision. All four P0 architectural issues from Round 1 have been addressed. The decisions made are architecturally sound, not just checkbox-filling. The remaining concerns are refinement-level, not blockers.

---

## What Changed (Round 1 → Round 2)

| Issue (Round 1) | Resolution in Round 2 | Quality |
|-----------------|----------------------|---------|
| Handoff schema undefined | JSON schema with $schema, validation rules, re-verification requirements | Strong |
| No Opus cost ceiling | maxReviewsPerRun + maxTokenEstimate + pre-spawn estimation | Strong |
| Stage 2 outputs shell commands | Structured JSON output + deterministic action executor | Correct |
| Review dismiss+repost gap | PATCH /reviews/{id} edit in-place | Correct |
| Prompt injection undefended | Three-layer defense (system prompt + delimiters + Haiku pre-check) | Strong |
| Token scope too broad | Read token / write token separation | Strong |
| Handoff trust boundary unvalidated | Stage 2 re-verifies ciStatus + touchesSecurityPaths independently | Good |

---

## Component Boundary Analysis

### Stage 1 (Scanner / Haiku) — Boundaries Are Clean

The spec correctly constrains Stage 1 to classification-only output. It produces a JSON array, passes it via handoff notes, and never executes write operations. The pre-flight checks (auth, rate limit) are positioned correctly — they run before any scan work, not as an afterthought.

**One concern**: Stage 1 also spawns the Stage 2 sub-session (via `POST /sessions`). This means Stage 1 has two responsibilities: (1) classify, and (2) orchestrate. For MVP this is acceptable, but it creates a coupling point. If Stage 1's Haiku session is compromised or produces a manipulated classification, it also controls whether Stage 2 runs. This is noted but not a blocker — the Stage 2 re-verification requirement mitigates it.

### Stage 2 (Reviewer / Opus) — Boundaries Are Correct

The decision to have Stage 2 output structured JSON instead of shell commands is the architecturally correct call, not just a security improvement. It cleanly separates the LLM reasoning layer from the execution layer. The "deterministic action executor" concept — parsing Stage 2's JSON and then running `gh` commands — is the right pattern for any LLM-driven pipeline where you need auditability and safety gates.

The re-verification step (Stage 2 independently re-checks `ciStatus` and `touchesSecurityPaths` from the GitHub API before acting) correctly treats the Stage 1 handoff as untrusted input. This is a sound architectural choice: no component in the pipeline should blindly trust its upstream.

### Action Executor (Implicit)

The spec describes a pattern — Stage 2 JSON → action executor → gh CLI — but never explicitly names or specifies the action executor as a component. This is a gap. The action executor is where the write token lives, where merge decisions get executed, and where the audit log gets written. If it's just "the calling code," that's ambiguous in ways that matter for security and error handling.

**Recommendation**: Make the action executor an explicit architectural component in the spec, even if it's a small function. Define what it accepts (Stage 2 JSON), what it outputs (GitHub API calls + audit log entries), and what its error behavior is (fail closed, not fail open).

---

## Handoff Schema Assessment

The `handoff-v1` schema is well-designed for its purpose. Key strengths:

- **`$schema` version field**: Schema versioning from day one is correct. When this schema evolves, Stage 2 can reject incompatible versions rather than silently misbehaving.
- **`scanTimestamp`**: Including the scan timestamp enables Stage 2 to detect stale handoffs (e.g., if Stage 2 is delayed and the handoff is from a scan cycle ago, it can note this context).
- **`headRefOid`**: Including the commit SHA in the handoff allows Stage 2 to verify it's reviewing the right commit, not a commit that was pushed after Stage 1 scanned.
- **`touchesSecurityPaths` as boolean**: Clean. Stage 2 re-verifies it anyway, so the boolean is an optimization (skip re-verification if false from a trusted context), not a decision-maker.

**One design question**: The handoff schema has `items` as a flat array. If Stage 1 also wants to pass metadata (e.g., "I skipped 12 items due to cost ceiling," "rate limit was at 150 when I scanned"), there's nowhere to put it. The `scanTimestamp` is there, but a `metadata` object would be more extensible. Not a blocker, but worth considering before v1 is frozen.

**Validation rules are correct**:
- Reject unknown `$schema` — prevents forward-compatibility surprises
- Enforce `maxReviewsPerRun` at schema parse time — cost ceiling is enforced at the boundary, not inside Stage 2 logic
- Re-verify critical fields — Stage 2 is not trusting Stage 1's assessment of security-sensitive state

---

## Cost Ceiling Architecture Assessment

The two-layer cost ceiling is well-designed:

**Layer 1 — Item count**: `maxReviewsPerRun` (default: 5) caps the number of Opus invocations. Simple, predictable, easy to reason about.

**Layer 2 — Token estimate**: `maxTokenEstimate` (default: 200K) caps total token exposure. The estimation formula (4 tokens × diffLines) is rough but directionally correct for a ceiling — you want to be conservative and err toward not spawning, not toward spawning and hitting a surprise limit.

**What happens when the ceiling is hit**: Stage 2 is not spawned; items are queued; Justin is notified with a count and estimated token load. This is the correct behavior — fail visible, not fail silent.

**One gap**: The spec says "remaining items stay unprocessed and are picked up on the next scan." But skip ledger composite keys include the commit SHA — if no new commits arrive, the items WILL be in the skip ledger and will NOT be re-picked up. This is a latent bug: cost-ceiling-overflow items that haven't changed since the last scan will be silently deduped by the skip ledger and never processed.

**Fix**: Items that hit the cost ceiling must NOT be added to the skip ledger. They should be held in a separate "pending review" state. The spec already handles this correctly for `ci-pending` items (don't add to skip ledger). The same logic needs to apply to cost-ceiling-overflow items.

---

## Review Edit API Assessment

Using `PATCH /repos/{owner}/{repo}/pulls/{number}/reviews/{review_id}` for in-place edits is the correct call. The Round 1 synthesis identified this resolution, and the spec has implemented it cleanly.

Architectural implications:
- Stage 2 needs to persist the `review_id` from its initial review post, so it can PATCH on subsequent commits. The spec doesn't explicitly say where this is stored.
- The skip ledger composite key (`pr-{number}-{headRefOid}`) handles re-triggering when new commits arrive, but the `review_id` lookup needs to survive between Stage 2 invocations.

**Recommendation**: The audit log (`.instar/logs/github-review-decisions.jsonl`) should include `reviewId` in each entry. Stage 2 can look up the prior review by querying the audit log for `prNumber`. This avoids a separate state store for review IDs while making the audit log the single source of truth for PR review state.

---

## Data Flow Assessment

```
GitHub API (read-only token)
  └── Stage 1 (Haiku)
        ├── Skip Ledger (dedup)
        ├── Relationships API (trust lookup)
        └── Handoff Notes (validated JSON)
              └── Stage 2 (Opus)
                    ├── GitHub API (read-only token, re-verify)
                    ├── Haiku pre-check (injection detection)
                    └── Structured JSON output
                          └── Action Executor
                                ├── GitHub API (write token: PATCH review, merge)
                                ├── Audit Log (.instar/logs/)
                                └── Telegram notification
```

This data flow is clean. The write token is correctly isolated to the action executor at the end of the pipeline. The read token is used by both Stage 1 and Stage 2, which is appropriate — read operations are low-risk and re-verification requires independent reads.

**One observation**: The Haiku pre-check for injection detection runs inside Stage 2, not before Stage 2 is spawned. This means Stage 2 (Opus) is already running when the injection check happens — the check gates whether Opus processes the diff, but Opus has already been invoked. For the cost ceiling, this is fine. For injection defense, it means Opus is briefly exposed to the potentially-injected content before the Haiku check runs. This is an acceptable architecture choice (the check is the first thing Stage 2 does), but worth documenting explicitly in the spec.

---

## Technical Debt Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Cost-ceiling items silently deduped by skip ledger | High (it's a latent bug) | Medium — items never get reviewed | Fix skip ledger logic for overflow items |
| Action executor undefined as component | Medium | Low at MVP, grows as pipeline complexity increases | Explicitly spec the component |
| `review_id` persistence not specified | Medium | Low — edge case if audit log is queried | Add reviewId to audit log schema |
| Stage 1 as both classifier and orchestrator | Low at MVP | Medium if Stage 1 is compromised | Acceptable for Phase 1, document for v2 |
| Handoff schema missing `metadata` field | Low | Low | Extensibility concern, not a bug |
| Haiku pre-check runs inside Stage 2, not before spawn | Low | Low — architectural defense-in-depth question | Document clearly |

---

## Critical Issues

**None that block deployment.** The P0 issues from Round 1 are resolved. One latent bug (cost-ceiling-overflow items in skip ledger) should be fixed before first production scan because it would cause silent review gaps.

---

## Recommendations

**Must Fix Before First Scan**:
1. **Cost-ceiling-overflow items must not be added to the skip ledger.** They should be held in a "pending review" queue analogous to how `ci-pending` items are handled. Otherwise, items that overflow the cost ceiling on scan N will be silently dropped on scan N+1 if no new commits arrive.

**Should Address in Implementation**:
2. **Persist `review_id` in the audit log.** Add `"reviewId": "..."` to the `github-review-decisions.jsonl` schema. Stage 2 uses this when deciding whether to POST a new review or PATCH an existing one.

3. **Make the action executor an explicit component.** Give it a name, a responsibility definition, and specify its error behavior. "Fail closed" means: if the action executor encounters an unexpected Stage 2 output schema, it logs and notifies rather than attempting to execute partial actions.

**Nice to Have**:
4. **Add a `metadata` object to the handoff schema** for Stage 1 to report operational context (items skipped, rate limit at scan time, cost-ceiling overflow count). Enables Stage 2 and the audit log to have richer context without schema breaking changes.

5. **Consider noting in the spec** that the Haiku injection pre-check runs as the first operation inside Stage 2, and that this is intentional — Opus is invoked but processes no diff content until Haiku clears it.

---

## Score

| Dimension | Round 1 | Round 2 | Change |
|-----------|---------|---------|--------|
| Component boundary clarity | 6 | 8 | +2 |
| Data flow integrity | 5 | 9 | +4 |
| Security architecture | 4 | 9 | +5 |
| Cost control | 3 | 8 | +5 |
| Handoff design | 4 | 8.5 | +4.5 |
| Error handling | 6 | 7 | +1 |
| Operational controls | 7 | 9 | +2 |
| **Overall** | **7/10** | **8.5/10** | **+1.5** |

The architectural improvements in Round 2 are substantive. The handoff schema, structured JSON output, token separation, and cost ceiling together form a coherent security and cost architecture that is appropriate for production use. The remaining gaps are implementation-level details, not design flaws.

---

*Architecture review by SpecReview agent. Round 2. 20260329-171130.*
