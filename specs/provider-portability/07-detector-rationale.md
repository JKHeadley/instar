# Detector Rationale Appendix — Rule 3.1 Justifications

**Status:** Active, living document
**Purpose:** Capture the Rule 3.1 "criticality × frequency × stability × fallback" rationale for every detector in the [state-detector registry](./06-state-detector-registry.md). Required artifact per Rule 3.

---

## Why this document exists

Rule 3.1 of the path constraints says every state-detection PR must ship a one-paragraph rationale answering: how critical is the signal, how often does it fire, how stable is the upstream system, what's the fallback when wrong. The combination drives whether deterministic detection is acceptable on its own, requires a canary, or needs to be replaced with an LLM-based check.

This appendix captures the rationale for detectors that pre-date the rule. New detectors include the rationale inline at design time (in the PR description or a short doc-comment at the top of the file). The format below is the template.

---

## Format

For each detector, four lines plus a one-line conclusion:

- **Criticality:** silent-corruption-if-wrong (worst) / minor-degradation / non-critical
- **Frequency:** per-prompt / per-poll / per-session-start / startup-only
- **Stability:** unstable / semi-stable / stable / very-stable
- **Fallback:** what cross-checks the signal, or "none" if its output is load-bearing
- **→ Verdict:** deterministic + canary / deterministic + LLM gate / LLM-based / exempt

---

## Provider substrate

### `adapters/anthropic-interactive-pool/promptRunner.ts` — empty-prompt completion detector

- **Criticality:** silent-corruption-if-wrong. A false-positive returns truncated/garbage text as a successful response; downstream parsers act on it.
- **Frequency:** per-prompt — fires once per call to OneShotCompletion.evaluate.
- **Stability:** unstable. Claude Code's TUI is a private surface; the prompt glyph has changed before and will change again.
- **Fallback:** none on the success path — the detector's "complete" signal is the only thing telling runPrompt to stop polling and return.
- **→ Verdict:** deterministic + canary (with self-healing) + LLM fallback. Currently shipped with startup canary, scheduled recurrence, persistence, and optional LLM fallback.

### `adapters/anthropic-headless/observability/conversationLogReader.ts` — JSONL log parser

- **Criticality:** moderate. Wrong parse degrades triage / resume but is detectable downstream (missing fields surface as null).
- **Frequency:** per-session-end (when a triage agent reads the log) or per-resume operation.
- **Stability:** semi-stable. Anthropic does change the JSONL schema occasionally; new event types appear without notice.
- **Fallback:** the canonical event union has a `ProviderRaw` escape hatch — unknown event types are passed through with their original payload so consumers can still operate, just without canonical-event helpers.
- **→ Verdict:** deterministic + canary. Canary writes a known event via hook, reads it back through this primitive, verifies key fields parse correctly. Not yet built; queued.

### `adapters/anthropic-headless/observability/conversationLogTailer.ts` — real-time JSONL tail

- **Criticality:** high. Stall detection depends on this; missed events extend recovery latency or mask crashes.
- **Frequency:** per-second polling against the file.
- **Stability:** semi-stable (same as Reader).
- **Fallback:** the file mtime check is a cross-signal — even if event parsing fails, file activity is observable independently.
- **→ Verdict:** deterministic + canary. Reuses the Reader's canary infrastructure; tail-specific test verifies incremental parsing handles partial writes.

### `adapters/anthropic-headless/observability/hookEventReceiver.ts` — hook payload parser

- **Criticality:** silent-corruption-if-wrong. Subagent lifecycle, compaction signals, and stop-gate events all flow through here; wrong parse means lost autonomous-loop state.
- **Frequency:** per-event (high — every tool call, every subagent start/stop, every compaction).
- **Stability:** unstable. Anthropic adds new hook event types regularly without schema versioning.
- **Fallback:** none on the path — consumers register handlers keyed by event type; an unparseable event simply doesn't fire any handler.
- **→ Verdict:** deterministic + canary + LLM gate for unknown shapes. Canary spawns a session that fires each known event type and verifies each is parsed correctly. Highest-leverage retrofit candidate per the audit.

### `adapters/anthropic-headless/observability/usageMeterProvider.ts` — Anthropic OAuth usage endpoint

