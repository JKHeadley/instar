# v1.0.0 — Provider Portability — Running Change Log

This log captures every behavior-affecting change in the provider-portability project as it's made (not retroactively). When v1.0.0 is cut, the released `NEXT.md` is condensed from this.

**Branch:** `spec/provider-portability`
**Status:** in progress (Phase 2 starting 2026-05-14)

---

## Pre-release foundation (no behavior changes yet — spec only)

### 2026-05-14 — Phase 1 foundation complete

- **Functional map produced.** Every file in `src/` (441 files) classified by functional cluster and Claude-coupling level (direct / indirect / none). Roughly 63 files direct, 108 indirect, 270 provider-agnostic. See `specs/provider-portability/00-functional-map.md`.
- **Primitives inventory converged.** Two-pass convergence (Pass 1a expanded inventory from 21 → 33 primitives; Pass 1b verification added 3 + 1 split). Final set: 36 universal primitives across 5 layers. See `specs/provider-portability/01-primitives-inventory.md` and `01b-convergence-report.md`.
- **Codex deep-dive done.** Codex CLI mapped against the 36 primitives; 35 cleanly map, 1 renamed, 5 capability-flagged as asymmetric, 15 new optional primitives surfaced. Final expanded set: 51 primitives. See `specs/provider-portability/02-codex-deep-dive.md`.
- **Interactive-pool feasibility prototype passed.** Shell-script prototype drove a long-lived `claude` REPL through 10 prompts via tmux send-keys + capture-pane; all 10 succeeded; subscription billing confirmed. See `specs/provider-portability/prototype/interactive-pool/findings.md`.

### Decisions locked

- Generic naming throughout. No `claude*` / `anthropic*` in shared interfaces. `claudeSessionId` → `providerSessionId`. `.claude/` → `.agent/<provider>/`. `CLAUDE.md` → `AGENT.md` (alias).
- Two Anthropic adapters in Phase 3: `anthropic-headless-sdk` and `anthropic-interactive-pool`. Routing policy decides.
- Routing default: drain Agent SDK credit first, fall back to interactive pool. (User decision 2026-05-14 — overrode my initial proposal.)
- 51 primitives, 36 universal + 15 optional capability-flagged.
- Canonical Instar event vocabulary at the abstraction boundary; adapters normalize.
- Migration is its own workstream (Phase 7) with local-agent testing before release.

---

### 2026-05-14 — Phase 2 complete

All TypeScript interfaces and the conformance-test framework for the provider abstraction landed in `src/providers/`. No adapter code yet (that's Phase 3); these are contracts.

- **Foundational types** (4 files): `types.ts` (ProviderId, SessionHandle, ModelTier, UsageReport, ProviderSpecific, CancellationOptions); `capabilities.ts` (CapabilityFlag enum with 36 universal + 18 optional + 5 asymmetric sub-flags); `errors.ts` (ProviderError hierarchy: Auth, Quota, RateLimit, Timeout, Network, Abort, UnsupportedCapability, Unexpected, with type guards); `events.ts` (CanonicalEvent discriminated union — MessageDelta, ToolCall, ToolResult, TurnEnd, SessionLifecycle, SubagentLifecycle, InteractivePrompt, Error, ProviderRaw escape hatch).
- **Transport layer** (6 files): oneShotCompletion, structuredOneShot, agenticSessionHeadless, agenticSessionInteractive, warmSessionInbox (the interactive-pool substrate), agenticSessionRpc.
- **Capability layer** (6 files): toolAccess, toolAllowlist (with MCP identity matching for Codex), fileSystemAccess (read-only / workspace-write / danger-full-access), pathAllowlist (with deny precedence), bashExecution (per-command rules + env policy), webAccess.
- **Observability layer** (9 files): liveOutputStream, conversationLogReader, conversationLogTailer, hookEventReceiver (10+ Claude / 6 Codex hooks with synthesis), subagentLifecycleObserver, sessionId, usageMeterProvider (with `agentSdkCredit` field for Anthropic's $200 pot), processLifecycle, interactivePromptObserver.
- **Control layer** (11 files): inputInjection, hardKill, interrupt, stopGateInterceptor, timeoutBound, idleBound, authCredentialInjection, credentialStorageProvider, contextScopeControl, compactionLifecycle, intelligenceCallQueue.
- **Integration layer** (4 files): providerScaffolder, mcpToolRegistry, sessionResumeIndex, conversationLogProvider.
- **Optional layer** (18 files): threadFork, threadRollback, threadGoalSlot, profileSwitcher, customModelProvider (partial Phase 6 solution via Codex+Ollama), shellEnvironmentPolicy, otelExporter, complianceApi, pluginRegistry, trustedProjectGate (security primitive worth adopting on Claude too), filesystemRpc, processSpawn, capabilityNegotiation, notificationOptOut, codeReviewPreset, csvBatchMode, selfUpdate, requirementsToml.
- **Registry + routing** (2 files): `registry.ts` exposes a singleton `registry` with register / unregister / candidates / resolve / resolvePrimitive; `routing.ts` defines `RoutingPolicy` interface plus three reference policies (FirstAvailable, PreferCapability, Chain). Cost-aware policy is Phase 5.
- **Conformance test framework** (56 files): `runner.ts` (ConformanceContext, ConformanceFactory, contract-assertion stubs); `index.ts` (barrel export of all 54 suites); 54 `runXxxConformance(factory, ctx)` suites — one per primitive — that verify capability flag and method presence. Phase 3+ adapter packages extend these with behavior tests gated by `ctx.realApi`.

**Final total**: 116 TypeScript files in `src/providers/`, all compile cleanly under existing `tsconfig.json` with no errors. 9 commits on `spec/provider-portability` for Phase 2 (steps 1–9). Zero changes to existing source — the entire substrate is additive.

### Phase 2 design notes worth preserving for Phase 3

- The `IntelligenceProvider` interface in `src/core/types.ts` is the in-tree precursor of `OneShotCompletion`. Phase 3a refactor will re-express it through the new substrate (`ClaudeCliIntelligenceProvider` becomes `anthropic-headless`'s OneShotCompletion implementation).
- `SessionHandle` is opaque to consumers — a branded string at runtime. Each adapter knows how to interpret its own handles; the type system enforces that the same adapter that issued a handle is the one that uses it.
- `WarmSessionInbox` is the substrate for the Phase 3b interactive-pool adapter. The prototype proved the mechanic (tmux send-keys + capture-pane against a long-lived `claude` REPL). The interface accepts an inbox path so callers can use file-system message queues without dictating implementation.
- Asymmetric primitives (`hookEventReceiver`, `usageMeterProvider`, `compactionLifecycle`, `subagentLifecycleObserver`, `interactivePromptObserver`) use sub-capability flags (PublicUsageApi, PreCompactHook, SubagentLifecycleHooks, NativeIdleBound, StructuredApprovalEvents) so routing can prefer authoritative paths when available.
- `customModelProvider` (optional, Codex-native) is the strategic shortcut for Phase 6: routing through Codex with Ollama as the underlying model is faster than building a direct Ollama adapter.
- `trustedProjectGate` (optional, Codex-native) is a security primitive Instar should adopt even on top of Claude — closes the malicious-CLAUDE.md attack surface that Claude lacks native protection for.

---

## What's next

Phase 3a — `anthropic-headless` adapter (port current `claude -p` behavior onto the new substrate). Phase 3b — `anthropic-interactive-pool` adapter (interactive-pool substrate). Phase 3c — behavior-parity test suite between 3a and 3b.
