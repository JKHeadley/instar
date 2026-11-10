// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PostUpdateMigrator, JOB_TOOL_LIMITS_CLAUDEMD_MARKER } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type Result = { upgraded: string[]; skipped: string[]; errors: string[] };
const dirs: string[] = [];

function migrate(projectDir: string): Result {
  const result: Result = { upgraded: [], skipped: [], errors: [] };
  const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'echo' });
  (migrator as unknown as { migrateClaudeMd(value: Result): void }).migrateClaudeMd(result);
  return result;
}

describe('Job tool limits — agent awareness (EVO-008 §9)', () => {
  afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-jobToolLimits.test.ts' }); });

  it('generateClaudeMd carries the section once, with the run read and the switch', () => {
    const fresh = generateClaudeMd('instar', 'Echo', 4042, true);
    expect(fresh.split(JOB_TOOL_LIMITS_CLAUDEMD_MARKER)).toHaveLength(2);
    expect(fresh).toContain('http://localhost:4042/jobs/SLUG/history');
    expect(fresh).toContain('toolsConfined');
    expect(fresh).toContain('jobs.toolAllowlistEnforcement.enabled');
    expect(fresh).toContain('toolAllowlistEnforce: true');
    expect(fresh).toContain('Never tell anyone a job "can only read" from its list alone');
  });

  it('migrateClaudeMd adds it once to an existing agent (content-sniffed, idempotent)', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-tool-limits-awareness-'));
    dirs.push(projectDir);
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Existing agent\n');
    expect(migrate(projectDir).upgraded).toContain('CLAUDE.md: added Job tool limits section');
    const second = migrate(projectDir);
    expect(second.upgraded).not.toContain('CLAUDE.md: added Job tool limits section');
    expect(second.skipped).toContain('CLAUDE.md: Job tool limits section already present');
    expect(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8').split(JOB_TOOL_LIMITS_CLAUDEMD_MARKER)).toHaveLength(2);
  });
});
