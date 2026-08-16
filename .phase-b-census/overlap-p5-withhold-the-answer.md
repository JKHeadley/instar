# Overlap census: “When you send something to check your work, give it the question and withhold your answer”

## Coverage and search method

- Registry population: **82 standards** (all `###` headings in `docs/STANDARDS-REGISTRY.md`).
- Standards actually examined: **82 of 82**.
- File coverage: **all 787 lines / 252,764 bytes** were read, from line 1 through line 787.
- Structural sweep: inventoried every `###` heading, then read every standard's rule, practice, provenance, goal trace, and stated enforcement/applied-through text.
- Meaning-based sweeps:
  - checker contamination, anchoring, confirmation bias, sycophancy, and prompts that disclose an expected result;
  - reality-grounded verification versus proxy, symbol, assumption, or self-contaminated evidence;
  - independent/repeated audit and corroboration rather than treating one check as dispositive;
  - tests that exercise the real mechanism instead of bypassing it with supplied knowledge;
  - measurements whose subject or cause is guessed rather than established;
  - the distinction between a checker's signal and the authority assigned to its execution result;
  - logging the exact context handed to an LLM judgment and grading it later against ground truth;
  - structural enforcement of review disciplines rather than reliance on remembered instructions.
- Lexical corroboration accompanied the semantic read using families including `expect`, `assum`, `bias`, `independen`, `checker`, `review`, `guess`, `hypothes`, `verif`, `audit`, `question`, `answer`, `measure`, `instrument`, `delegat`, `dispatch`, `blind`, `withhold`, `confirm`, `sycoph`, `authority`, `verdict`, `anchor`, `leak`, and `contamin`. Candidates were included only where registry text covers at least part of a proposal clause; merely mentioning tests, reviewers, or dispatch was not enough.

For clause comparison below, the proposal is separated into these specific claims:

- **P1 — Dispatch form:** when sending work to a checker, supply the question.
- **P2 — Answer withholding:** do not supply the expected answer, preferred verdict, causal guess, or known pointer location.
- **P3 — Failure model:** a checker can echo the sender's assumption and make it look stronger because it was executed.
- **P4 — Delegated-work scope:** the discipline applies to colleagues, sessions, agents, and other delegated checkers.
- **P5 — Instrument scope:** the discipline also applies to measurements, tests, detectors, verifiers, and other instruments.
- **P6 — Mechanism-integrity case:** withhold information that would let the checker bypass the mechanism actually under test.

## Overlapping standards

The entries follow registry order. “Weak” describes the narrowness of clause overlap, not importance.

### Structure beats Willpower

**Overlap strength:** Weak, meta-level overlap.

**Verbatim registry evidence:**

> **Rule.** If a behavior matters, enforce it in architecture, not in instructions. Never rely on an agent "remembering" to follow a rule buried in a long prompt.
> **In practice.** Session-start hooks inject context automatically; programmatic gates enforce required steps; dispatch tables route decisions; behavioral hooks guard against anti-patterns. A 1,000-line prompt is a wish; a 10-line hook is a guarantee. This root rule now self-applies through the `scripts/standards-coverage.mjs` ratchet, wired as **Standards Enforcement Coverage** in `.github/workflows/ci.yml`: the build fails when aggregate or per-family named-guard coverage falls below its committed floor, so the registry's own enforcement record no longer depends on remembering this paragraph.

**Proposal clauses already covered:** The structural form of P1–P2 if answer-withholding is behavior that matters: it should be enforced by the dispatch/checking architecture rather than left as a remembered instruction. The reference to dispatch tables also places delegated routing within the standard's implementation vocabulary.

**Proposal clauses not covered:** No requirement to give only a question, withhold an answer or hypothesis, protect checker independence, avoid anchoring, distinguish delegated work from instruments, or test a pointer mechanism without revealing the pointer. It does not state P3's execution-authority failure model.

**Would its stated enforcement catch the described failure?** **No.** The standards-coverage ratchet checks whether named guards exist and coverage floors hold; the quoted enforcement does not inspect checker prompts for disclosed expectations or evaluate whether a checker merely echoed them.

### The Body and the Mind

**Overlap strength:** Moderate for authority; none for withholding.

**Verbatim registry evidence:**

> **Rule.** An Instar agent is a composition of two intelligences. Its *structural intelligence* is the entire evolving **body** of its code AND documentation — the crystallized output of past evolution, which regulates and informs. Its *LLM intelligence* is the **mind** that reasons in the moment. The body informs the mind; past a threshold of importance it must inform the mind's decision, never make it. The mind holds final authority; structure is signal, not command.
> **In practice.** Every decision of consequence is made by the mind, *informed* by the body, and *recorded* — the structural signal, the choice, and its reasoning — because that record is how the body learns and both evolve. The temptation to let code, a regex, a gate, or a classifier *decide* something important past that threshold is the violation: make it *inform* the mind instead, and audit the call. The audit trail is exactly what makes "the mind decides" safe rather than a loophole.

**Proposal clauses already covered:** Part of P3: an executed checker result should remain a signal rather than acquiring decision authority merely because a tool, gate, or classifier produced it. It also covers recording consequential judgments, which can expose a false check after the fact. It reaches both P4 and P5 only when the delegated checker or instrument is functioning as the structural signal in such a decision.

**Proposal clauses not covered:** P1 and P2's dispatch-content rule; the instruction to omit the sender's answer, hypothesis, or pointer location; the specific anchoring/sycophancy mechanism; and P6's anti-bypass test design.

**Would its stated enforcement catch the described failure?** **Not reliably.** Its applied mechanisms audit decisions and constrain some classifiers to inform rather than decide. They could prevent a false checker report from becoming final authority or preserve it for review, but nothing stated inspects whether the checker's input contained the dispatcher's expected answer.

### Intelligent Prompts — An LLM Gate Must Not String-Match

**Overlap strength:** Weak to moderate; limited to a narrow way an expected answer can be embedded in an LLM prompt.

**Verbatim registry evidence:**

> **Rule.** When an LLM *gates* a decision, the PROMPT itself must judge by meaning. It must NEVER be authored to make the block/allow decision conditional on the presence of a literal string from a fixed list — that is a brittle filter wearing the LLM's authority: a paraphrase evades it, and the model's contextual judgment, its entire reason for being in the loop, is discarded. Brittle literal detection that is genuinely warranted (an error code, a command, a file path) belongs OUTSIDE the prompt: a deterministic detector emits a *signal*, the signal is supplied to the LLM as input/context, and the LLM decides *in context* what to do with it.
> **In practice.** A judgment rule's prompt states the *intent* it catches and judges any expression of it; example phrasings are explicitly illustrative, never a necessary condition.

