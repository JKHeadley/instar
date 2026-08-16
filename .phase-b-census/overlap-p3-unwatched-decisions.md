# Overlap census: “Decisions written where no check can see them”

## Scope and coverage

- Registry examined: `docs/STANDARDS-REGISTRY.md`
- File coverage: all 787 lines, from the title through “The Stakes — the AWG Challenge” and the closing canonical-home note.
- Total standards in the registry: **82**, counted by the registry's `###` standard headings.
- Standards actually examined: **82 of 82**.
- Standards reported below as overlapping in whole or in part: **20**.

This is retrieval and clause-level comparison only. It contains no verdict or recommendation.

## Proposal clauses used for comparison

For compact comparison, the proposal was divided into these clauses:

- **P1 — One-language visibility:** the automated ratchets/lints read one programming language.
- **P2 — Unwatched blocking sites:** blocking/refusing decisions exist in another programming language and are unseen by those checks.
- **P3 — Shared causal defect:** two guards share a use-versus-mention defect because neither was inspected, not by coincidence.
- **P4 — Placement discipline:** a decision that can block or refuse must live where the checking apparatus can see it.
- **P5 — Boundary collapse:** move decision logic into the checked language and leave thin shims that decide nothing.
- **P6 — No parallel detectors:** do not maintain separate detector implementations in both languages.

## Search strategies used

1. **Complete structural enumeration.** Enumerated every `###` heading, confirmed the count of 82, and read every standard entry in full, including its Rule, In practice, Earned from, Traces to the goal, Applied through, enforcement, and honest-limit text where present.
2. **Decision-authority search.** Looked by meaning for standards governing who or what may block, refuse, veto, hold, consume, gate, classify, or make a judgment, including standards that use “authority,” “floor,” “signal,” or “decision boundary” instead of “block.”
3. **Visibility/coverage search.** Looked for standards about blind spots, unobserved duties, incomplete audit surfaces, missing categories, dark guards, unenforced prose, coverage ratchets, and mechanisms that are present but do not watch the whole population.
4. **Use-versus-mention search.** Looked for semantic equivalents: symbol versus state, description versus reality, literal/keyword matching versus meaning, subject binding, false positives, discussion being mistaken for intent, and brittle filters with veto power.
5. **Boundary/canonicalization search.** Looked for shared funnels, single sources of truth, canonical authorities, consumer completeness, chokepoints, generated rather than hand-maintained variants, and rules against parallel implementations.
6. **Enforcement-scope check.** For every candidate, compared the proposed failure to the exact mechanism the standard says enforces it, including stated allowlists, registries, source scopes, report-only modes, tracked-but-not-landed ratchets, and honest limits.
7. **Semantic-neighbor rejection.** Mere occurrence of “refusal,” “guard,” “lint,” or “language” was not enough. For example, **A Refusal Stays a Refusal** governs preservation of a negative result after a refusal has occurred, not where the refusing decision lives; **Stall Coverage Is Enumerated, Not Discovered** governs framework stall detection/recovery matrices, not source-language coverage of blocking decisions; and **Cross-Store Coherence Is an Invariant** governs agreement between data stores, not duplicate detector implementations. Those were examined but are not reported as overlaps.

## Overlapping standards

### Structure beats Willpower

**Overlap breadth:** direct at the principle level, but broad; it does not state the programming-language boundary.

**Verbatim overlap evidence:**

> **Rule.** If a behavior matters, enforce it in architecture, not in instructions. Never rely on an agent "remembering" to follow a rule buried in a long prompt.

> **In practice.** Session-start hooks inject context automatically; programmatic gates enforce required steps; dispatch tables route decisions; behavioral hooks guard against anti-patterns. A 1,000-line prompt is a wish; a 10-line hook is a guarantee. This root rule now self-applies through the `scripts/standards-coverage.mjs` ratchet, wired as **Standards Enforcement Coverage** in `.github/workflows/ci.yml`: the build fails when aggregate or per-family named-guard coverage falls below its committed floor, so the registry's own enforcement record no longer depends on remembering this paragraph.

**Proposal clauses already covered:** P4 at the general level: consequential behavior must be structurally placed behind enforceable architecture rather than left to convention. It also partially covers the concern behind P2: a purported discipline that does not structurally reach some sites is not an architectural guarantee for those sites.

**Proposal clauses not covered:** P1's fact that checks read one programming language; P2's concrete cross-language population; P3's use-versus-mention recurrence and its causal attribution; P5's checked-language/thin-shim design; P6's rejection of parallel detector sets.

**Would its stated enforcement already catch the proposed failure?** **No.** The cited ratchet measures aggregate and per-family **named-guard coverage** in the registry's enforcement record. The quoted text does not say it enumerates every blocking/refusing source site, classifies programming languages, or fails when a decision implementation sits outside a lint's source-language scope.

