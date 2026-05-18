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

### 2026-05-15 — Phase 3a complete

First concrete provider adapter (`anthropic-headless`) landed at `src/providers/adapters/anthropic-headless/`. Implements the Phase 2 substrate by delegating to Anthropic's `claude -p` and existing Instar infrastructure. No changes to existing source — purely additive.

- **Adapter package** (skeleton + 28 primitive implementations + 5 stubs): README, `index.ts` exposing `createAnthropicHeadlessAdapter` factory, `capabilities.ts` declaring the full universal set + Anthropic-favorable asymmetric sub-flags (PublicUsageApi, PreCompactHook, SubagentLifecycleHooks), `config.ts` with env-var defaults, `errors.ts` mapping exec/API errors to canonical hierarchy, `stubs.ts` for primitives without active consumers.
- **Real implementations** for the active-consumer primitives: OneShotCompletion (claude -p with env-scrubbing and OAuth/API-key credential routing), AgenticSessionHeadless (tmux + claude -p with full env injection), HardKill / InputInjection / Interrupt (tmux operations), TimeoutBound / IdleBound (in-memory policy with external watchdog enforcement), AuthCredentialInjection (validate + probe via Messages API), CredentialStorageProvider (file-backed at ~/.instar/anthropic-credentials.json with 0600), ContextScopeControl (--setting-sources mapping), CompactionLifecycle (polls /tmp/claude-session-<id>/compacting marker), StopGateInterceptor (handler registry), SessionId (handle↔Claude-UUID bridge), LiveOutputStream (tmux capture-pane snapshot + tail with ANSI stripping), ProcessLifecycle (tmux list-panes), ConversationLogReader / Tailer (parses ~/.claude/projects/.../jsonl into CanonicalEvents), UsageMeterProvider (Anthropic OAuth /api/oauth/usage), HookEventReceiver (EventEmitter-backed dispatcher; HTTP receiver in monitoring/ feeds via dispatchHookEvent), SubagentLifecycleObserver (filters hook events), SessionResumeIndex (scans ~/.claude/projects), ProviderScaffolder (creates `.agent/anthropic/`), McpToolRegistry (writes `~/.claude.json`), ConversationLogProvider (composes reader+tailer), all 6 CAPABILITY primitives (buildSpec for portable spec construction).
- **Stubs** for primitives without active consumers (throw UnsupportedCapabilityError with clear "not yet implemented" messages): StructuredOneShot, AgenticSessionInteractive, WarmSessionInbox, AgenticSessionRpc, InteractivePromptObserver, IntelligenceCallQueue. The adapter still declares these capabilities so the registry can find it; the throw makes any premature use loud rather than silent.
- **Smoke test** (`_smoketest.ts`, gated by `INSTAR_REAL_API=1`): real `claude -p` invocation through OneShotCompletion returned "4" for "What is 2+2?" in 5 seconds. End-to-end wiring verified against actual Anthropic infrastructure.
- **TypeScript verification**: `npx tsc --noEmit -p .` passes across the entire `src/providers/` tree (Phase 2 substrate + adapter) with zero errors.

### Phase 3a design notes

- The adapter is purely additive in Phase 3a — application code still uses `ClaudeCliIntelligenceProvider` and `SessionManager` directly. The refactor that wires the adapter into the application layer (replacing direct usage with `registry.resolve()`) is queued behind Phase 3b so that the routing policy has both adapters to choose from when it lands.
- SessionHandles issued by the adapter are formatted `anthropic-headless/<tmuxName>`. The `tmuxSessionFromHandle` helper extracts the tmux session name for control operations. Validates the prefix to prevent cross-adapter handle leakage.
- HookEventReceiver in this adapter is the canonical-event end of the path; the HTTP receiver in `src/monitoring/HookEventReceiver.ts` is the wire-protocol end. They wire together via the module-level `dispatchHookEvent` export. The full wiring is a Phase 3 follow-up.
- CredentialStorageProvider defaults to file-backed at `~/.instar/anthropic-credentials.json` (0600 permissions). A Keychain-backed wrapper is deferred — the abstraction supports it via `getBackend`/`setBackend` but only the file backend is wired in Phase 3a.

---

### 2026-05-15 — Phase 3b complete

Second concrete provider adapter (`anthropic-interactive-pool`) landed at `src/providers/adapters/anthropic-interactive-pool/`. Sister to 3a — same contracts, different transport: instead of one `claude -p` subprocess per call, this adapter maintains a pool of long-lived `claude` REPL sessions in tmux and routes work through them via prompt-injection + idle-marker completion detection. Post-2026-06-15 this is the path that bills against Max subscription rather than the Agent SDK credit pot.

