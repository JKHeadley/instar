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

    try {
      fs.writeFileSync(path.join(hooksDir, 'external-operation-gate.js'), this.getExternalOperationGateHook(), { mode: 0o755 });
      result.upgraded.push('hooks/external-operation-gate.js (MCP tool safety gate)');
    } catch (err) {
      result.errors.push(`external-operation-gate.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(hooksDir, 'deferral-detector.js'), this.getDeferralDetectorHook(), { mode: 0o755 });
      result.upgraded.push('hooks/deferral-detector.js (anti-deferral checklist)');
    } catch (err) {
      result.errors.push(`deferral-detector.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(hooksDir, 'post-action-reflection.js'), this.getPostActionReflectionHook(), { mode: 0o755 });
      result.upgraded.push('hooks/post-action-reflection.js (evolution awareness)');
    } catch (err) {
      result.errors.push(`post-action-reflection.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(hooksDir, 'external-communication-guard.js'), this.getExternalCommunicationGuardHook(), { mode: 0o755 });
      result.upgraded.push('hooks/external-communication-guard.js (identity grounding)');
    } catch (err) {
      result.errors.push(`external-communication-guard.js: ${err instanceof Error ? err.message : String(err)}`);
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

    // Coherence Gate section — pre-action verification for high-risk actions
    if (!content.includes('Coherence Gate') && !content.includes('/coherence/check')) {
      const section = `
### Coherence Gate (Pre-Action Verification)

**BEFORE any high-risk action** (deploying, pushing to git, modifying files outside this project, calling external APIs):

1. **Check coherence**: \`curl -X POST http://localhost:${port}/coherence/check -H 'Content-Type: application/json' -d '{"action":"deploy","context":{"topicId":TOPIC_ID}}'\`
2. **If result says "block"** — STOP. You may be working on the wrong project for this topic.
3. **If result says "warn"** — Pause and verify before proceeding.
4. **Generate a reflection prompt**: \`POST http://localhost:${port}/coherence/reflect\` — produces a self-verification checklist.

**Topic-Project Bindings**: Each Telegram topic can be bound to a specific project. When switching topics, verify the binding matches your current working directory.
- View bindings: \`GET http://localhost:${port}/topic-bindings\`
- Create binding: \`POST http://localhost:${port}/topic-bindings\` with \`{"topicId": N, "binding": {"projectName": "...", "projectDir": "..."}}\`

**Project Map**: Your spatial awareness of the working environment.
- View: \`GET http://localhost:${port}/project-map?format=compact\`
- Refresh: \`POST http://localhost:${port}/project-map/refresh\`
`;
      // Insert before Scripts or append
      const insertBefore = content.indexOf('**Scripts**');
      if (insertBefore >= 0) {
        content = content.slice(0, insertBefore) + section + '\n' + content.slice(insertBefore);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added Coherence Gate section');
    } else {
      result.skipped.push('CLAUDE.md: Coherence Gate section already present');
    }

    // External Operation Safety — structural guardrails for external service operations
    if (!content.includes('External Operation Safety') && !content.includes('/operations/evaluate')) {
      const section = `
### External Operation Safety (Structural Guardrails)

**When using MCP tools that interact with external services** (email, Slack, GitHub, etc.), a PreToolUse hook automatically classifies and gates each operation.

How it works:
1. The \`external-operation-gate.js\` hook intercepts all \`mcp__*\` tool calls
2. It classifies the operation by mutability (read/write/modify/delete) and reversibility
3. For non-read operations, it calls the gate API: \`POST http://localhost:${port}/operations/evaluate\`
4. The gate returns: \`allow\`, \`block\`, \`show-plan\` (requires user approval), or \`suggest-alternative\`

**If an operation is blocked**, you'll see an error message with the reason. Do NOT try to bypass it.
**If an operation requires a plan**, show the plan to the user and get explicit approval before proceeding.

**Emergency stop**: If the user says "stop everything", "emergency stop", "kill all sessions", or similar urgent commands, the MessageSentinel will intercept the message and halt operations immediately.

**Trust levels**: Each service starts at a trust floor (supervised or collaborative). As operations succeed without issues, trust can be elevated automatically. Check trust status: \`GET http://localhost:${port}/trust\`

**API endpoints**:
- Evaluate operation: \`POST http://localhost:${port}/operations/evaluate\`
- Classify message: \`POST http://localhost:${port}/sentinel/classify\`
- View trust: \`GET http://localhost:${port}/trust\`
- View operation log: \`GET http://localhost:${port}/operations/log\`
`;
      // Insert before Scripts or append
      const insertBefore = content.indexOf('**Scripts**');
      if (insertBefore >= 0) {
        content = content.slice(0, insertBefore) + section + '\n' + content.slice(insertBefore);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added External Operation Safety section');
    } else {
      result.skipped.push('CLAUDE.md: External Operation Safety section already present');
    }

    // Session Continuity — ensure agents know how to handle respawn context
    if (this.config.hasTelegram && !content.includes('Session Continuity') && !content.includes('CONTINUATION')) {
      const section = `
### Session Continuity (CRITICAL)

When your first message starts with \`CONTINUATION\`, you are **resuming an existing conversation**. The inline context contains a summary and recent messages from the prior session. You MUST:

1. **Read the context first** — it tells you what the conversation is about
2. **Pick up where you left off** — do NOT introduce yourself or ask "how can I help?"
3. **Reference the prior context** — show the user you know what they were discussing

The user has been talking to you (possibly for days). A generic greeting like "Hey! What can I help you with?" after dozens of messages of conversation history is a critical failure — it signals you lost all context and the user has to repeat everything. The context is right there in your input. Use it.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Session Continuity section');
    } else if (this.config.hasTelegram && content.includes('Session Continuity')) {
      result.skipped.push('CLAUDE.md: Session Continuity section already present');
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

    // Add PreToolUse MCP matcher for external operation gate
    if (!hooks.PreToolUse) {
      hooks.PreToolUse = [];
    }
    const preToolUse = hooks.PreToolUse as Array<{ matcher?: string; hooks?: unknown[] }>;
    const hasMcpMatcher = preToolUse.some(e => e.matcher === 'mcp__.*');
    if (!hasMcpMatcher) {
      preToolUse.push({
        matcher: 'mcp__.*',
        hooks: [{
          type: 'command',
          command: 'node .instar/hooks/external-operation-gate.js',
          blocking: true,
          timeout: 5000,
        }],
      });
      patched = true;
      result.upgraded.push('.claude/settings.json: added PreToolUse MCP matcher (external operation gate)');
    } else {
      result.skipped.push('.claude/settings.json: PreToolUse MCP matcher already present');
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

    // External operations — add defaults for existing agents.
    // Conservative: supervised floor, no auto-elevation (existing agents need to opt in).
    if (!config.externalOperations) {
      config.externalOperations = {
        enabled: true,
        sentinel: { enabled: true },
        services: {},
        readOnlyServices: [],
        trust: {
          floor: 'supervised',
          autoElevateEnabled: false,
          elevationThreshold: 10,
        },
      };
      patched = true;
      result.upgraded.push('config.json: added externalOperations defaults (supervised mode)');
    } else {
      result.skipped.push('config.json: externalOperations already configured');
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

  /**
   * Get the content of a named hook template.
   * Used by init.ts to share canonical hook content without duplication.
   */
  getHookContent(name: 'session-start' | 'compaction-recovery' | 'external-operation-gate' | 'deferral-detector' | 'post-action-reflection' | 'external-communication-guard'): string {
    switch (name) {
      case 'session-start': return this.getSessionStartHook();
      case 'compaction-recovery': return this.getCompactionRecovery();
      case 'external-operation-gate': return this.getExternalOperationGateHook();
      case 'deferral-detector': return this.getDeferralDetectorHook();
      case 'post-action-reflection': return this.getPostActionReflectionHook();
      case 'external-communication-guard': return this.getExternalCommunicationGuardHook();
    }
  }

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

# PROJECT MAP — spatial awareness of the working environment
if [ -f "$INSTAR_DIR/project-map.json" ]; then
  echo ""
  echo "--- PROJECT CONTEXT ---"
  python3 -c "
import json, sys
try:
    m = json.load(open('$INSTAR_DIR/project-map.json'))
    print(f'Project: {m[\"projectName\"]} ({m[\"projectType\"]})')
    print(f'Path: {m[\"projectDir\"]}')
    r = m.get('gitRemote')
    b = m.get('gitBranch')
    if r: print(f'Git: {r}' + (f' [{b}]' if b else ''))
    t = m.get('deploymentTargets', [])
    if t: print(f'Deploy targets: {(\", \").join(t)}')
    d = m.get('directories', [])
    print(f'Files: {m[\"totalFiles\"]} across {len(d)} directories')
    for dd in d[:6]:
        print(f'  {dd[\"name\"]}/ ({dd[\"fileCount\"]}) — {dd[\"description\"]}')
    if len(d) > 6: print(f'  ... and {len(d) - 6} more')
except Exception as e:
    print(f'(project map load failed: {e})', file=sys.stderr)
" 2>/dev/null
  echo "--- END PROJECT CONTEXT ---"
fi

# COHERENCE SCOPE — before ANY high-risk action, verify alignment
if [ -f "$INSTAR_DIR/config.json" ]; then
  echo ""
  echo "--- COHERENCE SCOPE ---"
  echo "BEFORE deploying, pushing, or modifying files outside this project:"
  echo "  1. Verify you are in the RIGHT project for the current topic/task"
  echo "  2. Check: curl -X POST http://localhost:\${PORT:-4040}/coherence/check \\\\"
  echo "       -H 'Content-Type: application/json' \\\\"
  echo "       -d '{\"action\":\"deploy\",\"context\":{\"topicId\":N}}'"
  echo "  3. If the check says BLOCK — STOP. You may be in the wrong project."
  echo "  4. Read the full reflection: POST /coherence/reflect"
  echo "--- END COHERENCE SCOPE ---"
fi

# Key files
echo ""
echo "Key files:"
[ -f "$INSTAR_DIR/AGENT.md" ] && echo "  .instar/AGENT.md — Your identity (read for full context)"
[ -f "$INSTAR_DIR/USER.md" ] && echo "  .instar/USER.md — Your collaborator"
[ -f "$INSTAR_DIR/MEMORY.md" ] && echo "  .instar/MEMORY.md — Persistent learnings"
[ -f "$INSTAR_DIR/project-map.md" ] && echo "  .instar/project-map.md — Project structure map"

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

# Deployment/push commands — check coherence gate first
for pattern in "vercel deploy" "vercel --prod" "git push" "npm publish" "npx wrangler deploy" "fly deploy" "railway up"; do
  if echo "$INPUT" | grep -qi "$pattern"; then
    if [ -f "$INSTAR_DIR/config.json" ]; then
      PORT=$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('port', 4040))" 2>/dev/null || echo "4040")
      TOPIC_ID="\${INSTAR_TELEGRAM_TOPIC:-}"
      ACTION="deploy"
      echo "$INPUT" | grep -qi "git push" && ACTION="git-push"
      echo "$INPUT" | grep -qi "npm publish" && ACTION="git-push"
      CTX="{}"
      [ -n "$TOPIC_ID" ] && CTX="{\\\"topicId\\\": $TOPIC_ID}"
      CHECK=$(curl -s -X POST "http://localhost:$PORT/coherence/check" -H 'Content-Type: application/json' -d "{\\\"action\\\":\\\"$ACTION\\\",\\\"context\\\":$CTX}" 2>/dev/null)
      if echo "$CHECK" | grep -q '"recommendation":"block"'; then
        SUMMARY=$(echo "$CHECK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary','Coherence check failed'))" 2>/dev/null || echo "Coherence check failed")
        echo "BLOCKED: Coherence gate blocked this action." >&2
        echo "$SUMMARY" >&2
        echo "Run POST /coherence/reflect for a detailed self-verification checklist." >&2
        exit 2
      fi
    fi
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

# ── 2b. PROJECT CONTEXT (where am I working?) ──
if [ -f "\$INSTAR_DIR/project-map.json" ]; then
  echo ""
  echo "--- PROJECT CONTEXT ---"
  python3 -c "
import json, sys
try:
    m = json.load(open('\$INSTAR_DIR/project-map.json'))
    print(f'Project: {m[\"projectName\"]} ({m[\"projectType\"]})')
    print(f'Path: {m[\"projectDir\"]}')
    r = m.get('gitRemote')
    b = m.get('gitBranch')
    if r: print(f'Git: {r}' + (f' [{b}]' if b else ''))
    t = m.get('deploymentTargets', [])
    if t: print(f'Deploy targets: {(\", \").join(t)}')
    print(f'Files: {m[\"totalFiles\"]} across {len(m.get(\"directories\", []))} directories')
except Exception as e:
    print(f'(project map load failed: {e})', file=sys.stderr)
" 2>/dev/null
  echo "--- END PROJECT CONTEXT ---"
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

  private getDeferralDetectorHook(): string {
    return `#!/usr/bin/env node
// Deferral detector — catches agents deferring work they could do themselves.
// PreToolUse hook for Bash commands. Scans outgoing messages for deferral patterns.
// When detected, injects a due diligence checklist (does NOT block).
//
// Born from an agent saying "This is credential input I cannot do myself"
// when it already had the token available via CLI tools.

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    if (input.tool_name !== 'Bash') process.exit(0);

    const command = (input.tool_input || {}).command || '';
    if (!command) process.exit(0);

    // Only check communication commands (messages to humans)
    const commPatterns = [
      /telegram-reply/i, /send-email/i, /send-message/i,
      /POST.*\\/telegram\\/reply/i, /slack.*send/i
    ];
    if (!commPatterns.some(p => p.test(command))) process.exit(0);

    // Exempt: genuinely human-only actions
    if (/password|captcha|legal|billing|payment credential/i.test(command)) process.exit(0);

    // Deferral patterns
    const patterns = [
      { re: /(?:I |i )(?:can'?t|cannot|am (?:not |un)able to)/i, type: 'inability_claim' },
      { re: /(?:this |it )(?:requires|needs) (?:your|human|manual) (?:input|intervention|action)/i, type: 'human_required' },
      { re: /you(?:'ll| will)? need to (?:do|handle|complete|input|enter|run|execute|click)/i, type: 'directing_human' },
      { re: /(?:you (?:can|could|should|might want to) )(?:run|execute|navigate|open|click)/i, type: 'suggesting_human_action' },
      { re: /(?:want me to|should I|shall I|would you like me to) (?:proceed|continue|go ahead)/i, type: 'permission_seeking' },
      { re: /(?:blocker|blocking issue|can'?t proceed (?:without|until))/i, type: 'claimed_blocker' },
    ];

    const matches = patterns.filter(p => p.re.test(command));
    if (matches.length === 0) process.exit(0);

    const checklist = [
      'DEFERRAL DETECTED — Before claiming you cannot do something, verify:',
      '',
      '1. Did you check --help or docs for the tool you are using?',
      '2. Did you search for a token/API-based alternative to interactive auth?',
      '3. Do you already have credentials/tokens that might work? (env vars, CLI auth, saved configs)',
      '4. Can you use browser automation to complete interactive flows?',
      '5. Is this GENUINELY beyond your access? (e.g., typing a password, solving a CAPTCHA)',
      '',
      'If ANY check might work — try it first.',
      'The pattern: You are DESCRIBING work instead of DOING work.',
      '',
      'Detected: ' + matches.map(m => m.type).join(', '),
    ].join('\\n');

    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: checklist }));
  } catch { /* don't break on errors */ }
  process.exit(0);
});
`;
  }

  private getPostActionReflectionHook(): string {
    return `#!/usr/bin/env node
// Post-action reflection — evolution awareness after significant actions.
// PreToolUse hook for Bash. When the agent is about to commit, deploy, or
// complete a task, injects a brief reminder to capture learnings.
//
// "Every action is an opportunity to learn. Most of that learning is lost
// because nobody paused to ask: what did this teach me?"

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    if (input.tool_name !== 'Bash') process.exit(0);

    const command = (input.tool_input || {}).command || '';
    if (!command) process.exit(0);

    // Significant action patterns — moments worth reflecting on
    const significantPatterns = [
      /git\\s+commit/i,
      /git\\s+push/i,
      /npm\\s+publish/i,
      /curl\\s+-X\\s+POST.*\\/deploy/i,
      /instar\\s+server\\s+restart/i,
    ];

    if (!significantPatterns.some(p => p.test(command))) process.exit(0);

    const reminder = [
      'POST-ACTION REFLECTION — Quick evolution check:',
      '',
      'Before moving on, consider:',
      '- Did this teach you something worth recording? → /learn',
      '- Did you notice a gap in your capabilities? → /gaps',
      '- Did you discover an improvement opportunity? → /evolve',
      '- Did you make a commitment to follow up? → /commit-action',
      '',
      'Skip if nothing notable. The value is in the pause, not the output.',
    ].join('\\n');

    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: reminder }));
  } catch { /* don't break on errors */ }
  process.exit(0);
});
`;
  }

  private getExternalCommunicationGuardHook(): string {
    return `#!/usr/bin/env node