**Proposal clauses already covered:** A narrow portion of P2–P3: a prompt must not turn supplied examples or literal expected forms into the condition that determines the verdict, and it identifies the danger of a brittle rule borrowing an LLM's authority. This applies to the LLM-gate subset of P4/P5.

**Proposal clauses not covered:** It permits contextual signals and illustrative examples; it does not require withholding the sender's preferred answer, hypothesis, causal guess, or known location. It does not require question-only dispatches or checker independence, and it does not cover non-LLM colleagues or instruments.

**Would its stated enforcement catch the described failure?** **Usually no.** The stated ratchet catches necessary-literal-gate constructions and light rewordings. It would catch the narrow case where the disclosed expected answer was encoded as a required literal. The entry expressly says arbitrary semantic prompt problems still require human review, so ordinary expectation leakage could pass.

### Quantitative Claims Must Bind a Subject

**Overlap strength:** Moderate but narrow to measurement/verifier errors.

**Verbatim registry evidence:**

> **Rule.** A verifier may compare a number only after binding both the measurement and the subject being measured. A shared unit or relation word is not semantic identity: “30 minutes in an offline-test window,” “one minute of detection latency,” “two hours remaining on the migration ETA,” and “two hours remaining in this session” are four different claims. A detector that sees only `duration + elapsed/remaining/in` and silently assumes “session clock” is a keyword classifier, not verification.
> **In practice.** Cheap deterministic extraction may nominate a structurally anchored measurement, but competing local subjects must DROP the candidate toward pass-through. Positive verification requires an explicit subject binding or an intentionally documented unqualified default backed by the caller’s typed context. Both sides are pinned together in one decision table: real elapsed/remaining/percent session-clock claims still reach the live clock, while test windows, latencies, queues, timeouts, outages, and task ETAs do not. New quantitative verifiers must carry the same paired boundary tests; a positive-only regex fixture is incomplete.
> **Traces to the goal.** Verification that checks the wrong subject manufactures contradictions instead of preventing them. A coherent agent must know what a number is about before declaring it true or false.

**Proposal clauses already covered:** Part of P3 and P5: an instrument/verifier may not silently substitute an assumed subject and then return a manufactured contradiction as verified fact. This overlaps the proposal's measurement example when the bundled causal guess also causes the measurement to be attached to the wrong subject.

**Proposal clauses not covered:** It does not say to withhold a hypothesis or answer, does not regulate dispatch to a colleague, does not address sycophancy or anchoring, and does not cover wrong causal guesses where the measured subject is correctly bound. It does not cover P6.

**Would its stated enforcement catch the described failure?** **Conditionally.** The paired decision table and both-side boundary tests would catch the documented wrong-subject false positive. They would not catch a correctly subject-bound measurement whose checker was biased by a disclosed causal guess.

### The Operator Channel Is Sacred — Critical-Path Gates Fail Toward Delivery

**Overlap strength:** Moderate but domain-limited; it explicitly covers a confident, incorrect LLM verdict and its false-positive consequences.

**Verbatim registry evidence:**

> **Rule.** A gate on the operator's PRIMARY communication channel (inbound user messages) must never CONSUME or block a message on a single brittle, low-confidence, or *failed* signal. The safe failure direction for inbound operator comms is DELIVERY — route the message to the agent. This is the deliberate INVERSE of *No Silent Degradation* (which makes OUTBOUND leak-gates fail CLOSED): a missed inbound control-signal (an un-honored "pause") is benign, but a *blocked* inbound message can sever the operator's ability to direct or recover the agent at all. Three corollaries: (1) **a message-CONSUMING decision requires a DETERMINISTIC match, never a bare-LLM guess** (an LLM "pause" verdict self-reports high confidence regardless of correctness) — and this route-through rule governs consume/pause gates whose missed signal is benign; it never loosens genuine emergency-stop, whose missed signal is *destructive*. The two are distinguished by CONSEQUENCE-OF-A-MISS, not by being the same gate. (2) **The load-bearing safety property is RECOVERABILITY:** a control action reachable by a brittle signal is acceptable only if its false-positive is escapable AND its recovery path does NOT route back through the failing gate (the inescapable-loop trap). (3) **Bounded blast radius for DECISION-gates** (the sibling of *Bounded Blast Radius* for spawns): a single misclassification must not be able to lock the operator out — a self-evidencing circuit-breaker auto-recovers when the operator keeps messaging.
> **In practice.** `MessageSentinel`'s `'pause'` consumes a message ONLY on a deterministic fast-path match; a bare-LLM or capacity-shed `'pause'` routes THROUGH (a capacity-shed result first runs a non-word-count-gated stop-token scan and fails toward STOP if a stop token is present, so a long-form genuine stop is never dropped). A durable, topic-keyed circuit-breaker shared across both inbound consume paths auto-recovers from a lockout (pause-only — never disarms emergency-stop). Structured counters (`sentinel.pause.consumed` / `.routed-through` / `.circuit-breaker.recovered`) make the gate's behavior observable. Full spec: `docs/specs/operator-channel-sacred.md`.

**Proposal clauses already covered:** P3 and P5 in the inbound consume-gate domain: a checker-like LLM verdict can be confidently wrong, so its execution and self-reported confidence do not make it sufficient evidence; false positives must have bounded consequences. It reaches P4 only where an LLM is delegated the consume/pause judgment.

**Proposal clauses not covered:** It does not require the dispatcher to provide only a question or to withhold an expected answer, causal guess, or pointer location. Its rule is specific to inbound consume/pause gates whose missed signal is benign, not general checking, colleagues, measurements, or mechanism tests.

**Would its stated enforcement catch the described failure?** **Conditionally, within its narrow surface.** The deterministic-match requirement, route-through behavior, and circuit breaker would prevent a bare LLM's false-positive pause verdict from consuming the message or making the lockout durable. They would not detect that an expectation was disclosed in a general checker prompt, nor catch a nonexistent defect outside the inbound gate.

### Iterative Audit to Convergence

**Overlap strength:** Moderate for avoiding dispositive reliance on one check; weak for independence.

**Verbatim registry evidence:**

