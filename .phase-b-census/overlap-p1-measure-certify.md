# Overlap census: “A check must say what it measures and what it certifies — and those must be argued equal”

## Coverage and method

- Registry file: `docs/STANDARDS-REGISTRY.md`
- Registry size examined: 787 lines, 36,593 words, 252,764 bytes.
- Total standards in the registry: **82**, counted from every `###` standard heading.
- Standards actually examined: **82 of 82**. The introductory, closing, and amendment-process text was also read.
- Overlapping standards found: **38**. They are not ranked by importance.

I used five meaning-oriented search strategies:

1. Enumerated all 82 headings, then read the complete file sequentially rather than treating keyword hits as the corpus.
2. Looked for proxy-versus-reality formulations: symbol/state, component/outcome, structural/semantic, declaration/default, clean fixture/real bytes, unit/live behavior, and success-shaped failure.
3. Looked for false-pass formulations: lower tiers green while behavior is absent, literal/keyword checks that paraphrases evade, positive-only fixtures, one-pass checks represented as thorough, and per-tick bounds represented as convergence.
4. Looked for explicit enforcement-scope honesty: text saying a lint proves only enumerable structure while semantic review retains authority.
5. Looked for the proposal’s authoring-time counterexample in other forms: negative controls, both sides of decision boundaries, adversarial/impostor states, sustained-failure proofs, and tests of the original failure.

For clause-level comparison, the proposal is decomposed as follows:

- **P1 — Narrower-check failure:** a check can measure less than the property its pass is taken to prove.
- **P2 — State the measurement:** every check states what it measures.
- **P3 — State the certification:** every check states what its pass certifies.
- **P4 — Argue equality:** the measured passing set and the certified-property set must be argued equal.
- **P5 — Counterexample question:** ask what input passes the check while failing the claim.

“Does not cover” below means the quoted standard does not impose that proposal clause, even when the standard strongly illustrates the same failure shape.

## Overlapping standards

### Observation Needs Structure

> **Rule.** A standing responsibility to *notice* something is a wish unless an unskippable artifact proves the looking happened. Duties of perception get gates, not adjectives: if a system is supposed to observe X, there must be a required record that cannot exist without the observation — because an observation without a required artifact is indistinguishable from no observation at all.
>
> **In practice.** Encode every observation duty as a refused-without-it field at the state-mutating transition: the apprenticeship cycle store (`src/monitoring/ApprenticeshipCycleStore.ts`) refuses a cycle record without an operator-seat UX verdict — pinned by `tests/unit/apprenticeship-cycle-store.test.ts`, which asserts the throw, that the message is self-describing, and that nothing is persisted on refusal; the dev gate's audit entry finalizes a pass/blocked verdict; fix-class commits carry a causal-autopsy origin. The refusal message teaches the exact required shape, so a blocked observer can self-serve compliance. The test for any new responsibility: *"if this duty were silently skipped, what artifact would fail to exist?"* If the answer is "none," the duty is decorative.

- **Overlap strength:** Partial. It requires an artifact whose existence is causally tied to the claimed observation and supplies a counterfactual authoring question.
- **Already covers:** P1 in the specific case where artifact presence is overread as proof that observation occurred; part of P4 by requiring that the artifact “cannot exist without the observation”; part of P5 through “if this duty were silently skipped, what artifact would fail to exist?”
- **Does not cover:** P2 or P3 as explicit fields for every check; full bidirectional/set equality in P4; P5’s exact pass-while-claim-fails question; checks outside observation duties.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. The stated refusal gates and unit test enforce required observation artifacts at named state transitions. They do not inspect arbitrary test names or assertions such as “returns a list.”

### No Silent Degradation to Brittle Fallback

> **Rule.** When an LLM makes a judgment that *gates* an action, a provider failure (rate-limit, circuit-open, error) must never silently drop to a brittle heuristic. The call must SWAP PROVIDER (try another harness+account whose circuit is healthy) or FAIL CLOSED (refuse / treat-as-unsafe), and the degradation must be REPORTED — never swallowed. Silent degradation to a weak check is *worse than no check*, because it looks protected while being fake-protected.

- **Overlap strength:** Partial and domain-specific. It names the same appearance-of-proof problem when a weaker check substitutes for the check whose protection is being claimed.
- **Already covers:** P1 for LLM action gates during provider failure; part of P3 because the gate is understood to certify protection; part of P5 because a weak fallback must be considered against the unsafe cases it can let through.
- **Does not cover:** P2–P4 as an authoring obligation for every check; tests that are weak from the outset rather than degraded fallbacks; an explicit measured-set/certified-set argument.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. `tests/unit/no-silent-llm-fallback.test.ts` targets gating LLM callsites that silently fall back on provider failure, not semantically weak assertions in ordinary tests.

### Intelligence Infers, Keywords Only Guard

> **Rule.** A decision about what a human MEANT — their intent, their request, whether a message is a command or just conversation — is made by an LLM reasoning over the message AND its surrounding conversation context. A keyword/phrase/regex list is NEVER the decision-maker for natural-language meaning.
>
> **Enforcement.** A lint/ratchet flags keyword/phrase/regex lists tested against message or conversation text inside sentinel/gate/classifier code (sibling to the existing "an LLM gate must not string-match" guard, which was clearly not applied everywhere — three live-wired violators found 2026-07-03). New such code must justify itself as one of the two survivors or route through an LLM.

