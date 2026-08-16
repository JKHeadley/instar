# External cross-model review — round 14 (codex-cli:gpt-5.5)

Spec: docs/specs/grok-build-framework-integration.md
Status: ok · Verdict: SERIOUS ISSUES

Disposition:
1/2/5. **Structure, phase scope, and "minimize surface" — DECIDED, fifth round.**
   The normative-contract section (round-11) plus the Phase A acceptance section
   (round-13) are this spec's answer; splitting the document conflicts with the
   repo's spec convention, and the title is accurate for what the BRANCH does —
   the threading is real and lands here, while Phase A is what is LIVE. The
   reviewer's underlying observation is correct and is now stated in the spec
   itself rather than argued away: the file count measures Phase B threading, not
   Phase A capability.
3. **CLI-vs-API decision table — DECLINED as scope, with the reasoning already
   present.** §0.5 records the rejection and round-12 tightened its language to
   "locally token-bounded and valued conservatively at public list rates", which
   is the honest form of the claim the reviewer is testing. A fuller table would
   not change the decision: the operator's goal is an agent that RUNS on grok,
   and the API path cannot deliver that at all.
4. **Graduation language vs the admitted fail-open — FOLDED, and it was a real
   internal contradiction.** The maturation plan said the daily ceiling is "never
   silently exceeded" while §8 says the ledger is per-machine and fails open on
   lock acquisition. The criterion now says no breach goes UNRECORDED, with the
   note that the stronger guarantee arrives with the append-only records. A
   graduation bar must not assert a property its own section disclaims.

---

**Verdict: SERIOUS ISSUES**

1. **Normative clarity is still too non-local (§“Current normative contract”, §§0-14).**  
   Source says “read this first” but also “where it and a later section disagree, the later section governs.” Observation: this forces implementers to scan the whole audit trail to know the current contract. Concrete resolution: split the spec into a short normative Phase A contract plus an appendix audit log, or make a single requirements matrix authoritative with no later-section override rule.

2. **Phase scope is muddled (§1, §5, §Acceptance for THIS increment).**  
   Source says “In scope” includes session launch, quota/accounts, pool surfaces, and ~48 files, while acceptance says Phase A ships only one-shot reviewer and explicitly not sessions, internal routing, ACP, or production pool enrolment. Observation: the document still reads like a framework integration spec while accepting a reviewer adapter. Concrete resolution: rename/scope this as “Phase A: Grok one-shot reviewer adapter” and move Phase B threading/session work into a separate spec or clearly non-shipping appendix.

3. **The API alternative is under-argued given the billing uncertainty (§0.0, §0.5).**  
   Source says billing sink is unknown and every run must be budgeted as metered; §0.5 rejects the xAI API because CLI showed 17%-of-list and no visible charge. Observation: if operations must budget as metered anyway, the CLI path’s complexity, mutable login policy, invisible quota, and self-updating binary need a more explicit tradeoff against the simpler API path. Concrete resolution: add a decision table comparing CLI vs API on billing certainty, operational risk, confinement, quota visibility, and implementation size.

4. **The local budget ledger is a fragile spend brake (§8).**  
   Source says the ledger is “not accounting,” per-machine, fail-open on lock acquisition failure, and should be replaced by append-only run records for broader use. Observation: the same section also relies on it as Phase A’s live ceiling and later says graduation requires the daily ceiling “never silently exceeded.” Concrete resolution: either make Phase A’s reviewer ledger append-only/idempotent now, or weaken graduation language to match the admitted fail-open/per-machine guarantees.

5. **The spec over-indexes on LLM/reviewer process mechanics instead of minimizing surface (§0.5, §4, §8).**  
   Source acknowledges a narrow reviewer subprocess would avoid most defects but rejects it because Groky sessions are the operator goal. Observation: Phase A does not ship that goal, so carrying broad framework threading now increases risk before value. Concrete resolution: land the reviewer as a narrow adapter first; require a separate approval gate before Phase B framework/session threading.
