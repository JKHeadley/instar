# Codex rollout scan worker

## What Changed

Codex rollout discovery, file reads, and full parsing now run in a worker thread. The worker relocates the prior scan without changing its selection or results: `listAllRollouts` still selects 500 files by default in descending modification-time order, every selected file is read on every poll, the optional age and project-directory filters are unchanged, and duplicate session IDs retain final-upsert-wins behavior in discovery order. The poller keeps its existing 30-day age window.

Worker timeout, error, unexpected-exit, shutdown termination, and overlapping-poll guards prevent a stuck or duplicate scan. The main thread applies compact parsed results with the legacy per-file SQLite upserts.

## What to Tell Your User

If you use Codex a lot, I no longer freeze for several seconds every minute or so while counting its usage. The numbers I report are the same.

## Evidence

`TokenLedgerPoller-codex.test.ts` covers responsiveness, repeated full reads, preserved-mtime rewrites, legacy duplicate-session ordering, the 500-file default, worker timeout/error/exit/close, and overlapping polls. The focused Vitest suites and TypeScript build validate the change.

## Summary of New Capabilities

None — the same token totals, gathered without freezing the server.
