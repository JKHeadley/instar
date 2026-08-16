# External cross-model review — round 16 (codex-cli:gpt-5.5)

Spec: docs/specs/grok-build-framework-integration.md
Status: ok · Verdict: SERIOUS ISSUES

Disposition:
1. **Carrier table not self-auditable — FOLDED, and a fair hit on my own
   structural fix.** The marker→carrier table was built so a reviewer could
   CHECK coverage rather than trust prose — but it depended on live
   `GET /commitments/…` calls, which a reviewer reading an inlined spec cannot
   make. Commitment text is immutable, so the six carriers' text is now inlined
   verbatim as a frozen ref and the table is self-contained.
2. **Phase scope — DECIDED, seventh round.** The normative contract, the Phase A
   acceptance section and the Phase B Scope relabel are the answer; splitting the
   document would make it LESS accurate about what the branch contains.
3. **Economic rationale — FOLDED.** §0.5 rejected the API path partly on
   economics while §0.0 says the billing sink is unknown and every run is
   budgeted as metered. Those cannot both stand. The rejection is now grounded
   on reviewer INDEPENDENCE (session auth, no key, so the door refuses key-based
   auth structurally), local token caps we control, and the operator's actual
   goal — with the 17% observation kept as evidence about the reported cost
   field rather than as the reason.
4. **Unopted-agent surface — DECIDED (round-15 folded the §7 sentence; invariant
   5 enumerates the four surfaces and §11 declares the migration).**

---

**Verdict: SERIOUS ISSUES**

1. **Self-contained audit gap (§Deferral carrier, Known unknowns):** The spec says marker coverage is verified by live `GET /commitments/CMT-...` calls, but those commitment texts are not inlined. In this review protocol, that makes carrier correctness unauditable. Resolution: inline immutable commitment excerpts or replace live-CMT dependency with checkable frozen refs.

2. **Phase scope is still too broad (§0.5, §4.3, §5, Phase A):** The spec says Phase A ships only one-shot reviewer use, yet threads `grok-build` through session pins, pool placement, migrations, conversational aliases, fallback behavior, and awareness surfaces. The source itself records many defects caused by this early threading. Resolution: split Phase A into a minimal reviewer adapter spec, and move session/pin/pool/fallback work into a separate Phase B spec with its own acceptance bar.

3. **Economic rationale remains weaker than the design admits (§0.0, §0.3, §0.5):** The API path is rejected partly on cheaper CLI economics, but the spec also says billing sink is unknown and every run must be budgeted as metered. That is internally defensible operationally, but not as a cost-based design argument. Resolution: restate the API rejection as “session-auth/no-key reviewer independence plus local token caps,” not “better economics,” until invoice-side proof exists.

4. **Unopted-agent change surface is easy to miss (§1, §7, §11):** The spec repeatedly says “ships dark,” but also admits four global surfaces change for every agent and adds broad always-overwrite skill migrations. The caveat is scattered. Resolution: add a single “Global changes despite dark ship” table near Scope/Rollout with exact files/surfaces and rollback behavior.

5. **Ledger pattern is a bespoke partial queue (§8):** The JSON ledger plus advisory lock, fail-open recording, stale reclaim, and future append-only replacement is reinventing an event log. The spec already names append-only records as required later. Resolution: use append-only run records with idempotent run IDs now for reviewer budget, even if stored locally.