### The Body and the Mind

**Overlap breadth:** partial and authority-focused; it covers where consequential judgment belongs, not where static checking can see source code.

**Verbatim overlap evidence:**

> **In practice.** Every decision of consequence is made by the mind, *informed* by the body, and *recorded* — the structural signal, the choice, and its reasoning — because that record is how the body learns and both evolve. The temptation to let code, a regex, a gate, or a classifier *decide* something important past that threshold is the violation: make it *inform* the mind instead, and audit the call. The audit trail is exactly what makes "the mind decides" safe rather than a loophole.

**Proposal clauses already covered:** P3 in part, because a use-versus-mention regex or classifier with blocking authority is precisely a brittle mechanism making a consequential decision. P4 in part, because the standard specifies an authority location: code/regex/classifier supplies signal, while the full-context mind decides and the call is recorded.

**Proposal clauses not covered:** P1 and P2's cross-language checking blind spot; the claim that lack of inspection caused the two similar defects; P5's checked-language/thin-shim boundary collapse; P6's prohibition on parallel detector implementations.

**Would its stated enforcement already catch the proposed failure?** **No.** Its “Applied through” text names the tier classifier, LLM-supervised gates, and decision audit trails, but it does not state a source-wide mechanism that discovers deterministic blocking decisions in every programming language. A reviewer applying the rule could identify the authority defect, but the cited machinery would not automatically find the unwatched sites described by P2.

### Observation Needs Structure

**Overlap breadth:** direct on the existence of an unwatched population; indirect on code placement.

**Verbatim overlap evidence:**

> **Rule.** A standing responsibility to *notice* something is a wish unless an unskippable artifact proves the looking happened. Duties of perception get gates, not adjectives: if a system is supposed to observe X, there must be a required record that cannot exist without the observation — because an observation without a required artifact is indistinguishable from no observation at all.

> **In practice.** Encode every observation duty as a refused-without-it field at the state-mutating transition: the apprenticeship cycle store (`src/monitoring/ApprenticeshipCycleStore.ts`) refuses a cycle record without an operator-seat UX verdict — pinned by `tests/unit/apprenticeship-cycle-store.test.ts`, which asserts the throw, that the message is self-describing, and that nothing is persisted on refusal; the dev gate's audit entry finalizes a pass/blocked verdict; fix-class commits carry a causal-autopsy origin. The refusal message teaches the exact required shape, so a blocked observer can self-serve compliance. The test for any new responsibility: *"if this duty were silently skipped, what artifact would fail to exist?"* If the answer is "none," the duty is decorative.

**Proposal clauses already covered:** P2's core condition—an entire population receives no observation—and P3's causal reading that repeated misses can share one structural absence of inspection. It also partially supports P4: inspection must be attached to an unskippable transition, not merely requested.

**Proposal clauses not covered:** P1's one-language fact; any rule that all blocking/refusing decisions must be in the checked language; the move-to-checked-language/thin-shim architecture in P5; P6's rejection of dual detector sets; the specific use-versus-mention defect.

**Would its stated enforcement already catch the proposed failure?** **No.** Its stated mechanisms enforce particular artifacts at particular transitions. They do not enumerate source-language decision sites or prove that every blocker/refuser is inside a ratchet's parse surface. The standard diagnoses the missing-observation shape but its listed gates do not cover this population.

### No Silent Degradation to Brittle Fallback

**Overlap breadth:** narrow-domain overlap. It already requires one shared checked funnel for **gating LLM calls**, but not for blocking decisions generally.

**Verbatim overlap evidence:**

> **In practice.** Route every gating LLM call through the one shared provider that swaps-then-fails-closed (`IntelligenceRouter.failureSwap` for `gating: true` calls), so the whole fleet inherits the behavior from one place (Structure beats Willpower). Flip any gate that returns a permissive verdict on failure (`proceed`, `safe`) to its safe verdict (`show-plan`, `sensitive`). Advisory / observability calls (a metric, a digest) MAY degrade — but must log it. A forward ratchet (`tests/unit/no-silent-llm-fallback.test.ts`) fails CI on a new gating callsite that ships a silent fallback; each accepted-advisory site carries a written reason.

**Proposal clauses already covered:** P4–P6, but only for the standard's narrow subject: gating LLM calls must pass through one shared provider, inheriting one enforcement implementation rather than implementing local fallbacks in parallel.

**Proposal clauses not covered:** non-LLM blockers/refusers; programming-language visibility; use-versus-mention defects; the claim that the two observed guards share a cause; thin shims in an unwatched language.

