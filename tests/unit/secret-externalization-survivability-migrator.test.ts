// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup only.
/**
 * Unit: PostUpdateMigrator's secret-externalization survivability migration.
 *
 * Verifies the structural rule: any deployed agent that has the OLD broken
 * version of a secret-sensitive script (auxiliary path — not on the
 * always-overwrite track) gets the new env-first version on next update,
 * while custom forks are left alone.
 *
 * The canonical hooks (session-start.sh, compaction-recovery.sh,
 * telegram-topic-context.sh) are covered by separate always-overwrite tests
 * elsewhere; this file is scoped to the auxiliary migration path
 * (migrateSecretExternalizationSurvivability + migrateReplyScriptTo408 with
 * extended-marker check).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

let tmpRoot: string;
let projectDir: string;
let stateDir: string;
let scriptsDir: string;
let claudeHooksInstarDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-secext-mig-'));
  projectDir = tmpRoot;
  stateDir = path.join(projectDir, '.instar');
  scriptsDir = path.join(stateDir, 'scripts');
  claudeHooksInstarDir = path.join(projectDir, '.claude', 'hooks', 'instar');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(claudeHooksInstarDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ messaging: [{ type: 'slack', enabled: true }] }));
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* test cleanup; tmpRoot may already be gone */ } // safe-fs-allow: per-test tmpdir cleanup
});

function makeMigrator(): PostUpdateMigrator {
  return new PostUpdateMigrator({
    stateDir,
    projectDir,
    port: 4042,
    sessions: { claudePath: 'claude' },
    hasTelegram: false,
  } as any);
}

// The migrator is a class so we exercise the public `migrate()` and observe
// disk effects rather than calling private methods directly.
function runMigrate(m: PostUpdateMigrator): { upgraded: string[]; skipped: string[]; errors: string[] } {
  // migrate() handles all phases; we want to assert that
  // migrateSecretExternalizationSurvivability ran and produced expected
  // disk changes for the targets we seeded.
  const result = (m as any).migrate();
  return {
    upgraded: result.upgraded ?? [],
    skipped: result.skipped ?? [],
    errors: result.errors ?? [],
  };
}

describe('secret-externalization survivability migration', () => {
  it('upgrades imessage-reply.sh when the deployed copy has the broken pattern', () => {
    // Seed the broken pre-fix shape: shipped-marker header + no INSTAR_AUTH_TOKEN.
    const broken = [
      '#!/bin/bash',
      '# imessage-reply.sh — old shipped version',
      'AUTH_TOKEN=""',
      'if [ -f ".instar/config.json" ]; then',
      '  AUTH_TOKEN=$(python3 -c "import json; print(json.load(open(\'.instar/config.json\')).get(\'authToken\',\'\'))" 2>/dev/null)',
      'fi',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(scriptsDir, 'imessage-reply.sh'), broken);

    const m = makeMigrator();
    const out = runMigrate(m);

    const final = fs.readFileSync(path.join(scriptsDir, 'imessage-reply.sh'), 'utf-8');
    expect(final).toContain('INSTAR_AUTH_TOKEN');
    expect(final).toContain('isinstance(v, str)');
    expect(out.upgraded.some(u => u.includes('imessage-reply.sh'))).toBe(true);
  });

  it('leaves a CUSTOM imessage-reply.sh fork untouched (no shipped marker)', () => {
    // No shipped marker → custom; never auto-overwrite.
    const custom = [
      '#!/bin/bash',
      '# user-rolled imessage helper',
      'echo "custom: $@"',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(scriptsDir, 'imessage-reply.sh'), custom);

    const m = makeMigrator();
    runMigrate(m);

    const final = fs.readFileSync(path.join(scriptsDir, 'imessage-reply.sh'), 'utf-8');
    expect(final).toBe(custom);
  });

  it('idempotent: when the file is already current it is left alone', () => {
    // Already-fixed shape (has INSTAR_AUTH_TOKEN env-first).
    const current = [
      '#!/bin/bash',
      '# imessage-reply.sh — current version',
      'AUTH_TOKEN="${INSTAR_AUTH_TOKEN:-}"',
      'if [ -z "$AUTH_TOKEN" ] && [ -f ".instar/config.json" ]; then',
      '  AUTH_TOKEN=$(python3 -c "import json; v=json.load(open(\'.instar/config.json\')).get(\'authToken\',\'\'); print(v if isinstance(v, str) else \'\')" 2>/dev/null)',
      'fi',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(scriptsDir, 'imessage-reply.sh'), current);

    const m = makeMigrator();
    runMigrate(m);

    const final = fs.readFileSync(path.join(scriptsDir, 'imessage-reply.sh'), 'utf-8');
    expect(final).toBe(current);
  });

  it('upgrades slack-channel-context.sh when present with broken auth pattern', () => {
    const broken = [
      '#!/bin/bash',
      '# slack-channel-context.sh — auto-inject Slack channel history',
      'AUTH=""',
      'if [ -f ".instar/config.json" ]; then',
      '  AUTH=$(python3 -c "import json; print(json.load(open(\'.instar/config.json\')).get(\'authToken\',\'\'))" 2>/dev/null)',
      'fi',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(claudeHooksInstarDir, 'slack-channel-context.sh'), broken);

    const m = makeMigrator();
    runMigrate(m);

    const final = fs.readFileSync(path.join(claudeHooksInstarDir, 'slack-channel-context.sh'), 'utf-8');
    expect(final).toContain('INSTAR_AUTH_TOKEN');
    expect(final).toContain('isinstance(v, str)');
  });
});

describe('migrateReplyScriptTo408: extended INSTAR_AUTH_TOKEN marker check', () => {
  it('preserves an unknown slack-reply.sh and stages the auth-safe current candidate', () => {
    // Old shipped marker; has 408 (old upgrade marker); LACKS INSTAR_AUTH_TOKEN
    // → was previously stuck in "already up to date" branch and would silently
    // 403 forever after the agent's authToken got externalized.
    const broken = [
      '#!/bin/bash',
      '# slack-reply.sh — Send a message to a Slack channel via the instar server',
      'HTTP_CODE=$(echo "$RESPONSE" | tail -1)',
      'if [ "$HTTP_CODE" = "408" ]; then',
      '  echo "408 ambiguous" >&2',
      'fi',
      'AUTH=$(python3 -c "import json; print(json.load(open(\'.instar/config.json\')).get(\'authToken\',\'\'))" 2>/dev/null)',
    ].join('\n') + '\n';
    const scriptPath = path.join(projectDir, '.claude', 'scripts', 'slack-reply.sh');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, broken);

    const m = makeMigrator();
    runMigrate(m);

    expect(fs.readFileSync(scriptPath, 'utf-8')).toBe(broken);
    const candidate = fs.readFileSync(`${scriptPath}.new`, 'utf-8');
    expect(candidate).toContain('INSTAR_AUTH_TOKEN');
    expect(candidate).toContain('isinstance(v, str)');
  });
});
