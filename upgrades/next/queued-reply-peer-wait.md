# Upgrade Guide — NEXT

## What Changed

A Telegram reply being retried no longer waits indefinitely for a machine that cannot answer. Before a retried reply goes out, the server reads the conversation's history from every machine, so it does not send an answer someone has already moved past. One sleeping machine made that read incomplete, and the reply stayed held on every retry until it expired. The wait now ends 15 minutes after the reply was written, and the reply goes out at the next retry after that, usually about 24 minutes after it was written. A newer message found on any machine still retires the reply. The reply still holds when the pool read itself fails or the history page is full.

## What to Tell Your User

- **Replies no longer stick behind a sleeping machine**: "If one of my machines is asleep, a reply that needed a retry reaches you in about 25 minutes instead of possibly never arriving."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Bounded wait for an unreachable machine on a retried reply | Automatic |

## Evidence

Op ece51280 (2026-11-07) sat queued for over 30 minutes through 6 silent retries because the Laptop answered HTTP 530; other topics in the same chat delivered normally.