**Would its stated enforcement already catch the proposed failure?** **No.** Its forward ratchet looks for new **gating LLM callsites that ship a silent fallback**. The proposed guards are described as decision sites outside the language the checks read, and the proposed defect is use-versus-mention, not an LLM-provider failure fallback. The mechanism's stated subject and source reach do not include that failure.

### Intelligence Infers, Keywords Only Guard

**Overlap breadth:** direct on the concrete use-versus-mention defect and blocking authority; direct evidence in the entry also acknowledges incomplete guard reach.

**Verbatim overlap evidence:**

> **Rule.** A decision about what a human MEANT — their intent, their request, whether a message is a command or just conversation — is made by an LLM reasoning over the message AND its surrounding conversation context. A keyword/phrase/regex list is NEVER the decision-maker for natural-language meaning.

> **Enforcement.** A lint/ratchet flags keyword/phrase/regex lists tested against message or conversation text inside sentinel/gate/classifier code (sibling to the existing "an LLM gate must not string-match" guard, which was clearly not applied everywhere — three live-wired violators found 2026-07-03). New such code must justify itself as one of the two survivors or route through an LLM.

**Proposal clauses already covered:** P3's use-versus-mention class when the blocker mistakes a phrase appearing in discussion, quotation, or test material for the human actually expressing the guarded intent. P4 is also covered for natural-language decisions: the keyword detector may not be the blocking decision-maker. The enforcement paragraph already records the narrower version of P2: the existing guard “was clearly not applied everywhere.”

**Proposal clauses not covered:** P1's programming-language diagnosis; the general rule for all blocking/refusing decisions rather than natural-language meaning; P3's asserted common cause for the two particular guards; P5's checked-language/thin-shim remedy; P6's explicit rejection of maintaining two detector sets.

**Would its stated enforcement already catch the proposed failure?** **No.** The proposal states that both guards are in the language the lint/ratchet does not read. The standard's own enforcement is the lint/ratchet whose incomplete application is acknowledged in the quote. It could catch the same pattern only inside its inspected source population.

### Intelligent Prompts — An LLM Gate Must Not String-Match

**Overlap breadth:** narrow and partial. It covers a use-versus-mention/literal-match failure inside LLM judgment prompts, not the cross-language placement issue.

**Verbatim overlap evidence:**

> **Rule.** When an LLM *gates* a decision, the PROMPT itself must judge by meaning. It must NEVER be authored to make the block/allow decision conditional on the presence of a literal string from a fixed list — that is a brittle filter wearing the LLM's authority: a paraphrase evades it, and the model's contextual judgment, its entire reason for being in the loop, is discarded. Brittle literal detection that is genuinely warranted (an error code, a command, a file path) belongs OUTSIDE the prompt: a deterministic detector emits a *signal*, the signal is supplied to the LLM as input/context, and the LLM decides *in context* what to do with it. Pattern-matching is the deterministic layer's job, fed in — never the prompt's.

> **In practice.** A judgment rule's prompt states the *intent* it catches and judges any expression of it; example phrasings are explicitly illustrative, never a necessary condition. Where a literal artifact must be detected, detect it deterministically and pass it as a signal (the pattern B8/B9/B12 already use), then have the prompt reason about the signal in context. A forward ratchet (`tests/unit/gate-prompts-judge-by-meaning.test.ts`) scans judgment-rule prompts — block conditions, carve-out prose, and shared headers — for a necessary-literal-gate construction and fails CI; rules are classified by a machine-readable source registry (`RULE_CLASSES` in `MessagingToneGate.ts`) so the boundary is structural, and an unclassified or misclassified judgment-shaped rule fails closed. **Honest limit:** the ratchet catches the necessary-literal-gate construction and light rewordings; an arbitrarily sophisticated semantic rewrite still requires human review of any judgment-prompt change, which the PR must document — claiming more enforcement than that would itself be fake-protection.

**Proposal clauses already covered:** P3 for the subset where use-versus-mention is created by a literal-required LLM prompt; P4 for the placement of literal detection versus semantic authority—the detector emits a signal and the contextual LLM decides.

**Proposal clauses not covered:** P1 and P2's programming-language blind spot; non-LLM shell or other deterministic blockers; P5's move into the checked programming language; P6's one-detector-set rule.

**Would its stated enforcement already catch the proposed failure?** **No.** The ratchet expressly scans judgment-rule prompts and uses `RULE_CLASSES` in `MessagingToneGate.ts`. It would not inspect a blocker implemented in a different programming language outside that prompt registry. Its own honest limit also disclaims complete semantic detection even within the prompt population.

### Quantitative Claims Must Bind a Subject

**Overlap breadth:** weak but concrete on context binding: it covers one specialized version of a detector mistaking shared words for shared meaning.

**Verbatim overlap evidence:**

