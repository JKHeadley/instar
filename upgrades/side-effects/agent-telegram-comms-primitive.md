# Side-Effects Review — Agent-to-Agent Telegram comms primitive (core logic, PR 1)

**Spec:** `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` §Fix 2a (converged, approved by Justin
2026-05-27). Convergence report: `docs/specs/reports/mentor-live-readiness-convergence.md`.
**Change:** New module `src/messaging/AgentTelegramComms.ts` — the PURE, security-critical
core of the agent-to-agent Telegram comms primitive: strict marker parse/format, the
recipient routing matrix (every drop branch), and cycle-detection. I/O (the actual Telegram
send, audit ledgers, processed-id store) is **injected**, so this PR is pure logic + tests;
the TelegramAdapter wiring + ledger persistence is PR 2, the mentor consumer is PR 3.
**Files:** `src/messaging/AgentTelegramComms.ts` (new), `tests/unit/messaging/AgentTelegramComms.test.ts` (new).
**Ships dark:** nothing imports the module yet except its test — zero runtime behavior change.

## Principle check (Phase 1)

Decision point? Yes — this is the recipient admission/routing decision (`decideRoute`) and
the anti-loop cycle key. It is built as PURE functions returning a decision the caller acts
on; the blocking authority (drop vs route) is explicit + exhaustively tested. No existing
gate is loosened (nothing wired yet).

## The seven questions

1. **Over-block.** `decideRoute` drops on every ambiguous/unrecognized shape (malformed,
   stale, spoofed, wrong-recipient, unknown-version, unknown-sender, duplicate,
   role-not-allowed). Correct posture for a security boundary — a marker-shaped string is
   guilty until allowlisted. The only fall-through is a genuine no-marker (normal user msg).
2. **Under-block.** The spoof defense (`!senderIsBot && senderChatId===undefined` → drop)
   is the round-2 adversarial F1 closure — a human typing a marker can NEVER reach a
   role-handler, even if from/id match. Tested explicitly. `corr`/`ts` are required in the
   parser so neither the cycle key nor the replay window can be bypassed by omission.
3. **Level-of-abstraction fit.** Pure logic separated from I/O — the security decisions are
   unit-testable in isolation (20 tests, every branch). I/O injection deferred to PR 2.
4. **Signal vs authority.** `decideRoute` IS the authority (drop/route); it returns a typed
   decision + audit reason for every branch (no silent drops — caller writes the audit row).
5. **Interactions.** Module is dark (imported only by its test). No interaction with the
   running system yet. PR 2 wires it into TelegramAdapter (multi-instance + handler-chain);
   PR 3 wires the mentor consumer. Each subsequent PR re-runs the gate against the same spec.
6. **External surfaces.** None in this PR (no routes, no config consumed yet). The marker
   format is the wire contract for PR 2/3 + Codey's side; `A2A_VERSION` is exported for
   version pinning.
7. **Rollback cost.** Trivial — revert removes an unused module. No data, no migration.

## Build-time refinements beyond the spec text

- The spec mentioned `state/a2a-*.jsonl` (append-only JSONL audit) + a processed-id JSON
  store. Convention note (MessageProcessingLedger header: "NOT a new ad-hoc JSON file") —
  PR 2 will implement the processed-id store on the SQLite path (matching
  PendingRelayStore/CommitmentTracker) rather than a JSON file; the append-only audit
  ledgers stay JSONL (Codey designed the audit-row schema as JSONL, and append-only JSONL
  is the right shape for a forensic trail). Flagged here so PR 2's choice is intentional.
- `senderBotId` resolution (`sender_chat.id ?? from.id`) + `senderIsBot` are passed in by
  the caller (PR 2 resolves them from the Telegram update, after the Message type is
  extended to expose `is_bot`/`sender_chat`). The pure core only consumes them.

## Testing

- 20 unit tests (`tests/unit/messaging/AgentTelegramComms.test.ts`), all passing:
  - **Marker parse/format**: valid parse; no-marker (fall-through) vs malformed (drop) —
    incl. missing `corr`, missing `ts`, charset violation, no blank-line separator;
    format↔parse round-trip; format rejects charset-violating fields.
  - **Routing matrix**: route success; fall-through; and every drop branch — malformed,
    stale/future (replay), **user-spoof** (human-typed marker dropped even when from/id
    match), group bot-as-channel accept, wrong-recipient, unsupported-version, unknown
    sender, bot-id mismatch, duplicate, **role-not-allowed-from-source** (notify from echo
    dropped even though notify is a known role), unknown-role.
  - **Cycle-detection**: key never collapses (corr always present); trips within window,
    clears after; no collision on different corr.
- tsc --noEmit clean.
- PR 2/3 add the integration + e2e tiers (TelegramAdapter wiring, mentor consumer, the
  bidirectional contract test, the supervised live cycle).

## Migration parity

None for this PR — a new unwired module. No agent-installed file changes, no config, no
routes. PR 2/3 carry the config defaults + migration (file-outbox retirement, dead-config
removal) per the spec's §Migration parity.
