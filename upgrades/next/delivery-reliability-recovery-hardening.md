---
title: "Harden delivery recovery and liveness detection"
---

## What Changed

Recovery now owns accepted relay work across restarts, preserves stale evidence, keeps autonomous orphan observation active during queue pauses, and persists attention items before provider I/O.

## What to Tell Your User

Important replies and alerts are less likely to disappear during restarts or a slow Telegram connection. Autonomous runs also keep producing evidence when recovery actuation is paused.

## Summary of New Capabilities

- Always-on relay recovery by default.
- Stale backlog is withheld instead of silently purged or sent late.
- `/attention` acceptance is bounded independently of Telegram latency.

## Evidence

Focused pending-relay tests, TypeScript build, repository lint, and the instar-dev ceremony gate pass.