- **Overlap strength:** Partial and narrow. It rejects a measurement (keyword presence) as certification of a broader semantic property (human intent).
- **Already covers:** P1 for natural-language intent classifiers; an implicit P2/P3 distinction between measuring keywords and certifying meaning; part of P5 through the requirement to justify why a keyword gate is a valid survivor.
- **Does not cover:** Explicit P2 or P3 declarations; P4’s equality argument; non-language checks; tests whose assertion is merely too weak.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. Its lint is scoped to keyword/phrase/regex classification of message or conversation text.

### Intelligent Prompts — An LLM Gate Must Not String-Match

> **Rule.** When an LLM *gates* a decision, the PROMPT itself must judge by meaning. It must NEVER be authored to make the block/allow decision conditional on the presence of a literal string from a fixed list — that is a brittle filter wearing the LLM's authority: a paraphrase evades it, and the model's contextual judgment, its entire reason for being in the loop, is discarded.
>
> **In practice.** A judgment rule's prompt states the *intent* it catches and judges any expression of it; example phrasings are explicitly illustrative, never a necessary condition.

- **Overlap strength:** Direct for one check class. The literal list is narrower than the semantic property the gate claims to decide, and “a paraphrase evades it” is a pass-while-claim-fails counterexample.
- **Already covers:** P1; P3 for block/allow gates; a scoped version of P4 requiring the prompt to judge any expression of the stated intent; P5 through paraphrase-evasion analysis.
- **Does not cover:** An explicit P2 measurement statement; a general measured-set/certified-set record; checks outside LLM judgment prompts.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. `tests/unit/gate-prompts-judge-by-meaning.test.ts` scans judgment-rule prompts for necessary-literal constructions; it does not analyze ordinary test assertions.

### Quantitative Claims Must Bind a Subject

> **Rule.** A verifier may compare a number only after binding both the measurement and the subject being measured. A shared unit or relation word is not semantic identity: “30 minutes in an offline-test window,” “one minute of detection latency,” “two hours remaining on the migration ETA,” and “two hours remaining in this session” are four different claims. A detector that sees only `duration + elapsed/remaining/in` and silently assumes “session clock” is a keyword classifier, not verification.
>
> **In practice.** Cheap deterministic extraction may nominate a structurally anchored measurement, but competing local subjects must DROP the candidate toward pass-through. Positive verification requires an explicit subject binding or an intentionally documented unqualified default backed by the caller’s typed context. Both sides are pinned together in one decision table: real elapsed/remaining/percent session-clock claims still reach the live clock, while test windows, latencies, queues, timeouts, outages, and task ETAs do not. New quantitative verifiers must carry the same paired boundary tests; a positive-only regex fixture is incomplete.

- **Overlap strength:** Direct for quantitative verifiers. It explicitly separates the observed number from the claim’s subject and rejects a positive-only fixture.
- **Already covers:** P1; P2 (measurement plus subject must be bound); P3 (the quantitative claim being verified); part of P4 through a paired decision table; P5 through both-side boundary tests and the rejection of positive-only fixtures.
- **Does not cover:** Generalization beyond quantitative claims; an explicit requirement to write two named “measures” and “certifies” statements; a proof that the sets are fully equal rather than paired boundary coverage.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. Its decision table and tests concern quantitative subject binding in `src/core/time-claim.ts`.

### Bounded Blast Radius

> **Rule.** Every operation that can spawn subprocesses, allocate memory, or otherwise consume a *physical* host resource must have a STRUCTURAL ceiling on how much it can consume *at once* — a bound enforced in code, not assumed by good behavior. Safety that reasons only about MEANING (is this action correct / authorized / coherent?) and never about MASS (how many of these run concurrently, how much do they cost the host?) is "semantically flawless, physically suicidal." A correct operation, fanned out without a cap, is a fork-bomb.
>
> A forward ratchet (`scripts/lint-no-unbounded-llm-spawn.js`) fails CI on a new spawn-capable provider constructed outside the funnel, and a burst-invariant test (`tests/unit/host-spawn-semaphore-burst-invariant.test.ts`) fails any build where live holders can exceed the cap under a 10k-attempt storm (the Bounded-Accumulation proof).

- **Overlap strength:** Partial and domain-specific. It identifies correctness/authorization checks as narrower than the physical-safety property and adds a stress input that can pass local correctness while failing the broader claim.
- **Already covers:** P1; P2/P3 through the MEANING-versus-MASS distinction; part of P4/P5 through the 10,000-attempt burst invariant.
- **Does not cover:** Explicit measure/certify statements per check; full equality; non-resource checks.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. Its funnel lint and burst test concern subprocess/resource concurrency.

### Capacity Safety — No Unbounded Self-Action

> **Rule.** Any **self-triggered** action that bears cost or disruption — a restart, swap, respawn, spawn, notify, retry, re-drive, re-pin, or kill/reap request that a loop, monitor, sentinel, reaper, scheduler, or recovery path fires on its own — must be **proven to CONVERGE under sustained worst-case pressure** before it ships: the number of times it fires must settle to a small bound even when the triggering condition never clears on its own. Safety that reasons only about *correctness* (is each action well-formed / authorized?) and never about *convergence* (does the action count settle, or does it feed the pressure that re-triggers it?) is semantically flawless and dynamically unstable — a control loop that oscillates forever while every individual tick passes review. The temporal twin of *Bounded Blast Radius* (which bounds instantaneous MASS — how many run at once); this bounds steady-state FREQUENCY under feedback. A per-tick cap is not a convergence proof — it bounds one pass, never the loop.

- **Overlap strength:** Direct for convergence checks. “A per-tick cap is not a convergence proof” is the same narrower-measure/broader-certification failure.
- **Already covers:** P1; P2 by distinguishing per-tick correctness/caps from steady-state frequency; P3 by naming convergence as the certified property; part of P4/P5 through a sustained-worst-case proof in which the trigger never clears.
- **Does not cover:** Every check; an explicit written equality argument; non-self-action properties.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. `self-action-convergence.test.ts` and the registration lint exercise self-triggered controllers under sustained pressure, not access-control test semantics.