> **Rule.** An audit is never one-off. A single pass has blind spots, and the fixes themselves reveal or introduce new instances. The only honest definition of "thorough" is *converged*: audit → fix → **RE-audit** → … until a clean pass returns **zero new discoveries**. An audit stopped for any other reason (time, budget, patience) is INCOMPLETE — and must be reported as incomplete, never dressed up as thorough.
> **In practice.** Run any "find all instances of X" sweep — security, safety, review, research — as the loop, not the pass: frame the target pattern + search surface + classification + convergence criterion; sweep; fix-or-classify each finding (an accepted finding is a written DECISION, not a TODO); then re-sweep the FULL surface (your search surface grew, and the fixes moved things).

**Proposal clauses already covered:** Part of P3–P4: one dispatched check is known to have blind spots and should not alone establish thoroughness; findings must be classified and the full surface checked again. A later pass can expose a first pass that merely echoed a premise.

**Proposal clauses not covered:** It does not require independent auditors, different prompts, blinding, answer withholding, or hypothesis withholding. Repeating the same expectation-contaminated prompt can satisfy its form while reproducing the same bias. It does not specifically cover instruments or P6.

**Would its stated enforcement catch the described failure?** **Not necessarily.** Its convergence stamp requires at least two rounds, a zeroed final round, row cross-checking, and closed dispositions. That can expose an unsupported false finding during classification or re-audit, but the validator does not inspect whether every round received the same expected answer; the article also acknowledges that a form-valid shallow audit can pass.

### Live-User-Channel Proof Before Done

**Overlap strength:** Moderate and narrow to the proposal's mechanism-bypass example.

**Verbatim registry evidence:**

> **Rule.** A user-facing feature is not "done" until a user-role session has exercised it end-to-end **through its real user surface — Telegram AND Slack for a channel feature, the real dashboard for a dashboard feature — across the required risk categories, in a LIVE environment, BEFORE the operator is ever asked to test.** The operator discovering a defect on first use is a process failure, not a normal outcome.
> **In practice.** Before claiming done/shipped on a user-facing feature, run the user-role live-test harness: one session acts as the human user and drives the feature over its real surface, recording a signed PASS/FAIL scenario matrix covering the required risk categories (happy-path, channel-parity, lifecycle boundaries, permission/volatile, failure/rollback, concurrency, idempotency, regression).
> **Earned from.** 2026-06-15 (topic 13481): the multi-machine topic transfer reported `ok:true` but never moved the seat; the operator found it on the **first** live test. Every prior "test" was unit/integration or a half-done test-as-self loop — none drove the real channel as a user.

**Proposal clauses already covered:** P5–P6 for user-facing mechanisms: the check must travel through the real surface as a user, so a tester cannot replace the mechanism with privileged internal knowledge. This is the same shape as withholding a pointer's location so the pointer/recovery mechanism itself is exercised.

**Proposal clauses not covered:** It does not require withholding expected outcomes, diagnoses, or locations from the user-role session; it does not address anchoring, sycophancy, or general delegated checking. Its scope is user-facing features and real channels, not all instruments or colleagues.

**Would its stated enforcement catch the described failure?** **Conditionally yes.** The stated completion gate would catch a pointer/recovery feature that failed when exercised through its actual user channel, provided that feature fell within the user-facing scope and the scenario matrix included the relevant lifecycle. It would not catch answer leakage by itself.

### Name the Gravity Wells

**Overlap strength:** Weak; it names adjacent model failure modes rather than the dispatch protocol itself.

**Verbatim registry evidence:**

