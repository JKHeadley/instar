# Overlap census: “Remove what demands attention — do not supply more attention”

## Coverage and method

- Registry examined: `docs/STANDARDS-REGISTRY.md`.
- Registry size examined: 787 lines, 36,593 words, 252,764 bytes.
- Total standards in the registry: 82 (`###` headings).
- Standards actually examined: 82 of 82.
- Non-standard registry material also examined: the preface, Genesis, family introductions, “Two layers,” “How a new standard joins this registry,” and “The Stakes.”
- Result below: 23 standards have at least a partial semantic overlap. They are listed in registry order, not by importance.

I used these search strategies:

1. A complete sequential read of the file, not a keyword-only sweep.
2. Heading inventory and count of all `###` articles, followed by article-by-article comparison.
3. Concept searches for the proposal's maintenance-burden idea: remembering, willpower, manual work, care, attention, repeated/recurring failure, partial fixes, and same-shaped failures.
4. Concept searches for its proposed structural technique: delete/remove duplicates, one place, chokepoint, funnel, single source of truth, canonical authority, derived values, never re-type, hand-maintained copies, and agreement invariants.
5. Domain-specific searches for the “fix one site, leave another” shape: migration parity, consumer completeness, compaction parity, per-framework matrices, per-machine defaults, per-feature cooperation, and per-tab duplication.
6. A second boundary pass over notification/attention standards. Mere use of the word “attention” was not treated as overlap when it meant message volume rather than maintenance/correctness; those articles appear only where they also contain a structural centralization or elimination clause.

For clause-level comparison, the proposal is separated into:

- **P1 — trigger:** something repeatedly fails because correctness requires constant care.
- **P2 — positive remedy:** delete the thing that requires the care.
- **P3 — rejected remedy:** do not answer by supplying more attention, diligence, or remembering.
- **P4 — failure topology:** repeated partial fixes update one site and leave another.
- **P5 — concrete technique:** remove duplicated copies of a value instead of keeping the copies synchronized.
- **P6 — earned lesson:** repeated care produced repeated partial fixes and could not make the design pass.

## Overlapping standards

### Structure beats Willpower

**Overlap extent:** direct on the anti-diligence principle; partial on the remedy.

**Verbatim registry evidence:**

> **Rule.** If a behavior matters, enforce it in architecture, not in instructions. Never rely on an agent "remembering" to follow a rule buried in a long prompt.

> **Earned from.** This is the founding lens, not a single incident — every other standard in this document is an instance of it. The recurring proof is every time an agent "knew better" and drifted anyway: it had the knowledge, lacked the structure. The crystallizing instance is **February 22, 2026** (see **Genesis**): not the first time willpower failed, but the night the lesson hardened into infrastructure. A small, exact living corroboration: in a single 2026-06-03 autonomous run the pre-push gate, the docs-coverage gate, and the dangerous-command guard each caught a mistake the author had genuinely made and forgotten — three saves in one session — every one a case of the structure firing precisely where the author's own care had already lapsed and was certain it hadn't (full account: `docs/lessons/2026-06-03-listsessions-hotloop-success-story.md`).

**Already covers:** P1, P3, and P6: repeated drift despite knowledge/care, and the rejection of remembering or trying harder as protection. It partially covers P2 by demanding an architectural answer.

**Does not cover:** It does not say the architectural answer must be deletion; it permits gates, hooks, dispatch tables, and other enforcement. It does not specifically cover duplicated values, multi-site synchronization, or deleting three of four copies (P4–P5).

**Would its stated enforcement catch the described failure?** Not generically. The cited `standards-coverage.mjs` ratchet catches missing named-guard coverage, not four duplicated numeric literals or partial synchronization among them. A domain-specific guard hanging from this root could catch the failure, but the root's own aggregate/per-family coverage floor would not establish that the duplicated value had been removed.

### No Silent Degradation to Brittle Fallback

**Overlap extent:** weak and implementation-shaped; it centralizes behavior so correctness is inherited from one place.

**Verbatim registry evidence:**

> **In practice.** Route every gating LLM call through the one shared provider that swaps-then-fails-closed (`IntelligenceRouter.failureSwap` for `gating: true` calls), so the whole fleet inherits the behavior from one place (Structure beats Willpower).

