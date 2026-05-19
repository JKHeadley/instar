---
title: "Codex CLI — Hook rendering"
slug: "frameworks-codex-cli-hooks"
framework: "codex-cli"
primitive: "hook"
parent-concept: "specs/instar-concepts/hook.md"
verified-against: "Codex CLI 0.130"
---

# Codex CLI — Hook rendering

## What Codex CLI does

Codex 0.130 discovers hooks via the project-scope `.agent/openai/hooks.json` config file. The file declares a dispatch table mapping event names to script paths:

```json
{
  "hooks": [
    {
      "event": "session_start",
      "script": ".agent/openai/hooks/session-start/identity-injection.sh"
    },
    {
      "event": "pre_compact",
      "script": ".agent/openai/hooks/pre-compact/persist.sh"
    }
  ]
}
```

Hook scripts live under `.agent/openai/hooks/<event>/<name>.<ext>`.

## Event vocabulary (Codex-native)

Codex's events use snake_case:
- `session_start`, `session_end`
- `pre_compact`, `post_compact`
- `pre_tool_use`, `post_tool_use`
- `user_prompt_submit`

(Codex 0.130's complete event list is documented at the Codex CLI source — Instar tracks the subset Instar needs.)

## Canonical → Codex rendering

For each canonical hook at `.instar/hooks/<event>/<name>.<ext>`:

1. **Script copy**: write to `.agent/openai/hooks/<event>/<name>.<ext>` (canonical event name preserved).
2. **Stamp**: prepend `# x-instar-stamp: <sha256-of-canonical-body>` as a leading comment.
3. **Executable bit**: `chmod +x` after write.
4. **hooks.json entry**: add (or merge) an entry under `hooks[]` with the snake_case event name and the script path. Event-name mapping:

| Canonical (kebab) | Codex-native (snake_case) |
|---|---|
| `session-start` | `session_start` |
| `session-end` | `session_end` |
| `pre-compact` | `pre_compact` |
| `post-compact` | `post_compact` |
| `pre-tool-use` | `pre_tool_use` |
| `post-tool-use` | `post_tool_use` |
| `user-prompt-submit` | `user_prompt_submit` |

5. **Merge semantics for hooks.json**: existing entries pointing to scripts outside `.agent/openai/hooks/` are preserved; only entries whose `script` path is under `.agent/openai/hooks/<canonical-event>/` are managed by the parity rule.

## Known quirks

- **hooks.json format**: Codex expects `hooks` as an array of `{event, script}` objects. Some adapter implementations also accept `{event, command}`; Instar uses `script` for path clarity.
- **Working directory**: hooks fire with cwd at the project root by default. Relative paths in script bodies should anchor to the project root.
- **Event payload**: Codex passes the event JSON to the script via stdin (same convention as Claude). Scripts that need event metadata should parse stdin.
- **Trust prerequisite**: same `trust_level="trusted"` requirement that gates skill auto-discovery also gates hook execution. Operator-managed, not Instar's responsibility.
- **Codex equivalent of Claude's UserPromptSubmit**: Codex's `user_prompt_submit` event is functionally equivalent but may fire at slightly different stages of the input pipeline. v0.1 parity rule doesn't render this event.

## Parity verification

For each canonical hook at `.instar/hooks/<event>/<name>.<ext>`:

1. `.agent/openai/hooks/<event>/<name>.<ext>` exists, body matches canonical, stamp present, executable bit set.
2. `.agent/openai/hooks.json` has an entry under `hooks[]` with snake_case event and the rendered script path.
3. Symmetric: rendered script with no canonical counterpart → orphan; hooks.json entry referencing a removed script → orphan-entry.

## Version + verification status

- **Verified against**: Codex CLI 0.130.
- **v0.1 scope**: `session-start` event only.
- **Risk surface**: Codex's hook event vocabulary expansion would surface here; the canonical→native mapping table is the place additional events land.
