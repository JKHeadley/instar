/**
 * The feature-notes block (awareness-entry-registry spec) is the last thing in CLAUDE.md. The
 * context-death anti-pattern step must add its section before it, or every update moves the block
 * back to the end and the file never settles (found when the first awareness entry, the Needs-you
 * list of work-front-doors stage 1, made the block non-empty).
 */
import { describe, it, expect } from 'vitest';
import { insertContextDeathClaudeBlock } from '../../src/core/PostUpdateMigrator.js';
import { AWARENESS_REGISTRY_START, AWARENESS_REGISTRY_END, findRegistryBlock } from '../../src/awareness/registry.js';

const block = `${AWARENESS_REGISTRY_START}\n## Feature notes\n\nNotes.\n\n**A note** — text.\n${AWARENESS_REGISTRY_END}\n`;

describe('context-death block and the feature notes', () => {
  it('with no Critical Anti-Patterns section, the new section goes before the feature notes', () => {
    const out = insertContextDeathClaudeBlock(`# CLAUDE.md\n\nSome text.\n\n${block}`);
    const notes = findRegistryBlock(out);
    expect(notes.state).toBe('well-formed');
    if (notes.state === 'well-formed') expect(notes.end).toBe(out.length);
    expect(out.indexOf('## Critical Anti-Patterns')).toBeLessThan(out.indexOf(AWARENESS_REGISTRY_START));
    expect(insertContextDeathClaudeBlock(out)).toBe(out);
  });

  it('a Critical Anti-Patterns section right before the notes gets the block outside the notes', () => {
    const out = insertContextDeathClaudeBlock(`# CLAUDE.md\n\n## Critical Anti-Patterns\n\nOne.\n\n${block}`);
    const notes = findRegistryBlock(out);
    expect(notes.state).toBe('well-formed');
    if (notes.state === 'well-formed') expect(out.slice(notes.start, notes.end)).toBe(block);
  });

  it('without feature notes it behaves as before', () => {
    expect(insertContextDeathClaudeBlock('# CLAUDE.md\n')).toMatch(/## Critical Anti-Patterns\n\n<!-- INSTAR:ANTI-PATTERN-CONTEXT-DEATH -->/);
  });
});