> **Rule.** A verifier may compare a number only after binding both the measurement and the subject being measured. A shared unit or relation word is not semantic identity: “30 minutes in an offline-test window,” “one minute of detection latency,” “two hours remaining on the migration ETA,” and “two hours remaining in this session” are four different claims. A detector that sees only `duration + elapsed/remaining/in` and silently assumes “session clock” is a keyword classifier, not verification.

> **In practice.** Cheap deterministic extraction may nominate a structurally anchored measurement, but competing local subjects must DROP the candidate toward pass-through. Positive verification requires an explicit subject binding or an intentionally documented unqualified default backed by the caller’s typed context. Both sides are pinned together in one decision table: real elapsed/remaining/percent session-clock claims still reach the live clock, while test windows, latencies, queues, timeouts, outages, and task ETAs do not. New quantitative verifiers must carry the same paired boundary tests; a positive-only regex fixture is incomplete. The first verifier and its paired decision table are `src/core/time-claim.ts`.

**Proposal clauses already covered:** P3 only at the semantic-pattern level: a surface token match does not establish what the text is about, and both genuine-use and non-use contexts must be represented at the decision boundary.

**Proposal clauses not covered:** the standard is limited to quantitative claims and subject binding. It does not cover P1–P2's programming-language blind spot, the two particular guards, P4's source-placement rule, P5's checked-language/thin-shim structure, or P6's prohibition on parallel detector sets.

**Would its stated enforcement already catch the proposed failure?** **No.** Its paired decision table and implementation citation apply to `src/core/time-claim.ts` and new quantitative verifiers. They do not enumerate general blocking/refusing guards or inspect implementations in another language.

### The Operator Channel Is Sacred — Critical-Path Gates Fail Toward Delivery

**Overlap breadth:** partial and channel-specific. It covers brittle decisions that consume or block inbound operator messages, not the general cross-language placement discipline.

**Verbatim overlap evidence:**

> **Rule.** A gate on the operator's PRIMARY communication channel (inbound user messages) must never CONSUME or block a message on a single brittle, low-confidence, or *failed* signal. The safe failure direction for inbound operator comms is DELIVERY — route the message to the agent.

> Three corollaries: (1) **a message-CONSUMING decision requires a DETERMINISTIC match, never a bare-LLM guess** (an LLM "pause" verdict self-reports high confidence regardless of correctness) — and this route-through rule governs consume/pause gates whose missed signal is benign; it never loosens genuine emergency-stop, whose missed signal is *destructive*. The two are distinguished by CONSEQUENCE-OF-A-MISS, not by being the same gate. (2) **The load-bearing safety property is RECOVERABILITY:** a control action reachable by a brittle signal is acceptable only if its false-positive is escapable AND its recovery path does NOT route back through the failing gate (the inescapable-loop trap). (3) **Bounded blast radius for DECISION-gates** (the sibling of *Bounded Blast Radius* for spawns): a single misclassification must not be able to lock the operator out — a self-evidencing circuit-breaker auto-recovers when the operator keeps messaging.

**Proposal clauses already covered:** P3–P4 for the inbound-channel subset: a brittle misclassification must not receive unbounded consume/block effect, and the decision's consequence and recovery path must be explicit.

**Proposal clauses not covered:** the standard does not address the programming-language inspection perimeter (P1–P2), does not identify lack of inspection as the two guards' common cause, does not move decisions to a checked language or define thin shims (P4–P5), and does not prohibit parallel detector sets (P6). Its scope is inbound operator messages, while the proposal covers any decision that blocks or refuses.

**Would its stated enforcement already catch the proposed failure?** **No.** Its stated implementation is `MessageSentinel`'s pause path, a topic-keyed circuit-breaker, and structured pause counters. It does not scan unrelated outbound or tool-command guards or enumerate blockers by source language.

### Iterative Audit to Convergence

**Overlap breadth:** direct on complete search-surface coverage and the need for a standing ratchet; it does not prescribe source placement.

**Verbatim overlap evidence:**

> **In practice.** Run any "find all instances of X" sweep — security, safety, review, research — as the loop, not the pass: frame the target pattern + search surface + classification + convergence criterion; sweep; fix-or-classify each finding (an accepted finding is a written DECISION, not a TODO); then re-sweep the FULL surface (your search surface grew, and the fixes moved things). Where the pattern is CI-expressible, leave a standing ratchet (a `no-*` test) so the converged state cannot silently un-converge on the next commit — the ledger of accepted findings becomes its allowlist.

> Honest scope: this enforces that a `converged:` claim in a canonical report is form-verified + CI-re-checked; it does not (and cannot) force an audit to be routed to `docs/audits/` in the first place, nor make a form-valid but shallow audit deep — the converging-loop process discipline (single-pass = incomplete) is delivered to every agent via the `/iterative-converging-audit` skill + the CLAUDE.md default-route section, and the stamp is earned only in a repo carrying the validator.

