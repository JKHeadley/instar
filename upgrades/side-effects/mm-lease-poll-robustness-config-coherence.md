# Side-Effects Review — Phase 2 #7 startup config-coherence WARNINGS

**Change:** Add `checkMultiMachineConfigCoherence` (pure) + wire it to LOG warnings at server boot (multi-machine only). Flags the audit's worst-of-both state — `meshTransport.enabled:false` while `sessionPool.stage:live-transfer` (transfer live but single-rope, reintroducing the lease flap) — and duplicate/non-positive mesh rope priorities. WARN-only — NEVER a boot reject.

**Files:** `src/core/configCoherence.ts` (new pure checker), `src/commands/server.ts` (boot-time log), `tests/unit/configCoherence.test.ts`.

## Phase 1 — Principle check
Signal only — it logs warnings; it NEVER throws or blocks boot. Per the audit (F-CLAMP1), a hard-reject invariant would refuse fleet boot on a default-config combination, so this is deliberately advisory.

## 1-8
- Over/under-block: N/A (logs only). Single-machine → no warnings (harmless no-op there). Undefined config → no warnings (never throws).
- Abstraction: pure checker + a thin boot-time log call. Right layer (boot, where config resolves).
- Signal vs authority: pure signal; boot is never blocked. (Ref docs/signal-vs-authority.md.)
- Interactions: reads `config.multiMachine` at boot, after the coordinator starts; no mutation.
- External: yellow `⚠ config-coherence [...]` boot log lines only.
- Multi-machine: only runs when `coordinator.enabled` (a real multi-machine agent); the exact combination it flags is the one my 2026-06-20 morning band-aid created.
- Rollback: trivial (remove the boot call; the pure checker is inert).

## Verification
- `tsc --noEmit` clean. `tests/unit/configCoherence.test.ts` 7/7 (mesh-off-while-live-transfer; single-machine no-flag; mesh-on coherent; duplicate priorities; non-positive priorities; well-formed no-warn; undefined no-throw).

## Phase 5 — Second-pass review
Not required — a pure WARN-only config check that logs at boot; no authority, no gate, never blocks boot, no session/messaging/recovery path touched.
