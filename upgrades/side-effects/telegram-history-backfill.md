# Side-effects review — Telegram history backfill (script tier)

Per L6. Seven dimensions.

## 1. Over-block / under-block

**Before.** Echo had no path to retrieve Telegram history after a local
topic-memory.db truncation. The Bot API is forward-only, so any data loss
in the local mirror was permanent absent a Telegram-side export. The
2026-05-20 native-module cascade exposed this gap.

**After.** The script-tier backfill closes the gap for the post-recovery
scenario. There is no over-block — the script runs only when invoked
explicitly (`--chat` flag required), never silently. No new automatic
behavior is added to any always-on path. Under-block protection: the
importer's UNIQUE-constraint-guarded INSERT OR IGNORE prevents duplicates
even under retries, FloodWait recoveries, and manual reruns.

## 2. Level-of-abstraction fit

Three modules at deliberately different altitudes:

- `topic-memory-importer.mjs` — pure DB logic, unit-tested against the
  real schema. No network, no auth, no gramjs dependency. Trivially testable.
- `telegram-historian.mjs` — gramjs wrapper. Exposes the minimum surface
  needed (connect, listForumTopics, iterTopicMessages). No business logic.
- `telegram-history-backfill.mjs` — orchestration only. Parses CLI flags,
  resolves credentials, ties the two libs together.

Each module is replaceable without touching the others.

## 3. Signal vs Authority compliance

This is the central concern for this PR.

`.instar/secrets/...` is the credential signal. The operator's sealed
file is the authoritative declaration that this account may be accessed
via MTProto. The script reads the signal and acts on it; it has no
authority to mint or rotate credentials.

The session string, once captured, is the long-lived authority. Storing
it at mode 0600 outside any git path is the structural enforcement that
no other process can read it. The operator's Telegram Devices page is
the only revocation channel — exactly the right placement of authority,
because the operator alone owns that surface.

The script's read-only Telegram posture (iter/get only, no send/edit/
delete) is the third layer: even if everything else were compromised,
this code path cannot produce outbound messages or mutations against
Telegram.

## 4. Interactions with adjacent systems

- **instar server (echo's own process).** Holds `topic-memory.db` open
  under WAL mode. SQLite serializes writes across processes, so the
  backfill can write while the server is reading without corruption. The
  FTS triggers maintain the FTS index automatically; tested by
  `tests/unit/topic-memory-importer.test.ts`'s "does not corrupt FTS
  index across re-runs" case.
- **Bot-API polling (TelegramAdapter).** Unaffected. Live messages
  continue to arrive through the bot. The backfill writes the same
  schema with the same constraints, so the live path's INSERT OR IGNORE
  (if any) and the backfill's INSERT OR IGNORE converge to the same
  final state regardless of ordering.
- **Coherence gate / external-operation-gate hook.** The script is a
  local Node process; it does not go through the MCP tool path the
  external-operation-gate intercepts. The gate's authority remains over
  agent-initiated network operations from the harness; this script is
  operator-initiated from the CLI.
- **Migration parity / PostUpdateMigrator.** No agent-installed file is
  modified by this PR. No template change, no hook change, no config
  default change. Existing agents are unaffected by the merge — they
  pick up the script only if they explicitly run it.

## 5. Rollback cost

Trivial. Five files, two libraries, one test, one spec, one ELI16, one
side-effects review. `git revert <merge-sha>` removes the code. The
sealed credential file and the session string file are outside the repo
and unaffected by the revert. The `topic-memory.db` is touched only by
INSERT OR IGNORE, so already-imported rows are correct and stay — no
data restoration needed.

If the operator wants the imported rows undone too, a single SQL command
removes them: `DELETE FROM messages WHERE timestamp < '<backfill cutoff>'`.
This is safe because all writes go through the importer, which can be
disabled by removing the script.

## 6. Backwards compatibility / drift surface

Fully backwards-compatible. The script is additive only — no existing
behavior is modified. The `topic-memory.db` schema is read but never
altered (no migrations). The CLI entry is a new file; nothing references
it from existing code paths.

Drift surface:
- The script targets the schema as it exists 2026-05-20 (read live for
  this PR). A future schema change (e.g. adding a `chat_id` column)
  would require updating `topic-memory-importer.mjs`. The narrow surface
  and unit-test coverage make this easy to spot in code review.
- gramjs (`telegram` package) is a new dependency. Version pin is
  `^2.26.22` — caret range allows non-breaking updates. If gramjs ever
  ships a breaking 3.x, the import surface in `telegram-historian.mjs`
  is small (4 imports, 3 method calls) so adaptation cost is bounded.

## 7. Authorization / Trust posture

The single point where new authority is granted is the operator's
explicit hand-off of `api_id` + `api_hash` (2026-05-20T03:10:18Z via
Telegram topic 10873) and the live SMS-code exchange during `--auth`.
The script grants itself nothing — it only reads what the operator has
already authorized.

The session string, once captured, is the durable artifact of that
authorization. The operator can revoke it via Telegram's Devices UI at
any time; the script will then error on the next run and require a
fresh `--auth`. This places revocation entirely in the operator's hands
with no instar-side dependency.

The "read-only on Telegram" posture is enforced by **not exposing any
write method**, not by a guard the operator must trust. Adding a write
method would require a spec change AND a fresh operator approval — the
review-convergence + approved frontmatter tags would have to be
regenerated, which is the structural enforcement here.

## Outcome

Ship. Incident-driven, single-purpose, read-only, idempotent, unit-tested.
Promotion to a full `src/messaging/TelegramHistorian.ts` feature is a
separate, follow-up PR after the recovery itself is verified end-to-end
against the live lifeline supergroup.
