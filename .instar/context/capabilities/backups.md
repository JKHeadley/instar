# Backup System

Snapshot and restore agent state. Use before risky changes, after major progress, or to recover from corruption.

## Endpoints

- **List snapshots**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/backups`
- **Create snapshot**: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/backups`
- **Restore**: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/backups/SNAPSHOT-ID/restore`

## Automatic Safety

Restore is blocked while sessions are active and creates a pre-restore backup first.

## When to Use Proactively

Before applying dispatches that modify config, before updating agent identity, before any experiment that touches state files.
