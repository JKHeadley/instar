import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator, MACHINE_MEMORY_CARE_CLAUDE_MD_LINE } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type R = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('PostUpdateMigrator — machine memory care line (docs/specs/machine-memory-care.md)', () => {
  let dir = '';
  afterEach(() => { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-machineMemoryCare.test.ts' }); });
  const run = (body: string): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-memcare-line-'));
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    const p = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(p, body);
    const m = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'x' } as never);
    const once = (): void => (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd({ upgraded: [], skipped: [], errors: [] });
    once(); once();
    return fs.readFileSync(p, 'utf8');
  };

  it('adds the line exactly once to an agent with the pool section (idempotent)', () => {
    const out = run('# Agent\n\n**Multi-Machine Session Pool (active-active — spread conversations)**\n');
    expect(out.split('Machine memory care (swap counts').length).toBe(2);
    expect(out).toContain(MACHINE_MEMORY_CARE_CLAUDE_MD_LINE);
  });

  it('the template carries the same line, so new and updated agents agree', () => {
    expect(generateClaudeMd('p', 'a', 4042, false)).toContain(MACHINE_MEMORY_CARE_CLAUDE_MD_LINE);
  });
});
