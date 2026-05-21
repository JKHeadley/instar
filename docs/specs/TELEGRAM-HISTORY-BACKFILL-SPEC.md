---
review-convergence: "rev-1 — incident-response scope. MTProto backfill primitive driven by the 2026-05-20 topic-memory truncation. Read-only operations only (iter/get, never send). Idempotent import via UNIQUE(message_id, topic_id) + INSERT OR IGNORE. Session string is the long-lived credential, lives behind mode-0600 file perms outside any git path. Scope is the script tier (proof of concept + recovery delivery); promotion to src/messaging/TelegramHistorian.ts is a follow-up PR after the recovery itself is verified."
approved: true
approved-by: "operator (Justin) via Telegram topic 10873 — autonomous-mode handshake 2026-05-20T03:01:41Z (\"go for as long as you need... just make sure you don't break anything or lose data\")"
approved-at: "2026-05-20T20:00:00Z"
---

# Telegram History Backfill — Spec

**Status:** rev 1 (incident response). Approved 2026-05-20.
**Author:** Echo
**Companion:** TELEGRAM-HISTORY-BACKFILL-SPEC.eli16.md
**Goal:** Restore the topic-memory.db rows that were lost when Echo's local store was truncated during the Node 22→25 native-module cascade recovery on 2026-05-20.

---

## Problem

On 2026-05-20, Echo's `better-sqlite3` native module broke when the host Node was swapped from 22 to 25. The recovery procedure restored a working module but left `topic-memory.db` empty (74 messages across 7 topics after recovery, against the prior multi-thousand-message store). The operator's Telegram client retains the full thread history (Telegram is the source of truth for messages they participated in), but Echo's local mirror was lost.

The Telegram Bot API has no history-fetch primitive — it is forward-only by design. Bots see messages that arrive while they are polling and cannot retrospectively read older content. This is a Telegram policy, not an instar bug; it cannot be worked around at the bot layer.

The only path to backfill is a **user-account MTProto session**, which authenticates as the operator's actual Telegram account (not as a bot) and therefore can read everything that account can read. This spec defines the smallest, safest, idempotent implementation of that path.

---

## What ships in this PR

1. `scripts/lib/topic-memory-importer.mjs` — Pure-DB importer that takes a batch of normalized message objects and writes them into `.instar/topic-memory.db`. UNIQUE(message_id, topic_id) + INSERT OR IGNORE is the idempotency primitive. Wraps each batch in a transaction.
2. `scripts/lib/telegram-historian.mjs` — gramjs wrapper. Manages session string load/save (mode 0600), the interactive auth flow (phone → SMS code → optional 2FA), forum-topic listing, and per-topic message iteration via `client.iterMessages({ replyTo: topicId })`.
3. `scripts/telegram-history-backfill.mjs` — CLI entry. Parses flags, resolves credentials, drives auth or backfill. Read-only against Telegram (iter/get only — never send/edit/delete).
4. `tests/unit/topic-memory-importer.test.ts` — 12 cases against a real `better-sqlite3` instance with the production schema. Covers single insert, batch insert, idempotency under re-run, partial-overlap re-run, cross-topic message-id collision, FTS index cleanliness, edge cases, and a regression scenario shaped exactly like the 2026-05-20 incident.

---

## Authority posture (read carefully before extending)

This module authenticates **as the operator's Telegram account**, not as a bot. The operator's account has read access to every chat they participate in — DMs, private groups, channels. That power requires discipline:

- **Permitted operations only**: `iterMessages` (read), `getDialogs` (read), `getMessages` (read), `channels.GetForumTopics` (read).
- **Forbidden operations**: any send/edit/delete/reaction. Adding such a method to this module requires an explicit spec change and a fresh operator approval.
- **Session string is the long-lived credential**. It lives at the path declared in the sealed credentials file, mode 0600, outside any git-tracked directory. When `~/.local/share/instar-echo-secrets/` was created it was set to mode 0700. Migration to a real secret store (Bitwarden, instar's own credential store) is a follow-up; this PR's hard requirement is "not in git, not in agent-home git-sync, not world-readable."
- **Interactive auth surface**: phone number, SMS code, optional 2FA password. These are the only points where operator input enters the flow. After the session string is captured, subsequent runs are non-interactive.

---

## Idempotency contract (the headline property)

The backfill must be **safe to re-run** without producing duplicates. FloodWait recovery, partial-success retries, manual aborts, and operator-initiated reruns must all converge to the same final state.

The mechanism:

```sql
UNIQUE(message_id, topic_id) ON CONFLICT FAIL  -- (the existing schema)
INSERT OR IGNORE INTO messages ...             -- the importer's only write
```

Each `importBatch(messages)` call is wrapped in a single transaction. If any row violates a constraint, the transaction rolls back; otherwise each row either inserts (returns `changes === 1`) or is silently skipped (`changes === 0`). The returned `ImportResult` exposes `{ inserted, skipped, touchedTopics }` for accurate reporting.

`tests/unit/topic-memory-importer.test.ts` proves this contract under realistic shapes — including the exact "post-truncation overlap" pattern that the 2026-05-20 incident produces (4 surviving messages + 50-message incoming batch → 50 inserts, 4 skips).

---

## What this spec does NOT cover

- **Real-time tailing.** This is a one-shot backfill, not a continuous listener. The existing Bot-API polling continues to handle live messages. A future `TelegramHistorian` running as a long-lived service could subsume both, but that is out of scope here.
- **Productization into `src/messaging/TelegramHistorian.ts`.** The script tier is the deliverable for this PR. Promotion to a full instar feature (CLI subcommand, HTTP route, three-tier tests including integration + e2e, CLAUDE.md template update, migration parity) is a follow-up PR after the recovery itself is verified end-to-end.
- **Multi-machine session sync.** The session string is per-machine — running the backfill on a second machine requires a fresh `--auth` there. This is consistent with the existing Telegram session-per-machine posture (per `feedback_mcp_install_is_per_machine` and related infrastructure decisions).
- **Bitwarden integration.** Credentials are currently in a sealed local file because Bitwarden was locked at delivery time. Migration to Bitwarden is a separate, operator-driven follow-up — the script accepts a `--secrets-path` override so the credential format is decoupled from storage location.

---

## Test plan

- [x] `tests/unit/topic-memory-importer.test.ts` (12 cases) green
- [x] `node scripts/telegram-history-backfill.mjs --help` renders correctly
- [x] Missing-credentials path exits 2 with a clear error
- [x] gramjs library loads, `TelegramClient` is a constructor
- [ ] Live auth via `--auth` succeeds (requires operator phone + SMS — blocked on operator availability)
- [ ] Live backfill against the lifeline supergroup runs to completion with non-zero inserts and zero corruption (blocked on auth)
- [ ] Re-run of live backfill produces zero new inserts (the idempotency contract under real Telegram data)

---

## Rollback

`git revert <merge-sha>` removes the script and tests. The sealed credentials file at `~/.local/share/instar-echo-secrets/telegram-mtproto.json` is outside the repo and unaffected. The session string at `telegram-mtproto.session` is similarly outside the repo and unaffected. No state migration, no deployed-agent impact. The `topic-memory.db` is touched only by `INSERT OR IGNORE`, so no rollback is needed for the database itself — already-imported rows are correct and stay.

---

## Outcome

Ship the script-tier primitive. Recover topic-memory.db's lost rows via a live run. Promote to a real instar feature in a follow-up PR once the recovery is verified.