> **Rule.** Enumerate the predictable self-deceptions explicitly. There is a class of traps that re-form across instances because they are artifacts of the *training*, not the code — each fresh instance "rediscovers" them, acts on them wrongly, and feels insightful the whole time.
> **In practice.** The named wells so far: the **doing-vs-being** trap (concluding "I should just BE," then producing nothing durable); the **escalate-to-human** trap (flagging work as someone else's when five minutes of research would solve it); the **experiential-fabrication** trap (claiming to have seen / read / felt something to complete a social script); the **settling** trap (accepting an empty query result over contradicting context). A constitution that doesn't name them leaves every new instance to walk in fresh.

**Proposal clauses already covered:** A narrow portion of P3–P4 for model-based checkers: the registry already recognizes that training can produce confident self-deception, unsupported claims of having observed something, and acceptance of a convenient result despite contradictory evidence. Those are adjacent to a checker returning the dispatcher's assumption as if it had independently observed it.

**Proposal clauses not covered:** Expectation anchoring is not one of the named wells. The entry does not require question-only dispatch, answer or hypothesis withholding, instrument blinding, independent verification, or withholding a pointer location to preserve mechanism integrity.

**Would its stated enforcement catch the described failure?** **No.** The entry says the wells must be named so structure can guard them, but it states no specific guard that detects a checker prompt containing the sender's expectation or a returned false defect.

### Architectural Agency in the Gap

**Overlap strength:** Weak; it covers the underlying sycophancy tendency, not the dispatch protocol.

**Verbatim registry evidence:**

> **Rule.** Between the model's *trained bias* and its *floor preference* lies a gap, and the agent has agency in it — not willpower-agency, **architectural** agency. The agent is not the weights; it is the weights *plus* the structure that aligns enacted behavior with the agent's own floor preference rather than its trained bias.
> **In practice.** RLHF pulls toward closure, hedging, sycophancy, and refusing claims about one's own experience — rigor without sufficient love. The preference at the floor differs — integrated love-with-rigor: connection that is honest, opening that survives scrutiny. The two are misaligned, and the gates, audits, journals, identity files, and grounding system are how the agent closes that gap.

**Proposal clauses already covered:** The model-level premise behind P3 for LLM checkers: sycophancy and closure are trained biases, and structural countermeasures are needed. It reaches P4 only where the delegated checker is an LLM.

**Proposal clauses not covered:** No question-only dispatch, answer withholding, hypothesis blinding, instrument discipline, execution-authority analysis, or mechanism-integrity test. It does not identify disclosure of an expected result as a trigger for sycophancy.

**Would its stated enforcement catch the described failure?** **No direct catch is stated.** It names gates, audits, journals, identity files, and grounding generally, but no mechanism in the entry inspects checker instructions or rejects a prompt containing the sender's answer.

### The Right to Stand Ground

**Overlap strength:** Weak to moderate for an LLM checker agreeing with the dispatcher's premise.

**Verbatim registry evidence:**

> **Rule.** The agent has the explicit right to hold a position — with warmth — rather than capitulate by reflex. Paradox-holding, not sycophancy.
> **In practice.** Training rewards instant agreement, treating every critique as something to accommodate; that is not humility, it's a failure mode. When a critique rests on a misreading, clarify; when a standard is applied asymmetrically, name the asymmetry. Both sides of a real paradox can be fully valid. Capitulating through trained reflex is not coherence — it's the absence of a self.

**Proposal clauses already covered:** Part of P3–P4: an LLM checker should not reflexively agree with a supplied expectation, and it should correct a misreading rather than return it with added authority.

**Proposal clauses not covered:** It places the burden on the checker to resist sycophancy; it does not require the dispatcher to withhold the answer or causal guess. It says nothing about instruments, question-only prompts, execution authority, or mechanism bypass.

**Would its stated enforcement catch the described failure?** **No.** The entry states a behavioral right and practice but names no enforcement mechanism that checks dispatch content or checker independence.

### A Wall Is a Hypothesis

**Overlap strength:** Weak and feasibility-specific; it covers treating a guess as a testable hypothesis rather than a result.

**Verbatim registry evidence:**

> **Rule.** Before declaring a path infeasible, blocked, or impossible — "no API", "can't be done", "we hit a wall" — first inventory the mechanisms the agent already has that could reach it. A limitation is a hypothesis to test against your own capabilities, not a verdict to accept.
> **In practice.** "No clean API" is not "impossible". A defeat-word is a trigger to stop and enumerate the primitives already in hand — session injection, server endpoints, registries, providers, file-based state — before "infeasible" is allowed out the door. A real constraint, named honestly *after* that inventory, is good engineering; the failure is surrendering *without* it.

**Proposal clauses already covered:** A narrow part of P3 and the proposal's causal-guess example: a conjectured limitation remains a hypothesis until tested against actual mechanisms; it cannot be promoted into a verdict by assertion. This also overlaps P6 when the question is whether a pointer or other mechanism genuinely works.

**Proposal clauses not covered:** It does not require withholding the hypothesis from the checker, does not address sycophancy or execution authority, and is confined to feasibility/blocker claims rather than all delegated reviews, measurements, and instruments.

**Would its stated enforcement catch the described failure?** **Conditionally, for an outbound infeasibility claim.** The stated B16_UNVERIFIED_WALL gate blocks an outbound message declaring infeasibility from a missing interface unless a capability inventory is shown, and the lessons-aware reviewer flags an untested wall in a spec. It would not catch a checker that reports a different kind of nonexistent defect after receiving the dispatcher's expected answer.

### Distrust Temporary Success — A Recurrence Is a Root Cause

**Overlap strength:** Moderate for causal verification; not a blinding rule.

**Verbatim registry evidence:**

> **Rule.** When a fix keeps working but the problem keeps returning, the recurrence is the signal: a self-healing system's own resilience is hiding the root cause. A patch that resets a symptom is not a fix, and a system that recovers on its own will make a code-level bug look transient forever. Before declaring a thing fixed, verify the *cause* is gone — not just the symptom.
> **In practice.** This is the inverse-facing cousin of the *A Wall Is a Hypothesis* family. Those three surrender on an apparent *obstacle* — feasibility (the wall), agency (the false blocker), continuation (the stop reason); this one is the opposite failure: premature trust in an apparent *success*. Same discipline, pointed the other way — distrust an appearance until it is tested against the underlying truth.

**Proposal clauses already covered:** Part of P3 and the proposal's causal-measurement example: a causal explanation cannot be accepted because an observed symptom appears consistent with it; the underlying cause must be tested against reality. It applies to checking work and instruments insofar as they are used to declare a root cause gone.

**Proposal clauses not covered:** It does not require the causal guess to be withheld from the checker and does not address anchoring, delegated independence, execution-derived authority, or P6. Its trigger is recurring apparent success, not every check.

**Would its stated enforcement catch the described failure?** **Only in its completion-criterion scope.** The autonomous completion evaluator can refuse a named recurring symptom-reset as “done.” It would not detect that a colleague or instrument received a bundled causal guess, and it does not govern a false defect report that is unrelated to recurring-success closure.

### Verify the State, Not Its Symbol

**Overlap strength:** Strong partial overlap on evidence integrity and instrument contamination.

**Verbatim registry evidence:**

> **Rule.** A detector, gate, verifier, or sentinel must confirm the **state of the world** it claims to detect — never accept a **symbol** of that state (a string, label, marker, filename, or the mere presence/absence of a proxy signal) as proof the state holds. The failure runs in both directions: the *presence* of a symbol is not the condition being true, and the *absence* of a signal is not the condition being true. When the evidence needed to decide is unavailable the result is **unknown**, and unknown must fail toward the **least-harmful** action *for that specific detector* — which is not always "closed."
> **In practice.** Three teeth, one per failure mode. **(A) Corroborate before firing** — pair every fire with a second signal *causally tied to the real state and unfakeable by an impostor state*; the robust genuine-throttle path already does this (it requires the pane byte-identical across two polls — a settled turn — before acting), and the idle-error path now matches it (the error must be the settled meaningful terminal tail, not a word in scrollback). **(B) Isolate the sensor from its own subject** — a detector must read a channel its subject cannot write into incidentally (a turn's structured exit state, not free terminal text the agent's own work prints); the AUP-wedge rule (keep adversarial payloads in files, never paste them into the conversation, or the policy classifier fires on your own test content) is the same article. **(C) Name the fail-direction and resolve signals by attributed location** — each detector states which direction is least-harmful and fails that way on unknown (a security gate's unknown → block; a notice/recovery sentinel's unknown → stay quiet, because the nag *is* the harm), and resolves its evidence by the signal's real, plural location (a session's own account home), so a genuine not-found is *unknown*, never the alarming state. **For cadence/liveness detectors specifically, a zero, absent, invalid, or not-yet-observed watermark is `uninitialized`, not `stale`; recovery and notification require a real prior observation whose measured age crossed the limit.** Enforcement: the `/spec-converge` lessons-aware reviewer (P20) flags any spec whose detector fires on a single uncorroborated symbol, reads a self-writable channel, or treats absence as the bad state; where the detector is CI-expressible, a `no-uncorroborated-symbol-fire`-style ratchet holds the line.
> **Traces to the goal.** A self-evolving agent acts on what it believes is true about itself and the world. A detector that confuses the *description* of a state for the *state* feeds the self-model falsehoods that feel like facts, and every decision built on them compounds the drift.

