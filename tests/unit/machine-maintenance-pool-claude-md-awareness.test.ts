/** Agent Awareness + Migration Parity for the machine maintenance pool view (CMT-1199). */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator, MACHINE_MAINTENANCE_POOL_CLAUDEMD_SECTION } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type R = { upgraded: string[]; skipped: string[]; errors: string[] };
const HEADING = '### Restart care on every machine (read-only)';
const count = (s: string) => s.split(HEADING).length - 1;

describe('Machine maintenance pool view CLAUDE.md section', () => {
  it('new agents get it from the template, once, with the curl line', () => {
    const md = generateClaudeMd('test', 'Test', 4042, false);
    expect(count(md)).toBe(1);
    expect(md).toContain('http://localhost:4042/machine-maintenance?scope=pool');
  });

  it('existing agents that already have the maintenance sections get it once through migrateClaudeMd; idempotent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-pool-md-'));
    try {
      fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
      const file = path.join(dir, 'CLAUDE.md');
      fs.writeFileSync(file, '# CLAUDE.md\nRead GET /machine-maintenance and /machine-maintenance/lock-state.\n');
      const m = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
      const run = () => { const r: R = { upgraded: [], skipped: [], errors: [] }; (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(r); return r; };
      expect(run().upgraded).toContain('CLAUDE.md: added machine maintenance pool view section');
      expect(run().skipped).toContain('CLAUDE.md: machine maintenance pool view section already present');
      expect(count(fs.readFileSync(file, 'utf8'))).toBe(1);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-maintenance-pool-claude-md-awareness.test.ts' });
    }
  });

  it('says it is read-only and that a failed row means can\'t tell', () => {
    const s = MACHINE_MAINTENANCE_POOL_CLAUDEMD_SECTION(4042);
    expect(s).toContain('authority: "none"');
    expect(s).toContain('canRestart: false');
    expect(s).toContain('route-missing');
    expect(s).toContain('"can\'t tell", never "fine"');
  });
});