- **Pool internals**: `pool.ts` manages N warm `claude` REPL sessions (default 2, `INSTAR_INTERACTIVE_POOL_SIZE`), allocate / release lifecycle, retire-and-replace, hard-kill-and-replace, observe state. `promptRunner.ts` injects a prompt and detects completion via the idle-marker + output-stability signals validated in the Phase 1 feasibility prototype.
- **Real implementations** for primitives the pool can directly serve: OneShotCompletion (allocate → inject → detect-complete → extract → release), WarmSessionInbox (the primary contract for this adapter — exposes pool sessions to external file-system message-queue callers), HardKill / InputInjection / Interrupt (pool-session control via tmux), LiveOutputStream (tmux capture-pane snapshot + tail), ProcessLifecycle (tmux list-panes for PID/RSS/alive), SessionId (handle ↔ Claude-UUID bridge — distinct from 3a since the UUID comes from REPL startup output rather than `claude -p` exit metadata), TimeoutBound / IdleBound / StopGateInterceptor (in-memory policy), AuthCredentialInjection (env-var routing into pool sessions), ContextScopeControl (--setting-sources flag mapping at session-spawn time), CompactionLifecycle (PreCompact hook with per-pool-session compacting marker).
- **Stubs** for primitives without active 3b consumers (throw UnsupportedCapabilityError): all capability primitives, StructuredOneShot, AgenticSession* (head/interactive/rpc), the asymmetric observability set (ConversationLogReader/Tailer, HookEventReceiver, SubagentLifecycleObserver, UsageMeterProvider, InteractivePromptObserver — those route to 3a today since they share the same underlying ~/.claude/projects log file), CredentialStorageProvider, IntelligenceCallQueue, all four integration primitives. The capability surface still declares them so the registry can find the adapter; the throw makes any premature use loud.
- **Smoke test** (`_smoketest.ts`, gated `INSTAR_REAL_API=1`): real-API run on 2026-05-15 passed — pool size 1 warm in 1019ms, "what is 2+2?" returned "4" in 10.7s through the REPL. Subscription billing path confirmed (no Agent SDK credit drawdown observed).
- **TypeScript verification**: `npx tsc --noEmit` passes across the full `src/providers/` tree (Phase 2 substrate + 3a adapter + 3b adapter) with zero errors.

### Phase 3b design notes

- The adapter is purely additive in Phase 3b — application code still uses `ClaudeCliIntelligenceProvider` and `SessionManager` directly. The refactor that wires both 3a and 3b into the application layer lands after 3c, gated on routing-policy implementation.
- SessionHandles issued by the adapter are formatted `anthropic-interactive-pool/<poolSessionId>`. The pool owns the underlying tmux session name; the handle is a stable bridge across pool recycling within a session's lifetime.
- LiveOutputStream reads from `tmux capture-pane` against the pool session's tmux window. The ANSI-strip + output-region extraction matches the 3a path so consumers can switch transparently.
- The asymmetric observability primitives are stubbed (not implemented in 3b) because the underlying source — `~/.claude/projects/<path>/<uuid>.jsonl` — is the same file that 3a's implementations read. A consumer needing those today gets routed to 3a via the registry. If a future pool-only deployment needs them, the 3a implementations should be hoistable with minor refactoring; deferred until that's a real requirement.
- The Phase 1 prototype validated up to ~360-byte responses, single-session pool, no tool use mid-response, no compaction. The Phase 3b smoke covers 1 prompt × 1 session. Pool concurrency, longer responses, tool-call mid-response, and compaction recovery are Phase 3c gates (behavior-parity suite).

---

### 2026-05-15 — Phase 3c complete

Behavior-parity test harness for paired adapters + pool-only stress tests landed. Phase 2 conformance suites verified single-adapter contract shape; Phase 3c goes one level deeper: given two adapters that claim the same capability, send identical inputs to both and assert observable equivalence. Catches drift between sibling adapters (3a vs 3b) where each correctly implements the primitive contract in isolation but their externally-observable behavior disagrees on edge cases.

