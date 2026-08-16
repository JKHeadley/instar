---
name: Failed Resume Automatic Fallback
description: Stale resume UUIDs that crash during startup now trigger automatic fresh-spawn retry, preserving the user's message
type: user
---

## Overview

When a stale `--resume` UUID crashes Claude during agent startup, the system now automatically retries with a fresh spawn instead of silently dropping the user's message. This fixes a two-stage failure mode where a message from a conversation pause longer than 15 minutes would be lost.

## The Problem It Solves

Previously, when an agent's resume UUID became stale:
1. SessionManager would attempt to resume with `--resume UUID`
2. Claude would crash during startup (stale UUID)
3. The readiness probe would time out
4. The user's initial message was logged "NOT injected" and **silently dropped**

This happened particularly in messaging-bridged agents after long idle periods, making users think their message didn't send.

## How It Works

SessionManager now detects the failed resume scenario:
1. During startup, if the `--resume` spawn crashes and the readiness probe times out
2. SessionManager emits a `resumeFailed` event
3. The Telegram/Slack/iMessage bridge listener clears the stale UUID
4. The system automatically retries once with a fresh spawn
5. The original user message is carried forward into the fresh session

The UUID cleanup is gated on equality check, so a fresh spawn that quickly saves a new UUID won't have it wiped by a concurrent cleanup.

## Practical Effect

When you send a message after a very long pause (where the resume UUID might be stale), the message reliably reaches the agent instead of vanishing. You get a response instead of needing to re-send.

## Technical Details

- Affects messaging-bridged agents (Telegram, Slack, iMessage)
- Only triggers on confirmed failed resume (not on other startup failures)
- Single automatic retry; no cascading retries
- Preserves original message payload through the retry
