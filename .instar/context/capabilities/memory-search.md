# Memory Search

Full-text search over all indexed memory files using SQLite FTS5. Find anything you've ever written to MEMORY.md, handoff notes, or state files.

## Endpoints

- **Search**: `curl -H "Authorization: Bearer $AUTH" "http://localhost:4042/memory/search?q=QUERY&limit=10"`
- **Stats**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/memory/stats`
- **Reindex**: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/memory/reindex`
- **Sync (incremental)**: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/memory/sync`

## Auto-Sync

Search automatically syncs before querying, so results are always current.

## When to Use

When looking for something you know you wrote but can't remember where. When a user asks "didn't we discuss X?" When building context for a task from past learnings.
