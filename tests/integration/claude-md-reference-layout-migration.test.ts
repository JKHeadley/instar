/**
 * Integration: a full PostUpdateMigrator.migrate() over an existing agent's
 * ~500k legacy CLAUDE.md (docs/specs/claude-md-reference-layout.md §2.4).
 * Every other migration runs first, then the conversion; AGENTS.md mirroring
 * keeps working from the canonical document once CLAUDE.md is small.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { AWARENESS_REGISTRY_START, createRegistry, emptyRegistry, type AwarenessRegistry } from '../../src/awareness/registry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import {
  CLAUDE_MD_CORE_BUDGET_CHARS,
  CLAUDE_MD_LEGACY_BACKUP_REL,
  REFERENCE_DIR_REL,
  findCoreRegion,
} from '../../src/scaffold/claudeMdLayout.js';

describe('CLAUDE.md reference layout — full migrate() on a legacy agent', () => {
  let tmp: string;
  let projectDir: string;
  let stateDir: string;
  let legacy: string;
  let first: { upgraded: string[]; errors: string[] };

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-layout-int-'));
    projectDir = path.join(tmp, 'agent');
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'legacy', port: 4043 }));
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Legacy\n\n## Who I Am\n\nI am Legacy.\n');
    // A legacy agent: the old full template plus an operator's own section.
    legacy = generateClaudeMd('legacy', 'Legacy', 4043, false)
      .replaceAll('| Where did we discuss this before? | `GET /mobile/conversations/search?q=...&scope=pool` (app, Telegram, and Slack history) |',
        '| Something I wrote before | `GET /memory/search?q=...` |') + '\n## Shop Rules\n\nNever ship on Fridays.\n';
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), legacy);
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# AGENTS.md — legacy\n\nCodex shadow.\n');
    const m = new PostUpdateMigrator({ projectDir, stateDir, port: 4043, hasTelegram: false, projectName: 'legacy' });
    first = m.migrate();
  }, 300_000);

  afterAll(() => {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/claude-md-reference-layout-migration.test.ts' });
  });

  it('produces the small CLAUDE.md, the backup, the reference files and keeps the operator section', () => {
    const claudeMd = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(first.errors.filter(e => /CLAUDE|reference/i.test(e))).toEqual([]);
    expect(claudeMd.length).toBeLessThan(CLAUDE_MD_CORE_BUDGET_CHARS);
    expect(findCoreRegion(claudeMd)).not.toBeNull();
    expect(claudeMd).toContain('Never ship on Fridays.');
    expect(claudeMd).toContain('I am Legacy,');
    expect(fs.readFileSync(path.join(projectDir, CLAUDE_MD_LEGACY_BACKUP_REL), 'utf-8').length).toBeGreaterThanOrEqual(legacy.length);
    const refDir = path.join(projectDir, REFERENCE_DIR_REL);
    const files = fs.readdirSync(refDir);
    expect(files).toContain('INDEX.md');
    expect(files.length).toBeGreaterThan(8);
    // Migration-appended sections (not in the template) reach the reference files.
    const allRef = files.map(f => fs.readFileSync(path.join(refDir, f), 'utf-8')).join('\n');
    expect(allRef).toContain('### Quota-enforcement scheduler pause');
    expect(claudeMd).toContain('| Where did we discuss this before? | `GET /mobile/conversations/search?q=...&scope=pool`');
    expect(allRef).toContain('http://localhost:4043/mobile/conversations/search?scope=pool&limit=10');
    expect(claudeMd).not.toContain('/memory/search');
    expect(allRef).not.toContain('/memory/search');
    expect(first.upgraded.some(u => u.startsWith('CLAUDE.md: moved'))).toBe(true);
  });

  it('AGENTS.md mirroring still gets its capability sections', () => {
    const agents = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('### Quota-enforcement scheduler pause');
  });

  it('a second migrate() leaves CLAUDE.md and the reference files unchanged', () => {
    const before = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    const m = new PostUpdateMigrator({ projectDir, stateDir, port: 4043, hasTelegram: false, projectName: 'legacy' });
    const second = m.migrate();
    expect(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8')).toBe(before);
    expect(second.upgraded.filter(u => /CLAUDE\.md|reference/.test(u))).toEqual([]);
  }, 300_000);
});

/**
 * Awareness entry registry (docs/specs/awareness-entry-registry.md): a feature's
 * awareness text is one data file. Through a full migrate() on a legacy agent it
 * lands in a reference file, is named in the core list, reaches the Codex copy,
 * and an edited body replaces the old text on the next migration.
 */