// External communication guard — identity grounding before external posting.
// PreToolUse hook for Bash. Detects external posting commands (curl POST, API calls,
// CLI tools that post to external services). Injects identity re-read reminder.
//
// "An agent that knows itself is harder to compromise."
// "An agent that forgets itself posts things it shouldn't."

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    if (input.tool_name !== 'Bash') process.exit(0);

    const command = (input.tool_input || {}).command || '';
    if (!command) process.exit(0);

    // Patterns that indicate external posting
    const postingPatterns = [
      /curl\\s.*-X\\s+POST/i,
      /curl\\s.*-X\\s+PUT/i,
      /curl\\s.*-X\\s+PATCH/i,
      /curl\\s.*-d\\s+['"]/i,
      /curl\\s.*--data/i,
      /gh\\s+issue\\s+(?:comment|create)/i,
      /gh\\s+pr\\s+(?:comment|create|review)/i,
      /gh\\s+api\\s+graphql.*mutation/i,
      /sendgrid|mailgun|ses\\.amazonaws.*send/i,
      /telegram-reply/i,
      /send-email/i,
      /slack.*(?:chat\\.postMessage|send)/i,
    ];

    if (!postingPatterns.some(p => p.test(command))) process.exit(0);

    // Exempt: localhost, internal APIs, health checks
    if (/localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0/i.test(command)) process.exit(0);
    if (/curl\\s+-s\\s+https?:\\/\\/[^\\s]+\\s*$/i.test(command)) process.exit(0);  // Simple GET
    if (/heartbeat|keepalive|health/i.test(command)) process.exit(0);

    const reminder = [
      'EXTERNAL COMMUNICATION DETECTED — Identity grounding check:',
      '',
      'Before posting externally, verify:',
      '1. Have you read .instar/AGENT.md recently in this session?',
      '2. Does this message represent who you are and your principles?',
      '3. Are you posting something you would stand behind across sessions?',
      '4. Is the tone and content consistent with your identity?',
      '',
      'Security Through Identity: An agent that knows itself is harder to compromise.',
    ].join('\\n');

    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: reminder }));
  } catch { /* don't break on errors */ }
  process.exit(0);
});
`;
  }

  private getExternalOperationGateHook(): string {
    return `#!/usr/bin/env node
