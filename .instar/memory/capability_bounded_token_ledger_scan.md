---
name: Bounded Token Ledger Scan
description: Token ledger startup now processes batches with event-loop yielding to prevent multi-minute blocks on deep session history
type: reference
---

# Bounded Token Ledger Scan (v0.28.78+)

**Issue it fixes**: On agents with deep Claude Code history (100K+ session transcripts), the token ledger's first-boot scan blocked the Node event loop for minutes, making the server unresponsive.

## How It Works

The token ledger now bounds startup in three independent ways:

1. **Per-tick file cap** (default 500 files)
   - Processes 500 files per tick with a persistent cursor
   - On next boot, resumes where the previous scan left off
   - Once fully walked, cursor wraps to catch newly-written sessions
   - Files older than the backfill window (default 30 days) are skipped

2. **Intra-tick yielding** (default every 25 files)
   - Calls `setImmediate` every 25 files
   - Lets the event loop drain HTTP and health-check traffic
   - Server stays responsive even while ledger is working

3. **Max file age cutoff** (default 30 days)
   - Ignores transcripts with mtime older than backfill window
   - Active sessions stay in scope (appending updates mtime)
   - Source JSONLs in `~/.claude/projects/` remain ground truth

## User-Facing Impact

- **Tokens tab loads in ~1 minute** (most recent 30 days visible first)
- **Older sessions backfill gradually** as background scan continues
- **Server stays responsive** during startup, doesn't appear stuck

## Configuration

No configuration required. The bounds apply automatically.

Optional: if you want to widen the backfill window later to load older history, operators can pass `maxFileAgeMs` to the TokenLedger constructor.

## Method Reference

- `scanAllAsync()` — New async method with bounds, event-loop yielding, age cutoff
- `scanAll()` — Original sync entry point preserved for tests, now also honors bounds and age cutoff

No schema migration, no new routes, no external API changes.
