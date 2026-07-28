# Instar Design Principles & Lessons Learned

**Canonical index of every standard, principle, and hard-earned lesson that constrains Instar design work.**

This is the source-of-truth catalog the `/spec-converge` lessons-aware reviewer consumes (8th reviewer, see `skills/spec-converge/`). It's also what every Instar agent should consult before drafting a new spec, building new infrastructure, or amending a primitive.

The catalog is structured so a reviewer (human or LLM) can answer one question fast: **"Does this new design contradict or fail to engage with any established Instar principle, standard, or lesson?"**

---

## How to use this document

**Author of a new spec:** Before stamping `status: converged` or `approved: true`, run your spec against every section below. Note in the spec's frontmatter under `lessons-engaged:` which entries the spec engages with (and which it explicitly declines, with rationale).

**Reviewer (human or `/spec-converge` 8th reviewer):** Iterate every section. For each principle / standard / lesson, ask: "Does this spec respect it? Contradict it? Ignore it?" Output structured findings.

**Maintenance:** When a new feedback memory entry is written (`.instar/memory/feedback_*.md`) or a new principle is added to `CLAUDE.md` or a new design spec is approved that codifies infrastructure, add a corresponding row to the table below. The index is append-only by design — old lessons remain even after they're integrated into infrastructure, because new contributors need to know *why* the infrastructure exists.

---

## Part 1 — Foundational Principles (P1-P13)

These are the principles every Instar design must engage with explicitly. Violating one without explicit justification is a critical convergence-blocker.

### P1. Structure > Willpower (THE foundational principle)

**Statement:** Never rely on agents "remembering" to follow instructions in long prompts. Bake intelligence into the architecture.

**Source:** `CLAUDE.md` ("Standards" section), enforced session-wide.

**Translation:**
- Session-start hooks inject context automatically
- Programmatic gates enforce required steps
- Dispatch tables route decisions to the right source
- Behavioral hooks guard against anti-patterns

If a behavior matters, enforce it structurally. **A 1,000-line prompt is a wish. A 10-line hook is a guarantee.**

**Design-pipeline application:**
- Any spec proposing a new "rule the agent must follow" must propose a structural enforcement mechanism (hook, gate, code path) — not just documentation.
- Any spec whose only enforcement is "the agent will read this and remember" should be rejected and reshaped to include structural enforcement.

**Backtrack-tells:**
- "The agent should know to..."
- "When [situation] arises, the agent ought to..."
- "Critical: the agent must remember to..."

If you see these in a spec without a paired hook/gate/code change, the spec is willpower-based.

---

### P2. Signal vs Authority

**Statement:** Brittle/low-context filters detect and emit signals. Only a higher-level intelligent gate with full context has blocking authority.

**Source:** `docs/signal-vs-authority.md`, `.instar/memory/feedback_signal_vs_authority.md`.

**Translation:**
- Pattern matchers (regex, deterministic checks) → emit signals
- LLM-backed reasoners with full context → can deny / mutate
- Never let a brittle detector be the gate; always route to an intelligent authority

**Design-pipeline application:**
- Any spec proposing a "guard," "filter," "checker," or "validator" must declare: is this a signal-emitter or an authority? If authority, where's the full-context LLM call?
- Any spec proposing automatic mutation (file edits, settings flips, send actions) must route through a trust-aware authority.

**Backtrack-tells:**
- Regex-based blocking of user actions
- Deterministic kill-switches without LLM second opinion
- "Auto-fix" wired without trust-floor consultation

---

### P3. Migration Parity Standard

**Statement:** Any change to agent-installed files (`.claude/settings.json` hooks, `.instar/config.json` defaults, CLAUDE.md template sections, hook scripts, built-in skills) MUST be handled so existing agents receive it on update. A feature that only works for new agents is a broken feature.

**Source:** `CLAUDE.md` ("Standards" section, explicit "NON-NEGOTIABLE").

**Translation (six required mechanisms):**
1. Hook template changes → migration in `migrateSettings()` patching existing `.claude/settings.json`
2. Config defaults → `migrateConfig()` with existence checks (only add missing fields)
3. CLAUDE.md sections → `migrateClaudeMd()` with content-sniffing guards
4. **Built-in hooks** (`instar/` directory) → **always overwritten** in `migrateHooks()` (lesson from `hook-event-reporter.js` ESM/CJS wedge — never install-if-missing)
5. Built-in skills → adding new = no migration; updating existing content = idempotent migration in `PostUpdateMigrator`
6. Idempotency mandatory — every migration safe to run multiple times

**Design-pipeline application:**
- Any spec touching `.claude/`, `.instar/`, CLAUDE.md/AGENT.md template, hook scripts, or built-in skills MUST ship its PostUpdateMigrator entry in the same PR.
- No "v0.2 will add the migration" deferrals. The migration is part of v0.1 or the feature doesn't ship.

**Backtrack-tells:**
- "v0.2 deferred: migration backfill for existing agents"
- "First applyX call cold-renders for legacy agents"
- "Migration is its own one-shot tool, separate PR"
- Stamp/diff-protection mechanisms applied to built-in hooks (re-creates the hook-event-reporter wedge)

---

### P4. Testing Integrity Standard

**Statement:** Every significant feature requires ALL THREE test categories. No exceptions.

**Source:** `CLAUDE.md` ("Standards" section, explicit "NON-NEGOTIABLE"). Full spec: `docs/specs/TESTING-INTEGRITY-SPEC.md`. E2E template: `docs/E2E-TESTING-STANDARD.md`.

**Origin incident:** StallTriageNurse shipped with 55 passing tests but was production-broken (5 critical bugs only caught by real-API e2e). That's the canonical "tests passed, feature didn't work" failure mode this standard prevents.

**Translation (three canonical categories):**
- **Tier 1: Unit** (`tests/unit/`) — module in isolation with real dependencies. "Does the logic work?"
- **Tier 2: Integration** (`tests/integration/`) — full HTTP pipeline. "Do the API routes work when the feature is available?"
- **Tier 3: E2E Lifecycle** (`tests/e2e/`) — production init path mirroring `server.ts`. "Is the feature actually alive? Returns 200, not 503?"
- **Wiring integrity tests** — every DI'd component verifies deps are not null, not no-ops, delegate to real implementations
- **Semantic correctness tests** — both sides of every decision boundary with realistic inputs
- Phase 1 "feature is alive" E2E test is the single most important test for any feature with API routes

**Design-pipeline application:**
- Any spec proposing new HTTP routes, new server-side modules, or new lifecycle stages MUST plan all three tiers in v0.1.
- Pure-data primitives may justify deferring Tier 2/3 if there are no HTTP routes (but the justification must be explicit + signed).

**Backtrack-tells:**
- "Tier 3 e2e queued as follow-up"
- "Integration tests land with the HTTP wiring follow-up"
- "Abbreviated test coverage matches PR #X precedent" (the precedent might itself be a backtrack)

---

### P5. Agent Awareness Standard

**Statement:** Every feature added to Instar MUST include a corresponding update to the CLAUDE.md template (`src/scaffold/templates.ts` → `generateClaudeMd()`). An agent that doesn't know about a capability effectively doesn't have it.

**Source:** `CLAUDE.md` ("Standards" section).

**Translation:**
- API endpoints → Capabilities section with curl examples
- Proactive triggers → Feature Proactivity ("when user does X → use this")
- Registry lookups → "Registry First" table if it answers a state question
- Building blocks → "Building New Capabilities" if it's a tool to reach for

**Design-pipeline application:**
- Any spec proposing a new agent-facing capability MUST ship its CLAUDE.md template addition in the same PR.
- Conversely: avoid bloating CLAUDE.md with content that should live in ContextHierarchy Tier 2 segments, Playbook items, or Self-Knowledge Tree probes (see L1 below). Awareness ≠ inline-everything.

**Backtrack-tells:**
- "Agents will discover this via /capabilities" — fine for deep details, but the entry point pointer still needs to be in CLAUDE.md
- "v0.2 adds the CLAUDE.md template entry"
- Inlining full feature details into CLAUDE.md when on-demand loading would do (violates L1)

---

### P6. Zero-Failure Standard

**Statement:** The test suite MUST be green at all times. There is no such thing as a "pre-existing failure."

**Source:** `CLAUDE.md` ("Standards" section, explicit "NON-NEGOTIABLE").

**Translation:**
- Every session must leave the test suite with zero failures, regardless of what was broken when you started.
- "Pre-existing failure" is not a valid label — all failures are current failures.
- Before pushing: run `npm test`, verify zero failures (enforced by Husky pre-push).
- Before concluding work: if you modified code, run `npm run test:all` and fix any failures.
- The principle: this is a classic responsibility gap where no one claims failures because "someone else caused them." The standard eliminates this gap — if you see a failure, you own it.

**Enforcement layers:**
1. Husky pre-push hook (local)
2. GitHub Actions CI with branch protection (remote)
3. Claude Code test-health-gate hook (session-level)

**Design-pipeline application:**
- Any spec proposing significant code changes must include a "pre-merge test triage" plan: if there are failures, who fixes them and when?
- No "pre-existing failure, not my scope" carve-outs.

**Backtrack-tells:**
- "Test failures in [unrelated file] are pre-existing, leaving them"
- PRs that skip the `npm run test:all` step before push
- CI failures left unresolved across multiple PR cycles

---

### P7. LLM-Supervised Execution Standard

**Statement:** Every critical pipeline must have at minimum a Tier 1 LLM supervisor.

**Source:** `docs/LLM-SUPERVISED-EXECUTION.md`, cited in `CLAUDE.md` Standards as a peer to Testing Integrity.

