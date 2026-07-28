/**
 * Verifies PostUpdateMigrator backfills the Topic-Flood Guard CLAUDE.md section
 * into existing agents on update (Migration Parity + Agent Awareness Standards).
 *
 * The guard itself ships in code (pure src, default-ON) so every fleet agent is
 * PROTECTED on the dist update with no config. This section is the awareness
 * layer: so an agent can answer "why are my notices grouped / where did topic X
 * go?". New agents get it via the first migrateClaudeMd run; this proves it at
 * runtime and that it is idempotent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — Topic-Flood Guard CLAUDE.md section', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-floodguard-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-topicFloodGuard.test.ts:cleanup',
    });
  });

  function newMigrator(): PostUpdateMigrator {
    return new PostUpdateMigrator({
      projectDir,
      stateDir: path.join(projectDir, '.instar'),
      port: 4042,
      hasTelegram: false,
      projectName: 'test',
    });
  }

  it('adds the Topic-Flood Guard section when CLAUDE.md does not already contain it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    const result = runClaudeMdMigration(newMigrator());
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('Topic-Flood Guard');
    expect(content).toContain('attention-suppressed.jsonl');
    expect(result.upgraded.some((u) => u.includes('Topic-Flood Guard'))).toBe(true);
  });

  it('is idempotent — a second run does not duplicate the section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    runClaudeMdMigration(newMigrator());
    const after1 = fs.readFileSync(claudeMdPath, 'utf-8');
    const result2 = runClaudeMdMigration(newMigrator());
    const after2 = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after2).toBe(after1);
    const occurrences = after2.split('## Topic-Flood Guard (attention queue circuit breaker)').length - 1;
    expect(occurrences).toBe(1);
    expect(result2.upgraded.some((u) => u.includes('Topic-Flood Guard'))).toBe(false);
  });

  it('a fresh insert carries the single-alerts-topic wording (2026-07-09 default), never the stale per-item lead', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    runClaudeMdMigration(newMigrator());
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('single durable "🔔 Attention" hub topic by default');
    expect(content).not.toContain('The attention queue spawns ONE Telegram forum topic per item');
    expect(content).not.toContain('HIGH/URGENT items are NEVER coalesced');
  });

  it('rewrites the STALE pre-flip lead paragraph + bullet in place on already-migrated agents (single-alerts-topic parity)', () => {
    const staleSection = [
      '# CLAUDE.md',
      '',
      '## Topic-Flood Guard (attention queue circuit breaker)',
      '',
      'The attention queue spawns ONE Telegram forum topic per item — right for a genuine /ack-able to-do, catastrophic when a HOUSEKEEPING feature raises items at volume. A per-source circuit breaker now sits at the topic-creation chokepoint (`TelegramAdapter.createAttentionItem`): further NON-critical items are COALESCED and recorded in `state/attention-suppressed.jsonl`. HIGH/URGENT items are NEVER coalesced (critical messages always get their own topic).',
      '',
      '- Default-ON, no config required (it ships in code). Tune via `messaging[].config.attentionTopicGuard` = `{ "enabled": true, "windowMs": 600000, "maxTopicsPerSource": 3 }`.',
      '- If a user asks "why are my notices grouped together" — read `state/attention-suppressed.jsonl`.',
      '',
    ].join('\n');
    fs.writeFileSync(claudeMdPath, staleSection);

    const result = runClaudeMdMigration(newMigrator());
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).not.toContain('The attention queue spawns ONE Telegram forum topic per item');
    expect(content).not.toContain('- Default-ON, no config required');
    expect(content).toContain('single durable "🔔 Attention" hub topic by default');
    expect(content).toContain('- Single-topic routing is the code default');
    expect(result.upgraded.some((u) => u.includes('single-alerts-topic'))).toBe(true);

    // Idempotent: a second run leaves the section byte-for-byte unchanged.
    const result2 = runClaudeMdMigration(newMigrator());
    const after2 = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after2).toBe(content);
    expect(result2.upgraded.some((u) => u.includes('single-alerts-topic'))).toBe(false);
  });
});