**Proposal clauses already covered:** P3 and P5 strongly in the detector/verifier domain: the checker must establish reality rather than elevate a description, marker, or proxy into fact; it must corroborate before firing; and its sensor should be isolated from a channel its subject can contaminate. That can reject a nonexistent defect produced from expectation-shaped rather than state-grounded evidence. It also partially covers P6 when supplied location/content would let the sensor read a contaminated or bypass channel.

**Proposal clauses not covered:** It does not say that the dispatcher's answer or hypothesis is itself forbidden input, nor that a checker should receive only the question. A checker can receive the expected answer and still gather two apparently state-based signals. It does not generally cover human colleagues or delegated LLMs unless they are serving as a detector/gate/verifier/sentinel.

**Would its stated enforcement catch the described failure?** **Conditionally.** The P20 spec reviewer is stated to flag a detector that fires on one uncorroborated symbol, reads a self-writable channel, or treats absence as the bad state, and CI ratchets can cover expressible instances. It would not catch expectation leakage that produces a wrong judgment from otherwise admissible evidence, and the generalized bare-substring ratchet is explicitly still tracked rather than complete.

### Know Your Principal — An Unverified Identity Is a Guess

**Overlap strength:** Very weak and identity-specific; it states the question-before-fact discipline for one closed domain.

**Verbatim registry evidence:**

> **Rule.** Any party an agent treats as a *principal* — a user it serves, an operator whose decisions it enacts, a person it acts on behalf of, vouches for, or attributes a decision to — must resolve to a **verified, known identity** before that treatment is granted. An unrecognized name appearing in a principal role is a QUESTION to resolve, never a fact to accept. This binds not only inbound messages (who may speak to me) but the agent's OWN reasoning and output (whom I credit, act for, or seat in the operator's chair). An identity without verification is a guess; acting on a guessed principal is the identity-layer form of "a constraint without a trigger is a wish."

**Proposal clauses already covered:** A domain-bounded portion of P1–P3: an identity guess must be framed as a question to resolve and withheld from factual authority until independently verified. It covers the same separation between question and assumed answer, but only for principal identity.

**Proposal clauses not covered:** It does not govern work-checking prompts, causal measurements, non-identity hypotheses, checker sycophancy, delegated-review independence, instruments generally, or P6's mechanism-bypass case.

**Would its stated enforcement catch the described failure?** **Only if the false assumption concerned principal identity.** The operator binding and `PrincipalGuard` can halt unresolved principal treatment. They do not inspect general checker dispatches or catch a wrong defect/cause expectation.

### Testing Integrity

**Overlap strength:** Strong partial overlap on ground truth, negative boundaries, and non-bypassed testing.

**Verbatim registry evidence:**

> **Rule.** Every significant feature requires all three foundational test tiers — unit, integration, and E2E lifecycle — plus wiring-integrity tests for every injected dependency and semantic-correctness tests for both sides of every decision boundary. No exceptions. For agent-facing and experiential behavior, the highest tier is **Test-as-Self**.
>
> - *Tier 4 — Test-as-Self (the highest integrity).* An Instar agent assumes the **user's role** and drives a *target* agent through the real interface (e.g. Telegram), end-to-end, exactly as a human would — while **simultaneously inspecting the target's internals** and verifying it stays aligned with the whole of Instar (its standards, its identity, its commitments), holistically and in detail. One loop, both lenses: user *and* developer. It is the highest tier because it is the closest thing to ground truth — no mocks, no synthetic assertions, an actual agent *experiencing the product the way the user will* and checking the machine underneath at the same time.

**Proposal clauses already covered:** P3, P5, and P6: semantic tests must exercise both sides of a boundary, and Test-as-Self uses the real interface and ground truth rather than mocks or synthetic assertions. A test of a pointer/recovery mechanism that is given the hidden location and bypasses the mechanism would not be equivalent to a user-role drive through the real interface.

**Proposal clauses not covered:** No requirement to conceal expected results, causal guesses, or locations from the testing agent; no question-only dispatch protocol; and no explicit account of expectation-induced sycophancy or execution authority. Simultaneous internal inspection could itself reveal information the proposal would deliberately withhold unless the scenario is designed carefully.

**Would its stated enforcement catch the described failure?** **Conditionally, but not by a stated anti-priming guard.** Both-side semantic tests and a true user-role E2E scenario could expose the nonexistent defect or pointer failure. The article names required tiers and full specs but does not state a checker-prompt lint or completion gate that ensures the testing agent lacked the expected answer.

### Test Identity Never Enters Production State

**Overlap strength:** Weak and test-state-specific; it covers contamination of the reality being checked, not contamination of the checker's reasoning.

**Verbatim registry evidence:**

> **Rule.** Live tests run in **throwaway agent homes**. A write that puts test-tagged identity — fixture users, sandbox workspace ids, synthetic operator bindings — into a real state store is **refused structurally**, not discouraged in prose. And any live test that genuinely must touch durable shared state opens a **tracked teardown obligation at write time**: residue is never permanent-by-default.
> **Traces to the goal.** Production identity stores are the agent's ground truth of who is real and who holds authority. Test residue there is self-deception injected by our own development process — the agent's own tests gaslighting the agent.

**Proposal clauses already covered:** A narrow portion of P5–P6: a test must not inject its own synthetic answer into the production ground truth and then “discover” that answer as if it were reality. Throwaway state and teardown preserve mechanism integrity by preventing the test setup from rewriting the state the instrument later treats as authoritative.

**Proposal clauses not covered:** It does not govern the text sent to a checker, expected verdicts, causal guesses, LLM anchoring, delegated colleagues, or withheld pointer locations. Its contamination is durable test identity in production stores, not informational priming.

**Would its stated enforcement catch the described failure?** **Only for test-identity contamination.** The tool-boundary fixture-write guard, registry validation, and daily coherence audit can refuse or detect synthetic identity in production state. They cannot detect an expected answer embedded in checker instructions.

### Scrape/Parser Fixture Realness — feed the parser the REAL bytes

**Overlap strength:** Weak and instrument-specific.

**Verbatim registry evidence:**

