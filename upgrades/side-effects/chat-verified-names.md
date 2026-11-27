# Side-Effects Review — Verified Names in Chats

## Summary

Tier 1. The Chats rendering model uses the shared display-name check for Telegram titles and a plain label when it cannot verify one. The already open title remains eligible for hydration while it reads Unnamed conversation. The source and route keys continue to determine which chat is opened.

## Decision-point Inventory

Missing, blank, and synthetic Telegram titles use the same fallback. App and Slack title selection stays on the existing path. In the open chat, the title hydrates when a list read first resolves a verified name. The generic label is static and the same for every agent. Multiple unnamed rows keep their distinct URLs, channel labels, timestamps or previews where available.

## 6b. Operator-surface Quality

The visible chat title never uses a numeric placeholder for a missing Telegram name. The existing platform label and preview remain available. The title uses text content and the naming test checks the real Chats page. No additional action, permission or prompt is required.

## Multi-machine posture

The change is downstream of the existing signed list projection. It does not alter data requests, pagination, conversation routing or cross-machine state.

## Rollback

Revert the two presentation changes. No data or preference migration.

## Class-Closure Declaration

No agent-authored-artifact defect or scheduled controller.
