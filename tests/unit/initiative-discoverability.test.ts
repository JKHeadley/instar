/**
 * Discoverability (Layer D, GRADUATED-FEATURE-ROLLOUT-SPEC §4.5): the agent must
 * reach for the initiative tracker reflexively. Two structural wirings:
 *  - /initiatives is NO LONGER suppressed from the capability matrix.
 *  - the CLAUDE.md template's Registry-First table has the "what are we working
 *    on → /initiatives + /projects" row (NEVER answer from memory).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('initiative discoverability', () => {
  it('CapabilityIndex no longer suppresses the `initiatives` prefix', () => {
    const src = fs.readFileSync(path.join(root, 'src/server/CapabilityIndex.ts'), 'utf8');
    // The active suppression entry must be gone (a comment explaining the
    // removal is allowed, but not a live `{ prefix: 'initiatives', ... }`).
    expect(/\{\s*prefix:\s*'initiatives'/.test(src)).toBe(false);
  });

  it('CLAUDE.md template Registry-First table routes "what are we working on" to /initiatives', () => {
    const md = generateClaudeMd('test-project', 'test-agent', 4040, false);
    expect(md).toContain('What are we working on?');
    expect(md).toMatch(/\/initiatives/);
    expect(md).toContain('NEVER answer this from memory');
  });
});