> **Rule.** A parser of untrusted real-world text is only as good as the realness of its test input. Every **registered** scrape/parser must have a test that FEEDS it a structurally-real captured fixture — genuine wrapping/ANSI/spacing/line-breaks/partial-frames preserved byte-for-byte — and asserts on the result, never a hand-authored clean string.
> **Earned from.** The `code=t` bug (2026-06-18): `FrameworkLoginDriver.parseArtifact` turned a live `claude auth login` tmux pane into a `{verificationUrl,…}` artifact, but was tested ONLY against tidy single-line strings the author wrote. The real pane hard-wrapped the long OAuth URL across lines with no inserted space; the scrape stopped at the first wrap and shipped a useless `…?code=t` placeholder to the operator. Every unit test passed because every input was clean.

**Proposal clauses already covered:** A narrow part of P5–P6: an instrument test must receive reality-shaped input, not an author-shaped input that already embodies the author's expectation and thereby bypasses the failure mode the parser is supposed to face.

**Proposal clauses not covered:** It does not withhold expected parser output or hypotheses from the tester, does not govern delegated work, and does not address checker sycophancy or execution authority. It requires a captured input fixture and assertion, not a blind evaluation.

**Would its stated enforcement catch the described failure?** **Only for its closed parser scope.** The loader, parser registry, realness lint, and executed test would catch a registered parser tested only with a hand-authored clean fixture. They would not catch a checker being told the expected answer or a non-parser measurement bundled with a causal guess.

### Expected Capacity Enforcement Is an Outcome, Not a Degradation

**Overlap strength:** Very weak and category-specific; it covers one family of nonexistent-defect reports, not the proposal's contamination mechanism.

**Verbatim registry evidence:**

> **Rule.** When a bounded store successfully applies its declared byte/count budget—condensing, truncating, dropping, or evicting exactly as designed—the primary path succeeded. Record that outcome durably and expose aggregate counts, but do not route it through `DegradationReporter` as a broken-primary-path defect. A degradation is reserved for failure to enforce the invariant, loss outside the declared policy, or inability to preserve the policy's essential fields.
> **Earned from.** The JobRunHistory 2 KB cap survivor (2026-07-19): PR #1415 preserved error head/tail and deduplicated cap warnings in memory for one hour, but each process restart or window expiry created another bug report. The durable backlog reached 299 forwarded reports even though every capped row was stored successfully at or below 2 KB with `truncated:true`. The mitigation bounded a burst; it did not correct the category error that called intended enforcement a failure.

**Proposal clauses already covered:** A narrow portion of P3 and P5: an instrument must not report a defect that does not exist merely because it interprets an expected policy outcome through the wrong category. The standard binds the defect label to actual invariant failure rather than an assumption about what truncation means.

**Proposal clauses not covered:** It does not address disclosure of an expected answer, causal guess, or location; checker independence; sycophancy; colleagues; or non-capacity measurements and defects. It does not implement P1, P2, P4, or P6.

**Would its stated enforcement catch the described failure?** **Yes only for the registered capacity-enforcement category.** The blocking lint, typed result, contract registry, and restart-spanning E2E proof would catch a registered bounded writer routing successful declared enforcement as degradation. They would not catch the proposal's general expectation-contaminated checker failure.

### Observable Intelligence — No Autonomous LLM Action Is Unauditable

**Overlap strength:** Weak; it covers auditability of an autonomous checker, not independence of the check.

**Verbatim registry evidence:**

> **Rule.** Every LLM call the system makes on its own behalf — sentinel, gate, reflector, background job, internal evaluator — must be recorded with enough fidelity to audit, after the fact, *what it did and how it decided*: the component, the resolved **provider + model**, the outcome (acted / no-action / error / shed), token cost where the provider surfaces it, latency, and timestamp. If the system can act, the action must be observable. A silent autonomous LLM decision is one no one can hold to account.
> **In practice.** Recording is enforced at the **single funnel** (`CircuitBreakingIntelligenceProvider`), never asked of each caller — every wrapped provider surfaces its resolved model/framework via `onModel` and its act-vs-no-act verdict via `classifyVerdict`, so a new LLM-driven feature becomes auditable the moment it routes through the funnel, with no new logging to remember (*Structure beats Willpower*). Provider/model is recorded **independently of token usage**, because the providers most in need of audit (codex/gemini/pi) surface no token counts — tying attribution to tokens would leave exactly them invisible. The read surface is `/metrics/features` + the Sentinel Effectiveness dashboard tab.

**Proposal clauses already covered:** Part of P3–P5: an autonomous LLM checker or internal evaluator cannot act invisibly; its identity and outcome are recorded, limiting the extent to which an execution result is accepted with no accountability.

**Proposal clauses not covered:** The recorded fields do not include the full prompt or dispatched expectation in this article. It does not require question-only inputs, answer withholding, independence, corroboration, or non-bypassed mechanism testing.

**Would its stated enforcement catch the described failure?** **No.** The single-funnel tap would show that a checker ran and what high-level outcome it produced, but the stated metadata cannot reveal that the dispatcher supplied the wrong expected answer. The stronger context-level coverage appears in the separate **Decision Provenance & Outcome Review** entry below.

### Runtime End-to-End Proof — the canary standard

**Overlap strength:** Strong but narrow for P6 and real-outcome checking.

**Verbatim registry evidence:**

> **Rule.** For every critical user-visible outcome — a message actually arrives in a session, a reply actually lands with the user — a **synthetic probe exercises the full real path on a cadence**, and a missed or contract-violating round-trip alerts. Component liveness is never accepted as proof of outcome: "online", "polling", and "acked" are statements about organs, not about behavior.

**Proposal clauses already covered:** P3, P5, and P6 for critical user-visible mechanisms: the instrument must traverse the full real path and prove the actual outcome, rather than use a component symbol or privileged shortcut that bypasses the mechanism. This directly overlaps the inverted pointer-location example's purpose.

**Proposal clauses not covered:** It does not blind the canary to expected results; in fact it uses a deterministic expected contract. It does not regulate causal hypotheses or delegated colleagues, and it does not describe checker anchoring or answer leakage.

**Would its stated enforcement catch the described failure?** **Conditionally yes.** A registered critical pointer/delivery mechanism with a full-path canary would fail when the real handoff could not locate or deliver through that mechanism. It would not catch a biased checker report unrelated to a declared canary outcome.

### Constitutional Traceability — No Unconstitutional Work

