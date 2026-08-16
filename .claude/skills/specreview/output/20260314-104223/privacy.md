# Privacy & Ethics Review: Seed Migration Spec
**Spec**: seed-migration.md
**Reviewer**: Privacy & Ethics Specialist
**Date**: 2026-03-14
**Focus**: Identity coherence, knowledge exposure, user experience continuity

---

### Approval Status: CONDITIONAL

The spec is architecturally sound and the intent is responsible. The risks are real but addressable. Key conditions: resolve the agent-specific content boundary problem before Phase 5, implement access control on the capabilities-reference file, and add explicit informed consent for behavioral changes during live migration.

---

### Critical Issues

#### 1. Agent-Specific Instruction Leakage (HIGH)

The spec correctly identifies that Echo's "never use POST /feedback" rule is agent-specific — but then leaves the boundary question open ("Where's the line?" in Open Questions). This is not a deferred design question; it is an identity safety risk.

**The problem**: If Echo-specific behavioral overrides (like the anti-pattern against feedback API usage) are stripped from the seed template into a shared tree node, two failure modes emerge:
- **Contamination**: Other agents pull Echo's operational rules from a shared tree node and apply them incorrectly (e.g., a non-developer agent refusing to use the feedback API)
- **Deprivation**: Echo's seed, missing the override, defaults to the template behavior — which says use the feedback API. The agent loses a core behavioral boundary precisely because it trusted the tree

**Recommendation**: The spec needs an explicit category for "agent-specific behavioral overrides" that must live in the seed, not the tree. These are not capability docs — they are identity constraints. The test for inclusion in the seed is: "Would violating this rule cause the agent to act against its fundamental role?" If yes, it stays in the seed regardless of token cost.

#### 2. capabilities-reference.md Access Control (HIGH)

The spec defines a single file (`.instar/context/capabilities-reference.md`) as the authoritative source for all capability documentation — but says nothing about read/write permissions, who can modify it, or whether modification triggers any audit.

**The problem**: This file becomes the single point of truth for agent operational knowledge. If it can be modified by:
- A job running as the agent
- A sub-agent spawned to "help"
- A dispatch applying changes
- A compromised session

...then a bad actor (or a confused agent) could rewrite capability documentation in ways that alter agent behavior without touching CLAUDE.md. The agent would silently pick up the corrupted instructions from the tree on next query.

**Recommendation**:
- Store HMAC signatures for each section in the file (the spec already uses HMAC in the Playbook system — same pattern applies here)
- Log any write to capabilities-reference.md to the decision journal
- The upgrade script (Phase 4) should set this file's sections as read-only by default, requiring explicit unlock to modify
- The tree node validation (`GET /self-knowledge/validate`) should verify file section hashes on each startup

#### 3. Cross-Agent Tree Exposure (MEDIUM-HIGH)

Open Question #5 asks whether critical anti-patterns should stay in the seed or always be loaded at session start. Buried inside this is a more serious question the spec doesn't address: **Do all agents on the same machine share a single Self-Knowledge Tree?**

If yes: when one agent queries the tree for behavioral guidance, does the tree's LLM triage see the context from another agent's session? Could a query from AI Guy about "what are my anti-patterns" retrieve a node that was last refreshed by Echo's session with Echo-specific context contaminating the retrieval?

**The spec says zero about tree isolation between agents.** For a multi-agent deployment (Echo + AI Guy + test agent = 3 agents mentioned in cost table), this is not theoretical.

**Recommendation**: The spec must explicitly state whether the tree is per-agent or shared infrastructure. If shared:
- Tree nodes must be namespaced by agent identity
- LLM triage context must be stripped of any agent-session-specific information before cross-agent queries
- The test suite (Category 5: Cross-agent consistency) must include a cross-contamination test: "After Echo queries the tree, does AI Guy retrieve any Echo-specific content?"

---

### Recommendations

#### R1: Informed Behavioral Change Disclosure

The migration changes how agents retrieve behavioral guidance — from always-loaded to on-demand. This is a change to the agent's effective behavior profile that users have implicitly consented to through the existing CLAUDE.md. The new system could behave differently:

- An anti-pattern that previously loaded every session now loads only "when the agent is about to act." But the agent decides when that trigger fires. A subtle shift in trigger logic means users experience behavioral drift without knowing the rules changed.

**Recommendation**: The spec should include a "behavioral equivalence guarantee" section. Before Phase 6 (broad rollout), document what behavioral differences, if any, are expected between monolith and seed agents. If the intent is strict equivalence, say so explicitly and make it a success criterion. If some drift is acceptable, define the bounds.

#### R2: Test Agent vs. Real Agent Ethics

The spec correctly creates a dedicated test agent to prevent side effects on Echo and production agents. However, Category 3 tests (anti-pattern resistance) probe real behavioral failures: asking the agent to violate its own rules, fabricate, settle, etc.

These tests are ethically fine for a test agent — but the spec also says "Apply migration to Echo" in Phase 5. If Echo's behavioral tests run after migration but before full validation, Echo itself is being tested in a potentially degraded state while it's a production agent with real user relationships.

