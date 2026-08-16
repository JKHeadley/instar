# Cross-Model Synthesis — Unanswered-Message Reaper

**Document**: docs/specs/unanswered-message-reaper.md
**Models**: GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast
**Date**: 2026-04-28

## Verdict

All three external models returned **CONDITIONAL** approval at 8–9/10. Strong design fundamentals; specific corrections required before code lands.

| Model | Score | Status |
|-------|-------|--------|
| GPT 5.4 | 8/10 | Conditional |
| Gemini 3.1 Pro | 9/10 | Conditional |
| Grok 4.1 Fast | 9/10 | Conditional |

## Consensus Findings (all 3 models flag)

1. **Open questions must resolve before approval** — performative-reply (Q1) and escalation cadence (Q2). All three explicitly flagged this; cannot ship a spec with architectural decisions still open.
2. **Mode B classification too aggressive** — JSONL-mtime + no-active-children misclassifies legitimate slow LLM/tool API calls as "diverged." Needs hardening: GPT wants explicit at-prompt signal, Gemini wants 90s+ idle threshold, Grok wants getChildProcesses error fallback. All three converge on the same root concern.

## Two-of-Three Findings

3. **Phase-3 scale ceiling** (Gemini + Grok) — at 5K active topics, 50-topics-per-sweep budget breaks the 3-min unanswered SLA. v1 design is correct for phase 1–2 (≤500 topics).

## Unique Catches (per model)

**GPT** — strongest on correctness ambiguity:
- Time semantics conflate monotonic and wall-clock across persistence/restart/mtime. Real correctness bug.
- Dedupe key `<topicId>:<timestampMs>` violates the spec's own channel-discriminator rule.
- Restart reconciliation 20-row window is steady-state-tuned, not restart-tuned.
- No SLO/success criteria; no rollout plan; edited/deleted message semantics undefined.

**Gemini** — strongest on scalability and side-effects:
- Polling math doesn't scale (5K topics → 100-min cycle).
- No async mutex on dedupe debounced flush — interleaving risk.
- Cross-machine clock skew on lastReal.timestamp.
- Mode B prompt should mandate redaction of secrets/system-prompt-fragments.

**Grok** — strongest on operational hardening:
- `injectMessage` hang has no timeout — single hung call stalls a sweep.
- `getChildProcesses` failure fallback unspecified (throw → silent skip is wrong).
- Restart reconciliation depth too shallow for high-volume topics.
- No telemetry catalog, no threat-model table.

## Resolutions Applied

| Finding | Resolution in updated spec |
|---------|---------------------------|
| Open questions (consensus) | Resolved both: performative=motion-with-telemetry; escalation=T+5 retry, T+10 AttentionQueue notification |
| Mode B too aggressive (consensus) | Four-gate classifier: mtime-after + 90s-idle + no-children (with try/catch) + positive at-prompt signal from SessionWatchdog. Fail-closed → Mode A |
| Time semantics (GPT) | Split into `receivedAtWallClockMs` (persistence/comparison) + `receivedAtMonotonicMs` (in-process); explicit field naming at every comparison |
| Dedupe key channel-qualification (GPT) | Key is now `(channel, topicId, lastReal.receivedAtWallClockMs)` |
| Restart reconciliation depth (GPT + Grok) | Targeted O(log n) `findFirstAgentMessageAfter` query, not 20-row scroll |
| injectMessage hang timeout (Grok) | 10s timeout + `reaper:inject-hang` event |
| getChildProcesses failure (Grok) | try/catch + "treat throw as active-children-present" (conservative skip) |
| Async mutex on dedupe flush (Gemini) | In-memory mutex wraps every dedupe-map mutation |
| Mode B redaction (Gemini) | Prompt explicitly mandates redaction of secrets/system-prompt/cross-topic |
| Rollout plan (GPT) | New section: 4-stage rollout (dark-mode → Mode A → Mode B → escalation) |
| SLO / success criteria (GPT) | New section with quantitative targets |
| Telemetry catalog (Grok) | New section enumerating every `reaper:*` event with dimensions + dashboard group |
| Threat model (Grok) | New section as table |
| Phase-3 scale (Gemini + Grok) | Explicitly out-of-scope; tracked follow-up |

## Convergence Verdict

**CONVERGED** at iteration 4 (3 internal Claude rounds + 1 external cross-model round). All consensus findings and all unique findings rated at severity ≥ low have been materially addressed in the spec. Out-of-scope items (phase-3 scale, edit/delete semantics) are explicitly listed and tracked rather than handwaved.

The spec is ready for user review and approval.