- **Criticality:** high (cost-routing input — Phase 5 routing policy reads this to decide when to drain SDK credits).
- **Frequency:** per-poll (configurable, 5-60min).
- **Stability:** semi-stable. Read-only public-ish endpoint; Anthropic changes shape less often than UI but still does.
- **Fallback:** none — when this returns null, cost-routing falls back to "assume worst" and may drain credits faster.
- **→ Verdict:** deterministic + canary. Canary fetches and asserts returned-shape fields present. Per-poll cost makes LLM fallback expensive; defer to canary alone.

### `adapters/anthropic-headless/observability/sessionId.ts` — UUID extraction from JSONL filename

- **Criticality:** high (resume continuity — wrong ID returns a phantom session).
- **Frequency:** per-session-start.
- **Stability:** stable. UUID format is canonical; filename structure has been stable across Claude Code versions.
- **Fallback:** the resume operation itself verifies the session exists before using the ID.
- **→ Verdict:** deterministic + light canary (startup-only). Canary verifies a freshly-spawned session's UUID extraction matches the JSONL filename it actually writes to.

### `adapters/anthropic-headless/observability/subagentLifecycleObserver.ts` — filters hook events for subagent types

- **Criticality:** high (autonomous-loop accuracy depends on knowing when subagents start/stop).
- **Frequency:** per-event (high).
- **Stability:** unstable (depends transitively on hookEventReceiver — same upstream).
- **Fallback:** verified transitively by the hookEventReceiver canary.
- **→ Verdict:** deterministic + canary (covered by parent hookEventReceiver canary).

### `adapters/anthropic-headless/observability/processLifecycle.ts` — tmux list-panes for PID/RSS

- **Criticality:** moderate (informational; not load-bearing for any single decision).
- **Frequency:** per-check (varies).
- **Stability:** very stable. tmux output format has been stable for years.
- **Fallback:** ps fallback if tmux output unparseable.
- **→ Verdict:** deterministic + light canary (weekly or on major-version upgrade).

### `adapters/anthropic-headless/observability/liveOutputStream.ts` — tmux capture-pane