### The Operator Channel Is Sacred — Critical-Path Gates Fail Toward Delivery

> A gate on the operator's PRIMARY communication channel (inbound user messages) must never CONSUME or block a message on a single brittle, low-confidence, or *failed* signal.
>
> **a message-CONSUMING decision requires a DETERMINISTIC match, never a bare-LLM guess** (an LLM "pause" verdict self-reports high confidence regardless of correctness)

- **Overlap strength:** Weak and domain-specific. It refuses to let a narrow or unreliable signal certify the broader decision needed to consume a message.
- **Already covers:** P1 and a scoped P2/P3 distinction between the observed signal and the consuming conclusion; the self-reported-confidence example is a pass-looking signal that is not proof.
- **Does not cover:** Explicit P2/P3 fields; P4 set equality; P5 as a general authoring question; checks outside inbound operator gates.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. Its route-through behavior, circuit breaker, and counters are specific to `MessageSentinel` consume/pause paths.

### The Agent Is Always Reachable — A Guaranteed Reachability Floor

> **Liveness, not existence** — "reachable" means a session that actually RESPONDS; a wedged/walled session (context-wedge, AUP-rejection, rate-limit) that exists-but-rejects is floor-UNMET and triggers a fresh respawn, never reported as reachable.

- **Overlap strength:** Weak but exact in shape. It rejects an existence check as certification of liveness.
- **Already covers:** P1 for “session exists” versus “session is reachable,” and it states the semantic property a reachability check must exercise.
- **Does not cover:** P2/P3 declarations; P4 equality; P5 as a reusable question; non-liveness checks.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. Its lifeline-protection, pressure-notice, and liveness-floor tests do not inspect authorization tests.

### Iterative Audit to Convergence

> **Rule.** An audit is never one-off. A single pass has blind spots, and the fixes themselves reveal or introduce new instances. The only honest definition of "thorough" is *converged*: audit → fix → **RE-audit** → … until a clean pass returns **zero new discoveries**. An audit stopped for any other reason (time, budget, patience) is INCOMPLETE — and must be reported as incomplete, never dressed up as thorough.
>
> **Traces to the goal.** Coherence requires that "I checked" mean the same thing every time.

- **Overlap strength:** Partial. It binds the certification word “thorough” to a stronger process than a single pass and forbids a narrower sweep from being reported as the broader claim.
- **Already covers:** P1 and P3 for audit thoroughness; part of P4 by defining the evidence required before “converged” may be claimed; a process-level P5 through re-auditing for instances the prior pass missed.
- **Does not cover:** P2/P3 declarations per individual check; equality of the inputs passed by a check and the property claimed; non-audit checks.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. The convergence stamp validator verifies report form, multiple rounds, dispositions, and a zeroed final round. The registry expressly says it cannot make a form-valid but shallow audit deep, and it does not inspect individual test assertions.

### Live-User-Channel Proof Before Done

> **Rule.** A user-facing feature is not "done" until a user-role session has exercised it end-to-end **through its real user surface — Telegram AND Slack for a channel feature, the real dashboard for a dashboard feature — across the required risk categories, in a LIVE environment, BEFORE the operator is ever asked to test.**
>
> **Earned from.** 2026-06-15 (topic 13481): the multi-machine topic transfer reported `ok:true` but never moved the seat; the operator found it on the **first** live test. Every prior "test" was unit/integration or a half-done test-as-self loop — none drove the real channel as a user.

- **Overlap strength:** Direct for a “done” certification on user-facing features. It identifies lower-tier success and `ok:true` as narrower than the real outcome.
- **Already covers:** P1; P3 (“done”); part of P4 through a required real-surface scenario matrix; part of P5 through required permission, failure, concurrency, idempotency, and regression categories.
- **Does not cover:** An explicit P2 measure declaration; an explicit set-equality argument; non-user-facing checks; arbitrary unit-test claims.
- **Would its stated enforcement catch the proposal’s concrete failure?** Conditional, not general. The stated completion gate could catch it if “untrusted agents get no operations” is part of a user-facing feature and the signed live scenario matrix actually includes the untrusted-permission case. It does not statically reject the example’s list-only assertion.

### Distrust Temporary Success — A Recurrence Is a Root Cause

> A patch that resets a symptom is not a fix, and a system that recovers on its own will make a code-level bug look transient forever. Before declaring a thing fixed, verify the *cause* is gone — not just the symptom.
>
> The structural counter is to encode the distinction into the *definition of done* itself rather than to remember it — a completion criterion that says, in so many words, "a symptom-reset that recurs does NOT count as done."

- **Overlap strength:** Partial. It rejects a symptom-reset measurement as certification that the root cause is fixed.
- **Already covers:** P1/P3 for “symptom gone” versus “cause gone”; part of P5 by testing recurrence after the immediate pass.
- **Does not cover:** P2/P3 declarations per check; P4 equality; non-fix claims; arbitrary assertion semantics.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. Its completion criterion and P14 reviewer concern recurring symptoms and cause-removal claims.

### Verify the State, Not Its Symbol

> **Rule.** A detector, gate, verifier, or sentinel must confirm the **state of the world** it claims to detect — never accept a **symbol** of that state (a string, label, marker, filename, or the mere presence/absence of a proxy signal) as proof the state holds. The failure runs in both directions: the *presence* of a symbol is not the condition being true, and the *absence* of a signal is not the condition being true.
>
> **In practice.** Three teeth, one per failure mode. **(A) Corroborate before firing** — pair every fire with a second signal *causally tied to the real state and unfakeable by an impostor state*;

