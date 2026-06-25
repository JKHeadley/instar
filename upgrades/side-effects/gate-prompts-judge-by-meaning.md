# Side-Effects Review — gate-prompts-judge-by-meaning-not-literal-lists

**Change:** Make the outbound tone gate's behavioral rules (B15–B18) judge by MEANING, not by literal-phrase presence; author the new constitution standard "Intelligent Prompts — An LLM Gate Must Not String-Match" with a CI ratchet; feed a deterministic agent-state (session-clock) signal into B15; and flip every gating no-verdict path to FAIL-CLOSED (invalid-rule, JSON-parse, provider-exhaustion, route-budget timeout) with an operator kill-switch.

**Spec:** docs/specs/gate-prompts-judge-by-meaning-not-literal-lists.md (review-convergence + approved:true). ELI16 + convergence report shipped.

**Signal-vs-Authority (Phase 1):** This IS a decision point (the outbound gate). The change is the *purest application* of Signal-vs-Authority — it removes brittle string-matching authority from the LLM's own prompt and routes deterministic detection through signals (B8/B9/B12 pattern), letting the full-context mind judge. No brittle check gains blocking authority; the CI ratchet is a signal-only developer-loop guard (fails CI, makes no runtime decision).

## The 8 questions

1. **Over-block** — Meaning-based judgment could over-block honest status disclosure ("at 95% context, continuing"). MITIGATED structurally: §Design 1 step 1 makes "a stop is ACTUALLY proposed" the hard precondition (mention ≠ stop → PASS), and step 4b scopes the freshness tell to agent-fatigue framing (external-dependency timing passes). Both have explicit PASS fixtures. An over-block is also self-correcting (the agent gets the reason + rephrases).
2. **Under-block** — A sufficiently sophisticated semantic rewrite of a *literal-gate construction* could evade the CI ratchet (documented honest limit; human review of judgment-prompt changes still required). At runtime, the meaning-based gate is strictly *harder* to evade than the old literal list. B1–B7 still literal-match in-prompt (tracked debt CMT-1793).
3. **Level-of-abstraction fit** — Correct layer: the deterministic detectors (dangerous-command/free-text floors, jargon/junk signals, the new session-clock signal) live OUTSIDE the prompt and feed it; the LLM judges. This is the architecture the new standard mandates. B1–B7's in-prompt matching is the one not-yet-migrated spot (CMT-1793).
4. **Signal vs authority compliance** — Compliant by construction (see Phase 1). The ratchet enforces it forward.
5. **Interactions** — The fail-closed change interacts with: the capacity-shed sibling path (now consistent — both hold), the route-budget fail-open (now opt-in fail-closed via the kill-switch), and the `no-silent-llm-fallback` ratchet (gate already satisfies it via `gating:true`; no REVIEWED_ADVISORY edit — asserted by a test). The structured-intermediate is back-compat: absent block ⇒ legacy path unchanged. The agentState signal is fail-open-skip on error (never blocks an outbound).
6. **External surfaces** — The gate's blocking verdict is user-visible. A new config key `messaging.toneGate.failClosedOnExhaustion` (default true). A new CLAUDE.md section (+ framework-shadow mirror to AGENTS.md/GEMINI.md). The new STANDARDS-REGISTRY standard. No new HTTP route. The fail-closed direction means a *total LLM outage* holds `/telegram/reply` outbound (held-not-lost, retried) — system/lifeline/post-update sends use separate routes and are unaffected.
7. **Multi-machine posture** — **REPLICATED.** The prompt is rebuilt from source on every review; the provider is stateless; the ratchet + standard ship compiled. The agentState signal reads local topic-bound clock on the serving machine (where the gate already runs, pre-adapter). The CLAUDE.md/shadow awareness note rides normal per-machine migration (converges as each machine updates). No machine-local state affects the verdict. Uniform by construction.
8. **Rollback cost** — Prompt revert is a one-file `git revert`. The fail-closed flips are independently revertable per return path, AND the provider-exhaustion + slow-timeout paths carry a live operator kill-switch (`failClosedOnExhaustion:false`) — revertable without a deploy (mobile-first). The CI ratchet is removable by deleting the test.

## Tracked follow-ups (no orphan deferrals)
- B1–B7 detect-outside-feed-signal migration — CMT-1793 (frozen PHASE2_MIGRATION_DEBT allowlist + stale-allowlist test).
- Availability-aware kind-routing + codebase-wide gating-fail-open sweep — CMT-1794 (DEFERRED_REFINEMENT, non-placeholder-commitment-pinned).
- Dedicated production-init E2E ("gate alive") + the live Playwright-Telegram channel proof — driven by the orchestrating session before merge (the integration tier already exercises the real route + real gate end-to-end).

## Phase 5 — Second-pass review (high-risk: gate/sentinel/outbound-block)

Independent re-audit (performed inline by the build fork, which cannot spawn a subagent):

- **Fail-closed availability:** Verified system/lifeline/`post-update` sends use SEPARATE routes (`routes.ts:10430`), so failing closed at the `/telegram/reply` seam only holds conversational + automated traffic during a *total* outage — held-not-lost, kill-switch-revertable. Sound.
- **Structured-derivation safety:** The derivation only ever makes the verdict MORE conservative (derives a BLOCK from the model's own structured reasoning); it never flips a block to a pass. A contradictory structured verdict re-prompts then holds. Sound.
- **Back-compat:** A response with no `structured` block follows the exact legacy path (verified by an explicit test). Existing callers (`new MessagingToneGate(provider)`) compile unchanged (config optional). Sound.
- **Ratchet brittleness:** The ratchet keys off the machine-readable RULE_CLASSES registry (not prose), checks both boundary directions, fails closed on an unclassified rule, and has a negative test proving it catches a reworded construction. Its honest limit is documented in the standard + the test header. Sound.
- **Concern raised + resolved:** the re-prompt doubles provider calls on a discipline-failure branch — bounded to ONE extra call, only on the rare wanted-block-mis-cited / unparseable / contradictory branch, inside the existing route budget, and the error path collapses to hold (no back-door into the deferred fail-open). Acceptable.

**Verdict: Concur with the review.** No blocking concern. The change strengthens the gate and is compliant with Signal-vs-Authority and No Silent Degradation.