- **Criticality:** moderate.
- **Frequency:** per-call.
- **Stability:** very stable.
- **Fallback:** alternative capture via session attach if capture-pane fails.
- **→ Verdict:** deterministic + light canary (shares process-lifecycle's cadence).

### `adapters/anthropic-headless/control/authCredentialInjection.ts` — credential-validity probe

- **Criticality:** minor-degradation. A wrong verdict surfaces as a loud AuthError, or the credential fails loudly downstream — never silent corruption; the probe is a pre-check convenience, not the authority.
- **Frequency:** per-enrollment / per-verification event (rare).
- **Stability:** very-stable — official public Messages-API HTTP status semantics (401/403 for bad credentials), not a scraped surface.
- **Fallback:** every downstream call with the same credential fails loudly on its own; `mapApiError` classifies non-ok statuses.
- **→ Verdict:** deterministic, exempt-from-canary (stable public API contract + loud failure path). Probe model config-overridable via `intelligence.pinnedModels.anthropicCredentialProbe` (2026-07-02).

### `adapters/anthropic-interactive-pool/pool.ts` — waitForReady static idle-marker check

- **Criticality:** moderate (pool boot signal — wrong "ready" hands out an unready session, but the first real prompt against that session will fail loudly).
- **Frequency:** per-spawn.
- **Stability:** unstable (same Claude Code TUI as the empty-prompt detector).
- **Fallback:** the empty-prompt detector takes over once the session is "ready"; if waitForReady is wrong, the next prompt's stability+marker check fails fast.
- **→ Verdict:** deterministic + canary (should consume the same signature the empty-prompt canary derives). Currently uses hardcoded markers; pending refactor to share the signature store.

### `adapters/anthropic-interactive-pool/promptRunner.ts` — extractResponse marker grammar

- **Criticality:** silent-corruption-if-wrong (returns wrong text as response body).
- **Frequency:** per-prompt.
- **Stability:** unstable (Claude Code TUI response framing).
- **Fallback:** the legacy heuristic that walks back from `lastIndexOf('⏺')` — already a degraded fallback for when marker grammar fails.
- **→ Verdict:** deterministic + canary (extract-response should be exercised by the same canary that derives the empty-prompt signature — they share the upstream). Currently the canary only verifies the empty-prompt signal; extending it to verify response extraction is the natural next step.

---

## Pool internals (Bug B/C/D fix surfaces)

### `pool.ts` — replacement-spawn retry handler

- **Criticality:** high (pool decay = unbounded allocate-timeout latency for callers, eventually no service).
- **Frequency:** event-driven (fires only when a spawn fails).
- **Stability:** very stable (JS-level errors from execFile; not upstream-UI dependent).
- **Fallback:** the routing policy can route around a degraded pool to the headless adapter.
- **→ Verdict:** deterministic + light canary (weekly). Canary forces a controlled spawn failure (wrong claudePath) and verifies the degradation event fires and retry-with-backoff kicks in. Built in commit immediately following this doc.

### `transport/oneShotCompletion.ts` — retire-on-error path

- **Criticality:** silent-corruption-if-wrong (was the exact bug Bug C fixed: poisoned session returns garbage as success).
- **Frequency:** event-driven (fires only when runPrompt throws).
- **Stability:** very stable (internal contract).
- **Fallback:** routing policy fallback to headless if the pool is in distress.
- **→ Verdict:** deterministic + unit-test coverage (no canary required — drift risk is zero since it's internal contract). Covered by `oneShotCompletion-retire-on-error.test.ts`.

### `markers.ts` — STUB_MARKER symbol

- **Criticality:** high (capability-declaration honesty — a missed marker means a stub passes parity as if real).
- **Frequency:** parity test runs.
- **Stability:** very stable (internal symbol).
- **Fallback:** none required — symbol identity is deterministic.
- **→ Verdict:** deterministic + startup canary. Canary verifies stubs created by both adapter factories satisfy `isStubPrimitive`. Built in commit immediately following this doc.

---

## Application layer

### `monitoring/QuotaCollector.ts` — Anthropic OAuth usage poll

- **Criticality:** high (same upstream as substrate's UsageMeterProvider).
- **Frequency:** per-poll (adaptive 5-60min).
- **Stability:** semi-stable.
- **Fallback:** stale-cache fallback exists in the collector.
- **→ Verdict:** deterministic + canary (shared with substrate UsageMeterProvider canary once that lands).

### `monitoring/StallTriageNurse.ts` — terminal-output heuristic pre-filter

- **Criticality:** moderate (LLM diagnose is the primary path; this is the fast pre-filter).
- **Frequency:** per-stalled-session.
- **Stability:** unstable (same Claude Code TUI as the substrate).
- **Fallback:** falls through to the LLM diagnose path if heuristic is uncertain.
- **→ Verdict:** deterministic + canary. Lower priority than substrate canaries because the LLM fallback exists and is already wired (post-Rule 2 fix).

### `core/SessionManager.ts` — tmux session liveness checks

- **Criticality:** high (session health gates job dispatch).
- **Frequency:** per-second polling.
- **Stability:** very stable (tmux exit codes).
- **Fallback:** ps-based liveness fallback exists.
- **→ Verdict:** deterministic + light canary (weekly).

### `messaging/TelegramAdapter.ts` — Telegram Bot API response parsing

- **Criticality:** high (relay correctness — wrong parse drops messages or replays them).
- **Frequency:** per-poll / per-webhook event.
- **Stability:** semi-stable (Telegram does change schemas occasionally).
- **Fallback:** raw-payload retention on disk allows post-hoc reprocessing.
- **→ Verdict:** deterministic + canary. Canary fetches a known channel's info and asserts response shape. Lower priority than provider substrate but still in the Tier 2 list.

---

## OS / filesystem

### Filesystem existence checks (`fs.existsSync`, `fs.statSync` patterns)

- **→ Verdict:** exempt. Filesystem semantics don't drift; direct existence checks don't need canaries.

### OS process tools (`ps`, `tmux has-session` exit codes)

- **→ Verdict:** exempt. OS command-line contracts are stable across decades.

---

## Template for new detectors

When adding a new state-detector to Instar, include this block in the PR description AND as a doc-comment at the top of the detector file:

```
RULE 3.1 RATIONALE
- Criticality: [silent-corruption / minor-degradation / non-critical]
- Frequency:   [per-prompt / per-poll-Xmin / per-session-start / startup-only]
- Stability:   [unstable / semi-stable / stable / very-stable]
- Fallback:    [<what cross-checks this, or "none">]
- Verdict:     [deterministic + canary / deterministic + LLM gate / LLM-based / exempt]
```

A registry row in `06-state-detector-registry.md` and (unless exempt) a canary file in the same PR are also required.
