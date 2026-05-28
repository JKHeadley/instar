# Side-Effects Review — CollaborationRedrive: fingerprint-as-relatedAgent + escalation-flood fix

**Context:** Dogfood-armed PR #490 on Echo's live node, 2026-05-28. Within minutes of the engine going `armed`, Justin caught a notification flood on his Telegram Attention queue (35+ items in <30 min, screenshot). Two distinct bugs.

## Bug 1 — fingerprint-as-relatedAgent
**Symptom.** ~10 of 15 active `threadline-reply` commitments on Echo store the peer's 32-character hex fingerprint directly in `relatedAgent` (when the commitment was opened from an inbound whose sender we only knew by fingerprint). The original `resolveFingerprint` always ran a name lookup against `known-agents.json` — a hex string is not a name → lookup misses → engine skips with `unresolved-name` → in the original code, escalates as "can't reach <fingerprint>".

**Fix.** Detect the fingerprint case structurally (`/^[0-9a-f]{32}$/i`) and use the value directly as the routing address; normalise to lowercase. Fall through to the name lookup only for non-fingerprint strings.

**Tests added.** `looksLikeFingerprint` accepts lowercase/uppercase 32-hex, rejects non-hex and wrong-length strings; a commitment with a fingerprint `relatedAgent` resolves directly with an empty `known-agents.json` and the engine sends.

## Bug 2 — escalation flood
**Symptom.** The original `unresolved-name` path used an in-memory strike counter that escalated to the Attention queue after 3 strikes per peer AND reset the counter to 0 — so the next sweep started accumulating strikes again, and the queue received a new `can't reach <peer>` item every few sweeps for every unresolvable peer. Verified live: 35 stacked items in ~30 min covering `dawn`, `ai-guy`, `codey`, `instar-codey`, `8c7928aa…`.

**Fix.** Replace the strike counter with a **durable per-peer cooldown**: a peer's `lastEscalatedAt` ISO is persisted to `<knownAgentsDir>/collab-redrive-escalation-log.json`; the engine escalates only if `(now - lastEscalatedAt) >= unreachableEscalationCooldownMs` (default 24h). New config knob `unreachableEscalationCooldownMs`. Within a single tick, multiple commitments to the same unresolvable peer collapse to exactly one escalation. The log survives restart so a server bounce does not re-flood.

**Tests added.** First sweep escalates once; sweeps within 12h produce zero new escalations; sweep past 24h produces one renewed escalation. Five commitments to the same peer in one tick → exactly one escalation. A fresh engine instance reading the same log respects the cooldown (restart-survival).

## 1-7 Side-effects review
1. **Over/under-block** — Strictly less escalation than before. The cooldown can be lowered if rare repeats are wanted; the cap is a knob, not a hard rule.
2. **Level-of-abstraction** — Reuses the existing `raiseAttention` injected dep + a tiny on-disk JSON sibling to `known-agents.json`. No new transport.
3. **Signal vs Authority** — The cooldown is purely a *delivery throttle* on a signal; the underlying engine behaviour (skip-don't-increment on unresolved) is unchanged. The operator still receives the signal — just once per peer per day.
4. **Interactions** — Touches only the resolveFingerprint code path and the per-peer escalation path in `tick()`. No effect on the durable redrive cap, the per-peer 24h send cap, the engine-wide daily fuse, the per-tick fuse, or the completion gate.
5. **Rollback** — Both fixes are confined to `CollaborationRedriveEngine.ts`. Reverting restores the original behaviour with no data implications. The escalation log file is a stateless cache (deleting it just allows one more escalation per peer).
6. **Data integrity** — No commitment-record mutations beyond what shipped in #490. The new on-disk log is a write-only-rotate map of `{peerKey: iso}` — corrupt JSON parses to empty (fail-open into a renewed escalation, not a stuck silent state).
7. **Failure modes** — (a) Log file write fails → warn + continue without persisting (engine state degrades to in-memory, not to flood). (b) Clock skew makes `lastEscalatedAt` parse to NaN → cooldown treats as elapsed → re-escalates once (then records a sane timestamp). (c) Multi-machine scenario where two engines escalate the same peer near-simultaneously → at most one extra item due to write race; acceptable, the file is per-agent-home.