**Already covers:** Part of P2–P5 in one narrow domain: eliminate per-callsite responsibility by routing all sites through one shared implementation, so individual sites do not each need attention to remain aligned.

**Does not cover:** It does not require deleting duplicated data or values, and it is scoped to gating LLM failure behavior. It does not address repeated hostile-review rounds or care producing partial fixes (P1, P4, P6) except by analogy.

**Would its stated enforcement catch the described failure?** Only if the repeated copies were gating-LLM fallback callsites covered by `tests/unit/no-silent-llm-fallback.test.ts`. It would not catch an arbitrary number copied four times.

### Bounded Blast Radius

**Overlap extent:** weak and domain-specific; it contains an explicit “remove duplicate instances” technique and rejects good behavior as the safety mechanism.

**Verbatim registry evidence:**

> **Rule.** Every operation that can spawn subprocesses, allocate memory, or otherwise consume a *physical* host resource must have a STRUCTURAL ceiling on how much it can consume *at once* — a bound enforced in code, not assumed by good behavior.

> Duplicate-instance multipliers are removed by a single-instance lock (`src/core/SingleInstanceLock.ts`).

**Already covers:** P3 and a narrow analogue of P2/P5: do not depend on careful behavior; remove duplicated live instances through a single-instance lock rather than keeping several actors well-behaved.

**Does not cover:** Its duplicates are processes, not copies of a maintained value. It does not establish the constant-care trigger, multi-site partial-fix pattern, or deletion of redundant configuration/state (P1, P4–P6).

**Would its stated enforcement catch the described failure?** No for the proposal's generic failure. The spawn-funnel lint and burst-invariant test catch unbounded provider construction and concurrent-holder excess; they do not scan for duplicated numeric sources of truth.

### Capacity Safety — No Unbounded Self-Action

**Overlap extent:** partial on repeated same-shaped point fixes versus one class-wide structural guard; weak on deletion.

**Verbatim registry evidence:**

