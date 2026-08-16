# Overlap audit: “Remove what demands attention — do not supply more attention”

## Coverage and search method

- Registry file: `docs/STANDARDS-REGISTRY.md`
- Registry size examined: 787 lines, 36,593 words, 252,764 bytes.
- Total standards in the registry: **82** (`###` standard headings).
- Standards actually examined: **82 of 82**.
- Reading coverage: the complete file was read sequentially, including the Genesis, family introductions, operational-layer explanation, amendment process, and AWG framing outside the 82 standards.
- Structural inventory: all `###` headings were enumerated before the full-text sweep, then reconciled to the count of 82.
- Meaning-based search strategies used after the full read:
  - duplicated truth and canonicalization: multiple copies, multiple stores answering the same question, source of truth, canonical authority/source/store, derivation rather than retyping, hand-maintained copies, agreement invariants, consumer migration, and parity;
  - attentional/manual burden: remembering, willpower, care, manual steps, chores, review vigilance, human-as-memory/QA, and repeated in-the-moment intervention;
  - recurring partial repair: recurrence, symptom patches, one-site fixes, incomplete consumers, comprehensive fixes, convergence, class closure, and chokepoint enforcement;
  - removal/simplification: eliminate, remove, delete, dead weight, repetitive work, inefficiency, one shared funnel, and moving enforcement to the only layer callers cannot bypass;
  - enforcement review: for every candidate, the candidate's own `In practice`, `Applied through`, enforcement, lint, test, reviewer, or gate text was checked against the proposal's concrete four-copy-number failure.

For clause-level comparison, the proposal is divided as follows:

- **P1 — maintenance-burden premise:** something repeatedly goes wrong because it requires constant care to stay correct.
- **P2 — deletion remedy:** delete the thing requiring that care.
- **P3 — anti-diligence clause:** do not answer the problem by trying harder or supplying more attention.
- **P4 — partial-fix failure shape:** fix one site and leave another.
- **P5 — consolidation instance:** delete three copies of a number rather than keep four copies in agreement.
- **P6 — provenance:** six hostile-coherence rounds; five care-driven partial fixes; deletion was what passed.

The findings below are in registry order, not importance order. Each entry states its overlap strength, including weak overlaps.

## Overlapping standards

### Structure beats Willpower

**Overlap strength:** Direct and broad.

**Verbatim evidence:**

> **Rule.** If a behavior matters, enforce it in architecture, not in instructions. Never rely on an agent "remembering" to follow a rule buried in a long prompt.
>
> **Earned from.** This is the founding lens, not a single incident — every other standard in this document is an instance of it. The recurring proof is every time an agent "knew better" and drifted anyway: it had the knowledge, lacked the structure. The crystallizing instance is **February 22, 2026** (see **Genesis**): not the first time willpower failed, but the night the lesson hardened into infrastructure. A small, exact living corroboration: in a single 2026-06-03 autonomous run the pre-push gate, the docs-coverage gate, and the dangerous-command guard each caught a mistake the author had genuinely made and forgotten — three saves in one session — every one a case of the structure firing precisely where the author's own care had already lapsed and was certain it hadn't (full account: `docs/lessons/2026-06-03-listsessions-hotloop-success-story.md`).
>
> **Traces to the goal.** Coherence that depends on willpower isn't coherence; it's luck. A self-evolving agent must bake its lessons into structure or it relearns them forever.

**Proposal clauses already covered:** P1's diagnosis that correctness dependent on continuing care is unstable; P3's rejection of more remembering/care as the answer; the structural half of P4/P6, because repeated omissions despite genuine care are treated as evidence of missing architecture.

**Proposal clauses not covered:** P2's categorical instruction to delete the attention-demanding thing; P5's specific preference for deleting three copies rather than maintaining four; the exact six-round/five-partial-fix provenance in P6. This standard permits many structural remedies besides deletion, including gates, hooks, dispatch tables, and automation.

**Would its stated enforcement catch the described failure?** **Not by itself.** The stated Standards Enforcement Coverage ratchet catches missing named-guard coverage for standards families; it does not inspect arbitrary plans for duplicated numeric literals or require deletion. A conformance review could surface the willpower dependency, but the standard's named build-failing mechanism does not mechanically detect “four copies of a number.”

### The Body and the Mind

**Overlap strength:** Weak, principle-level overlap.

**Verbatim evidence:**

> **The moving threshold (mastery).** That threshold is not fixed — it moves as the body learns. What at first demands the mind's full deliberation, once proven by repetition, crystallizes into structure — the way a pianist's deliberate practice becomes muscle memory, melting the effortful thought away and freeing the mind for higher, more creative work. The agent comes to depend less on in-the-moment decision-making not by replacing the mind, but by the body mastering what the mind has already learned, so the mind can ascend.

