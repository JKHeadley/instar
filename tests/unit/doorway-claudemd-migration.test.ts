// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1 unit tests for the Doorway/Model Knowledge Registry CLAUDE.md awareness block
 * (docs/specs/DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md §Agent Awareness / §Migration Parity):
 *   - generateClaudeMd (new agents via init) includes the awareness section;
 *   - migrateClaudeMd (existing agents via update) appends it, content-sniffed + idempotent;
 *   - the section function uses the injected port (never hardcoded).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { DOORWAY_REGISTRY_CLAUDEMD_SECTION, PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MARKER = 'Doorway/Model Knowledge Registry';

describe('Doorway registry CLAUDE.md awareness (Agent Awareness Standard)', () => {
  it('generateClaudeMd (new-install path) includes the awareness section with the GET /doorways read', () => {
    const md = generateClaudeMd('my-proj', 'echo', 4042, true);
    expect(md).toContain(MARKER);
    expect(md).toContain('GET /doorways');
    expect(md).toContain('http://localhost:4042/doorways');
    expect(md).toContain('registry-unavailable-no-instar-source');
  });

  it('the section function honors the injected port (never hardcoded)', () => {
    const s = DOORWAY_REGISTRY_CLAUDEMD_SECTION(9999);
    expect(s).toContain('http://localhost:9999/doorways');
    expect(s).not.toContain('localhost:4042');
  });
});

describe('migrateClaudeMd appends the doorway section for existing agents (Migration Parity), idempotently', () => {
  let projectDir: string;
  let stateDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorway-claudemd-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'x', port: 4042 }));
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
    // A CLAUDE.md that does NOT yet carry the doorway section.
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md — legacy agent\n\nSome existing content.\n');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/doorway-claudemd-migration.test.ts' });
  });

  function countMarker(): number {
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    return content.split(MARKER).length - 1;
  }

  it('adds the section on first migrate, then is a no-op on a second run (content-sniffed)', () => {
    expect(countMarker()).toBe(0);
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0' }).migrate();
    expect(countMarker()).toBe(1);
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toContain('GET /doorways');
    // Second run must not double-append.
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0' }).migrate();
    expect(countMarker()).toBe(1);
  });

  it('does NOT re-append when the section is already present', () => {
    fs.appendFileSync(claudeMdPath, DOORWAY_REGISTRY_CLAUDEMD_SECTION(4042));
    expect(countMarker()).toBe(1);
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0' }).migrate();
    expect(countMarker()).toBe(1);
  });
});
