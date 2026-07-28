/**
 * Migration Parity tests — Session Boot Self-Knowledge (spec:
 * docs/specs/session-boot-self-knowledge.md).
 *
 * Existing agents only receive features through the update path. Verifies:
 *   - migrateConfig backfills the `selfKnowledge` defaults idempotently
 *     (run twice = no second change) and preserves an operator's partial
 *     override (existing operationalFacts untouched)
 *   - the regenerated session-start hook carries the boot-self-knowledge
 *     fetch block (always-overwrite delivery)
 *   - migrateClaudeMd adds the Session Boot Self-Knowledge section once
 *     (content-sniffed idempotency)
 *   - migrateScripts installs scripts/secret-get.mjs (always-overwrite)
 *   - last-writer-wins pinning: a facts-route write interleaved with a
 *     migrateConfig run — common orderings lose neither the fact nor the
 *     migration's fields (spec §Writer path)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { writeConfigAtomic } from '../../src/core/BootSelfKnowledge.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function callPrivate(migrator: PostUpdateMigrator, method: string): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as Record<string, (r: MigrationResult) => void>)[method](result);
  return result;
}

describe('PostUpdateMigrator — Session Boot Self-Knowledge migration parity', () => {
  let projectDir: string;
  let stateDir: string;
  let configPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-boot-sk-mig-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    configPath = path.join(stateDir, 'config.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-bootSelfKnowledge.test.ts:cleanup',
    });
  });

  it('migrateConfig backfills selfKnowledge defaults idempotently, leaving `enabled` UNSET (dark-ship)', () => {
    fs.writeFileSync(configPath, JSON.stringify({ projectName: 'x', port: 4042 }, null, 2) + '\n');
    const r1 = callPrivate(newMigrator(projectDir), 'migrateConfig');
    expect(r1.errors).toEqual([]);
    const cfg1 = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(cfg1.selfKnowledge).toBeTruthy();
    expect(cfg1.selfKnowledge.sessionContext.maxInjectedBytes).toBe(2000);
    expect(cfg1.selfKnowledge.sessionContext.enabled).toBeUndefined(); // the developmentAgent gate resolves it
    expect(cfg1.selfKnowledge.operationalFacts).toEqual([]);

    // Idempotent: a second run changes nothing.
    callPrivate(newMigrator(projectDir), 'migrateConfig');
    const cfg2 = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(cfg2.selfKnowledge).toEqual(cfg1.selfKnowledge);
  });

  it('migrateConfig preserves an operator partial override (existing operationalFacts untouched)', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ projectName: 'x', port: 4042, selfKnowledge: { operationalFacts: ['operator fact'] } }, null, 2) + '\n',
    );
    callPrivate(newMigrator(projectDir), 'migrateConfig');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(cfg.selfKnowledge.operationalFacts).toEqual(['operator fact']); // never clobbered
    expect(cfg.selfKnowledge.sessionContext.maxInjectedBytes).toBe(2000); // missing sub-key backfilled
  });

  it('the regenerated session-start hook carries the boot-self-knowledge fetch (always-overwrite delivery)', () => {
    const migrator = newMigrator(projectDir);
    const src = (migrator as unknown as { getSessionStartHook(): string }).getSessionStartHook();
    expect(src).toContain('# SESSION BOOT SELF-KNOWLEDGE injection');
    expect(src).toContain('/self-knowledge/session-context');
    expect(src).toContain('curl -sf --max-time 4 --connect-timeout 1');
  });

  it('the regenerated compaction-recovery hook RE-injects the block (long-session survival)', () => {
    const migrator = newMigrator(projectDir);
    const src = (migrator as unknown as { getHookContent(n: string): string }).getHookContent('compaction-recovery');
    expect(src).toContain('# SESSION BOOT SELF-KNOWLEDGE re-injection');
    expect(src).toContain('/self-knowledge/session-context');
    // The re-injection block must come BEFORE the recovery banner closes.
    expect(src.indexOf('# SESSION BOOT SELF-KNOWLEDGE re-injection')).toBeLessThan(src.indexOf('END IDENTITY RECOVERY'));
  });

  it('migrateClaudeMd adds the Session Boot Self-Knowledge section once (idempotent)', () => {
    const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nExisting agent instructions.\n');

    const r1 = callPrivate(newMigrator(projectDir), 'migrateClaudeMd');
    expect(r1.upgraded.some((u) => u.includes('Session Boot Self-Knowledge'))).toBe(true);
    const content1 = fs.readFileSync(claudeMdPath, 'utf8');
    expect(content1).toContain('**Session Boot Self-Knowledge**');
    expect(content1).toContain('secret-get.mjs');
    expect(content1).toContain('/self-knowledge/facts');

    const r2 = callPrivate(newMigrator(projectDir), 'migrateClaudeMd');
    expect(r2.upgraded.some((u) => u.includes('Session Boot Self-Knowledge'))).toBe(false);
    const content2 = fs.readFileSync(claudeMdPath, 'utf8');
    expect(content2.match(/\*\*Session Boot Self-Knowledge\*\*/g)).toHaveLength(1);
  });

  it('migrateScripts installs scripts/secret-get.mjs (always-overwrite)', () => {
    const r = callPrivate(newMigrator(projectDir), 'migrateScripts');
    expect(r.errors).toEqual([]);
    const scriptPath = path.join(stateDir, 'scripts', 'secret-get.mjs');
    expect(fs.existsSync(scriptPath)).toBe(true);
    const content = fs.readFileSync(scriptPath, 'utf8');
    expect(content).toContain('secret-get.mjs');
    expect(content).toContain('stdout');
    // Always-overwrite: stomp it, re-run, restored.
    fs.writeFileSync(scriptPath, '// stale fork\n');
    callPrivate(newMigrator(projectDir), 'migrateScripts');
    expect(fs.readFileSync(scriptPath, 'utf8')).toContain('Containment contract');
  });

  it('last-writer-wins pinning: fact-add then migrateConfig keeps BOTH the fact and the migration fields', () => {
    fs.writeFileSync(configPath, JSON.stringify({ projectName: 'x', port: 4042 }, null, 2) + '\n');

    // Ordering 1: fact written first, migration second — migration must not drop the fact.
    writeConfigAtomic(configPath, (cfg) => {
      const sk = ((cfg as Record<string, any>).selfKnowledge ??= {});
      (sk.operationalFacts ??= []).push({ fact: 'interleaved fact', updatedAt: '2026-06-05T00:00:00Z', machine: 'test' });
      return { value: true };
    });
    callPrivate(newMigrator(projectDir), 'migrateConfig');
    const cfg1 = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(cfg1.selfKnowledge.operationalFacts).toHaveLength(1);
    expect(cfg1.selfKnowledge.sessionContext.maxInjectedBytes).toBe(2000);

    // Ordering 2: migration first, fact second — the fact write re-reads from
    // disk inside the handler, so the migration's fields survive.
    writeConfigAtomic(configPath, (cfg) => {
      const sk = ((cfg as Record<string, any>).selfKnowledge ??= {});
      (sk.operationalFacts ??= []).push({ fact: 'second fact', updatedAt: '2026-06-05T00:00:01Z', machine: 'test' });
      return { value: true };
    });
    const cfg2 = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(cfg2.selfKnowledge.operationalFacts).toHaveLength(2);
    expect(cfg2.selfKnowledge.sessionContext.maxInjectedBytes).toBe(2000);
    expect(cfg2.projectName).toBe('x');
  });
});