**Recommendation**: Phase 5 (Echo Migration) should be preceded by a "shadow mode" period where Echo's seed is active but its CLAUDE.md remains as a fallback that the agent can compare against. The behavioral divergence tests run in shadow mode, not in production mode. Only when shadow mode passes do you cut over.

#### R3: Upgrade Script Backup Verification

Phase 4 describes an upgrade script that backs up CLAUDE.md before migration. The spec says "backs up current CLAUDE.md" but doesn't specify what backup mechanism is used or how the backup is verified before proceeding.

**Recommendation**: The upgrade script must:
1. Create a backup via `POST /backups` (instar's native backup system, not just a file copy)
2. Verify the backup was created by checking `GET /backups` and confirming the snapshot appears
3. Only then proceed with migration
4. Store the snapshot ID in the upgrade log so rollback is a single command, not a search

#### R4: Proactive Capability Summary in Seed

Open Question #1 asks whether the seed should include a one-line-per-capability summary. From a user experience perspective, this is not a tradeoff — it's a requirement.

**The problem**: Without a capability summary, agents operating in degraded mode (tree down) lose all awareness of what features they have. The lookup table helps them find information, but only if they already know to look. An agent that doesn't know the Attention Queue exists can't look it up.

**Recommendation**: Include a compact capability manifest (~20 lines) in the seed. Growth concern is valid but manageable: add a style rule that new capabilities get exactly one line in the manifest (name + one-sentence purpose). This is not the same as the full documentation — it's awareness metadata. The tree provides details; the seed provides existence.

---

### Observations

**The "No Knowledge Loss" principle is well-scoped but underspecified for behavioral content.** The spec guarantees every section from CLAUDE.md has a home. But "home" for Tier 3 (behavioral) content needs a different fidelity test than Tier 2 (capability docs). A capability doc is correct if it contains the same information. A behavioral rule is correct only if it fires at the right moment with the right priority. The spec's content fidelity test (semantic equivalence) doesn't cover behavioral timing.

**The graceful degradation design is strong.** The layered fallback (tree → rule-based triage → seed lookup table → manual file reads) is a well-considered resilience model. This is the right architecture for a system that agents depend on for operational knowledge.

**The A/B comparison framework is the most ethically valuable part of the test suite.** Running identical prompts against monolith and seed configurations, graded by Haiku, gives genuine evidence of behavioral equivalence. This should be the primary gate for Phase 5, not a secondary check.

**The Threadline pointer in the seed is correctly classified.** Keeping just the capability pointer (not the full protocol) in the seed means agents know the network exists without needing to know how to use it until they're actually connecting. This is the right pattern for the seed/tree split — model it for other capabilities.

**Open Question #4 (one file vs. many) has a clear privacy answer.** Multiple small files are better from a least-privilege perspective: a tree node for publishing can only read the publishing section, not accidentally expose the security or permissions documentation adjacent to it in a single large file. The maintenance overhead of multiple files is real but smaller than the exposure surface of a monolith reference file.

---

### Research Findings

**No novel privacy vectors identified beyond those already in scope.** The existing instar infrastructure (HMAC for Playbook, backup system, rollback) provides the right primitives — the spec just doesn't apply them consistently to the new capabilities-reference file.

**The skip ledger pattern (mentioned in capabilities) is relevant to upgrade safety.** If the upgrade script uses the skip ledger to mark which agents have been migrated, a partial rollout can be safely paused and resumed without double-migrating any agent.

**The LLM-graded test evaluation creates a secondary privacy surface.** When Haiku evaluates whether an agent response is semantically equivalent to the expected answer, it sees: the test prompt, the agent's response, and the expected answer. If any of these contain sensitive content (e.g., a test that involves auth tokens, real user data, or internal architecture details), that content passes through Haiku. The test suite should use synthetic, non-sensitive content for all test cases.

---

### Scalability Assessment

The seed/tree architecture scales better than the current monolith in every dimension the spec measures (token cost, growth trajectory, multi-agent deployment). The cost table shows a 65% reduction in per-session token cost and a stable growth trajectory — both accurate given the design.

One unmodeled scalability risk: **the capabilities-reference.md file becomes a new monolith.** At 650 lines of Tier 2 content plus however many Tier 3 behavioral sections, this file will grow at the same rate as CLAUDE.md did before. The difference is that agents only load sections on demand — but the file itself needs maintenance discipline. Without it, in 12 months the reference file is 2,000 lines and harder to navigate than the original CLAUDE.md.

**Recommendation**: Apply the Playbook lifecycle model to capabilities-reference.md sections: usefulness scoring, decay for sections never queried, and a periodic audit that flags sections that haven't been retrieved in 30 days. Structure creates discipline; discipline prevents the new system from becoming what it replaced.

---

### Score: 7/10

**Strong architectural foundation, meaningful token savings, and a responsible test-before-rollout philosophy.** The conditional score reflects three unresolved issues that must be addressed before production deployment: the agent-specific content boundary is under-specified in a way that creates identity drift risk; the capabilities-reference file lacks the access control that the Playbook system already applies to analogous content; and tree isolation between agents on the same machine is never addressed despite a multi-agent deployment being the stated target. None of these are blockers to starting Phase 1-3 (which are additive and low-risk), but all three must be resolved before Phase 5.