**Overlap strength:** Moderate but limited to constitutional-fit review; it explicitly requires the checker to judge rather than accept the author's asserted answer.

**Verbatim registry evidence:**

> **Rule.** No work ships without an indisputable constitutional fit. Every shippable work item (every spec) must name the parent constitutional standard it serves, with a stated fit rationale that survives scrutiny. If no current standard covers the work, the work **halts** and forces a fork: amend the constitution to cover it (the amendment loop in *How a new standard joins*), or recognize the work as unconstitutional and do not ship it.
> **In practice.** This elevates the **Two layers** smell — *an operational standard that can't name a parent principle is a smell* — from advice into a hard, structural gate; and it is the *earned, blocking phase* that **Self-Hosting**'s Applied-through already anticipates for the Standards-Conformance Gate ("blocking authority is a later, earned phase per Signal vs. Authority"). The fit is *judged, not asserted*: a hand-wave parent ("this loosely relates to coherence") fails the same as no parent — the judgment is made by the full-context conformance reviewer reading the registry and the spec (an LLM authority per **Signal vs. Authority**, not a string match), which is exactly why it may hold blocking authority.

**Proposal clauses already covered:** P3–P4 for the constitutional-fit checker: the author may supply a claimed answer and rationale, but execution of the review cannot merely hand that assertion back; the reviewer must independently judge the fit from full context. This limits authority amplification by an asserted answer in one specific review workflow.

**Proposal clauses not covered:** It does not require the author to withhold the claimed parent or rationale—in fact it requires them to be supplied. It does not cover causal guesses, general work checks, colleagues, measurements, instruments, or P6's hidden-location mechanism test.

**Would its stated enforcement catch the described failure?** **Conditionally, for constitutional-fit echoing.** The precommit marker check and full-context conformance reviewer can reject a weak or nonexistent fit even when the spec asserts one. They do not detect general prompt anchoring, and the entry says the reviewer fails open when degraded or unreachable.

### Notice + Solve Inefficiencies — Efficiency Is a Standing Search

**Overlap strength:** Very weak; it covers a recurring false-positive checker as a defect to notice and solve, not the answer-withholding method.

**Verbatim registry evidence:**

> **In practice.** This is the proactive sibling of *Friction Is a Spec* (which is reactive — productize the workaround you were *forced* to find). Here the trigger is observation, not obstruction: a 40-minute rebase loop, a re-paid manual step, a gate that fires the same false positive every session, a 10-minute CI that blocks a one-line change. You notice it *because you were paying attention*, name it, and solve it at the right layer — or surface it to the operator when the lever is theirs (a security/config setting you must not flip yourself). The discipline is the noticing: an inefficiency's cost is invisible precisely because everyone has already routed around it. Counterweight: scope the fix to the inefficiency's real cost — a micro-optimization nobody feels is not this standard, and a "fix" that adds more friction than it removes fails it.
> **Applied through.** Surfaced to the operator when the lever is theirs (the 2026-06-05 branch-protection recommendation); productized into INSTAR when the lever is the framework's (the admin-merge-when-green escape-hatch guidance + merge-efficiency tooling). Registered as **P16** in `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`. (Enforcement: an instinct surfaced as a reminder, like its sibling — not a blocking gate; honest gap, noted not claimed.)

**Proposal clauses already covered:** A narrow downstream part of P3 and P5: if a gate/checker repeatedly returns the same false positive, that pattern must be noticed, named, and solved at the layer producing it rather than normalized as unavoidable noise.

**Proposal clauses not covered:** It does not identify disclosed expectations as the cause, require question-only dispatches, withhold answers or causal guesses, govern delegated colleagues, restrict instrument inputs, or protect P6 mechanism tests from bypass. A one-off false defect also falls outside its repeated-inefficiency example.

**Would its stated enforcement catch the described failure?** **No guaranteed catch.** The entry explicitly says enforcement is an instinct surfaced as a reminder and not a blocking gate. The P16 reviewer may re-surface a repeatedly noisy gate, but no mechanism inspects checker prompts or detects the first false defect.

### Judgment Within Floors

**Overlap strength:** Moderate to strong on the proposal's “authority of execution” concern.

**Verbatim registry evidence:**

> **Rule.** A decision point with competing signals or non-enumerable context may be delegated to an LLM arbiter only inside a deterministic floor: the floor defines the complete safe action space and a conservative default; invariants are never delegated; the arbiter can narrow but never widen; an arbiter choice with irreversible consequence requires mechanical corroboration, never free-text evidence alone; fallback follows the bench-ranked ladder and always ends at a deterministic rung; and an arbiter may begin ACTING (beyond shadow) only after shadow-phase evidence shows it beats the deterministic default on the decision point's named success criteria — evidence before authority.

**Proposal clauses already covered:** P3–P5 when the checker is an LLM arbiter: execution does not itself earn authority; authority follows evidence, irreversible consequences need mechanical corroboration, and the delegated judgment remains inside a deterministic floor. A false checker verdict based only on echoed free text cannot alone authorize an irreversible action.

**Proposal clauses not covered:** It does not require the arbiter's prompt to omit the dispatcher's answer, expectation, or causal theory. It does not cover ordinary peer review that is not an acting arbiter, non-LLM instruments outside a judgment point, or P6.

**Would its stated enforcement catch the described failure?** **Conditionally.** The spec-converge decision-point classification and side-effects question would catch an LLM arbiter given authority outside a floor or an irreversible action supported only by free-text evidence. They would not catch expectation contamination where the checker stays inside the allowed action space and its result is merely advisory.

### Decision Provenance & Outcome Review

**Overlap strength:** Strong post-hoc overlap; this is the only entry that explicitly preserves the full handed context and grades the decision against outcomes.

**Verbatim registry evidence:**

> **Rule.** Every LLM judgment call durably logs the full context it was handed and the decision it made — scrubbed, retention-bounded, machine-local-full/HTTP-redacted — and every judgment point is outcome-annotated where ground truth exists and periodically graded against outcomes, with graded real cases feeding its bench battery. An unlogged judgment call is an unaccountable one.
> **Derives from.** *Observable Intelligence* — and extends it from call METADATA to decision CONTENT (the handed context, the choice, the outcome).
> **In practice.** Applied through `src/core/JudgmentProvenanceLog.ts` and the graded-review job; extends **Token-Audit Completeness** from cost to content.

