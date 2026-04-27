/**
 * Verifies PostUpdateMigrator correctly upgrades existing agents' telegram-reply.sh
 * to the new version (port-from-config + agent-id binding, which also retains
 * HTTP 408 ambiguous-outcome handling).
 *
 * Detection moved from marker-string match to SHA-based match in the
 * Layer-1 spec rev (telegram-delivery-robustness). The migrator now upgrades
 * ONLY scripts whose SHA-256 is in the known-prior-shipped set; user-modified
 * scripts get a .new candidate file and a relay-script-modified-locally
 * degradation event, never an in-place overwrite.
 *
 * For the upgrade-path test, OLD_SHIPPED_SCRIPT is the real shipped content
 * at origin/main 18a6735b (sha256:3d08c63c…) — the version that lacked
 * port-from-config / agent-id binding. Hand-crafted minimal fixtures
 * intentionally fall through to the .new candidate path and exercise the
 * user-modification safety guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: true,
    projectName: 'test-agent',
  });
}

// Real shipped version at origin/main 18a6735b — sha256:3d08c63c…
// (the version pre-Layer-1: HTTP 408 + tone-gate handling, but no
// port-from-config, no X-Instar-AgentId). Checked into tests/fixtures/
// rather than pulled from git at test time — SourceTreeGuard refuses
// in-tree git invocations even for read-only operations, by design.
const OLD_SHIPPED_SCRIPT = fs.readFileSync(
  path.resolve(__dirname, '..', 'fixtures', 'telegram-reply-pre-port-config.sh'),
  'utf-8'
);

// User-customized script — no shipped-header marker, so migration must not touch.
const USER_CUSTOM_SCRIPT = `#!/bin/bash
# My custom reply script — do not touch
echo "custom behavior"
curl -X POST "http://example.com/my-endpoint" -d "$*"
`;

describe('PostUpdateMigrator — telegram-reply.sh 408 migration', () => {
  let projectDir: string;
  let scriptsDir: string;
  let scriptPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-update-mig-test-'));
    scriptsDir = path.join(projectDir, '.claude', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    scriptPath = path.join(scriptsDir, 'telegram-reply.sh');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-telegramReply.test.ts:72' });
  });

  it('getTelegramReplyScript() returns a string that handles HTTP 408', () => {
    const migrator = createMigrator(projectDir);
    const script = (migrator as unknown as { getTelegramReplyScript(): string }).getTelegramReplyScript();
    expect(script).toContain('HTTP_CODE" = "408"');
    expect(script).toMatch(/ambiguous/i);
  });

  it('installs telegram-reply.sh when file is missing', async () => {
    const migrator = createMigrator(projectDir);
    const result = await migrator.migrate();
    expect(fs.existsSync(scriptPath)).toBe(true);
    const installed = fs.readFileSync(scriptPath, 'utf-8');
    expect(installed).toContain('HTTP_CODE" = "408"');
    expect(result.upgraded.some(u => u.includes('telegram-reply.sh'))).toBe(true);
  });

  it('upgrades the shipped-but-old script to the new port-config + agent-id version', async () => {
    fs.writeFileSync(scriptPath, OLD_SHIPPED_SCRIPT, { mode: 0o755 });

    const migrator = createMigrator(projectDir);
    const result = await migrator.migrate();

    const updated = fs.readFileSync(scriptPath, 'utf-8');
    // The new template still carries the 408 path (it's additive, not
    // a replacement) and adds port-from-config + agent-id binding.
    expect(updated).toContain('HTTP_CODE" = "408"');
    expect(updated).toMatch(/ambiguous/i);
    expect(updated).toMatch(/X-Instar-AgentId/);
    expect(updated).toMatch(/config\.json/);
    expect(
      result.upgraded.some(u =>
        u.includes('telegram-reply.sh') &&
        u.includes('port-from-config + agent-id binding')
      )
    ).toBe(true);

    // Backup of the prior version was retained.
    const backupDir = path.join(projectDir, '.instar', 'backups');
    expect(fs.existsSync(backupDir)).toBe(true);
    const backups = fs
      .readdirSync(backupDir)
      .filter(f => f.startsWith('telegram-reply.sh.'));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(path.join(backupDir, backups[0]), 'utf-8')).toBe(
      OLD_SHIPPED_SCRIPT
    );
  });

  it('writes a .new candidate (and emits degradation) when the on-disk SHA is unknown', async () => {
    const customWithShippedHeader = OLD_SHIPPED_SCRIPT + '\n# custom local change\n';
    fs.writeFileSync(scriptPath, customWithShippedHeader, { mode: 0o755 });

    const migrator = createMigrator(projectDir);
    const result = await migrator.migrate();

    // Original is left untouched.
    expect(fs.readFileSync(scriptPath, 'utf-8')).toBe(customWithShippedHeader);
    // New template lives next to it as a .new candidate.
    const candidate = `${scriptPath}.new`;
    expect(fs.existsSync(candidate)).toBe(true);
    const candidateContent = fs.readFileSync(candidate, 'utf-8');
    expect(candidateContent).toMatch(/X-Instar-AgentId/);
    expect(candidateContent).toMatch(/config\.json/);
    expect(
      result.skipped.some(s =>
        s.includes('telegram-reply.sh') && s.includes('user-modified')
      )
    ).toBe(true);
  });

  it('leaves a user-customized script untouched (no shipped marker present)', async () => {
    fs.writeFileSync(scriptPath, USER_CUSTOM_SCRIPT, { mode: 0o755 });

    const migrator = createMigrator(projectDir);
    const result = await migrator.migrate();

    const after = fs.readFileSync(scriptPath, 'utf-8');
    expect(after).toBe(USER_CUSTOM_SCRIPT);
    expect(result.upgraded.some(u => u.includes('HTTP 408'))).toBe(false);
    expect(result.skipped.some(s => s.includes('telegram-reply.sh'))).toBe(true);
  });

  it('leaves an already-migrated script untouched (idempotent)', async () => {
    const migrator = createMigrator(projectDir);
    const newScript = (migrator as unknown as { getTelegramReplyScript(): string }).getTelegramReplyScript();
    fs.writeFileSync(scriptPath, newScript, { mode: 0o755 });

    const result = await migrator.migrate();

    const after = fs.readFileSync(scriptPath, 'utf-8');
    expect(after).toBe(newScript);
    expect(result.upgraded.some(u => u.includes('HTTP 408'))).toBe(false);
    expect(result.skipped.some(s => s.includes('telegram-reply.sh'))).toBe(true);
  });

  it('does not install telegram-reply.sh when Telegram is not configured', async () => {
    const migrator = new PostUpdateMigrator({
      projectDir,
      stateDir: path.join(projectDir, '.instar'),
      port: 4042,
      hasTelegram: false,
      projectName: 'test-agent',
    });
    await migrator.migrate();
    expect(fs.existsSync(scriptPath)).toBe(false);
  });
});

const OLD_SHIPPED_SLACK = `#!/usr/bin/env bash
# slack-reply.sh — Send a message to a Slack channel via the instar server.
CHANNEL_ID="$1"
shift
MESSAGE="$*"
RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://localhost:4042/slack/reply/\${CHANNEL_ID}" -d "$MESSAGE")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
if [ "$HTTP_CODE" = "200" ]; then
  echo "Sent"
else
  echo "Failed" >&2
  exit 1
fi
`;

const OLD_SHIPPED_WHATSAPP = `#!/bin/bash
# whatsapp-reply.sh — Send a message back to a WhatsApp JID via instar server.
JID="$1"
shift
MSG="$*"
PORT="\${INSTAR_PORT:-4040}"
RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://localhost:\${PORT}/whatsapp/send/\${JID}" -d "{\\"text\\":\\"$MSG\\"}")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
if [ "$HTTP_CODE" = "200" ]; then
  echo "Sent"
else
  echo "Failed" >&2
  exit 1
fi
`;

describe('PostUpdateMigrator — slack-reply.sh 408 migration', () => {
  let projectDir: string;
  let scriptsDir: string;
  let scriptPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-update-mig-slack-'));
    scriptsDir = path.join(projectDir, '.claude', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    scriptPath = path.join(scriptsDir, 'slack-reply.sh');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-telegramReply.test.ts:185' });
  });

  it('upgrades the shipped-but-old slack-reply.sh to the new 408-aware version', async () => {
    fs.writeFileSync(scriptPath, OLD_SHIPPED_SLACK, { mode: 0o755 });
    const migrator = createMigrator(projectDir);
    const result = await migrator.migrate();

    const updated = fs.readFileSync(scriptPath, 'utf-8');
    expect(updated).toContain('HTTP_CODE" = "408"');
    expect(updated).toMatch(/ambiguous/i);
    expect(result.upgraded.some(u => u.includes('slack-reply.sh') && u.includes('HTTP 408'))).toBe(true);
  });

  it('leaves a custom slack-reply.sh untouched', async () => {
    fs.writeFileSync(scriptPath, USER_CUSTOM_SCRIPT, { mode: 0o755 });
    const migrator = createMigrator(projectDir);
    await migrator.migrate();
    expect(fs.readFileSync(scriptPath, 'utf-8')).toBe(USER_CUSTOM_SCRIPT);
  });

  it('does nothing when slack-reply.sh is not installed', async () => {
    const migrator = createMigrator(projectDir);
    await migrator.migrate();
    expect(fs.existsSync(scriptPath)).toBe(false);
  });
});

describe('PostUpdateMigrator — whatsapp-reply.sh 408 migration', () => {
  let projectDir: string;
  let whatsappScriptsDir: string;
  let scriptPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-update-mig-wa-'));
    whatsappScriptsDir = path.join(projectDir, '.instar', 'scripts');
    fs.mkdirSync(whatsappScriptsDir, { recursive: true });
    scriptPath = path.join(whatsappScriptsDir, 'whatsapp-reply.sh');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-telegramReply.test.ts:226' });
  });

  it('upgrades the shipped-but-old whatsapp-reply.sh to the new 408-aware version', async () => {
    fs.writeFileSync(scriptPath, OLD_SHIPPED_WHATSAPP, { mode: 0o755 });
    const migrator = createMigrator(projectDir);
    const result = await migrator.migrate();

    const updated = fs.readFileSync(scriptPath, 'utf-8');
    expect(updated).toContain('HTTP_CODE" = "408"');
    expect(updated).toMatch(/ambiguous/i);
    expect(result.upgraded.some(u => u.includes('whatsapp-reply.sh') && u.includes('HTTP 408'))).toBe(true);
  });

  it('leaves a custom whatsapp-reply.sh untouched', async () => {
    fs.writeFileSync(scriptPath, USER_CUSTOM_SCRIPT, { mode: 0o755 });
    const migrator = createMigrator(projectDir);
    await migrator.migrate();
    expect(fs.readFileSync(scriptPath, 'utf-8')).toBe(USER_CUSTOM_SCRIPT);
  });

  it('does nothing when whatsapp-reply.sh is not installed', async () => {
    const migrator = createMigrator(projectDir);
    await migrator.migrate();
    expect(fs.existsSync(scriptPath)).toBe(false);
  });
});
