# Side-Effects Review — a2a audit ledger + processed-id store (PR 3a)

**Spec:** `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` §Fix 2a "Round-trip audit ledger" +
"Processed-id ledger" + Codey's round-2 idempotency-on-receive design point. PR 3 of the
staged build, part a.
**Change:** Two new storage primitive modules the receiver wiring (PR 3b) will consume:
`AgentTelegramLedger` (append-only JSONL of sent + received audit rows) and
`ProcessedIdStore` (bounded persistent set of recently-processed marker `id`s for Telegram
retry / restart idempotency). Both **dark** — no caller yet; PR 3b wires the recipient
handler at `server.ts` and uses these.
**Files:** `src/messaging/AgentTelegramLedger.ts` (new), `src/messaging/ProcessedIdStore.ts`
(new), `tests/unit/messaging/AgentTelegramLedger.test.ts` (new — covers both).

## The seven questions

1. **Over-block.** N/A — no gate. The ledger always writes; the store only blocks on a
   recorded `id` (the idempotency guarantee).
2. **Under-block.** Ledger writes are **best-effort + non-throwing** — an audit-write
   failure must not crash a tick (spec note: "silent drops make Stage-B forensics painful,
   but a crashed tick is worse"). Tested: pointing the ledger at an unwritable path → no
   throw. The store's persistence is also best-effort (warn + continue on persist failure,
   retry on next mark).
3. **Level-of-abstraction fit.** Each module owns ONE thing — ledger appends rows; store
   answers "have I seen this id." Both injectable for PR 3b's wiring + tests. JSONL append
   is intentional (atomic at line granularity on POSIX for `<PIPE_BUF`); SafeFsExecutor's
   atomic-write-replace is wrong for append (documented in module header so a future
   reviewer doesn't "fix" it incorrectly).
4. **Signal vs authority.** N/A.
5. **Interactions — both modules are dark.** No caller, no runtime side-effect. PR 3b
   integrates them into the recipient handler. The ReceiveAuditRow shape is the wire
   contract for Stage-B forensics + future debugging.
6. **External surfaces.** None new. Default paths are `{stateDir}/a2a-sent.jsonl` +
   `{stateDir}/a2a-received.jsonl` + (PR 3b chooses) `{stateDir}/a2a-processed-ids.json`.
   Caller may override.
7. **Rollback cost.** Trivial — revert removes two unused modules. No data, no migration.

## Convention notes

- **JSONL ≠ SQLite for these two cases.** The MessageProcessingLedger header explicitly
  prefers SQLite for dedup ledgers ("NOT a new ad-hoc JSON file") — and we follow that
  spirit by isolating the data behind a class boundary (a SQLite swap-in is one constructor
  away). The current JSON-file backing is justified for `ProcessedIdStore` because the
  working set is small (bounded 10k entries / 30d), atomic-write-rewrite is cheap at that
  size, and there's no concurrent-writer story to need WAL. For `AgentTelegramLedger`,
  JSONL append IS the right shape (forensic trail, append-only, line-atomic).
- **Eviction policy + the round-2 adversarial F2 surface.** The store evicts by
  `maxEntries` (10k) OR `maxAgeMs` (30d) — whichever first. A replayer who captured an `id`
  outside that window could re-inject it; the **defense at that layer is the marker's
  `ts` + `skewWindowMs` (24h)** added in PR 1 (already shipped). The store's job is
  "de-dup within the legitimate-retry window," not "absolute replay protection." Documented.

## Testing

8 unit tests, all green:
- **Ledger**: appendSent + appendReceived to distinct files (+ JSONL line-per-row); drop
  row with `dropReason` captured (the routing-matrix audit trail); **never throws** when
  the target is unwritable (best-effort guard tested).
- **Store**: mark + recall + persist-across-reopen; eviction by `maxAgeMs`; eviction by
  `maxEntries` (oldest first); corrupt-file recovery (start fresh, don't crash); idempotent
  re-mark (first-seen-ts preserved).
- `tsc --noEmit` clean. Both modules dark (no caller).

## Migration parity

None — two new unwired modules. No agent-installed file changes, no config consumed yet.
PR 3b adds the recipient handler wiring + `mentor.processedIdStorePath` (or similar) to
config defaults; PR 3c (mentor consumer) adds the file-outbox retirement + dead-config
removal migrations per the spec's §Migration parity.
