# State-Detector Registry — Rule 3 Coverage Tracker

**Status:** Active, living document
**Purpose:** Track every place Instar reads state from an external system, with Rule 3 compliance status. The source of truth for "where coverage is" and "what's left."

---

## How this document works

Every place Instar reads state from something it doesn't control — Claude Code's terminal output, conversation logs, hook payloads, OS process state, third-party APIs, future provider adapters — is one row in this registry. Each row tracks:

- **Location:** file path + brief description of the check
- **Upstream:** what system / surface is being read
- **Criticality:** how bad is a wrong answer (silent corruption vs. minor degradation)
- **Frequency:** per-prompt / per-hour / per-session / startup-only
- **Stability:** how often does the upstream actually change shape
- **Canary status:** has a Rule 3.2 canary been built for this check?
- **Self-heal:** does the canary self-heal on drift, or only detect?
- **E2E test:** is there a real-upstream test gating merges to this code?
- **Notes:** action items, follow-ups, design tradeoffs

The registry is updated:
- **On every new state-detection PR** — adding a row is part of the PR's required scope, alongside the canary and e2e test.
- **On every Rule 3 retrofit** — when an existing entry's status changes (canary added, self-heal added, etc.), the row is updated in the same PR.
- **On every audit sweep** — periodic scans of the codebase looking for state-detection patterns that aren't in the registry. New entries created from sweep findings.

The point: coverage grows over time and is visible. A glance at this file tells the next contributor what's covered and what's not. Justin's framing 2026-05-15: "keep awareness of what hasn't been updated yet, so coverage grows over time rather than the rule being applied only to new code."

---

## Compliance status legend

