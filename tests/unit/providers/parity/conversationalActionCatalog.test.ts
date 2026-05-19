/**
 * Unit tests for conversationalActionCatalog.
 *
 * Spec: specs/instar-concepts/conversational-action.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  discoverActions,
  renderCatalogBlock,
  _internals,
} from '../../../../src/providers/parity/conversationalActionCatalog.js';

async function tmpProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'conv-action-test-'));
}

async function writeSkill(
  projectRoot: string,
  slug: string,
  frontmatter: Record<string, unknown>,
  body: string = '# body',
): Promise<void> {
  const dir = path.join(projectRoot, '.instar/skills', slug);
  await fs.mkdir(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : String(v)}`)
    .join('\n');
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\n${fm}\n---\n\n${body}\n`);
}

describe('conversationalActionCatalog', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await tmpProject();
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  describe('discoverActions', () => {
    it('returns empty when no .instar/skills/ directory exists', async () => {
      expect(await discoverActions(projectRoot)).toEqual([]);
    });

    it('discovers a single skill', async () => {
      await writeSkill(projectRoot, 'foo', {
        name: 'foo',
        description: 'Do the foo thing',
      });
      const actions = await discoverActions(projectRoot);
      expect(actions).toEqual([
        { name: 'foo', description: 'Do the foo thing', invocation: '/foo' },
      ]);
    });

    it('discovers multiple skills sorted by name', async () => {
      await writeSkill(projectRoot, 'beta', { name: 'beta', description: 'B' });
      await writeSkill(projectRoot, 'alpha', { name: 'alpha', description: 'A' });
      const actions = await discoverActions(projectRoot);
      expect(actions.map((a) => a.name)).toEqual(['alpha', 'beta']);
    });

    it('falls back to directory name when frontmatter has no name', async () => {
      await writeSkill(projectRoot, 'no-name-skill', { description: 'X' });
      const actions = await discoverActions(projectRoot);
      expect(actions[0].name).toBe('no-name-skill');
      expect(actions[0].invocation).toBe('/no-name-skill');
    });

    it('falls back to (no description) when frontmatter has no description', async () => {
      await writeSkill(projectRoot, 'silent', { name: 'silent' });
      const actions = await discoverActions(projectRoot);
      expect(actions[0].description).toBe('(no description)');
    });

    it('skips directories with invalid slug grammar', async () => {
      await writeSkill(projectRoot, 'GoodSkillButBadSlug', { name: 'X', description: 'Y' });
      await writeSkill(projectRoot, 'good-skill', { name: 'good-skill', description: 'Y' });
      const actions = await discoverActions(projectRoot);
      expect(actions.map((a) => a.name)).toEqual(['good-skill']);
    });

    it('skips skills with broken YAML frontmatter (does not throw)', async () => {
      const dir = path.join(projectRoot, '.instar/skills', 'broken');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: broken\n  bad: [unclosed\n---\n\nbody\n');
      await writeSkill(projectRoot, 'ok', { name: 'ok', description: 'fine' });
      const actions = await discoverActions(projectRoot);
      expect(actions.map((a) => a.name)).toEqual(['ok']);
    });

    it('ignores files (only directories count)', async () => {
      const skillsDir = path.join(projectRoot, '.instar/skills');
      await fs.mkdir(skillsDir, { recursive: true });
      await fs.writeFile(path.join(skillsDir, 'not-a-dir.md'), 'noise');
      expect(await discoverActions(projectRoot)).toEqual([]);
    });
  });

  describe('renderCatalogBlock', () => {
    it('includes start/end delimiter comments', () => {
      const block = renderCatalogBlock([]);
      expect(block).toContain(_internals.BLOCK_START);
      expect(block).toContain(_internals.BLOCK_END);
    });

    it('renders empty-state placeholder when no actions', () => {
      const block = renderCatalogBlock([]);
      expect(block).toMatch(/No conversational actions installed yet/);
    });

    it('renders each action as a bullet with invocation + description', () => {
      const block = renderCatalogBlock([
        { name: 'foo', description: 'Do foo', invocation: '/foo' },
        { name: 'bar', description: 'Do bar', invocation: '/bar' },
      ]);
      expect(block).toContain('- `/foo` — Do foo');
      expect(block).toContain('- `/bar` — Do bar');
    });

    it('is stable — same input produces same output', () => {
      const actions = [
        { name: 'a', description: 'd1', invocation: '/a' },
        { name: 'b', description: 'd2', invocation: '/b' },
      ];
      expect(renderCatalogBlock(actions)).toBe(renderCatalogBlock(actions));
    });
  });

  describe('end-to-end: discover → render', () => {
    it('produces a catalog block from discovered skills (pure data; caller decides placement)', async () => {
      await writeSkill(projectRoot, 'one', { name: 'one', description: 'First' });
      await writeSkill(projectRoot, 'two', { name: 'two', description: 'Second' });
      const actions = await discoverActions(projectRoot);
      const block = renderCatalogBlock(actions);
      expect(block).toContain('- `/one` — First');
      expect(block).toContain('- `/two` — Second');
      expect(block).toContain(_internals.BLOCK_START);
      expect(block).toContain(_internals.BLOCK_END);
    });
  });

  describe('bloat-aware design — applyCatalogBlock NOT exported', () => {
    it('public API exports only the pure-data primitives', async () => {
      // Import the module's exports and assert applyCatalogBlock is absent.
      // This is a structural test of the bloat-aware v0.1 surface.
      const mod = await import('../../../../src/providers/parity/conversationalActionCatalog.js');
      expect(typeof (mod as Record<string, unknown>).discoverActions).toBe('function');
      expect(typeof (mod as Record<string, unknown>).renderCatalogBlock).toBe('function');
      expect((mod as Record<string, unknown>).applyCatalogBlock).toBeUndefined();
    });
  });
});
