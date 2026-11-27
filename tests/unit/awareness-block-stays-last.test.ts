/**
 * The awareness-registry feature-notes block stays the LAST thing in CLAUDE.md
 * (docs/specs/awareness-entry-registry.md). `insertContextDeathClaudeBlock` runs after
 * `migrateClaudeMd` wrote the block; it must insert before the block, never past it.
 * Otherwise the next update moves the block back to the end and CLAUDE.md changes on
 * every run (seen live with the first registry entries, PRs #3053 and #3183).
 */
import { describe, it, expect } from 'vitest';
import { insertContextDeathClaudeBlock } from '../../src/core/PostUpdateMigrator.js';
import { AWARENESS_REGISTRY_START, AWARENESS_REGISTRY_END, AWARENESS_REGISTRY_HEADING, findRegistryBlock } from '../../src/awareness/registry.js';

const BLOCK = `${AWARENESS_REGISTRY_START}\n${AWARENESS_REGISTRY_HEADING}\n\nNotes added by individual features, one per entry.\n\n**A feature** — some text.\n${AWARENESS_REGISTRY_END}\n`;
const MARKER = 'INSTAR:ANTI-PATTERN-CONTEXT-DEATH';

function blockIsLast(doc: string): boolean {
  const b = findRegistryBlock(doc);
  return b.state === 'well-formed' && b.end === doc.length;
}

describe('the anti-pattern step keeps the feature-notes block last', () => {
  it('creates the Critical Anti-Patterns section before the block when the file has none', () => {
    const doc = `# CLAUDE.md\n\n## Some section\n\ntext\n\n${BLOCK}`;
    const out = insertContextDeathClaudeBlock(doc);
    expect(out).toContain(MARKER);
    expect(out.indexOf('## Critical Anti-Patterns')).toBeLessThan(out.indexOf(AWARENESS_REGISTRY_START));
    expect(blockIsLast(out)).toBe(true);
    expect(out.endsWith(BLOCK)).toBe(true);
  });

  it('inserts into an existing last section without reaching into the block', () => {
    const doc = `# CLAUDE.md\n\n## Critical Anti-Patterns\n\nexisting\n\n${BLOCK}`;
    const out = insertContextDeathClaudeBlock(doc);
    expect(out.indexOf(MARKER)).toBeLessThan(out.indexOf(AWARENESS_REGISTRY_START));
    expect(blockIsLast(out)).toBe(true);
    expect(out.endsWith(BLOCK)).toBe(true);
  });

  it('is a no-op the second time', () => {
    const doc = `# CLAUDE.md\n\n## Some section\n\ntext\n\n${BLOCK}`;
    const once = insertContextDeathClaudeBlock(doc);
    expect(insertContextDeathClaudeBlock(once)).toBe(once);
  });

  it('leaves a document without a block exactly as before (appends at the end)', () => {
    const doc = '# CLAUDE.md\n\n## Some section\n\ntext\n';
    expect(insertContextDeathClaudeBlock(doc)).toBe(`${doc}\n\n## Critical Anti-Patterns\n\n<!-- ${MARKER} -->\n${insertContextDeathClaudeBlock(doc).split(`<!-- ${MARKER} -->\n`)[1]}`);
    expect(insertContextDeathClaudeBlock(doc).startsWith(doc + '\n\n## Critical Anti-Patterns\n\n')).toBe(true);
  });
});