- **Parity harness** at `src/providers/parity/`: `runner.ts` exposes `runParitySuite(harness, scenarios)` returning `ParityResult[]` plus `reportParityResults` (pretty-print + exit code). Scenarios are async functions taking a `ParityHarness` (left + right + ctx); ctx carries `realApi`, optional timeoutMs, optional skipPatterns. Adapter lifecycle managed by the runner (start/dispose called automatically). Scenarios run sequentially since concurrent execution against pool-backed adapters can cause queueing effects that confound parity comparisons.
- **Capability-overlap scenarios** (`scenarios/capabilityOverlap.ts`, structural-only): `distinctIds` (registry differentiation), `sharedCapabilitiesInstantiate` (every shared capability returns a non-null primitive on both sides). Excludes asymmetric sub-capability flags (`PublicUsageApi`, `PreCompactHook`, `SubagentLifecycleHooks`, `NativeIdleBound`, `StructuredApprovalEvents`) which are declarative markers, not retrievable primitives — they modify the behavior of OTHER primitives.
- **OneShotCompletion scenarios** (`scenarios/oneShotCompletion.ts`): `primitiveShape` (structural), `arithmeticParity` (realApi — both adapters answer "what is 2+2?" with text containing "4", both return non-empty trimmed string, both include `usage` field), `abortSignalParity` (realApi — both adapters surface AbortSignal cancellation as a thrown error rather than fabricating a response). Equivalence is structural (same shape, same digit) rather than literal string equality since LLM outputs aren't deterministic.
- **SessionId scenarios** (`scenarios/sessionId.ts`, structural-only): `shape` (providerIdFor + handleFor methods present, correct capability flag), `unknownHandle` (bogus handle either resolves to null or throws — never fabricates a UUID).
- **Runnable parity test** at `src/providers/parity/_paritytest.ts`: constructs anthropic-headless × anthropic-interactive-pool and runs all scenarios. `INSTAR_REAL_API=1 npx tsx src/providers/parity/_paritytest.ts` for full run; without the env var, structural scenarios run and real-API scenarios skip.
- **Pool stress tests** at `src/providers/adapters/anthropic-interactive-pool/_stresstest.ts`: three scenarios for 3b-only paths — `shutdownReleasesResources` (pool.status().sessions empty after dispose), `concurrentAllocation` (3 prompts to pool size 2, all correct), `retireAndReplace` (kill the only session mid-flight, verify pool replaces it and next prompt succeeds). Gated by `INSTAR_REAL_API=1` since every scenario spawns real `claude` REPLs and consumes subscription quota.
- **Verification**:
  - `npx tsc --noEmit` clean across the full `src/providers/` tree.
  - Structural-only parity run (realApi=false): 7 scenarios, 7 pass.
  - Real-API parity run (realApi=true) on 2026-05-15: 7 scenarios, 7 pass. Both adapters returned text containing "4" for the arithmetic prompt within timeout; both honored AbortSignal cancellation by throwing rather than resolving with a fabricated response. **Behavior-equivalence between 3a and 3b empirically verified.**

### Phase 3c design notes

- Parity scenarios assert structural equivalence (same error class category, same response shape, presence of required fields) rather than literal output equality. LLM outputs are non-deterministic, so byte-equality is the wrong target; the target is "both adapters honor the same contract observably."
- Real-API scenarios are gated to keep CI cheap and to avoid burning subscription quota on every test run. The pattern matches the Phase 3a/3b smoke tests (`INSTAR_REAL_API=1`).
- The 3c parity surface is intentionally minimal — it covers the primitives that the application layer will route to (OneShotCompletion, SessionId) plus the capability declaration surface. As the application-layer refactor wires the adapters in for real, more scenarios (LiveOutputStream tail equivalence, ProcessLifecycle alive/dead semantics, HookEventReceiver canonical-event normalization) get added incrementally — scenarios accumulate without changing the harness shape.

---

### 2026-05-15 — Rule 2 violation cleanup (pre-Phase-4 hardening)

After the path constraints were locked (Rule 1 + Rule 2), a read-only sweep of all Anthropic-touching code surfaced three direct-API violations. All three are removed in this batch; the v1.0.0 substrate now has no raw `api.anthropic.com` calls on routine inference paths.

- **`AnthropicIntelligenceProvider` deleted.** The class made direct fetch calls to the Messages API as an alternate IntelligenceProvider implementation, opt-in via `intelligenceProvider: "anthropic-api"` in config. The class is removed entirely; the `"anthropic-api"` config field is no longer honored (stale configs get a one-time warning at startup pointing at `specs/provider-portability/04-anthropic-path-constraints.md`). All shared intelligence wiring in `server.ts` now defaults to `ClaudeCliIntelligenceProvider` unconditionally. Touches: `src/core/AnthropicIntelligenceProvider.ts` (deleted), `src/index.ts`, `src/commands/server.ts`, `src/commands/reflect.ts`, plus surface labels in `FeatureRegistry.ts`, `FeatureDefinitions.ts`, `SurfacingTemplates.ts`, `CapabilityRegistryGenerator.ts`, `models.ts`, `ClaudeCliIntelligenceProvider.ts`.
- **`CoherenceReviewer.callApi()` direct-API branch removed.** The base reviewer class previously fell back to its own `fetch(ANTHROPIC_API_URL)` path when no IntelligenceProvider was injected. That fallback is gone; `callApi()` now routes exclusively through `this.intelligence` and throws a descriptive error pointing at the spec doc if the provider is missing. The 12 reviewer subclass constructors still take an unused `apiKey` parameter — a follow-up task is queued to remove that mechanical scar.
- **`StallTriageNurse.callAnthropicApi()` deleted.** The most cost-impactful violation: stall triage runs continuously over autonomous sessions, and each triage call hit the unsubscribed API path at full rates when the IntelligenceProvider was missing or `useIntelligenceProvider` was false. The method is gone; `diagnose()` routes exclusively through `this.intelligence`. The `apiKey`, `apiTimeoutMs`, and `useIntelligenceProvider` config fields are removed from `StallTriageConfig` (existing configs with these fields will see them silently ignored — `apiKey` was always env-fallback-only, the other two are now unconditional). Process-tree and heuristic fallbacks inside `diagnose()` are preserved as the substrate's degradation strategy.

### Verification

