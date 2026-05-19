---
title: "Claude Code — Hook rendering"
slug: "frameworks-claude-code-hooks"
framework: "claude-code"
primitive: "hook"
parent-concept: "specs/instar-concepts/hook.md"
---

# Claude Code — Hook rendering

## What Claude Code does

Claude discovers hooks by reading `.claude/settings.json` at session start. The settings file declares a hook table mapping event names to arrays of script invocations:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "bash .claude/hooks/session-start/identity-injection.sh", "timeout": 10000 }] }
    ],
    "PreCompact": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "bash .claude/hooks/pre-compact/persist.sh" }] }
    ]
  }
}
```

Hook scripts live under `.claude/hooks/<event>/<name>.<ext>` by convention; settings.json's `command` field references them.

## Event vocabulary (Claude-native)

Claude's events use CamelCase:
- `SessionStart`, `SessionEnd`, `Stop`
- `PreCompact`, `PostCompact`
- `PreToolUse`, `PostToolUse`
- `UserPromptSubmit`
- `Notification`

## Canonical → Claude rendering

For each canonical hook at `.instar/hooks/<event>/<name>.<ext>`:

1. **Script copy**: write to `.claude/hooks/<event>/<name>.<ext>` (canonical event name preserved — lowercase kebab-case).
2. **Stamp**: prepend a comment line `# x-instar-stamp: <sha256-of-canonical-body>` so user-edits can be distinguished from canonical drift.
3. **Executable bit**: `chmod +x` after write.
4. **settings.json entry**: add (or merge) a hook table entry under `hooks.<EventCamelCase>` referencing the rendered script. Event-name mapping:

| Canonical (kebab) | Claude-native (CamelCase) |
|---|---|
| `session-start` | `SessionStart` |
| `session-end` | `SessionEnd` |
| `stop` | `Stop` |
| `pre-compact` | `PreCompact` |
| `post-compact` | `PostCompact` |
| `pre-tool-use` | `PreToolUse` |
| `post-tool-use` | `PostToolUse` |
| `user-prompt-submit` | `UserPromptSubmit` |
| `notification` | `Notification` |

5. **Merge semantics for settings.json**: existing non-Instar hook entries are preserved; only entries whose `command` field includes a path under `.claude/hooks/<canonical-event>/` are managed by the parity rule. Other entries (user-added hooks pointing elsewhere) are left alone.

## Known quirks

- **Script permissions**: Claude won't run a hook script without the executable bit. Renderer MUST `chmod +x` after every write.
- **Hook timeout**: Claude defaults to no timeout; parity rule sets `timeout: 10000` (10s) for renderered hooks unless the canonical declares otherwise via a `<event>.<name>.config.json` sibling (deferred to v0.2).
- **settings.json hand-edits**: users frequently customize settings.json (permissions, MCP servers). The parity rule's merge semantics preserve any key the rule doesn't manage; touches only `hooks.<CamelCase>` arrays for events in the canonical mapping.
- **Stop hook + Claude SDK**: Claude's stop hook can return non-zero to block the agent from exiting. The parity rule does NOT autopopulate stop hooks — they're left to operator-driven flows.

## Parity verification

For each canonical hook at `.instar/hooks/<event>/<name>.<ext>`:

1. `.claude/hooks/<event>/<name>.<ext>` exists, body matches canonical, stamp present, executable bit set.
2. `.claude/settings.json` has an entry under `hooks.<EventCamelCase>` referencing the rendered script.
3. Symmetric: rendered script with no canonical counterpart → orphan; settings.json entry referencing a removed script → orphan-entry.

## Version + verification status

- **Verified against**: Claude Code 2.x (settings.json hook table format stable since 1.x).
- **v0.1 scope**: `session-start` event only; rest of vocabulary tracked but not rendered.