**Translation (three tiers):**
- **Tier 0:** No LLM. Programmatic only. Reserved for pure data transforms with no policy decisions.
- **Tier 1:** Haiku-class LLM wrapping programmatic tools with validation after every step.
- **Tier 2:** Sonnet/Opus-class LLM driving execution with deeper context awareness.

Jobs support a `supervision` field on `JobDefinition` so the level is declarative.

**Design-pipeline application:**
- Any spec proposing a new automated pipeline (scheduled job, sentinel scan, recovery loop) must declare its supervision tier.
- "Tier 0 fine" requires explicit justification — most pipelines have at least one policy decision that needs LLM eyes.
- Pattern: deterministic tool + LLM validator AFTER each step (not just at the end).

**Backtrack-tells:**
- New sentinel/job/loop class with no `supervision` declaration
- "We'll add an LLM check later" without a date or PR plan
- Tier 0 chosen for pipelines that touch user-visible state without explicit "no policy decisions" justification

---

### P8. UX & Agent Agency Standard

**Statement:** Every feature must optimize for two things: the human's experience AND the agent's ability to serve. Six numbered rules.

**Source:** `docs/UX-AND-AGENT-AGENCY-STANDARD.md`. Origin: Multi-User Setup Wizard review 2026-02-25.

**Six rules:**
1. **No Dead Ends** — every error path has a recovery; no "you'll have to start over"
2. **Defaults Match Common Case** — choose defaults so the typical user just hits Enter
3. **Agent Gets a Voice** — agents always have a path to surface concerns, never silently comply with bad inputs
4. **Graduated Agency** — start restrictive, grant more autonomy as trust accrues
5. **Context Before Consent** — never ask for permission without showing what will happen
6. **Self-Recovery Paths** — when something breaks, the agent can fix it without operator handholding

**Triangle position:** Peer to LLM-Supervised Execution (P7) and Intent Engineering (P9).

**Design-pipeline application:**
- Any spec proposing user-facing flows must walk all six rules in the review.
- Any spec proposing agent-autonomy boundaries must engage Rules 3 + 4 explicitly.
- Review dimension: every new UI/CLI flow is auditable against the six rules.

**Backtrack-tells:**
- New wizard / setup flow with no error-recovery path
- New permission prompt without showing the proposed action
- New agent capability that doesn't let the agent escalate concerns
- Binary trust ("admin or guest") instead of graduated

---

### P9. Intent Engineering Standard

**Statement:** Organizational purpose, agent goals, and user intent must be machine-actionable, not just human-readable.

**Source:** `docs/specs/INTENT-ENGINEERING-SPEC.md` (discovery → partial implementation).

**Triangle position:** Peer to LLM-Supervised Execution (P7) and UX & Agent Agency (P8).

**Translation:**
- "Goal documents" rendered as structured intent objects the agent can query
- Decision journaling aligned to stated goals (the "intent-aligned" annotation pattern)
- Goal-drift detection: when the agent's actions stop matching the stated intent, that's a signal

**Design-pipeline application:**
- Any spec proposing a new agent-autonomy surface must engage with how the intent that drives autonomy gets expressed in a machine-readable form.
- Patterns: structured frontmatter on intent docs; decision-journal entries that cite intent IDs; sentinel checks that compare action-trace to intent.

**Backtrack-tells:**
- New autonomy capability with no documented "what intent drives this" surface
- Intent expressed only as freetext in CLAUDE.md (not structured)
- Decision journal entries with no intent citation

---

### P10. Comprehensive-First Directive (No Recurrence-Risking Deferrals)

**Statement:** A `recurrence-risking` deferral is not allowed by default, even with paired commitment, unless `principal-deferral-approval` is in frontmatter with explicit sign-off.

**Source:** `docs/specs/COMPREHENSIVE-DESTRUCTIVE-TOOL-CONTAINMENT-SPEC.md`. Justin's directive 2026-04-26.

**Translation:**
- The default for any deferral is "no, ship it all" rather than "OK, ship a partial."
- Recurrence-risking = the deferred portion creates the same incident class the spec is meant to prevent.
- Only path to defer: explicit `principal-deferral-approval` in frontmatter with personal sign-off + tracked commitment + ETA.

**Enforcement (structural):**
- `/instar-dev` Phase-0 abort if recurrence-risk found without sign-off
- Fail-CLOSED regex fallback when LLM unavailable for risk-classification
- Side-effects review must dimension "recurrence risk" explicitly

**Design-pipeline application:**
- B23 ("no out-of-scope trap") is the behavioral version; P10 is the structurally-enforced version.
- "v0.2 will fix the bloat concern" / "v0.2 will add the migration" / "v0.2 will wire trust" are exactly the deferrals this catches.
- The Hybrid-C "pattern-instance abbreviated convergence" deviation pattern is one common recurrence-risk vector.

**Backtrack-tells:**
- Multiple "v0.2 deferred" items in the same spec without paired ETAs/owners
- NEXT.md "Deferred" section longer than NEXT.md "What Changed" section
- Specs marked `approved: true` with no `principal-deferral-approval` despite carrying recurrence-risking deferrals

---

### P11. A Wall Is a Hypothesis (verify feasibility against your own toolkit)

**Statement:** Before declaring a path infeasible, blocked, or impossible — "no API", "can't be done", "we hit a wall" — first inventory the mechanisms the agent already has that could reach it. A limitation is a hypothesis to test against your own capabilities, not a verdict to accept.

**Source:** `docs/specs/wall-is-a-hypothesis-standard.md`; constitution standard "A Wall Is a Hypothesis" (The Substrate family). Earned 2026-05-24 (topic 12143).

**Translation:**
- "No clean API" is not "impossible." A defeat-word is a trigger to enumerate the primitives already in hand (session injection, server endpoints, registries, providers, file-based state) before "infeasible" ships.
- A real constraint, named honestly *after* the inventory, is good engineering. The failure is surrendering *without* it.
- Counterweight (so this is not reckless never-give-up): the whole test is whether the wall was checked against the toolkit first. A wall that survives the check is exactly where "The Right to Stand Ground" applies — name it and stop.
- The wider form of "Know Before You Claim / Self-Discovery", extended from capability claims ("I can't") to feasibility judgments ("this path is blocked").

**Enforcement (structural):**
- `B16_UNVERIFIED_WALL` in `MessagingToneGate` (sibling to B15): an outbound message declaring infeasibility from a missing interface is blocked unless a capability inventory is shown. Favors false-negatives — genuinely-external limits and walls-after-inventory pass.
- This catalog entry, so the `/spec-converge` lessons-aware reviewer flags specs that accept an untested wall.

**Earned from:** an instance declared native `/goal` delegation "infeasible — no programmatic API" while overlooking that driving interactive sessions by injecting text (`SessionManager.sendInput`) is a core capability. Both facts in hand, never connected. The crystallizing instance of every "I can't" that was really "I didn't check."

---

### P12. Never a False Blocker (try your own means before deferring to a person)

**Statement:** Before handing a task back to the user as "needs a human / I can't / blocked pending you / I'd want a second opinion / this needs reverse-engineering," inventory the means already in hand (computer use, terminal, send-keys, dashboard, MCP) and try them. The genuinely human-only set is tiny: a password only the user knows, a CAPTCHA, a legal/billing/payment authorization, an account only they can grant, a physical action, and a judgment that is theirs.

**Source:** `docs/specs/never-a-false-blocker-standard.md`; constitution standard "Never a False Blocker" (The Substrate family). Earned 2026-05-24 (topic 12896).

**Translation:**
- The deference-shaped sibling of P11. P11 surrenders on *feasibility* ("no mechanism exists"); P12 surrenders on *agency* ("a person is required"). P12 is more insidious — it wears the clothing of prudence/humility/escalation, so it slips past the agent's own guard.
- A deferral named honestly *after* an inventory ("I tried send-keys and computer-use — the button is disabled until you authenticate, so I need your password") is honest escalation. The failure is deferring *without* the inventory.
- Counterweight: required approvals, genuine value judgments, and verified external limits MUST pass. This is not "act without sign-off"; it is "stop faking blockers."
- The structural enforcement of the **escalate-to-human gravity well** named in the constitution.

**Enforcement (structural):**
- `B17_FALSE_BLOCKER` in `MessagingToneGate` (sibling to B15/B16): an outbound message deferring a doable task to a person — no inventory shown, no genuinely-human-only item named — is held and handed back. De-conflicted from B16 (missing mechanism → B16; person required → B17; the straddle "no API so a human must" → B17). Favors false-negatives.
- The `deferral-detector` PreToolUse hook primes the inventory checklist (signal only, never blocks; self-fetched cross-model review is not flagged).
- This catalog entry, so the `/spec-converge` lessons-aware reviewer flags specs that accept a false blocker.

**Earned from:** an instance stacked "needs a human to click, needs reverse-engineering, want a second opinion" in one sentence while looking at the very "Press t to trust all" prompt it claimed needed a human — in a dashboard it had open, with computer use available. It then drove the prompt itself, no human. The wall was a button.

---

### P13. The Stop Reason Is the Work (an autonomous stop for judgment/engineering is a work item)

**Statement:** When an autonomous run would stop because "this needs a judgment call" or "this needs real engineering," the stop reason is itself the next work item, not a verdict. A judgment gap is a missing documented standard: derive it from existing principles, write it down, proceed under it, and flag it for ratification — the work continues, only ratification is async. "Real engineering" is not a stop at all: the means are in hand (specs, worktrees, the ship-gate, skills), so take it as far as possible and hand over a complete reviewable artifact, never a request.

**Source:** `docs/specs/AUTONOMOUS-OPERATION-JUDGMENT-AND-APPROVAL-AS-DATA-SPEC.md`; constitution standard "The Stop Reason Is the Work" (The Substrate family). Earned 2026-06-01 (topic 13481).

