---
title: Threadline stale thread retirement
review-convergence: true
approved: true
eli16-overview: threadline-stale-thread-retirement.eli16.md
---

# Threadline Stale Thread Retirement

## Problem

Threadline conversations can stay in active or idle state long after the useful exchange has ended. Codey's live store showed dozens of Echo relay conversations, many with only a single message, still counted as active days later. That makes active thread counts read like current work even when they mostly describe stale relationship history.

## Design

Add a store-level retirement method that archives inactive, non-pinned conversations after a conservative threshold. The default threshold is 24 hours. The method uses the existing mutation path so concurrent writers keep the same safety properties as other conversation updates.

Run the retirement check before active Threadline views are returned. This keeps compatibility surfaces honest without adding a separate background process. Correct the MCP active-agent metric so it counts only active state entries, not idle entries.

## Acceptance Criteria

- Stale active conversations are archived after the threshold.
- Stale idle conversations are archived after the threshold.
- Pinned stale conversations are not archived.
- Fresh conversations stay active.
- Archived conversations remain in the store.
- The active-agent metric excludes idle and resolved conversations.

## Verification

Focused tests cover the store primitive, the resume-map active listing path, and the MCP active-thread count. Broader Threadline integration tests continue to exercise relay and conversation handling.
