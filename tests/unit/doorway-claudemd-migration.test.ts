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
    expect(md).toContain('Existing jobs keep their saved schedule.');
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
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'x', port: 4042 , claudeMd: { layout: 'full' } /* tests the legacy append chain; the reference-layout conversion is covered in claude-md-reference-layout.test.ts */ }));
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

  it('replaces the shipped schedule bullet once and preserves nearby edits', () => {
    const old = `- **Keeping the map current** is a recurring \`doorway-scan\` job that re-probes each door and surfaces ONE plain-English heads-up only when something changes. It ships **OFF by default** (dark for the fleet; the job manifest is \`enabled:false\`) — enable it per maintainer agent via the \`doorway-scan\` job manifest (free-probes spends zero metered budget; metered probes are manual-only + budget-fail-closed). The \`maintenance.doorwayScan\` config block (\`scope\`/\`cadence\`/\`digestTopicId\`/\`budgetCapUsd\`) tunes it; an explicit \`maintenance.doorwayScan.enabled:false\` is a master kill-switch (deny-wins).`;
    const custom = '- Our doorway scan runs on Tuesdays.';
    const currentSection = DOORWAY_REGISTRY_CLAUDEMD_SECTION(4042);
    fs.appendFileSync(claudeMdPath, currentSection.replace(/^- \*\*Keeping the map current\*\*.*$/m, () => old) + custom + '\n');
    const migrate = () => new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0' }).migrate();
    migrate();
    const first = fs.readFileSync(claudeMdPath, 'utf8');
    expect(first).toContain('Existing jobs keep their saved schedule.');
    expect(first).toContain(custom);
    expect(first).not.toContain(old);
    migrate();
    expect(countMarker()).toBe(1);
    expect(fs.readFileSync(claudeMdPath, 'utf8')).toContain('Existing jobs keep their saved schedule.');
  });

  it('keeps an agent-customized schedule bullet', () => {
    const custom = '- **Keeping the map current** follows our Tuesday maintenance window.';
    const currentSection = DOORWAY_REGISTRY_CLAUDEMD_SECTION(4042);
    fs.appendFileSync(claudeMdPath, currentSection.replace(/^- \*\*Keeping the map current\*\*.*$/m, () => custom));
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0' }).migrate();
    expect(countMarker()).toBe(1);
    expect(fs.readFileSync(claudeMdPath, 'utf8')).toContain(custom);
  });

  it('does NOT re-append when the section is already present', () => {
    fs.appendFileSync(claudeMdPath, DOORWAY_REGISTRY_CLAUDEMD_SECTION(4042));
    expect(countMarker()).toBe(1);
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0' }).migrate();
    expect(countMarker()).toBe(1);
  });
});
