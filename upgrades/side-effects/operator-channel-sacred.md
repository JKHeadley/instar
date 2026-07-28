# Side-Effects Review — Operator Channel Is Sacred (MessageSentinel pause-lockout fix)

Spec: docs/specs/operator-channel-sacred.md (converged + approved). Standard integrated into docs/STANDARDS-REGISTRY.md.
Change: MessageSentinel `'pause'` consumes a message ONLY on a deterministic match; a bare-LLM or capacity-shed `'pause'` routes THROUGH (with a stop-token rescue); a per-topic circuit-breaker bounds blast radius; both inbound consume paths (server.ts onSentinelIntercept + routes.ts /internal/telegram-forward) decide via one shared `decideInboundDisposition`.

## 1. Over-block
The change can ONLY reduce consumption (more messages delivered). The one residual: `hasStopToken` is intentionally conservative (a whole-word "stop" anywhere → rescue to kill), so a benign message that the classifier already called 'pause' AND contains a whole-word stop ("non-stop") would be killed. Accepted: a kill is RECOVERABLE ("send a new message to start fresh"), unlike the pause lockout; and it only triggers on an already-pause-classified message, not normal traffic.

## 2. Under-block
A genuine pause directive that is non-deterministic (LLM-only) is now NOT honored (routes through). Accepted per the standard + the code's own comment ("pause's value is politeness, not safety"). A genuine STOP is preserved: deterministic fast-path stop fires instantly; a long-form/capacity-shed stop is rescued by `hasStopToken`.

## 3. Level-of-abstraction fit
The standard lives in ONE place (`MessageSentinel.decideInboundDisposition`); both consume sites call it, so policy cannot diverge between the poll path and the lifeline-forward path. Signal-vs-Authority: the classifier signals; the deterministic gate holds consume authority.

## 4. Signal vs authority compliance
Compliant + the exemplar of the new standard. A brittle (LLM/capacity-shed) signal no longer has authority to consume the operator's message; only a deterministic match (or a rescued stop) actuates.

## 5. Interactions
- detectRateLimited / throttle path: unchanged (separate).
- The capacity-shed return (llmClassify catch, confidence 0.4) now routes through instead of consuming — reconciled with the fork-bomb/No-Silent-Degradation fail-closed posture as a NAMED inbound exception (the deterministic emergency-stop pre-check + the stop-token rescue keep a real stop from ever being dropped).
- Emergency-stop kill path + resume-queue stop custody: unchanged for `disposition: 'kill'`.
- Circuit-breaker is in-memory shared across both paths (same MessageSentinel instance); in-memory is safe because the PRIMARY guard is deterministic-only-consume — a restart resetting the breaker cannot reintroduce the lockout. (Reasoned deviation from the spec's "durable" FD2: the build showed deterministic-only-consume makes breaker durability non-load-bearing; documented here.)

## 6. External surfaces
The user-facing change: benign messages that were being eaten as "Session paused" now reach the agent. `getStats()` (/sentinel/stats) now also exposes `disposition` counters (pause.consumed / .routed-through / breaker.recovered) — additive. No new route, no config schema change (the existing `externalOperations.sentinel.enabled` still gates the whole sentinel).

## 7. Multi-machine posture
Machine-local: each machine's MessageSentinel decides for its own inbound; both consume paths on a machine share its one instance + breaker. No cross-machine state. (Lifeline-owned agents hit the routes.ts path; poll-mode hits onSentinelIntercept — both on the same machine, same sentinel.)

## 8. Rollback cost
Single-commit revert restores the prior classify-then-consume logic. No migration, no durable state. The interim safeguard (`externalOperations.sentinel.enabled:false`) can stay until this merges, then be re-enabled (this fix makes the sentinel safe to re-enable).