- **Overlap strength:** Direct and broad. A returned value being a list is a symbol/proxy; “contains no operations” is the state the example claims to prove.
- **Already covers:** P1; an implicit P2/P3 distinction between proxy signal and claimed world-state; part of P4 by demanding causal corroboration unfakeable by an impostor state; P5 through the explicit “impostor state” analysis.
- **Does not cover:** Explicit per-check “measures” and “certifies” statements; a formal equality argument rather than corroboration; all tests unambiguously, because its named scope is detectors, gates, verifiers, and sentinels.
- **Would its stated enforcement catch the proposal’s concrete failure?** Conditional. The `/spec-converge` P20 reviewer is stated to flag detectors that fire on a single uncorroborated symbol, so it could flag this design if the check is described in a reviewed spec. The generic `no-uncorroborated-symbol-fire` ratchet is explicitly still tracked, so no stated build-wide mechanism guarantees that an arbitrary list-only test is caught.

### Framework-Agnostic — and Framework-Optimizing

> **Enforced by (structure, not willpower).** A new feature touching the session **launch / inject / resume** surface is held to this standard by three layers, so "works for every framework" is true by construction:
>
> - **Review gate.** The `/instar-dev` precommit gate (`scripts/instar-dev-precommit.js → assertFrameworkGenerality`) requires the side-effects artifact of any change to the launch/inject abstraction to explicitly state whether it works for codex-cli and gemini-cli — so the *subtler* Claude-specific assumptions a static test can't see get reasoned about in review.

- **Overlap strength:** Weak but explicit. It scopes what the static test measures and adds semantic review for the broader certification “works for every framework.”
- **Already covers:** P1 for this portability check; part of P2/P3 by separately naming static conditions and framework-wide behavior; part of P5 through review of assumptions the static test cannot see.
- **Does not cover:** A claim that the static and certified sets are equal—in fact it says the static test is insufficient alone; a per-check equality argument; checks outside launch/inject/resume portability.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. Its compiler, CI, and review gates are scoped to execution-framework portability.

### An Instar Agent Is Always a Multi-Machine Entity

> **Distinct from Cross-Machine Coherence.** Its sibling above governs the *robustness of the lease / seamlessness layer* under degraded conditions — the machinery that keeps N machines from becoming two agents. This one governs the *default posture of every new feature*: that machinery only makes the agent whole if features actually ride it. The per-feature posture check (2026-06-12 widening, above) already exists — but it verifies a feature *declares* a posture and accepts "machine-local BY DESIGN" as a valid declared answer, so a wrong posture (machine-local where unified was correct) passes the check by being *declared*. The gap this closes: the check tested for a declaration, not for the unified DEFAULT.

- **Overlap strength:** Direct as a concrete instance of the proposed failure. The registry itself says what the old check tested and identifies a failing state that still passed it.
- **Already covers:** P1; P2 (declaration presence); P3 (the unified-by-default posture the check was treated as establishing); P5 (machine-local where unified was correct but still passes).
- **Does not cover:** The general P2/P3 authoring format; a general P4 equality argument; checks outside multi-machine posture.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. Its marker lint and semantic reviewer concern `machine-local-justification` in specs. They would not inspect an untrusted-agent operations test.

### Testing Integrity

> **Rule.** Every significant feature requires all three foundational test tiers — unit, integration, and E2E lifecycle — plus wiring-integrity tests for every injected dependency and semantic-correctness tests for both sides of every decision boundary. No exceptions. For agent-facing and experiential behavior, the highest tier is **Test-as-Self**.
>
> **Earned from.**
> - Tiers 1–3: features that shipped green-on-unit-tests but were never instantiated (e.g. sentinels wired as dead code with a false "wired into server startup" claim) — proof that lower tiers can all pass while the feature is functionally absent.

- **Overlap strength:** Direct but less explicit about documentation. The proposed example fails the requirement for semantic-correctness tests on both sides of the authorization boundary.
- **Already covers:** P1; P3 for claims that a feature is alive or behaviorally correct; much of P5 through tests on both sides of every decision boundary and real-interface Test-as-Self.
- **Does not cover:** Explicit P2 and P3 statements attached to every check; an explicit P4 set-equality argument; insignificant features; the proposal’s exact authoring-time wording.
- **Would its stated enforcement catch the proposal’s concrete failure?** The rule would classify the list-only test as insufficient, but the registry entry names only full-spec documents and no generic build-time enforcement mechanism for semantic boundary completeness. On the enforcement mechanism actually stated in this entry: no guaranteed catch is established.

### Scrape/Parser Fixture Realness — feed the parser the REAL bytes

> **Rule.** A parser of untrusted real-world text is only as good as the realness of its test input. Every **registered** scrape/parser must have a test that FEEDS it a structurally-real captured fixture — genuine wrapping/ANSI/spacing/line-breaks/partial-frames preserved byte-for-byte — and asserts on the result, never a hand-authored clean string.
>
> **Earned from.** The `code=t` bug (2026-06-18): `FrameworkLoginDriver.parseArtifact` turned a live `claude auth login` tmux pane into a `{verificationUrl,…}` artifact, but was tested ONLY against tidy single-line strings the author wrote. The real pane hard-wrapped the long OAuth URL across lines with no inserted space; the scrape stopped at the first wrap and shipped a useless `…?code=t` placeholder to the operator. Every unit test passed because every input was clean.

