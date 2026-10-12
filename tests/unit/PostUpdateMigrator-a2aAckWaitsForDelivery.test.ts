/**
 * Migration parity for the ACT-091 follow-up (the relay's automatic ack waits
 * for a live session on every path): the CLAUDE.md awareness section reaches
 * existing agents (sniff key `A2A ack waits for a live session`), idempotently,
 * with the same wording the template gives new agents.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const HEADING = '### A2A ack waits for a live session';

describe('PostUpdateMigrator — A2A ack waits for a live session', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ack-waits-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-a2aAckWaitsForDelivery.test.ts' }));

  const run = () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  };
  const section = (s: string) => {
    const i = s.indexOf(HEADING);
    const end = s.indexOf('\n### ', i + 5);
    return s.slice(i, end === -1 ? undefined : end).trim();
  };

  it('adds the section once and is idempotent', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n');
    expect(run().upgraded).toContain('CLAUDE.md: added A2A ack waits for a live session section');
    const r2 = run();
    expect(r2.upgraded).not.toContain('CLAUDE.md: added A2A ack waits for a live session section');
    expect(fs.readFileSync(claudeMdPath, 'utf-8').split(HEADING).length - 1).toBe(1);
  });

  it('the template carries the same wording, with the proactive trigger', () => {
    const md = generateClaudeMd('test', 'Test', 4040, false);
    expect(md).toContain(HEADING);
    expect(md).toContain('`Auto-ack withheld`');
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n');
    run();
    expect(section(fs.readFileSync(claudeMdPath, 'utf-8'))).toBe(section(md));
  });
});
