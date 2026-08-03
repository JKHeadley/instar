import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('PostUpdateMigrator — inbound queue evidence awareness', () => {
  let projectDir: string;
  let claudeMd: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-iq-awareness-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-inboundQueueAwareness.test.ts',
    });
  });

  function migrate(): MigrationResult {
    const migrator = new PostUpdateMigrator({
      projectDir,
      stateDir: path.join(projectDir, '.instar'),
      port: 4046,
      hasTelegram: false,
      projectName: 'test',
    });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  }

  it('upgrades an existing queue section with shadow, tenure-start, and detection provenance', () => {
    fs.writeFileSync(
      claudeMd,
      '# Existing\n\n**Durable Inbound Message Queue**\n' +
        '- **Queue state:** `curl -H "Authorization: Bearer $AUTH" http://localhost:4046/pool/queue` → counts (queued/claimed/held/frozen, delivered24h — which EXCLUDES possibly-not-injected), durable counters (incl. `possiblyNotInjected`, `holdBypassedByAttemptsCap`, dry-run `wouldEnqueue`/`wouldHold`), flap/hold state, tenure. 503 while dark.\n',
    );

    const result = migrate();
    expect(result.errors).toEqual([]);
    expect(result.upgraded).toContain('CLAUDE.md: inbound queue status awareness updated for shadow custody and provenance');
    const after = fs.readFileSync(claudeMd, 'utf8');
    expect(after).toContain('dry-run shadow-custody evidence');
    expect(after).toContain('tenure + its start time');
    expect(after).toContain('whether custody-durability detection actually exists');
    expect(after).not.toContain('dry-run `wouldEnqueue`/`wouldHold`');
  });

  it('is idempotent after the awareness line is current', () => {
    fs.writeFileSync(claudeMd, '# Existing\n');
    migrate();
    const first = fs.readFileSync(claudeMd, 'utf8');
    const second = migrate();
    expect(fs.readFileSync(claudeMd, 'utf8')).toBe(first);
    expect(second.upgraded).not.toContain('CLAUDE.md: inbound queue status awareness updated for shadow custody and provenance');
  });
});
