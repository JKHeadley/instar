# Side-Effects Review — /verify-claim Skill

**Source:** Cherry-pick from GSD-Instar spike (gsd-verifier 4-level protocol)
**Author:** Echo · autonomous run · 2026-05-23

## 1. Over-block
N/A — a prompt skill, blocks nothing. Worst case: the agent runs a few extra grep/test commands before claiming done. That's the intended cost.

## 2. Under-block
The skill is advisory — an agent could skip invoking it. Mitigation: it's wired into the recommended /build Phase 3 flow and the "before claiming shipped" trigger. Not a hard gate (that would be the e2e-pairing pre-commit hook + response-review). This is the verification METHODOLOGY made callable; enforcement lives elsewhere.

## 3. Level-of-abstraction fit
A user-invocable skill alongside the other built-in skills in installBuiltinSkills(). Same inline-content pattern, same install mechanism, same idempotency guarantee.

## 4. Signal-vs-authority compliance
N/A in the gate sense — it's a methodology the agent runs. It PRODUCES signals (the per-level status), and the agent (authority) acts on them. Aligned with the spike's whole verdict: import the methodology, let the agent wield it.

## 5. Cross-feature interactions
- Complements the e2e-pairing pre-commit gate (that enforces an e2e test FILE exists; this verifies a claim is actually wired). Different layers, no overlap.
- Complements response-review (Stop hook). /verify-claim is invoked DURING work; response-review checks the outbound message.
- Referenced from /build Phase 3 VERIFY as the per-must-have check.
- Pure additive skill — no existing skill changes.

## 6. Rollback cost
Trivial. One entry in the installBuiltinSkills record + one test file. Revert the commit; the skill stops being installed for new agents. Existing agents that already have the SKILL.md keep an inert copy (harmless).

## 7. Migration parity
Adding a NEW skill needs no migration per the Migration Parity Standard: installBuiltinSkills() is called from refreshHooksAndSettings() on every update and is non-destructive (only writes missing SKILL.md files). Existing agents get verify-claim on their next update. Idempotency verified in the test (does not overwrite a customized copy).

Note: a follow-up should add /verify-claim to the CLAUDE.md template's capability list (Agent Awareness Standard) so agents surface it conversationally — tracked, not blocking this PR.

## Conclusion
Ship. The spike's #1 cherry-pick by leverage. Pure additive prompt skill, trivial rollback, no migration needed. Seven-dimension review clean.
