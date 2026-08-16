# GROK-family cross-model review — first LIVE run (grok-build:grok-4.6)

Spec: docs/specs/grok-build-framework-integration.md
Status: ok · Verdict: MINOR ISSUES · Flag: `cross-model-review: grok-build:grok-4.6`

This is the third reviewer family running for real, not a detection probe: the
door was opened with Groky's opt-in config (`--config` into his agent home),
the spec was reviewed end-to-end, and the result came back structured. On the
authoring agent's own config the same command correctly reports
`grok-not-enabled` — both sides of the dark-ship gate observed live.

Disposition: finding 1 (the unconsidered alternative — a reviewer-family
subprocess with no SessionManager / pool / pin surface) is RECORDED in §0.5
rather than dismissed. Its observation is correct: most of this integration's
defects came from threading a framework through closed lanes. It is rejected
because the operator's goal is an agent that RUNS on grok, which needs exactly
those surfaces — with the honest note that if the session lanes were ever
abandoned, §4.2-4.3 and the session half of §5 should be dropped with them.
The remaining findings are consistency and scope-clarity notes folded into the
round-11 pass (the "current normative contract" section answers the
extractability complaint directly).

Note on provenance: this reviewer read the spec it is reviewing, which
describes the reviewer itself. That is not disqualifying — its findings are
checkable against source — but it is a self-referential pass, and the two
independent families (GPT via codex, plus six internal reviewers) remain the
load-bearing checks.

---

I'll read the full offloaded prompt first so the review is grounded in the complete spec and context, not the truncated excerpt.The spec is long; I’ll keep reading the rest so findings are based on the full contract, not the opening extract.**Verdict: MINOR ISSUES**

The live contract is extractable: one confined one-shot reviewer lane, dark behind `enabledFrameworks`, budgeted as metered, routing excluded. Supporting standards (Agent Awareness, Cross-Machine Coherence, Account Follow-Me) and the eli16 overview were **not inlined** — alignments with those docs are unverified.

The prompt’s suggestion that this over-relies on **LLM-as-authority is false**. §8 treats reviewer output as untrusted and re-derived.

### Findings

**1. Unacknowledged alternative (§0.5, §1, extract)**  
§0.5 rejects the metered API, ACP-first, and a queue. It never considers *not* adding a fifth framework. The only live lane is `detectGrokReviewer` + the §4.1 adapter. Ten rounds of defects (four binary-resolution sites, six load-path gaps, pin-enum fallthrough to Claude, enrollment flipping the Claude throttle in §7) are the tax of type-union threading for **closed** lanes.  
**Resolution:** Record a rejected option: “reviewer-family subprocess; no SessionManager / pool / pin surface.” If future lanes are real, keep threading; if not, drop §4.2–4.3 and the session/routing half of §5 from this increment.

**2. Later-section-governs vs §1 (§1 vs extract / Decision 1)**  
The extract says later text wins, routing is excluded, and this is not framework parity. §1 then lists session launch and “component routing eligibility” as in scope. An implementer who reads in order is told §1 governs. Motivation still says “running on subscription billing”; §0.0 says that is unproven.  
**Resolution:** Make §1 match the extract (“live: reviewer one-shot; threaded-but-closed: sessions/routing”). Soften the Motivation sentence to §0.0.

**3. §0.2 overclaim**  
22 runs prove the *denomination* of `total_cost_usd` (0.17 × published list). They do not prove a subsidy, a durable plan, or the debit sink. A promo multiplier or delayed invoice still fit.  
**Resolution:** Drop “5.88× subsidy.” Call it a date-stamped reported-field scale factor that may change.

**4. API rejection does not follow from §0.0 (§0.5)**  
If every run is budgeted as metered, the HTTP API is the simpler certain-metered path: real quota, no ~12k-token CLI tax, no version-drift canary. The CLI wins only if the sink is cheaper — still unknown.  
**Resolution:** Choose the CLI for the probed envelope and *hoped* subscription semantics, not as a known-cheaper design.

**5. Fence accretion is the demonstrated failure mode (§2, §4.3, §8, §11)**  
Authorship-vs-git-tracked config, four-rung resolvers, half-cap precharge — each patched a surface this spec created. The likely next miss is another impersonation/load-path hole in a closed lane, not a billing miss. “Open questions: none” plus CMT-1299 as a junk drawer hides that.

**6. Review-shape assumption (§8, §4.1)**  
`--json-schema` is named as an advantage and unused. The consume path is “existing machinery, unchanged.” A third family’s different finding shape can drop opinions silently.  
**Resolution:** Constrain the CLI output or adapt the parser; do not assume GPT/Gemini-shaped JSON.
