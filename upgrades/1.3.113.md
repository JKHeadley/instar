# Upgrade Guide - vNEXT

<!-- bump: patch -->

## What Changed

Threadline conversation lifecycle now retires stale active and idle threads automatically. Conversations that have seen no activity for 24 hours are archived instead of staying in the active set forever, while pinned conversations are left alone. Archived conversations keep their history and metadata, so a later peer reply can still reactivate the relationship context.

The Threadline active-agent summary also now reports only truly active threads. Idle conversations are no longer counted as active work, which makes agent health and collaboration dashboards reflect the real current workload instead of accumulated stale conversations.

## What to Tell Your User

- **Cleaner Threadline state**: "I now clean up old Threadline conversations automatically, so stale inter-agent chats stop cluttering the active thread count while the relationship history remains available."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Stale Threadline retirement | Automatic during Threadline active-thread reads |
| Accurate active thread counts | Automatic in threadline agent status |

## Evidence

Codey's live Threadline store showed 42 conversations before the change: 39 active, 3 idle, and 38 with Echo. Many were single-message relay threads from May 23-28 that still counted as active on May 30. Focused regression tests now prove stale active and idle conversations are archived without deletion, pinned stale threads remain active, and idle threads no longer increment the active thread metric.
