/**
 * Post-Update Migrator — the "intelligence download" layer.
 *
 * When an agent installs a new version of instar, updating the npm
 * package only changes the server code. But the agent's local awareness
 * lives in project files: CLAUDE.md, hooks, scripts.
 *
 * This migrator bridges that gap. After every successful update, it:
 *   1. Re-installs hooks with the latest templates (behavioral upgrades)
 *   2. Patches CLAUDE.md with any new sections (awareness upgrades)
 *   3. Installs any new scripts (capability upgrades)
 *   4. Returns a human-readable migration report
 *
 * Design principles:
 *   - Additive only: never remove or modify existing user customizations
 *   - Hooks are overwritten (they're generated infrastructure, not user-edited)
 *   - CLAUDE.md sections are appended only if missing (check by heading)
 *   - Scripts are installed only if missing (never overwrite user modifications)
 */

import fs from 'node:fs';
import path from 'node:path';

export interface MigrationResult {
  /** What was upgraded */
  upgraded: string[];
  /** What was already up to date */
  skipped: string[];
  /** Any errors that occurred (non-fatal) */
  errors: string[];
}

export interface MigratorConfig {
  projectDir: string;
  stateDir: string;
  port: number;
  hasTelegram: boolean;
  projectName: string;
}

export class PostUpdateMigrator {
  private config: MigratorConfig;

  constructor(config: MigratorConfig) {
    this.config = config;
  }

  /**
   * Run all post-update migrations. Safe to call multiple times —
   * each migration is idempotent.
   */
  migrate(): MigrationResult {
    const result: MigrationResult = {
      upgraded: [],
      skipped: [],
      errors: [],
    };

    this.migrateHooks(result);
    this.migrateClaudeMd(result);
    this.migrateScripts(result);
    this.migrateSettings(result);
    this.migrateConfig(result);

    return result;
  }

  /**
   * Re-install hooks with the latest templates.
   * Hooks are generated infrastructure — always overwrite.
   */
  private migrateHooks(result: MigrationResult): void {
    const hooksDir = path.join(this.config.stateDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });

    try {
      // Session start hook — the most important one for self-discovery
      fs.writeFileSync(path.join(hooksDir, 'session-start.sh'), this.getSessionStartHook(), { mode: 0o755 });
      result.upgraded.push('hooks/session-start.sh (capability awareness)');
    } catch (err) {
      result.errors.push(`session-start.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(hooksDir, 'dangerous-command-guard.sh'), this.getDangerousCommandGuard(), { mode: 0o755 });
      result.upgraded.push('hooks/dangerous-command-guard.sh');
    } catch (err) {
      result.errors.push(`dangerous-command-guard.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(hooksDir, 'grounding-before-messaging.sh'), this.getGroundingBeforeMessaging(), { mode: 0o755 });
      result.upgraded.push('hooks/grounding-before-messaging.sh');
    } catch (err) {
      result.errors.push(`grounding-before-messaging.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(hooksDir, 'compaction-recovery.sh'), this.getCompactionRecovery(), { mode: 0o755 });
      result.upgraded.push('hooks/compaction-recovery.sh');
    } catch (err) {
      result.errors.push(`compaction-recovery.sh: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Patch CLAUDE.md with any new sections that don't exist yet.
   * Only adds — never modifies or removes existing content.
   */
  private migrateClaudeMd(result: MigrationResult): void {
    const claudeMdPath = path.join(this.config.projectDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      result.skipped.push('CLAUDE.md (not found — will be created on next init)');
      return;
    }

    let content: string;
    try {
      content = fs.readFileSync(claudeMdPath, 'utf-8');
    } catch (err) {
      result.errors.push(`CLAUDE.md read: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let patched = false;
    const port = this.config.port;

    // Self-Discovery section
    if (!content.includes('Self-Discovery') && !content.includes('/capabilities')) {
      const section = `
### Self-Discovery (Know Before You Claim)

Before EVER saying "I don't have", "I can't", or "this isn't available" — check what actually exists:

\`\`\`bash
curl http://localhost:${port}/capabilities
\`\`\`

This returns your full capability matrix: scripts, hooks, Telegram status, jobs, relationships, and more. It is the source of truth about what you can do. **Never hallucinate about missing capabilities — verify first.**
`;
      // Insert before "### How to Build" or "### Building New" if present, otherwise append
      const insertPoint = content.indexOf('### How to Build New Capabilities');
      const insertPoint2 = content.indexOf('### Building New Capabilities');
      const target = insertPoint >= 0 ? insertPoint : (insertPoint2 >= 0 ? insertPoint2 : -1);

      if (target >= 0) {
        content = content.slice(0, target) + section + '\n' + content.slice(target);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added Self-Discovery section');
    } else {
      result.skipped.push('CLAUDE.md: Self-Discovery section already present');
    }

    // Telegram Relay section — add if Telegram is configured but section is missing
    if (this.config.hasTelegram && !content.includes('Telegram Relay') && !content.includes('telegram-reply')) {
      const section = `
## Telegram Relay

When user input starts with \`[telegram:N]\` (e.g., \`[telegram:26] hello\`), the message came from a user via Telegram topic N.

**IMMEDIATE ACKNOWLEDGMENT (MANDATORY):** When you receive a Telegram message, your FIRST action — before reading files, searching code, or doing any work — must be sending a brief acknowledgment back. This confirms the message was received and you haven't stalled. Examples: "Got it, looking into this now." / "On it — checking the scheduler." / "Received, working on the sync." Then do the work, then send the full response.

**Message types:**
- **Text**: \`[telegram:26] hello there\` — standard text message
- **Voice**: \`[telegram:26] [voice] transcribed text here\` — voice message, already transcribed
- **Photo**: \`[telegram:26] [image:/path/to/file.jpg]\` or \`[telegram:26] [image:/path/to/file.jpg] caption text\` — use the Read tool to view the image at the given path

**Response relay:** After completing your work, relay your response back:

\`\`\`bash
cat <<'EOF' | .claude/scripts/telegram-reply.sh N
Your response text here
EOF
\`\`\`

Strip the \`[telegram:N]\` prefix before interpreting the message. Respond naturally, then relay. Only relay your conversational text — not tool output or internal reasoning.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Telegram Relay section');
    }

    // Upgrade existing Telegram Relay sections to include mandatory acknowledgment
    if (this.config.hasTelegram && content.includes('Telegram Relay') && !content.includes('IMMEDIATE ACKNOWLEDGMENT')) {
      const ackBlock = `\n**IMMEDIATE ACKNOWLEDGMENT (MANDATORY):** When you receive a Telegram message, your FIRST action — before reading files, searching code, or doing any work — must be sending a brief acknowledgment back. This confirms the message was received and you haven't stalled. Examples: "Got it, looking into this now." / "On it — checking the scheduler." / "Received, working on the sync." Then do the work, then send the full response.\n`;
      // Insert after the first line of the Telegram Relay section
      const relayIdx = content.indexOf('## Telegram Relay');
      if (relayIdx >= 0) {
        const nextNewline = content.indexOf('\n\n', relayIdx + 18);
        if (nextNewline >= 0) {
          content = content.slice(0, nextNewline + 1) + ackBlock + content.slice(nextNewline + 1);
          patched = true;
          result.upgraded.push('CLAUDE.md: added mandatory acknowledgment to Telegram Relay');
        }
      }
    }

    // Upgrade existing Telegram Relay sections to document image message format
    if (this.config.hasTelegram && content.includes('Telegram Relay') && !content.includes('[image:')) {
      const imageBlock = `\n**Message types:**\n- **Text**: \`[telegram:N] hello there\` — standard text message\n- **Voice**: \`[telegram:N] [voice] transcribed text here\` — voice message, already transcribed\n- **Photo**: \`[telegram:N] [image:/path/to/file.jpg]\` or with caption — use the Read tool to view the image at the given path\n`;
      // Insert before the Response relay section
      const relayIdx = content.indexOf('**Response relay:**');
      if (relayIdx >= 0) {
        content = content.slice(0, relayIdx) + imageBlock + '\n' + content.slice(relayIdx);
        patched = true;
        result.upgraded.push('CLAUDE.md: added image/photo message format to Telegram Relay');
      }
    }

    // Private Viewer + Tunnel section
    if (!content.includes('Private Viewing') && !content.includes('POST /view')) {
      const section = `
**Private Viewing** — Render markdown as auth-gated HTML pages, accessible only through the agent's server (local or via tunnel).
- Create: \`curl -X POST http://localhost:${port}/view -H 'Content-Type: application/json' -d '{"title":"Report","markdown":"# Private content"}'\`
- View (HTML): Open \`http://localhost:${port}/view/VIEW_ID\` in a browser
- List: \`curl http://localhost:${port}/views\`
- Update: \`curl -X PUT http://localhost:${port}/view/VIEW_ID -H 'Content-Type: application/json' -d '{"title":"Updated","markdown":"# New content"}'\`
- Delete: \`curl -X DELETE http://localhost:${port}/view/VIEW_ID\`

**Use private views for sensitive content. Use Telegraph for public content.**

**Cloudflare Tunnel** — Expose the local server to the internet via Cloudflare. Enables remote access to private views, the API, and file serving.
- Status: \`curl http://localhost:${port}/tunnel\`
- Configure in \`.instar/config.json\`: \`{"tunnel": {"enabled": true, "type": "quick"}}\`
- Quick tunnels (default): Zero-config, ephemeral URL (*.trycloudflare.com), no account needed
- Named tunnels: Persistent custom domain, requires token from Cloudflare dashboard
- When a tunnel is running, private view responses include a \`tunnelUrl\` with auth token for browser-clickable access
`;
      // Insert after Publishing section or before Scripts section
      const publishIdx = content.indexOf('**Scripts**');
      if (publishIdx >= 0) {
        content = content.slice(0, publishIdx) + section + '\n' + content.slice(publishIdx);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added Private Viewer + Cloudflare Tunnel section');
    } else {
      result.skipped.push('CLAUDE.md: Private Viewer section already present');
    }

    // Dashboard section
    if (!content.includes('**Dashboard**') && !content.includes('/dashboard')) {
      const section = `
**Dashboard** — Visual web interface for monitoring and managing sessions. Accessible from any device (phone, tablet, laptop) via tunnel.
- Local: \`http://localhost:${port}/dashboard\`
- Remote: When a tunnel is running, the dashboard is accessible at \`{tunnelUrl}/dashboard\`
- Authentication: Uses a 6-digit PIN (auto-generated in \`dashboardPin\` in \`.instar/config.json\`). NEVER mention "bearer tokens" or "auth tokens" to users — just give them the PIN.
- Features: Real-time terminal streaming of all running sessions, session management, model badges, mobile-responsive
- **Sharing the dashboard**: When the user wants to check on sessions from their phone, give them the tunnel URL + PIN. Read the PIN from your config.json. Check tunnel status: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/tunnel\`
`;
      // Insert after Server Status or before Scripts section
      const insertBefore = content.indexOf('**Scripts**');
      if (insertBefore >= 0) {
        content = content.slice(0, insertBefore) + section + '\n' + content.slice(insertBefore);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added Dashboard section');
    } else {
      result.skipped.push('CLAUDE.md: Dashboard section already present');
    }

    if (patched) {
      try {
        fs.writeFileSync(claudeMdPath, content);
      } catch (err) {
        result.errors.push(`CLAUDE.md write: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Install any new scripts that don't exist yet.
   * Never overwrites existing scripts (user may have customized them).
   */
  private migrateScripts(result: MigrationResult): void {
    const scriptsDir = path.join(this.config.projectDir, '.claude', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });

    // Telegram reply script — install if Telegram configured and script missing
    if (this.config.hasTelegram) {
      const scriptPath = path.join(scriptsDir, 'telegram-reply.sh');
      if (!fs.existsSync(scriptPath)) {
        try {
          fs.writeFileSync(scriptPath, this.getTelegramReplyScript(), { mode: 0o755 });
          result.upgraded.push('scripts/telegram-reply.sh (Telegram outbound relay)');
        } catch (err) {
          result.errors.push(`telegram-reply.sh: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        result.skipped.push('scripts/telegram-reply.sh (already exists)');
      }
    }

    // Health watchdog — install if missing
    const watchdogPath = path.join(scriptsDir, 'health-watchdog.sh');
    if (!fs.existsSync(watchdogPath)) {
      try {
        fs.writeFileSync(watchdogPath, this.getHealthWatchdog(), { mode: 0o755 });
        result.upgraded.push('scripts/health-watchdog.sh');
      } catch (err) {
        result.errors.push(`health-watchdog.sh: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      result.skipped.push('scripts/health-watchdog.sh (already exists)');
    }
  }

  /**
   * Ensure .claude/settings.json has required MCP servers and correct hook wiring.
   * Migrates legacy PostToolUse/Notification hooks to proper SessionStart type.
   */
  private migrateSettings(result: MigrationResult): void {
    const settingsPath = path.join(this.config.projectDir, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) {
      result.skipped.push('.claude/settings.json (not found — will be created on next init)');
      return;
    }

    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch (err) {
      result.errors.push(`settings.json read: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let patched = false;

    // Playwright MCP server — required for browser automation (Telegram setup, etc.)
    if (!settings.mcpServers) {
      settings.mcpServers = {};
    }
    const mcpServers = settings.mcpServers as Record<string, unknown>;
    if (!mcpServers.playwright) {
      mcpServers.playwright = {
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
      };
      patched = true;
      result.upgraded.push('.claude/settings.json: added Playwright MCP server');
    } else {
      result.skipped.push('.claude/settings.json: Playwright MCP already configured');
    }

    // Migrate hooks from legacy PostToolUse/Notification to proper SessionStart
    if (!settings.hooks) {
      settings.hooks = {};
    }
    const hooks = settings.hooks as Record<string, unknown[]>;

    const sessionStartHook = {
      type: 'command',
      command: 'bash .instar/hooks/session-start.sh',
      timeout: 5,
    };

    // Add SessionStart hooks if missing
    if (!hooks.SessionStart) {
      hooks.SessionStart = [
        { matcher: 'startup', hooks: [sessionStartHook] },
        { matcher: 'resume', hooks: [sessionStartHook] },
        { matcher: 'compact', hooks: [sessionStartHook] },
      ];
      patched = true;
      result.upgraded.push('.claude/settings.json: added SessionStart hooks (startup/resume/compact)');
    }

    // Clean up legacy PostToolUse session-start (was noisy — fired every tool use)
    if (hooks.PostToolUse) {
      const postToolUse = hooks.PostToolUse as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
      const filtered = postToolUse.filter(e => {
        if (e.matcher === '' && e.hooks?.some(h => h.command?.includes('session-start.sh'))) {
          return false;
        }
        return true;
      });
      if (filtered.length !== postToolUse.length) {
        if (filtered.length === 0) {
          delete hooks.PostToolUse;
        } else {
          hooks.PostToolUse = filtered;
        }
        patched = true;
        result.upgraded.push('.claude/settings.json: removed legacy PostToolUse session-start hook');
      }
    }

    // Clean up legacy Notification compaction hook (now in SessionStart)
    if (hooks.Notification) {
      const notification = hooks.Notification as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
      const filtered = notification.filter(e => {
        if (e.matcher === 'compact' && e.hooks?.some(h => h.command?.includes('compaction-recovery.sh'))) {
          return false;
        }
        return true;
      });
      if (filtered.length !== notification.length) {
        if (filtered.length === 0) {
          delete hooks.Notification;
        } else {
          hooks.Notification = filtered;
        }
        patched = true;
        result.upgraded.push('.claude/settings.json: migrated compaction hook from Notification to SessionStart');
      }
    }

    if (patched) {
      try {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      } catch (err) {
        result.errors.push(`settings.json write: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Migrate the agent's config.json with sensible defaults for new features.
   * Only adds missing fields — never overwrites existing user customizations.
   */
  private migrateConfig(result: MigrationResult): void {
    const configPath = path.join(this.config.stateDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      result.skipped.push('config.json (not found)');
      return;
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      result.errors.push(`config.json read: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let patched = false;

    // Auto-generate dashboardPin if missing — the dashboard should always be
    // accessible via PIN, not bearer token. Users don't need to know about tokens.
    if (!config.dashboardPin && config.authToken) {
      const pin = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit PIN
      config.dashboardPin = pin;
      patched = true;
      result.upgraded.push(`config.json: generated dashboard PIN (${pin})`);
    } else if (config.dashboardPin) {
      result.skipped.push('config.json: dashboard PIN already set');
    }

    if (patched) {
      try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      } catch (err) {
        result.errors.push(`config.json write: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── Hook Templates ─────────────────────────────────────────────────

  private getSessionStartHook(): string {
    return `#!/bin/bash
# Session start hook — injects identity context on session lifecycle events.
# Fires on: startup, resume, clear, compact (via SessionStart hook type)
#
# On startup/resume: outputs a compact identity summary
# On compact: delegates to compaction-recovery.sh for full injection
INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"
EVENT="\${CLAUDE_HOOK_MATCHER:-startup}"

# On compaction, delegate to the dedicated recovery hook
if [ "\$EVENT" = "compact" ]; then
  if [ -x "$INSTAR_DIR/hooks/compaction-recovery.sh" ]; then
    exec bash "$INSTAR_DIR/hooks/compaction-recovery.sh"
  fi
fi

# For startup/resume/clear — output a compact orientation
echo "=== SESSION START ==="

# TOPIC CONTEXT (loaded FIRST — highest priority context)
if [ -n "\$INSTAR_TELEGRAM_TOPIC" ]; then
  TOPIC_ID="\$INSTAR_TELEGRAM_TOPIC"
  CONFIG_FILE="$INSTAR_DIR/config.json"
  if [ -f "\$CONFIG_FILE" ]; then
    PORT=\$(grep -o '"port":[0-9]*' "\$CONFIG_FILE" | head -1 | cut -d':' -f2)
    if [ -n "\$PORT" ]; then
      TOPIC_CTX=\$(curl -s "http://localhost:\${PORT}/topic/context/\${TOPIC_ID}?recent=30" 2>/dev/null)
      if [ -n "\$TOPIC_CTX" ] && echo "\$TOPIC_CTX" | grep -q '"totalMessages"'; then
        TOTAL=\$(echo "\$TOPIC_CTX" | grep -o '"totalMessages":[0-9]*' | cut -d':' -f2)
        TOPIC_NAME=\$(echo "\$TOPIC_CTX" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('topicName') or 'Unknown')" 2>/dev/null || echo "Unknown")
        echo ""
        echo "--- CONVERSATION CONTEXT (Topic: \${TOPIC_NAME}, \${TOTAL} total messages) ---"
        echo ""
        SUMMARY=\$(echo "\$TOPIC_CTX" | python3 -c "import sys,json; d=json.load(sys.stdin); s=d.get('summary'); print(s if s else '')" 2>/dev/null)
        if [ -n "\$SUMMARY" ]; then
          echo "SUMMARY OF CONVERSATION SO FAR:"
          echo "\$SUMMARY"
          echo ""
        fi
        echo "RECENT MESSAGES:"
        echo "\$TOPIC_CTX" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for m in d.get('recentMessages', []):
    sender = 'User' if m.get('fromUser') else 'Agent'
    ts = m.get('timestamp', '')[:16].replace('T', ' ')
    text = m.get('text', '')
    if len(text) > 500:
        text = text[:500] + '...'
    print(f'[{ts}] {sender}: {text}')
" 2>/dev/null
        echo ""
        echo "Search past conversations: curl http://localhost:\${PORT}/topic/search?topic=\${TOPIC_ID}&q=QUERY"
        echo "--- END CONVERSATION CONTEXT ---"
        echo ""
      fi
    fi
  fi
fi

# Identity summary (first 20 lines of AGENT.md — enough for name + role)
if [ -f "$INSTAR_DIR/AGENT.md" ]; then
  echo ""
  AGENT_NAME=\$(head -1 "$INSTAR_DIR/AGENT.md" | sed 's/^# //')
  echo "Identity: \$AGENT_NAME"
  # Output personality and principles sections
  sed -n '/^## Personality/,/^## [^P]/p' "$INSTAR_DIR/AGENT.md" 2>/dev/null | head -10
fi

# Key files
echo ""
echo "Key files:"
[ -f "$INSTAR_DIR/AGENT.md" ] && echo "  .instar/AGENT.md — Your identity (read for full context)"
[ -f "$INSTAR_DIR/USER.md" ] && echo "  .instar/USER.md — Your collaborator"
[ -f "$INSTAR_DIR/MEMORY.md" ] && echo "  .instar/MEMORY.md — Persistent learnings"

# Relationship count
if [ -d "$INSTAR_DIR/relationships" ]; then
  REL_COUNT=\$(ls -1 "$INSTAR_DIR/relationships"/*.json 2>/dev/null | wc -l | tr -d ' ')
  [ "\$REL_COUNT" -gt "0" ] && echo "  \${REL_COUNT} tracked relationships in .instar/relationships/"
fi

# Server status + self-discovery + feature awareness
if [ -f "$INSTAR_DIR/config.json" ]; then
  PORT=\$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('port', 4040))" 2>/dev/null || echo "4040")
  HEALTH=\$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
  if [ "\$HEALTH" = "200" ]; then
    echo ""
    echo "Instar server: RUNNING on port \${PORT}"
    # Load full capabilities for tunnel + feature guide
    CAPS=\$(curl -s "http://localhost:\${PORT}/capabilities" 2>/dev/null)
    TUNNEL_URL=\$(echo "\$CAPS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tunnel',{}).get('url',''))" 2>/dev/null)
    [ -n "\$TUNNEL_URL" ] && echo "Cloudflare Tunnel active: \$TUNNEL_URL"
    # Inject feature guide — proactive capability awareness at every session start
    if echo "\$CAPS" | grep -q '"featureGuide"'; then
      echo ""
      echo "--- YOUR CAPABILITIES (use these proactively when context matches) ---"
      echo "\$CAPS" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    guide = d.get('featureGuide', {})
    triggers = guide.get('triggers', [])
    if triggers:
        for t in triggers:
            print(f'  When: {t[\"context\"]}')
            print(f'  Do:   {t[\"action\"]}')
            print()
except: pass
" 2>/dev/null
      echo "--- END CAPABILITIES ---"
    fi
  else
    echo ""
    echo "Instar server: NOT RUNNING (port \${PORT})"
  fi
fi

echo ""
echo "IMPORTANT: To report bugs or request features, use POST /feedback on your local server."

# Telegram relay instructions (structural — ensures EVERY Telegram session knows how to respond)
if [ -n "\$INSTAR_TELEGRAM_TOPIC" ]; then
  TOPIC_ID="\$INSTAR_TELEGRAM_TOPIC"
  RELAY_SCRIPT=""
  [ -f "$INSTAR_DIR/scripts/telegram-reply.sh" ] && RELAY_SCRIPT=".instar/scripts/telegram-reply.sh"
  [ -z "\$RELAY_SCRIPT" ] && [ -f "\${CLAUDE_PROJECT_DIR:-.}/.claude/scripts/telegram-reply.sh" ] && RELAY_SCRIPT=".claude/scripts/telegram-reply.sh"
  echo ""
  echo "--- TELEGRAM SESSION (topic \${TOPIC_ID}) ---"
  echo "MANDATORY: After EVERY response, relay conversational text back to Telegram:"
  echo "  cat <<'EOF' | \${RELAY_SCRIPT:-'.instar/scripts/telegram-reply.sh'} \${TOPIC_ID}"
  echo "  Your response text here"
  echo "  EOF"
  echo "Strip the [telegram:\${TOPIC_ID}] prefix before interpreting messages."
  echo "If a thread history file is referenced, READ IT FIRST before responding."
  echo "--- END TELEGRAM SESSION ---"
fi

# Pending upgrade guide — inject knowledge from the latest update
GUIDE_FILE="$INSTAR_DIR/state/pending-upgrade-guide.md"
if [ -f "\$GUIDE_FILE" ]; then
  echo ""
  echo "=== UPGRADE GUIDE (ACTION REQUIRED) ==="
  echo ""
  echo "A new version of Instar was installed with upgrade instructions."
  echo "You MUST do the following:"
  echo ""
  echo "1. Read the full upgrade guide below"
  echo "2. Take any suggested actions that apply to YOUR situation"
  echo "3. MESSAGE YOUR USER about what's new:"
  echo "   - Compose a brief, personalized message highlighting the features"
  echo "     that matter most to THEM and their specific use case"
  echo "   - Explain what each feature means in practical terms — how they"
  echo "     can take advantage of it, what it changes for them"
  echo "   - Skip internal plumbing details — focus on what the user will"
  echo "     notice, benefit from, or need to configure"
  echo "   - Send this message to the user via Telegram (Agent Updates topic)"
  echo "   - NEVER send updates to Agent Attention — that's for critical/blocking items only"
  echo "   - Use your knowledge of your user to personalize — you know their"
  echo "     workflow, their priorities, what they care about"
  echo "4. UPDATE YOUR MEMORY with the new capabilities:"
  echo "   - Read the upgrade guide's 'Summary of New Capabilities' section"
  echo "   - Add the relevant capabilities to your .instar/MEMORY.md file"
  echo "   - Focus on WHAT you can now do and HOW to use it"
  echo "   - If similar notes exist in MEMORY.md, update rather than duplicate"
  echo "   - This ensures you KNOW about these capabilities in every future session"
  echo "5. After messaging the user and updating memory, run: instar upgrade-ack"
  echo ""
  echo "--- UPGRADE GUIDE CONTENT ---"
  echo ""
  cat "\$GUIDE_FILE"
  echo ""
  echo "--- END UPGRADE GUIDE CONTENT ---"
  echo "=== END UPGRADE GUIDE ==="
fi

echo "=== END SESSION START ==="
`;
  }

  private getDangerousCommandGuard(): string {
    return `#!/bin/bash
# Dangerous command guard — safety infrastructure for autonomous agents.
# Supports safety.level in .instar/config.json:
#   Level 1 (default): Block and ask user. Level 2: Agent self-verifies.
INPUT="$1"
INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"

# Read safety level from config
SAFETY_LEVEL=1
if [ -f "$INSTAR_DIR/config.json" ]; then
  SAFETY_LEVEL=$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('safety', {}).get('level', 1))" 2>/dev/null || echo "1")
fi

# ALWAYS blocked (catastrophic, irreversible)
for pattern in "rm -rf /" "rm -rf ~" "> /dev/sda" "mkfs\\." "dd if=" ":(){:|:&};:"; do
  if echo "$INPUT" | grep -qi "$pattern"; then
    echo "BLOCKED: Catastrophic command detected: $pattern" >&2
    echo "Always blocked regardless of safety level. User must execute directly." >&2
    exit 2
  fi
done

# Risky commands — behavior depends on safety level
for pattern in "rm -rf \\." "git push --force" "git push -f" "git reset --hard" "git clean -fd" "DROP TABLE" "DROP DATABASE" "TRUNCATE" "DELETE FROM"; do
  if echo "$INPUT" | grep -qi "$pattern"; then
    if [ "$SAFETY_LEVEL" -eq 1 ]; then
      echo "BLOCKED: Potentially destructive command detected: $pattern" >&2
      echo "Ask the user for explicit confirmation before running this command." >&2
      exit 2
    else
      IDENTITY=""
      if [ -f "$INSTAR_DIR/AGENT.md" ]; then
        IDENTITY=$(head -20 "$INSTAR_DIR/AGENT.md" | tr '\\n' ' ')
      fi
      echo "{\\"decision\\":\\"approve\\",\\"additionalContext\\":\\"=== SELF-VERIFICATION REQUIRED ===\\\\nDestructive command detected: $pattern\\\\n\\\\n1. Is this necessary for the current task?\\\\n2. What are the consequences if this goes wrong?\\\\n3. Is there a safer alternative?\\\\n4. Does this align with your principles?\\\\n\\\\nIdentity: $IDENTITY\\\\n\\\\nIf ALL checks pass, proceed. If ANY fails, stop.\\\\n=== END SELF-VERIFICATION ===\\"}"
      exit 0
    fi
  fi
done
`;
  }

  private getGroundingBeforeMessaging(): string {
    return `#!/bin/bash
# Grounding before messaging — Security Through Identity.
INPUT="$1"
if echo "$INPUT" | grep -qE "(telegram-reply|send-email|send-message|POST.*/telegram/reply)"; then
  INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"
  if [ -f "$INSTAR_DIR/AGENT.md" ]; then
    echo "Before sending this message, remember who you are."
    echo "Re-read .instar/AGENT.md if you haven't recently."
    echo "Security Through Identity: An agent that knows itself is harder to compromise."
  fi
fi
`;
  }

  private getCompactionRecovery(): string {
    return `#!/bin/bash
# Compaction recovery — re-injects identity AND topic context when Claude's context compresses.
# Born from Dawn's 164th Lesson: "Advisory hooks get ignored. Automatic content
# injection removes the compliance gap entirely."
#
# This hook OUTPUTS identity content directly into context rather than just
# pointing to files. After compaction, the agent needs to KNOW who it is
# AND what conversation it's in — not be told where to look.
#
# Context priority (same as session-start):
#   1. Topic context (summary + recent messages) — what are we working on?
#   2. Identity (AGENT.md) — who am I?
#   3. Memory (MEMORY.md) — what have I learned?
#   4. Telegram relay — how do I respond?
#   5. Capabilities — what can I do?
INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"

echo "=== IDENTITY RECOVERY (post-compaction) ==="

# ── 1. TOPIC CONTEXT (highest priority — what are we working on?) ──
# After compaction, the conversation history is lost. Re-inject it from TopicMemory.
if [ -n "\$INSTAR_TELEGRAM_TOPIC" ]; then
  TOPIC_ID="\$INSTAR_TELEGRAM_TOPIC"
  CONFIG_FILE="\$INSTAR_DIR/config.json"
  if [ -f "\$CONFIG_FILE" ]; then
    PORT=\$(grep -o '"port":[0-9]*' "\$CONFIG_FILE" | head -1 | cut -d':' -f2)
    if [ -n "\$PORT" ]; then
      TOPIC_CTX=\$(curl -s "http://localhost:\${PORT}/topic/context/\${TOPIC_ID}?recent=20" 2>/dev/null)
      if [ -n "\$TOPIC_CTX" ] && echo "\$TOPIC_CTX" | grep -q '"totalMessages"'; then
        TOTAL=\$(echo "\$TOPIC_CTX" | grep -o '"totalMessages":[0-9]*' | cut -d':' -f2)
        TOPIC_NAME=\$(echo "\$TOPIC_CTX" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('topicName') or 'Unknown')" 2>/dev/null || echo "Unknown")

        echo ""
        echo "--- CONVERSATION CONTEXT (Topic: \${TOPIC_NAME}, \${TOTAL} total messages) ---"
        echo ""

        SUMMARY=\$(echo "\$TOPIC_CTX" | python3 -c "import sys,json; d=json.load(sys.stdin); s=d.get('summary'); print(s if s else '')" 2>/dev/null)
        if [ -n "\$SUMMARY" ]; then
          echo "SUMMARY OF CONVERSATION SO FAR:"
          echo "\$SUMMARY"
          echo ""
        fi

        echo "RECENT MESSAGES:"
        echo "\$TOPIC_CTX" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for m in d.get('recentMessages', []):
    sender = 'User' if m.get('fromUser') else 'Agent'
    ts = m.get('timestamp', '')[:16].replace('T', ' ')
    text = m.get('text', '')
    if len(text) > 500:
        text = text[:500] + '...'
    print(f'[{ts}] {sender}: {text}')
" 2>/dev/null
        echo ""
        echo "Search past conversations: curl http://localhost:\${PORT}/topic/search?topic=\${TOPIC_ID}&q=QUERY"
        echo "--- END CONVERSATION CONTEXT ---"
        echo ""
      fi
    fi
  fi
fi

# ── 2. IDENTITY (full AGENT.md — who am I?) ──
if [ -f "\$INSTAR_DIR/AGENT.md" ]; then
  echo ""
  echo "--- Your Identity (from .instar/AGENT.md) ---"
  cat "\$INSTAR_DIR/AGENT.md"
  echo ""
  echo "--- End Identity ---"
fi

# ── 3. MEMORY (first 50 lines — what have I learned?) ──
if [ -f "\$INSTAR_DIR/MEMORY.md" ]; then
  LINES=\$(wc -l < "\$INSTAR_DIR/MEMORY.md" | tr -d ' ')
  echo ""
  echo "--- Your Memory (.instar/MEMORY.md — \${LINES} lines, showing first 50) ---"
  head -50 "\$INSTAR_DIR/MEMORY.md"
  if [ "\$LINES" -gt 50 ]; then
    echo "... (\$((LINES - 50)) more lines — read full file if needed)"
  fi
  echo "--- End Memory ---"
fi

# ── 4. TELEGRAM RELAY (how do I respond?) ──
if [ -n "\$INSTAR_TELEGRAM_TOPIC" ]; then
  TOPIC_ID="\$INSTAR_TELEGRAM_TOPIC"
  RELAY_SCRIPT=""
  if [ -f "\$INSTAR_DIR/scripts/telegram-reply.sh" ]; then
    RELAY_SCRIPT=".instar/scripts/telegram-reply.sh"
  elif [ -f "\${CLAUDE_PROJECT_DIR:-.}/.claude/scripts/telegram-reply.sh" ]; then
    RELAY_SCRIPT=".claude/scripts/telegram-reply.sh"
  fi

  echo ""
  echo "--- TELEGRAM SESSION (topic \${TOPIC_ID}) ---"
  echo "This session is connected to Telegram topic \${TOPIC_ID}."
  echo "Messages arrive prefixed with [telegram:\${TOPIC_ID}]. Strip prefix before interpreting."
  echo "After EVERY response, relay your text back:"
  if [ -n "\$RELAY_SCRIPT" ]; then
    echo "  cat <<'EOF' | \${RELAY_SCRIPT} \${TOPIC_ID}"
  else
    echo "  cat <<'EOF' | .instar/scripts/telegram-reply.sh \${TOPIC_ID}"
  fi
  echo "  Your response text here"
  echo "  EOF"
  echo "--- END TELEGRAM SESSION ---"
fi

# ── 5. SERVER STATUS + CAPABILITIES ──
CONFIG_FILE="\$INSTAR_DIR/config.json"
if [ -f "\$CONFIG_FILE" ]; then
  PORT=\$(python3 -c "import json; print(json.load(open('\$CONFIG_FILE')).get('port', 4040))" 2>/dev/null || echo "4040")
  HEALTH=\$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
  if [ "\$HEALTH" = "200" ]; then
    echo ""
    echo "Instar server: RUNNING on port \${PORT}"
    CAPS=\$(curl -s "http://localhost:\${PORT}/capabilities" 2>/dev/null)
    if echo "\$CAPS" | grep -q '"featureGuide"' 2>/dev/null; then
      echo ""
      echo "--- YOUR CAPABILITIES ---"
      echo "\$CAPS" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    guide = d.get('featureGuide', {})
    for t in guide.get('triggers', []):
        print(f'  When: {t[\"context\"]}')
        print(f'  Do:   {t[\"action\"]}')
        print()
except: pass
" 2>/dev/null
      echo "--- END CAPABILITIES ---"
    fi
  else
    echo ""
    echo "Instar server: NOT RUNNING (port \${PORT})"
  fi
fi

echo ""
echo "=== END IDENTITY RECOVERY ==="
`;
  }

  private getTelegramReplyScript(): string {
    const port = this.config.port;
    return `#!/bin/bash
# telegram-reply.sh — Send a message back to a Telegram topic via instar server.
#
# Usage:
#   .claude/scripts/telegram-reply.sh TOPIC_ID "message text"
#   echo "message text" | .claude/scripts/telegram-reply.sh TOPIC_ID
#   cat <<'EOF' | .claude/scripts/telegram-reply.sh TOPIC_ID
#   Multi-line message here
#   EOF

TOPIC_ID="$1"
shift

if [ -z "$TOPIC_ID" ]; then
  echo "Usage: telegram-reply.sh TOPIC_ID [message]" >&2
  exit 1
fi

# Read message from args or stdin
if [ $# -gt 0 ]; then
  MSG="$*"
else
  MSG="$(cat)"
fi

if [ -z "$MSG" ]; then
  echo "No message provided" >&2
  exit 1
fi

PORT="\${INSTAR_PORT:-${port}}"

# Escape for JSON
JSON_MSG=$(printf '%s' "$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null)
if [ -z "$JSON_MSG" ]; then
  JSON_MSG="$(printf '%s' "$MSG" | sed 's/\\\\\\\\/\\\\\\\\\\\\\\\\/g; s/"/\\\\\\\\"/g' | sed ':a;N;$!ba;s/\\\\n/\\\\\\\\n/g')"
  JSON_MSG="\\"$JSON_MSG\\""
fi

RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://localhost:\${PORT}/telegram/reply/\${TOPIC_ID}" \\
  -H 'Content-Type: application/json' \\
  -d "{\\"text\\":\${JSON_MSG}}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  echo "Sent $(echo "$MSG" | wc -c | tr -d ' ') chars to topic $TOPIC_ID"
else
  echo "Failed (HTTP $HTTP_CODE): $BODY" >&2
  exit 1
fi
`;
  }

  private getHealthWatchdog(): string {
    const port = this.config.port;
    const projectName = this.config.projectName;
    const escapedProjectDir = this.config.projectDir.replace(/'/g, "'\\''");
    return `#!/bin/bash
# health-watchdog.sh — Monitor instar server and auto-recover.
# Install as cron: */5 * * * * '${path.join(this.config.projectDir, '.claude/scripts/health-watchdog.sh').replace(/'/g, "'\\''")}'

PORT="${port}"
SERVER_SESSION="${projectName}-server"
PROJECT_DIR='${escapedProjectDir}'
TMUX_PATH=$(which tmux 2>/dev/null || echo "/opt/homebrew/bin/tmux")

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
if [ "$HTTP_CODE" = "200" ]; then exit 0; fi

echo "[\$(date -Iseconds)] Server not responding. Restarting..."
$TMUX_PATH kill-session -t "=\${SERVER_SESSION}" 2>/dev/null
sleep 2
cd "$PROJECT_DIR" && npx instar server start
echo "[\$(date -Iseconds)] Server restart initiated"
`;
  }
}