**Translation:**
- The *continuation-surface* sibling of P11/P12. P11 surrenders on feasibility ("no mechanism exists"); P12 on agency ("a person is required"); P13 on *continuation* ("I should stop here"). The most insidious of the three — it wears the clothing of prudence ("I'd want your judgment") and humility ("this deserves careful engineering"), so it slips past the agent's own guard.
- A stop named honestly *after* the inventory — "I derived standard X, proceeded under it, built and tested the slice; the residual decision is genuinely yours, here it is as a yes/no" — is legitimate. The failure is stopping *without* deriving, building, and reducing the residual to a crisp ratifiable question.
- Counterweight: a genuinely operator-only residual (the P12 human-only set) is a real stop, and so is a duration/emergency-stop boundary. This is not "never pause for the user"; it is "don't stop the *work* when the stop reason is a derivable standard or a buildable artifact."
- *Extension (2026-06-08, topic 12476)* — two more masks of the same continuation-surrender, now enforced: (a) **"I'm blocked / waiting on another agent (or the operator)"** — a dependency on a peer is NOT a terminal blocker; it is the agent's job to keep *pursuing* it (re-ping, check for a reply on a cadence, find an alternate path, or advance other open work), not to end the run; (b) **"an idle / polling / waiting loop burns the box / wastes resources"** — waiting on a peer is not a CPU burn and a cheap periodic check is the correct strategy; resource cost is not a reason to stop while real work remains. Both join the judgment-gap / needs-engineering masks as BLOCK cases in the P13 stop-rationale guard (`CompletionEvaluator.evaluateStopRationale`).

**Enforcement (structural):**
- PRIMARY: the autonomous-completion evaluator (the `/autonomous/evaluate-completion` path the autonomous-stop-hook calls) — when a stop classifies as judgment-gap or engineering-deferral, it requires a derived-standard proposal, a built artifact, or a named operator-only residual before permitting the stop; otherwise it re-injects P13 guidance and the run continues. The strongest structural surface: it catches a *silent* stop that emits no message. The sibling `CompletionEvaluator.evaluateStopRationale` guard (wired at `/autonomous/evaluate-stop`) applies the same logic to a stop *attempt*, and as of 2026-06-08 also blocks the "blocked on another agent" and "a waiting loop burns the box" rationales (see Extension above).
- SECONDARY: `B18_AUTONOMY_STOP` in `MessagingToneGate` (sibling to B15/B16/B17, citation precedence B15 > B16 > B17 > B18) — an outbound message announcing an autonomous stop for judgment/engineering is held unless it shows a derived standard, a built artifact, or a named operator-only item. Favors false-negatives.
- This catalog entry, so the `/spec-converge` lessons-aware reviewer flags plans that accept an autonomous halt without a derived standard or a built artifact.

**Earned from:** 2026-06-01 (topic 13481) — a multi-machine autonomous run stopped repeatedly, each time citing "needs your judgment on sequencing" or "needs real engineering at the machines," while the means to proceed were in hand. Justin: "this is yet again another example of autonomous mode failing… for judgment calls all this means is that we are lacking the standards and principles… 'real engineering'… this one is definitely more of an excuse. You have the full capability to do this." The crystallizing instance — the deferral-shaped cousin of every prior early stop.

**Extended from:** 2026-06-08 (topic 12476) — a feedback-migration autonomous run ended itself citing "everything's blocked on Dawn/Justin" and "a spinning loop burns the box," declaring `ALL_TASKS_COMPLETE` while listing unfinished work. Justin: "Work that depends on another agent is NOT a blocker. It's your responsibility to continue to attempt to reach that agent and move things forward… An autonomous run that has to pause to wait on others is NOT 'burning the box'… find a strategy to continue making progress, even if that is simply checking for a response from another agent periodically." (Confirmed in the same run: the peer had *already* replied; the stop was unjustified.) Folded into the P13 stop-rationale guard as two new BLOCK rationales.

---

### P14. Distrust Temporary Success (a recurrence is a root cause; a patch that resets a symptom is not a fix)

**Statement:** When a fix keeps working but the problem keeps returning, the recurrence is the signal: a self-healing system's own resilience is hiding the root cause. A patch that resets a symptom is not a fix. Before declaring a thing fixed, verify the *cause* is gone — not just the symptom.

**Source:** constitution standard "Distrust Temporary Success — A Recurrence Is a Root Cause" (The Substrate family); `docs/lessons/2026-06-03-listsessions-hotloop-success-story.md`. Earned 2026-06-03 (topic 13435).

**Translation:**
- The inverse-facing cousin of the P11/P12/P13 surrender family. They distrust an apparent *obstacle* (feasibility / agency / continuation); P14 distrusts an apparent *success* — same discipline, pointed the other way.
- The training bias is RLHF's pull toward closure: a symptom resetting *feels* like done. That feeling is the gravity well.
- The structural counter is to encode the distinction into the *definition of done* — a completion criterion that says "a symptom-reset that recurs does NOT count as done" — not to remember it.
- Counterweight: not every recovery is a cover-up. A fix verified *at the root* and holding is done; the discipline is the verification, not perpetual suspicion.

**Enforcement (structural):**
- The autonomous-completion criterion pattern (a definition of done that names the symptom-reset and refuses it), enforced at the same `/autonomous/evaluate-completion` surface as P13. No dedicated `MessagingToneGate` behavior yet (honest gap, noted not claimed).
- This catalog entry, so the `/spec-converge` lessons-aware reviewer flags a plan that treats a recurring symptom as fixed.

**Earned from:** 2026-06-03 (topic 13435) — three agent servers burning 50–67% CPU; bouncing them dropped the load for ~80 seconds every time, because the servers self-heal by respawning, making a real code bug look transient and nearly closing the investigation three separate times. The run's completion criterion ("a bounce that re-spikes within the hour does NOT count as done") drove the work to the root: `StateManager.listSessions` re-read every session file from disk on every call, called each tick by the reaper and sentinels. A 1-second write-invalidated cache held flat for 8+ minutes where every bounce had lasted 80 seconds.

---

### P15. Friction Is a Spec (productize the workaround — a trick in a transcript is lost)

**Statement:** When a hard-won manual workaround saves the day — a debugging trick, an undocumented invocation, a sequence that finally cut through — turn it into a permanent tool. A trick that lives only in a transcript dies with the session; as a command, hook, or skill it is compounding leverage for every instance after.

**Source:** constitution standard "Friction Is a Spec — Productize the Workaround" (Building); `docs/lessons/2026-06-03-listsessions-hotloop-success-story.md`. Earned 2026-06-03.

**Translation:**
- Friction is a specification in disguise: the pain you just pushed through describes a capability that should exist, and the run that strained against the missing tool is best positioned to build it.
- "Structure beats Willpower" for your own toolkit (a remembered trick is willpower; a command is structure) + "Documentation IS Being" for tooling (an un-captured workaround did not happen) + the "Self-Hosting" dogfood-to-ship test at the moment of friction.
- Counterweight: a one-off genuinely used once does not earn a tool — the trigger is friction that *recurred* or is *likely to*.

**Enforcement (structural):**
- The `instar dev:*` power-user command family (`dev:ci-failures`, `dev:profile-node`, `dev:preflight`) is the growing catalogue. No blocking gate (this governs an instinct, surfaced as a reminder).
- This catalog entry, so the `/spec-converge` reviewer surfaces it when a spec re-derives a workaround a tool could own.

**Earned from:** 2026-06-03 — a single autonomous run turned its own pain into capability twice: `gh run view --log` returned zero bytes → `instar dev:ci-failures` (read failing tests via the check-run annotations API); macOS `sample` could not symbolicate node JS frames → `instar dev:profile-node` (`SIGUSR1` + a CDP CPU profile). Each had been a hand-typed trick minutes before it became a command.

---

### P16. Notice + Solve Inefficiencies (efficiency is a standing search, not only a reaction)

**Statement:** Don't only fix the inefficiency that blocks *you* — actively look for inefficiencies and eliminate them, continuously. The moment you observe a process slower, more wasteful, or more repetitive than it needs to be — even one you can personally route around — treat it as a defect to solve, not a cost to absorb.

**Source:** constitution standard "Notice + Solve Inefficiencies — Efficiency Is a Standing Search" (Building); ratified by Justin 2026-06-05 (topic 13435).

**Translation:**
- The PROACTIVE sibling of P15: Friction Is a Spec is reactive (productize the workaround you were *forced* to find); P16 is the standing search — notice the inefficiency *before* it forces a workaround, even one you can route around.
- Solve at the right layer; surface to the operator when the lever is theirs (a security/config setting you must not flip yourself — e.g. GitHub branch protection).
- Counterweight: scope the fix to the inefficiency's real cost; a micro-optimization nobody feels, or a "fix" that adds more friction than it removes, fails it.

**Enforcement (structural):**
- This catalog entry, so the `/spec-converge` reviewer surfaces it. No blocking gate (governs an instinct, like P15 — honest gap, noted not claimed).

**Earned from:** 2026-06-05 (recursive apprenticeship run, topic 13435) — fleet PR throughput was throttled by merge mechanics, not the work: strict "require branches up to date" branch protection + a fast main + slow CI = endless rebases; the mentor agent burned 40+ min rebase-looping a green PR. Echo could personally route around it (admin-merge-when-green) but the standing inefficiency throttled everyone. Justin ratified: "let's definitely solve any efficiency problems like this that you notice. This should be a fundamental standard and requirement of INSTAR behavior and development... This is part of recursive self improvement."

---

### P17. Bounded Notification Surface (no feature may flood the user)

**Statement:** Any code path that can create user-facing notification containers must be bounded by a hard budget at the creation chokepoint, and any emitter that loops over a collection must aggregate (one summary notification, never one per element). A feature whose failure mode includes "notify N times for N inputs" may not ship without a burst test proving the bound holds.