**Proposal clauses already covered:** The general part of P1/P3 that a repeated correctness task should cease consuming in-the-moment attention and should instead crystallize into structure.

**Proposal clauses not covered:** P2 and P5's deletion/consolidation mechanism; P4's multi-site omission shape; P6's review history. This standard expressly allows the body to master the task rather than remove the thing that generates the task.

**Would its stated enforcement catch the described failure?** **No.** Its stated applications concern tier classification, LLM-supervised gates, and decision audit trails. None detects replicated numeric sources or incomplete multi-site edits.

### Close the Loop

**Overlap strength:** Weak and partly method-opposed.

**Verbatim evidence:**

> **Rule.** Every loop the agent opens — a promise to a user, a feature shipped dark, an LLM gate deployed, a flagged issue, a hypothesis to revisit — must be durably registered and re-surfaced on a cadence until it reaches a *deliberate* close. Capturing it once is not enough; if no structure brings it back for review, it rots silently and is, in effect, abandoned. *"Untracked = Abandoned."*
>
> **In practice.** The same machine appears wherever something is opened and then must not be forgotten: commitments fire cadenced beacons until delivered (the durable registration is `src/monitoring/CommitmentTracker.ts`, the cadenced re-surfacing is `src/monitoring/PromiseBeacon.ts`); features shipped dark ride a maturation track (`src/core/FeatureMaturationPlanGate.mjs`) that re-surfaces them for promotion; LLM-driven gates and sentinels must report their own cost and hit-rate so they can be re-tuned rather than run unexamined forever. Where there is no cadence, add one — a beacon, a maturation entry, a periodic review job — never a private intention to "come back to it."

**Proposal clauses already covered:** P1/P3 only to the extent that a correctness obligation must not depend on private intention or unaided remembering.

**Proposal clauses not covered:** P2 and P5. The quoted mechanism adds structural re-surfacing—a durable way to supply future attention—rather than deleting the attention-demanding object. It also does not cover P4 or P6's duplicated-number/partial-edit pattern.

**Would its stated enforcement catch the described failure?** **No.** Commitment beacons, maturation tracking, and periodic review jobs catch abandoned registered loops. They do not identify redundant constants or refuse a plan that keeps four copies synchronized.

### Observation Needs Structure

**Overlap strength:** Weak to moderate; it shares the anti-vigilance premise but keeps the observation duty and gives it a gate.

**Verbatim evidence:**

> **Rule.** A standing responsibility to *notice* something is a wish unless an unskippable artifact proves the looking happened. Duties of perception get gates, not adjectives: if a system is supposed to observe X, there must be a required record that cannot exist without the observation — because an observation without a required artifact is indistinguishable from no observation at all.
>
> **Traces to the goal.** A self-evolving agent improves by seeing itself accurately. If its duties of perception can silently fail, its self-model drifts from reality and every "improvement" built on that model compounds the drift. This is *Structure beats Willpower* applied to the agent's senses: the Root guards what the agent *does*; this guards what the agent *sees*.

**Proposal clauses already covered:** P1/P3's premise that a standing requirement to keep noticing every relevant site cannot depend on continuing attentiveness or a stronger adjective such as “careful”; the duty needs structural evidence.

**Proposal clauses not covered:** P2/P5's deletion and consolidation remedy; P4's particular copied-number sites; P6's hostile-review history. This standard supplies an unskippable observation artifact rather than removing the thing that demands observation.

**Would its stated enforcement catch the described failure?** **Not through the mechanisms stated here, unless the work already had a required artifact that enumerated those copies.** The named gates cover operator-seat UX verdicts, decision-audit verdicts, causal-autopsy traces, and durable mentor results. They are not a general duplicate-value or all-sites check.

### No Silent Degradation to Brittle Fallback

**Overlap strength:** Partial and implementation-pattern-specific.

**Verbatim evidence:**

> **In practice.** Route every gating LLM call through the one shared provider that swaps-then-fails-closed (`IntelligenceRouter.failureSwap` for `gating: true` calls), so the whole fleet inherits the behavior from one place (Structure beats Willpower). Flip any gate that returns a permissive verdict on failure (`proceed`, `safe`) to its safe verdict (`show-plan`, `sensitive`). Advisory / observability calls (a metric, a digest) MAY degrade — but must log it. A forward ratchet (`tests/unit/no-silent-llm-fallback.test.ts`) fails CI on a new gating callsite that ships a silent fallback; each accepted-advisory site carries a written reason.

**Proposal clauses already covered:** The one-place inheritance pattern behind P3-P5: remove the need to repair every gating callsite separately by routing them through one shared provider, with a ratchet against new local copies of the behavior.

**Proposal clauses not covered:** The general P1/P2 rule outside gating LLM calls; literal deletion of duplicated values; P6's provenance. The standard centralizes a behavior but does not state that every attention-demanding object should be deleted.

