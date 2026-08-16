# Fix: Invalid HTTP Hooks in .claude/settings.json

**Date**: 2026-03-23
**Agent affected**: echo (may affect any Instar agent)
**Symptom**: Claude Code shows "Settings Error — Invalid URL" on startup, listing hooks in PostToolUse, Stop, and/or SubagentStart. The entire settings file is skipped, disabling ALL hooks.

## Root Cause

Three `type: "http"` hooks were present in `.claude/settings.json` with unresolved env var templates as URLs:

```json
{
  "type": "http",
  "url": "${INSTAR_SERVER_URL}/hooks/events?instar_sid=${INSTAR_SESSION_ID}",
  "headers": { "Authorization": "Bearer ${INSTAR_AUTH_TOKEN}" }
}
```

Claude Code validates hook URLs at startup. Since the env vars (`INSTAR_SERVER_URL`, `INSTAR_SESSION_ID`, `INSTAR_AUTH_TOKEN`) are never set, the literal string `${INSTAR_SERVER_URL}/hooks/events...` fails URL validation. **Claude Code skips the ENTIRE settings file when any hook has an invalid URL** — so all hooks (safety guards, scope coherence, session start) were silently disabled.

## How They Got There

Instar's source includes `http-hook-templates.ts` which defines HTTP observability hooks. These templates are exported via `buildHttpHookSettings()` but are **NOT installed by the standard `installClaudeSettings()` init path**. The function requires a resolved `serverUrl` argument to replace the `${INSTAR_SERVER_URL}` placeholder.

The hooks were most likely added by the agent's own Claude session using the raw templates without calling `buildHttpHookSettings()` to resolve the URL — or by a migration/update script that added them with unresolved placeholders.

## Fix Applied

Removed all three `type: "http"` hook entries from PostToolUse, Stop, and SubagentStart in `.claude/settings.json`. These hooks are for **observability only** (telemetry to a `/hooks/events` endpoint that doesn't exist yet) — removing them has zero impact on agent functionality. All safety-critical hooks are `type: "command"` and were unaffected.

## How to Check Other Agents

```bash
# Check all Instar agents for http hooks with unresolved env vars
for agent_dir in ~/.instar/agents/*/; do
  settings="$agent_dir/.claude/settings.json"
  if [ -f "$settings" ]; then
    if grep -q '"type": "http"' "$settings" 2>/dev/null || grep -q '"type":"http"' "$settings" 2>/dev/null; then
      echo "FOUND http hooks in: $settings"
    fi
  fi
done
```

## How to Fix (If Found in Another Agent)

1. Open the agent's `.claude/settings.json`
2. Search for `"type": "http"` entries
3. Remove the entire hook entry object containing the http hook
4. Ensure no trailing commas remain after removal (JSON doesn't allow them)
5. Validate: `python3 -c "import json; json.load(open('path/to/settings.json'))"`

## Prevention

If http hooks are re-enabled in the future, they must:
1. Be installed via `buildHttpHookSettings(resolvedServerUrl)` — never with raw `${INSTAR_SERVER_URL}` templates
2. Only be added when the Instar server URL is known and the `/hooks/events` endpoint exists
3. Have the env vars actually configured in the agent's launch environment (plist or session-start.sh)