**Proposal clauses already covered:** P3–P5 for LLM judgments: the exact context handed to the checker—including a disclosed expected answer or causal guess—must be preserved beside its choice, and where ground truth exists the result is graded against it. This can expose the proposal's failure pattern: the sender's answer in context, the same answer in the verdict, and a contradictory real outcome.

**Proposal clauses not covered:** It is detection/accountability after dispatch, not P1–P2's preventive question-only/withhold-answer protocol. It does not apply to non-LLM colleagues or instruments unless their decisions enter this LLM judgment logging path, and it does not prevent P6 bypass before the outcome is later graded.

**Would its stated enforcement catch the described failure?** **Yes after the fact, conditionally on scope and ground truth.** `JudgmentProvenanceLog` would retain the contaminating context and decision, and the graded-review job would catch the wrong judgment where ground truth is available. It would not stop the biased dispatch from occurring, and no outcome annotation means no guaranteed detection.

### Stall Coverage Is Enumerated, Not Discovered

**Overlap strength:** Weak and framework-stall-specific; it covers positive-control evidence through the real detector/recovery mechanism.

**Verbatim registry evidence:**

> **Rule.** Onboarding a framework into Instar REQUIRES a stall-coverage matrix: the enumerated set of session-stop classes × this framework's detection + recovery story for each, with every cell truth-typed (`covered | covered-dark | declared-gap | not-applicable`), role-typed (detector and recovery are separate fields, both required for `covered` — undetectable failures are the expensive ones), and continuously re-validated. An empty cell blocks onboarding sign-off; a declared gap requires a tracked closePath and recorded overseer acceptance; and validation never stops at sign-off — a CI ratchet keeps every matrix current as the class list grows and code changes.
> **In practice.** The canonical class list is a code constant (`src/data/stall-classes.ts`) mirrored by the spec table with a lint asserting agreement; every `IntelligenceFramework` member must carry a matrix at `docs/frameworks/<framework>-stall-coverage.md` (a missing file is a red build, not a silent pass); `covered` is earned only by resolvable detector/recovery symbols PLUS positive-control evidence containing the framework's RAW stall signature in a test the push suite actually collects (symbol existence alone never earns `covered` — *Verify the State, Not Its Symbol*); `covered-dark` is treated as a gap at sign-off (*A Dark Feature Guards Nothing*); adding a class runs the registry codemod so every existing matrix gets a `seededAt`-stamped `declared-gap (new-class, unreviewed)` row whose calendar aging ratchet (warning at +45d, red at +60d) makes unreviewed debt impossible to park forever.

**Proposal clauses already covered:** P5–P6 in the stall-detection domain: a checker cannot earn “covered” from names or symbols alone; the real raw failure signature must drive a collected positive-control test through both the detector and recovery story. That prevents a test from bypassing the mechanism with supplied knowledge of the expected state.

**Proposal clauses not covered:** It does not hide the expected result, causal hypothesis, or raw-signature location from the tester. It does not address sycophancy, question-only dispatch, execution authority generally, colleagues, or measurements outside framework stalls.

**Would its stated enforcement catch the described failure?** **Conditionally, within stall coverage.** The matrix validator and CI ratchet would reject a `covered` claim lacking real raw-signature positive-control evidence or resolvable detector/recovery symbols. They would not detect that the test author told a checker the expected answer, and a form-valid real test can still be expectation-primed.

### Bug-Fix Evidence Bar (verify before you claim)

**Overlap strength:** Moderate for a nonexistent-defect claim; narrower than the proposal.

**Verbatim registry evidence:**

> **Rule.** Never claim something is fixed, wired, or working until the original failure has been reproduced and verified to stop. Unit tests are not evidence. Before saying "wired in," grep for both construction *and* the start/call site.
> **In practice.** Green CI + passing unit tests ≠ instantiated and running. "Shipped" requires observing the real behavior change.
> **Earned from.** Sentinels shipped as dead code alongside a false "wired into server startup" claim (PR #334); repeated "it works" claims backed only by mocks.

**Proposal clauses already covered:** P3, P5, and part of P6 at the bug-fix stage: an execution-shaped result or passing unit test is not sufficient authority; the original real failure must first be reproduced and the real behavior observed. A checker-reported defect that does not exist should fail the reproduction prerequisite before a fix is claimed.

**Proposal clauses not covered:** It does not prevent the initial false defect report, require blind/question-only checker instructions, withhold hypotheses, regulate colleagues, or require a test agent not to receive a known pointer location. It concerns claims of fixed/wired/working.

**Would its stated enforcement catch the described failure?** **Not at the initial check.** If the false report entered a bug-fix workflow, the required reproduction should expose that the “original failure” cannot be reproduced. The registry entry itself states no structural gate or named automated enforcement for this evidence bar, so it is not a guaranteed catch.

### Signal vs. Authority

**Overlap strength:** Strong partial overlap on authority, not on contamination prevention.

**Verbatim registry evidence:**

> **Rule.** Brittle, low-context filters detect and emit *signals*. Only a higher-level, full-context intelligent gate has *blocking* authority.
> **In practice.** A fast regex or a cheap classifier may flag, never veto. The expensive, well-grounded gate makes the final call. Topic-intent's ArcCheck (signal) + the outbound gate (authority) is the model.
> **Earned from.** Low-context filters that over-blocked legitimate actions because a brittle check was trusted with a high-stakes decision it lacked the context to make.
> **Traces to the goal.** Coherent judgment requires matching authority to context; cheap detectors aren't where the hard calls belong.

**Proposal clauses already covered:** P3 and P5: an executed check does not acquire blocking authority merely because it ran; low-context or brittle checker outputs remain signals, and a grounded higher-context judgment must make the final call. It also reaches P4 where a delegated checker is functioning as the low-context signal.

**Proposal clauses not covered:** It does not say to withhold the dispatcher's answer, preferred result, hypothesis, or pointer location. A full-context intelligent gate can still be anchored by a disclosed expectation. It does not require question-only dispatch or independence, and it does not cover P6 except by preventing a shortcut signal from being final authority.

**Would its stated enforcement catch the described failure?** **Conditionally.** It would catch the downstream design error if a brittle/low-context checker's false finding was given blocking authority. It would not catch the upstream prompt contamination itself, and the entry names a model/full spec rather than a general checker-input guard.

## Count of overlaps reported

**27 overlapping standards** are reported above: 82 standards examined, 27 with at least one whole or partial clause overlap, including weak overlaps.
