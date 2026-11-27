/**
 * Fresh-install lifecycle (production scaffold path): `instar init --standalone`
 * writes a CLAUDE.md far under Claude Code's 150k limit, carrying the core
 * rules and the "read on demand" table, with every feature section in
 * .instar/reference/ (docs/specs/claude-md-reference-layout.md §2.3). The
 * first server start runs the migrator over it, which must leave it small.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initProject } from '../../src/commands/init.js';
import { createRegistry, defaultRegistry, emptyRegistry, unreportedRegistryDegradations } from '../../src/awareness/registry.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  CLAUDE_MD_CORE_BUDGET_CHARS,
  CLAUDE_MD_LEGACY_BACKUP_REL,
  REFERENCE_DIR_REL,
  findCoreRegion,
} from '../../src/scaffold/claudeMdLayout.js';

describe('fresh init writes the small CLAUDE.md + reference files', () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-claude-md-layout-init-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    SafeFsExecutor.safeRmSync(tmpHome, { recursive: true, force: true, operation: 'tests/e2e/claude-md-reference-layout-init-lifecycle.test.ts' });
  });

  it('standalone init → small CLAUDE.md with dispatch table; first update keeps it small', async () => {
    const agentName = 'cml-' + Math.random().toString(36).slice(2, 8);
    await initProject({ name: agentName, standalone: true, port: 4098, skipPrereqs: true });
    const agentDir = path.join(tmpHome, '.instar', 'agents', agentName);
    const claudeMdPath = path.join(agentDir, 'CLAUDE.md');

    const md = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(md.length).toBeLessThan(CLAUDE_MD_CORE_BUDGET_CHARS);
    expect(findCoreRegion(md)).not.toBeNull();
    expect(md).toContain('## Instar Reference — read on demand');
    expect(md).toContain('### Self-Discovery');
    expect(fs.existsSync(path.join(agentDir, CLAUDE_MD_LEGACY_BACKUP_REL))).toBe(false);

    const refDir = path.join(agentDir, REFERENCE_DIR_REL);
    const index = fs.readFileSync(path.join(refDir, 'INDEX.md'), 'utf-8');
    expect(index).toContain('Normal-Chrome browser');
    const allRef = fs.readdirSync(refDir).map(f => fs.readFileSync(path.join(refDir, f), 'utf-8')).join('\n');
    expect(allRef).toContain('### Normal-Chrome browser (account-bound web tasks, macOS + Windows + Linux)');
    expect(md).toContain('| Where did we discuss this before? | `GET /mobile/conversations/search?q=...&scope=pool`');
    expect(allRef).toContain('http://localhost:4098/mobile/conversations/search?scope=pool&limit=10');
    expect(md).not.toContain('/memory/search');
    expect(allRef).not.toContain('/memory/search');

    // First server start: the migrator runs (now with Telegram configured).
    const result = new PostUpdateMigrator({
      projectDir: agentDir, stateDir: path.join(agentDir, '.instar'), port: 4098, hasTelegram: true, projectName: agentName,
    }).migrate();
    expect(result.errors.filter(e => /CLAUDE|reference/i.test(e))).toEqual([]);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after.length).toBeLessThan(CLAUDE_MD_CORE_BUDGET_CHARS);
    expect(after).toContain('## Telegram Relay');
    expect(after).not.toContain('Kept from the previous CLAUDE.md');
  }, 300_000);

  // Awareness entry registry (docs/specs/awareness-entry-registry.md): on the production
  // start path the entry folder has no error, a fresh agent's files are what they are
  // without the mechanism while the folder has no entry, and a second update changes nothing.
  it('awareness entries: no error at start, files unchanged with no entry, a fixture entry lands in a reference file', async () => {
    const agentName = 'cml-' + Math.random().toString(36).slice(2, 8);
    await initProject({ name: agentName, standalone: true, port: 4098, skipPrereqs: true });
    const agentDir = path.join(tmpHome, '.instar', 'agents', agentName);
    const refDir = path.join(agentDir, REFERENCE_DIR_REL);
    const snapshot = () => ({
      claudeMd: fs.readFileSync(path.join(agentDir, 'CLAUDE.md'), 'utf-8'),
      refs: fs.readdirSync(refDir).sort().map(f => [f, fs.readFileSync(path.join(refDir, f), 'utf-8')]),
    });
    const config = { projectDir: agentDir, stateDir: path.join(agentDir, '.instar'), port: 4098, hasTelegram: false, projectName: agentName };

    // What the server reports at start: nothing, because the real folder has no bad entry.
    expect(defaultRegistry().errors()).toEqual([]);
    expect(unreportedRegistryDegradations()).toEqual([]);

    const firstUpdate = new PostUpdateMigrator(config).migrate();
    expect(firstUpdate.errors.filter(e => /CLAUDE|reference|awareness/i.test(e))).toEqual([]);
    const real = snapshot();
    expect(real.claudeMd).not.toContain('instar:awareness-registry');

    // A second update changes nothing.
    new PostUpdateMigrator(config).migrate();
    expect(snapshot()).toEqual(real);

    // The same agent built with NO entries at all: identical exactly when the real folder has none.
    new PostUpdateMigrator({ ...config, awarenessRegistry: emptyRegistry() }).migrate();
    const withoutEntries = snapshot();
    const noRealEntries = defaultRegistry().eligibleEntries({ port: 4098, hasTelegram: false }).length === 0;
    expect(JSON.stringify(withoutEntries) === JSON.stringify(real)).toBe(noRealEntries);
    expect(withoutEntries.claudeMd).not.toContain('Feature notes');

    // With a fixture entry: it lands in one reference file and the core names it; a second update changes nothing.
    const entryDir = fs.mkdtempSync(path.join(tmpHome, 'entries-'));
    fs.writeFileSync(path.join(entryDir, 'zylophone-fixture.md'), '---\ntitle: Zylophone fixture note\n---\nA fixture note on port {{port}}.\n');
    const fixture = createRegistry(pathToFileURL(entryDir + path.sep));
    const withFixture = new PostUpdateMigrator({ ...config, awarenessRegistry: fixture }).migrate();
    expect(withFixture.errors.filter(e => /CLAUDE|reference|awareness/i.test(e))).toEqual([]);
    const landed = snapshot();
    expect(landed.claudeMd.length).toBeLessThan(CLAUDE_MD_CORE_BUDGET_CHARS);
    expect(landed.claudeMd).toContain('Zylophone fixture note');
    expect(landed.claudeMd).not.toContain('A fixture note on port');
    expect(landed.refs.filter(([name, text]) => name !== 'INDEX.md' && text.includes('**Zylophone fixture note** — A fixture note on port 4098.'))).toHaveLength(1);
    new PostUpdateMigrator({ ...config, awarenessRegistry: fixture }).migrate();
    expect(snapshot()).toEqual(landed);
  }, 600_000);
});