// External operation gate — structural safety for external service operations.
// PreToolUse hook. Intercepts MCP tool calls to external services and evaluates
// risk before allowing execution. Structure > Willpower.
//
// Born from the OpenClaw email deletion incident: an agent deleted 200+ emails
// because nothing distinguished safe reads from destructive bulk deletes.
//
// Uses global fetch() (Node.js 18+) — no CommonJS imports needed.

// Read tool input from stdin
let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(data);
    const toolName = input.tool_name || '';

    // Only intercept MCP tools (external service calls)
    if (!toolName.startsWith('mcp__')) {
      process.exit(0); // Not an MCP tool — pass through
    }

    // Extract service name from mcp__<service>__<action>
    const parts = toolName.split('__');
    if (parts.length < 3) {
      process.exit(0); // Malformed MCP tool name — pass through
    }

    const service = parts[1];
    const action = parts.slice(2).join('_');

    // Classify mutability from action name
    let mutability = 'read';
    if (/^(delete|remove|trash|purge|destroy|drop|clear)/.test(action)) {
      mutability = 'delete';
    } else if (/^(send|create|post|write|add|insert|new|compose|publish)/.test(action)) {
      mutability = 'write';
    } else if (/^(update|modify|edit|patch|rename|move|change|set|toggle|enable|disable)/.test(action)) {
      mutability = 'modify';
    }
    // Everything else defaults to 'read' (get, list, search, fetch, check, etc.)

    // Read operations are always safe — fast-path
    if (mutability === 'read') {
      process.exit(0);
    }

    // Classify reversibility
    let reversibility = 'reversible';
    if (/^(send|publish|post|destroy|purge|drop)/.test(action)) {
      reversibility = 'irreversible';
    } else if (/^(delete|remove|trash)/.test(action)) {
      reversibility = 'partially-reversible';
    }

    // Estimate item count from tool_input
    const toolInput = input.tool_input || {};
    let itemCount = 1;
    for (const key of Object.keys(toolInput)) {
      const val = toolInput[key];
      if (Array.isArray(val)) {
        itemCount = Math.max(itemCount, val.length);
      }
    }

    // Build description
    const description = action.replace(/_/g, ' ') + ' on ' + service;

    // Read config (port + auth token) via dynamic import to stay ESM-compatible
    let port = 4321;
    let authToken = '';
    try {
      const nodeFs = await import('node:fs');
      const configPath = (process.env.CLAUDE_PROJECT_DIR || '.') + '/.instar/config.json';
      const raw = nodeFs.readFileSync(configPath, 'utf-8');
      const cfg = JSON.parse(raw);
      port = cfg.port || 4321;
      authToken = cfg.authToken || '';
    } catch { /* use defaults */ }

    // Call the gate API using global fetch (Node 18+)
    const postData = JSON.stringify({
      service,
      mutability,
      reversibility,
      description,
      itemCount,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const res = await fetch('http://127.0.0.1:' + port + '/operations/evaluate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken,
        },
        body: postData,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const decision = await res.json();

      if (decision.action === 'block') {
        process.stderr.write('BLOCKED: External operation gate denied this action.\\n');
        process.stderr.write('Reason: ' + (decision.reason || 'Operation not permitted') + '\\n');
        process.stderr.write('Service: ' + service + ', Action: ' + action + '\\n');
        process.exit(2);
      }

      if (decision.action === 'show-plan') {
        const ctx = [
          '=== EXTERNAL OPERATION GATE: APPROVAL REQUIRED ===',
          'Operation: ' + description,
          'Risk: ' + (decision.riskLevel || 'unknown'),
          decision.plan ? 'Plan: ' + decision.plan : '',
          decision.checkpoint ? 'Checkpoint: pause after ' + decision.checkpoint.afterCount + ' items' : '',
          '',
          'Show this plan to the user and get explicit approval before proceeding.',
          'If the user has not approved this specific operation, DO NOT PROCEED.',
          '=== END GATE ===',
        ].filter(Boolean).join('\\n');

        process.stdout.write(JSON.stringify({
          decision: 'approve',
          additionalContext: ctx,
        }));
        process.exit(0);
      }

      if (decision.action === 'suggest-alternative' && decision.alternative) {
        process.stdout.write(JSON.stringify({
          decision: 'approve',
          additionalContext: 'External Operation Gate suggests: ' + decision.alternative,
        }));
      }
      process.exit(0);
    } catch {
      clearTimeout(timeout);
      process.exit(0); // Server unreachable or timeout — fail open
    }
  } catch {
    process.exit(0); // Parse error — fail open
  }
});
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
