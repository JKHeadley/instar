---
title: Reap Log Skipped Disposition
review-convergence: 2026-05-29T11:28:00Z
approved: true
eli16-overview: reap-log-skipped-disposition.eli16.md
---

# Reap Log Skipped Disposition

## Problem

Reap Log is the file-backed answer to "where did my session go?" It records both sessions that were actually reaped and terminate attempts that were refused by the authority.

Dogfooding showed the endpoint is alive and useful, but skipped entries had an inconsistent shape. Reaped entries included `disposition`, while skipped entries only included `skipped`. That means a client asking for `ts/type/session/reason/disposition` sees a missing outcome field exactly on the rows that explain why a session did not vanish.

## Proposed Change

Normalize Reap Log entries so every returned row includes `disposition`:

- reaped terminal rows use `terminal`;
- reaped recovery bounces use `recovery-bounce`;
- skipped rows use `skipped:<authority-reason>`.

Keep the existing `skipped` field on skipped rows for compatibility and detail. When reading old log lines that predate this field, backfill `disposition` in memory without rewriting the log.

## Acceptance Criteria

- New skipped entries are written with both `skipped` and `disposition`.
- Old skipped entries without `disposition` are returned with a normalized `disposition`.
- Existing reaped entries still return a disposition, defaulting to `terminal` when older calls omitted it.
- The route remains read-only and file-backed.

## Decision Points

This changes only the shape and normalization of Reap Log audit rows. It does not change reap authority, session termination, notification, or lease behavior.

## Rollback

Rollback is a normal code revert. Existing log lines are JSONL and remain readable; newer rows with `disposition` are ignored by older readers.