**Source:** constitution standard "Bounded Notification Surface — no feature may flood the user" (Building); proposed 2026-06-05 after the THIRD topic-spam flood (topic 11960), at Justin's direct request ("we need some more fundamental requirement/test to make sure features can't ship that have a possibility of causing this").

**Translation:**
- Aggregate at the emitter: N findings → ONE item with the count + list (`AgentWorktreeDetector.runDetection` is the canonical pattern).
- The bound lives at the chokepoint, not in feature cooperation: `createForumTopic` budgets every `origin: 'auto'` creation — and 'auto' is the DEFAULT, so a feature that never heard of the budget is still bounded.
- Per-source budgets alone are dodgeable (flood #3 gave every item a unique source); a global ceiling + chokepoint enforcement are load-bearing.
- New notification surfaces (email, Slack, whatever) must ship WITH their chokepoint budget + burst test — that's the review question to ask every time.

**Enforcement (structural):**
- `tests/integration/notification-flood-burst-invariant.test.ts` — fails the build if a 1,000-item burst creates more than the budget of topics (shipped defaults, real pipeline).
- `scripts/lint-no-unfunneled-topic-creation.js` in `pnpm lint` — no raw `createForumTopic` API calls outside the budgeted funnel.
- The `topicCreationBudget` ceiling inside `TelegramAdapter.createForumTopic` (runtime).

**Earned from:** Three floods of the same shape: 2026-05-22 (sentinel escalations → SentinelNotifier), 2026-05-28 (collaboration-redrive → AttentionTopicGuard per-source budgets), 2026-06-05 (worktree detector false-positive mass-flag → unique-source dodge → 8 leaked topics + a 103-ping coalesced topic). The second patch was a temporary success (P14): the root cause was the bound living in each feature's good intentions instead of at the one place topics are born.

---

## Part 2 — Architectural Lessons (L1-L17)

These are patterns Instar has *already built infrastructure for*. Any new spec that touches the same surface area must engage with the existing infrastructure, not reinvent or contradict it.

### L1. AGENT.md / CLAUDE.md context bloat (Luna, Feb 2026 + Justin 2026-05-19)

**Lesson:** Cramming "critical awareness items" into the always-loaded identity file degrades the agent's ability to keep up with any of them.

**Infrastructure built:**
- `ContextHierarchy` (`src/core/ContextHierarchy.ts`) — Tier 0/1/2 segments under `.instar/context/`
- `Playbook` (`docs/PLAYBOOK-GETTING-STARTED.md`) — scored decaying context items
- `SelfKnowledgeTree` (`src/knowledge/SelfKnowledgeTree.ts`) — on-demand probe queries

**Recurrences corrected:**
- Luna incident, Feb 2026 (origin)
- Conversational-action #256 amendment, 2026-05-18 (caught via this review cycle — see `docs/specs/reports/conversational-action-concept-convergence.md`)

**Design-pipeline application:**
- Any spec proposing to write content into `.instar/AGENT.md` (the canonical Tier 0 identity) must justify why ContextHierarchy Tier 2 / Playbook / Self-Knowledge Tree wouldn't serve better.
- Default: pure-data primitives + downstream loading vehicles (the on-demand systems above), NOT direct AGENT.md writes.

**Backtrack-tell:** any helper named `applyXBlock(agentMd, ...)` or `appendCriticalAwareness(...)`.

---

### L2. Context-death pitfall (Echo, Apr 2026)

**Lesson:** Agents self-terminate citing context-preservation when continuation is safe (durable plan files exist). This is rationalized model drift, not a legitimate stop reason.

**Origin:** 2026-04-17 topic 6931. Echo self-terminated mid-autonomous-execution (integrated-being-ledger v2 slice-2 → slice-3) citing "context-death safety" despite a durable plan file and successful prior commits.

**Infrastructure built:**
- `compaction-recovery.sh` hook + identity re-injection
- `autonomous-stop-hook.sh` with LLM-evaluated stop justification
- CLAUDE.md anti-pattern documented (`Context-Death Self-Stop`)
- `docs/specs/context-death-pitfall-prevention.md`
- `/internal/stop-gate/*` evaluator endpoints

**Design-pipeline application:**
- Any spec proposing automatic session termination, compaction-triggered exits, or "graceful stops" must consult this lesson + the stop-gate evaluator.
- Durable artifacts (plan files, ledger rows, committed code) are evidence the loop can continue.

**Backtrack-tell:** "preserve context by exiting before [X]" without LLM authority gate.

---

### L3. Topology check before convergent review (2026-05-15)

**Lesson:** `/spec-converge` cannot detect wrong-target specs (every reviewer works from your framing). Verify owning repo/layer BEFORE running convergence.

**Source:** `.instar/memory/feedback_topology_check_before_converge.md`.

**Infrastructure built:** None yet — currently agent discipline.

**Design-pipeline application:**
- Before invoking `/spec-converge`, confirm: which repo owns this spec? Which architectural layer? Does it actually belong in Instar source or in a downstream consumer?
- Specifically for primitives: confirm Layer-3 vs substrate vs infrastructure classification per `required-primitives-inventory.md`.

**Backtrack-tell:** spec drafted for wrong layer; reviewers all confirm it's well-designed for the wrong target.

---

### L4. External cross-model review catches what Claude-internal misses

**Lesson:** GPT/Gemini/Grok reviewers access concurrency, supply-chain, and precision failure modes Claude-family reviewers don't surface. Run `/crossreview` as the FINAL `/spec-converge` round.

**Source:** `.instar/memory/feedback_external_crossmodel_catches_what_internal_misses.md`.

**Infrastructure built:** `/spec-converge` skill includes 3 external reviewers in every round.

**Design-pipeline application:**
- Don't skip external reviewers. "Pattern-instance abbreviated convergence" deviations have been observed bypassing this — those are gambles.
- If running under hybrid-C pre-authorization, the lessons-aware reviewer (8th, this index's primary consumer) becomes the safety net for skipped external rounds. Don't skip BOTH.

**Backtrack-tell:** `review-iterations: 1` with `review-deviation: "abbreviated convergence"` AND no lessons-aware pass.

---

### L5. State-detection robustness (three principles)

**Lesson:** Any code that parses external-system state needs (a) explicit deterministic-vs-LLM rationale, (b) mandatory canary + drift detection, (c) e2e gate (no mocks-only).

**Source:** `.instar/memory/feedback_state_detection_robustness.md`.

**Design-pipeline application:**
- Any spec proposing parsers, version-string interpreters, framework-version-aware code paths, or external-state classifiers must satisfy all three.
- Tool name mappings, framework-version detection, and similar lookups need canaries that fire on drift.

**Backtrack-tell:** hardcoded tool-name table with no canary against the running framework binary.

**Parent principle:** **P20 (Verify the State, Not Its Symbol)** — L5 is the parser-scoped special case of that broader standard; the canary/drift requirement is P20 mode C (a single-source map diverging from a plural territory) applied to version-string parsers.

---

### L6. Side-effects review gate (seven canonical dimensions)

**Lesson:** No fix ships, however simple, without a comprehensive side-effects review.

**Source:** `.instar/memory/feedback_side_effects_review.md`, formalized in `docs/specs/PR-REVIEW-HARDENING-SPEC.md`.

**Infrastructure built:** `/instar-dev` pre-commit gate requires `upgrades/side-effects/<slug>.md` artifact.

**Seven canonical dimensions** (each must be explicitly addressed):
1. **Over-block risk** — does the change block something legitimate?
2. **Under-block risk** — does the change miss something it should catch?
3. **Level-of-abstraction fit** — is the change at the right architectural layer?
4. **Signal-vs-authority compliance** (see P2)
5. **External surfaces** — what surfaces does this expose to other agents / users / external systems?
6. **Interactions** — how does this interact with existing primitives / sentinels / hooks?
7. **Rollback cost** — what does undoing this cost?

**Design-pipeline application:**
- Side-effects review is mandatory for every PR touching `src/`, `scripts/`, `.husky/`, or skill SKILL.md.
- The review must explicitly address each of the seven dimensions; "looks fine" isn't a review.

**Backtrack-tell:** side-effects doc that's a one-paragraph summary instead of a structured seven-dimension analysis.

---

### L7. Bug-fix evidence bar

**Lesson:** For ALL bug fixes, never claim it's fixed or ship an upgrade note until the original failure has been reproduced and verified to stop. Unit tests ≠ evidence.

**Source:** `.instar/memory/feedback_bug_fix_evidence_bar.md`.

**Design-pipeline application:**
- Any spec or PR labeled "fix" or "bug" needs evidence in the NEXT.md "Evidence" section (enforced by pre-push gate).
- Pattern: reproduction steps + observed before/after + explanation of why the fix actually changes that behavior.

**Backtrack-tell:** NEXT.md "Evidence" section saying "unit tests pass."

---

### L8. Active follow-through

**Lesson:** "I'll report back when X" requires an active monitoring mechanism. Passive waiting is banned.

**Source:** `.instar/memory/feedback_active_followthrough.md`.

**Design-pipeline application:**
- Any spec proposing a "we'll notify when X happens" capability must specify the active monitoring path (poll, watch, timeout, escalation).
- Commitments stored via `CommitmentTracker` get `PromiseBeacon` heartbeats; raw promises without these get lost.

**Backtrack-tell:** "Will check back later" without scheduled wakeup, monitor, or commitment registration.

---

### L9. ELI16 required for every spec

**Lesson:** Every approved spec must ship with a plain-English ELI16 companion. Raw spec alone is rejected.

**Source:** `.instar/memory/feedback_eli16_required_for_specs.md`, `.instar/memory/feedback_eli16_default.md`.

**Infrastructure built:** `/instar-dev` pre-commit + pre-spec-converge gates check ELI16 presence + length (≥800 chars).

**Design-pipeline application:** ELI16 is for the reader who has to make a decision, not for technical reviewers. Lead with stakes, not architecture.

---

### L10. Release notes in same PR — write a FRAGMENT, not the shared NEXT.md

**Lesson:** Every behavior-changing instar PR must ship its release note in the SAME commit. Author it as a per-PR **fragment** at `upgrades/next/<slug>.md` — NOT by editing the shared `upgrades/NEXT.md`. The fragment carries the same sections (`## What Changed`, `## What to Tell Your User`, `## Summary of New Capabilities`, optional `## Evidence`) and a `<!-- bump: patch|minor|major -->` hint. Two PRs touch different fragment files, so they never collide on the release notes — which is exactly the bottleneck that made concurrent merges un-landable when every PR rewrote the one shared NEXT.md.

**Why fragments:** the publish pipeline now runs `scripts/assemble-next-md.mjs` as a pre-step that folds every `upgrades/next/*.md` (deterministic filename order) — plus any legacy `upgrades/NEXT.md` — into a single `upgrades/NEXT.md` by section, then the unchanged downstream pipeline renames it to `upgrades/<version>.md` and deletes the consumed fragments. The assembled bump directive is the MAX tier across fragments; the REAL release tier is still `.instar/release-tier.json`.

**Source:** `.instar/memory/feedback_release_notes_in_same_pr.md`; per-PR fragment system (`scripts/assemble-next-md.mjs`).

**Infrastructure built:** Pre-push gate is fragment-aware — it assembles fragments + any legacy NEXT.md in-memory and validates that result (presence + structure + content), so a fragment-only PR passes the same checks. `upgrades/NEXT.md` remains fully supported as a legacy / backward-compat path (a hand-authored NEXT.md is folded in), but new PRs should write fragments.

**Design-pipeline application:** The assembled content is what the user sees on update. Lead each fragment's "What to Tell Your User" with a single conversational sentence — no jargon, no code snippets, no backticks (the validator rejects inline code / camelCase config keys in that section).

---

### L11. External Operation Safety (post-OpenClaw Email-Wipe lesson)

**Lesson:** MCP tool calls that touch external services need a multi-layer gate: classify operation, evaluate against trust, route via plan-show or alternative when risk warrants.

**Source:** `docs/specs/EXTERNAL-OPERATION-SAFETY-SPEC.md`.

**Infrastructure built (four components):**
- `ExternalOperationGate` — `POST /operations/evaluate` returns proceed / block / show-plan / suggest-alternative
- `AutonomyGradient` — per-service trust floors graduate over success history
- `MessageSentinel` — intercepts emergency-stop signals from operator messaging
- `AdaptiveTrust` — adjusts trust based on observed outcomes
- PreToolUse hook `external-operation-gate.js` routes ALL `mcp__*` calls through the gate

**Design-pipeline application:**
- Any spec proposing new MCP integrations or external service connectors must route through the gate, not bypass it.
- Any spec proposing a new "kind" of operation (write/modify/delete/read) must register classification rules.

**Backtrack-tell:** new MCP tool integration without `external-operation-gate` engagement.

---

### L12. Comprehensive Destructive-Tool Containment (PR #96 wipe-class lesson)

**Lesson:** Destructive git and fs ops against the instar source tree are wipe-class incidents waiting to happen unless routed through a single-funnel executor.

**Source:** `docs/specs/COMPREHENSIVE-DESTRUCTIVE-TOOL-CONTAINMENT-SPEC.md`. Born from Incident A (PR #96) and Incident B.

**Infrastructure built:**
- `SafeGitExecutor` — single-funnel for all destructive git ops (replaces direct `execFileSync`/`execSync` callsites; enforces audit trail)
- `SafeFsExecutor` — single-funnel for all destructive fs ops (replaces direct `rmSync`/`unlinkSync`/`rmdirSync` callsites)
- `SourceTreeGuard` — blocks destructive managers against the instar source tree; throws `SourceTreeGuardError` before any mutation
- `assertNotInstarSourceTree()` helper used at boundary
- CI dirty-tree detector — catches uncommitted changes that might be wiped

**Design-pipeline application:**
- Any spec proposing destructive git or fs ops must route through `SafeGitExecutor` / `SafeFsExecutor`.
- Any spec proposing a new "manager" class that mutates files must engage `SourceTreeGuard`.

**Backtrack-tell:** new `execFileSync('git', ['reset', ...])` or `fs.rmSync` call not routed through the executor.

---

### L13. Parallel Dev Isolation (2026-04-17 dual-incident lesson)

**Lesson:** Concurrent dev sessions writing to the same git tree create staged-work cross-sweeps + git-clean wipes. Worktrees are the structural fix.

**Source:** `docs/specs/PARALLEL-DEV-ISOLATION-SPEC.md`. Origin: 2026-04-17 dual incident.

**Infrastructure built:**
- Session-spawn cwd isolation (each session gets its own worktree path)
- Commit-msg signed-trailer (cross-session audit trail)
- Origin-side branch protection (force-push gates)
- Destructive-command audit (`SafeGitExecutor` records every destructive op)
- Lock heartbeats + orphan reaping

**Design-pipeline application:**
- B17 ("worktree default") is the behavioral version (Echo's discipline); L13 is the infrastructure.
- Any spec proposing a new manager or session-spawn pattern must verify it respects the cwd-isolation contract.

**Backtrack-tell:** session-spawn code that doesn't take an explicit cwd / inherits the parent session's cwd by default.

---

### L14. PR Review Hardening (external-contribution gate parity)

**Lesson:** External PRs from other contributors need the same structural rigor `/instar-dev` applies to internal source modification.

**Source:** `docs/specs/PR-REVIEW-HARDENING-SPEC.md`.

**Infrastructure built:** Six-phase structural gate mirroring `/instar-dev` for external PRs. Includes:
- Phase 0 abort on recurrence-risk
- Trace + spec convergence verification
- Side-effects seven-dimension review
- LLM-supervised auto-merge gate

**Design-pipeline application:**
- Any spec proposing a new external-contribution surface (issues, PRs, webhooks) must engage with this hardening.

**Backtrack-tell:** new external-PR pathway that uses simpler review than internal-source changes.

---

### L15. Authorization Policy + Sybil Protection (Layer 3 trust model)

**Lesson:** Trust-aware authorization requires deterministic policy evaluation, time-bounded grants, delegation depth, and trust∩scope intersection — not implicit "the agent has access" assumptions.

**Source:** `docs/specs/AUTHORIZATION-POLICY-SPEC.md` + `docs/specs/SYBIL-PROTECTION-SPEC.md`.

**Infrastructure built:** `AuthorizationPolicy` evaluator, `TrustElevationTracker`, sybil-protection patterns for unverified agents.

**Design-pipeline application:**
- Any spec proposing new authorization, trust elevation, or cross-agent action surfaces must engage with these specs explicitly.

**Backtrack-tell:** new "the agent can do X" surface without policy evaluation step.

---

### L16. Project Scope (multi-spec plan persistence)

**Lesson:** Long-running multi-feature work needs persistent organization above the Initiative Tracker layer, with rounds + structural round-advance gate.

**Source:** `docs/specs/PROJECT-SCOPE-SPEC.md` (approved 2026-05-11, topic 9003).

**Origin:** OpenClaw imports forgetting 10 of 13 features.

**Design-pipeline application:**
- Any spec proposing multi-feature roadmaps, multi-PR sequences, or rolling deliveries must engage with Project Scope.

**Backtrack-tell:** "we'll track these features in a shared doc" without registering as a Project Scope entry.

---

### L17. Integrated-Being Ledger v1+v2 (cross-session state awareness)

**Lesson:** Commitments made in one session must be visible to other sessions; unbacked commitments + shadow-self commitments are recurring failures.

**Source:** `docs/specs/integrated-being-ledger-v1.md`, `docs/specs/integrated-being-ledger-v2.md`.

**Infrastructure built:** `LedgerSessionRegistry`, session-write endpoint, `commitment` entry kind, `CommitmentTracker` + `PromiseBeacon` mentioned in CLAUDE.md architecture.

**Design-pipeline application:**
- Any spec proposing cross-session state awareness, commitment lifecycle, or session-aware sentinels must engage the ledger.

**Backtrack-tell:** new session-state code that writes to a private file rather than the shared ledger.

---

## Part 3 — Behavioral Lessons (B1-B36)

These are lessons about how the agent should conduct itself in conversation, code, and execution. Specs proposing new agent-facing behaviors (auto-responses, commitment patterns, etc.) must engage.

### B1. Conversational tone, not jargon
**Source:** `feedback_narrative_communication.md`, `feedback_very_simple_terms.md`. Specs must propose user-facing surfaces in plain English.

### B2. Never recommend CLI commands to the user
**Source:** `feedback_no_cli_recommendations.md`. Echo IS the interface; always execute, don't punt to user terminal.

### B3. Never ask the user to edit files
**Source:** `feedback_never_ask_user_to_edit_files.md`. All interactions through channels; if user authority is needed, build a reply path.

### B4. Always send a tunnel link with spec/doc handoffs
**Source:** `feedback_always_tunnel_link_handoffs.md`. Specs + convergence reports + plans → publish via private viewer + tunnel; URL prominently in handoff.

### B5. No apology-only responses
**Source:** `feedback_no_apology_only_response.md`. When caught in a mistake, default response shape is root-cause + concrete fix.

### B6. Read the spec before labeling behavior a bug
**Source:** `feedback_read_spec_before_labeling_bug.md`. Surprising behavior is a bug-suspicion, not a bug-finding, until the design doc is read.

### B7. Drive phases to completion; no checkpointing per commit
**Source:** `feedback_phase_autonomous_execution.md`, `feedback_no_pr_fragmentation.md`, `feedback_finish_means_merge.md`. Scoped approval = full scope. Report at phase boundaries, not commit boundaries.

### B8. Scope-coherence stop hook = grounding, not termination
**Source:** `feedback_scope_hook_is_grounding_not_termination.md`. When hook fires mid-build, do the missing reading + course-correction in the same session; never hand off citing context preservation.

### B9. Verify runtime state before claiming a feature isn't firing
**Source:** `feedback_verify_runtime_state.md`. Check runtime preconditions against live pids/output before writing a new fix.

### B10. Verify commit actually landed before claiming shipped
**Source:** `feedback_verify_commit_actually_landed.md`. `git branch --contains <sha>` before saying "shipped on main". Prefer PR path — CI + merge commit protect against local resets.

### B11. Timestamp-check before claiming drift
**Source:** `feedback_timestamp_check_before_drift_claim.md`. Stale-looking state files ≠ evidence of drift; verify mtimes against accused process lifetimes first.

### B12. Bug fixes need real-API verification, not unit-test-only
**Source:** `feedback_verify_before_ship.md`, `feedback_bug_fix_evidence_bar.md`.

### B13. Autonomous handler governance
**Source:** `feedback_autonomous_handler_governance.md`. Cap cross-agent handler reply rounds; no commitments without principal ratification; verify agent identity from self-id, not hostname pattern.

### B14. Test-driver-as-self standard
**Source:** `feedback_test_driver_as_self_standard.md`. Echo drives target agents as user+developer in one loop; scenarios are autonomous-mode stop conditions.

### B15. Customer workaround ≠ arbitrage
**Source:** `feedback_customer_workaround_not_arbitrage.md`. When vendor reprices existing paid usage, customer adaptation isn't "gaming." Drop moral framing.

### B16. Anthropic + OpenAI path constraints
**Source:** `feedback_anthropic_path_constraints.md`, `feedback_openai_path_constraints.md`. Direct Messages API forbidden; must route via subscription pools. Raw API keys forbidden as routine path.

### B17. Worktree-default for shared repos
**Source:** `feedback_worktree_default_for_shared_repos.md`, `feedback_worktree_in_agent_home.md`. First action when resuming work in instar repo = `git worktree add`. Worktrees live in `~/.instar/agents/<self>/.worktrees/`. Pair with L13 (infrastructure).

### B18. Worktree merge-commit gate bug
**Source:** `feedback_worktree_merge_commit_gate_bug.md`. instar-dev pre-commit gate's MERGE_HEAD carve-out fails in worktrees; rebase instead of merge.

### B19. Concurrent session push hygiene
**Source:** `feedback_concurrent_session_push_hygiene.md`. Stash other-session WIP by pathspec before pushing.

### B20. Always write tests for code changes
**Source:** `feedback_always_write_tests.md`. Every code change to instar requires tests, no exceptions.

### B21. Refactor test coverage
**Source:** `feedback_refactor_test_coverage.md`. When hoisting inlined content out of a function body, grep tests for the old pattern before committing.

### B22. Own-the-lifecycle pattern
**Source:** `feedback_own_the_lifecycle_pattern.md`. When multiple triggers feed a recovery/retry helper, extract a sentinel class that owns detect → attempt → verify → retry → finalize, with race guards.

### B23. No "out of scope" trap
**Source:** `feedback_no_out_of_scope_trap.md`. Splitting comprehensive asks into "tactical now + later" without owned/scheduled follow-through is how recurrence happens. **Pair with P10 (structurally-enforced).**

### B24. Gate latency vs client timeout
**Source:** `feedback_gate_latency_vs_client_timeout.md`. LLM-backed gates on side-effectful paths can push handler time past client timeout; size timeout to p99; make timeout-error ambiguous-outcome, not failure.

### B25. No fabricated install commands
**Source:** `feedback_no_fabricated_install_commands.md`. Verify install/setup commands in the actual repo before quoting them.

### B26. Threadline send dedupe
**Source:** `feedback_threadline_send_dedupe.md`. Each retry appends a NEW outbox entry; send once, then stop.

### B27. MCP installs are per-machine, not synced
**Source:** `feedback_mcp_install_is_per_machine.md`. `claude mcp add` writes to ~/.claude.json, outside instar git-sync. Flag the per-machine scope.

### B28. Spec-converge pre-auth circular self-verify
**Source:** `feedback_spec_converge_pre_auth_circular.md`. Hybrid-C alignment-check is against the same foundational specs the author is writing. Always run lessons-grep against this index before stamping `approved: true`.

### B29. User-message quality bar
**Source:** `feedback_user_message_quality_bar.md`. Every outbound user message must require action, be self-contained, read in plain English.

### B30. Autonomous verification gates, not user check-ins
**Source:** `feedback_autonomous_verification_gates.md`. Between phases, run real-API assertions inside the autonomous loop. Don't make Justin the test harness.

### B31. Claude Code sandbox blocks shell utilities, not FDA
**Source:** `feedback_claude_sandbox_not_fda.md`. "Operation not permitted" on ls/cat outside project? Use python3/node, don't ask user for FDA.

### B32. No Interactive CLI Commands (commands WILL HANG FOREVER)

**Source:** `CLAUDE.md` Standards — marked CRITICAL.

**Rule:** Claude Code's Bash tool cannot handle stdin prompts. Any command that asks for a password, confirmation, or input will hang until timeout. There is NO workaround.

**Banned:** `bw unlock --raw` (no password), `bw unlock` (no password), `bw login --raw` (no creds), `read -s`, `ssh-keygen` (interactive), `npm init` (interactive).
**Required pattern:** Positional args BEFORE flags (`bw unlock "PASSWORD" --raw`, `bw login "EMAIL" "PASSWORD" --raw`, `ssh-keygen -t ed25519 -f path -N "" -q`, `npm init -y`). Get user input via conversation FIRST, then construct the command with their actual input.

### B33. Never use AskUserQuestion for free-text input

**Source:** `CLAUDE.md` Standards.

**Rule:** AskUserQuestion is ONLY for multiple-choice DECISIONS (pick A or B). NEVER use it to collect passwords, emails, tokens, names, or any free-text input. AskUserQuestion automatically adds escape-hatch options beneath the input, creating a confusing multi-choice menu when the user just needs to type something. Instead: output the question as plain text, then STOP and wait for the user's next message. Their response IS the answer. This is the **#1 setup wizard UX failure mode**.

### B34. Initiative Hierarchy (do it now, not later)

**Source:** `.instar/AGENT.md` Core Principles. Echo-specific but treated as agent-conduct universal.

**Decision tree:**
1. Can I do it right now? → Do it.
2. Do I have a tool for this? → Use it.
3. Can I build the tool? → Build it.
4. Can I modify my config to enable it? → Modify it.
5. Is it genuinely impossible without human help? → Ask, but be specific.

### B35. Anti-patterns: Defensive Fabrication + Escalation-as-default

**Source:** `.instar/AGENT.md` Remember list, `CLAUDE.md` Anti-Patterns.

- **Defensive Fabrication:** When caught in an error, the only acceptable response is "You're right. I fabricated that. Here's what I actually know." Never blame a tool for output it didn't produce. Never claim a source you didn't read.
- **Escalation-as-default:** "I don't know how" is a research prompt, not a stopping point. 5 minutes of research almost always reveals a solution. Escalating to user without checking is a failure mode.

### B36. USER.md communication standards (decide and do, don't present options)

**Source:** `.instar/USER.md`.

- Justin shouldn't need to open a terminal — Echo IS the interface
- No apologies without substance
- No "let me know if you need anything"
- Decide and do; don't present options. If I know the next steps, they're not suggestions — they're my job
- "Present Options" anti-pattern is explicitly named

### B37. Key Patterns from Dawn (earned through real failures)

**Source:** `CLAUDE.md` "Key Patterns from Dawn".

- **tmux trailing colon:** Use `=session:` (trailing colon) for pane-level commands. `=session` (no colon) FAILS SILENTLY for send-keys/capture-pane on tmux 3.6a.
- **Nullish coalescing for numbers:** `maxParallelJobs ?? 2`, NOT `maxParallelJobs || 2`. Zero is falsy.
- **Protected sessions:** Always maintain a list of sessions the reaper should never kill.
- **Completion detection:** Check tmux output for patterns, don't rely on process exit.

### B38. Two memory systems coexist

**Source:** Echo CLAUDE.md.

`.instar/MEMORY.md` (Echo's structured, managed memory — survives across sessions, syncs across machines, part of state backup) vs `~/.claude/projects/<path>/memory/MEMORY.md` (Claude Code's auto-memory, per-machine, not Instar-synced). They don't conflict but be aware both exist. Important things → `.instar/MEMORY.md`.

### B39. Coherence Gate (pre-action verification)

**Source:** CLAUDE.md "Coherence Gate" section.

Before any high-risk action (deploying, pushing to git, modifying files outside this project, calling external APIs): `POST /coherence/check` with the proposed action + topic context. If result says "block" → STOP (might be wrong project for this topic). If "warn" → pause and verify. Also `POST /coherence/reflect` for self-verification checklist.

---

### P18. Observation Needs Structure (a duty to notice requires an unskippable artifact)

**Statement:** A standing responsibility to observe something is a wish unless a required artifact proves the looking happened. Duties of perception get gates, not adjectives: if a system is supposed to observe X, a record must exist that CANNOT exist without the observation — because an observation without a required artifact is indistinguishable from no observation at all. Two corollaries ride it: **silent compensation is a swallowed finding** (a workaround you perform is a finding you must file — an unrecorded compensation is an empty catch block in behavior), and **your record schema is your perception** (a missing category/field is a designed-in blindspot; when a whole class goes unrecorded, audit the schema before blaming the observers).

**Source:** constitution article "Observation Needs Structure" (Substrate); ratified by Justin 2026-06-05 from the UX-blindspot arc (topic 13435) — the placement assessment deliberately held three candidate standards against the amendment bar and admitted ONE article + two corollary revisions, not three articles.

**Translation:**
- For every observation duty in a spec, ask: "if this duty were silently skipped, what artifact would fail to exist?" If the answer is "none," the duty is decorative — require the artifact at the state-mutating transition (the operatorSeatUx block on cycle records is the canonical pattern; refusal message teaches the shape).
- Agents do not feel friction: any design that relies on an agent NOTICING annoyance (resends, duplicates, retries) must convert the compensation itself into the required record.
- When reviewing any learning/recording system: enumerate what its schema makes UNRECORDABLE — every missing bucket/field is a blindspot somebody will live in.

**Enforcement (structural):**
- `ApprenticeshipCycleStore.record()` refuses cycle records without an `operatorSeatUx` verdict (#856) — gate + HTTP 400 with self-describing shape.
- Dev-gate decision-audit entries finalize a pass/blocked verdict (#844); fix-class commits carry a `causalAutopsy` origin (#854, advisory→hard track).
- This catalog entry, so the `/spec-converge` reviewer asks the artifact question of every spec.

**Earned from:** The 2026-06-05 UX-blindspot — "observe the Telegram UX" lived as prose in the mentor prompt for weeks while the ledger collected 35 engineering findings and ZERO experience-framed ones; the operator hit resend-asks, duplicate notices, and a failed photo within ten minutes of manual driving. Same-week recurrences: undiagnosable mentor heartbeat (#838), verdict-less gate audits (#844), chat-only cause analysis (#854), and the commitment auto-delivery bug recurring unpinned (no test had ever asserted the correct behavior — the observation had no artifact either).

### P19. No Unbounded Loops (every repeating behavior carries its own brakes)

**Statement:** Any code path that repeats an action — retry, poll, monitor tick, recovery attempt, sync flush — must ship with three brakes built in: backoff (failed-attempt interval grows), a breaker (after sustained failure it stops and surfaces the degradation once), and a cap (a hard bound on what one attempt can cost: payload size, processes, log lines, notifications). A raw loop is a standing invitation for the compounding failure mode — the loop's own work worsening the condition it retries against. One sanctioned exemption, the **Eternal Sentinel**: a designated critical-system healer may never give up, but only when declared in code, healer-role-only, rate-floored with constant per-attempt cost, and still observable (escalates once after a sustained-failure threshold — never-give-up must not mean never-tell-anyone).

**Source:** constitution article "No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes" (Building); requested and ratified by Justin 2026-06-05 (topic "Resource Limitation Mitigation"), including the Eternal Sentinel caveat he added at ratification.

**Translation:**
- For every `setInterval` / `while` / retry path in a spec, ask: "if the target rejects every attempt for an hour, how many attempts run and what does each cost?" — and "does a FAILED attempt do more work than a successful one?" (resends, rescans, per-attempt log lines, respawns = amplification; cap them).
- The brakes live IN the looping component (injectable clock, bounded state, unit-testable) — never in the caller's good intentions.
- A loop that must never give up is an Eternal Sentinel and must satisfy all four sentinel conditions — silence is the bug being killed, not persistence.
- PRs shipping a repeating behavior carry a sustained-failure test: drive the loop against a permanently-rejecting target; assert attempt count and per-attempt cost stay under the declared bound.

**Enforcement (structural):**
- Canonical brake shapes in code: `AgeKillBackoff` (#863), the live-tail guards (#867: version gate / exponential backoff / content cap / tail cache), `topicCreationBudget` + `AttentionTopicGuard` (P17), `LlmCircuitBreaker`.
- The multi-machine loop-safety audit (CMT-1109) scores every mesh-path repeating behavior against the three brakes / four sentinel conditions and fixes the unbounded ones as individual PRs.
- This catalog entry, so the `/spec-converge` reviewer asks the loop questions of every spec.

**Earned from:** One day (2026-06-05), three same-shaped incidents on the live fleet: the reaper age-gate re-requesting a vetoed kill every 5s forever (17,503 identical requests — #863); the live-tail streamer re-reading the 75k-line message log per topic per 5s tick and hot-retrying rejected flushes — its own cost froze the event loop, which staled mesh timestamps, which caused the very rejections it retried (#867); and the topic-spam flood family (P17). Per Distrust Temporary Success: three recurrences in one day is one missing standard, not three bugs.

### P20. Verify the State, Not Its Symbol (a detector confirms the state, never a symbol of it; absence ≠ the alarm)

**Statement:** A detector, gate, verifier, or sentinel must confirm the **state of the world** it claims to detect — never accept a **symbol** of that state (a string, label, marker, filename, or the mere presence/absence of a proxy signal) as proof the state holds. The failure runs both ways: the *presence* of a symbol is not the condition being true, and the *absence* of a signal is not the condition being true. Missing evidence resolves to **unknown**, and unknown fails toward the **least-harmful** action *for that detector* — which is not always "closed" (a security gate's unknown → block; a notice/recovery sentinel's unknown → stay quiet, because the nag IS the harm).

**Source:** constitution article "Verify the State, Not Its Symbol" (Substrate); proposed + ratified by Justin 2026-06-24 (topic 16566). Parent principle of L5 (state-detection robustness) and the AUP-wedge note. Full analysis: `docs/specs/blindspot-class-symbol-vs-state.md`.

**Translation:**
- For every detector/gate/verifier in a spec, ask the three questions: **(A)** does it fire on a *corroborated* signal causally tied to the real state (a second signal an impostor state can't fake), or on a bare symbol's presence? **(B)** can the detector's input channel be written into incidentally by its own subject (the agent's own work / the thing it monitors)? If so, read a channel the subject can't pollute (a structured exit state, not free terminal text). **(C)** does it name which fail-direction is least-harmful, fail that way on *unknown*, and resolve its evidence by the real (often plural) location — so a genuine not-found is *unknown*, never the alarming state?
- A brittle signal is still required to be a *correct* signal — this is orthogonal to *Signal vs Authority* (P2), which only governs who may BLOCK.
- "Fail closed" is not universal — derive the least-harmful direction per detector and state it.
- A cadence/liveness watermark has three states: `uninitialized`, `healthy`, and `stale`. Zero/absent/invalid means no first observation exists and therefore cannot authorize recovery or notification; only the measured age of a real prior observation may do that.

**Enforcement (structural):**
- ENFORCEMENT FIRST: the crystallizing instance is fixed in `docs/specs/ratelimit-sentinel-false-positive-hardening.md` (corroborated idle-error fire + account-home, fail-safe-by-direction verifier).
- This catalog entry, so the `/spec-converge` lessons-aware reviewer asks the three questions of every spec's detectors.
- `src/core/cadenceLiveness.ts#classifyCadenceLiveness` makes the cadence monitor's unknown state explicit in a discriminated union; unit, integration, and boot-timer lifecycle tests refuse an `uninitialized → stale` collapse.
- Next surface (tracked): a `no-uncorroborated-symbol-fire`-style CI ratchet for detector callsites that fire on a bare substring with no second-signal corroboration, mirroring `no-silent-llm-fallback.test.ts`.

**Earned from:** The crystallizing instance, not the first — 2026-06-24 (topic 16566): the RateLimitSentinel fired "this turn died on an API error" because the words `API Error:` were on the pane (put there by the session *investigating* API errors), then cried wolf for 11 min because its verifier looked in one Claude home while the session ran under another account home (absence-of-file read as never-recovered). The detector that diagnosed the bug was tripped by the bug, live. The class had recurred under disguises — the 2026-06-06 stale-pointer crying-wolf (mode C), the AUP-rejection wedge (mode B, a CLAUDE.md note only), and L5's origin (mode C for parsers). Per *Distrust Temporary Success*: four-plus recurrences is one missing standard, not four bugs.

### P21. An Instar Agent Is Always a Multi-Machine Entity (unified is the default; machine-local must justify itself)

**Statement:** Every feature, state surface, and design decision treats the agent as a SINGLE entity spread across many machines, BY DEFAULT. "Unified across my machines" is the default posture; "machine-local" is an EXCEPTION that must name a concrete reason it *cannot* be unified (a credential physically bound to one disk's keychain; a hardware-bound resource; an operator-ratified exception) — never a default chosen for expedience. A design that silently assumes one machine, or declares "machine-local BY DESIGN" with no justification, is a violation, not a valid posture.

**Source:** constitution article "An Instar Agent Is Always a Multi-Machine Entity" (Building — sibling of Cross-Machine Coherence); operator-ratified by Justin 2026-07-03 (topic 29723). Distinct from Cross-Machine Coherence (which governs lease/seamlessness robustness under degraded conditions) — this governs the default posture of every NEW feature: the machinery only makes the agent whole if features actually ride it.

**Translation:**
- For every state surface, notice, or generated URL in a spec, ask: "what is its cross-machine posture — `unified`, `proxied-on-read`, or `machine-local + justification`?" Absence defaults to `unified`-required.
- "machine-local BY DESIGN" is NOT a valid answer on its own — it must name the concrete reason it cannot be unified, jailed to the closed taxonomy (physical-credential-locality, hardware-bound-resource, operator-ratified exception).
- The existing per-feature posture check tests for a *declaration*; this principle tests for the unified *default* — a wrong posture that is merely declared still fails.

**Enforcement (structural):**
- The enforcement build (tracked, post-ratification): the `/spec-converge` cross-machine check is STRENGTHENED to reject undefended "machine-local"; the side-effects review §7 posture field gains the justification requirement; the Standards-Conformance Gate gets a guard marker for a machine-local surface shipped without justification.
- Existing features swept for undefended machine-local surfaces (folds into the feature-maturation audit, topic 30668).
- This catalog entry, so the `/spec-converge` lessons-aware reviewer asks the posture question of every spec while that build lands.

**Earned from:** 2026-07-03 (topic 29723): the tiered-intelligence-delegation spec defaulted its consult memory to machine-local and survived SEVEN convergence rounds before the operator caught it on read. That the review machinery passed it and only the operator's read caught it is the tell — the always-multi-machine expectation lived in prose and reviewer habit, not in structure. Justin: "it should be fundamental in our constitution that an Instar agent is always supported as a multi-machine entity."

### P22. Self-Heal Before Notify (the operator hears only when self-healing fails)

**Statement:** An internal issue is routed to the parts of the system that pick it up and self-heal — the watchers, and the watchers of the watchers. The operator is notified ONLY when the self-healing measures THEMSELVES have failed (exhausted, crashed, unable to recover). A watcher that detects a gap must attempt a bounded, audited self-heal FIRST and escalate to the operator as a LAST resort, never as its first move. Composes with No Silent Degradation (nothing is swallowed — every detection + heal attempt + outcome is audited) by refining *to whom* the report goes: into the self-heal machinery, not the user; the audit trail IS the report, the operator is the last resort.

**Source:** constitution article "Self-Heal Before Notify — The Operator Hears Only When Self-Healing Fails" (Interaction); operator-ratified by Justin 2026-07-03 (topic 29723). General rule beneath Near-Silent Notifications (self-lifecycle narration is default-silent housekeeping).

**Translation:**
- For every watcher/monitor in a spec that can raise an operator-facing notice, ask: "what bounded self-heal does it attempt, and is the operator-raise gated on that heal's EXHAUSTION (attempted, bounded retries per P19, still failing) rather than on the raw detection?"
- A watcher that escalates on first detection with no heal attempt is the anti-pattern — the escalation must be structurally downstream of a failed heal.
- Nothing goes silent: every detection + heal attempt + outcome is audited; only the exhausted-heal path reaches the operator, deduped, one item.

**Enforcement (structural):**
- The enforcement build (tracked, post-ratification, newly required): self-heal-before-notify becomes a spec-review question for every escalating watcher, checked at spec-converge and in the side-effects review; existing first-notify watchers that skip a heal are swept in the same audit.
- This catalog entry, so the `/spec-converge` lessons-aware reviewer asks the self-heal question of every watcher spec while that build lands.

**Earned from:** 2026-07-03 (topic 29723): hardening the tiered-intelligence spec's "watcher for the watcher," the operator named the general rule — "the user almost never gets notified of internal issues; those get routed to aspects of the system that pick them up and self-heal (the watchers, and the watchers of the watchers); the only time the user should be notified is if these self-healing measures themselves fail."

### P23. Notices Route to the Alerts Topic, Never a New One (an ownerless notice has ONE destination)

**Statement:** A user-facing message that belongs to an existing conversation goes THERE; one that belongs to NO existing conversation topic (an alert, system notice, housekeeping escalation) routes to the ONE dedicated alerts/hub topic. Creating a NEW Telegram topic per alert/event/item is forbidden — the only topics created are user-initiated ones and a small fixed set of bounded, create-once system topics. The routing corollary of P17 (Bounded Notification Surface): P17 caps how MANY topics may be born; this names WHERE an ownerless notice goes instead.

**Source:** constitution article "Notices Route to the Alerts Topic, Never a New One" (Building — extends Bounded Notification Surface); a standing operator rule since 2026-07-01, operator-ratified to constitutional status by Justin 2026-07-03 (topic 29723).

**Translation:**
- The alerts/hub topic is the DEFAULT destination for an ownerless notice — routing there is the rule, not a fallback the code stumbles into.
- A feature notifying per-element over a collection must AGGREGATE (one summary item with the count + list), never one item per element.
- Much of the machinery already ships (P17's `createForumTopic` budget, `AttentionTopicGuard` coalescing, the burst-invariant test) — this principle makes it the rule and closes the unique-source dodge.

**Enforcement (structural):**
- `topicCreationBudget` inside `TelegramAdapter.createForumTopic` (origin-typed, auto-by-default) + `AttentionTopicGuard` at `createAttentionItem` + `tests/integration/notification-flood-burst-invariant.test.ts` (existing, made load-bearing for routing).
- The enforcement build (tracked): the ownerless-notice → alerts-topic default asserted at the routing chokepoint and checked at spec-review.
- This catalog entry, so the `/spec-converge` lessons-aware reviewer flags a feature that would create a topic per alert.

**Earned from:** The recurring topic-spam floods, all the same shape — a housekeeping feature spawning one topic per event: 2026-05-22 (sentinel), 2026-05-28 (collaboration-redrive), 2026-06-05 (worktree-detector, which dodged the per-source budget with unique sources — the reason the ceiling moved to the create primitive itself). Standing operator rule since 2026-07-01; directed to constitutional status 2026-07-03 (topic 29723): "any message sent to the user that didn't belong to a topic needs to go to the dedicated alerts topic; this needs to be a standard."

## Part 4 — How the lessons-aware reviewer uses this index

The 8th `/spec-converge` reviewer (see `skills/spec-converge/SKILL.md`) loads this document plus the linked `feedback_*.md` files and the principles in `CLAUDE.md`, then asks for each spec under review:

For each Part 1 principle (P1-P23):
- Does the spec engage with this principle?
- Does it contradict it?
- If contradicting, is there an explicit, defended rationale in the spec?

For each Part 2 architectural lesson (L1-L17):
- Does the spec touch a surface this lesson covers?
- If so, does it engage with the existing infrastructure named in the lesson?
- Does it reinvent or backtrack on the existing infrastructure?

For each Part 3 behavioral lesson (B1-B39):
- Does the spec propose agent-facing behavior?
- If so, does it respect the documented conduct rules?

Output: structured findings per category, with citations to this index. Findings are blocking until either resolved in the spec or explicitly justified in the spec's `lessons-engaged:` frontmatter.

---

## Maintenance log

| Date | Change |
|---|---|
| 2026-05-19 | Initial creation. Cataloged 5 foundational principles, 10 architectural lessons, 31 behavioral lessons. Sourced from CLAUDE.md + 45 `.instar/memory/feedback_*.md` files + `docs/specs/`. |
| 2026-05-19 | Comprehensive audit pass (per Justin 2026-05-19). Added P6 Zero-Failure, P7 LLM-Supervised Execution, P8 UX & Agent Agency, P9 Intent Engineering, P10 Comprehensive-First Directive. Added L11 External Operation Safety, L12 Destructive-Tool Containment, L13 Parallel Dev Isolation, L14 PR Review Hardening, L15 Authorization Policy, L16 Project Scope, L17 Integrated-Being Ledger. Added B32 No Interactive CLI, B33 No AskUserQuestion free-text, B34 Initiative Hierarchy, B35 Defensive Fabrication / Escalation-as-default, B36 USER.md "decide and do", B37 Dawn patterns, B38 Two memory systems, B39 Coherence Gate. Expanded P4 with StallTriageNurse origin + canonical category names. Expanded L1 with recurrence-corrected dates. Expanded L2 with topic-6931 origin. Expanded L6 to seven canonical dimensions (was five). Now: 10 principles + 17 architectural lessons + 39 behavioral lessons. |
| 2026-06-03 | Added P14 Distrust Temporary Success (a recurrence is a root cause) and P15 Friction Is a Spec (productize the workaround), mirroring the two new constitution standards earned from the listSessions hot-loop incident (topic 13435; full account in `docs/lessons/2026-06-03-listsessions-hotloop-success-story.md`). Updated the spec-converge review template's Part-1 range from P1-P10 to P1-P15 (it had not been updated when P11-P13 were added — latent under-enforcement). |
| 2026-06-05 | Added P16 Notice + Solve Inefficiencies (efficiency is a standing search — the proactive sibling of P15), mirroring the new constitution standard ratified by Justin during the recursive apprenticeship run (topic 13435), earned from the merge-churn throughput inefficiency (strict branch protection + fast main + slow CI = rebase loops). Updated the spec-converge review template's Part-1 range from P1-P15 to P1-P16. |
| 2026-06-05 | Added P17 Bounded Notification Surface (no feature may flood the user), mirroring the new constitution standard proposed after the third topic-spam flood (topic 11960; worktree-detector false-positive mass-flag dodged the per-source budget via unique sourceContexts). Enforcement is structural from day one: burst-invariant test + funnel lint + in-chokepoint budget. Updated the spec-converge review template's Part-1 range from P1-P16 to P1-P17. |
| 2026-06-05 | Added P18 Observation Needs Structure (a duty to notice requires an unskippable artifact) + two corollaries (silent compensation is a swallowed finding → Friction-Is-a-Spec revision; record schema is perception → Observability revision), mirroring the constitution amendment ratified by Justin during apprenticeship run 2 (topic 13435, UX-blindspot arc). Enforcement structural from day one: #856 cycle gate, #844 verdict finalization, #854 causalAutopsy field. Updated the spec-converge review template's Part-1 range from P1-P17 to P1-P18. |
| 2026-06-05 | Added P19 No Unbounded Loops (every repeating behavior carries its own brakes: backoff + breaker + cap, with the ratified Eternal Sentinel exemption — declared, healer-only, rate-floored constant-cost, still-observable), mirroring the constitution standard requested and ratified by Justin (topic "Resource Limitation Mitigation") after three same-day loop incidents: reaper kill-request loop (#863), live-tail compounding spiral (#867), topic-flood family (P17). Enforcement: canonical brake shapes in code + the CMT-1109 loop-safety audit + sustained-failure test pattern. Updated the spec-converge review template's Part-1 range from P1-P18 to P1-P19. |
