// safe-git-allow: test file — fs.rmSync calls are per-test tmpdir cleanup only.
/**
 * E2E: full agent-update lifecycle survives secret-externalization.
 *
 * Simulates a real deployed agent in two states:
 *   1. Pre-fix agent — has the old broken hook scripts on disk AND has gone
 *      through secret-externalization (config.json contains the
 *      `{ "secret": true }` placeholder).
 *   2. Post-fix agent — runs `PostUpdateMigrator.migrate()`, which is the
 *      single code path that any auto-updated production instar agent
 *      exercises on every version bump.
 *
 * Asserts that, after `migrate()`, every shipped hook/script on the agent's
 * disk has the env-first INSTAR_AUTH_TOKEN canary AND a string-type guard.
 * This is the "feature is alive in production" property — the canonical
 * `Tier 3` test per the Testing Integrity Standard.
 *
 * Without this test, a regression that broke the migrator's hook-rewrite
 * path (e.g. an install-if-missing slip on a script that previously was
 * always-overwrite) would not be caught by the unit + integration tiers
 * alone.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

describe('secret-externalization survivability — e2e lifecycle', () => {
  let tmpDir: string;
  let stateDir: string;
  let claudeHooksInstarDir: string;
  let claudeScriptsDir: string;
  let instarScriptsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-secext-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    claudeHooksInstarDir = path.join(tmpDir, '.claude', 'hooks', 'instar');
    claudeScriptsDir = path.join(tmpDir, '.claude', 'scripts');
    instarScriptsDir = path.join(stateDir, 'scripts');

    fs.mkdirSync(claudeHooksInstarDir, { recursive: true });
    fs.mkdirSync(claudeScriptsDir, { recursive: true });
    fs.mkdirSync(instarScriptsDir, { recursive: true });

    // Seed config.json in the externalized state — the placeholder is on disk
    // because SecretMigrator ran (multi-machine pairing happened).
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      projectName: 'test-e2e',
      projectDir: tmpDir,
      stateDir,
      port: 4242,
      authToken: { secret: true },
    }));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* test cleanup */ } // safe-fs-allow
  });

  function seedBrokenHook(relPath: string, marker: string): string {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const body = [
      '#!/bin/bash',
      `# ${marker}`,
      'AUTH=""',
      'if [ -f ".instar/config.json" ]; then',
      '  AUTH=$(python3 -c "import json; print(json.load(open(\'.instar/config.json\')).get(\'authToken\',\'\'))" 2>/dev/null)',
      'fi',
    ].join('\n') + '\n';
    fs.writeFileSync(full, body);
    return full;
  }

  it('every shipped hook+script on a pre-fix deployed agent has env-first auth after migrate()', () => {
    // Seed pre-fix copies of every script that gets installed during init.
    // After migrate() runs (the auto-update path), each must contain the
    // INSTAR_AUTH_TOKEN canary AND the string-guard.
    const seeded: string[] = [];
    seeded.push(seedBrokenHook('.instar/scripts/imessage-reply.sh', 'imessage-reply.sh'));
    seeded.push(seedBrokenHook('.instar/scripts/serendipity-capture.sh', 'serendipity-capture.sh'));
    seeded.push(seedBrokenHook('.claude/hooks/instar/slack-channel-context.sh', 'slack-channel-context.sh'));

    // Trigger the canonical migration path the live updater runs.
    const migrator = new PostUpdateMigrator({
      stateDir,
      projectDir: tmpDir,
      port: 4242,
      sessions: { claudePath: 'claude' },
      hasTelegram: false,
    } as any);
    (migrator as any).migrate();

    // Every seeded file must now have the env-first canary AND a string guard.
    for (const file of seeded) {
      const body = fs.readFileSync(file, 'utf-8');
      expect(body, `${path.relative(tmpDir, file)}: missing INSTAR_AUTH_TOKEN env-first marker`).toContain('INSTAR_AUTH_TOKEN');
      const hasShellGuard = /isinstance\([^,]+,\s*str\)/.test(body) || /typeof\s+\w+\s*===\s*['"]string['"]/.test(body);
      expect(hasShellGuard, `${path.relative(tmpDir, file)}: missing string-type guard against { secret: true } placeholder`).toBe(true);
    }
  });

  it('canonical migrator-emitted hooks (telegram-topic-context, session-start, compaction-recovery) always carry the env-first canary', () => {
    // These three are written from `getHookContent()` on EVERY migration run
    // (per the always-overwrite policy of the Migration Parity Standard).
    // Assert the emitted content carries the canary so we never ship a
    // version that silently 403s after secret-externalization again.
    const migrator = new PostUpdateMigrator({
      stateDir,
      projectDir: tmpDir,
      port: 4242,
      sessions: { claudePath: 'claude' },
      hasTelegram: false,
    } as any);

    const names: Array<'telegram-topic-context' | 'session-start' | 'compaction-recovery'> = [
      'telegram-topic-context',
      'session-start',
      'compaction-recovery',
    ];
    for (const name of names) {
      const body: string = (migrator as any).getHookContent(name);
      expect(body, `${name}: missing INSTAR_AUTH_TOKEN env-first marker`).toContain('INSTAR_AUTH_TOKEN');
      expect(body, `${name}: missing string-type guard against { secret: true } placeholder`).toMatch(/isinstance\([^,]+,\s*str\)/);
    }
  });

  it('idempotent: a second migrate() pass produces no further upgrades for the already-fixed scripts', () => {
    // Seed broken first pass.
    seedBrokenHook('.instar/scripts/imessage-reply.sh', 'imessage-reply.sh');
    seedBrokenHook('.instar/scripts/serendipity-capture.sh', 'serendipity-capture.sh');

    const migrator = new PostUpdateMigrator({
      stateDir,
      projectDir: tmpDir,
      port: 4242,
      sessions: { claudePath: 'claude' },
      hasTelegram: false,
    } as any);

    const r1 = (migrator as any).migrate();
    const upgraded1 = (r1.upgraded as string[]).filter(u =>
      u.includes('imessage-reply.sh') || u.includes('serendipity-capture.sh'));
    expect(upgraded1.length, 'first pass should upgrade both seeded files').toBeGreaterThanOrEqual(2);

    const migrator2 = new PostUpdateMigrator({
      stateDir,
      projectDir: tmpDir,
      port: 4242,
      sessions: { claudePath: 'claude' },
      hasTelegram: false,
    } as any);
    const r2 = (migrator2 as any).migrate();
    const upgraded2 = (r2.upgraded as string[]).filter(u =>
      u.includes('imessage-reply.sh') || u.includes('serendipity-capture.sh'));
    expect(upgraded2.length, 'second pass should be a no-op for the already-fixed files').toBe(0);
  });
});
