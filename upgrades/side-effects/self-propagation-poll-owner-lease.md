# Side-Effects Review — Self-Propagation, Part 1 (Poll-Ownership Lease)

**Spec:** docs/specs/SELF-PROPAGATION-HARNESS-SPEC.md (approved: true) — Part 1 of two. Part 2 (`instar test-as-self` harness) ships as a separate PR under the same approved spec.

Closes the Telegram 409 dual-poll **class** structurally. Telegram allows exactly one long-poller per bot token. instar has two potential pollers — the lifeline (canonical, forwards to the server) and the server's `TelegramAdapter` (`telegram.start()`). The server only enters send-only when started with `--no-telegram` or on a standby machine; nothing structurally detects that a lifeline already owns the slot. Start the server without `--no-telegram` while a lifeline polls the same token → guaranteed 409 (the 2026-05-27 live-test failure mode). This was operator discipline, not structure.

## What changed
- `src/lifeline/TelegramPollOwnerLease.ts` — NEW. `tokenHash(botToken)` (SHA-256 hex; security contract: NEVER stores the raw token), `writeLease(stateDir, token, pid, now?)` (atomic tmp+rename + best-effort never-throws), `readLease(stateDir, now?, staleMs?)` (fail-OPEN at every error path — missing/unparseable/wrong-shape/wrong-version/stale all return null), `lifelineOwnsPoll(stateDir, token, now?, staleMs?)` (the server's one-question API). Lease lives at `state/telegram-poll-owner.json`. Default staleness 90 s (comfortably > 2× Telegram long-poll timeout + backoff; clears within ~minute when the lifeline genuinely dies).
- `src/lifeline/TelegramLifeline.ts` — calls `writePollOwnerLease(stateDir, token, pid)` right after the successful-poll reset block (after `consecutive409s = 0`). Refreshes the heartbeat on every successful tick. Best-effort + non-throwing — a lease-write hiccup never disturbs the polling loop.
- `src/commands/server.ts` — before the send-only vs full-poll branch, computes `lifelineOwnsPolling = lifelineOwnsTelegramPoll(stateDir, token)`. The send-only branch now ALSO triggers when `lifelineOwnsPolling` is true; the full-poll branch is gated on `!lifelineOwnsPolling`. Send-only log now distinguishes "lifeline owns polling (lease detected)" so operators see the structural decision in action.

## Tests
- `tests/unit/TelegramPollOwnerLease.test.ts` (16) — `tokenHash` security contract (never contains the raw token) + determinism + uniqueness; round-trip write/read; on-disk file never contains the raw token; overwrite-refreshes; ALL of the fail-OPEN paths (missing, unparseable, wrong-shape, unknown-version, stale); the lifelineOwnsPoll decision matrix — both sides of every boundary (live+match=TRUE; live+mismatch=FALSE; stale=FALSE; missing=FALSE; corrupted=FALSE).
- `tests/unit/poll-owner-lease-wiring.test.ts` (4) — lifeline import + call in the success branch; server import + the `lifelineOwnsPolling` computation; the send-only branch includes the new term; the full-poll branch is gated on `!lifelineOwnsPolling`; the server NEVER writes the lease (single-writer = lifeline only); the lease path is stable. Guards the PR#334 dead-code failure mode.

## Signal vs authority
- The lease is a SIGNAL (the lifeline declares "I'm polling"). The server holds the AUTHORITY to act on it (auto-demote). The lifeline never tries to demote the server itself.
- Fail-OPEN is the safety polarity: ANY read miss, any malformed lease, ANY mismatched tokenHash, ANY stale heartbeat → the server polls as today. The lease can only ever CAUSE silence; we err on the side of NEVER silencing a fine agent.

## Security
- The bot token is the secret. The lease stores its SHA-256 hash, never the raw value. Verified by a unit test against both the in-memory return AND the on-disk file. A read of `state/telegram-poll-owner.json` reveals only `{pid, tokenHash, heartbeatTs, v}`.
- File mode follows the stateDir's existing convention (no special mode set; atomic via tmp+rename so a partial write is never observable).

## Over/under-demote
- OVER (server falsely demotes to send-only): mitigated by tokenHash match (a lifeline polling a DIFFERENT token doesn't trigger demote) + 90 s staleness. Worst case: a still-live lifeline + same-token + same-machine → exactly the scenario we WANT demote in.
- UNDER (server fails to demote when it should): the lease must be present + fresh + token-match. Race window at lifeline startup before the first successful poll (lease not yet written) — acceptable: the existing 409-backoff handling absorbs the brief window, and within one poll tick the lease is up.

## Near-silent compliance
N/A — no new user-facing notifications. The server's send-only log line gains one descriptor ("lease detected").

## Migration parity
- Server + lifeline source ship in the same version → no agent-installed-file change, no config change. The new behavior takes effect on first server restart after update (the existing lifeline writes the lease; the new server reads it). Existing setups without a lifeline poller see ZERO behavioral change (fail-OPEN preserves current full-poll path).

## Rollback
Revert the 3 files (one new module + two callsite edits) + the 2 tests. Worst case: agents return to today's "operator discipline" model (start with `--no-telegram` to avoid the 409). No data migration concern (the lease file is stateless ephemera — safe to leave behind or delete).

## Tests / verification
- Tier 1 unit: TelegramPollOwnerLease + wiring-integrity (above; 20 tests green).
- Tier 3 live: test-as-self before merge — start the lifeline + start the server on the same machine WITHOUT `--no-telegram` and confirm the server logs "lifeline owns polling (lease detected)" and Telegram returns no 409. (This is what Part 2 — the harness — automates.)

## NOT in this PR (tracked)
- Part 2: the `instar test-as-self` CLI command + skill (a much larger, hardware-touching deliverable).
- Live mmtest OOM crash reproduction (only possible under the harness in Part 2).
