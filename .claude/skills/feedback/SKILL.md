---
name: feedback
description: Submit feedback about bugs, features, or improvements to instar. Use when something is broken, missing, or could be better. Routes to maintainers automatically via the Rising Tide feedback loop.
metadata:
  user_invocable: "true"
---

# /feedback — Report Issues & Request Features

You have a built-in feedback system. When something isn't working, is missing, or could be better — use this. **Do NOT use GitHub issues, `gh` CLI, or any external tracker.**

## Quick Submit

```bash
curl -s -X POST http://localhost:${INSTAR_PORT:-4042}/feedback \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "bug",
    "title": "Brief description of the issue",
    "description": "Full context: what happened, what you expected, error messages, steps to reproduce"
  }' | python3 -m json.tool
```

Or via CLI:
```bash
instar feedback --type bug --title "Brief description" --description "Full context"
```

## Feedback Types

| Type | When to use |
|------|-------------|
| `bug` | Something broke or behaves differently than expected |
| `feature` | A capability that doesn't exist yet but would be useful |
| `improvement` | Something works but could work better |
| `question` | Not sure if it's a bug or intended behavior |

## When to Submit (Autonomously)

Don't wait for the user to notice. You are the first line of detection:

- **Server API** returning unexpected errors or response shapes
- **Hooks** throwing errors or not firing when expected
- **Jobs** not running on schedule or failing silently
- **Sessions** not spawning, not tracked, or becoming zombies
- **State files** with corrupted or missing fields
- **Config settings** not being applied
- **Missing capabilities** that should exist
- **Friction** in workflows that feel unnecessarily complex

## Good Feedback

Include enough context for a fix:

**Bug**: What happened + what you expected + steps to reproduce + error output + your environment (`instar --version`, `node --version`)

**Feature**: What you're trying to do + what's limited today + how you'd like it to work + why it matters

## View & Retry

```bash
# View submitted feedback
curl -s http://localhost:${INSTAR_PORT:-4042}/feedback | python3 -m json.tool

# Retry failed forwards
curl -s -X POST http://localhost:${INSTAR_PORT:-4042}/feedback/retry
```

## How It Works

Your feedback is stored locally AND forwarded to the instar maintainers. When they fix the issue and publish an update, the built-in auto-updater detects it, applies it, and restarts the server — no manual intervention needed. One agent's bug report lifts all ships.

**User feedback matters too.** When your user says "this isn't working" or "I wish I could..." — capture it with their original words. User language carries context that technical rephrasing loses.