- `npx tsc --noEmit` clean across the full source tree after each violation fix.
- Stricter grep (`fetch.*anthropic\.com`, `fetch(ANTHROPIC_API`, `messages.create(`, `new Anthropic(`) against `src/` excluding `src/providers/` and the legitimate `QuotaCollector` OAuth exception: zero matches.
- The remaining `api.anthropic.com` string hits are documentation comments (in `CoherenceReviewer.ts`'s replacement docstring and `CapabilityRegistryGenerator.ts`'s tool-platform descriptor), not active code paths.
- `QuotaCollector` continues to hit `api.anthropic.com/api/oauth/usage` — the read-only, fixed-cost exception permitted by Rule 2.

### Follow-up queued

The 12 reviewer subclasses still take an unused `apiKey` parameter through their constructors; the parameter is now dead weight. A mechanical pass to remove the parameter from the base class and every subclass constructor is queued (task #8 in this session's task list).

---

### 2026-05-15 — Substrate correctness fixes (audit Tier 1)

Four real correctness bugs found by the pre-Phase-4 audit are fixed. Each had unit-test coverage added; the existing real-API smoke and parity tests continue to pass.

- **Idle-marker false-positive on response content** (`promptRunner.ts`). The completion detector previously called `buf.includes(marker)` against the whole pane buffer using static UI strings (`"? for shortcuts"`, etc.) as markers. Those strings are in the status bar at all times — they don't distinguish generating from idle, so stability was carrying the whole signal and a brief mid-generation stall could fire completion. Worse, a response that legitimately contained a marker substring (e.g., a model asked to talk about Claude keyboard shortcuts) would also match, returning partial output as success — worst-class silent data corruption. Replaced with a structural detector: walk the buffer from the bottom up, find the most recent `❯` line, return true only if it's empty. The empty `❯` is Claude Code's UI "your turn again" cue and only appears after a response completes. 8 unit tests cover the false-positive case directly, including the audit-cited example.
- **Pool decays silently on spawn failure** (`pool.ts`). When a session was retired and the replacement spawn failed (claude binary moved, OAuth expired, ENOMEM, weekly limit hit), the previous behavior was `.catch(console.error)` — error logged, dropped. The pool decayed invisibly. Replaced with an observable retry mechanism: emits `pool:degraded` on failure with attempt number, schedules exponential-backoff retries up to MAX_REPLACEMENT_ATTEMPTS = 5, emits `pool:healed` on recovery or `pool:degraded_persistent` after final exhaustion. All pending retry timers cleared on shutdown. Routing policy in Phase 5 can observe pool health and fall back to the SDK-credit path when the pool is degraded. 3 unit tests cover happy retry, exhaustion, and shutdown safety.
- **Failed prompts return poisoned sessions** (`transport/oneShotCompletion.ts`). When `runPrompt` threw (timeout/abort/exec failure), the surrounding `finally` released the session back to ready. The underlying REPL could be wedged with a partial prompt in the input buffer or still streaming a response from a failed send-keys — the next allocate would hand out a poisoned session that returned residual pane content as if it were the new response. Worst-class silent data corruption: caller sees success, gets garbage. Fixed with a `healthy` flag set true only after `runPrompt` returns. On true → `pool.release(session)`; on false → `pool.retire(session)` (which now also benefits from the retry-with-backoff path from the previous fix). 3 unit tests cover release-on-success, retire-on-throw, and retire-on-abort.
- **Capability-declaration honesty** (`markers.ts`, both adapter `capabilities.ts` + `index.ts`, `parity/scenarios/capabilityOverlap.ts`). The parity check `sharedCapabilitiesInstantiate` previously treated any non-null primitive as success, so an adapter could claim a capability via `capabilities.ts` while wiring a throwing stub in `index.ts` and the test would silently pass. Introduced `STUB_MARKER` Symbol attached to all stub-factory output and `isStubPrimitive(impl)` helper. Updated the parity check to detect three cases on each shared capability: both-real (proper check), both-stub (acceptable), or mixed (FAIL with adapter-name detail). Then trimmed both adapters' capability declarations to honest sets: pool removes ~17 stub-only declarations, headless removes 6. The registry's `candidates(cap)` now returns the honest set of adapters that can actually serve a capability — Phase 5 routing policy can rely on it without probing for stubs. 6 unit tests cover the marker system; 7/7 parity scenarios pass against real API.

### Verification

- `npx tsc --noEmit` clean across the full src/providers/ tree after each fix.
- 20 new unit tests across 4 files; all pass.
- Real-API smoke test re-runs cleanly after each adapter fix.
- Real-API parity (7 scenarios): all pass, including arithmetic and abort-signal scenarios — behavior equivalence between 3a and 3b unaffected by the substrate hardening.

---

### 2026-05-15 — Rule 3 enforcement: canary self-healing + scheduled drift detection + persistence + LLM fallback

Built out the operational infrastructure for Rule 3 (state-detection robustness) on the empty-prompt detector — the most fragile state-check in the substrate. The canary now runs at pool spawn AND on a scheduled interval (default hourly), self-heals signature drift across process restarts via on-disk persistence, and has an optional LLM fallback for unrecoverable structural changes.

- **Persistence** (`canary/emptyPromptSignature.ts`). Canary-derived signatures are written to `~/.instar/providers/anthropic-interactive-pool/empty-prompt-signature.json` (override via `INSTAR_PROVIDER_STATE_DIR`). Schema v1; regex patterns serialized as `.source` strings. Lazy load on first `getSignature()`, fall back to default on any failure (file absent, JSON corrupt, schema mismatch, regex uncompilable). 7 unit tests cover the load/save round-trip and every failure mode.
- **Scheduled recurring canary** (`pool.ts`). Added `canaryIntervalMs` config (default 1 hour, env override `INTERACTIVE_POOL_CANARY_INTERVAL_MS`, 0 disables). Each tick allocates a ready session, runs the canary, releases. Re-entrancy guarded by `scheduledCanaryInFlight` lock. Timer is `unref()`ed so it doesn't keep the process alive on its own. Cleared on shutdown.
- **Optional LLM fallback** (`canary/emptyPromptCanary.ts`). When deterministic structural re-derivation can't extract a signature from the canary's after-buffer, an optional `llmFallback` callback can verify whether the pane indicates idle. New result status `'llm-confirmed'` joins `'pass' | 'self-healed' | 'fail'`. The fallback fires only when re-derivation has already exhausted; cost on stable upstream is zero. The application-layer wiring (passing a real `IntelligenceProvider.evaluate()` callback into the pool config) is queued — substrate is ready. 5 unit tests cover all four fallback paths.
- **State-detector registry** (`specs/provider-portability/06-state-detector-registry.md`). New living document listing every place Instar reads external state, with Rule 3 compliance status flags (✅ Compliant / 🟡 Partial / ❌ Missing / 🔵 Exempt). 16 seed entries; the empty-prompt detector is the only 🟡 (canary present, schedule/persistence/LLM-fallback now landed — re-classifies to ✅ after follow-up #17 wires the LLM). Every new state-detection PR adds a row in the same commits. Phase 4 Codex adapter inherits the structure.
- **Conformance behavior assertions** (`tests/integration/conformance/oneShotCompletion.conformance.test.ts`). First concrete replacement for the no-op stub assertions in the Phase 2 conformance framework. Parameterizes over both Anthropic adapters; 3 structural assertions always run, 2 behavior assertions gated by `INSTAR_REAL_API=1`. Establishes the pattern for the remaining 50 primitives (queued as follow-up).

### Verification

- `npx tsc --noEmit` clean throughout all commits.
- 31 new unit tests across the canary infrastructure all pass.
- Real-API smoke runs three times in a row, all pass: pool ready in ~21s (includes 20s canary), prompt round-trip 7-9s.
- Conformance template's structural tests pass without real API.

### Follow-ups queued in the task list

- #17: Wire the canary LLM fallback into the pool's spawnOne / runScheduledCanary callers (threads `IntelligenceProvider.evaluate()` through pool config).
- #18: Populate the remaining 50 conformance suites with real behavior assertions using the template established here.
- #8: Remove the now-unused `apiKey` parameter from the 12 CoherenceReviewer subclass constructors (mechanical refactor, ~13 files).

---

### 2026-05-15 — Rule 3 finish-up: per-detector rationale, two more canaries, commit-time gate

Scope-coherence review against the locked Rule 3 spec surfaced three pieces of drift between the spec and what had actually shipped. All four pieces (rationale doc + two canaries + commit-time gate) now landed.

- **Per-detector rationale appendix** (`specs/provider-portability/07-detector-rationale.md`). Required by Rule 3.1: every state-check carries a one-paragraph rationale covering criticality, frequency, stability, fallback, and verdict (deterministic vs. LLM vs. canary-gated). Eleven seed rationales — one per substrate detector and one per application-layer state-check. Rule 3.1 RATIONALE doc-comment template defined; the commit-time check (below) grep-enforces it.
- **Pool decay canary** (`src/providers/adapters/anthropic-interactive-pool/canary/poolDecayCanary.ts`). Verifies the silent-decay fix from the audit Tier 1 batch can't regress: instantiates a pool with a deliberately broken tmux binary, asserts the pool emits `degraded` → retries with backoff → emits `degraded_persistent` after exhaustion. Internal-contract canary (not drift-detection), so it lives forever as a regression guard. 2 unit tests.
- **Capability-honesty canary** (`src/providers/canary/capabilityHonestyCanary.ts`). Verifies the STUB_MARKER Bug-D fix from the audit Tier 1 batch can't regress: pulls both Anthropic adapters' `createStubPrimitive` factories, asserts each result is detected as a stub through `isStubPrimitive`, asserts a real-shape primitive is NOT flagged, asserts the canonical `Symbol.for('@instar/providers/stub')` identity matches across both adapters. Catches "future stub-factory refactor forgets the marker" — the regression that would silently re-grant adapters the ability to lie about capabilities. 2 unit tests.
- **Commit-time Rule 3 coverage gate** (`scripts/check-rule3-coverage.cjs`, `.husky/pre-commit`). Pre-commit script scans the staged diff for state-detection patterns (`fetch()` to Anthropic / OpenAI / Slack / Telegram, tmux `capture-pane` / `send-keys`, `JSON.parse(...stdout)`, `class *Reader/*Tailer/*Observer/*Receiver/*Parser` in `src/`) and **blocks the commit** unless each touched file has either a Rule 3.1 RATIONALE comment + a canary file staged alongside, OR a registry entry in `06-state-detector-registry.md`, OR an explicit `RULE 3: EXEMPT — <reason>` marker. Structural enforcement of the "keep awareness of what hasn't been updated yet" directive — new state-detection code can't land without registering. Signal-only, not authority: false positives are remediated with the EXEMPT marker, false negatives are the trade-off accepted against silent-corruption bugs. 8 unit tests cover pass/block paths, exempt marker, rationale-only / canary-only blocks, *Reader class trigger, test-file exclusion.
- **Registry updates** (`specs/provider-portability/06-state-detector-registry.md`). Two new rows for the canaries that landed (pool decay handler, STUB_MARKER reader), both ✅ Compliant. Audit-sweep procedure section restructured into per-commit (automated) and per-milestone (manual) layers.

### Verification

- `npx vitest run` — all 12 new tests pass alongside the existing 31 from the prior Rule 3 batch.
- Pre-commit hook fires on every commit in this batch; the gate flagged nothing (canary files and rationale comments already in place).

---

### 2026-05-15 — Phase 4: OpenAI Codex adapter — CODE COMPLETE, REAL-API VERIFICATION PENDING

**Status correction (2026-05-15, same day):** I initially recorded this as "Phase 4 complete" but Justin caught that the acceptance evidence was structural-only — TypeScript compile clean, 7/7 structural parity scenarios pass, 11 unit tests pass — with zero successful real-API calls against Codex. Per the new [phase-acceptance discipline](#2026-05-15--phase-acceptance-gate-machine-checkable-verification-manifest) (see entry below), a phase is not complete until every real-API gate in its acceptance manifest has been observed passing. Phase 4 is in `CODE COMPLETE` state — the substrate proves it CAN abstract Codex on paper, but the empirical proof that it DOES abstract Codex correctly awaits a real-API smoke pass.

First non-Anthropic adapter landed at `src/providers/adapters/openai-codex/`. Once the acceptance gate clears, this will be the definitive evidence that Phase 2's interfaces aren't accidentally Anthropic-shaped.

- **40 files, ~2,200 lines.** Mirrors the anthropic-headless adapter's directory layout (transport/capability/observability/control/integration/canary). Compiles clean under the existing `tsconfig.json` without any substrate code changes — the Phase 4 acceptance test is that a new provider plugs in by writing only adapter code, and that test passes.
- **30 of 36 universal primitives implemented.** Transport (3: oneShotCompletion via `codex exec --output-last-message`, structuredOneShot via `--output-schema` with caller-side validate, agenticSessionHeadless via `codex exec --json` in tmux). Capability (6: toolAccess/Allowlist, fileSystemAccess with all 3 sandbox tiers native, pathAllowlist with deny-rule support, bashExecution with sandboxModes=true, webAccess). Observability (9: liveOutputStream, conversationLogReader+Tailer reading rollout JSONL from $CODEX_HOME/sessions/YYYY/MM/DD/, hookEventReceiver for 5 Codex-supported event kinds, subagentLifecycleObserver synthesized from app-server notifications, sessionId binding UUIDv7 threads, usageMeterProvider with local accounting since Codex has no public usage endpoint, processLifecycle, interactivePromptObserver with source='structured'). Control (10). Integration (4).
- **Honest capability declarations.** `capabilities.ts` declares only what's actually implemented — declared-but-stubbed counts as a lie under Rule 3.2 / the parity harness's stub-vs-real check. Asymmetric flags per the deep-dive: StructuredApprovalEvents=true (Codex's app-server emits structured approval events); PublicUsageApi=false (no documented usage endpoint); PreCompactHook=false (Codex auto-compacts silently — adapter synthesizes a notice at 85% of assumed 200k window); SubagentLifecycleHooks=false (no native subagent events — adapter synthesizes from app-server thread/started|closed); NativeIdleBound=false.
- **Rule 3 canaries.** `codexEventNormalizerCanary` — critical-severity, asserts the 8 known Codex JSONL event types map to expected CanonicalEvent shapes against fixtures captured 2026-05-15 on Codex CLI 0.130.0, surfaces unknown types via provider-raw escape hatch rather than dropping silently. `codexSessionLayoutCanary` — high-severity, writes synthetic rollout under temp $CODEX_HOME and verifies discovery via findRolloutFile / listAllRollouts. Self-heal is not applicable for enum-shape or layout-shape mismatches; failures surface via DegradationReporter (ECHO-only) and the remediation path is a code fix.
- **Capability-honesty canary extension.** `src/providers/canary/capabilityHonestyCanary.ts` now covers all three adapter stub factories (anthropic-headless, anthropic-interactive-pool, openai-codex). Adding a fourth adapter in the future will require extending this canary in the same commit per Rule 3 enforcement.
- **Codex × Anthropic parity test** at `src/providers/parity/_codex_paritytest.ts`. Runs the full Phase 3c scenario set (capabilityOverlap, oneShotCompletion, sessionId) against anthropic-headless × openai-codex. **Structural set: 7 of 7 scenarios pass** (no realApi required). This is the definitive Phase 4 acceptance signal. Real-API scenarios skip without `INSTAR_REAL_API=1` AND working Codex credentials.
- **Smoke test** at `src/providers/adapters/openai-codex/_smoketest.ts`. Gated on credential availability (OPENAI_API_KEY env or valid OAuth in ~/.codex/auth.json). In dev environments without credentials it prints "skipped"; when credentials are present but rejected by Codex (subscription lapsed, OAuth expired), it prints "AUTH-BLOCKED" rather than failing — distinguishing real adapter failure from dev-environment auth state. Real-API verification awaits a credential refresh.
- **Registry rows added** for all 8 Codex-side state-detection surfaces in `06-state-detector-registry.md`. Audit-sweep procedure already covers Codex via the commit-time `check-rule3-coverage.cjs` script (no changes needed — same pattern set applies). Phase 4 Codex adapter inherits the structure exactly as `00-phase-2-plan.md` promised.

### Verification

- `npx tsc --noEmit` clean across the new adapter and all callers.
- 11 new unit tests pass (3 canary tests + 8 normalizer edge-case tests, plus the capability-honesty canary still passes after extension).
- Structural parity: 7 scenarios, 7 pass.
- Pre-existing test-pollution bug between `emptyPromptSignaturePersistence.test.ts` and `promptRunner.test.ts` surfaces 4 failures when running the full `tests/unit/providers/` suite (each file passes individually). Confirmed unrelated to this batch by stashing all Phase 4 work and reproducing on HEAD. Filed as a follow-up.

### Optional primitives (deferred)

The deep-dive named 15 Codex-only optional primitives (threadFork, threadRollback, threadGoalSlot, profileSwitcher, customModelProvider, shellEnvironmentPolicy, otelExporter, complianceApi, pluginRegistry, trustedProjectGate, filesystemRpc, processSpawn, capabilityNegotiation, notificationOptOut, codeReviewPreset, csvBatchMode, selfUpdate, requirementsToml). None gate the parity test; they're high-value but Phase 5+ work because the cost-aware routing policy is the next critical-path item.

### Follow-ups queued in the task list

- #24: Fix the test-pollution bug between `emptyPromptSignaturePersistence.test.ts` and `promptRunner.test.ts` — refactor `statusBarHasIdleMarker` to accept the signature as a parameter rather than reading module-level state.
- #17: Wire canary LLM fallback into the pool application layer (carry-over).
- #18: Populate remaining 50 conformance suites with real behavior assertions (carry-over).

---

## What's next

Per `specs/provider-portability/README.md` the remaining phase sequence is:

- **Phase 4 — OpenAI Codex adapter.** First non-Anthropic adapter. Implements the same primitive surface as 3a/3b using `codex exec`, app-server JSON-RPC, and the Codex hook system. Smoke + parity test against 3a once landed.
- **Phase 5 — Cost-aware routing policy.** Concrete `RoutingPolicy` implementation: drain Agent SDK credit first (UsageMeterProvider's `agentSdkCredit` field), fall back to interactive pool below a configurable safety margin, route capability-asymmetric work to whichever adapter claims the capability. This is also where the application-layer refactor lands: replace direct `ClaudeCliIntelligenceProvider` / `SessionManager` callsites with `registry.resolve()`, re-express `IntelligenceProvider` in `src/core/types.ts` as a thin wrapper over `OneShotCompletion`.
- **Phase 6 — Open-source / local adapter.** Evaluate Aider / Open-Interpreter / Continue.dev as the substrate for self-hosted models rather than building an Ollama adapter from scratch.
- **Phase 7 — Migration design + local agent testing.** Migration script (`.claude/` → `.agent/anthropic/`, `claudeSessionId` → `providerSessionId`, `CLAUDE.md` → `AGENT.md` alias). Tested on multiple local agents before release: snapshot → migrate → snapshot → diff for unexpected losses → verify jobs + Telegram + threadline still work.
- **Phase 8 — v1.0.0 release.** Cut once Phase 7 testing is clean across the test-agent set.

---

## 2026-05-18 — v1.0.0 release prep cycle (Phases A+B+6+7 closure + sentinel cross-port)

This is the final cycle before v1.0.0 cuts. Closes the seven remaining work items called out in the prior regroup.

### Track A+B — Codex Rule 1 (spec 12) enforcement

- **Phase A defaults.** `OpenAiCodexConfig.apiKey` is now `@deprecated` + `@internal`. `configFromEnv` no longer reads `OPENAI_API_KEY` into config. Adapter init runs `credentials.checkAndWarn` which emits a structured warning + `.instar/security.jsonl` telemetry when API-key auth is detected (env var OR auth.json shape). Default behavior is warning-only — existing installs that have `OPENAI_API_KEY` set don't break the moment they upgrade.
- **Phase B opt-in.** Setting `INSTAR_RULE1_ENFORCE=hard` makes adapter construction throw `AuthError` instead of warning. Lets deployments lock the rule down early.
- **Escape hatch + sunset.** `INSTAR_DISABLE_RULE1_OPENAI=1` suppresses the warning until the hardcoded sunset `RULE1_KILLSWITCH_SUNSET_DATE = '2026-12-01'`. After that date the escape hatch is ignored regardless.
- **Drift CI gate.** New `scripts/check-codex-rule1-drift.js` runs in `npm run lint`. Fails the build if `config.ts` regresses (stale "Agent SDK credit pot analog" comment, env-var read re-added, deprecation tags missing).
- 23 new unit tests + existing test suite green.

### Track C — Phase 6 local-model adapter via Codex CLI `--oss`

- **Passthrough not adapter.** Codex CLI's built-in `--oss --local-provider <p>` flags route to local Ollama or LM Studio. `frameworkSessionLaunch` builders gain `codexLocalProvider` option that emits the flags. `SessionManager.spawnSession` and `spawnInteractiveSession` forward the option.
- **Live verified** with `codex exec --oss --local-provider ollama --model llama3.2:latest --json --skip-git-repo-check -s read-only`. Same `thread.started` → `turn.started` → `item.completed` → `turn.completed` event sequence the existing event normalizer already consumes.
- **Recipe doc** at `docs/local-model-recipe.md`. Fitness catalog entry at `specs/provider-portability/08-model-fitness-catalog.md` § "Local-model adapter via Codex CLI (Phase 6 path)".

### Track D — Phase 7 migration entry

- **`PostUpdateMigrator.migrateProviderPortability`** records `provider-portability-v1.0.0-<ISO>` in `_instar_migrations` on first `instar update` after v1.0.0 ships. Idempotent (re-runs are no-ops). Surfaces detected Codex CLI path in the upgrade message. Does NOT silently flip framework defaults — operators opt in via `/route` or `topicFrameworks` config.

### Track E — Sentinel + monitoring cross-port

- **InstructionsVerifier** — `framework?: 'claude-code' | 'codex-cli'` field. Default expected pattern resolves per-framework (CLAUDE.md vs AGENTS.md). When framework is unset, accepts either (migration-safe).
- **PromptGate** — confirmation pattern now detects both `Esc to cancel` (Claude) and `Ctrl+C to cancel` / `Press Ctrl-C to cancel` (Codex). LLM gate prompt extended to mention Codex's UI tokens (`Update Plan`, `Step N`, `>` prompt, `Apply patch?`).
- **Lifeline doctor session** — framework-aware refusal. For codex-cli framework, throws a typed error explaining the gap; recovery falls back to circuit-breaker reset. The doctor's Claude-specific `--message -` stdin + `--allowedTools` have no direct Codex equivalent; cross-port deferred to v1.1+.
- **Setup wizard** — explicitly Claude-only by design. Claude Code's skill system is upstream territory; future Codex-only setup wizard requires its own design pass.

### Track F — Verification on deep-signal

- **Branch installed** to deep-signal's shadow-install. Server restarted on the new code (uptime baseline).
- **12/12 v1.0.0 scenarios green** via injection mode against updated deep-signal.
- **Live Codex spawn round-trip** verified — `/sessions/spawn` with `framework: codex-cli, model: balanced` succeeded end-to-end on deep-signal.
- Real-Telegram-loop verification requires provisioning a separate driver bot (current `--via-telegram` mode requires a non-target bot in the target's chat). The polling-health scenario (#11) covers the network leg without that dependency.

### What "v1.0.0" means in this release

- All hot-path callsites work for both Claude Code and Codex CLI agents.
- Local model adapter works via Codex CLI passthrough; Ollama smoke verified.
- Existing installs upgrade safely (Phase A warning, no behavior change).
- Lifecycle migrator records the version transition.
- Sentinels detect both frameworks' UI patterns.
- Drift CI gate prevents config regression.

### What's NOT in v1.0.0 (documented residuals)

- Lifeline doctor session under Codex (framework-guarded refusal, falls back to circuit-breaker reset).
- Setup wizard under Codex (Claude Code skill system is upstream; documented as future work).
- `OPENAI_BASE_URL` first-observation approval flow with HMAC binding per spec 12 § "First-observation user confirmation" (passthrough works; the structured-approval gate is a Phase A+ defensive feature for compromised-shell-rc scenarios).
- Real-Telegram driver-bot provisioning (requires Justin to create a second Telegram bot account; documented in the test-driver README).
