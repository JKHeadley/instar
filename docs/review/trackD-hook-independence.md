# Track D: Hook System Independence

## Summary
Hooks are ALWAYS installed (infrastructure pattern) but check feature flags at RUNTIME. Custom hooks coexist with built-in hooks — both run if registered. Execution order is predictable (array order within a matcher). You can add custom hooks without enabling any feature gate.

---

## D1: Hook installation flow [VERIFIED]

**Location:** `src/core/PostUpdateMigrator.ts:78-193`

**Two-stage process:**

1. **File installation** (`migrateHooks()`): Writes all built-in hooks to `.instar/hooks/instar/` as executable scripts. Always overwrites on update.
2. **Settings registration** (`migrateSettings()`): Registers hook references in `.claude/settings.json` under `hooks` object, organized by event type.

**Directory separation:**
- `.instar/hooks/instar/` — built-in, always overwritten on update
- `.instar/hooks/custom/` — user-written, NEVER touched by migrations (line 81)

**Settings structure** (from `src/templates/hooks/settings-template.json`):
```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [
        { "type": "command", "command": "bash .instar/hooks/instar/dangerous-command-guard.sh..." }
      ]},
      { "matcher": "AskUserQuestion", "hooks": [
        { "type": "command", "command": "bash .instar/hooks/instar/free-text-guard.sh" }
      ]}
    ],
    "Stop": [
      { "matcher": "", "hooks": [{ "command": "node .instar/hooks/instar/response-review.js" }] },
      { "matcher": "", "hooks": [{ "command": "node .instar/hooks/instar/claim-intercept-response.js" }] }
    ]
  }
}
```

---

## D2: Runtime vs. install-time gating [VERIFIED]

**Hooks check feature flags at RUNTIME, not install-time.**

Examples:
- **dangerous-command-guard.sh** (lines 24-28): Reads `config.json` safety level at execution time
- **response-review.js** (PostUpdateMigrator.ts:3103-3114): Checks `config.responseReview.enabled` at runtime — exits silently if false
- **session-start.sh** (lines 26-27): Reads config for port/authToken at execution time

**Implication:** You can flip a config flag and immediately change behavior without restart. Hooks are always present but conditionally active.

---

## D3: Can you override built-in hooks? [VERIFIED]

**Location:** `src/core/PostUpdateMigrator.ts:81,195-259`

**Yes, but both run if both are registered.** Custom hooks don't shadow built-in ones — they're separate entries in settings.json.

**To replace a built-in hook:**
1. Create replacement in `.instar/hooks/custom/my-hook.sh`
2. Register it in `.claude/settings.json`
3. **Remove** the built-in hook entry from settings.json (otherwise both fire)

**Migration note:** Lines 195-259 detect agent-modified built-in hooks, move them to `custom/` with provenance tracking, and preserve them across updates. This prevents your customizations from being overwritten.

---

## D4: Hook execution order [VERIFIED]

**Within a matcher entry:** Hooks execute **sequentially in array order**. Predictable.

Example (PreToolUse Bash):
1. `dangerous-command-guard.sh`
2. `grounding-before-messaging.sh`
3. `deferral-detector.js`
4. `external-communication-guard.js`

**Multiple matcher entries (same event):** Claude Code matches the tool name against each entry's `matcher` field. Only matching entries fire. For empty matchers (""), all entries fire.

**Stop event (3 entries with empty matcher):**
1. `response-review.js`
2. `claim-intercept-response.js`
3. `scope-coherence-checkpoint.js`

All three fire in order for every Stop event.

---

## D5: Custom PreResponse hook without coherence gate [VERIFIED]

**Yes, fully supported.**

- Add a custom Stop hook in `.instar/hooks/custom/vault-check.sh`
- Register it in `.claude/settings.json` under `Stop`
- Set `responseReview.enabled: false` in config.json to disable the coherence gate
- Your custom hook fires; `response-review.js` reads config and exits silently

**No conflict.** Multiple Stop hooks coexist — they all fire sequentially. Your custom hook is independent of the built-in coherence gate pipeline.

**Example lightweight vault-path check:**
```bash
#!/bin/bash
# .instar/hooks/custom/vault-path-verify.sh
# Verify any vault file paths mentioned in response actually exist
RESPONSE="$CLAUDE_STOP_RESPONSE"
VAULT_PATHS=$(echo "$RESPONSE" | grep -oP '/vault/[^\s"]+')
for path in $VAULT_PATHS; do
  if [ ! -e "$path" ]; then
    echo "BLOCK: Response references non-existent vault path: $path"
    exit 2
  fi
done
exit 0
```
