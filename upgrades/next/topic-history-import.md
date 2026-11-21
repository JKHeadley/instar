# Restore lost conversation history with POST /topic/import

<!-- bump: minor -->

## What Changed

A machine that lost part of its Telegram message log (the 2026-11-20 Mac Studio rebuild lost about 14,000 messages across 167 topics) had no supported way to put the history back. `POST /topic/rebuild` only replays the live log, and appending old rows to the live log makes old messages look like the newest ones, both to the search index and to the background readers that tail the log.

New `POST /topic/import` (agent bearer token only; a paired phone gets 403). It takes a recovered JSONL file inside the state folder, or inline rows. It checks each row against the store's own schema and keys Telegram ids by the existing key rule, skips any message already held, and publishes the accepted rows as one immutable batch under `.instar/topic-history-imports/`. It never writes the live log. Then it re-sequences each affected conversation so restored messages sit at their message time, with the newest real message still last. The search index is updated, and every run writes an audit line to `.instar/logs/topic-history-imports.jsonl` (counts only, no message text). Boot and `/topic/rebuild` re-apply the batches the same way, so a restore survives a rebuild. A second identical import does nothing. `dryRun: true` reports without writing.

Restored rows are labelled `origin: imported`. They never count as a fresh instruction from the owner: forwarded provenance is narrowed to unknown, and the user corpus labels them `recovered` with no authority. Messages typed in the Instar app (`app:` ids) are refused, because the app keeps its own copy of them. A live copy of a restored message replaces the restored copy when it arrives. The peer row carrier never carries a restored row.

## What to Tell Your User

- **Lost conversation history can be put back**: "If a machine ever loses part of our conversation history, I can now restore it from the copies my other machines kept. The restored messages slot back into each conversation at the right time, search finds them again, and your newest messages stay at the bottom."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Restore recovered conversation history | `POST /topic/import` with `{ "file": "<path inside .instar>", "dryRun": true }` first, then without `dryRun` |

## Evidence

- Unit: `tests/unit/topic-history-import.test.ts` (24 tests): every refusal reason, provenance narrowing, the merge placement rule, two batches equal to one replay after a rebuild, idempotence, search reach, live copy supersedes, retry heals a failed merge, cumulative bound, rebuild/import serialization, re-apply continues past a failing topic, an unreadable archive never reads as empty.
- Integration: `tests/integration/topic-history-import-route.test.ts` (7 tests): file and inline modes, dry run, path escape refused (`..`, absolute, symlink), device principal refused, audit lines, idempotence, `/topic/search` hits and `/topic/context` ending on the newest live message.
- E2E: `tests/e2e/topic-history-import-lifecycle.test.ts` (2 tests): the server.ts boot path answers 200, the restore survives a restart and a destructive `/topic/rebuild` in time order, and the live log is byte-identical.
