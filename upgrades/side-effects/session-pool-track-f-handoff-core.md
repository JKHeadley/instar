# Side effects — Track F part 1: Transfer/Handoff core + transfer-by-nickname (§L3/§L5)

## What this adds
Two PURE, side-effect-free cores for the L5 Session Transfer / Handoff Orchestrator, shipped DARK (no boot wiring / no live transfer yet — Track-H stage-gated activation). No runtime behavior change.

- `src/core/TransferByNickname.ts` — `planTransferByNickname(command, state, sessionKey)`: turns an already-recognized NicknameCommand into a gated, validated TransferPlan. Resolves nickname→machineId; REJECTS unknown nicknames (lists valid ones — never silent mis-route); rate-limits rapid-fire transfers per topic; no-ops when already on the target; and applies the §L4 confirmation gate (offline target, or a different owner while mid-reply). This is the brain behind the headline "move this to <nickname>" swap.
- `src/core/TransferOrchestrator.ts` — `TransferOrchestrator.transfer(req)`: drives the §L3/§L5 ordered handoff `active(S) → transferring(e+1) → drain → flush ledger → target pulls+verifies → active(T, e+2) → S-release` (claim-before-release, fenced by status+epoch; no double-run, no no-owner gap). Enforces the two timing contracts: drain bound (`transferDrainTimeoutMs` — abandon partial output, never emit past the deadline) and output exclusion (`transferOutputCutoffMs` — T holds its CONTINUATION until the cutoff since `transferring`, so the emission windows are disjoint). Abort paths: CAS-lost, sync-corrupted (escalates, does NOT claim), target-claim-failed (no release). Plus `verifyLedgerSnapshot()` — the §L5 handoff verify (SHA256 match + every entry terminal, reject any in_flight). All I/O injected → deterministic.

## Risk / blast radius
None — neither module is imported by any boot path yet. Pure functions + new tests only.

## Tests
- `tests/unit/TransferByNickname.test.ts` — 8 tests: transfer/pin, unknown-nickname rejection, rate-limit (and post-window), already-there no-op, offline + mid-reply confirmation gates.
- `tests/unit/TransferOrchestrator.test.ts` — 10 tests: full ordered sequence, output-cutoff hold (and skip when already elapsed), drain-abandon, CAS-lost abort, sync-corrupted escalation (no claim/release), target-claim-failed (no release); verifyLedgerSnapshot accept / sha-mismatch / in-flight-reject.

## Follow-ups (this Track F)
Part 2: Tier-2 integration over the REAL transfer MeshRpc command + real SessionOwnershipRegistry transfer FSM + real ledger-snapshot verify; config tunables (transferDrainTimeoutMs, transferOutputCutoffMs, placementCooldownMs, topicPlacementUpdateMinIntervalMs) with migration parity. Live drain (SessionMigrator) + real git ledger flush + outbound mesh client are Track-H activation (D11).
