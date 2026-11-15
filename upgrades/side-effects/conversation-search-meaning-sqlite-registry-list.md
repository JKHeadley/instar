# Side-effects: the meaning-search index is listed as a long-lived SQLite store

The SQLite registry wiring guard lists every file in src/ that opens a better-sqlite3 database. ConversationEmbeddingIndex.ts opens one, registers its handle with registerSqliteHandle in the constructor and unregisters in close(), but was missing from the guard's list of long-lived stores, so the guard failed. This adds it to that list. Test change only.

1. Over-block: none. 2. Under-block: none; the guard's second check still requires the file to call registerSqliteHandle, which it does. 3. Level-of-abstraction fit: the guard's allowlist is where each store is declared. 4. Signal vs authority: no decision point. 5. Interactions: none. 6. External surfaces: none. 7. Multi-machine posture: not applicable, test only. 8. Rollback cost: revert the line.