- **Overlap strength:** Direct for parser tests. It identifies a passing input subset that is narrower than the real-world input property the test was taken to certify.
- **Already covers:** P1; P2 by prescribing structurally real captured bytes; P3 by tying the test to real-world parser behavior; a scoped P4/P5 through real captured fixtures that include the structure clean strings omit.
- **Does not cover:** Explicit “measures”/“certifies” statements; proof of full set equality; non-parser checks.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. The fixture-realness lint is limited to registered scrape/parser tests and their sanctioned captured-fixture loader.

### Observability — you can't tune what you can't see

> **Rule.** Every feature ships with metrics that make its effectiveness auditable and gradable, and that observability is itself an input to how the agent evolves. Meter the *whole* loop, not just the half that's easy to count.
>
> **In practice.** Counters at every stage of a pipeline, exposed on a read-only operator surface — and the metering covers the full funnel, not just the front of it. The topic-intent capture loop is the model: it meters captured → surfaced → used → corrected, so we can see exactly where the loop leaks (capturing nothing? capturing but never surfacing? surfacing but never acted on?). Metrics feed the evolution loop rather than just decorating a dashboard: the human-as-detector heat map grades what the guardians *missed*, and a recurrence count can itself become the data-driven trigger to propose a new standard. A capture-only metering set is a half-measure — it can't tell you whether what you captured ever changed anything.

- **Overlap strength:** Partial. It rejects a narrow front-of-funnel metric as certification of whole-loop effectiveness.
- **Already covers:** P1; P2 by requiring whole-loop measurements; P3 by naming effectiveness as the property to grade; part of P5 by requiring metrics for misses and downstream leakage.
- **Does not cover:** Tests/checks generally; explicit P2/P3 statements per metric; P4’s equality argument.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. The entry states a metrics design discipline but no general assertion-semantics guard.

### Expected Capacity Enforcement Is an Outcome, Not a Degradation

> **In practice.** A capped record carries a durable per-record outcome flag or equivalent metadata, and its read/stat surface counts those outcomes. Tests cross process restarts and budget-window boundaries: repeated successful enforcement remains queryable but produces zero degradation/feedback events. Every bounded writer registers a versioned contract in `docs/capacity-enforcement-contracts.json`, carries its exact source marker, returns the shared typed `CapacityEnforcementResult`, and binds its invariant-failure report annotation to the same contract revision. The lint checks only those mechanically enumerable facts; semantic review remains the authority for whether a capacity policy is correctly classified.

- **Overlap strength:** Weak but explicit about enforcement scope. It states what the lint measures and refuses to treat that structural result as semantic certification.
- **Already covers:** A scoped P1/P2 distinction; part of P3 by reserving semantic classification to review; it prevents silent over-reading of lint success.
- **Does not cover:** P4 equality—the two layers are deliberately not equal; P5; checks outside bounded-store capacity contracts; a required author-written measure/certify pair.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. The lint and restart-spanning proof concern capacity-enforcement contracts and degradation classification.

### A Refusal Stays a Refusal — conservation of negative outcomes

> **Rule.** A terminal negative outcome — a refusal, rejection, veto, or drop — must remain **distinguishable from success at every boundary it crosses**. No adapter, ack protocol, or result mapping may collapse a rejection into a success-shaped value. Ack vocabularies name what was actually promised (wire-accepted / durably-queued / injected-into-session are DIFFERENT claims, and a caller may not believe more than was promised).

- **Overlap strength:** Direct for acknowledgement/result checks. It requires the success token to certify no more than the exact event it measures.
- **Already covers:** P1; P2/P3 for acknowledgement vocabularies; a scoped P4 requiring negative outcomes never enter the success set; P5 through rejection-to-success mapping tests.
- **Does not cover:** Every check; a general equality argument; positive properties unrelated to refusals or acknowledgements.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. `silent-loss-route-outcome-ratchet.test.ts` pins rejection mapping at `SessionRouter`; it does not inspect arbitrary operation-list assertions.

### Runtime End-to-End Proof — the canary standard

> **Rule.** For every critical user-visible outcome — a message actually arrives in a session, a reply actually lands with the user — a **synthetic probe exercises the full real path on a cadence**, and a missed or contract-violating round-trip alerts. Component liveness is never accepted as proof of outcome: "online", "polling", and "acked" are statements about organs, not about behavior.

- **Overlap strength:** Direct for runtime canaries. It explicitly states that the narrower component measurement does not certify the end-to-end property.
- **Already covers:** P1; P2 (component versus full-path probe); P3 (critical user-visible outcome); part of P4/P5 through a typed end-to-end contract and contract-violating probes.
- **Does not cover:** Explicit per-check measure/certify prose; full set equality; non-critical or non-user-visible checks.
- **Would its stated enforcement catch the proposal’s concrete failure?** No in the general case. Its delivery-canary job probes declared critical user-visible outcomes. It would not reject the example unit test merely because its assertion checks only the return type.

### Migration-Consumer Completeness

> **Rule.** A canonical authority migration is incomplete until every authorization, validation, routing, and compatibility consumer of the replaced authority moves in the same unit of work, with tests that exercise the new canonical source through those consumer boundaries. A producer-only migration is not partial progress; it is a split-brain contract.
>
> The lint proves synchronized structural review of the declared boundary; review remains the semantic authority for whether the declaration and changed tests are actually complete.

- **Overlap strength:** Partial and domain-specific. It says the structural lint’s passing set is not the same as the semantic completeness claim and assigns the latter to review.
- **Already covers:** P1; part of P2/P3 by distinguishing structural synchronization from actual completeness; P5 through consumer-boundary tests.
- **Does not cover:** P4 equality—the mechanism is intentionally two-layered; every check; an author-written measure/certify statement.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. The manifest/marker lint is limited to registered canonical authority migrations.

