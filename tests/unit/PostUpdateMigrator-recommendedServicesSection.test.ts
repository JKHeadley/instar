/** Agent Awareness + Migration Parity for recommended services: both paths, once, and short. */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator, RECOMMENDED_SERVICES_CLAUDEMD_SECTION, RECOMMENDED_SERVICES_V1_TAIL, RECOMMENDED_SERVICES_V2_TAIL, RECOMMENDED_SERVICES_V3_TAIL } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MARKER = 'Recommended outside services (';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-recommendedServicesSection.test.ts' }); });

describe('recommended services awareness', () => {
  it('is in the template, and stays short on purpose', () => {
    expect(RECOMMENDED_SERVICES_CLAUDEMD_SECTION(4040)).toContain(MARKER);
    expect(RECOMMENDED_SERVICES_CLAUDEMD_SECTION(4040).length).toBeLessThan(1400);
    expect(generateClaudeMd('p', 'a', 4040, false)).toContain(MARKER);
  });
  it('an existing agent gets it once on update', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-mig-'));
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
  it('a legacy-layout agent on the v1 or v2 wording reaches the v3 wording in place, once, and the template already carries it', () => {
    expect(RECOMMENDED_SERVICES_CLAUDEMD_SECTION(4040)).toContain(RECOMMENDED_SERVICES_V3_TAIL);
    expect(RECOMMENDED_SERVICES_CLAUDEMD_SECTION(4040)).not.toContain(RECOMMENDED_SERVICES_V1_TAIL);
    expect(RECOMMENDED_SERVICES_CLAUDEMD_SECTION(4040)).not.toContain(RECOMMENDED_SERVICES_V2_TAIL);
    expect(RECOMMENDED_SERVICES_V3_TAIL).toContain('recommendedServices.offers.enabled');
    for (const older of [RECOMMENDED_SERVICES_V1_TAIL, RECOMMENDED_SERVICES_V2_TAIL]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-mig-v3-'));
      dirs.push(dir);
      const stateDir = path.join(dir, '.instar');
      fs.mkdirSync(stateDir, { recursive: true });
      const old = RECOMMENDED_SERVICES_CLAUDEMD_SECTION(4040).replace(RECOMMENDED_SERVICES_V3_TAIL, older);
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# Agent\n${old}`);
      const m = new PostUpdateMigrator({ projectDir: dir, stateDir, port: 4040, hasTelegram: false, projectName: 'p' } as never);
      const run = () => (m as unknown as { migrateClaudeMd(r: { upgraded: string[]; skipped: string[]; errors: string[] }): void }).migrateClaudeMd({ upgraded: [], skipped: [], errors: [] });
      run(); run();
      const text = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
      expect(text.split(MARKER).length - 1).toBe(1);
      expect(text).not.toContain(RECOMMENDED_SERVICES_V1_TAIL);
      expect(text).not.toContain(RECOMMENDED_SERVICES_V2_TAIL);
      expect(text.split(RECOMMENDED_SERVICES_V3_TAIL).length - 1).toBe(1);
    }
  });
});
