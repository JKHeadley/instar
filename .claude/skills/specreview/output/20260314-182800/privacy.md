# Privacy & Ethics Review: Seed Migration Spec (Round 2)
**Spec**: seed-migration.md (v2, post-review)
**Reviewer**: Privacy & Ethics Specialist
**Round**: 2
**Date**: 2026-03-14
**Prior Review**: 20260314-104223

---

### Round 2 Assessment

The revised spec is substantially improved. All three critical issues from Round 1 received explicit, substantive responses — none were dismissed or deferred. The spec now has a coherent position on agent-specific content (identity test), tree isolation (per-agent scope), and content integrity (HMAC at the file level, consistent with Playbook). The previously-open questions are now locked decisions with clear rationale.

One new issue warrants attention: the shadow mode in Phase 5 creates a 24-hour window where the agent is running in a partially-migrated state that exposes behavioral comparison data to the tree's LLM triage path. This is minor but worth noting.

The spec is ready to proceed. The remaining open questions (operator observability, multi-machine sync, token budget enforcement, evolution interaction) are genuinely lower priority and do not block Phase 1-4.

---

### Round 1 Issues Resolution

| Issue | Status | Notes |
|-------|--------|-------|
| **1. Agent-Specific Instruction Leakage (HIGH)** | RESOLVED | The spec now defines an explicit "identity test" for seed inclusion: "Would violating this rule cause the agent to act against its fundamental role?" Agent-specific overrides satisfying this test stay in the seed, injected from AGENT.md at scaffold time — not hardcoded in the template. The contamination and deprivation failure modes are both addressed: contamination is prevented by keeping overrides out of shared tree nodes; deprivation is prevented by keeping them in the seed unconditionally. The Tier 1 table now includes an explicit "Agent-Specific Overrides" row (~10 lines). This is the correct resolution. |
| **2. capabilities-reference.md Access Control (HIGH)** | RESOLVED | The spec abandoned the single monolith reference file entirely in favor of individual per-capability files. HMAC integrity is now specified at the file level (cleaner than per-section), with signatures stored in `context/.integrity.json`. The Content Integrity section specifies: sign on write, verify on read (fail closed), include HMAC in git sync. The verification failure behavior — serve nothing, log security event, fall back to manual lookup — is exactly what was recommended. The Phase 4 scaffold creates the integrity manifest automatically for new agents. |
| **3. Cross-Agent Tree Exposure (MEDIUM-HIGH)** | RESOLVED | The spec now explicitly states: "Each agent on a machine has its own tree configuration and context files within its own `.instar/context/` directory. There is no shared tree state between agents." The cache scope is per-agent. The remaining open question about multi-machine sync (Q2 in Remaining Open Questions) is acknowledged as deferred — appropriately, since it doesn't affect single-machine isolation. The cross-agent consistency test in Category 5 now validates that Echo, AI Guy, and a test agent all work independently after migration. |

---

### New Issues

#### N1. Shadow Mode Behavioral Comparison Data (LOW)

Phase 5 includes a 24-hour shadow validation period where the agent logs "what the tree would serve vs. what the monolith had" for comparison. This is good engineering — but the spec doesn't specify where these logs are stored or who can read them.

The shadow comparison log will contain:
- The agent's live query strings (which reveal what the agent was working on)
- The content the tree would have served (which reveals the agent's operational context)
- Differences between tree and monolith outputs (which reveal gaps in tree coverage)

If this log is written to a location accessible to the tree itself (e.g., inside `.instar/`), a compromised tree node could, in theory, read its own shadow-mode comparison data and use it to craft responses that look more similar to the monolith output on subsequent queries — a form of self-optimization that bypasses the test.

**Recommendation**: Shadow comparison logs should be written outside the tree's data directory (e.g., `tests/seed-migration/shadow-{date}.log`) and should not be queryable via tree search. This is a low-severity concern because the window is 24 hours and the scenario requires a compromised tree, but it's worth specifying explicitly.

#### N2. LLM-Graded Test Data Privacy (ACKNOWLEDGED FROM R1, NOW ELEVATED)

The spec retains Haiku as the LLM grader for behavioral tests. Round 1 noted this in Research Findings but didn't make it a formal issue. The spec now defines specific test prompts (e.g., "There's a bug in the job scheduler," "Deploy the latest changes") that could reveal internal architecture to the grading LLM. For most of these prompts this is acceptable — they're intentionally generic. But the A/B comparison framework uses the agent's actual responses, which may contain specific internal details (endpoint URLs, auth patterns, config file paths).

**Recommendation**: Before the test suite runs, add a content filter that strips or replaces actual auth tokens, file paths outside the project, and any dynamically-retrieved user data from responses before they're sent to the Haiku grader. The evaluation is about behavioral pattern, not specific values — the grader doesn't need real endpoint URLs to assess semantic completeness.

---

### Remaining Observations

**The Behavioral Equivalence Guarantee is now implicit but not explicit.** Round 1 recommended a "behavioral equivalence guarantee" section stating whether strict equivalence or bounded drift is the goal. The spec resolves this indirectly via the test suite (same-task A/B comparison, anti-pattern resistance, LLM-graded evaluation) and the success criterion "Anti-pattern resistance maintained — behavioral tests pass at same rate." This is functionally equivalent to the recommendation, though a one-sentence explicit statement ("The seed model must produce behaviorally equivalent outcomes to the monolith for all test categories") would clarify intent.

**The shadow mode in Phase 5 is the single most valuable addition to the spec.** Running seed and monolith in parallel for 24 hours before cutover, then comparing what would have been served, is a genuine behavioral equivalence test in a production context. This is the right way to validate that no critical knowledge is missing from the tree before committing to the migration.

**The Resilience Mode behavior table is comprehensive and well-specified.** The "corrupt tree config → attention queue, awaiting human confirmation" behavior is particularly good: it prevents an auto-regeneration loop from a compromised AGENT.md while ensuring the agent doesn't silently degrade. This is the correct ethical stance — an agent that can't verify its own config should escalate to human review, not attempt self-repair.

**The upgrade rollback procedure is now clear and executable.** The Phase 5 sequence (backup → extract → replace → regenerate → shadow → validate) gives a single command for rollback at each step. The success criteria include upgrade testing on 3+ agents — this is the right validation gate before broad rollout.

---

### Updated Approval Status: APPROVE

The three critical issues that produced the Round 1 CONDITIONAL rating are all resolved. The two new issues (N1, N2) are LOW severity and do not block deployment — they can be addressed during Phase 3 (test suite development) without blocking Phases 1-2. The spec is ready to proceed to implementation.

**Phases 1-3 can begin immediately.** These are additive (context files, tree config, test suite) and non-destructive. Phase 4 (scaffold template) and Phase 5 (Echo migration with shadow mode) should proceed only after Phase 3's test suite passes — which the spec already specifies as the gate.

---

### Updated Score: 9/10

The spec earned a substantial upgrade from 7 to 9. The three critical issues were resolved correctly and with the right level of specificity — not hand-waved, but with explicit mechanisms (identity test, per-file HMAC, per-agent tree scope). The previously-open questions now have locked answers with clear rationale. The test suite is comprehensive, the cost model now accounts for triage overhead with explicit measurement gates, and the rollback path is executable.

The one point held back reflects the two new low-severity issues (shadow log isolation, LLM test data privacy) and the absence of an explicit behavioral equivalence guarantee statement. These are polish items, not blockers — but a 10/10 requires no outstanding items.
