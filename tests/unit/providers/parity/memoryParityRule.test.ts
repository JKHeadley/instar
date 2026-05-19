/**
 * Unit tests for memoryParityRule.
 *
 * Specs:
 *   - specs/instar-concepts/memory.md
 *   - specs/frameworks/claude-code/memory.md
 *   - specs/frameworks/codex-cli/memory.md
 *
 * v0.1 scope: verifier-only. No remediation (refuses by design). No orphan
 * cleanup (no rendering callsites yet).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { memoryParityRule } from '../../../../src/providers/parity/rules/memoryParityRule.js';

async function tmpProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'memory-parity-test-'));
}

async function writeArtifact(
  projectRoot: string,
  relPath: string,
  content: string | Buffer,
): Promise<void> {
  const abs = path.join(projectRoot, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

const VALID_AGENT_MD = '---\nname: echo\nrole: developer\n---\n\n# Echo\n\nI am Echo.\n';
const VALID_USER_MD = '# User\n\nJustin — Instar creator.\n';
const VALID_MEMORY_MD = '# Memory\n\n- Learned that X.\n';
// Minimal SQLite file: just the magic header + zero-padding to first page (4096).
// Real DBs have a full header; the verifier only checks magic bytes.
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'binary');
const MIN_SQLITE = Buffer.concat([SQLITE_MAGIC, Buffer.alloc(4096 - SQLITE_MAGIC.length)]);

async function writeAllRequired(projectRoot: string): Promise<void> {
  await writeArtifact(projectRoot, '.instar/AGENT.md', VALID_AGENT_MD);
  await writeArtifact(projectRoot, '.instar/USER.md', VALID_USER_MD);
  await writeArtifact(projectRoot, '.instar/MEMORY.md', VALID_MEMORY_MD);
}

describe('memoryParityRule', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await tmpProject();
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  describe('listInstances', () => {
    it('returns the canonical artifact set', async () => {
      const instances = await memoryParityRule.listInstances(projectRoot);
      expect(instances).toEqual([
        '.instar/AGENT.md',
        '.instar/USER.md',
        '.instar/MEMORY.md',
        '.instar/state/topic-memory.sqlite',
      ]);
    });
  });

  describe('verify — required artifacts', () => {
    it('passes when all required markdown artifacts are present + valid', async () => {
      await writeAllRequired(projectRoot);
      for (const rel of ['.instar/AGENT.md', '.instar/USER.md', '.instar/MEMORY.md']) {
        const r = await memoryParityRule.verify(projectRoot, rel);
        expect(r.ok).toBe(true);
        expect(r.mismatches).toEqual([]);
      }
    });

    it('fails when AGENT.md is missing', async () => {
      await writeArtifact(projectRoot, '.instar/USER.md', VALID_USER_MD);
      await writeArtifact(projectRoot, '.instar/MEMORY.md', VALID_MEMORY_MD);
      const r = await memoryParityRule.verify(projectRoot, '.instar/AGENT.md');
      expect(r.ok).toBe(false);
      expect(r.mismatches).toHaveLength(1);
      expect(r.mismatches[0].reasonCode).toBe('canonical-read-error');
      expect(r.mismatches[0].framework).toBe('canonical');
      expect(r.mismatches[0].detail).toMatch(/agent identity/);
      expect(r.mismatches[0].detail).toMatch(/missing/);
    });

    it('fails when MEMORY.md is empty', async () => {
      await writeAllRequired(projectRoot);
      await writeArtifact(projectRoot, '.instar/MEMORY.md', '');
      const r = await memoryParityRule.verify(projectRoot, '.instar/MEMORY.md');
      expect(r.ok).toBe(false);
      expect(r.mismatches[0].reasonCode).toBe('canonical-read-error');
      expect(r.mismatches[0].detail).toMatch(/empty/);
    });

    it('fails when AGENT.md frontmatter is malformed YAML', async () => {
      await writeArtifact(
        projectRoot,
        '.instar/AGENT.md',
        '---\nname: echo\n  bad-indent: [unclosed\n---\n\nbody\n',
      );
      const r = await memoryParityRule.verify(projectRoot, '.instar/AGENT.md');
      expect(r.ok).toBe(false);
      expect(r.mismatches[0].reasonCode).toBe('canonical-read-error');
      expect(r.mismatches[0].detail).toMatch(/YAML frontmatter parse error/);
    });

    it('fails when AGENT.md frontmatter is unterminated', async () => {
      await writeArtifact(projectRoot, '.instar/AGENT.md', '---\nname: echo\nbody without close\n');
      const r = await memoryParityRule.verify(projectRoot, '.instar/AGENT.md');
      expect(r.ok).toBe(false);
      expect(r.mismatches[0].detail).toMatch(/unterminated frontmatter/);
    });

    it('passes for MEMORY.md without frontmatter', async () => {
      await writeArtifact(projectRoot, '.instar/MEMORY.md', '# Just a heading\n\ncontent\n');
      const r = await memoryParityRule.verify(projectRoot, '.instar/MEMORY.md');
      expect(r.ok).toBe(true);
    });
  });

  describe('verify — optional sqlite artifact', () => {
    it('passes when topic-memory.sqlite is absent (optional)', async () => {
      const r = await memoryParityRule.verify(projectRoot, '.instar/state/topic-memory.sqlite');
      expect(r.ok).toBe(true);
      expect(r.mismatches).toEqual([]);
    });

    it('passes when topic-memory.sqlite is present with valid magic bytes', async () => {
      await writeArtifact(projectRoot, '.instar/state/topic-memory.sqlite', MIN_SQLITE);
      const r = await memoryParityRule.verify(projectRoot, '.instar/state/topic-memory.sqlite');
      expect(r.ok).toBe(true);
    });

    it('fails when topic-memory.sqlite has wrong magic bytes', async () => {
      await writeArtifact(
        projectRoot,
        '.instar/state/topic-memory.sqlite',
        Buffer.from('NOT a SQLite file just random bytes here'),
      );
      const r = await memoryParityRule.verify(projectRoot, '.instar/state/topic-memory.sqlite');
      expect(r.ok).toBe(false);
      expect(r.mismatches[0].reasonCode).toBe('canonical-read-error');
      expect(r.mismatches[0].detail).toMatch(/SQLite/);
    });
  });

  describe('verify — unknown instance names', () => {
    it('returns ok for instance names outside the canonical set (defensive)', async () => {
      const r = await memoryParityRule.verify(projectRoot, '.instar/SOMETHING_ELSE.md');
      expect(r.ok).toBe(true);
      expect(r.mismatches).toEqual([]);
    });
  });

  describe('remediate — refused by design', () => {
    it('throws with a documented repair procedure', async () => {
      await expect(
        memoryParityRule.remediate(projectRoot, '.instar/AGENT.md', 'claude-code'),
      ).rejects.toThrow(/refused to remediate/);
      await expect(
        memoryParityRule.remediate(projectRoot, '.instar/AGENT.md', 'claude-code'),
      ).rejects.toThrow(/instar init/);
    });

    it('mentions the repair procedure even for unknown artifact names', async () => {
      await expect(
        memoryParityRule.remediate(projectRoot, '.instar/UNKNOWN.md', 'codex-cli'),
      ).rejects.toThrow(/refused to remediate/);
    });
  });

  describe('orphans — no rendering callsites in v0.1', () => {
    it('listOrphans returns empty', async () => {
      const orphans = await memoryParityRule.listOrphans(projectRoot);
      expect(orphans).toEqual([]);
    });

    it('removeOrphans returns empty for any framework', async () => {
      expect(await memoryParityRule.removeOrphans(projectRoot, 'claude-code')).toEqual([]);
      expect(await memoryParityRule.removeOrphans(projectRoot, 'codex-cli')).toEqual([]);
    });
  });

  describe('rule metadata', () => {
    it('declares the memory primitive', () => {
      expect(memoryParityRule.primitive).toBe('memory');
    });

    it('covers both currently-enabled frameworks', () => {
      expect([...memoryParityRule.frameworks].sort()).toEqual(['claude-code', 'codex-cli']);
    });

    it('uses flag-only remediation policy (Memory is never auto-fixed)', () => {
      expect(memoryParityRule.remediationPolicy).toBe('flag-only');
    });
  });
});
