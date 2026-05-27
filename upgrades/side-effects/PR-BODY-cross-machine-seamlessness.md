# Cross-Machine Seamlessness — one agent that follows the user across machines

Implements the converged + approved **Cross-Machine Seamlessness** spec
(`docs/specs/CROSS-MACHINE-SEAMLESSNESS-SPEC.md`), grounded in the 2026-05-26
real-hardware Phase-0 run. Closes the gap between "a backup machine can take
over" and "the same agent follows you across machines with no amnesia and no
double-replies."

## What this fixes (the Phase-0 findings)
- **G2 — auto-sync never fired.** A self-electing machine changed its role but
  nothing pushed it to git. Now `roleChange`/`leaseEpochChange` → a debounced,
  single-writer `RegistrySyncDebouncer` push (the wiring is named + a
  wiring-integrity test reproduces the original failure and proves it caught).
- **G1 — split-brain.** Two machines both showed `awake`. Replaced with a
  **fenced lease** (clock-proof, epoch-fenced CAS); `shouldSkipProcessing` gates
  on `holdsLease()`, so a wedged old-awake is structurally fenced out. A holder
  that can't confirm its lease over a shared medium for > leaseTtlMs
  self-suspends (no partitioned-old-awake split-brain).
- **G3 — the seamless channel experience.** Durable message-processing ledger
  (no-loss / no-duplicate-reply, structural), fencing-gated outbox, encrypted-
  live-tail buffer with sequence-dedup + secret redaction, and a HandoffSentinel
  that yields the lease ONLY on a verified ack + passing validation (else stays
  awake). Channel Seamlessness Contract implemented by Telegram (reference) +
  Slack (second target).

## Layers (commit-by-commit)
1. Foundations + G2 auto-sync (types, config resolver/validator, FencedLease,
   RegistrySyncDebouncer, registryReplayGuard, the named wiring).
2. G1 fenced-lease leader resolution (LeaseCoordinator + GitLeaseStore + live
   coordinator integration).
3. G3 idempotent ledger + handoff lifecycle + adapter contract.
4. G3 live-tail buffer + redaction + fenced outbox.
5. Observability (`/health.multiMachine.syncStatus`) + agent awareness
   (CLAUDE.md generate + migrate).
6. Telegram + Slack Channel Seamlessness Contract.

## Tunability, migration parity, observability
- All §9 knobs under `.instar/config.json` → `multiMachine`, with startup
  invariant validation (a violating config is rejected, not run silently).
- Knobs default in code (existing agents get the feature without config bloat);
  server code ships automatically; SQLite stores self-initialize; CLAUDE.md
  awareness is migrated to existing agents.
- `/health.multiMachine.syncStatus` (leaseHolder, leaseEpoch, holdsLease,
  splitBrainState, awakeMachineCount, protocolVersion) — the Phase-1
  feature-alive surface.

## Tests
~100 new unit tests (real Ed25519, real SQLite): lease CAS/fencing/clock-skew/
livelock, registry replay/epoch/unknown-key guard, the Phase-0-catching push
wiring test, message-ledger redelivery/stuck-recovery/dual-medium marker,
fenced-outbox suppression, live-tail sequence-dedup/gap-discard, redaction,
HandoffSentinel verify-before-yield (every abort gate), feature-alive syncStatus,
and Telegram + Slack contract conformance.

## Deliberate staging (honest)
- The **live cross-machine handoff TRANSPORT** (server-to-server live-tail + ack
  over the wire) and the **inbound-dispatch integration** of the ledger/outbox
  are the validation-phase work proven by the real-hardware gate (test-as-self
  over Telegram on two machines). The machinery is built + unit-tested here; the
  wire integration lands with the hardware validation.
- Onboarding/self-propagation gaps are tracked to ACT-156 (companion spec).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
