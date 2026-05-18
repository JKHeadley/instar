# Instar Provider Portability

**Goal:** Abstract Instar's coupling to Claude (Anthropic) into a thin substrate that supports any capable agent provider — Claude, OpenAI Codex, Google Gemini, local models (Ollama / LM Studio / similar) — without rewriting Instar.

**Why:** Anthropic's 2026-06-15 Agent SDK credit change reprices Instar's existing usage pattern. The economically defensive response is also the architecturally correct one: stop being locked to one provider. This also unlocks running Instar against self-hosted models.

**Branch:** `spec/provider-portability`
**Target release:** v1.0.0 (date TBD — gated on migration testing on local agents)

---

## Status (2026-05-18)

**Release-ready.** All v1.0.0 work items complete except deployment/publishing.

| Phase | Status | Output |
|---|---|---|
| 1 Primitives inventory | ✓ done | [01-primitives-inventory.md](./01-primitives-inventory.md) |
| 1a Convergent functional map | ✓ done | [00-functional-map.md](./00-functional-map.md) |
| 1b Verification + convergence | ✓ done | [01b-convergence-report.md](./01b-convergence-report.md) |
| Pre-2 Interactive-pool prototype | ✓ passed | [prototype/interactive-pool/findings.md](./prototype/interactive-pool/findings.md) |
| Pre-2 Codex deep-dive | ✓ done | [02-codex-deep-dive.md](./02-codex-deep-dive.md) |
| Pre-2 Phase 2 plan | ✓ done | [03-phase-2-plan.md](./03-phase-2-plan.md) |
| 2 Interface design + conformance | ✓ done | `../../src/providers/` |
| 3a Anthropic headless adapter | ✓ done | `src/providers/adapters/anthropic-headless/` |
| 3b Anthropic interactive-pool adapter | ✓ done | `src/providers/adapters/anthropic-interactive-pool/` |
| 3c Behavior parity test suite | ✓ done | `src/providers/parity/` |
| 4 OpenAI Codex adapter | ✓ verified | `src/providers/adapters/openai-codex/` (acceptance/phase-4.json) |
| 5a Framework-aware model router | ✓ done | `FrameworkModelRouter` + `PreferenceStore` + `TaskClassifier` |
| 5b CostStateTracker | ✓ done | `src/providers/costAwareRouting.ts` |
| 5c Cost-aware routing policy | ✓ done | `CostAwareRoutingPolicy` wired at server boot |
| 6 Open-source / local adapter | ✓ done (passthrough) | Codex CLI `--oss --local-provider` via `frameworkSessionLaunch`; recipe at `docs/local-model-recipe.md` |
| 7 Migration design + local agent testing | ✓ done | `PostUpdateMigrator.migrateProviderPortability`; verified on deep-signal |
| 8 v1.0.0 release | release-ready (branch merge pending) | Final cycle 2026-05-18 |

**Spec 12 (Codex Rule 1) enforcement status:**
- Phase A (warning + telemetry) — DEFAULT in v1.0.0
- Phase B (hard refuse) — OPT-IN via `INSTAR_RULE1_ENFORCE=hard` in v1.0.0; default in v1.1
- Escape hatch (`INSTAR_DISABLE_RULE1_OPENAI=1`) — sunsets `2026-12-01`
- Drift CI gate — active in `npm run lint`

---

## Read in this order

If you're new to the project, read the docs in this sequence:

1. **[01-primitives-inventory.md](./01-primitives-inventory.md)** — the initial Phase 1 inventory. Defines what a "primitive" is and lays out the four-layer model (transport / capability / observability / control / integration).
2. **[00-functional-map.md](./00-functional-map.md)** — every file in instar's source mapped by functional cluster, with coupling level (direct Claude / indirect Claude / none). The Pass-1a expansion of the inventory from 21 primitives to 33.
3. **[01b-convergence-report.md](./01b-convergence-report.md)** — the Pass-1b verification result. Locks the primitive set at 36 across five layers. Includes the meta-finding that many instar subsystems agents propose as primitives are actually application infrastructure that sits above the substrate.
4. **[prototype/interactive-pool/findings.md](./prototype/interactive-pool/findings.md)** — the feasibility prototype for the interactive-pool primitive (long-lived `claude` REPL driven via tmux). Passed.
5. **[02-codex-deep-dive.md](./02-codex-deep-dive.md)** — Codex CLI mapped against the 36 primitives. 35 of 36 map cleanly; 1 rename, 5 capability-flag adjustments, 15 new optional primitives surfaced. Final set: 51.
6. **[03-phase-2-plan.md](./03-phase-2-plan.md)** — how Phase 2 turns the 51 primitives into TypeScript interfaces, with sequencing and conformance test approach.

---

## Key decisions locked

- **Generic naming throughout.** No `claude*` / `anthropic*` in shared interfaces. `claudeSessionId` → `providerSessionId`. `.claude/` becomes `.agent/<provider>/` via migration. `CLAUDE.md` aliased to `AGENT.md`.
- **Two Anthropic adapters in Phase 3, not one.** `anthropic-headless-sdk` (uses `claude -p`, draws from Agent SDK credit pot) and `anthropic-interactive-pool` (uses long-lived `claude` REPL, draws from Max subscription). Routing policy decides which based on quota state.
- **Routing default:** drain Agent SDK credit first (it's prepaid as part of subscription, use it), fall back to interactive pool when credit is exhausted or below safety margin.
- **51 primitives, 36 universal + 15 optional.** Optional primitives are capability-flagged; providers declare what they support, routing policy can require specific capabilities.
- **Canonical event vocabulary at the abstraction boundary.** Adapters normalize provider-native events (`item.commandExecution.outputDelta` on Codex, `tool_use` on Claude) into Instar's canonical types (`messageDelta`, `toolCall`, `toolResult`, `turnEnd`, `error`).
- **Migration is its own workstream.** Phase 7 produces a migration script tested on multiple local agents before v1.0.0 ships. CHANGES.md captures every behavior-affecting change as it's made, not retroactively.
- **No moral framing of customer adaptation.** When a vendor unilaterally reprices existing usage, building a workaround isn't arbitrage — it's the customer using what they paid for. Architectural choices follow the technical-stability and account-risk arguments only.

---

## Why we're doing this now (the trigger)

On 2026-04-23 Anthropic announced that starting 2026-06-15, Pro/Max/Team/Enterprise subscribers get a *separate* monthly credit pot for "Agent SDK" usage — anything triggered via `claude -p`, the published Agent SDK package, or third-party tools. Max 20x: $200/month at standard API rates, no rollover, hard ceiling unless extra-usage overage is enabled.

Trade press framing (InfoWorld, The Decoder, XDA, BigGo Finance, Theo Browne / T3 Code): this ends the "compute arbitrage era," ~25-40x effective price increase for third-party agentic tools. Instar is exactly the category being repriced.

The economic response is to build provider portability so Instar isn't held hostage to one vendor's pricing. The architectural response is identical — generic interfaces are the right design even before billing arrived.

---

## Methodology notes

The Phase 1 work used **four parallel Explore agents** with disjoint source-tree slices, two convergence passes, and a final synthesis step that filtered out application-infrastructure that agents had mistakenly proposed as primitives. The Codex deep-dive used a research agent against authoritative sources (OpenAI docs, GitHub repos, app-server README) rather than Claude's training data, since the training cutoff predates Codex's current generation. The feasibility prototype was a shell script driving real `claude` and `tmux` binaries — no mocks, no theory.

This pattern (parallel scoped agents → synthesis → external verification where possible) is the working model for the rest of the project too.
