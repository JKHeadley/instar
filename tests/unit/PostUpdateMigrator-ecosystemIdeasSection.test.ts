/** Agent Awareness + Migration Parity for the idea pipeline: both paths, once, and short. */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator, ECOSYSTEM_IDEAS_CLAUDEMD_SECTION } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MARKER = 'Ideas from similar projects (';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-ecosystemIdeasSection.test.ts' }); });

describe('ecosystem ideas awareness', () => {
  it('is in the template, and stays short on purpose', () => {
    expect(ECOSYSTEM_IDEAS_CLAUDEMD_SECTION(4040)).toContain(MARKER);
    expect(ECOSYSTEM_IDEAS_CLAUDEMD_SECTION(4040).length).toBeLessThan(1400);
    expect(generateClaudeMd('p', 'a', 4040, false)).toContain(MARKER);
  });
  it('an existing agent gets it once on update', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-mig-'));
    dirs.push(dir);
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Agent\n');
    const m = new PostUpdateMigrator({ projectDir: dir, stateDir, port: 4040, hasTelegram: false, projectName: 'p' } as never);
    const run = () => (m as unknown as { migrateClaudeMd(r: { upgraded: string[]; skipped: string[]; errors: string[] }): void }).migrateClaudeMd({ upgraded: [], skipped: [], errors: [] });
    run(); run();
    const text = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
    expect(text.split(MARKER).length - 1).toBe(1);
  });
});