### Canonical Pipeline Operational Completeness — Accepted Intake Must Drain

> **Rule.** A canonical accepted intake must have an authoritative admission decision, one durable owner and fenced lease, operated cadence, an explicit terminal or governed waiting disposition, backlog-age and progress observability, and an end-to-end positive control proving the real consumer advances the handoff.
>
> `scripts/lint-canonical-pipeline-completeness.mjs` rejects missing registry coverage, owner/handoff/consumer declarations, comment-only membership, broken citations, incomplete edge declarations, and uncollected runtime evidence. The lint emits structural coverage evidence only: constructed runtime tests and semantic review remain authoritative for actual liveness, effective idempotency, cadence, and progress.

- **Overlap strength:** Direct for canonical-pipeline completeness checks, but not general. It states the lint’s exact evidentiary ceiling and names the broader properties separately.
- **Already covers:** P1; P2 and P3 for the structural-lint versus operational-completeness distinction; P5 through a production-adapter positive control and semantic review.
- **Does not cover:** P4 equality—the stated solution combines multiple mechanisms rather than arguing the lint alone equals the certification; arbitrary checks.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. The closed manifest, lint, and named runtime positive controls apply only to canonical pipelines.

### Bounded Notification Surface — no feature may flood the user

> **Rule.** Any code path that can create user-facing notification containers (Telegram topics today; any channel tomorrow) must be bounded by a hard budget enforced at the creation chokepoint — not in each feature's good intentions — and any emitter that loops over a collection must aggregate (one summary notification, never one per element). A feature whose failure mode includes "notify N times for N inputs" may not ship without a burst test proving the bound holds.
>
> The THIRD topic-spam flood (2026-06-05): a boot-time worktree detector read a transiently-wrong agent registry (lost-update race + a silent parse-failure→empty-list fallback), mass-flagged 110 properly-placed worktrees as misplaced, and emitted one attention item PER worktree — each with a unique `sourceContext`, which dodged the per-source budget the 2026-05-28 lockdown (flood #2) had added; only the global ceiling caught it, after 8 topics leaked plus a 103-ping coalesced topic.

- **Overlap strength:** Partial and domain-specific. The unique-`sourceContext` case is an input that passed the narrower per-source budget while failing the claimed anti-flood property.
- **Already covers:** P1; P3 (bounded notification volume); P5 through the required N-input burst test and the recorded budget-bypass input.
- **Does not cover:** Explicit P2 measurement statements; P4 set equality; non-notification checks.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. Its topic-creation funnel, budget, and burst proof are specific to notifications.

### No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes

> **Rule.** Any code path that repeats an action — a retry, a poll, a monitor tick, a recovery attempt, a sync flush — must ship with all three brakes built in: **backoff** (the interval between failed attempts grows), a **breaker** (after sustained failure it stops attempting and surfaces the degradation once, instead of trying forever), and a **cap** (a hard bound on the work one attempt may generate — payload size, processes spawned, log lines, notifications). A repeating behavior with no brakes is not "simple code" — it is a standing invitation for the compounding failure mode: the loop's own work makes the condition it is retrying against worse. No raw loop ships; a PR adding one must show the three brakes and a test that proves the bound holds under sustained failure.
>
> Ask three questions of every `setInterval`, `while`, and retry-on-failure path: (1) *If the target rejects every attempt for an hour, how many attempts run and what does each cost?* — "720 attempts, each rebuilding a payload" means no backoff and no breaker.

- **Overlap strength:** Partial and domain-specific. It binds the claimed loop bound to a sustained-rejection test rather than a happy-path or single-attempt check.
- **Already covers:** P1; P3; part of P4/P5 through the permanently rejecting target and explicit cost/attempt counterexample.
- **Does not cover:** P2 declarations; full set equality; checks outside repeating behavior.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. Its loop-safety audit and sustained-failure test pattern are scoped to repeating behavior.

### Judgment Within Floors

> **Rule.** A decision point with competing signals or non-enumerable context may be delegated to an LLM arbiter only inside a deterministic floor: the floor defines the complete safe action space and a conservative default; invariants are never delegated; the arbiter can narrow but never widen; an arbiter choice with irreversible consequence requires mechanical corroboration, never free-text evidence alone; fallback follows the bench-ranked ladder and always ends at a deterministic rung; and an arbiter may begin ACTING (beyond shadow) only after shadow-phase evidence shows it beats the deterministic default on the decision point's named success criteria — evidence before authority.

- **Overlap strength:** Partial. It binds authority to evidence on named success criteria and rejects weaker evidence types for irreversible consequences.
- **Already covers:** P1 for free-text or shadow evidence that is too narrow; P3 through named success criteria; part of P4/P5 through mechanical corroboration and comparison against the deterministic default.
- **Does not cover:** P2/P3 declarations for every check; exact pass-set equality; non-LLM-arbiter checks.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. Its stated implementations concern spawn admission, survivor floors, routing registries, and arbiter batteries.

### Decision Provenance & Outcome Review

> **Rule.** Every LLM judgment call durably logs the full context it was handed and the decision it made — scrubbed, retention-bounded, machine-local-full/HTTP-redacted — and every judgment point is outcome-annotated where ground truth exists and periodically graded against outcomes, with graded real cases feeding its bench battery. An unlogged judgment call is an unaccountable one.

- **Overlap strength:** Weak but real. It evaluates a judgment check against ground-truth outcomes and feeds cases where the decision and outcome diverge back into its battery.
- **Already covers:** Part of P1/P3 by separating the judgment made from the real outcome; part of P5 through graded real cases.
- **Does not cover:** P2/P3 declarations; P4 equality; deterministic or ordinary test checks; an author-time counterexample requirement.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. `JudgmentProvenanceLog` and the graded-review job concern LLM judgment points, not arbitrary test assertions.

### Stall Coverage Is Enumerated, Not Discovered

> **In practice.** The canonical class list is a code constant (`src/data/stall-classes.ts`) mirrored by the spec table with a lint asserting agreement; every `IntelligenceFramework` member must carry a matrix at `docs/frameworks/<framework>-stall-coverage.md` (a missing file is a red build, not a silent pass); `covered` is earned only by resolvable detector/recovery symbols PLUS positive-control evidence containing the framework's RAW stall signature in a test the push suite actually collects (symbol existence alone never earns `covered` — *Verify the State, Not Its Symbol*);

- **Overlap strength:** Direct for a coverage certification. It explicitly says a narrower symbol-existence check cannot certify `covered`.
- **Already covers:** P1; P2/P3 through the distinction between symbol existence and `covered`; part of P4/P5 through raw-signature positive controls collected by the real push suite.
- **Does not cover:** Every check; explicit prose fields named measures/certifies; proof of full set equality; non-stall properties.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. The matrix validator and CI ratchet are scoped to framework stall classes.

### Bug-Fix Evidence Bar (verify before you claim)

> **Rule.** Never claim something is fixed, wired, or working until the original failure has been reproduced and verified to stop. Unit tests are not evidence. Before saying "wired in," grep for both construction *and* the start/call site.
>
> **In practice.** Green CI + passing unit tests ≠ instantiated and running. "Shipped" requires observing the real behavior change.

- **Overlap strength:** Direct for “fixed/wired/working/shipped” certifications. It rejects a narrower passing test suite as sufficient proof of the claimed behavior.
- **Already covers:** P1; P3; much of P5 by reproducing the original failure and verifying it stops; part of P4 by requiring observation of the real behavior rather than accepting unit-test success.
- **Does not cover:** Explicit P2 measurement statements; a general set-equality argument; checks unrelated to bug-fix or shipping claims.
- **Would its stated enforcement catch the proposal’s concrete failure?** At the rule level, reproducing “unknown agent receives dangerous operation” would expose the failure. The registry entry, however, states no dedicated enforcement mechanism for this article. Therefore no automatic catch is established by its own stated mechanism.

### A Dark Feature Guards Nothing

> **Rule.** When an incident or a path analysis shows that a **load-bearing path depends on a feature that ships dark, disabled, or dry-run**, that is a forced decision point: **graduate it, or record explicit operator acceptance of the manual fallback**. A safety automation that exists only dark is, for the fleet, prose — the fleet's real posture is the DARK posture.

- **Overlap strength:** Weak. This is claim-versus-reality overlap, not check-authoring overlap: the existence of code is a narrower fact than the certified fleet protection.
- **Already covers:** P1 for “feature exists” versus “fleet is guarded”; P3 for the protection claim; part of P5 by asking which dark features would have prevented or shortened an incident.
- **Does not cover:** P2; P4; every check; test assertion semantics.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. Guard-posture classification and alerts concern dark load-bearing runtime features.

### Side-Effects Review Gate

> **Rule.** No fix ships, however simple, without a side-effects review: over/under-reach, level-of-abstraction fit, signal-vs-authority compliance, interactions with adjacent systems, and rollback cost.

- **Overlap strength:** Weak. “Under-reach” can include a check that proves less than the fix claim, but this article is a change-review gate rather than a check-specification rule.
- **Already covers:** Part of P1 and P5 by requiring under-reach review and signal-versus-authority analysis.
- **Does not cover:** P2–P4; an explicit test counterexample; a mandate applying to every check.
- **Would its stated enforcement catch the proposal’s concrete failure?** Conditional and not guaranteed. The precommit mechanism refuses a missing side-effects artifact, but the entry does not state that it semantically validates whether the artifact noticed the weak assertion. A reviewer could catch the under-reach; the structural presence check alone would not.

### The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred

> **Rule.** The user's ability to **reach** a live agent, **be heard**, and get a **timely, coherent response** is a first-class invariant that **outranks internal caution when the two conflict**. No internal guard, safety net, resource limit, or self-continuity discipline may *silently* degrade the user's channel.
>
> Each component optimized its *local* safety, fail-closing toward "the agent does nothing wrong"; summed, they produced an agent that was internally pristine and **externally unreachable**.

- **Overlap strength:** Weak but explicit at the composed-system level. Locally passing safety checks were narrower than the whole-experience property they were collectively assumed to preserve.
- **Already covers:** P1; P3 for reachability/responsiveness/coherence; part of P5 through verification of user-facing invariants after mutations and the documented local-pass/global-fail counterexample.
- **Does not cover:** P2 statements for each guard; P4 equality; ordinary tests unrelated to the user path.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. The stated implemented teeth concern graceful degradation of `MessagingToneGate`; the other sub-standards are tracked, and none inspect arbitrary list-only assertions.

### Operator-Surface Quality

> It passed because no gate measured *quality* — only existence and reachability.

- **Overlap strength:** Direct as a domain-specific failure instance. The text explicitly names what the old gates measured and the broader property they failed to establish.
- **Already covers:** P1; P2 (existence and reachability); P3 (operator-surface quality); P5 through the concrete passing-but-bad surface.
- **Does not cover:** General P2/P3 declarations; P4 equality; checks outside operator UI; arbitrary test assertions.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. Its precommit assertion and raw-input scan apply only to operator surfaces.

### Dashboard UX Standard — Reachable, Self-Explanatory, Responsive

> **In practice.** Floors are additive and brought in tab-by-tab — a floor gates a new regression, never blocks an unrelated change. Each pairs the #1403 pattern: a negative control proving the test fails when the floor is violated, plus a population floor so a regressed matcher fails loudly, not silently.

- **Overlap strength:** Partial and domain-specific. The required negative control is a concrete form of the proposal’s “what passes while the claim fails?” challenge to a check.
- **Already covers:** P5 directly for each dashboard floor; part of P4 by requiring evidence that the check rejects a known violation; P3 through eleven named floor claims.
- **Does not cover:** P2 statements; full equality of passed inputs and floor-satisfying inputs; non-dashboard checks.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. The negative controls and floor tests concern dashboard layout, reachability, interaction preservation, glance budgets, and drill-down behavior.

### Agent Proposes, Operator Approves

> **Rule.** When the agent needs the operator to authorize, decide, or confer authority, the agent MUST pre-fill the complete structured request and the operator's surface MUST present it as a plain-language **approval** (approve / decline + credential), never as a construction or authoring task. A surface that makes the operator assemble — from fields the agent already knows — what the agent could have pre-filled (picking enum values, editing JSON/bounds, naming fingerprints, choosing scopes) is a defect, even if every field is individually valid. **Corollary (display integrity):** the authority statement the operator approves must be authored by the server from the structured request and trusted data, never from agent free-text — what is shown and what executes cannot be allowed to diverge.

- **Overlap strength:** Direct for an authorization check. The displayed statement is what the operator measures; the executed structured request is what approval certifies; the standard requires them not to diverge.
- **Already covers:** P1; P2/P3 for approval display versus executed authority; a scoped P4 equality requirement; P5 through the described divergence risk.
- **Does not cover:** Every test/check; an explicit author-written equality argument; checks outside operator authorization.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. Its operator-surface assertion and server-authored authorization card are specific to approval flows.

### Constitutional Traceability — No Unconstitutional Work

> The fit is *judged, not asserted*: a hand-wave parent ("this loosely relates to coherence") fails the same as no parent — the judgment is made by the full-context conformance reviewer reading the registry and the spec (an LLM authority per **Signal vs. Authority**, not a string match), which is exactly why it may hold blocking authority.
>
> Hardens the existing **Standards-Conformance Gate** (`src/core/reviewers/standards-conformance.ts`; `POST /spec/conformance-check`) from signal-only/advisory into a **blocking, auto-invoked** ship-gate check: commit-time, `scripts/instar-dev-precommit.js` requires a staged spec's `parent-principle` to resolve to a real registry article (structural, always-on); review-time, the reviewer returns a `fit`/`weak`/`none` verdict (a net-new verdict dimension) so a non-fit is resolved before approval.

- **Overlap strength:** Weak but structurally analogous. It separates a narrow measurable condition (a parent marker resolves) from the broader certification (the work actually fits the parent), and gives the broader question semantic review.
- **Already covers:** P1; a scoped P2/P3 distinction; part of P5 through rejection of a hand-wave that passes only the marker check.
- **Does not cover:** P4 equality—the layers are complementary, not equal; test/check authoring generally; the proposed counterexample question.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. The marker and conformance reviewer evaluate constitutional fit of specs, not whether an individual test assertion proves its test name.

### Signal vs. Authority

> **Rule.** Brittle, low-context filters detect and emit *signals*. Only a higher-level, full-context intelligent gate has *blocking* authority.
>
> **In practice.** A fast regex or a cheap classifier may flag, never veto. The expensive, well-grounded gate makes the final call.

- **Overlap strength:** Direct at the architectural level. It prevents a narrow measurement from being treated as certification authoritative enough to decide the broader property.
- **Already covers:** P1; a functional P2/P3 distinction between signal detection and authoritative judgment; part of P4 by refusing equality unless a full-context gate supplies the missing scope.
- **Does not cover:** Explicit per-check measure/certify statements; a required equality argument; P5’s counterexample question; test assertions that produce no runtime authority decision.
- **Would its stated enforcement catch the proposal’s concrete failure?** No guaranteed catch. The entry names an architectural pattern and a full spec but no registry-stated generic test-assertion enforcement mechanism.

### Self-Heal Before Notify — The Operator Hears Only When Self-Healing Fails

> a NON-EMPTY `remediation-actions` list (the anti-no-op floor — an empty list is the fake heal that merely unlocks escalation)
>
> This is the deterministic SIGNAL; the `/spec-converge` reviewer holds the AUTHORITY on whether a declared heal is SUBSTANTIVE and its severity class HONEST.

- **Overlap strength:** Weak but explicit. It identifies a declaration that can structurally pass while substantively failing, adds an anti-no-op boundary, and limits what the deterministic lint is allowed to certify.
- **Already covers:** P1; a scoped P2/P3 distinction between declaration shape and substantive healing; P5 through the empty-list/no-op counterexample.
- **Does not cover:** P4 equality—the reviewer, not the lint, supplies semantic authority; checks outside self-heal declarations; the general authoring discipline.
- **Would its stated enforcement catch the proposal’s concrete failure?** No. The schema lint and reviewer are scoped to watcher self-heal declarations and notification escalation.

## Coverage summary

All **82 of 82** registry standards were examined. The 38 entries above are the standards whose text explicitly does at least one of the following: rejects a proxy/component/symbol as proof of a claimed property; requires real, boundary, negative-control, or adversarial evidence tied to a claim; states the evidentiary ceiling of a structural check; or records a concrete passing-check/broader-failure mismatch. The remaining 44 standards do not state one of those relationships closely enough to establish clause-level overlap with the proposal.
