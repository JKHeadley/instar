# Side-Effects Review — B4 clock-skew alarm decision core (multimachine-lease-poll-robustness, Decision 9)

**Change:** Add the pure clock-skew early-warning decision (`evaluateClockSkew`): given a measured cross-machine offset (max(ewma,last)) + this machine's own NTP-sync status, decide whether to raise an EARLY-WARNING below the 30s MeshRpc reject cliff, with hysteresis and N=2 self-blame attribution (blame self when own clock is unsynced; the peer when ours is verified synced; unknown when unprobed — never a confident finger-point). Pure, observe-only.

**Files:** `src/core/clockSkewAlarm.ts` (new), `tests/unit/clockSkewAlarm.test.ts`.

**Rollout sequencing (deliberate):** decision CORE first (fully unit-proven). The measurement wiring — a round-trip offset on the 5s lease-pull from the SIGNED `env.timestamp` (read pre-reject so it can report even past 30s), the own-NTP probe, and surfacing in `getSyncStatus`/a read route + a deduped Attention — is the follow-up. Tracked: spec Decision 9 + CMT-1710.

## Phase 1 — Principle check
Pure decision, no authority. It NEVER widens the MeshRpc 30s reject (replay-safety) — it only decides an advisory alarm. Fails toward not-alarming on uncertainty (within tolerance / unprobed NTP → no confident blame).

## 1-8
- Over/under-block: N/A (advisory). Correctness (unit-tested): early threshold (alarm at 20s, below the 30s break), hysteresis (clear at 12s), abs (step skew), self/peer/unknown blame.
- Abstraction: pure decision isolated from the (later) mesh measurement.
- Signal vs authority: pure signal — never the reject decision. (Ref docs/signal-vs-authority.md.)
- Interactions: none yet (no consumer). When wired: reads the measured offset + own-NTP, raises one deduped Attention.
- External: none (pure module).
- Multi-machine: inherently the N=2 attribution problem — encodes self-blame so two machines don't both finger-point. Single-machine: no peer → never measured → no alarm.
- Rollback: trivial (pure module, no consumer).

## Verification
- `tsc --noEmit` clean. `tests/unit/clockSkewAlarm.test.ts` 6/6.

## Phase 5 — Second-pass review
Not required — pure decision module, no consumer/authority, no session/messaging/recovery path. Full second-pass at the measurement-wiring increment.
