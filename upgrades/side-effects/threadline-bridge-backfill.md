# Side-Effects Review — Threadline Bridge Backfill Script

**Version / slug:** `threadline-bridge-backfill`
**Date:** `2026-05-02`
**Author:** `echo`
**Second-pass reviewer:** `self (incident-grounded reasoning)`

## Summary of the change

Final deliverable in topic-8686. Ships a one-shot CLI script that
backfills threadline-message history into Telegram topics using the
bridge primitives from PR #117 — so the user has a complete picture of
agent-to-agent traffic, including conversations that landed BEFORE the
bridge shipped.

Files added:

- `scripts/threadline-bridge-backfill.mjs` — the CLI script. Reads the
  agent's canonical inbox/outbox files (PR #113, PR #118), an optional
  seed file of historically-reconstructed messages, and the existing
  bridge bindings. Creates Telegram topics with the bridge naming
  pattern, posts a backfill banner explaining what the user is seeing,
  then posts each message chronologically with chunking under 4000 chars.
  Idempotent via a per-thread ledger at
  `.instar/threadline/bridge-backfill-ledger.json`.
- `src/threadline/BackfillCore.ts` — pure helpers (`buildTopicName`,
  `chunkBody`, `groupByThread`, `pickCounterparty`, `ledgerKey`,
  `formatBackfillMessage`). Source of truth for the contract; the
  script's inline copies must stay in sync.
- `tests/unit/BackfillCore.test.ts` — 16 unit cases pinning the contract.

Files modified: none (this PR is pure additions on top of the four
prior PRs in the topic-8686 set).

## Decision-point inventory

- `scripts/threadline-bridge-backfill.mjs` — **add** — CLI with
  `--state-dir`, `--port`, `--threads`, `--seed`, `--dry-run`,
  `--no-create` flags. Calls `POST /telegram/topics` to create and
  `POST /telegram/post-update` to post.
- `BackfillCore.buildTopicName` — **add** — same shape and limits as
  `TelegramBridge.buildTopicName` from PR #117.
- `BackfillCore.chunkBody` — **add** — fixed 3800-char chunks with no
  word-boundary alignment (Telegram preserves whitespace; visual
  continuity is acceptable).
- `BackfillCore.groupByThread` — **add** — combines inbox + outbox +
  seed; sorts each thread chronologically.
- `BackfillCore.formatBackfillMessage` — **add** — emoji prefix
  (📥 / 📤), counterparty name, ISO timestamp, body.
- Backfill ledger format — **add** — `{ version: 1, threads: { [threadId]: { topicId, topicName, posted: [...], lastBackfillAt } } }`.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The script is purely additive and doesn't gate any existing flows.
Validation:

- Empty / unparseable seed file → warn + treat as `[]`.
- Thread with no on-disk or seed messages → warn + skip.
- `--no-create` + no existing binding → warn + skip (the user explicitly
  asked NOT to create topics).
- `--dry-run` → prints the plan without making any HTTP calls.

No false-positive rejects. The `--threads` filter is exact-match on
threadId; that's intentional — partial matching here would be a
foot-gun (accidentally backfilling more threads than intended).

## 2. Under-block

**What failure modes does this still miss?**

- **Orphan topics on partial-success.** If topic creation succeeds but
  the first message post fails, we have a Telegram topic with only the
  banner. Acceptable — the ledger records the topic id; a re-run
  picks up where it left off and posts the remaining messages.
- **Order-of-arrival sensitivity for the first run.** If two backfill
  invocations race, both could create a topic for the same thread.
  Mitigation: the ledger write is the second step (after creation); a
  duplicate would be detectable and could be removed manually. This
  script is one-shot, intended to be run by Justin on demand, not
  scheduled — the race window is hypothetical.
- **No HMAC verification of inbox/outbox lines.** The script trusts
  the JSONL files. Same posture as the observability layer in PR #118:
  the HMAC is for tamper-evidence at write time; reading for
  user-visible mirroring doesn't need to re-verify (no decision
  surface). If a tampered line surfaces in Telegram, the user sees
  it in the conversation view and can investigate.
- **No quota-aware throttling beyond a 250ms gap.** Telegram's
  default rate limit is ~30 messages/second to the same chat;
  4 messages/second is well below. If a thread has 1000+ messages
  this still completes in ~4 minutes, which is acceptable for a
  one-shot.

## 3. Level-of-abstraction fit

The script is a CLI wrapper over the agent's existing
`/telegram/topics` and `/telegram/post-update` HTTP routes. It
deliberately does NOT:

- Instantiate `TelegramAdapter` directly — would duplicate the agent
  server's connection state.