> Three independent agents + a master-registry verification converged on one root: 20 distinct self-inflicted loops 2026-04-16 → 2026-07-02 (swap-thrash, both topic-floods, the fork-bomb OOM, the test-storm, the reaper's 17,503 kill-requests/day, the inescapable "session paused" loop) were the SAME shape — an unbounded self-triggered action under sustained pressure — yet each earned its own bespoke breaker one incident at a time.

> Per *Distrust Temporary Success*: 20 same-shaped incidents is not 20 bugs — it is one missing class. The class-closure system that answers "what class is this, and what guard ends it?" landed the same day (#1347); this standard names the class's convergence invariant and the guard closes it.

**Already covers:** P1, P4, and P6: repeated same-shaped failures, bespoke one-at-a-time fixes, and a move from local care to a class-level structural answer. It partially covers P3.

**Does not cover:** It does not say to delete the attention-requiring thing or remove duplicated values (P2, P5). Its structural answer is registration, linting, and convergence testing, not deletion.

**Would its stated enforcement catch the described failure?** No unless the duplicated number participates in a registered self-triggered controller. The self-action registry, emit lint, and convergence test catch unregistered/unbounded self-actions, not general multi-site value duplication.

### Iterative Audit to Convergence

**Overlap extent:** direct on the repeated-review/partial-fix topology, but its prescribed process is different from the proposal's deletion remedy.

**Verbatim registry evidence:**

> **Rule.** An audit is never one-off. A single pass has blind spots, and the fixes themselves reveal or introduce new instances. The only honest definition of "thorough" is *converged*: audit → fix → **RE-audit** → … until a clean pass returns **zero new discoveries**.

> **Earned from.** 2026-06-07 (topic 19437), ratified with Justin: "audit should never be a one-off — audit, then fix, then ANOTHER audit until the audits return no new discoveries… this is the only way to make sure audits are thorough and don't miss anything." The crystallizing instance is the LLM-fallback audit itself, where the round-1 sweep's "~20 sites" became 44 on the post-fix re-sweep — proof that the fixes and a second look surface what the first pass cannot.

**Already covers:** P4 and much of P6: a fix at one set of sites can reveal or leave other sites, so review repeats until no new instance remains. It also covers the six-round hostile-review setting as a converging audit shape.

**Does not cover:** It does not choose deletion over synchronization (P2/P5), and in fact requires continued audit attention until convergence rather than stating that the underlying attention demand should be removed. It does not independently identify duplicated values as the root cause.

**Would its stated enforcement catch the described failure?** Conditionally. If the hostile coherence review were recorded as a canonical converged audit, `write-audit-convergence.mjs`, the precommit gate, and `audit-convergence-reports.test.ts` would refuse a convergence claim without at least two rounds, a zeroed final round, and closed dispositions. They would catch an unfinished partial sweep, but not force the final solution to be deletion; a form-valid shallow audit also remains an expressly stated limit.

### Distrust Temporary Success — A Recurrence Is a Root Cause

**Overlap extent:** direct on recurrence proving that point fixes are not root fixes; partial on the remedy.

**Verbatim registry evidence:**

> **Rule.** When a fix keeps working but the problem keeps returning, the recurrence is the signal: a self-healing system's own resilience is hiding the root cause. A patch that resets a symptom is not a fix, and a system that recovers on its own will make a code-level bug look transient forever. Before declaring a thing fixed, verify the *cause* is gone — not just the symptom.

> **Traces to the goal.** A self-evolving agent that trusts temporary success evolves *patches*, not fixes — it re-pays the same root cost forever while believing each symptom-reset was progress.

**Already covers:** P1, P4, and P6: recurrence means the local fixes did not remove the cause, and repeatedly paying the same cost is not completion. It supports the proposal's distinction between more partial fixes and removing the root.

**Does not cover:** It does not identify redundant copies or mandatory deletion as the root-cause remedy (P2/P5). It permits any root fix that proves the cause is gone.

**Would its stated enforcement catch the described failure?** Partially. The autonomous-completion criterion and P14 lessons-aware reviewer can flag a plan or completion claim that treats a recurring symptom as fixed. The article acknowledges no dedicated `MessagingToneGate` behavior. It would not mechanically detect four copies of a number or require reducing them to one.

### Framework-Agnostic — and Framework-Optimizing

**Overlap extent:** direct in its per-engine-artifact clause; this is an explicit single-source/never-hand-maintain rule.

**Verbatim registry evidence:**

> And per-engine artifacts (like a startup tool-briefing) are generated from one shared source of truth, never hand-maintained per engine.

> The **codey under-briefing finding** (2026-05-23) — recent *live proof* that the principle reaches the awareness layer: OpenAI-engine agents invented flimsy workarounds (a shell timer instead of the commitment-tracker) because their briefing was a *separate, hand-maintained, incomplete* checklist that escaped the Agent Awareness Standard. Even mid-portability-effort, the engine had quietly become second-class.

**Already covers:** P1, P2, P3, P4, and P5 within per-engine artifacts: separate hand-maintained copies drift; use one shared source and generate the variants rather than supplying care to every copy. It also contains an earned partial-copy failure.

**Does not cover:** It is scoped to cross-engine features/artifacts, not every duplicated value. It does not state that deletion is always required when any component needs continuing attention, nor the six-round care-produced-partial-fixes lesson in general (P6).

**Would its stated enforcement catch the described failure?** Only on its declared launch/inject surfaces. Compiler exhaustiveness, `framework-agnosticism.test.ts`, and `assertFrameworkGenerality` catch missing/drifting framework launch/injection entries and require cross-engine review. The article does not cite a general lint that catches every separately hand-maintained per-engine artifact or arbitrary copied number.

### An Instar Agent Is Always a Multi-Machine Entity

**Overlap extent:** partial on reviewer-care failing repeatedly and replacing it with a structural default; weak on deletion.

**Verbatim registry evidence:**

> **Earned from.** 2026-07-03 (topic 29723), operator-ratified: the tiered-intelligence-delegation spec defaulted its consult memory to machine-local, conflicting with the single-unified-agent goal — and it survived SEVEN convergence rounds before the operator caught it on read. That it took the operator's read, not the review machinery, is the tell: the always-multi-machine expectation lived in prose and reviewer habit, not in structure.

> *Structure beats Willpower*: don't rely on the agent or a reviewer *remembering* that the agent is multi-machine; make the unified default the path of least resistance and machine-local the posture that must argue for itself.

**Already covers:** P1, P3, P4, and P6 at the review-process level: many convergence rounds did not prevent the same class of omission, and the response was to remove dependence on reviewer memory by changing the default.

**Does not cover:** It does not delete duplicated values or establish single-source derivation (P2/P5). Its subject is machine-local versus unified state posture.

**Would its stated enforcement catch the described failure?** No for a generic four-copy number. `lint-machine-local-justification.js` and the strengthened spec-converge check catch unjustified machine-local surfaces; they do not detect redundant constants unless the duplication manifests as an undefended machine-local posture.

### Cross-Store Coherence Is an Invariant

**Overlap extent:** direct on duplicated authorities that must remain in agreement, but it chooses monitored agreement rather than deletion.

**Verbatim registry evidence:**

> **Rule.** Any two stores that answer the same question — about identity, authority, machine liveness, or configuration — must have a **declared agreement invariant**, and that invariant must be **checked on a cadence by machinery**. A pair of authoritative stores with no coherence check is a contradiction waiting for a code path to read the wrong one. When a NEW store is introduced that answers a question an existing store already answers, declaring the invariant is part of introducing it.

> Two authoritative identity stores contradicted each other for **19 days** with no tripwire, and the contradiction became total silent message loss the moment mesh forwarding wired the weaker store into the delivery path.

**Already covers:** P1, P4, and P5's underlying danger: multiple copies/authorities answering the same question drift and one code path reads a stale/wrong answer. It rejects unguarded reliance on care (P3).

**Does not cover:** It does not require deleting redundant stores (P2). Its stated remedy is to declare and continuously check an agreement invariant, which still maintains more than one answer and therefore differs from the proposal's “delete three copies” technique. Its named domains are identity, authority, liveness, and configuration.

**Would its stated enforcement catch the described failure?** Yes if the four copies qualify as stores answering the same question and are enrolled in the coherence audit: the scheduled audit catches disagreement, and the wiring-time gate refuses enablement against an unresolved dependency. It would not catch unregistered literals or conclude that one source must replace the stores.

### Migration Parity

**Overlap extent:** direct but narrow on “fix one population/path, leave another.”

**Verbatim registry evidence:**

> **Rule.** Any change to agent-installed files (hooks, config defaults, CLAUDE.md template, built-in skills) must reach *existing* agents through the update path — not only new agents via `init`.

> A feature that only works for new agents is a broken feature.

**Already covers:** P4 and part of P6: changing only the new-agent site while leaving the existing-agent site unchanged is explicitly incomplete. It removes dependence on remembering a second rollout path (P3).

**Does not cover:** It keeps init and migration paths in parity rather than deleting a duplicated value/path (P2/P5). It does not generalize to arbitrary copies or make constant-care itself the deletion trigger (P1).

**Would its stated enforcement catch the described failure?** Yes only when the copies are agent-installed files split across init and update. `migration-guarantee.test.ts` executes committed pre-migration shapes through both paths, and `protect-migration-guarantee.js` protects that gate. It would not catch four unrelated constants.

### Migration-Consumer Completeness

**Overlap extent:** direct on canonicalizing a source while preventing “fix producer, leave consumer” partial work.

**Verbatim registry evidence:**

> **Rule.** A canonical authority migration is incomplete until every authorization, validation, routing, and compatibility consumer of the replaced authority moves in the same unit of work, with tests that exercise the new canonical source through those consumer boundaries. A producer-only migration is not partial progress; it is a split-brain contract.

> **Earned from.** PR #1523: Threadline's hash-chained `ThreadLog` had become the canonical inbound evidence store, while reply authorization still read only the legacy listener inbox. The migration producer and its own tests were green, but an authorization consumer remained on the retired authority because no process gate enumerated consumers before the migration shipped.

**Already covers:** P2, P4, and P5 in a canonical-migration context: establish one canonical source, move all readers together, and do not leave legacy authority copies alive at missed consumers. It directly covers the “fix one site, leave another” topology.

**Does not cover:** It applies when a canonical migration is already underway; it does not independently require initiating deletion merely because continued attention is costly (P1/P3). It does not contain the care-produced-five-partial-fixes lesson (P6).

**Would its stated enforcement catch the described failure?** Yes if the duplicated number is represented by an enrolled canonical-migration contract. The registry/marker lint requires producer, consumer, and validator revision agreement in the same diff. It would not catch copies omitted from the declared contract, and semantic completeness remains review authority.

### Canonical Pipeline Operational Completeness — Accepted Intake Must Drain

**Overlap extent:** partial on refusing to make continuing human attention the mechanism that keeps a system moving; weak on deletion.

**Verbatim registry evidence:**

> **Rule.** A canonical accepted intake must have an authoritative admission decision, one durable owner and fenced lease, operated cadence, an explicit terminal or governed waiting disposition, backlog-age and progress observability, and an end-to-end positive control proving the real consumer advances the handoff. A pipeline that makes a human its default approver is operationally incomplete unless a constitution-level requirement demands that gate: judgment defaults to a registered autonomous Instar agent using an appropriate frontier model inside deterministic floors, while human review is reserved for ambiguity, integrity repair, or explicit intervention.

> A proposed manual approval queue would merely have moved the terminal backlog onto operator attention.

**Already covers:** P1 and P3 in a pipeline domain: a system is incomplete when normal progress depends on sustained human approval attention, and moving a backlog onto that attention is not operational completion.

**Does not cover:** It does not say to delete the intake/pipeline element that needs care (P2), remove duplicated values (P5), or address one-site partial fixes and repeated hostile-review failures (P4/P6). Its remedy is autonomous ownership, cadence, and drain machinery.

**Would its stated enforcement catch the described failure?** No for the proposal's generic duplicated-number case. The canonical-pipeline manifest and lint catch missing owners, handoffs, consumers, cadence/evidence declarations, and structural coverage for enrolled pipelines. Semantic review could reject a default manual approver, but the lint does not detect arbitrary duplicated sources or require their deletion.

### Compaction Parity

**Overlap extent:** direct but narrow on the exact “update one site, miss its twin” failure shape; its remedy is enforced duplication/parity, not deletion.

**Verbatim registry evidence:**

> **Rule.** Whatever a session must know at message one, it must still know after compaction. Context injected at session start (session-context blocks, contracts, capability inventories) must also be wired into the compaction-recovery path — re-injected, never presumed to survive in the compaction summary.

> **Earned from.** PR #811 (2026-06-05): the boot self-knowledge block was specced, converged through three review rounds, and built — and still shipped boot-only, until the operator asked "sessions last days; won't this be forgotten after compaction?" The whole injector class (org-intent, preferences) carried the same silent gap. A pattern three review rounds missed and one operator question caught belongs in the constitution, not in memory.

**Already covers:** P3, P4, and P6: repeated review care missed a second site, and a parity mechanism replaces reviewer memory. The quoted incident closely matches the proposal's review-round provenance.

**Does not cover:** It deliberately requires two delivery paths and checks their parity; it does not delete the twin or derive both from a single source (P2/P5). It is scoped to session-start and compaction-recovery context.

**Would its stated enforcement catch the described failure?** Yes if the missed copies are `*/session-context` fetches split across the two hooks: `session-context-compaction-parity.test.ts` requires every start-hook fetch to appear in the recovery hook. It would not catch arbitrary copied values elsewhere.

### Friction Is a Spec — Productize the Workaround

**Overlap extent:** partial on converting repeatedly repaid manual attention into durable structure; weak on deletion.

**Verbatim registry evidence:**

> **Rule.** When a hard-won manual workaround saves the day — a debugging trick, an undocumented invocation, a sequence that finally cut through — the next move is to turn it into a permanent tool. A trick that lives only in a transcript is lost the moment the session ends; as a command, hook, or skill it becomes compounding leverage for every instance after.

> **Traces to the goal.** A self-evolving agent that re-derives the same workaround every time it is needed is not evolving — it is treading water with extra steps.

**Already covers:** P1 and P3: repeated manual attention or re-derivation is treated as a structural defect, not something to keep doing more carefully. It partially covers P2 by requiring removal of the manual workaround as the operative mechanism.

**Does not cover:** The replacement is a permanent tool, not deletion of the underlying attention-demanding thing or duplicated values (P2/P5). It does not cover multi-site partial fixes or review rounds (P4/P6).

**Would its stated enforcement catch the described failure?** No mechanically. The article states: “Aspirational enforcement: none beyond the reviewer prompt.” The reviewer could surface recurring manual synchronization as friction, but no cited gate detects the four copies.

### Notice + Solve Inefficiencies — Efficiency Is a Standing Search

**Overlap extent:** partial and broad; it treats re-paid manual/repetitive cost as a defect to eliminate.

**Verbatim registry evidence:**

> **Rule.** Don't only fix the inefficiency that blocks *you* — actively LOOK for inefficiencies and eliminate them, continuously, as a first-class development habit. The moment you observe a process that is slower, more wasteful, or more repetitive than it needs to be — even one you can personally route around — treat it as a defect to solve, not a cost to absorb.

> You notice it *because you were paying attention*, name it, and solve it at the right layer — or surface it to the operator when the lever is theirs (a security/config setting you must not flip yourself).

**Already covers:** P1 and part of P2/P3: a repetitive cost should be eliminated at the right layer rather than continuously absorbed or routed around.

**Does not cover:** It does not specify deletion, single-source derivation, duplicated values, or the fix-one-site failure pattern (P4–P6). “Eliminate” may be satisfied by automation, optimization, or another structural fix.

**Would its stated enforcement catch the described failure?** No. The article explicitly describes enforcement as “an instinct surfaced as a reminder, like its sibling — not a blocking gate; honest gap, noted not claimed.”

### Bounded Notification Surface — no feature may flood the user

**Overlap extent:** direct as an architectural analogue: repeated feature-by-feature fixes were replaced by one unavoidable chokepoint; domain-specific to notifications.

**Verbatim registry evidence:**

> **Rule.** Any code path that can create user-facing notification containers (Telegram topics today; any channel tomorrow) must be bounded by a hard budget enforced at the creation chokepoint — not in each feature's good intentions — and any emitter that loops over a collection must aggregate (one summary notification, never one per element). A feature whose failure mode includes "notify N times for N inputs" may not ship without a burst test proving the bound holds.

> Three recurrences of the same shape — "a feature notifies per-element at volume" — is the recurrence signal this registry's amendment loop names; per **Distrust Temporary Success**, the second patch (per-source budgets) was a temporary success, and the root cause is that the BOUND lived at the wrong layer: in each feature's cooperation rather than at the chokepoint no feature can route around.

**Already covers:** P1, P3, P4, and P6: repeated local patches failed because each feature had to cooperate; the lasting change moved responsibility to the single creation chokepoint. It partially covers P2/P5 by eliminating distributed copies of the enforcement responsibility.

**Does not cover:** It does not delete the notification feature or necessarily delete duplicated numeric budgets; it centralizes a bound. Its subject is user-facing notification containers, not general state/configuration maintenance.

**Would its stated enforcement catch the described failure?** Yes only in its domain. `topicCreationBudget`, the funnel lint, and the 1,000-notification burst test catch a feature that bypasses or exceeds the centralized topic bound. They do not catch a general number copied four times unless those copies cause this notification invariant to fail.

### No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes

**Overlap extent:** partial as another “put the invariant in the component, not in callers' care” rule; weak on deletion.

**Verbatim registry evidence:**

> The brakes live IN the looping component (injectable clock, bounded state, unit-testable), not in the caller's good intentions — canonical shapes: `AgeKillBackoff` (veto-respecting suppressor), the live-tail guards (version gate + exponential backoff + content cap), `AttentionTopicGuard` / `topicCreationBudget` (volume budgets at the chokepoint), `LlmCircuitBreaker` (the breaker shape).

> Per **Distrust Temporary Success — A Recurrence Is a Root Cause**: three same-shaped incidents in one day is not three bugs — it is one missing standard.

**Already covers:** P1, P3, P4, and P6 at the invariant-placement level: same-shaped repeated incidents mean a class-level structural brake is missing, and callers' intentions are not sufficient.

**Does not cover:** It adds brakes rather than deleting the repeating behavior or copies (P2/P5). It applies to loops/retries/monitors and their bounds, not general duplicated data.

**Would its stated enforcement catch the described failure?** No unless the four copies are part of a repeating-behavior brake and their drift violates the sustained-failure bound. The cited audit/test pattern catches missing backoff, breaker, cap, or restart-survival, not generic duplicate values.

### Keep the Doorway/Model Map Current

**Overlap extent:** direct on single-source derivation and never re-typing copies; partial because it retains a standing scan for genuinely changing external facts.

**Verbatim registry evidence:**

> **Rule.** The set of *doorways* the agent can reach a model through — and the top model(s) (with exact ids) behind each — is knowledge that **rots**, so it must be kept current by a standing *process*, never by anyone remembering to re-check. A stale doorway/model map is a **defect**, not a chore that's overdue.

> **In practice.** One machine-readable registry is the single source of truth for what doors exist and what the top model behind each is (canonical/reviewed layer) plus what each machine last actually reached (live/scanned layer); the frontier set that gates routing pins is *derived* from that record, never re-typed.

**Already covers:** P1, P3, and P5 directly in the model-routing domain: copied pins that need manual updating are replaced by one canonical registry and derived consumers, never re-typed. It partially covers P2 by removing maintained copies as authorities.

**Does not cover:** It does not delete the underlying map or external re-probing responsibility; changing model availability genuinely requires a standing process. It does not contain the one-site partial-fix/review-round provenance (P4/P6).

**Would its stated enforcement catch the described failure?** Yes if the copied number/value is a model pin or doorway fact covered by the registry: the strict freshness lint catches stale pins and drift from the derived frontier set, and the scan job refreshes the canonical record. It would not catch unrelated copied values.

### Stall Coverage Is Enumerated, Not Discovered

**Overlap extent:** partial on replacing per-site memory with one class registry plus forced propagation; it still maintains per-framework matrices.

**Verbatim registry evidence:**

> **Traces to the goal.** A self-evolving agent that learns its failure modes one production stall at a time is paying tuition it already paid. Enumerating the class space once and forcing every framework to answer it is *Structure beats Willpower* applied to failure knowledge: the map of how sessions die stays complete because a ratchet demands it, not because the next integrator remembers the last incident.

> adding a class runs the registry codemod so every existing matrix gets a `seededAt`-stamped `declared-gap (new-class, unreviewed)` row whose calendar aging ratchet (warning at +45d, red at +60d) makes unreviewed debt impossible to park forever.

**Already covers:** P1, P3, and P4: stop rediscovering/fixing the same failure class one framework at a time; enumerate it once and structurally force every site to account for it.

**Does not cover:** It does not delete the per-framework copies/matrix rows (P2/P5); it propagates them mechanically and validates parity. It does not address the proposal's number-copy example or care-produced review failures (P6).

**Would its stated enforcement catch the described failure?** Yes only if the omitted sites are framework stall-coverage matrix cells. The matrix validator, class codemod, and CI ratchet catch a missing/stale framework response. They do not catch an arbitrary duplicated number.

### No Deferrals

**Overlap extent:** weak but real on refusing partial fixes that knowingly leave the rest for later.

**Verbatim registry evidence:**

> **Rule.** Ship complete features and fixes. A deferral requires a same-PR tracked commitment with active follow-through — never an orphaned "later" note.

> **In practice.** "Tactical now + the rest later" without owned follow-through is how regressions recur. Default to comprehensive.

**Already covers:** P4 and part of P6 when the one-site fix explicitly defers remaining sites: a knowingly partial fix is not complete and recurrent regression is expected.

**Does not cover:** It allows tracked follow-through rather than requiring deletion now. It does not identify constant-care duplication, reject diligence, or require one source of truth (P1–P3, P5).

**Would its stated enforcement catch the described failure?** Only if the partial fixes contain recognizable deferral language without required markers/frontmatter. The orphan-deferral precommit step would refuse that commit. It would not catch silently overlooked copies—the exact case where no “later” note exists.

### No Manual Work (user *or* agent)

**Overlap extent:** direct on eliminating correctness that depends on someone remembering; partial because its accepted remedy is automation, not necessarily deletion.

**Verbatim registry evidence:**

> **Rule.** Capturing context and taking available actions must be automatic. Don't make the user remember Instar's features, and don't rely on the agent remembering to use its own tools.

> **In practice.** No "remember to log it" or "remember to run X" step survives into a design — for anyone. If a behavior depends on someone remembering, it isn't built yet.

> Agent-manual is the same willpower failure as user-manual.

**Already covers:** P1 and P3 directly: a design is unfinished when correctness depends on recurring human/agent attention or remembering. It partially covers P2 by requiring removal of the manual step.

**Does not cover:** It permits automatically maintaining four copies, which is precisely the alternative the proposal rejects; it does not require deleting the copies or deriving them from one source (P2/P5). It does not specifically cover one-site partial fixes or six hostile-review rounds (P4/P6).

**Would its stated enforcement catch the described failure?** It would catch an explicit design step saying someone must remember to keep the four copies aligned when the standards-conformance review applies. It would not necessarily catch four code literals with no documented manual step, and the article's own cited full spec does not name a dedicated duplicate-value ratchet.

### Dashboard UX Standard — Reachable, Self-Explanatory, Responsive

**Overlap extent:** weak and limited to one UI floor; it prefers shared components over per-tab copies.

**Verbatim registry evidence:**

> **F7** shared component vocabulary over per-tab inline styles;

> A quality bar that lives only in a style guide is a wish; each floor is a machine-checkable test that fails the build on a NEW regression.

**Already covers:** A narrow P2/P3/P5 analogue: common UI behavior should live in shared components rather than independently maintained per-tab styles, and correctness should not depend on style-guide diligence.

**Does not cover:** It does not establish that every per-tab value must be deleted, does not address general duplicated state/configuration, and does not contain the repeated partial-fix provenance (P1, P4, P6).

**Would its stated enforcement catch the described failure?** Not currently for F7 as stated. The article lists shipped tests for F1, F2, F9, F10, and F11 and says F3–F8 remain tracked follow-up floors. Therefore its currently cited enforcement would not catch four duplicated style values under F7, much less an arbitrary duplicated number.

### Never-Waste Feedback — corrections compound

**Overlap extent:** partial on repeated human corrections proving that the system, not the human's continued attention, must change.

**Verbatim registry evidence:**

> A human correction is treated as evidence that some *guardian* should have caught it and didn't — logged as a guardian-failure signal that builds a heat map of where the human is doing the system's job.

> Over time the heat map tells us which guardrails are weak and which are dead weight, and the data points toward where the next standard or fix should go.

> The deeper root is older: corrections that got fixed-and-forgotten in the moment, so the same class of miss recurred — the correction's value spent once instead of compounding.

> **Traces to the goal.** An agent that wastes the user's corrections forces the human to keep being its memory and its QA — the opposite of a self-evolving system.

**Already covers:** P1, P3, P4, and P6: repeated corrections/partial momentary fixes indicate guardian failure, and the human must not remain the recurring QA/attention supplier. It can identify dead-weight guardrails as part of the data.

**Does not cover:** It captures and compounds correction signals rather than mandating deletion of the attention-demanding element. It does not state single-source derivation or removal of duplicated values (P2/P5).

**Would its stated enforcement catch the described failure?** It would record the repeated hostile-review corrections as guardian-failure signals through `HumanAsDetectorLog` when that capture path applies, making the recurrence visible. It would not mechanically catch or remove the four copies, and the article does not claim that the heat map itself blocks a partial fix.

## Boundary exclusions from the semantic sweep

The following near-matches were searched and read but are not counted above because their operative subject does not cover maintenance correctness or multi-site duplication:

- `Conservative Outbound: Act, Don't Notify`, `Near-Silent Notifications`, `Self-Heal Before Notify — The Operator Hears Only When Self-Healing Fails`, and `The Agent Carries the Loop` conserve the **operator's** attention or memory. They do not cover engineering care needed to synchronize duplicated sources, except through the separate `No Manual Work` article already listed.
- `Close the Loop` requires continued resurfacing until deliberate closure. It addresses abandonment over time, not removing an element whose correctness itself requires continuing care.
- `Observation Needs Structure` makes observation duties unskippable. It adds a required artifact to ensure attention occurs; it does not cover deleting a duplicated maintenance obligation.
- `Testing Integrity`, `Bug-Fix Evidence Bar (verify before you claim)`, and `Side-Effects Review Gate` increase verification/review coverage. They can expose a bad partial fix, but their rules do not address duplicated authorities, single-source derivation, or removal of a recurring attention burden.
