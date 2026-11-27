/**
 * Migration parity for memory privacy owner recovery: agents that already have the
 * Memory privacy section still learn about blocker, fix and the repair link, once.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('PostUpdateMigrator — memory privacy recovery', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-mp-recovery-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-memoryPrivacyRecovery.test.ts' }));

  const run = () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  };

  it('reaches an agent that already has the Memory privacy section, once', () => {
    fs.writeFileSync(claudeMdPath, '# Agent\n\n- **Memory privacy**: older text with no recovery.\n');
    expect(run().upgraded).toContain('CLAUDE.md: added Memory privacy recovery');
    run();
    const text = fs.readFileSync(claudeMdPath, 'utf8');
    expect(count(text, 'one-time repair link')).toBe(1);
    expect(text).toContain('Never set');
  });
});
