// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup only.
/**
 * Migration parity — test-agent leak guard. Existing agents receive the
 * "Throwaway test agents" CLAUDE.md section on update, exactly once; new
 * agents get it from the template. A throwaway agent's migration never
 * touches the machine-wide fleet watchdog.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const realPlatform = process.platform;
let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlg-mig-')); });
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  vi.restoreAllMocks();
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-throwawayAgents.test.ts' });
});

function migrator(): PostUpdateMigrator {
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  return new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
}
function run(m: PostUpdateMigrator, method: string): MigrationResult {
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as Record<string, (r: MigrationResult) => void>)[method](r);
  return r;
}

describe('Throwaway test agents — CLAUDE.md parity', () => {
  it('appends the section once and is idempotent', () => {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Agent\n');
    const m = migrator();
    expect(run(m, 'migrateClaudeMd').upgraded).toContain('CLAUDE.md: added Throwaway test agents section');
    run(m, 'migrateClaudeMd');
    const c = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
    expect(c.split('## Throwaway test agents').length - 1).toBe(1);
  });

  it('the template carries the same section for new agents', () => {
    const md = generateClaudeMd('proj', 'Agent', 4040, false);
    expect(md).toContain('## Throwaway test agents');
  });
});

describe('fleet watchdog is never touched by a throwaway agent', () => {
  it('skips with the throwaway reason', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    const r = run(migrator(), 'migrateFleetWatchdog');
    expect(r.skipped.join(' ')).toMatch(/fleet-watchdog: throwaway agent/);
    expect(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'ai.instar.watchdog.plist'))).toBe(false);
  });
});
