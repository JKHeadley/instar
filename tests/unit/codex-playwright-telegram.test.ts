/**
 * Tests for the v1.2.17 Codex+Playwright Telegram setup primary path.
 *
 * v1.2.15 removed the codex-exec Telegram action because Playwright
 * wasn't registered for Codex (ensurePlaywrightMcp only wrote to
 * ~/.claude.json and .mcp.json, never ~/.codex/config.toml), so
 * Codex couldn't drive the browser. v1.2.17 restores it as the
 * primary path:
 *
 *   1. ensureCodexPlaywrightMcp now writes [mcp_servers."playwright"]
 *      to ~/.codex/config.toml when not already present.
 *   2. runTelegramAgentic spawns Codex with Playwright available,
 *      lets it drive Telegram Web → BotFather → token + chatId
 *      capture → config write.
 *   3. verifyTelegramConfig checks the config write actually
 *      happened; if not, the dispatch falls through to
 *      runTelegramSetup (the v1.2.15 instar-native readline
 *      backstop).
 *
 * These tests pin the SHAPE of the new primary path without making
 * real Codex/Telegram calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTelegramAgenticPrompt,
  verifyTelegramConfig,
  runSendLifelineGreeting,
} from '../../src/commands/setup-wizard/codex-driver.js';
import { ensureCodexPlaywrightMcp } from '../../src/commands/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tmpRm(dir: string): void {
  SafeFsExecutor.safeRmSync(dir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/codex-playwright-telegram.test.ts:tmpRm',
  });
}

describe('buildTelegramAgenticPrompt', () => {
  const prompt = buildTelegramAgenticPrompt('/tmp/fake-project');

  it('names the project dir for the agent', () => {
    expect(prompt).toContain('/tmp/fake-project');
  });

  it('lists the Playwright tool surface the agent should reach for', () => {
    expect(prompt).toMatch(/mcp__playwright__browser_navigate/);
    expect(prompt).toMatch(/browser_snapshot/);
    expect(prompt).toMatch(/browser_click/);
    expect(prompt).toMatch(/browser_type/);
  });

  it('declares the structural success criterion (config-write shape)', () => {
    expect(prompt).toMatch(/SUCCESS CRITERION/);
    expect(prompt).toMatch(/type:\s*"telegram"/);
    expect(prompt).toMatch(/token/);
    expect(prompt).toMatch(/chatId/);
    expect(prompt).toMatch(/pollIntervalMs/);
  });

  it('demands a PLAYWRIGHT_UNAVAILABLE sentinel on missing tools', () => {
    expect(prompt).toMatch(/PLAYWRIGHT_UNAVAILABLE/);
  });

  it('demands an AGENTIC_FAILED sentinel on recoverable failures', () => {
    expect(prompt).toMatch(/AGENTIC_FAILED/);
  });

  it('uses Telegram Bot API for token validation + chat ID discovery', () => {
    expect(prompt).toMatch(/api\.telegram\.org/);
    expect(prompt).toMatch(/getMe/);
    expect(prompt).toMatch(/getUpdates/);
  });

  it('tells Codex to surface user-facing instructions (v1.2.18 fix)', () => {
    // The v1.2.17 prompt only told Codex to "take snapshots" — no
    // user-facing language. Real user (Justin) sat looking at a QR
    // code with no on-screen guidance. v1.2.18 explicitly tells
    // Codex to narrate to the user.
    expect(prompt).toMatch(/CONVERSATIONAL RULES/i);
    expect(prompt).toMatch(/real person/i);
    expect(prompt).toMatch(/Telegram on your phone/);
    expect(prompt).toMatch(/Link Desktop Device/);
    // Install hint for first-time users.
    expect(prompt).toMatch(/install.*app store/i);
    // Periodic reminder pattern during the wait.
    expect(prompt).toMatch(/every ~25-30 seconds/);
  });

  it('uses a 5-minute (not 2-minute) login-wait window', () => {
    // v1.2.17 had "up to ~120 seconds". v1.2.18 bumps to 5 minutes
    // so a fresh user who has to install Telegram on their phone
    // first doesn't time out.
    expect(prompt).not.toMatch(/up to ~120 seconds/);
    expect(prompt).toMatch(/5 MINUTES|5 minutes/);
  });

  it('disables BotFather privacy mode (v1.2.19 fix — bot otherwise can not see group messages)', () => {
    // Real user (Justin) hit v1.2.18 install where bot was created
    // but couldn't see his group messages — can_read_all_group_messages
    // came back false on /getMe. Root cause: BotFather creates bots
    // with privacy mode ON by default. v1.2.19 prompt drives
    // /setprivacy → Disable.
    expect(prompt).toMatch(/\/setprivacy/);
    expect(prompt).toMatch(/Disable/);
    expect(prompt).toMatch(/can_read_all_group_messages/);
    expect(prompt).toMatch(/privacy-not-disabled/);
  });

  it('enables Forum/Topics mode on the new group (v1.2.19 fix)', () => {
    // Required for topic threads. Bot API cannot enable Forum mode —
    // must be done via UI (group settings → Topics toggle).
    expect(prompt).toMatch(/Forum mode|Topics.*Forum|enable Topics/i);
    expect(prompt).toMatch(/is_forum/);
    expect(prompt).toMatch(/forum-mode-not-enabled/);
  });

  it('creates the 4 canonical system topics with TOPIC_STYLE colors', () => {
    expect(prompt).toMatch(/Lifeline/);
    expect(prompt).toMatch(/Updates/);
    expect(prompt).toMatch(/Dashboard/);
    expect(prompt).toMatch(/Attention/);
    // Canonical colors from src/messaging/TelegramAdapter.ts TOPIC_STYLE.
    expect(prompt).toMatch(/9367192/);  // SYSTEM (Lifeline) — green
    expect(prompt).toMatch(/7322096/);  // INFO (Updates, Dashboard) — blue
    expect(prompt).toMatch(/16766590/); // ALERT (Attention) — yellow
    expect(prompt).toMatch(/createForumTopic/);
    expect(prompt).toMatch(/topics-create-failed/);
  });

  it('seeds each topic with an orienting message via sendMessage + message_thread_id', () => {
    // v1.2.20: wording changed from "intro message" to "orienting
    // message" — these are channel-purpose blurbs, distinct from
    // the agent's personal first hello (which fires post-server-
    // start via the send-greeting state-machine action).
    expect(prompt).toMatch(/orienting message|intro message/i);
    expect(prompt).toMatch(/message_thread_id/);
    expect(prompt).toMatch(/sendMessage/);
  });

  it('persists lifelineTopicId in the config write step', () => {
    expect(prompt).toMatch(/lifelineTopicId/);
  });
});

describe('buildTelegramAgenticPrompt v1.2.20 audit additions', () => {
  const prompt = buildTelegramAgenticPrompt('/tmp/fake-project', {
    agentName: 'codey',
    userName: 'Justin',
    agentRole: 'coding assistant',
  });

  it('uses the user-chosen agentName as the BotFather display name (D2/G1 fix)', () => {
    // Pre-v1.2.20 the display name was hardcoded "Instar Agent" —
    // even when the user picked "codey" in the wizard, Telegram
    // contact list showed "Instar Agent". v1.2.20 pipes agentName
    // into the prompt.
    expect(prompt).toContain('"codey"');
    expect(prompt).not.toMatch(/type:\s*\n?\s*["']Instar Agent["']/);
  });

  it('addresses the user by name in greetings + ID context (D2)', () => {
    expect(prompt).toContain('Justin');
    expect(prompt).toMatch(/User name:\s+"Justin"/);
  });

  it('uses agentRole in /setdescription text (A2 fix)', () => {
    expect(prompt).toContain('coding assistant');
    expect(prompt).toMatch(/\/setdescription/);
  });

  it('sets /setabouttext (A3 fix)', () => {
    expect(prompt).toMatch(/\/setabouttext/);
    // About text is 120-char cap.
    expect(prompt).toMatch(/120 chars/);
  });

  it('promotes bot to group admin via Playwright UI (A1 fix)', () => {
    expect(prompt).toMatch(/admin/i);
    expect(prompt).toMatch(/Add Admin|Add Administrator|Administrators/);
    expect(prompt).toMatch(/getChatMember/);
    expect(prompt).toMatch(/status === "administrator"/);
  });

  it('pins the Lifeline orientation message (B3 fix)', () => {
    expect(prompt).toMatch(/pinChatMessage/);
    expect(prompt).toMatch(/LIFELINE_INTRO_MESSAGE_ID/);
    // Pinning is non-fatal — depends on A1 admin rights.
    expect(prompt).toMatch(/NOT AGENTIC_FAILED/);
  });

  it('chmods config.json to 0600 after writing the token (F2 fix)', () => {
    expect(prompt).toMatch(/chmod 0600/);
    // Justification in the comment near the chmod step.
    expect(prompt).toMatch(/credential material|world-readable/i);
  });

  it('flushes the /getUpdates long-poll backlog before verification (G5 fix)', () => {
    expect(prompt).toMatch(/getUpdates\?offset=-1/);
    expect(prompt).toMatch(/sleep 1/);
  });

  it('Lifeline orienting message teaches topic mechanics in agent voice (C1 fix)', () => {
    // SKILL.md's Lifeline greeting was richer than the v1.2.19
    // text. v1.2.20 should now teach the user how topics work +
    // invite them to create more.
    expect(prompt).toMatch(/Lifeline/);
    expect(prompt).toMatch(/topic|topics/i);
    // Either form of the create-topics invitation is fine.
    expect(prompt).toMatch(/create.*topic|create new topic|create a topic/i);
  });

  it('CRITICAL CREDENTIAL HYGIENE section refuses to print the bot token (F1 fix)', () => {
    expect(prompt).toMatch(/CRITICAL CREDENTIAL HYGIENE/i);
    expect(prompt).toMatch(/NEVER print the bot token/i);
    expect(prompt).toMatch(/REDACTED/);
  });

  it('falls back to projectDir basename + "friend" when ctx is omitted (defensive)', () => {
    const bare = buildTelegramAgenticPrompt('/Users/x/instar-foo');
    // Agent name defaults to project basename.
    expect(bare).toContain('"instar-foo"');
    // User name defaults to "friend".
    expect(bare).toMatch(/User name:\s+"friend"/);
  });
});

describe('runSendLifelineGreeting (C2/D1 — magic moment after server start)', () => {
  let tmp: string;
  beforeEach(() => { tmp = mktmp('greet-'); });
  afterEach(() => { tmpRm(tmp); });

  function writeMessagingConfig(messaging: unknown[]): void {
    fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.instar', 'config.json'),
      JSON.stringify({ messaging }),
    );
  }

  const baseOptions = {
    codexPath: '/bin/true',
    projectDir: '',
    instarRoot: '',
  };

  it('silently no-ops when telegram messaging is not configured', async () => {
    writeMessagingConfig([]);
    const updates = await runSendLifelineGreeting(
      { agentName: 'codey', userName: 'Justin' },
      { ...baseOptions, projectDir: tmp },
    );
    expect(updates).toEqual({});
  });

  it('silently no-ops when lifelineTopicId is missing', async () => {
    writeMessagingConfig([
      { type: 'telegram', enabled: true, config: { token: 'x:y', chatId: '-100abc' } },
    ]);
    const updates = await runSendLifelineGreeting(
      { agentName: 'codey', userName: 'Justin' },
      { ...baseOptions, projectDir: tmp },
    );
    expect(updates).toEqual({});
  });

  it('silently no-ops when config.json is missing entirely', async () => {
    // No config dir at all.
    const updates = await runSendLifelineGreeting(
      { agentName: 'codey', userName: 'Justin' },
      { ...baseOptions, projectDir: tmp },
    );
    expect(updates).toEqual({});
  });

  it('attempts the sendMessage call when token + chatId + lifelineTopicId are all present', async () => {
    writeMessagingConfig([
      {
        type: 'telegram',
        enabled: true,
        config: { token: 'x:y', chatId: '-100abc', lifelineTopicId: 42 },
      },
    ]);
    // Stub global fetch to capture the call.
    const fetchCalls: Array<{ url: string; body: unknown }> = [];
    const stubFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url, init) => {
        fetchCalls.push({
          url: typeof url === 'string' ? url : String(url),
          body: init?.body ? JSON.parse(init.body as string) : null,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
    try {
      await runSendLifelineGreeting(
        { agentName: 'codey', userName: 'Justin', autonomy: 'proactive' },
        { ...baseOptions, projectDir: tmp },
      );
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toMatch(/api\.telegram\.org\/botx%3Ay\/sendMessage/);
      const body = fetchCalls[0].body as {
        chat_id: string;
        message_thread_id: number;
        text: string;
      };
      expect(body.chat_id).toBe('-100abc');
      expect(body.message_thread_id).toBe(42);
      expect(body.text).toContain('codey');
      expect(body.text).toContain('Justin');
    } finally {
      stubFetch.mockRestore();
    }
  });
});


describe('verifyTelegramConfig', () => {
  let tmp: string;
  beforeEach(() => { tmp = mktmp('verifytg-'); });
  afterEach(() => { tmpRm(tmp); });

  function writeConfig(messaging: unknown[]): void {
    fs.mkdirSync(path.join(tmp, '.instar'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.instar', 'config.json'),
      JSON.stringify({ messaging }),
    );
  }

  it('returns false when .instar/config.json is missing', () => {
    expect(verifyTelegramConfig(tmp)).toBe(false);
  });

  it('returns false when messaging array is empty', () => {
    writeConfig([]);
    expect(verifyTelegramConfig(tmp)).toBe(false);
  });

  it('returns false when telegram entry has empty token', () => {
    writeConfig([{ type: 'telegram', enabled: true, config: { token: '', chatId: '-100123' } }]);
    expect(verifyTelegramConfig(tmp)).toBe(false);
  });

  it('returns false when telegram entry has empty chatId', () => {
    writeConfig([{ type: 'telegram', enabled: true, config: { token: 'abc:def', chatId: '' } }]);
    expect(verifyTelegramConfig(tmp)).toBe(false);
  });

  it('returns true when telegram entry has both token and chatId populated', () => {
    writeConfig([
      { type: 'telegram', enabled: true, config: { token: '123:abc', chatId: '-100456' } },
    ]);
    expect(verifyTelegramConfig(tmp)).toBe(true);
  });

  it('ignores non-telegram messaging entries', () => {
    writeConfig([
      { type: 'whatsapp', enabled: true, config: { backend: 'baileys' } },
      { type: 'telegram', enabled: true, config: { token: '123:abc', chatId: '-100456' } },
    ]);
    expect(verifyTelegramConfig(tmp)).toBe(true);
  });
});

describe('ensureCodexPlaywrightMcp', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mktmp('codexmcp-');
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // Re-import os to pick up new HOME — but os.homedir() reads HOME
    // at call time on POSIX, so the next call inside the function
    // will see our override.
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    tmpRm(tmpHome);
  });

  it('skips silently when ~/.codex/ does not exist (Codex not installed)', () => {
    // No .codex dir created. Should no-op without throwing.
    expect(() => ensureCodexPlaywrightMcp()).not.toThrow();
    expect(fs.existsSync(path.join(tmpHome, '.codex'))).toBe(false);
  });

  it('appends the playwright MCP block when ~/.codex/config.toml exists without it', () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    const cfgPath = path.join(tmpHome, '.codex', 'config.toml');
    fs.writeFileSync(cfgPath, 'model = "gpt-5.2-codex"\n\n[mcp_servers."other"]\nkind = "stdio"\ncommand = "/bin/true"\nargs = []\n');
    ensureCodexPlaywrightMcp();
    const after = fs.readFileSync(cfgPath, 'utf-8');
    expect(after).toContain('[mcp_servers."playwright"]');
    expect(after).toContain('command = "npx"');
    expect(after).toContain('@playwright/mcp@latest');
    // Original sections preserved.
    expect(after).toContain('model = "gpt-5.2-codex"');
    expect(after).toContain('[mcp_servers."other"]');
  });

  it('is idempotent — re-running does NOT duplicate the block', () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    const cfgPath = path.join(tmpHome, '.codex', 'config.toml');
    fs.writeFileSync(cfgPath, 'model = "gpt-5.2-codex"\n');
    ensureCodexPlaywrightMcp();
    ensureCodexPlaywrightMcp();
    ensureCodexPlaywrightMcp();
    const after = fs.readFileSync(cfgPath, 'utf-8');
    const matches = after.match(/\[mcp_servers\."playwright"\]/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('matches BOTH quoted and unquoted TOML section forms', () => {
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
    const cfgPath = path.join(tmpHome, '.codex', 'config.toml');
    // Pre-existing unquoted form.
    fs.writeFileSync(cfgPath, '[mcp_servers.playwright]\nkind = "stdio"\ncommand = "npx"\nargs = []\n');
    ensureCodexPlaywrightMcp();
    const after = fs.readFileSync(cfgPath, 'utf-8');
    // Should NOT have added a duplicate quoted form.
    expect(after).not.toMatch(/\[mcp_servers\."playwright"\]/);
    expect(after).toMatch(/\[mcp_servers\.playwright\]/);
  });
});

describe('codex driver dispatches telegram-agentic before native fallback', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/commands/setup-wizard/codex-driver.ts'),
    'utf-8',
  );

  it('setup-telegram-agentic action tries runTelegramAgentic first', () => {
    expect(src).toMatch(/case 'setup-telegram-agentic':[\s\S]*?runTelegramAgentic/);
  });

  it('falls through to runTelegramSetup when the agentic path reports not configured', () => {
    expect(src).toMatch(
      /case 'setup-telegram-agentic':[\s\S]*?if \(agentic\.telegramConfigured\) return agentic;[\s\S]*?runTelegramSetup\(options\)/,
    );
  });
});