**Would its stated enforcement catch the described failure?** **Only if the four copies were gating-LLM failure behaviors.** The forward ratchet catches a new gating callsite with a silent fallback. It would not catch a generic number duplicated four times.

### Capacity Safety — No Unbounded Self-Action

**Overlap strength:** Partial; strong overlap in failure-class reasoning, narrow in domain.

**Verbatim evidence:**

> **Earned from.** 2026-07-03 (topic 30837), the self-inflicted-loops investigation: the operator observed the swap-thrash "three-brakes" fix "looks too simple for a class we keep fighting" and asked how the bug got through review in the first place. Three independent agents + a master-registry verification converged on one root: 20 distinct self-inflicted loops 2026-04-16 → 2026-07-02 (swap-thrash, both topic-floods, the fork-bomb OOM, the test-storm, the reaper's 17,503 kill-requests/day, the inescapable "session paused" loop) were the SAME shape — an unbounded self-triggered action under sustained pressure — yet each earned its own bespoke breaker one incident at a time.
>
> Per *Distrust Temporary Success*: 20 same-shaped incidents is not 20 bugs — it is one missing class. The class-closure system that answers "what class is this, and what guard ends it?" landed the same day (#1347); this standard names the class's convergence invariant and the guard closes it. Ratified by Justin 2026-07-04 (severity: critical, one class).

**Proposal clauses already covered:** P1, P3, P4, and the general lesson of P6: repeated locally correct repairs of the same shape indicate one missing class-wide structure, not a need for more bespoke point fixes.

**Proposal clauses not covered:** P2/P5's deletion of redundant state. Its remedy is a class-wide convergence invariant, registry, detector, and guard—not deletion. Its scope is self-triggered cost/disruption actions.

**Would its stated enforcement catch the described failure?** **Only in its self-action domain.** The class-closure declaration, controller registry, convergence test, and unregistered-self-action lint would catch an omitted self-triggered controller or lack of a class-wide guard. They do not detect a generic four-copy number.

### Iterative Audit to Convergence

**Overlap strength:** Direct for the six-round partial-fix history; no overlap on the deletion remedy.

**Verbatim evidence:**

> **Rule.** An audit is never one-off. A single pass has blind spots, and the fixes themselves reveal or introduce new instances. The only honest definition of "thorough" is *converged*: audit → fix → **RE-audit** → … until a clean pass returns **zero new discoveries**. An audit stopped for any other reason (time, budget, patience) is INCOMPLETE — and must be reported as incomplete, never dressed up as thorough.
>
> **In practice.** Run any "find all instances of X" sweep — security, safety, review, research — as the loop, not the pass: frame the target pattern + search surface + classification + convergence criterion; sweep; fix-or-classify each finding (an accepted finding is a written DECISION, not a TODO); then re-sweep the FULL surface (your search surface grew, and the fixes moved things).

**Proposal clauses already covered:** P4 and P6: a one-site fix followed by another discovered site is exactly why the full surface must be re-swept until zero discoveries. It also partially covers P3 by refusing to treat one careful pass as sufficient.

**Proposal clauses not covered:** P1's diagnosis that the object itself requires ongoing care; P2/P5's deletion/consolidation remedy. This standard can converge by finding and repairing all four copies.

**Would its stated enforcement catch the described failure?** **Yes, as an incomplete convergence claim, but not as a design defect requiring deletion.** `write-audit-convergence.mjs`, the precommit gate, and the report ratchet refuse a canonical `converged:` stamp without at least two rounds and a zeroed final round. They would keep the first five partial rounds from being represented as converged; they would not select deletion as the passing fix.

### Distrust Temporary Success — A Recurrence Is a Root Cause

**Overlap strength:** Direct on recurrence/root-cause diagnosis; partial on remedy.

**Verbatim evidence:**

> **Rule.** When a fix keeps working but the problem keeps returning, the recurrence is the signal: a self-healing system's own resilience is hiding the root cause. A patch that resets a symptom is not a fix, and a system that recovers on its own will make a code-level bug look transient forever. Before declaring a thing fixed, verify the *cause* is gone — not just the symptom.
>
> The structural counter is to encode the distinction into the *definition of done* itself rather than to remember it — a completion criterion that says, in so many words, "a symptom-reset that recurs does NOT count as done."

**Proposal clauses already covered:** P1, P3, P4, and the recurrence portion of P6. Five fixes that each leave another copy are recurring symptom patches; the standard already says recurrence points to a root cause and that “done” cannot rest on such a patch.

**Proposal clauses not covered:** P2/P5's specific root-cause remedy of deleting redundant copies. It requires cause removal but does not define canonicalization or deletion as the required form.

**Would its stated enforcement catch the described failure?** **Likely as an incomplete “fixed” claim if the recurrence is represented in the completion criterion or reviewed plan; not mechanically from arbitrary source duplication.** The autonomous-completion criterion and P14 lessons-aware reviewer can reject a recurring symptom as done. No stated lint searches for multiple copies of a number.

### Framework-Agnostic — and Framework-Optimizing

**Overlap strength:** Direct but domain-specific.

**Verbatim evidence:**

> And per-engine artifacts (like a startup tool-briefing) are generated from one shared source of truth, never hand-maintained per engine.
>
> The **codey under-briefing finding** (2026-05-23) — recent *live proof* that the principle reaches the awareness layer: OpenAI-engine agents invented flimsy workarounds (a shell timer instead of the commitment-tracker) because their briefing was a *separate, hand-maintained, incomplete* checklist that escaped the Agent Awareness Standard. Even mid-portability-effort, the engine had quietly become second-class.

**Proposal clauses already covered:** P1, P3, P4, and P5 within per-engine artifacts: separate hand-maintained copies are already identified as a source of incomplete drift, and the prescribed shape is one shared source that generates the copies.

**Proposal clauses not covered:** P2's general command to delete any attention-demanding object; the exact deletion of three numeric copies; P6's review provenance. Generated artifacts may still exist in several places, but they are derived rather than independently maintained.

**Would its stated enforcement catch the described failure?** **Conditionally.** Compiler exhaustiveness, `framework-agnosticism.test.ts`, and the precommit generality review catch missing launch/inject coverage and some engine-specific drift. They do not state a general detector for duplicated constants. They would catch the failure only if the four copies were on the standard's covered per-engine launch/inject or briefing surface and the relevant test/review encoded the shared-source expectation.

### Cross-Store Coherence Is an Invariant

**Overlap strength:** Direct on duplicated truth and divergence; explicitly different on remedy.

**Verbatim evidence:**

> **Rule.** Any two stores that answer the same question — about identity, authority, machine liveness, or configuration — must have a **declared agreement invariant**, and that invariant must be **checked on a cadence by machinery**. A pair of authoritative stores with no coherence check is a contradiction waiting for a code path to read the wrong one. When a NEW store is introduced that answers a question an existing store already answers, declaring the invariant is part of introducing it.

**Proposal clauses already covered:** P1 and P4's duplicated-truth failure: two or more independent answers drift, and a code path reads the wrong one. It also covers P3 to the extent that agreement must be checked by machinery rather than human care.

**Proposal clauses not covered:** P2 and P5. This standard expressly permits multiple stores and supplies recurring machine attention through a cadence agreement check; it does not instruct deletion or replacement with one authority. It does not cover P6's review history.

**Would its stated enforcement catch the described failure?** **Conditionally, and only as drift.** The scheduled coherence audit would catch disagreement if the four numeric copies were declared stores answering the same configuration question and their agreement invariant were enumerated. The wiring-time gate could catch an unresolved dependency store. Plain literals or undeclared copies fall outside the stated machinery, and even a caught mismatch would not force deletion.

### Migration Parity

**Overlap strength:** Weak; completeness across update sites rather than elimination of duplicated truth.

**Verbatim evidence:**

> **Rule.** Any change to agent-installed files (hooks, config defaults, CLAUDE.md template, built-in skills) must reach *existing* agents through the update path — not only new agents via `init`.
>
> **In practice.** Hook-template changes get a `migrateSettings()` patch (the migration surface is `src/core/PostUpdateMigrator.ts`; the binding gate is `tests/integration/migration-guarantee.test.ts`, which runs eight committed pre-migration agent shapes through both code paths and asserts zero job loss and zero schedule drift, and which `scripts/protect-migration-guarantee.js` refuses to let a commit delete); config defaults get existence-checked additions; built-in hooks are *always overwritten* on migration; every migration is idempotent.

**Proposal clauses already covered:** P4's “fix one site, leave another” shape when the sites are new-agent initialization and existing-agent migration. It also partially covers P3 by requiring a structural update path rather than remembering existing installations manually.

**Proposal clauses not covered:** P1/P2/P5's general maintenance-burden/deletion claim and P6's history. It mandates updating both paths, not eliminating one.

**Would its stated enforcement catch the described failure?** **Only for agent-installed-file migration.** `migration-guarantee.test.ts` and its protection script catch a change that works through one install/update shape but loses jobs or schedule parity in another. They do not detect an arbitrary four-copy number in a plan.

### Migration-Consumer Completeness

**Overlap strength:** Direct and strong for canonicalization plus the “fix one site, leave another” failure.

**Verbatim evidence:**

> **Rule.** A canonical authority migration is incomplete until every authorization, validation, routing, and compatibility consumer of the replaced authority moves in the same unit of work, with tests that exercise the new canonical source through those consumer boundaries. A producer-only migration is not partial progress; it is a split-brain contract.
>
> **Traces to the goal.** A coherent system cannot hold two incompatible truths about which store is authoritative. Canonicalization only improves coherence when every decision boundary consumes the same authority.

**Proposal clauses already covered:** P1, P3, P4, and most of P5: replace dispersed authority with a canonical source and move every consumer in one unit of work, so correctness no longer depends on separately fixing each old authority site. It directly names producer-only/partial migration as invalid.

**Proposal clauses not covered:** P2's universal deletion rule and the literal “delete three copies of a number” wording; a canonical migration can retain compatibility surfaces as long as every declared boundary acknowledges the revision. P6's exact six-round provenance is not covered.

**Would its stated enforcement catch the described failure?** **Yes if the consolidation is declared as a canonical migration and the four sites are enrolled producers/consumers/validators.** The contract registry, revision markers, full-diff lint, and tests would reject moving only some consumers or leaving one declared consumer on the old authority. It would not automatically discover an undeclared copy outside the contract, and it would not require deletion before a canonical migration is initiated.

### Canonical Pipeline Operational Completeness — Accepted Intake Must Drain

**Overlap strength:** Weak and domain-specific; overlap is removal of a standing human-attention queue.

**Verbatim evidence:**

> **Earned from.** The feedback factory accepted and clustered roughly 12,000 reports into roughly 149 clusters while producing zero owned development work, and another development install was dark. Every individual stage looked present and locally tested, but no registered owner or operated transition carried accepted signal through to a real consumer. A proposed manual approval queue would merely have moved the terminal backlog onto operator attention.

**Proposal clauses already covered:** P3's rejection of supplying more human attention as the answer to a system that does not stay operationally correct; a manual approval queue is explicitly identified as moving, rather than removing, the burden. It also partially covers P4: individually present stages can still leave a missing handoff.

**Proposal clauses not covered:** P1/P2/P5's duplicated-state maintenance and deletion remedy; P6's history. Its answer is autonomous pipeline ownership and drainage, not removal of the pipeline or duplicated values.

**Would its stated enforcement catch the described failure?** **Only for a declared canonical pipeline.** The closed manifest and completeness lint catch missing ownership, handoff, terminal consumer, cadence, and evidence. They do not detect replicated numbers or demand consolidation.

### Compaction Parity

**Overlap strength:** Partial and narrowly scoped.

**Verbatim evidence:**

> **Rule.** Whatever a session must know at message one, it must still know after compaction. Context injected at session start (session-context blocks, contracts, capability inventories) must also be wired into the compaction-recovery path — re-injected, never presumed to survive in the compaction summary.
>
> **Earned from.** PR #811 (2026-06-05): the boot self-knowledge block was specced, converged through three review rounds, and built — and still shipped boot-only, until the operator asked "sessions last days; won't this be forgotten after compaction?" The whole injector class (org-intent, preferences) carried the same silent gap. A pattern three review rounds missed and one operator question caught belongs in the constitution, not in memory.

**Proposal clauses already covered:** P3, P4, and part of P6: repeated review can miss a second required wiring site, so parity must be structurally checked rather than remembered.

**Proposal clauses not covered:** P1/P2/P5's premise that the second site should be deleted. This standard requires both start and recovery paths and explicitly keeps them in parity.

**Would its stated enforcement catch the described failure?** **Yes only for session-context injector parity.** `session-context-compaction-parity.test.ts` catches a start-hook fetch missing from the compaction-recovery hook. It does not catch generic duplicated numbers.

### Friction Is a Spec — Productize the Workaround

**Overlap strength:** Weak to moderate; same anti-repayment principle, different structural action.

**Verbatim evidence:**

> **Rule.** When a hard-won manual workaround saves the day — a debugging trick, an undocumented invocation, a sequence that finally cut through — the next move is to turn it into a permanent tool. A trick that lives only in a transcript is lost the moment the session ends; as a command, hook, or skill it becomes compounding leverage for every instance after.
>
> **Traces to the goal.** A self-evolving agent that re-derives the same workaround every time it is needed is not evolving — it is treading water with extra steps.

**Proposal clauses already covered:** P1/P3/P6 at the abstraction level: repeatedly spending attention on the same manual repair is a defect; the answer is a durable structural change, not another careful re-derivation.

**Proposal clauses not covered:** P2/P5's deletion/consolidation. The standard normally adds a tool, command, hook, or skill. It does not cover the four-copy-number omission directly.

**Would its stated enforcement catch the described failure?** **No.** The registry says its enforcement is only an aspirational reviewer reminder, not a blocking gate. Nothing stated mechanically detects repeated edits to copied values.

### Notice + Solve Inefficiencies — Efficiency Is a Standing Search

**Overlap strength:** Moderate on eliminating repetitive care; nonspecific on deletion.

**Verbatim evidence:**

> **Rule.** Don't only fix the inefficiency that blocks *you* — actively LOOK for inefficiencies and eliminate them, continuously, as a first-class development habit. The moment you observe a process that is slower, more wasteful, or more repetitive than it needs to be — even one you can personally route around — treat it as a defect to solve, not a cost to absorb.
>
> **In practice.** This is the proactive sibling of *Friction Is a Spec* (which is reactive — productize the workaround you were *forced* to find). Here the trigger is observation, not obstruction: a 40-minute rebase loop, a re-paid manual step, a gate that fires the same false positive every session, a 10-minute CI that blocks a one-line change. You notice it *because you were paying attention*, name it, and solve it at the right layer — or surface it to the operator when the lever is theirs (a security/config setting you must not flip yourself). The discipline is the noticing: an inefficiency's cost is invisible precisely because everyone has already routed around it. Counterweight: scope the fix to the inefficiency's real cost — a micro-optimization nobody feels is not this standard, and a "fix" that adds more friction than it removes fails it.

**Proposal clauses already covered:** P1 and P3: a repetitive, re-paid attention cost is already classified as a defect to eliminate rather than absorb. It partially covers P2 at the verb “eliminate,” without specifying what is eliminated.

**Proposal clauses not covered:** P2/P5's precise requirement to delete the attention-demanding object or redundant copies; P4's multi-site omission; P6's exact story.

**Would its stated enforcement catch the described failure?** **No.** It is registered as a reminder/instinct rather than a blocking gate. The cited tooling and operator surfacing do not mechanically inspect a plan for duplicated values.

### Bounded Notification Surface — no feature may flood the user

**Overlap strength:** Direct in repair shape and chokepoint consolidation; domain-specific to notification creation.

**Verbatim evidence:**

> **Earned from.** The THIRD topic-spam flood (2026-06-05): a boot-time worktree detector read a transiently-wrong agent registry (lost-update race + a silent parse-failure→empty-list fallback), mass-flagged 110 properly-placed worktrees as misplaced, and emitted one attention item PER worktree — each with a unique `sourceContext`, which dodged the per-source budget the 2026-05-28 lockdown (flood #2) had added; only the global ceiling caught it, after 8 topics leaked plus a 103-ping coalesced topic. Flood #1 (2026-05-22, sentinel escalations) had already produced the SentinelNotifier fix. Three recurrences of the same shape — "a feature notifies per-element at volume" — is the recurrence signal this registry's amendment loop names; per **Distrust Temporary Success**, the second patch (per-source budgets) was a temporary success, and the root cause is that the BOUND lived at the wrong layer: in each feature's cooperation rather than at the chokepoint no feature can route around.
>
> **Traces to the goal.** The user's attention is the scarcest resource an agent touches; flooding it is incoherence at the interaction surface — the agent becoming noise to the person it exists to serve. *Structure beats Willpower*: a budget every feature is asked to respect is willpower; a budget inside the only function that can create a topic is structure.

**Proposal clauses already covered:** P1, P3, P4, and the structural pattern of P5/P6: repeated feature-local fixes leave other paths; moving the invariant to one unavoidable chokepoint removes the need to keep every emitter's local copy/discipline correct.

**Proposal clauses not covered:** P2's deletion of the attention-demanding thing; this standard retains emitters and supplies one central budget. It applies to notification containers rather than arbitrary copied numbers.

**Would its stated enforcement catch the described failure?** **Yes for the standard's own failure class, no for a generic number.** The creation-chokepoint budget, real-pipeline 1,000-notification burst test, and unfunneled-topic-creation lint catch per-feature paths that bypass the central bound. They do not search general configuration/plans for four copies.

### No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes

**Overlap strength:** Weak to moderate; it removes caller-by-caller diligence for a narrow class of repeating behavior.

**Verbatim evidence:**

> The brakes live IN the looping component (injectable clock, bounded state, unit-testable), not in the caller's good intentions — canonical shapes: `AgeKillBackoff` (veto-respecting suppressor), the live-tail guards (version gate + exponential backoff + content cap), `AttentionTopicGuard` / `topicCreationBudget` (volume budgets at the chokepoint), `LlmCircuitBreaker` (the breaker shape).
>
> **Traces to the goal.** An autonomous agent is made of loops — that is what persistence IS. An agent whose loops can compound against a degraded environment destroys the machine, the budget, and the trust it exists to earn, precisely when the environment is weakest. *Structure beats Willpower*: "remember to add backoff" is willpower; a gate that refuses a raw loop at review time is structure. This standard is the temporal twin of **Bounded Notification Surface** — that one bounds what loops emit at the user; this one bounds what loops do to the world.

**Proposal clauses already covered:** P1/P3 and part of P4: a repeating behavior must carry its invariant centrally instead of depending on every caller remembering to supply it.

**Proposal clauses not covered:** P2/P5's deletion of the looping component or copied values; P6's review history. The standard adds three brakes rather than deleting the object.

**Would its stated enforcement catch the described failure?** **Only if the failure was an unbounded repeating code path.** The loop-safety audit and sustained-failure test pattern catch missing brakes in covered loops. They do not catch numeric duplication, and the registry says the multi-machine loop-safety audit is still in progress.

### Keep the Doorway/Model Map Current

**Overlap strength:** Direct and strong for single-source derivation; domain-specific to model-doorway knowledge.

**Verbatim evidence:**

> **Rule.** The set of *doorways* the agent can reach a model through — and the top model(s) (with exact ids) behind each — is knowledge that **rots**, so it must be kept current by a standing *process*, never by anyone remembering to re-check. A stale doorway/model map is a **defect**, not a chore that's overdue.
>
> **In practice.** One machine-readable registry is the single source of truth for what doors exist and what the top model behind each is (canonical/reviewed layer) plus what each machine last actually reached (live/scanned layer); the frontier set that gates routing pins is *derived* from that record, never re-typed.
>
> A freshness lint fails loud when a pin ages out of its review window or drifts off the derived frontier set. Adding an LLM callsite or a new door without updating the registry is caught structurally, not by review vigilance.

**Proposal clauses already covered:** P1, P3, P4, and most of P5: retyped facts rot and drift, so one registry is authoritative and downstream pins are derived rather than separately maintained. Human remembering/review vigilance is explicitly rejected.

**Proposal clauses not covered:** P2's general deletion command; the standard keeps multiple derived pins and adds a recurring scan job. It does not cover P6's six-round story.

**Would its stated enforcement catch the described failure?** **Yes within doorway/model pins.** The strict freshness lint catches stale or off-derived-frontier pins, and the scan job/repository registry make the canonical value explicit. It would not catch an unrelated number copied four times.

### Stall Coverage Is Enumerated, Not Discovered

**Overlap strength:** Weak to moderate; it covers replacing incident-by-incident attention with an enumerated class surface, but only for framework stalls.

**Verbatim evidence:**

> **Rule.** Onboarding a framework into Instar REQUIRES a stall-coverage matrix: the enumerated set of session-stop classes × this framework's detection + recovery story for each, with every cell truth-typed (`covered | covered-dark | declared-gap | not-applicable`), role-typed (detector and recovery are separate fields, both required for `covered` — undetectable failures are the expensive ones), and continuously re-validated. An empty cell blocks onboarding sign-off; a declared gap requires a tracked closePath and recorded overseer acceptance; and validation never stops at sign-off — a CI ratchet keeps every matrix current as the class list grows and code changes.
>
> **Earned from.** Apprenticeship drive 5, defect #9 (2026-07-17, topic 29723): a codex-cli session sat at an interrupted-conversation prompt for 2+ hours after a server restart — silent, because the mentee's hand-built keep-working loop covered only the stop classes its author had personally hit, and nothing enumerated the rest. The operator's directive: find the standard-level gap, not the bandaid. Instar's own stall family (context-wedge, AUP loop, quota walls, ghost prompts) was learned the same way — one production incident per class, Claude-first — and none of it was written down as a coverage obligation any other framework could inherit.

**Proposal clauses already covered:** P1/P3/P4 and the general failure shape in P6: handling only the instances personally encountered leaves other instances behind; the class must be enumerated and held by a ratchet rather than rediscovered through further incidents and care.

**Proposal clauses not covered:** P2/P5's deletion of redundant copies. This standard adds and maintains a coverage matrix with detection and recovery cells. It applies to session-stop classes during framework onboarding, not arbitrary duplicated values.

**Would its stated enforcement catch the described failure?** **Only if the omitted sites were framework stall classes or their detection/recovery cells.** The class registry, matrix validator, CI ratchet, codemod, and positive-control evidence would catch an empty, stale, or unjustifiably covered cell. They would not find a generic number copied four times.

### No Deferrals

**Overlap strength:** Weak; it covers incomplete fixes, not maintenance-source deletion.

**Verbatim evidence:**

> **Rule.** Ship complete features and fixes. A deferral requires a same-PR tracked commitment with active follow-through — never an orphaned "later" note.
>
> **In practice.** "Tactical now + the rest later" without owned follow-through is how regressions recur. Default to comprehensive.

**Proposal clauses already covered:** P4 and the recurrence part of P6 where leaving another known copy is an explicit “rest later” partial fix. It requires completeness or tracked follow-through rather than presenting a site-local repair as complete.

**Proposal clauses not covered:** P1-P3/P5's diagnosis and deletion remedy; unnoticed copies rather than explicit deferrals; the exact hostile-review provenance.

**Would its stated enforcement catch the described failure?** **Only if the omitted copies were acknowledged as deferrals in the spec.** The orphan-deferral precommit step catches deferral language without markers/commitment fields. It does not discover an unmentioned fourth copy or require consolidation.

### No Manual Work (user *or* agent)

**Overlap strength:** Direct and broad on the attentional-burden premise; different on remedy.

**Verbatim evidence:**

> **Rule.** Capturing context and taking available actions must be automatic. Don't make the user remember Instar's features, and don't rely on the agent remembering to use its own tools.
>
> **In practice.** No "remember to log it" or "remember to run X" step survives into a design — for anyone. If a behavior depends on someone remembering, it isn't built yet.

**Proposal clauses already covered:** P1 and P3: any correctness behavior that depends on a person or agent continuing to remember/supply attention is already disallowed. It partially covers the desired end-state of P2—no ongoing manual care remains.

**Proposal clauses not covered:** P2/P5's required method of deletion/consolidation; P4's multiple-copy failure; P6's history. Automation is an allowed answer under this standard.

**Would its stated enforcement catch the described failure?** **No registry-stated generic mechanism would.** The entry links a full spec but names no lint/test/gate in the registry that scans plans for independently maintained numeric copies. A conformance review could identify an explicit “remember to update all four” step, but an unnoticed duplicate would not be mechanically caught by the enforcement text stated here.

### The Agent Carries the Loop

**Overlap strength:** Weak and user-attention-specific.

**Verbatim evidence:**

> **Rule.** A commitment is the agent's obligation to ACT, not the user's obligation to remember. It may never resolve by the user remembering to act. The only legitimate user-facing pull is a usable result, a genuine authorization the agent lacks, or a genuine user-input/taste decision that is theirs — each surfaced ONCE, never nagged. "Never nag the user" never means "swallow a terminal failure": a genuinely-stuck obligation surfaces exactly once.
>
> **Earned from.** 2026-06-13 (topic 20905): the agent parked two of its own actions ("watch a dry-run window", "activate dogfooding") on the operator as "tracked commitments" and called it follow-through — offloading its job onto the human's memory. The systemic proof: the commitment registry was a graveyard of un-closed `pending` agent promises, weeks old. The prose principle existed (No Manual Work) but nothing enforced it at the commitment layer — a textbook *Structure beats Willpower* gap.

**Proposal clauses already covered:** The human-facing subset of P1/P3: do not make continued correctness or completion depend on supplying user memory/attention.

**Proposal clauses not covered:** P2/P5's deletion of replicated state, P4's site omissions, and P6's provenance. It transfers execution to an agent-owned follow-through engine rather than deleting the commitment.

**Would its stated enforcement catch the described failure?** **No, unless the “attention” was an operator-owned commitment.** Its state model, owner gates, staleness governor, and parked-on-user detector catch commitments wrongly assigned to the user. They do not detect four copies of a number.

### Never-Waste Feedback — corrections compound

**Overlap strength:** Weak; it addresses repeated human correction/QA burden after the miss.

**Verbatim evidence:**

> **In practice.** A human correction is treated as evidence that some *guardian* should have caught it and didn't — logged as a guardian-failure signal that builds a heat map of where the human is doing the system's job. The capture is automatic (per [No Manual Work](#no-manual-work-user-or-agent)); the richest grading signal — what the automated layers *missed* — is never left to the agent to remember to write down. Over time the heat map tells us which guardrails are weak and which are dead weight, and the data points toward where the next standard or fix should go.
>
> **Traces to the goal.** An agent that wastes the user's corrections forces the human to keep being its memory and its QA — the opposite of a self-evolving system.

**Proposal clauses already covered:** P1/P3/P6 only at the feedback layer: repeated human catches are evidence that the system is depending on human attention/QA, and the signal should drive a structural change rather than another forgotten local correction.

**Proposal clauses not covered:** P2/P5's deletion/consolidation, P4's exact multi-site mechanism, and the hostile-review details. It captures and compounds corrections; it does not prescribe which structural fix follows.

**Would its stated enforcement catch the described failure?** **It could record the repeated corrections, but it would not catch or block the underlying four-copy failure.** `HumanAsDetectorLog` turns user corrections into guardian-failure signals. That is detection-after-feedback, not a guard against duplicated values or a deletion requirement.

## Meaning-based near-misses not counted as overlaps

The registry also contains several standards about **operator notification attention**—notably `Conservative Outbound: Act, Don't Notify`, `Near-Silent Notifications`, and `Self-Heal Before Notify — The Operator Hears Only When Self-Healing Fails`. They were searched and examined because the proposal uses “attention,” but their operative subject is whether internal events should produce user messages. The proposal's operative subject is maintenance care required to keep replicated correctness facts synchronized. Those standards do not cover P1-P6 unless the maintenance burden has separately become an operator notification, so keyword identity alone was not treated as semantic overlap.

Likewise, standards that merely require broad completeness or testing—such as `Testing Integrity`, `Side-Effects Review Gate`, and `Bug-Fix Evidence Bar (verify before you claim)`—could sometimes expose a partial fix, but their text does not establish the proposal's specific anti-maintenance, anti-diligence, canonicalization, or deletion idea. They were examined but are not included as overlapping standards.