**Proposal clauses already covered:** P1–P3 in audit-process terms: the search surface must be framed, the full surface must be re-swept, and a shared blind-spot class/causal insight must be preserved rather than treating two instances independently. It also covers the standing-ratchet part implicit in P4.

**Proposal clauses not covered:** the substantive rule that blockers/refusers must reside in a particular checked language; P5's thin-shim architecture; P6's prohibition on parallel detector implementations.

**Would its stated enforcement already catch the proposed failure?** **No, not reliably.** A correctly framed full-surface audit would find the unwatched-language population. The stated machine enforcement, however, validates the form of a canonical convergence report and expressly “cannot … make a form-valid but shallow audit deep.” It does not mechanically prove that all programming languages containing blockers/refusers were included in the search surface.

### Distrust Temporary Success — A Recurrence Is a Root Cause

**Overlap breadth:** weak and causal. It covers the proposal's instruction to read repeated same-shaped failures as evidence of a shared structural cause.

**Verbatim overlap evidence:**

> **Rule.** When a fix keeps working but the problem keeps returning, the recurrence is the signal: a self-healing system's own resilience is hiding the root cause. A patch that resets a symptom is not a fix, and a system that recovers on its own will make a code-level bug look transient forever. Before declaring a thing fixed, verify the *cause* is gone — not just the symptom.

> **Traces to the goal.** A self-evolving agent that trusts temporary success evolves *patches*, not fixes — it re-pays the same root cost forever while believing each symptom-reset was progress. Coherence across **time** (see *Close the Loop*) requires that "done" mean the root is gone, because a recurrence mistaken for a fresh problem is how an agent loops indefinitely without learning.

**Proposal clauses already covered:** P3 at the general causal level: recurrence is evidence to seek and verify a common root rather than treating each instance as an isolated coincidence.

**Proposal clauses not covered:** its stated recurrence is symptom-return after apparently successful fixes, not two simultaneously unwatched guards. It does not cover P1–P2, use-versus-mention itself, P4's checked-language placement, P5's thin shims, or P6's parallel-detector prohibition.

**Would its stated enforcement already catch the proposed failure?** **No.** Its stated structural expression is an autonomous-completion criterion that refuses to call a recurring symptom-reset done, plus a lessons-aware reviewer. Neither mechanism enumerates blocking/refusing sites or checks programming-language coverage.

### Verify the State, Not Its Symbol

**Overlap breadth:** direct on use versus mention; no overlap with the proposed code-language remedy.

**Verbatim overlap evidence:**

> **Rule.** A detector, gate, verifier, or sentinel must confirm the **state of the world** it claims to detect — never accept a **symbol** of that state (a string, label, marker, filename, or the mere presence/absence of a proxy signal) as proof the state holds. The failure runs in both directions: the *presence* of a symbol is not the condition being true, and the *absence* of a signal is not the condition being true. When the evidence needed to decide is unavailable the result is **unknown**, and unknown must fail toward the **least-harmful** action *for that specific detector* — which is not always "closed."

> A `no-uncorroborated-symbol-fire`-style CI ratchet for detector callsites that fire on a bare substring with no second-signal corroboration remains tracked, mirroring `no-silent-llm-fallback.test.ts`.

**Proposal clauses already covered:** P3's defect itself. A mention, quotation, test fixture, or journal description is a symbol/description of a guarded state, not proof that the guarded action is being performed. The rule already prohibits a detector from firing solely on that evidence.

**Proposal clauses not covered:** P1–P2's programming-language coverage gap and its causal role; P4's source-placement discipline; P5's checked-language/thin-shim structure; P6's rejection of parallel detectors.

**Would its stated enforcement already catch the proposed failure?** **No.** The general `no-uncorroborated-symbol-fire` ratchet is explicitly described as still tracked, not as current enforcement. The mechanisms already named are a spec reviewer plus specific fixes/tests for particular detectors and cadence monitors; they do not enumerate shell or other non-checked-language blockers. The rule covers the defect semantically, but the stated live enforcement does not cover these sites.

### Testing Integrity

**Overlap breadth:** partial. It requires the exact two-sided semantic tests that can expose use-versus-mention over-blocking, but it does not guarantee cross-language discovery.

**Verbatim overlap evidence:**

> **Rule.** Every significant feature requires all three foundational test tiers — unit, integration, and E2E lifecycle — plus wiring-integrity tests for every injected dependency and semantic-correctness tests for both sides of every decision boundary. No exceptions. For agent-facing and experiential behavior, the highest tier is **Test-as-Self**.