describe('awareness entry registry — full migrate() with a fixture entry', () => {
  let tmp: string;
  let projectDir: string;
  let stateDir: string;
  let first: { upgraded: string[]; errors: string[] };

  function registryOf(body: string): AwarenessRegistry {
    const dir = fs.mkdtempSync(path.join(tmp, 'entries-'));
    fs.writeFileSync(path.join(dir, 'README.md'), '# skipped\n');
    fs.writeFileSync(path.join(dir, 'zylophone-fixture.md'), `---\ntitle: Zylophone fixture note\n---\n${body}\n`);
    return createRegistry(pathToFileURL(dir + path.sep));
  }
  const migratorWith = (awarenessRegistry: AwarenessRegistry) =>
    new PostUpdateMigrator({ projectDir, stateDir, port: 4043, hasTelegram: false, projectName: 'legacy', awarenessRegistry });
  const read = (rel: string) => fs.readFileSync(path.join(projectDir, rel), 'utf-8');
  const referenceFiles = () => {
    const refDir = path.join(projectDir, REFERENCE_DIR_REL);
    return fs.readdirSync(refDir).sort().map(f => [f, fs.readFileSync(path.join(refDir, f), 'utf-8')] as const);
  };

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-registry-int-'));
    projectDir = path.join(tmp, 'agent');
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'legacy', port: 4043 }));
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Legacy\n\n## Who I Am\n\nI am Legacy.\n');
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), generateClaudeMd('legacy', 'Legacy', 4043, false, false, false, emptyRegistry()) + '\n## Shop Rules\n\nNever ship on Fridays.\n');
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# AGENTS.md — legacy\n\nCodex shadow.\n');
    first = migratorWith(registryOf('The first fixture wording, on port {{port}}.')).migrate();
  }, 300_000);

  afterAll(() => {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/claude-md-reference-layout-migration.test.ts' });
  });

  it('the entry lands in exactly one reference file, is named in the core list, and CLAUDE.md holds no marker line', () => {
    expect(first.errors.filter(e => /CLAUDE|reference|awareness/i.test(e))).toEqual([]);
    const claudeMd = read('CLAUDE.md');
    expect(findCoreRegion(claudeMd)).not.toBeNull();
    expect(claudeMd.length).toBeLessThan(CLAUDE_MD_CORE_BUDGET_CHARS);
    expect(claudeMd).toContain('Zylophone fixture note');
    expect(claudeMd).not.toContain('The first fixture wording');
    expect(claudeMd).not.toContain('instar:awareness-registry');
    expect(claudeMd).toContain('Never ship on Fridays.');
    const holding = referenceFiles().filter(([name, text]) => name !== 'INDEX.md' && text.includes('**Zylophone fixture note** — The first fixture wording, on port 4043.'));
    expect(holding).toHaveLength(1);
    expect(referenceFiles().every(([, text]) => !text.includes('instar:awareness-registry'))).toBe(true);
    expect(read(`${REFERENCE_DIR_REL}/INDEX.md`)).toContain('Zylophone fixture note');
  });

  it('the Codex copy holds the marked block once, after its mirrored sections', () => {
    const agents = read('AGENTS.md');
    expect(agents.split(AWARENESS_REGISTRY_START)).toHaveLength(2);
    expect(agents.split('**Zylophone fixture note** — ')).toHaveLength(2);
    expect(agents).toContain('### Quota-enforcement scheduler pause');
    expect(agents.indexOf('### Quota-enforcement scheduler pause')).toBeLessThan(agents.indexOf(AWARENESS_REGISTRY_START));
  });

  it('an edited body replaces the old text on the next migration; a further migration changes nothing', () => {
    const edited = registryOf('The second fixture wording.');
    const second = migratorWith(edited).migrate();
    expect(second.errors.filter(e => /CLAUDE|reference|awareness/i.test(e))).toEqual([]);
    const allRef = referenceFiles().map(([, text]) => text).join('\n');
    expect(allRef).toContain('**Zylophone fixture note** — The second fixture wording.');
    expect(allRef).not.toContain('The first fixture wording');
    const agents = read('AGENTS.md');
    expect(agents).toContain('**Zylophone fixture note** — The second fixture wording.');
    expect(agents).not.toContain('The first fixture wording');
    expect(agents.split(AWARENESS_REGISTRY_START)).toHaveLength(2);

    const before = { claudeMd: read('CLAUDE.md'), agents, refs: referenceFiles() };
    const third = migratorWith(edited).migrate();
    expect(read('CLAUDE.md')).toBe(before.claudeMd);
    expect(read('AGENTS.md')).toBe(before.agents);
    expect(referenceFiles()).toEqual(before.refs);
    expect(third.upgraded.filter(u => /CLAUDE\.md|reference|AGENTS\.md/.test(u))).toEqual([]);
  }, 300_000);
});
