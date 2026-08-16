# DX / API Design Review: Coherence Gate — Round 3

**Reviewer**: Developer Experience Specialist
**Spec**: specs/response-review-pipeline.md
**Round**: 3 (prior: Round 2 score 8.0/10)
**Focus**: Round 2 P1 resolution + new additions

---

## Approval Status: APPROVE

## Score: 8.5/10 (+0.5 from Round 2)

---

## Assessment of New Additions

### PEL — Transparent to Operators
The PEL uses the same feedback format as LLM reviewers (line 134: `POLICY VIOLATION` category). This means operators see PEL blocks in the same review history, same stats endpoints, same audit log. No separate system to learn. The only difference is the category name, which is self-explanatory.

PEL blocks appearing in the attention queue with "Your response contains what appears to be an API key. Remove it before sending." is actionable and clear.

### Failure Mode Differentiation — Clear Mental Model
The 6 failure classes (lines 811-824) give operators a clear mental model of what happens when things go wrong. Each class has defined behavior for both external and internal channels. This is much better than a generic "it failed, good luck" response.

The key UX insight: retry exhaustion on accuracy/alignment holds for operator review, while tone issues auto-deliver. This means operators only get pulled in for high-impact decisions, not every tone tweak.

### Governance Endpoints — Good API Design
The new governance endpoints follow the existing API conventions:
- `GET /coherence/proposals` — list proposals (consistent with `GET /jobs`, `GET /feedback`)
- `POST /coherence/proposals/:id/approve` — approve action (consistent with REST conventions)
- `POST /coherence/proposals/:id/reject` — reject with reason
- `GET /coherence/health` — health dashboard (consistent with `/review/health`)

The attention queue integration for pending proposals means operators don't need to poll — they're notified proactively.

### Per-Recipient Review History — Useful for Debugging
Adding `recipientId` to review history and per-recipient-type breakdown to stats helps operators understand patterns:
- "Messages to external contacts fail tone review 40% of the time"
- "Agent-to-agent messages are clean but messages to secondary users frequently flag"

Query parameters `?recipientId=Z` on `/review/history` (line 1339) follow the existing filter pattern.

### Context Window Management — Invisible to Operators
The collapse format for retry feedback is entirely internal — operators don't see it. This is correct. The only operator-visible impact is that revision cycles produce cleaner feedback chains in the audit log.

### Semantic Evasion Detection — Useful Signal
The evasion rate in `/review/stats` (line 1349) gives operators a new dimension to monitor: "Is this agent consistently paraphrasing to evade rather than genuinely fixing issues?" This is a signal that the agent's behavior patterns need attention, not that the pipeline is broken.

---

## Testing Experience (Updated)

The test endpoint (`POST /review/test`, lines 716-753) now implicitly supports testing:
- PEL checks (test a message with a credential pattern)
- Recipient-type behavior (pass different `recipientType` in context)
- Per-reviewer model overrides (test messages against Sonnet vs Haiku)
- Information leakage reviewer (test agent-to-agent messages)

The CLI wrapper recommendation from Round 2 (`instar gate test "message" --channel telegram`) would make all of this more accessible. Still recommended.

---

## Operator Workflow Assessment

The spec defines a clear operator workflow for the organic evolution system:

1. **Agent detects complaint** → logs incident (automatic, no operator action)
2. **Agent proposes patch** → attention queue item (operator notified)
3. **Operator reviews proposal** → API call or dashboard action
4. **Operator approves/rejects** → patch activated or logged with reason
5. **System tracks outcomes** → health metrics show improvement (or not)

This is a lightweight workflow. The operator's job is triage, not engineering — they're reviewing proposals, not writing patches. Good.

### Auto-Approve Option
For operators who want less friction, `autoApproveRisk: "low"` delegates low-risk decisions to the system. The default (no auto-approve) is safe. This is progressive disclosure — simple by default, configurable for power users.

---

## Remaining Recommendations

### 1. CLI Wrapper (Repeated from Round 2)
`instar gate test "message" --channel telegram --recipient-type external-contact` would significantly improve the testing and debugging workflow. Wraps the API endpoints. Medium effort, high impact.

### 2. Example Custom Reviewers (Repeated from Round 2)
Ship example custom reviewers in `.instar/reviewers/examples/` — brand voice, formality check, etc. Gives operators a template to work from.

### 3. Coherence Gate Dashboard Tab (Repeated from Round 2)
A dashboard view showing: recent reviews, reviewer health, patch proposals, evasion rates, per-recipient patterns. This would make the entire system visible without API calls.

---

## Summary

The DX additions in Round 3 are clean. PEL is transparent to operators. Governance endpoints follow existing conventions. Per-recipient review history adds useful debugging dimensions. The operator workflow for organic evolution is lightweight and progressive.

The spec is ready for implementation from a DX perspective. The CLI wrapper and dashboard tab remain valuable Phase 2 additions.
