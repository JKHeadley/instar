// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('PostUpdateMigrator apprenticeship registry-integrity awareness', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'registry-integrity migration test' })));

  it('teaches existing agents active-only cycles, retained abandonment, and the integrity report exactly once', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-apprenticeship-integrity-'));
    dirs.push(projectDir);
    const claudeMd = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMd, '# Agent\n\n**Apprenticeship Program**\n\nThe standing program.\n- **When to use** (PROACTIVE): when starting or closing a mentorship/apprenticeship instance, use the registry.\n');
    const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4044, hasTelegram: false, projectName: 'test' });
    const run = () => {
      const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
      (migrator as unknown as { migrateClaudeMd(r: typeof result): void }).migrateClaudeMd(result);
      return result;
    };

    const first = run();
    const once = fs.readFileSync(claudeMd, 'utf8');
    expect(first.upgraded).toContain('CLAUDE.md: added apprenticeship registry-integrity awareness');
    expect(once).toContain('only against an existing `active` instance');
    expect(once).toContain('retained terminal `abandoned`');
    expect(once).toContain('GET /apprenticeship/cycles/integrity');

    run();
    const twice = fs.readFileSync(claudeMd, 'utf8');
    expect(twice.match(/GET \/apprenticeship\/cycles\/integrity/g)).toHaveLength(1);
  });
});
