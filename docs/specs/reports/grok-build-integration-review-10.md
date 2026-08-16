# External cross-model review — round 15 (codex-cli:gpt-5.5)

Spec: docs/specs/grok-build-framework-integration.md
Status: ok · Verdict: MINOR ISSUES

Disposition:
1/2. **Structure and Phase A/B scope — DECIDED, sixth round.** The normative
   contract (r11), the Phase A acceptance section (r13) and the Phase B
   Scope-not-Acceptance relabel (r13) are this spec's answer. Splitting into
   three files conflicts with the repo's one-spec-per-feature convention, and
   the branch genuinely contains the threading — describing it elsewhere would
   make the spec LESS accurate about what lands. The reviewer's underlying point
   is now stated in the spec's own words: the file count measures Phase B
   threading, not Phase A capability.
3. **Ledger storage — DECLINED for this increment, third time, and already the
   named pre-growth requirement.** §8 states it: anything beyond the dark
   reviewer lane requires append-only records keyed on idempotent run ids
   (CMT-1317). Replacing a tested mechanism with an untested one on a
   money-adjacent surface, in the same window that just closed its concurrency
   hole with a measured 6/6-vs-3/6 control, would trade proven behaviour for
   cleaner architecture at exactly the wrong moment.
4. **The unqualified "nothing differs" — FOLDED, and a fair catch.** §7's
   rollout sentence read absolutely while the scoping lives two sections away in
   invariant 5. It now carries the qualification inline, because that sentence is
   the one a reader actually carries away.
5. Terminology — as round 12/13: the normative-contract section is the
   implementation map; the vocabulary is the repo's.

---

**Verdict: MINOR ISSUES**

1. **Normative clarity is still too hard to extract (§“Current normative contract”, §§0-14).**  
   The source says the later sections govern when they disagree, but also embeds 14 rounds of corrections inline. Observation: an implementer must read historical defects, carrier prose, and status notes to infer the live contract.  
   **Resolution:** split into: `Phase A normative contract`, `Phase B draft/threading`, and `review history`. Keep only current MUST/REFUSE behavior in the normative file.

2. **Phase A vs Phase B scope remains blurry (§0.5, §4.3, §5, §Acceptance).**  
   The source says Phase A ships only the one-shot reviewer, while much of the spec threads session, pin, pool, migration, and fallback behavior. Observation: the rejected “reviewer subprocess only” alternative is dismissed because the operator ultimately wants Groky, but Phase A acceptance does not require Groky/session capability.  
   **Resolution:** either make Phase A truly narrow and defer session/pool threading to a Phase B spec, or define Phase B acceptance now before carrying closed-lane behavior through production surfaces.

3. **Budget ledger reinvents a solved durability/concurrency problem (§8).**  
   The source explicitly calls the JSON ledger a circuit breaker, not accounting, and names residual lock races, fail-open behavior, and eventual append-only records. Observation: this is exactly where SQLite WAL or an append-only event log with idempotent run IDs is simpler than a bespoke JSON-plus-lock protocol.  
   **Resolution:** use SQLite or append-only records now for the reviewer ledger; keep the per-machine ceiling but remove stale-lock, lost-update, and fail-open ambiguity.

4. **Dark-ship claim depends on a scoped definition that readers may miss (§1, §7, §11).**  
   The source correctly narrows “byte-identical” to grok registration/framework execution and lists four global changes. Observation: the opening rollout language still says “nothing differs,” which is false outside that narrowed scope.  
   **Resolution:** replace all unqualified dark-ship wording with the scoped invariant wording.

5. **Operator-ratified exception is not actually ratified (§Multi-machine posture).**  
   The source itself says ratification is owed, not held. Observation: using that locality key before the checkable operator decision exists weakens the taxonomy.  
   **Resolution:** mark those rows `temporary-unratified exception` until the authenticated operator decision exists.