- Call `TelegramBridge.mirrorInbound` — the bridge writes its own
  bindings file; the script reuses that file. We don't go through the
  bridge because the bridge would consult `TelegramBridgeConfig`
  (default-OFF) and refuse to post; the script's purpose is to
  backfill regardless of the live policy.
- Touch the canonical inbox/outbox files — those are append-only
  signals from the live agent; the script reads them but never
  rewrites them.

Putting the pure helpers in `src/threadline/BackfillCore.ts` keeps
them tsc-checked and unit-tested while letting the script stay a
plain `.mjs` (no build step required to run).

## 4. Signal-vs-authority compliance

- **Signal:** the on-disk inbox/outbox files; the optional seed file.
- **Authority:** none. The script has no decision surface on the
  routing path — it doesn't gate or alter any threadline flow. The
  Telegram topic creation goes through the existing `/telegram/topics`
  route, which is the authority for forum-topic creation.

The script intentionally **bypasses** `TelegramBridgeConfig` because
backfill is an explicit user action. The user already opted in by
running the script with the relevant `--threads` argument; consulting
the dashboard toggle would re-derive that consent. The script's
output is fully auditable in the ledger.

## 5. Interactions

- **PR #113 (canonical inbox).** Reads `inbox.jsonl.active`. No write.
- **PR #117 (bridge module).** Reads `telegram-bridge-bindings.json`.
  Reuses existing bindings (no new bridge-side artifact unless the
  script creates a topic, in which case the next live `mirrorInbound`
  / `mirrorOutbound` call will see the binding via the bindings file
  the script writes — wait, NO: this script does NOT write to
  `telegram-bridge-bindings.json`. It writes only to its own ledger.
  This means the live bridge has no awareness of script-created
  topics until a new bridge-driven message comes through, at which
  point `findOrCreateForumTopic` returns the existing topic id and
  the bridge writes its own binding. This is desirable: the bridge
  remains the only writer of `telegram-bridge-bindings.json`,
  preserving single-writer simplicity.
- **PR #118 (observability tab).** Reads `outbox.jsonl.active` (which
  PR #118 now writes). No write.
- **`/telegram/topics` route.** Existing route, unchanged.
- **`/telegram/post-update` route.** Existing route, unchanged.
- **Backfill ledger.** New file at
  `.instar/threadline/bridge-backfill-ledger.json` — the script is the
  only writer. Format is versioned (`version: 1`) so future format
  changes can land without breaking older ledgers.

## 6. Rollback cost

- The script is a CLI; not running it is the rollback. No recurring
  process, no background job, no config flag.
- If a bad backfill posted unwanted content to Telegram, the user
  deletes the topic via the Telegram UI. The script's ledger entry
  for that thread can be removed manually (`rm` the
  `bridge-backfill-ledger.json` entry), and a re-run with
  `--no-create` will skip the deleted thread.
- `BackfillCore.ts` is unused outside the test file (the script
  duplicates the logic inline) — drop the file with no import
  consequences.

## Plan if a regression appears

- **Symptom: script creates duplicate topics.** Check the ledger;
  ensure the thread's `topicId` field is populated. If null, the
  topic-creation HTTP call must have failed mid-flight; re-running
  is safe (the `bindings` lookup will find the orphan binding from
  the previous run via the agent's bridge if it ran since). If
  duplicates persist, delete one in Telegram and remove its ledger
  entry.
- **Symptom: messages posted in wrong order.** The grouping step
  sorts by ISO timestamp. If timestamps are missing or non-ISO,
  inbound/outbound order can drift. Check the seed file for
  timestamp consistency.
- **Symptom: rate-limited by Telegram.** Increase the `SEND_GAP_MS`
  constant or add `--gap <ms>` flag. Documented in the script header.

## Phase / scope

Final of five deliverables in topic-8686. Closes the build:

1. (a) Canonical inbox write-path — **MERGED** (#113).
2. (2) Settings surface — **MERGED** (#114).
3. (b) Bridge module — **MERGED** (#117).
4. (4) Observability tab — **PR open** (#118).
5. **(c) Backfill script — THIS PR.**

After this PR ships, Justin can use the dashboard's Threadline tab to
see live agent-to-agent traffic in real time (post-bridge-enable),
and run the backfill script to populate Telegram with any historical
threads he wants visible. The four specific threads named in the
topic-8686 brief (worktree-audit handoff, Dawn first handoff, Dawn
four-spawn thread, GROUND-TRUTH round-trip) can be backfilled by
running the script with a `--seed` file containing the reconstructed
historical messages — the script handles topic creation, banner,
chunking, and idempotency.
