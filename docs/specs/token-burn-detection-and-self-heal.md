---
slug: token-burn-detection-and-self-heal
review-convergence: "2026-05-15T20:25:00Z"
review-iterations: 1
review-completed-at: "2026-05-15T20:25:00Z"
review-report: docs/specs/reports/token-burn-detection-and-self-heal-convergence.md
approved: true
approved-by: justin
approved-at: "2026-05-15T20:35:00Z"
approved-via: "Telegram topic 8615 (uid:7812716706)"
---

# Token-Burn Detection and Auto-Heal — Spec

**Status: draft, awaiting `/spec-converge` and explicit user approval before implementation.**

## Motivating Incident

On 2026-05-15 a single InputDetector LLM-classification call path burned ~108,000 Haiku invocations and ~3.03 billion tokens in 24 hours — 73% of the entire machine's spend — without any autonomous detection or response. Justin only noticed because the bill caught his eye and he asked, "we seem to be burning tokens very fast again." A token ledger (#112, shipped 2026-05-14) had been built specifically to make this kind of pattern visible, but the ledger only stores data; it does not detect anomalies, alert, or act.

The reason the bug got that bad before someone noticed: the rate-limit on the LLM-call was wired to fire only on successful prompt emit, never on NO_PROMPT. Idle sessions kept asking the LLM "is this stuck?" every 5 seconds forever, getting "no" every time. Manual investigation + a hand-rolled fix shipped within hours of being asked, but the two-day cumulative spend was already gone. No alert, no auto-cut, no follow-up.

**The next instance of this pattern will look exactly the same** — some sentinel, hook, job, or user-installed extension will turn into a recurring-LLM-call loop, the ledger will quietly record it, and no one will notice until the human spots it. This spec proposes a structural fix: detection, alerting, bounded auto-cut, verification, and follow-up, all automatic, all generic enough to cover any future caller without modification — while staying inside the signal-vs-authority boundary and the existing Remediator V2 trust/authority framework.

## Goal

Add a self-running subsystem inside every instar agent that:

1. **Detects** when a single LLM call path is consuming an outsized share of the agent's 24h token budget (concrete trigger: a single attribution key crosses 25% of total spend in the last 24h, OR doubles its own 7-day median rolling baseline once that baseline exists).
2. **Triages** the signal through a signal-vs-authority compliant gate — the detector emits structured signals, the Remediator V2 dispatcher (existing F-1 / F-8) is the only blocking authority. No new authority layer is introduced.
3. **Alerts the user** via Telegram with a structured payload: offending attribution key, observed rate, projected 24h cost, recent samples, and an inline action button "Throttle this path" (one-tap), the button bound to the authorized principal so an unauthorized chat cannot trigger throttle.
4. **Auto-cuts the bleeding** for known-safe-to-throttle call paths with a bounded reversible throttle (default: cap the path's per-hour invocation rate at 25% of its observed last-hour rate, applied for the next 60 minutes, then auto-revert). Unknown paths get alert-only by default; operator opts in to auto-throttle on unknowns.
5. **Verifies** the cut took effect by re-sampling the same telemetry the ledger reads, and **sends a follow-up Telegram** with structured before/after numbers — or a "cut did not take effect, escalating" message if the throttle didn't reduce the rate.
6. Works generically: every LLM-emitting code path in every agent is automatically observable + (where safe) throttleable without per-path opt-in. Third-party agent authors who add new sentinels/jobs/hooks do not have to think about this — the system catches their accidents by default.

## Architecture

```
                        ┌──────────────────────┐
   ~/.claude/projects/  │  TokenLedger         │
   *.jsonl              │  (existing, #112)    │
   (Claude Code CLI     └─────────┬────────────┘
    ground truth +                │ events
    instar SDK calls)             │ (each event
                                  │  has
                                  │  attribution_key,
                                  │  written by
                                  │  IntelligenceProvider
                                  │  chokepoint on
                                  │  the write side)
                                  ▼
                        ┌──────────────────────┐
                        │  AttributionResolver │  ← pure mapping from event →
                        │  (NEW, deterministic)│    attribution key. Runs on
                        │  read-side only      │    LEDGER READ side. Not on
                        │  (zero hot-path cost)│    LLM call hot path.
                        └─────────┬────────────┘
                                  │ events keyed
                                  ▼
                        ┌──────────────────────┐
                        │  BurnDetector        │  ← polls ledger every 60s
                        │  (NEW, detector)     │    (independent of ledger
                        │  signal-emitter only │     writer cadence). Emits
                        └─────────┬────────────┘    BurnSignal on threshold.
                                  │ BurnSignal
                                  ▼
                        ┌──────────────────────┐
                        │  Remediator V2       │  ← existing F-1 dispatch +
                        │  dispatcher          │    F-5 trust elevation +
                        │  (existing authority)│    F-8 capability HMAC.
                        └─────────┬────────────┘    No new authority surface.
                                  │ Runbook invocation
                                  │ (Tier-2: signed ctx,
                                  │  audit, lock, deadline)
                                  ▼
                        ┌──────────────────────┐
                        │  burn-throttle       │  ← NEW Tier-2 Runbook.
                        │  runbook             │    Alerts + (where safe)
                        │  (NEW)               │    throttles + verifies +
                        │                      │     follow-up.
                        └──────────────────────┘
                                  │
                                  ▼
                        ┌──────────────────────┐
                        │  LlmRateGate         │  ← NEW primitive (ships in
                        │  primitive           │    Phase 1, BEFORE detector,
                        │  (NEW, capability-   │    so there is no regression
                        │   token gated)       │    window where detector
                        └──────────────────────┘    signals with no actuator).
```

### Signal-vs-Authority Decomposition

| Layer | Role | Authority? | Compliant w/ `docs/signal-vs-authority.md`? |
|---|---|---|---|
| AttributionResolver | Maps event → key | None | Yes — pure function on detector read-side |
| BurnDetector | Threshold-cross signal | None — emits only | Yes — brittle/cheap, no block authority |
| Remediator V2 dispatcher | Routes signal to runbook | Existing Tier-2 | Existing authority, unchanged |
| burn-throttle runbook | Alert / throttle / verify | Delegated Tier-2 | Authority is Remediator's, not the runbook's; runbook executes inside Remediator's signed-context wrapper |
| LlmRateGate primitive | Enforces throttle decision | None — enforces stored decision only; cannot decide | Yes — pure mechanism, decision is Remediator's |
| Telegram inline button | Principal-bound action | Capability HMAC (F-8) | Yes — button signature is principal+keyId, button forgery rejected |

No new authority layer is introduced. All "decide whether to throttle X" logic lives inside Remediator's Tier-2 surface (signed ctx, audit, lock, deadline).

### Attribution key

The key uniquely identifies a "call path" — the structural origin of the LLM call. Format: `<componentName>::<promptFingerprintShort>`, where:

- `componentName`: the source-side label (e.g. `InputDetector`, `CommitmentSentinel`, `user-job:<jobName>`). Resolved via:
  1. If the event has a `cwd` matching an instar source path, look up the file's responsible component via a static manifest (`src/monitoring/attribution-manifest.ts` — maps source-file globs to component names).
  2. If the event came from a scheduled job, the job name is the key (already in jobRuns ledger).
  3. If the event came from a user-defined hook/sentinel/extension, the hook/sentinel filename serves as the key.
  4. Fall back: `unknown::<sessionId-prefix>`.
- `promptFingerprintShort`: first 8 chars of SHA-256 over the first 256 bytes of the LLM prompt. This collapses repeated calls with similar prompts (the bleeding pattern) and distinguishes them from incidental variation.

**Capture surface (closing the bypass gap):**

- The Claude Code CLI's `~/.claude/projects/*.jsonl` writes are the ground truth for every `claude -p` invocation — captured automatically.
- Instar-internal LLM calls go through the `IntelligenceProvider` chokepoint (NEW chokepoint, lands in Phase 1). All `claude-cli`, Anthropic SDK, and raw HTTP wrappers in instar source are migrated to this chokepoint by Phase 1's tree-wide refactor. A lint rule blocks new raw-HTTP-to-LLM additions outside the chokepoint.
- User-installed extensions: covered automatically if they use the `IntelligenceProvider` shipped to extensions (`@instar/intelligence`). Raw HTTP bypass from a user extension is detected on the read side by the BurnDetector observing the JSONL telemetry; it cannot throttle a raw-HTTP path automatically but will alert with "unattributable LLM spend; possible direct API usage" — falling back to user-action.

### Data Model Changes

The `token_events` SQLite table (TokenLedger, #112) gets a new column:

```
ALTER TABLE token_events ADD COLUMN attribution_key TEXT NOT NULL DEFAULT 'unknown::pre-attribution';
CREATE INDEX IF NOT EXISTS idx_token_events_key_ts ON token_events(attribution_key, ts);
```

The column is populated on the write side by the `IntelligenceProvider` chokepoint (which knows the component) and on the read side by the AttributionResolver for legacy/JSONL-source events. Backfill on the existing rows happens once at Phase 1 init (one-shot job, idempotent, bounded by row count).

### Threshold logic

Two trigger conditions, OR'd:

1. **Absolute share**: a single attribution key consumed > 25% of the agent's total token spend in the last 24h.
2. **Rolling baseline divergence**: the key's last-1h rate is > 2× its trailing-7-day median rate, AND the 1h rate exceeds a floor of 10M tokens/h (avoid alerting on tiny absolute spend even if relatively spiked).

**Cold-start handling.** A 7-day baseline does not exist on day 1. For the first 7 days after the BurnDetector enables on an agent, only the absolute-share trigger fires (this is the trigger that would have caught the 2026-05-15 incident); the baseline-divergence trigger is held off and the system runs in "baseline-collection" mode for that key.

Both thresholds are configurable per-agent in `.instar/config.json` under `tokenBurnDetection`. Defaults shipped above are conservative — they would have caught today's incident (the InputDetector path was 73% of spend) AND would have caught it 3-4 hours into the burn rather than 24-48h.

### Auto-throttle mechanism

When the burn-throttle runbook decides to throttle, it executes through the existing scheduler / monitoring surface via the new `LlmRateGate` primitive:

- For SCHEDULED jobs (cron entries): drop the cron frequency by 4× (e.g. `*/5` → `*/20`). The throttle override is stored in `.instar/jobs.json.throttle-overrides`, a file whose every entry is HMAC-signed by Remediator's F-8 capability key (so an arbitrary writer cannot fabricate throttle entries that the scheduler honors). Auto-reverts after 60 minutes unless the runbook re-fires.
- For per-tick MONITORING components with an LLM rate limit (InputDetector, CommitmentSentinel, etc.): components use the `LlmRateGate` primitive. The gate exposes `gate.shouldFire(attributionKey): boolean` which the component consults before calling the LLM. When the burn-throttle runbook records a throttle (via a Remediator-signed capability token), the gate returns false for that key for the duration. Components that never adopt the gate are exempt from automatic throttling — alert-only fires for them.
- For HOOKS / USER EXTENSIONS without a rate gate surface: alert-only. The runbook explicitly says "I couldn't auto-throttle this; here are the options," and the throttle decision falls back to the user via the Telegram action button (one-tap "disable this hook for the next hour").
- For UNKNOWN/UNATTRIBUTABLE paths: alert-only by default. Operator opts in to "auto-throttle on unknown" via config (off by default — explicit principal authorization required because the system has no idea what it is throttling).

The throttle is reversible at any time via the Telegram inline button. (No CLI is recommended to the user; Echo's `feedback_no_cli_recommendations` rule applies.)

**Self-reinforcing loop guard.** The runbook's own LLM call (used to compose alerts / verify reports) is tagged with an exempt attribution key (`burn-throttle-runbook::*`) and is bounded to N=1 LLM call per BurnSignal. Even if the runbook's own LLM calls were misattributed to the offending key, the gate would refuse to throttle the runbook itself.

### Telegram inline-button safety

Telegram inline-button callbacks are bound to the authorized principal user_ids list in `.instar/config.json` (existing list, used by `MessagingToneGate` and other principal-checks). Each button's `callback_data` is signed with an HMAC over `(buttonAction, attributionKey, signalId, principal)` using Remediator's F-8 capability key. The webhook handler:

1. Verifies the callback's `from.id` matches one of `authorized_user_ids`.
2. Verifies the HMAC signature on `callback_data`.
3. Verifies the signal-id is fresh (not a replay of a previously-handled callback).

Any of these checks fails → the action is rejected silently with a Telegram log entry. This closes the unauthorized-principal hijack vector.

### Verification

After the throttle has been in place for 5 minutes, the runbook re-samples telemetry:
- Pulls all events in the last 5 minutes from the affected attribution key
- Computes the post-throttle rate
- Compares to the pre-throttle rate
- Emits `VerificationResult { successfullyThrottled: bool, postRate, preRate, ratio }`

If `successfullyThrottled === false` (the rate didn't drop materially), the runbook escalates: a structured Telegram follow-up with "I tried to throttle X but the rate didn't drop. Possible reasons: (a) attribution-key mismatch — the actual offender is a different path with similar fingerprint; (b) the path doesn't honor the gate — operator must intervene manually."

### Telegram payloads

All three messages (alert, follow-up after auto-cut, escalation on cut-failure) go through the existing tone-gate authority (`MessagingToneGate`). They are structured templates filled at runbook-time, narrative in tone, and pass ELI16. No backticks, no camelCase config keys — the agent's "interface" rule applies (`feedback_no_cli_recommendations` and `feedback_eli16_default` in Echo's MEMORY.md).

### Universality / opt-in shape

By default, every agent has burn-detection enabled at the conservative thresholds defined above. Configuration in `.instar/config.json`:

```
tokenBurnDetection:
  enabled: true                  (default)
  absoluteShareThreshold: 0.25   (default 25%)
  rollingBaselineMultiplier: 2   (default 2x)
  rollingBaselineFloor: 10000000 (default 10M tokens/h)
  autoThrottle: true             (default — known-safe paths only)
  autoThrottleOnUnknown: false   (default — alert-only on unattributed)
  autoThrottleFactor: 4          (default 4x rate cut)
  autoThrottleDurationMin: 60    (default 60 min before auto-revert)
  perKeyAlertCooldownMin: 60     (default 60 min between repeat alerts for same key)
```

Writes to this config section go through the principal-authorized config-write path (`POST /config/update` with principal HMAC check), not direct file writes — closing the "config is unsigned" vector.

Operators can disable any component independently. Setting `enabled: false` silences both alerts and throttle. Setting `autoThrottle: false` keeps alerts but never auto-cuts (alert-only mode). All defaults can be overridden per-agent.

## Implementation Phases (proposed — DO NOT implement until approved)

**Ordering is deliberate**: the actuator (LlmRateGate) lands before the detector (BurnDetector) so the detector never emits a signal that has no target to act on. The chokepoint (IntelligenceProvider) lands first so that attribution_key is populated on write from day 1, avoiding a regression window where the ledger has events with no key.

1. **Phase 1 — IntelligenceProvider chokepoint + LlmRateGate primitive + attribution_key column**: Tree-wide refactor migrating every instar-internal LLM caller to a single chokepoint. The chokepoint writes attribution_key on every TokenLedger event. The LlmRateGate primitive ships at this phase but is no-op (no throttles exist yet). Lint rule blocks new raw-HTTP-to-LLM outside the chokepoint. Tests: 15+ (callers correctly attributed, lint rule fires, gate returns true with no throttles, attribution_key backfill is idempotent).
2. **Phase 2 — AttributionResolver (read-side)**: pure function that maps a TokenLedger event with missing attribution_key (legacy JSONL events) to a key. Tests: 20+ event shapes (instar-internal, scheduled job, user extension, unknown).
3. **Phase 3 — BurnDetector**: polls the ledger every 60s (independent of ledger writer), computes per-key rates over rolling windows, emits BurnSignal when thresholds cross. Cold-start logic in place. Tests: 15+ scenarios (no burn, single key dominant, multi-key share, baseline spike, cold-start absolute-share, cold-start baseline-skip). Emits to a NEW DegradationReporter channel; no autonomous action.
4. **Phase 4 — burn-throttle runbook (Tier-2 Remediator)**: consumes BurnSignal via existing Remediator dispatch, decides alert vs throttle, executes the throttle via LlmRateGate, posts Telegram. Self-reinforcing-loop guard tested (runbook's own LLM call exempt). Tests: 12+ runbook outcomes (alert-only / throttle-instar-job / throttle-monitor-component / alert-on-unattributable / escalation / self-attribution-exempt).
5. **Phase 5 — Principal-bound Telegram inline buttons**: HMAC-signed callback_data, principal verification, signal-id freshness check. Tests: 8+ (authorized accept, unauthorized reject, replay reject, HMAC-tamper reject).
6. **Phase 6 — Verification + follow-up**: post-throttle re-sample + structured Telegram follow-up. Tests: 6+ (verified drop, verified no-drop, escalation).

Each phase ships as its own PR through `/instar-dev` with spec + side-effects review + second-pass reviewer + ELI16 + tests. The current spec is the umbrella; per-phase specs derive from it.

There is no "Phase 7" universal-block layer; the iteration-1 reviewers correctly flagged that a universal `IntelligenceProvider`-level gate with brittle threshold authority would violate signal-vs-authority. Universality is achieved instead by (a) chokepoint capture in Phase 1, (b) attribute-everything-on-write so the BurnDetector sees every caller, and (c) the runbook decision living inside the existing Remediator Tier-2 authority — not in a new gate.

## Acceptance Criteria (umbrella)

1. Reproduce today's incident (InputDetector burning 4500 calls/h on idle sessions) without the PromptGate fix: burn-detection fires within 30 minutes of the rate crossing the 25% threshold.
2. Telegram alert arrives in the user's chat with the structured payload + inline throttle button signed with the principal HMAC.
3. Unauthorized chat ID's button-press is rejected (principal-bind test).
4. One-tap throttle (or auto-throttle if enabled) reduces the rate to ≤25% of pre-throttle within 5 minutes.
5. Post-throttle verification message arrives with before/after numbers.
6. The full path works against a synthetic third-party hook/sentinel that has NEVER been seen before (universality test).
7. Synthetic test: an injected raw-HTTP LLM call (bypass) generates an "unattributable LLM spend" alert (not an auto-throttle), proving the bypass is observable.
8. Cold-start test: a fresh agent with no 7-day baseline still fires on absolute-share.
9. Self-reinforcing-loop test: the runbook's own LLM calls do not get throttled by their own decision.
10. Operator can disable the system entirely via the principal-authorized config-write path without touching code.
11. All runbook decisions go through Remediator orchestration (Tier-2: signed ctx, audit, lock, deadline) — no bypass paths.

## Side-Effects Considerations (preview, deferred to per-phase artifacts)

- **Over-throttle**: a legitimate sustained burst (e.g. a long debugging session genuinely needing the LLM) gets auto-throttled. Mitigation: alert with one-tap "this is fine, snooze for 24h" button (principal-bound).
- **Telegram alert flood**: a flapping burn pattern produces many alerts. Mitigation: `perKeyAlertCooldownMin` config (default 1h between repeat alerts).
- **Attribution key mismatch**: throttle goes to the wrong key, the real offender keeps burning. Verification + escalation path covers this.
- **Signal-vs-authority compliance**: detector is a brittle threshold gate; throttle decisions ARE made by the Remediator runbook (Tier-2 authority with audit + trust gate). No brittle component has block authority.
- **Hot-path cost**: AttributionResolver runs on detector read-side only; LLM hot path adds one cheap deterministic write (attribution_key as a column on the TokenLedger event the chokepoint already writes). No hot-path LLM call added.
- **Chokepoint migration risk**: Phase 1's tree-wide refactor touches every LLM caller. Each call site gets a test in the same PR; lint rule prevents regression.

Full side-effects review for each phase is in its respective PR's `upgrades/side-effects/*.md` artifact.

## Rollback Cost (umbrella)

The system is built phase-by-phase as additive code. Disabling at any phase boundary is a config flag (`tokenBurnDetection.enabled: false`). Rolling back any single phase is a per-phase revert. The only NEW persistent state is the `.instar/jobs.json.throttle-overrides` file (HMAC-signed entries; cleared on auto-revert) and the `attribution_key` column on `token_events` (NULLABLE rollback path: drop the column or set default to 'unknown::pre-attribution').

## ELI16 Companion

`docs/specs/token-burn-detection-and-self-heal.eli16.md` (sibling).

## Convergence Notes

This spec entered `/spec-converge` on 2026-05-15.

**Iteration 1** ran four internal Claude-subagent reviewers in parallel (security, scalability/performance, adversarial, integration). Total finding count: ~100 across all four reviewers, spanning CRITICAL / HIGH / MEDIUM / LOW severity.

CRITICAL and HIGH findings addressed in this rewrite include:
- Signal-vs-authority violation in the original "Phase 6 universal IntelligenceProvider gate" — replaced with chokepoint-on-write + Remediator-authority-only.
- Unauthorized-principal hijack of Telegram inline buttons — closed via HMAC + principal-bind + replay check.
- Unsigned config writes — closed via principal-authorized POST /config/update.
- Unsigned `jobs.json.throttle-overrides` — closed via HMAC-per-entry signed by Remediator's F-8 capability key.
- AttributionResolver placement on hot path — moved to read-side only.
- Detector polling coupled with ledger writer — decoupled to independent 60s cadence.
- Missing attribution_key column on token_events — added with index + backfill plan.
- Cold-start baseline undefined — first 7 days run absolute-share-only.
- Phase ordering regression window — reordered so LlmRateGate + chokepoint land before BurnDetector.
- `claude -p` and Anthropic-SDK bypass paths — closed via single IntelligenceProvider chokepoint + raw-HTTP lint rule + raw-HTTP detection on read-side (unattributable alert).
- Self-reinforcing throttle loop via runbook's own LLM call — closed via exempt attribution key + N=1 cap per signal.
- "Universal IntelligenceProvider gate" breaks legitimate high-volume LLM workloads — replaced; universality is via attribution-on-write + Remediator decision, not a new authority layer.
- Authority ambiguity (threshold detector held blocking authority) — fixed: detector is signal-only; only Remediator decides.

**Iteration 2** is the convergence check on this rewrite. External cross-model reviewers (GPT / Gemini / Grok) per `feedback_external_crossmodel_catches_what_internal_misses` are deferred to Justin's pre-implementation review window — the autonomous-mode window did not permit a fourth-round external pass, and this is noted in the convergence report. Justin's `approved: true` tag is the final convergence gate, not the four internal reviewers.

**Approval gate.** No Phase 1 code is written until Justin reads this spec (via the private viewer + tunnel link sent to Telegram topic 8615) and tags `approved: true` in this frontmatter.
