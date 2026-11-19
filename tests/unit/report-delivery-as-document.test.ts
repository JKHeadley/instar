// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Reports for a person are delivered as a document (fb-3bc8a879-2c7).
 *
 * The shipped Feature Proactivity rows told agents to publish research with the
 * Private Viewer only. While documents serve, POST /view refuses, so a session
 * fell back to a repo file and a GitHub link. These tests pin:
 *   - new agents (generateClaudeMd) get the document-first rows, not the retired ones;
 *   - existing agents (migrateClaudeMd) have each retired row replaced, idempotently,
 *     in both the full and the reference CLAUDE.md layouts;
 *   - a row the agent edited by hand is left alone;
 *   - the Documents awareness entry names the GitHub-link case.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateClaudeMd,
  generateAgentMd,
  DOC_DELIVERY_ROW_USER,
  DOC_DELIVERY_ROW_PRODUCE,
  RETIRED_DOC_DELIVERY_ROWS,
  RETIRED_AGENT_PRINCIPLE_WORDING,
  PRIVATE_VIEWS_SENTENCE,
} from '../../src/scaffold/templates.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { defaultRegistry } from '../../src/awareness/registry.js';

const [RETIRED_USER, RETIRED_PRODUCE, RETIRED_VIEWS] = RETIRED_DOC_DELIVERY_ROWS.map(([retired]) => retired);

describe('report delivery rows (new agents)', () => {
  it('generateClaudeMd carries the document-first rows and none of the retired ones', () => {
    const md = generateClaudeMd('my-proj', 'echo', 4042, true);
    expect(md).toContain(DOC_DELIVERY_ROW_USER);
    expect(md).toContain(DOC_DELIVERY_ROW_PRODUCE);
    expect(md).not.toContain(RETIRED_USER);
    expect(md).not.toContain(RETIRED_PRODUCE);
    expect(md).toContain(PRIVATE_VIEWS_SENTENCE);
    expect(md).not.toContain(RETIRED_VIEWS);
  });

  it('the produce row names the document route, the GitHub case and the documents-off fallback', () => {
    expect(DOC_DELIVERY_ROW_PRODUCE).toContain('POST /docs');
    expect(DOC_DELIVERY_ROW_PRODUCE).toContain('GitHub link');
    expect(DOC_DELIVERY_ROW_PRODUCE).toContain('503 documents-off');
  });

  it('the new-agent identity principles no longer send reports to the Private Viewer alone', () => {
    const agentMd = generateAgentMd({ name: 'Echo', role: 'r', personality: 'p', userName: 'U' } as never);
    expect(agentMd).not.toContain('(Telegraph for public, Private Viewer for private). Research');
    expect(agentMd).toContain('A file in a repo with a GitHub link is not delivery to a person.');
  });

  it('the Documents awareness entry names the GitHub-link case', () => {
    const entry = defaultRegistry().eligibleEntries({ port: 4042, hasTelegram: false }).find((e) => e.id === 'instar-documents');
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).toContain('never a GitHub file link');
  });
});

describe.each(['full', 'reference'] as const)('migrateClaudeMd replaces the retired rows (%s layout)', (layout) => {
  let projectDir: string;
  let stateDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-delivery-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'x', port: 4042, claudeMd: { layout } }));
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
    // An existing agent's CLAUDE.md as the previous release wrote it.
    const legacy = generateClaudeMd('x', 'echo', 4042, true)
      .replace(DOC_DELIVERY_ROW_USER, RETIRED_USER)
      .replace(DOC_DELIVERY_ROW_PRODUCE, RETIRED_PRODUCE)
      .replace(PRIVATE_VIEWS_SENTENCE, RETIRED_VIEWS);
    expect(legacy).toContain(RETIRED_PRODUCE);
    fs.writeFileSync(claudeMdPath, legacy);
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/report-delivery-as-document.test.ts' });
  });

  const read = () => fs.readFileSync(claudeMdPath, 'utf-8');
  const count = (s: string, needle: string) => s.split(needle).length - 1;

  it('replaces both rows on the first run and is a no-op on the second', () => {
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0' }).migrate();
    const once = read();
    expect(once).not.toContain(RETIRED_USER);
    expect(once).not.toContain(RETIRED_PRODUCE);
    expect(count(once, DOC_DELIVERY_ROW_PRODUCE)).toBe(1);
    expect(count(once, DOC_DELIVERY_ROW_USER)).toBe(1);
    expect(once).not.toContain(RETIRED_VIEWS);
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0' }).migrate();
    expect(read()).toBe(once);
  });
});

describe('migrateClaudeMd leaves an edited row alone', () => {
  let projectDir: string;
  let stateDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-delivery-edited-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'x', port: 4042, claudeMd: { layout: 'full' } }));
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\n- I produce **research** → my own house rule for reports.\n');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/report-delivery-as-document.test.ts' });
  });

  it('does not touch a hand-edited row', () => {
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0' }).migrate();
    const md = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(md).toContain('- I produce **research** → my own house rule for reports.');
  });
});

describe('existing AGENT.md principles are migrated', () => {
  let projectDir: string;
  let stateDir: string;
  let agentMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-delivery-agentmd-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'x', port: 4042, claudeMd: { layout: 'full' } }));
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# CLAUDE.md\n');
    agentMdPath = path.join(stateDir, 'AGENT.md');
    const legacy = generateAgentMd({ name: 'Echo', role: 'r', personality: 'p', userName: 'U' } as never)
      .replace(RETIRED_AGENT_PRINCIPLE_WORDING[0][1], RETIRED_AGENT_PRINCIPLE_WORDING[0][0])
      .replace(RETIRED_AGENT_PRINCIPLE_WORDING[1][1], RETIRED_AGENT_PRINCIPLE_WORDING[1][0]);
    expect(legacy).toContain(RETIRED_AGENT_PRINCIPLE_WORDING[1][0]);
    fs.writeFileSync(agentMdPath, legacy + '\n' + RETIRED_VIEWS + '\n');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/report-delivery-as-document.test.ts' });
  });

  it('replaces principles 6 and 9 and the private-views line, then is a no-op', () => {
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0' }).migrate();
    const once = fs.readFileSync(agentMdPath, 'utf-8');
    for (const [retired, current] of RETIRED_AGENT_PRINCIPLE_WORDING) {
      expect(once).not.toContain(retired);
      expect(once).toContain(current);
    }
    expect(once).not.toContain(RETIRED_VIEWS);
    expect(once).toContain(PRIVATE_VIEWS_SENTENCE);
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0' }).migrate();
    expect(fs.readFileSync(agentMdPath, 'utf-8')).toBe(once);
  });
});
