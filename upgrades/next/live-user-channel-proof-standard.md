# Live-User-Channel Proof — the gold-standard testing standard + multi-machine transfer fix

## What Changed

A new constitutional standard — **"Live-User-Channel Proof Before Done"** — plus its
structural enforcement, plus the first feature held to it: the cross-machine topic-transfer
fix.

- **The standard** (`docs/STANDARDS-REGISTRY.md`): a user-facing feature is not "done"
  until a user-role session has driven it end-to-end through its real user surface
  (Telegram AND Slack for a channel feature) before the operator is ever asked to test.
  Migrated to existing agents via the CLAUDE.md template + `PostUpdateMigrator`.
- **The completion gate** (`LiveTestGate` + `LiveTestArtifactStore`, wired into
  `POST /autonomous/evaluate-completion`): refuses a "done" verdict for a user-facing
  feature without a verified, signed live-test artifact. Ships DARK + dev-gated
  (`monitoring.liveTestGate`, mode dry-run) — it COMPUTES the veto and logs it, but only
  `mode:veto` overrides a verdict, and even then the only effect is keeping the run
  working (the safe direction).
- **The user-role harness core** (`LiveTestHarness`): runs a scenario matrix as the user
  over an injected channel driver, writes the signed artifact the gate reads, and refuses
  volatile/permission scenarios on a non-demo channel.
- **The transfer fix** (`LocalSessionOwnershipStore` + `OwnershipApplier`, wired DARK
  behind `multiMachine.durableOwnership`): the cross-machine ownership store is now durable
  and replicated (it materializes ownership on the target from the replicated placement
  journal), so a topic seat genuinely moves between machines. `POST /pool/transfer` now
  reports an honest `seatMoved` instead of a bare `ok:true`.

## What to Tell Your User

Nothing changes in normal use yet — everything ships dark behind flags and is dogfooded on
development agents first. The point of the work: I should never again report a feature
"done" without having tested it the way *you* would — by acting as you, through the real
channels — so you stop being the one who discovers a broken feature. The first feature held
to that bar is the "move a conversation between my machines" fix.

## Summary of New Capabilities

- `GET`/route surface: the completion gate post-checks `/autonomous/evaluate-completion`
  (dark/dev-gated, dry-run default).
- `POST /pool/transfer` now returns `seatMoved` (+ a reason when false).
- New dev-gated flags: `monitoring.liveTestGate.{enabled,mode}`,
  `multiMachine.durableOwnership.enabled` (both omit `enabled` → live-on-dev / dark-fleet).
- The constitution carries the "Live-User-Channel Proof Before Done" standard, migrated to
  existing agents.

## Evidence

**The bug being fixed (transfer):** 2026-06-15, the operator ran `POST /pool/transfer
{topic, to:"Mini"}` on a live Telegram topic. Observed BEFORE: response `ok:true`, but the
seat never moved — the next message routed back to the Laptop (the operator found it on the
first live interaction). Root cause, grounded in the running code (v1.3.586):
`SessionOwnershipRegistry` used `InMemorySessionOwnershipStore` with no cross-machine
replication — the placement was written into the source machine's in-memory Map and never
materialized on the target (`server.ts:16002` owner-resolution reads null → `SessionRouter`
treats it as unowned → places locally instead of forwarding).

**Observed AFTER (in tests — live hardware proof is the tracked next phase):** the durable
store + `OwnershipApplier` converge a transferred topic to exactly one owner (the target)
across a simulated crash mid-move (`tests/integration/ownership-transfer-crash-safety.test.ts`);
`POST /pool/transfer` now returns `seatMoved:false` with a reason when ownership did not
move. The gate's anti-hallucination check rejects a hand-edited artifact (hash-mismatch),
and the wired completion route overrides a `met:true` verdict for a user-facing feature with
no verified artifact (`tests/integration/live-test-gate-completion-route.test.ts`). 49 new
tests across 8 files, all green; full pre-commit lint suite + tsc clean. The end-to-end LIVE
Laptop↔Mini proof is the explicitly-tracked next phase (this ships the foundation dark).