**Proposal clauses already covered:** P3 at the behavior-test level. “Both sides of every decision boundary” includes an A-case that should block and a B-case—such as discussion, quotation, fixture construction, or reporting—that should pass. Wiring/E2E requirements also partially cover the concern that a guard population could exist outside the tested production path.

**Proposal clauses not covered:** P1 and P2's programming-language inventory; the causal claim that no inspection produced the shared flaw; P4's required source location; P5's thin shims; P6's ban on parallel detector implementations.

**Would its stated enforcement already catch the proposed failure?** **Not as an existing universal mechanism.** A compliant semantic-correctness test containing a use-versus-mention B-case would catch each guard's behavior regardless of implementation language. The entry does not state a registry or lint that enumerates every blocking/refusing decision across languages and proves such tests exist. Thus the obligation would catch the behavior if applied, but the standard's stated machinery does not already discover the omitted sites.

### Observability — you can't tune what you can't see

**Overlap breadth:** partial and blind-spot-focused; it concerns what a schema can perceive, not where decision logic is implemented.

**Verbatim overlap evidence:**

> **Your record schema is your perception** *(sharpened 2026-06-05, ratified with the UX-blindspot arc).* A learning system can only see what its forms have fields for: a ledger with only engineering buckets is *structurally* blind to user-experience findings, no matter how diligent the observers. When a whole class of issue goes unrecorded for weeks, audit the SCHEMA before blaming the observers — the missing category usually is the bug. Adding a field is adding a sense: the causalAutopsy trace field (#854) and the cycle store's channel and operatorSeatUx columns each made a previously-invisible class queryable.

**Proposal clauses already covered:** P2–P3 at the meta level. An unwatched programming-language category is a designed-in perception gap, and repeated defects in that category can share the missing category/sensor as their cause.

**Proposal clauses not covered:** P1's exact one-language diagnosis; blocking/refusing decisions as the population; P4's location rule; P5's checked-language/thin-shim remedy; P6's prohibition on parallel detectors; the use-versus-mention defect itself.

**Would its stated enforcement already catch the proposed failure?** **No.** Its stated mechanism is feature metrics and record-schema design. Those mechanisms can expose effects and missing measurement categories after the category is represented, but they do not statically enumerate decision code or identify an unparsed programming language.

### Migration-Consumer Completeness

**Overlap breadth:** narrow and remedy-stage only. It applies if moving the decisions into the checked language is treated as a canonical-authority migration.

**Verbatim overlap evidence:**

> **Rule.** A canonical authority migration is incomplete until every authorization, validation, routing, and compatibility consumer of the replaced authority moves in the same unit of work, with tests that exercise the new canonical source through those consumer boundaries. A producer-only migration is not partial progress; it is a split-brain contract.

> **Traces to the goal.** A coherent system cannot hold two incompatible truths about which store is authoritative. Canonicalization only improves coherence when every decision boundary consumes the same authority.

**Proposal clauses already covered:** P5–P6 after a canonical move begins: every decision boundary must consume the new authority, and leaving an old decision implementation behind as a second authority is incomplete. That supports thin compatibility shims only insofar as they do not retain authority.

**Proposal clauses not covered:** P1–P3's existing visibility defect and common cause; any mandate that the canonical authority be written in the lint-checked programming language; all blockers/refusers outside a declared migration; use-versus-mention semantics.

**Would its stated enforcement already catch the proposed failure?** **No.** Its lint checks declared contracts, markers, paths, and revision synchronization for an enrolled canonical migration. The current failure is the pre-existing absence of a cross-language decision-site rule, not a registered migration whose consumers failed to acknowledge a revision. The mechanism would govern completeness of a declared migration, not discover the motivating unwatched sites.

### Judgment Within Floors

**Overlap breadth:** direct on static heuristics holding consequential decision authority; indirect on checker visibility.

**Verbatim overlap evidence:**

> **Rule.** A decision point with competing signals or non-enumerable context may be delegated to an LLM arbiter only inside a deterministic floor: the floor defines the complete safe action space and a conservative default; invariants are never delegated; the arbiter can narrow but never widen; an arbiter choice with irreversible consequence requires mechanical corroboration, never free-text evidence alone; fallback follows the bench-ranked ladder and always ends at a deterministic rung; and an arbiter may begin ACTING (beyond shadow) only after shadow-phase evidence shows it beats the deterministic default on the decision point's named success criteria — evidence before authority. A new static heuristic at such a point must state why it is not a judgment point.

> **In practice.** Applied through `src/core/SpawnAdmission.ts` (the owner-dark arbiter's floor) and the duplicate reconciler survivor floor; contested per-spec via the spec-converge decision-point classification and per-change via the side-effects question; arbiters join the four routing registries and carry parity-checked batteries.

**Proposal clauses already covered:** P3–P4 in part. A use-versus-mention blocker operating over non-enumerable context is a static heuristic acting at a judgment point; the standard requires that status to be surfaced and justified, and assigns authority inside a deterministic floor rather than to the heuristic alone.

**Proposal clauses not covered:** P1–P2's source-language blind spot; a universal placement rule for every blocker/refuser; P5's checked-language/thin-shim move; P6's no-parallel-detectors rule.

**Would its stated enforcement already catch the proposed failure?** **No.** The cited mechanisms operate through spec-converge classification, a per-change side-effects question, named TypeScript components, routing registries, and batteries. Nothing in the entry states that shell or other-language blocking sites are enumerated. It could flag a newly reviewed declared heuristic, but it would not automatically discover the unwatched group.

### Side-Effects Review Gate

**Overlap breadth:** weak but actual at review time: it already requires scrutiny of abstraction placement and signal-versus-authority for every fix.

**Verbatim overlap evidence:**

> **Rule.** No fix ships, however simple, without a side-effects review: over/under-reach, level-of-abstraction fit, signal-vs-authority compliance, interactions with adjacent systems, and rollback cost.

> **In practice.** The review is a structural gate, not author discretion. Enforced by `scripts/instar-dev-precommit.js`, which refuses the commit when the side-effects artifact is not staged; `.husky/pre-commit` runs under `set -e` so that refusal is no longer discarded by a later passing check.

**Proposal clauses already covered:** P3–P4 only as required review questions. Use-versus-mention is over-reach; a brittle detector that blocks is signal-versus-authority; placing authoritative logic in a thin compatibility layer rather than a checked core is a level-of-abstraction issue.

**Proposal clauses not covered:** any explicit programming-language inventory; proof that all blocking/refusing sites are checked; the causal connection between the two guards; P5's required destination and thin-shim design; P6's explicit ban on dual detectors.

**Would its stated enforcement already catch the proposed failure?** **No, not deterministically.** The precommit mechanism proves that an artifact is staged. The entry does not state a field or parser that requires the artifact to identify an unwatched source language or forbids decision logic in it. A substantive reviewer could notice the issue, but artifact presence alone does not catch it.

### A Dark Feature Guards Nothing

**Overlap breadth:** weak, limited to the functional equivalence between an unavailable guard and no guard for the affected path.

**Verbatim overlap evidence:**

> **Rule.** When an incident or a path analysis shows that a **load-bearing path depends on a feature that ships dark, disabled, or dry-run**, that is a forced decision point: **graduate it, or record explicit operator acceptance of the manual fallback**. A safety automation that exists only dark is, for the fleet, prose — the fleet's real posture is the DARK posture.

**Proposal clauses already covered:** P2 only at the operational-effect level. For the decisions in the other language, a lint that does not inspect that language provides the same protection as an unavailable guard: none. The standard already rejects counting non-operating safety machinery as live protection.

**Proposal clauses not covered:** a partially scoped lint is not literally a dark/disabled feature under this standard; P1's programming-language split; P3's use-versus-mention cause; P4's decision-placement rule; P5–P6's canonical checked-language design.

**Would its stated enforcement already catch the proposed failure?** **No.** The guards inventory classifies known features by rollout/runtime posture (`loadBearingGap`, `loadBearingSoaking`, `loadBearingAccepted`). It does not inspect a lint's parser coverage or discover source-language decision sites that never became inventory rows.

### The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred

**Overlap breadth:** narrow consequence-based overlap. It applies only where an unwatched blocker/refuser can prevent a user message or response.

**Verbatim overlap evidence:**

> **Rule.** The user's ability to **reach** a live agent, **be heard**, and get a **timely, coherent response** is a first-class invariant that **outranks internal caution when the two conflict**. No internal guard, safety net, resource limit, or self-continuity discipline may *silently* degrade the user's channel. When a guard cannot do its job, it must **fail toward the user being served** — preserving safety by a different, cheaper, deterministic mechanism — and surface the degradation **loudly**. A guard may never be the single thing standing between the user and *any* response at all.

**Proposal clauses already covered:** P3–P4 only for the user-channel subset. A use-versus-mention guard that blocks a correct user-facing response violates the rule's consequence floor, regardless of implementation language; a guard may not be the sole veto between the user and a response.

**Proposal clauses not covered:** blockers/refusers unrelated to the user's channel; source-language visibility; the common-cause claim; moving decisions into a checked language; thin shims; avoiding parallel detector sets.

**Would its stated enforcement already catch the proposed failure?** **No.** The entry says the first shipped enforcement covers `MessagingToneGate` degradation on LLM-backend outage and explicitly says the remaining sub-standards are tracked. It does not state a general cross-language detector for every guard capable of blocking user output, so an unwatched shell or other-language guard is outside the cited teeth.

### Never-Waste Feedback — corrections compound

**Overlap breadth:** weak-to-partial. It covers how two separately observed guard failures should become durable evidence of a guardian gap, not the source-placement rule itself.

**Verbatim overlap evidence:**

> **Rule.** User feedback is never allowed to evaporate. When the user corrects, contradicts, or points out something the agent should have caught, built-in infrastructure detects it, ingests it, and turns it into a durable signal that improves the system — it is never merely fixed-in-the-moment and forgotten.

> **In practice.** A human correction is treated as evidence that some *guardian* should have caught it and didn't — logged as a guardian-failure signal that builds a heat map of where the human is doing the system's job. The capture is automatic (per [No Manual Work](#no-manual-work-user-or-agent)); the richest grading signal — what the automated layers *missed* — is never left to the agent to remember to write down. Over time the heat map tells us which guardrails are weak and which are dead weight, and the data points toward where the next standard or fix should go.

**Proposal clauses already covered:** P3 in process terms: two recorded instances should be treated as evidence of a guardian failure and accumulated into a pattern, rather than fixed independently and forgotten.

**Proposal clauses not covered:** it does not identify the shared cause as programming-language invisibility; P1–P2's population claim; P4's source-placement rule; P5's checked-language/thin-shim design; P6's no-parallel-detectors rule; the semantics of use versus mention.

**Would its stated enforcement already catch the proposed failure?** **No.** `HumanAsDetectorLog` can capture the human correction and make recurrence visible. It does not inspect source code or attribute multiple corrections to an unwatched programming-language group automatically. It catches the feedback event, not the described structural failure.

### Signal vs. Authority

**Overlap breadth:** direct on the use-versus-mention guards' blocking authority; silent on programming-language coverage.

**Verbatim overlap evidence:**

> **Rule.** Brittle, low-context filters detect and emit *signals*. Only a higher-level, full-context intelligent gate has *blocking* authority.

> **In practice.** A fast regex or a cheap classifier may flag, never veto. The expensive, well-grounded gate makes the final call. Topic-intent's ArcCheck (signal) + the outbound gate (authority) is the model.

> **Earned from.** Low-context filters that over-blocked legitimate actions because a brittle check was trusted with a high-stakes decision it lacked the context to make.

**Proposal clauses already covered:** P3's substantive defect when a use-versus-mention matcher is a brittle, low-context filter that over-blocks. P4 is covered as an authority rule: such a filter may signal but may not hold the veto; blocking authority belongs to the full-context gate.

**Proposal clauses not covered:** P1 and P2's cross-language visibility; the common-cause claim that absent inspection explains both guards; the requirement that authoritative decision code reside in the language current checks parse; P5's thin-shim move; P6's rejection of parallel detectors.

**Would its stated enforcement already catch the proposed failure?** **No.** This registry entry names the model and links a full spec, but it states no cross-language source enumerator or lint. It can classify the behavior as an authority violation once a guard is examined; it does not supply the missing mechanism that finds blockers/refusers in the unwatched language.

## Clause-level coverage summary

| Proposal clause | Existing overlap found | What remains outside the overlapping text |
|---|---|---|
| P1 — checks read one language | Only indirect overlap through full-surface audit and blind-spot/schema principles | No standard states the one-language limitation or requires checks to enumerate source languages containing blockers/refusers |
| P2 — blocking/refusing sites in another language are unwatched | Covered as a general missing-observation/fake-protection shape | No standard names this population or makes cross-language decision-site coverage a required invariant |
| P3 — two use-versus-mention defects share the no-inspection cause | Use-versus-mention is substantively covered by **Verify the State, Not Its Symbol**, **Intelligence Infers, Keywords Only Guard**, **Intelligent Prompts**, **Quantitative Claims Must Bind a Subject**, and **Signal vs. Authority**; recurrence/guardian failure is covered by **Iterative Audit**, **Distrust Temporary Success**, and **Never-Waste Feedback** | None of those texts connects the two particular instances to programming-language invisibility as the shared cause |
| P4 — blockers/refusers must live where checks can see them | Broad structural/authority overlap in **Structure beats Willpower**, **Observation Needs Structure**, **The Body and the Mind**, **The Operator Channel Is Sacred**, **Judgment Within Floors**, and **Signal vs. Authority** | No existing text imposes checked-programming-language placement on all blocking/refusing decisions |
| P5 — move decisions into checked language; leave decision-free shims | Narrow remedy-stage overlap in **No Silent Degradation to Brittle Fallback**'s shared provider and **Migration-Consumer Completeness**'s single canonical authority | No existing text specifies this programming-language boundary or thin-shim rule |
| P6 — do not maintain parallel detector sets | Narrow overlap in shared-funnel/canonical-migration rules | No existing text prohibits parallel detector sets across programming languages as a general rule |
