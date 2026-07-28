# Side-Effects Review — agent-to-agent Telegram comms: send side + audit (PR 2b)

**Spec:** `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` §Fix 2a "Sender side" + anti-loop #1 +
round-2 adversarial F5 (token-leak scrub). PR 2 of the staged build, part b.
**Change:** Extend `src/messaging/AgentTelegramComms.ts` with `sendAgentMessage` (the
adapter-agnostic send function), a `SendAuditRow` schema + appender hook, and `scrubToken`
(redacts the bot token from any error surface before it leaves the module). I/O still
**injected** — fully unit-testable; no caller invokes it yet (dark). PR 3 wires it.
**Files:** `src/messaging/AgentTelegramComms.ts` (additive), `tests/unit/messaging/AgentTelegramComms.test.ts` (+5).

## What changed

- `sendAgentMessage(input, deps)` — mints/uses `a2aId` (UUID-or-supplied), defaults
  `correlationId` to `id` (prompts self-correlate; replies thread on the prompt's id),
  formats the marker via `formatMarker`, calls the injected `deps.send(topicId, text)`,
  and writes ONE audit row (always — on `ok`, `failed`, or `role-refused`). Returns
  `{ok, a2aId, sentMessageId?, reason?}`.
- **Runtime anti-loop guard** (spec §Fix 2a anti-loop #1): refuses any `role` not in
  `deps.allowedRoles` — NO send attempted, NO marker formed, audit row with
  `result: 'role-refused'`. This makes the import-surface lint (deferred to PR 3) a
  backup rather than the only defense; the runtime guard always applies.
- `scrubToken(s, token)` — redacts the bot token (full + secret-portion) from any
  string before it leaves the module. Wired into every error/audit path in
  `sendAgentMessage` (round-2 adversarial F5: Telegram 401 response bodies sometimes
  echo the token).

## The seven questions

1. **Over-block.** The runtime role-refusal is exact — a caller that legitimately needs
   role X passes it in `allowedRoles`. No false-positive refusal.
2. **Under-block.** Every send path writes an audit row (ok / failed / role-refused) — no
   silent drop. Token scrub runs on every reason-string surface (format errors, send
   errors). The audit row schema explicitly forbids secrets (verified in the artifact).
3. **Level-of-abstraction fit.** I/O injected (`send`, `appendAudit`, `now`, `mintId`,
   `botToken`, `fromBotId`, `toBotId`). The function is the wire-level send/marker/audit
   logic; storage choice (JSONL vs SQLite) is the caller's (PR 3 picks).
4. **Signal vs authority.** Send is the authority on "did the message leave my process";
   the result is exact (`ok` only when the adapter returns a messageId). Audit row is the
   signal trail. No silent best-effort.
5. **Interactions — dark, but the module surface is shared with PR 1 + the existing
   `decideRoute`.** The send side adds NEW exports (sendAgentMessage, scrubToken,
   SendAuditRow, etc.) — existing imports unaffected. Dark today.
6. **External surfaces.** None new in this PR. The audit row schema is the wire format
   for future log readers (Stage-B forensics will read it in PR 3).
7. **Rollback cost.** Trivial — revert removes additive exports + tests. No data, no
   migration. PR 1 / PR 2a are not touched.

## Testing

- 5 new unit tests (25 total in the file, all green):
  - **send + audit happy path**: marker round-trips through `parseMarker` (the sender's
    output is the receiver's input — closes the wire-format integration informally);
    `result: 'ok'` audit row with `sentMessageId` + correct fields.
  - **correlation threading**: explicit `correlationId` lands in the marker's `corr=`
    and in the audit row (prompt↔reply linkage via Telegram chat history alone, per
    Codey's round-2 design point).
  - **ANTI-LOOP runtime refusal**: a role not in `allowedRoles` → no send, role-refused
    audit row with explanatory reason. Proves the import-lint isn't the only defense.
  - **send-error with token in body**: adapter throws an error containing the bot token
    → result + audit reason both scrubbed (no token leak through any surface).
  - **scrubToken unit**: full-token + secret-portion + no-token-present + undefined-token
    coverage.
- `tsc --noEmit` clean.

## Migration parity

None — additive exports to a dark module. No config, no routes, no agent-installed file
changes. PR 3 wires the receiver-handler at `server.ts`, the role handlers, the audit
ledger persistence (JSONL append via SafeFsExecutor), and the processed-id store (SQLite
per the convention note flagged in PR 1's artifact); migration (file-outbox retirement,
dead-config removal) lands there per the spec's §Migration parity.
