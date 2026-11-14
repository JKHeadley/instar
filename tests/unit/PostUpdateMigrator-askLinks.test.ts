/**
 * "Every ask carries its links." — Agent Proposes, Operator Approves named clause
 * (ratified 2026-11-11, topic 141868). Agent Awareness + Migration Parity: the
 * template emits the line once, right before the surface-referral paragraph;
 * migrateClaudeMd inserts it once for existing agents, is idempotent, and
 * converges a hand-added variant on the canonical text; the framework shadow
 * marker list carries it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PostUpdateMigrator,
  ASK_LINKS_CLAUDEMD_SECTION,
  ASK_LINKS_CLAUDEMD_MARKER,
  SURFACE_REFERRAL_CLAUDEMD_SECTION,
  migrateAskLinksParagraph,
} from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const CANONICAL = '**Every ask carries its links.** When a message needs the operator to review, approve or decide, end it with a short *What I need from you* section: one line per ask in plain words, a working link to each item (check it opens first; a private view for private content), and the exact reply that settles it. An authority grant links to its Approve/Decline page instead of a reply.';

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function migrateClaudeMd(projectDir: string): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (newMigrator(projectDir) as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('Every ask carries its links — CLAUDE.md line', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ask-links-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-askLinks.test.ts:cleanup',
    });
  });

  it('the constant is the ratified wording', () => {
    expect(ASK_LINKS_CLAUDEMD_SECTION).toBe(CANONICAL);
    expect(ASK_LINKS_CLAUDEMD_SECTION.startsWith(ASK_LINKS_CLAUDEMD_MARKER)).toBe(true);
  });

  it('the template carries the line exactly once, right before the surface-referral paragraph', () => {
    const md = generateClaudeMd('test', 'Test', 4040, false);
    expect(count(md, CANONICAL)).toBe(1);
    expect(md).toContain(`${CANONICAL}\n\n${SURFACE_REFERRAL_CLAUDEMD_SECTION}`);
  });

  it('a freshly scaffolded agent is a no-op for this migration', () => {
    fs.writeFileSync(claudeMdPath, generateClaudeMd('test', 'Test', 4042, false));
    const result = migrateClaudeMd(projectDir);
    expect(result.upgraded.some(u => u.includes('Every ask carries its links'))).toBe(false);
    expect(count(fs.readFileSync(claudeMdPath, 'utf-8'), CANONICAL)).toBe(1);
  });

  it('inserts the line once for an existing agent, before the surface-referral paragraph', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    const result = migrateClaudeMd(projectDir);
    expect(result.errors).toEqual([]);
    expect(result.upgraded).toContain('CLAUDE.md: added "Every ask carries its links"');
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(count(after, CANONICAL)).toBe(1);
    expect(after.indexOf(CANONICAL)).toBeLessThan(after.indexOf(SURFACE_REFERRAL_CLAUDEMD_SECTION));
  });

  it('is idempotent on re-run', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n');
    migrateClaudeMd(projectDir);
    const first = fs.readFileSync(claudeMdPath, 'utf-8');
    const second = migrateClaudeMd(projectDir);
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toBe(first);
    expect(second.upgraded.some(u => u.includes('Every ask carries its links'))).toBe(false);
    expect(count(first, CANONICAL)).toBe(1);
  });

  it('replaces a hand-added variant with the canonical text, keeping its neighbours', () => {
    fs.writeFileSync(
      claudeMdPath,
      '# CLAUDE.md\n\nBefore paragraph.\n\n**Every ask carries its links** — always link what you want reviewed.\nSecond line of the old variant.\n\nAfter paragraph.\n',
    );
    const result = migrateClaudeMd(projectDir);
    expect(result.upgraded).toContain('CLAUDE.md: replaced a variant of "Every ask carries its links" with the canonical line');
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(count(after, CANONICAL)).toBe(1);
    expect(after).not.toContain('always link what you want reviewed');
    expect(after).not.toContain('Second line of the old variant');
    expect(after).toContain(`Before paragraph.\n\n${CANONICAL}\n\nAfter paragraph.`);
    // and converged: a second run changes nothing
    const again = migrateClaudeMd(projectDir);
    expect(again.upgraded.some(u => u.includes('Every ask carries its links'))).toBe(false);
  });

  it('a variant directly followed by a heading does not swallow the heading', () => {
    const out = migrateAskLinksParagraph('**Every ask carries its links.** old text\n### Next Section\nbody\n');
    expect(out.replaced).toBe(true);
    expect(out.content).toBe(`${CANONICAL}\n### Next Section\nbody\n`);
  });

  it('appending to a file with no final newline still starts a new paragraph', () => {
    const out = migrateAskLinksParagraph('# CLAUDE.md\n\nLast paragraph');
    expect(out.content).toBe(`# CLAUDE.md\n\nLast paragraph\n\n${CANONICAL}\n`);
  });

  it('the framework shadow marker list includes the line', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/core/PostUpdateMigrator.ts'), 'utf-8');
    const start = src.indexOf('private migrateFrameworkShadowCapabilities(');
    expect(start).toBeGreaterThan(-1);
    const markersAt = src.indexOf('const markers = [', start);
    const markersEnd = src.indexOf('];', markersAt);
    const markerBlock = src.slice(markersAt, markersEnd);
    expect(markerBlock).toContain("'**Every ask carries its links.**'");
    expect(markerBlock.indexOf("'**Every ask carries its links.**'")).toBeGreaterThan(
      markerBlock.indexOf("'**Sending the operator to a page: link, words, and look first'"),
    );
  });
});