- ✅ **Compliant** — canary present, self-heals on drift, e2e test against real upstream gated by `INSTAR_REAL_API=1`.
- 🟡 **Partial** — some Rule 3 pieces in place (e.g., canary detects but doesn't self-heal, or unit-test only with no real-upstream e2e).
- ❌ **Missing** — no Rule 3 infrastructure. Has a unit test (maybe) but no canary, no self-heal, no e2e against real upstream.
- 🔵 **Exempt** — read-only / fixed-cost / stable-upstream — Rule 3 documentation present but canary not required. Justified per-row in Notes.

---

## Registry

### Provider substrate (`src/providers/`)

| Location | Upstream | Criticality | Frequency | Stability | Canary | Self-heal | E2E | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|
| `adapters/anthropic-interactive-pool/promptRunner.ts` — empty-prompt completion detector | Claude Code TUI prompt glyph | Critical (silent corruption) | per-prompt | Unstable | ✅ startup + scheduled (default hourly) | ✅ re-derives from canary output; persists across restarts; optional Haiku fallback when re-derivation fails | ✅ smoke + unit-test coverage | 🟡 Partial | Application-layer wiring of the LLM fallback into pool callers is queued (task #17). Once that lands, this row flips to ✅ Compliant. Canary infrastructure itself is complete. |
| `adapters/anthropic-headless/observability/conversationLogReader.ts` — parses `~/.claude/projects/.../jsonl` | Claude conversation log format | High (degraded triage / resume) | per-session-end | Semi-stable (Anthropic changes schema occasionally) | ❌ | ❌ | ❌ | ❌ Missing | Audit follow-up: build canary that writes a known event via hook, reads back through this primitive, verifies schema interpretation. |
| `adapters/anthropic-headless/observability/conversationLogTailer.ts` — real-time tail of same JSONL | Claude conversation log format | High (stall detection) | per-second polling | Semi-stable | ❌ | ❌ | ❌ | ❌ Missing | Same canary as Reader can verify Tailer's incremental parsing too. |
| `adapters/anthropic-headless/observability/hookEventReceiver.ts` — parses Claude Code hook event payloads | Claude Code hook event schema | Critical (subagent lifecycle, compaction signal) | per-event | Unstable (Anthropic adds hook types) | ❌ | ❌ | ❌ | ❌ Missing | Highest-leverage retrofit candidate after empty-prompt. Canary should spawn a session that fires each known event type and verify each is parsed correctly. |
| `adapters/anthropic-headless/observability/usageMeterProvider.ts` — Anthropic OAuth `/api/oauth/usage` | Anthropic OAuth API response schema | High (cost-routing input) | per-poll (5-60min) | Semi-stable (read-only API) | ❌ | ❌ | ❌ | ❌ Missing | Read-only API endpoint, lower drift risk than UI parsing. Canary: fetch and assert returned-shape fields present. |
| `adapters/anthropic-headless/observability/sessionId.ts` — Claude session UUID from JSONL filename | Claude session ID format | High (resume continuity) | per-session-start | Stable | ❌ | ❌ | ❌ | ❌ Missing | UUID format stable; canary could verify match against a freshly-spawned session's filename. |
| `adapters/anthropic-headless/observability/subagentLifecycleObserver.ts` — filters hook events for SubagentStart/Stop | Claude hook event types | High (autonomous-loop accuracy) | per-event | Unstable (depends on hook event canary above) | ❌ | ❌ | ❌ | ❌ Missing | Verified transitively by hookEventReceiver canary when that lands. |
| `adapters/anthropic-headless/observability/processLifecycle.ts` — tmux `list-panes` output for PID/RSS | tmux output format | Medium (process health) | per-check | Stable | ❌ | ❌ | ❌ | ❌ Missing | OS-level — slow drift. Canary required but cadence weekly, not hourly. |
| `adapters/anthropic-headless/observability/liveOutputStream.ts` — tmux `capture-pane` output | tmux capture-pane format | Medium (output observability) | per-call | Stable | ❌ | ❌ | ❌ | ❌ Missing | Same family as ProcessLifecycle — OS-level, low drift. |
| `adapters/anthropic-interactive-pool/pool.ts` — `waitForReady` static idle-marker detector | Claude Code TUI status bar strings | Medium (pool boot signal) | per-spawn | Unstable | ❌ | ❌ | ❌ | ❌ Missing | Same drift class as the empty-prompt detector. Should consume the same canary-derived signature once that infrastructure exists more generically. |
| `adapters/anthropic-interactive-pool/promptRunner.ts` — extractResponse marker grammar (`❯`, `⏺`, `✻`) | Claude Code TUI response framing | Critical (response-text extraction) | per-prompt | Unstable | ❌ | ❌ | ❌ | ❌ Missing | The OTHER side of the empty-prompt detector. Same drift risk; should derive markers from the canary's known input/output too. |
| `adapters/anthropic-interactive-pool/pool.ts` — degraded/replacement decay handler (spawn-failure recovery path) | Internal contract: own emitter API + retry policy | Critical (silent pool drain on spawn failures) | per-replacement-failure | Stable (own code) | ✅ startup canary (`canary/poolDecayCanary.ts`) | ✅ deterministic — exercises the failure path with a known-bad binary and verifies events + retry math | ✅ unit-test gates the canary itself | ✅ Compliant | Verifies the decay/heal event contract and exponential-backoff retry policy stay intact across refactors. Internal contract, so canary lives forever as a regression guard rather than a drift detector. |
| `core/codexHookArm.ts` — `makeTmuxTrustDriver` capture-pane match for the Codex "Trust all and continue" prompt | Codex CLI TUI trust prompt strings | Low (best-effort gate, NOT authoritative — see Notes) | per-arm (install/migrate, idempotent-skipped when already armed) | Unstable | 🟡 G5 runtime arming canary planned (spec §7) | ✅ fail-safe: drift → no keys sent → config.toml readback reports `partial`, never silent corruption | ✅ orchestration unit-tested (`codexHookArm.test.ts`); driver via test-as-self | 🟡 Partial | The capture-pane only gates WHEN to send keystrokes. AUTHORITATIVE state = the config.toml `[hooks.state]` trust readback (`codexHookTrust.codexHooksArmingStatus`), robust line-based config parse, not TUI scraping. G5 runtime canary (drive `rm -rf` → assert block) is the prompt-drift detector, tracked under codex-full-parity. |
| `providers/adapters/anthropic-headless/control/authCredentialInjection.ts` — credential-validity probe (4-token Messages-API ping) | Anthropic Messages API HTTP status semantics | Minor degradation (loud AuthError either way; probe is a pre-check, not the authority) | per-enrollment / per-verification (rare) | Very stable (official public API status codes) | 🔵 not required | n/a | ❌ | 🔵 Exempt | Deterministic status-code check via `mapApiError`; wrong verdict cannot be silent (downstream calls fail loudly with the same credential). Probe model config-overridable via `intelligence.pinnedModels.anthropicCredentialProbe` (2026-07-02). |
| `src/providers/markers.ts` — STUB_MARKER capability-honesty Symbol + `isStubPrimitive` reader | Internal contract: stub-vs-real adapter declaration | Critical (lying-adapter prevention; missed marker = parity test silently passes mocked stubs) | parity-test runs (transitive) | Very stable (Symbol.for identity) | ✅ startup canary (`canary/capabilityHonestyCanary.ts`) | ✅ deterministic — re-derives Symbol identity, fails loud if either adapter's `createStubPrimitive` forgets the marker | ✅ unit-test gates the canary itself | ✅ Compliant | Real risk is a future stub-factory refactor forgetting to attach the marker. Canary catches that regression at startup, before parity tests would silently lie. |

### Application layer (`src/core/`, `src/monitoring/`, `src/threadline/`)

| Location | Upstream | Criticality | Frequency | Stability | Canary | Self-heal | E2E | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|
| `monitoring/QuotaCollector.ts` — Anthropic OAuth `/api/oauth/usage` | Anthropic OAuth API response | High (autonomous-loop pacing) | per-poll | Semi-stable | ❌ | ❌ | ❌ | ❌ Missing | Same upstream as the substrate's UsageMeterProvider — one canary should cover both. Reconcile after substrate refactor. |
| `monitoring/StallTriageNurse.ts` — heuristic terminal-output classification + LLM diagnose | Claude Code TUI output + hook events | High (autonomous recovery) | per-stalled-session | Unstable | ❌ | ❌ | 🟡 has integration tests against real APIs but no Rule-3 canary | ❌ Missing | Now routes through IntelligenceProvider after Rule 2 fix; the heuristic pre-filter still parses tmux output and is exactly the kind of pattern a canary must guard. |
| `core/SessionManager.ts` — tmux session liveness via `tmux has-session`, scrollback-cap heuristic | tmux exit codes + capture-pane | High (session health) | per-second polling | Stable | ❌ | ❌ | ❌ | ❌ Missing | OS-level, slow drift. Weekly canary cadence appropriate. |
| `messaging/TelegramAdapter.ts` — Telegram Bot API response parsing | Telegram Bot API response schema | High (relay correctness) | per-poll | Semi-stable | ❌ | ❌ | 🟡 covered by integration tests, no Rule-3 canary | ❌ Missing | Third-party API — Telegram does change schemas occasionally. Canary: fetch a known channel's info and assert response shape. |
| `core/InputClassifier.ts` — message intent classification via LLM | (no external state parse) | n/a | per-message | n/a | n/a | n/a | n/a | 🔵 Exempt | LLM-based, no deterministic parse of upstream state. |
| `core/InUseAccountResolver.ts` — parses `claude auth status` JSON for the agent's active account email | `claude auth status` JSON output | Low (display-only — drives a dashboard "in use" badge; nothing acts on the result) | per-poll (dashboard /in-use, cached 60s) | Semi-stable (stable-ish CLI status command) | ❌ — not warranted | ✅ fail-safe: any parse/spawn failure → `activeAccountId: null` (no badge), never throws, never blocks | ✅ unit + integration + e2e (`in-use-account-resolver`, `subscription-inuse-route`, `subscription-inuse-lifecycle`) | ✅ Compliant | Non-load-bearing display signal with a safe-to-null fallback, so no canary needed (Rule 3.1 verdict: deterministic + degrades-safely). If `claude auth status` JSON shape changes, the worst case is a missing badge, surfaced visually — not silent corruption. |

### Provider substrate (`src/providers/adapters/openai-codex/`) — Phase 4

| Location | Upstream | Criticality | Frequency | Stability | Canary | Self-heal | E2E | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|
| `adapters/openai-codex/observability/eventNormalizer.ts` — Codex JSONL event vocabulary | Codex CLI `--json` event-type names + payload shapes | Critical (silent data corruption if a new event type isn't recognized) | per-event (per-prompt during a session) | Unstable — Codex CLI minor versions add/change event types | ✅ startup canary at `canary/codexEventNormalizerCanary.ts` against fixtures captured 2026-05-15 on Codex 0.130.0; provider-raw escape hatch ensures unknown types are never dropped silently | ❌ — fail surfaces via DegradationReporter (ECHO-only); code fix is the remediation path | ✅ unit-test gates the canary itself | 🟡 Partial | Self-heal not applicable for an enum-shape mismatch. Hourly scheduled re-run is queued behind the parallel canary-interval wiring used by the empty-prompt detector. |
| `adapters/openai-codex/observability/sessionPaths.ts` — Codex rollout discovery (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`) | Codex session-file layout | High (drives conversationLogReader, conversationLogTailer, sessionResumeIndex) | per-read (per-resume, per-conversation-replay) | Semi-stable (Codex changes layout yearly cadence) | ✅ startup canary at `canary/codexSessionLayoutCanary.ts` — writes synthetic rollout, asserts findRolloutFile + listAllRollouts discover it | ❌ — fail surfaces via alert; code fix is the remediation path | ✅ unit-test gates the canary itself | ✅ Compliant | Synthetic-fixture verification, no LLM fallback needed. |
| `adapters/openai-codex/observability/conversationLogReader.ts` — parses Codex rollout JSONL | Codex rollout schema (shared with eventNormalizer) | High (degraded triage / resume) | per-session-end / per-replay | Semi-stable | ✅ transitively via eventNormalizer canary (shared normalizer code path) | ❌ | ✅ transitively | ✅ Compliant | Routes through the same event normalizer. Canary on the normalizer covers the reader. |
| `adapters/openai-codex/observability/conversationLogTailer.ts` — real-time tail of rollout JSONL | same as reader | High (stall detection) | per-second polling | Semi-stable | ✅ transitively (shared normalizer) | ❌ | ✅ transitively | ✅ Compliant | Same parser; same coverage. |
| `adapters/openai-codex/observability/usageMeterProvider.ts` — local accounting of `turn.completed.usage` | Codex usage-field schema | High (cost-routing input) | per-poll | Stable (local accounting won't drift; usage-field shape is what could) | ✅ transitively via eventNormalizer canary (asserts turn.completed parsing) | ❌ | ✅ transitively | ✅ Compliant | isAuthoritative=false; local-accumulation only since Codex has no public usage endpoint. |
| `adapters/openai-codex/control/compactionLifecycle.ts` — synthesized pre-compact notice from `turn.completed.usage.context_window_used` | Codex auto-compact threshold (`effective_window - 13k`) | High (resume continuity, sentinel-state persistence) | per-session | Semi-stable (Codex's threshold can change) | ❌ — pre-compact synthesis trigger has no canary yet | ❌ | ❌ | ❌ Missing | Add a canary that simulates the threshold cross and verifies notice fires. Phase 5 follow-up. |
| `adapters/openai-codex/observability/processLifecycle.ts` — tmux `list-panes` + ps for PID/RSS | tmux output + ps output | Medium (process health) | per-check | Stable | ❌ — OS-level, slow drift | ❌ | ❌ | ❌ Missing | Shared family with anthropic-headless processLifecycle; weekly canary cadence applies. |
| `adapters/openai-codex/observability/liveOutputStream.ts` — tmux capture-pane | tmux capture-pane format | Medium (output observability) | per-call | Stable | ❌ | ❌ | ❌ | ❌ Missing | Same family as ProcessLifecycle. |
| `providers/adapters/openai-codex/transport/codexSpawn.ts` — `buildCodexChildEnv()` env-allowlist enforcing Rule 1a from spec 12 | Internal contract — Codex CLI's preference of `OPENAI_API_KEY` over OAuth, and Instar's allowlist of inherited env vars | Critical (silent runaway billing if `OPENAI_API_KEY` leaks into child env) | per-spawn (every Codex child process) | Stable (own code; Codex CLI env-preference is the upstream surface, gated by the canary) | ✅ startup canary at `canary/openaiKeyLeakageCanary.ts` — sentinel-injects `OPENAI_API_KEY=sk-CANARY` into parent env and asserts child observes it as undefined | ❌ — structural invariant has no self-heal; failure requires code fix | ✅ unit-test gates the canary itself | ✅ Compliant | Spec 12 Rule 1a. Internal-contract canary, regression guard rather than drift detector — lives forever to catch future allowlist-expansion mistakes. |
| `adapters/openai-codex/transport/agenticSessionHeadless.ts` — tmux `capture-pane` polling loop tailing Codex `--json` stdout for CanonicalEvent normalization, plus Rule 1a env-scrub at the tmux `new-session` spawn boundary | tmux capture-pane format (shared with liveOutputStream) + the env-allowlist contract | Medium (event observability) + Critical (env-scrub at spawn) | per-poll (500ms while alive) + per-spawn | Stable (tmux CLI is OS-level) | ✅ env-scrub covered by `openaiKeyLeakageCanary` at adapter init; capture-pane format shared with `liveOutputStream.ts` | ❌ — OS-level format; code fix is remediation path | ✅ unit-test gates the spawn boundary via `tests/unit/providers/adapters/openai-codex/agenticSessionHeadless-env.test.ts` (Spec 12 Rule 1a coverage) | ✅ Compliant | Spec 12 Pre-Phase A cycle 1 routed the tmux spawn through `buildCodexChildEnv()` + `buildCodexTmuxSessionEnv()`. The capture-pane loop reads from the resulting pane — coverage shared with the env-scrub canary at the spawn boundary it tails from. |

### OS / filesystem

| Location | Upstream | Criticality | Frequency | Stability | Canary | Self-heal | E2E | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|
| (catch-all for `~/.claude/projects/` directory existence checks) | filesystem | Low | per-check | Very stable | n/a | n/a | n/a | 🔵 Exempt | Filesystem semantics don't drift. Direct file-existence checks don't need canaries. |
| (catch-all for `ps` / `tmux list-sessions` exit codes) | OS process tools | Low | per-check | Very stable | n/a | n/a | n/a | 🔵 Exempt | Same — OS tools have stable command-line contracts. |
| `monitoring/greenPrAutomergeWiring.ts` — `gh pr view/list --json` PR/state/autoMergeRequest/identity reads + `--disable-auto` disarm seam | GitHub `gh` CLI structured `--json` output | High (merge watcher acts on this) | per-tick (≤ ~10 min) | Stable (`gh --json` is a versioned structured contract, never regex over human text) | n/a | n/a | ✅ unit + wiring-integrity coverage | 🔵 Exempt | Rule 3.1 rationale block present in-file. Every read fails toward NOT merging (throw → tick-failed; unparseable → skip/UNKNOWN), and `safe-merge` re-verifies at act time, so a misread can only cause a refusal, never an unintended merge. |
| `monitoring/MergeRunner.ts` — parses `safe-merge` JSON result line + in-flight record | safe-merge.mjs structured result + own durable record | High (merge accounting) | per-attempt | Stable (own structured format) | n/a | n/a | ✅ unit coverage | 🔵 Exempt | Rule 3.1 rationale block present in-file. Reads its OWN structured `safe-merge-result:` line + own in-flight JSON; unparseable → null/skip (never an unconfirmed-merge claim — B10 confirm is independent). |

---

## Audit sweep procedure

Two layers — automated per-commit, manual per-milestone.

### Per-commit (automated)

`scripts/check-rule3-coverage.cjs` runs from the husky pre-commit hook. It scans the staged diff for the same state-detection patterns the manual sweep would grep for, and **blocks the commit** unless each touched file has either:
- a `RULE 3.1 RATIONALE` doc-comment + a canary file staged alongside, OR
- an entry in this registry (path-matched), OR
- an explicit `RULE 3: EXEMPT — <reason>` marker comment.

This is the structural enforcement Justin asked for: "keep awareness of what hasn't been updated yet, so coverage grows over time." New state-detection code can't land without registering — false positives are remediated with the EXEMPT marker, false negatives are the trade-off we accept against silent-corruption bugs.

### Per-milestone (manual)

After each Phase milestone, before each release cut:

1. Grep the codebase for the same patterns the commit-time check uses, plus broader heuristics:
   - `/[A-Z].*Reader\b/`, `Tailer`, `Observer`, `Receiver`, `Parser` class names
   - `capture-pane`, `tmux .*-p`, `execFile.*tmux`
   - `fetch(.*\.anthropic\.com|api\.openai\.com|slack\.com|telegram\.org)`
   - `match(.*\/.*\/g?)` followed by a return / branch
   - `JSON.parse(.*response.*body)`

2. For each hit, check if a registry entry exists in this doc.

3. If missing, add a row marked ❌. Open an action item to retrofit a canary.

4. If present, verify the status flags still match reality (especially after refactors).

5. Report sweep deltas in the next CHANGES.md entry.

The manual sweep is a safety net for patterns the commit-time check misses (regex won't catch every shape of state-detection code), and a recalibration pass for status flags that may have drifted from reality through refactors.

---

## Phase-4 (Codex) inheritance

When the Codex adapter lands, it inherits the entire structure of this registry — every observability primitive in `adapters/openai-codex/observability/*.ts` gets a row at adapter-creation time. The PR adding Codex MUST include the registry entries (and the canaries) in the same commits. No new adapter ships without populating its rows here.
