/** Agent Awareness + Migration Parity for mobile multi-route (docs/specs/mobile-multi-route.md §4.5). */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator, MOBILE_ROUTES_CLAUDEMD_SECTION } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type R = { upgraded: string[]; skipped: string[]; errors: string[] };
const MARK = 'Mobile app routes';
const count = (s: string) => s.split(MARK).length - 1;

describe('Mobile app routes CLAUDE.md section', () => {
  it('new agents get it from the template, once', () => {
    expect(count(generateClaudeMd('test', 'Test', 4042, false))).toBe(1);
  });

  it('existing agents get it once through migrateClaudeMd; idempotent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-routes-md-'));
    try {
      fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
      const file = path.join(dir, 'CLAUDE.md');
      fs.writeFileSync(file, '# CLAUDE.md\n');
      const m = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
      const run = () => { const r: R = { upgraded: [], skipped: [], errors: [] }; (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(r); return r; };
      expect(run().upgraded).toContain('CLAUDE.md: added Mobile app routes section');
      run();
      expect(count(fs.readFileSync(file, 'utf8'))).toBe(1);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/mobile-routes-claude-md-awareness.test.ts' });
    }
  });

  it('names the route, the health field and the gate', () => {
    const s = MOBILE_ROUTES_CLAUDEMD_SECTION(4042);
    expect(s).toContain('GET /mobile/routes');
    expect(s).toContain('mobileRoutes');
    expect(s).toContain('mobilePairing.multiRoute.enabled');
    expect(s).toContain('http://localhost:4042/health');
  });
});
