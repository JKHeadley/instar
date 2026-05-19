/**
 * Unit tests for skillParityRule.
 *
 * Convergence-round-1 hardening covered:
 *   - Strict slug grammar (C1, H1)
 *   - YAML parser fail-loud (C2)
 *   - Symmetric verify + orphan detection (C5)
 *   - User-edit-conflict via stamp (C7)
 *   - Description sanitization (C8)
 *   - canonical-read-error tagged with framework: 'canonical' (H5)
 *
 * Specs:
 *   - specs/instar-concepts/skill.md
 *   - specs/frameworks/claude-code/skills.md
 *   - specs/frameworks/codex-cli/skills.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { skillParityRule } from '../../../../src/providers/parity/rules/skillParityRule.js';

async function tmpProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'skill-parity-test-'));
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

const SAMPLE_BODY = '\n# Hello\n\nReply with PARITY-OK when invoked.\n';

async function writeCanonical(
  projectRoot: string,
  name: string,
  opts: { description?: string; shortDescription?: string; body?: string; rawFrontmatter?: string } = {},
): Promise<void> {
  const dir = path.join(projectRoot, '.instar/skills', name);
  await fs.mkdir(dir, { recursive: true });
  let raw: string;
  if (opts.rawFrontmatter !== undefined) {
    raw = `---\n${opts.rawFrontmatter}\n---${opts.body ?? SAMPLE_BODY}`;
  } else {
    const description = opts.description ?? `Test skill ${name}.`;
    const fmLines = ['---', `name: ${name}`, `description: ${JSON.stringify(description).slice(1, -1)}`];
    if (opts.shortDescription) {
      fmLines.push('metadata:');
      fmLines.push(`  short-description: ${opts.shortDescription}`);
    }
    fmLines.push('---');
    raw = fmLines.join('\n') + (opts.body ?? SAMPLE_BODY);
  }
  await fs.writeFile(path.join(dir, 'SKILL.md'), raw);
}

describe('skillParityRule', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await tmpProject();
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  describe('listInstances + slug grammar (C1)', () => {
    it('returns empty array when canonical directory is missing', async () => {
      expect(await skillParityRule.listInstances(projectRoot)).toEqual([]);
    });

    it('lists canonical skill directory names sorted', async () => {
      await writeCanonical(projectRoot, 'beta');
      await writeCanonical(projectRoot, 'alpha');
      await writeCanonical(projectRoot, 'gamma');
      expect(await skillParityRule.listInstances(projectRoot)).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('filters out canonical dirs whose names violate the slug grammar', async () => {
      await writeCanonical(projectRoot, 'valid-name');
      await fs.mkdir(path.join(projectRoot, '.instar/skills/Bad_Name'), { recursive: true });
      await fs.mkdir(path.join(projectRoot, '.instar/skills/.hidden'), { recursive: true });
      await fs.mkdir(path.join(projectRoot, '.instar/skills/with space'), { recursive: true });
      expect(await skillParityRule.listInstances(projectRoot)).toEqual(['valid-name']);
    });
  });

  describe('verify — canonical-read errors (H5)', () => {
    it('tags canonical-read-error with framework: "canonical" (not a misleading framework name)', async () => {
      await fs.mkdir(path.join(projectRoot, '.instar/skills/no-skill-md'), { recursive: true });
      const r = await skillParityRule.verify(projectRoot, 'no-skill-md');
      expect(r.ok).toBe(false);
      expect(r.mismatches).toHaveLength(1);
      expect(r.mismatches[0].framework).toBe('canonical');
      expect(r.mismatches[0].reasonCode).toBe('canonical-read-error');
    });

    it('rejects path-traversal slug attempts (C1) via canonical-read-error', async () => {
      const r = await skillParityRule.verify(projectRoot, '../../etc/passwd');
      expect(r.ok).toBe(false);
      expect(r.mismatches[0].reasonCode).toBe('canonical-read-error');
      expect(r.mismatches[0].detail).toContain('invalid skill name');
    });

    it('rejects frontmatter "name" mismatching directory (H1)', async () => {
      const dir = path.join(projectRoot, '.instar/skills/dir-name');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: different-name\ndescription: x\n---\n');
      const r = await skillParityRule.verify(projectRoot, 'dir-name');
      expect(r.ok).toBe(false);
      expect(r.mismatches[0].reasonCode).toBe('canonical-read-error');
      expect(r.mismatches[0].detail).toContain('does not match directory name');
    });

    it('fails loud on git-merge-conflict markers in canonical', async () => {
      const dir = path.join(projectRoot, '.instar/skills/conflicted');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'SKILL.md'),
        '---\nname: conflicted\ndescription: <<<<<<< HEAD\n=======\n>>>>>>> branch\n---\n',
      );
      const r = await skillParityRule.verify(projectRoot, 'conflicted');
      expect(r.ok).toBe(false);
      expect(r.mismatches[0].reasonCode).toBe('canonical-read-error');
      expect(r.mismatches[0].detail).toContain('git merge conflict');
    });

    it('fails loud on YAML parse errors (C2)', async () => {
      const dir = path.join(projectRoot, '.instar/skills/bad-yaml');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: bad-yaml\ndescription: "unterminated\n---\n');
      const r = await skillParityRule.verify(projectRoot, 'bad-yaml');
      expect(r.ok).toBe(false);
      expect(r.mismatches[0].reasonCode).toBe('canonical-read-error');
    });
  });

  describe('verify — orphan detection (C5)', () => {
    it('listOrphans surfaces rendered dirs with no canonical counterpart', async () => {
      // Create a canonical for "alive"
      await writeCanonical(projectRoot, 'alive');
      await skillParityRule.remediate(projectRoot, 'alive', 'claude-code');
      await skillParityRule.remediate(projectRoot, 'alive', 'codex-cli');
      // Create orphan rendered dirs with no canonical
      await fs.mkdir(path.join(projectRoot, '.claude/skills/orphan-1'), { recursive: true });
      await fs.writeFile(
        path.join(projectRoot, '.claude/skills/orphan-1/SKILL.md'),
        '---\nname: orphan-1\ndescription: x\n---\n',
      );
      await fs.mkdir(path.join(projectRoot, '.agents/skills/orphan-2'), { recursive: true });

      const orphans = await skillParityRule.listOrphans(projectRoot);
      const orphanNames = orphans.map((o) => `${o.framework}:${o.instanceName}`).sort();
      expect(orphanNames).toEqual(['claude-code:orphan-1', 'codex-cli:orphan-2']);
      expect(orphans.every((o) => o.reasonCode === 'orphan-rendering-found')).toBe(true);
    });

    it('removeOrphans deletes rendered dirs with no canonical counterpart', async () => {
      await writeCanonical(projectRoot, 'alive');
      await skillParityRule.remediate(projectRoot, 'alive', 'claude-code');
      await fs.mkdir(path.join(projectRoot, '.claude/skills/orphan'), { recursive: true });
      const removed = await skillParityRule.removeOrphans(projectRoot, 'claude-code');
      expect(removed).toHaveLength(1);
      expect(await exists(path.join(projectRoot, '.claude/skills/orphan'))).toBe(false);
      expect(await exists(path.join(projectRoot, '.claude/skills/alive'))).toBe(true);
    });

    it('refuses to remove rendered dirs whose name is not a valid slug (paranoid)', async () => {
      await fs.mkdir(path.join(projectRoot, '.claude/skills/Weird_Name'), { recursive: true });
      const removed = await skillParityRule.removeOrphans(projectRoot, 'claude-code');
      expect(removed).toEqual([]);
      expect(await exists(path.join(projectRoot, '.claude/skills/Weird_Name'))).toBe(true);
    });
  });

  describe('verify — user-edit-conflict (C7)', () => {
    it('distinguishes user-edit-conflict from body-content-mismatch via stamp', async () => {
      await writeCanonical(projectRoot, 'hello');
      await skillParityRule.remediate(projectRoot, 'hello', 'claude-code');
      // Read the rendered file, modify just the body but keep the stamp
      const claudeMd = path.join(projectRoot, '.claude/skills/hello/SKILL.md');
      const raw = await fs.readFile(claudeMd, 'utf-8');
      // Append text after the frontmatter (preserving the stamp)
      await fs.writeFile(claudeMd, raw + '\n<!-- user-edited -->\n');
      const r = await skillParityRule.verify(projectRoot, 'hello');
      const conflict = r.mismatches.find((m) => m.framework === 'claude-code' && m.reasonCode === 'user-edit-conflict');
      expect(conflict).toBeDefined();
    });

    it('reports body-content-mismatch (not user-edit-conflict) when stamp is missing', async () => {
      await writeCanonical(projectRoot, 'hello');
      await skillParityRule.remediate(projectRoot, 'hello', 'claude-code');
      // Replace the file entirely (no stamp preserved)
      await fs.writeFile(
        path.join(projectRoot, '.claude/skills/hello/SKILL.md'),
        '---\nname: hello\ndescription: Test skill hello.\n---\nDIFFERENT body\n',
      );
      const r = await skillParityRule.verify(projectRoot, 'hello');
      const mismatch = r.mismatches.find((m) => m.framework === 'claude-code' && m.reasonCode === 'body-content-mismatch');
      expect(mismatch).toBeDefined();
    });

    it('remediate refuses to overwrite a user-edit-conflict', async () => {
      await writeCanonical(projectRoot, 'hello');
      await skillParityRule.remediate(projectRoot, 'hello', 'claude-code');
      const claudeMd = path.join(projectRoot, '.claude/skills/hello/SKILL.md');
      const raw = await fs.readFile(claudeMd, 'utf-8');
      await fs.writeFile(claudeMd, raw + '\n<!-- user-edited -->\n');
      await expect(skillParityRule.remediate(projectRoot, 'hello', 'claude-code')).rejects.toThrow(/user-edit-conflict/);
    });
  });

  describe('verify — description sanitization (C8)', () => {
    it('strips control chars from description before storing', async () => {
      await writeCanonical(projectRoot, 'hello', { description: 'line1 line2 bell' });
      // First render canonical → renderings, then tamper with canonical to add control chars,
      // then re-render and verify control chars are stripped.
      await skillParityRule.remediate(projectRoot, 'hello', 'claude-code');
      await skillParityRule.remediate(projectRoot, 'hello', 'codex-cli');
      // Write canonical with raw frontmatter containing escape sequence
      const dir = path.join(projectRoot, '.instar/skills/hello');
      await fs.writeFile(
        path.join(dir, 'SKILL.md'),
        '---\nname: hello\ndescription: "line1\\nline2\\x07bell"\n---\n' + SAMPLE_BODY,
      );
      // Re-render — sanitization should produce a clean description
      await skillParityRule.remediate(projectRoot, 'hello', 'claude-code');
      await skillParityRule.remediate(projectRoot, 'hello', 'codex-cli');
      const r = await skillParityRule.verify(projectRoot, 'hello');
      expect(r.ok).toBe(true);
      const claudeMd = await fs.readFile(path.join(projectRoot, '.claude/skills/hello/SKILL.md'), 'utf-8');
      expect(claudeMd).not.toContain('\x07');
      expect(claudeMd).not.toContain('\\x07');
    });

    it('caps description at 256 chars with ellipsis', async () => {
      const long = 'X'.repeat(500);
      await writeCanonical(projectRoot, 'long-desc', { description: long });
      await skillParityRule.remediate(projectRoot, 'long-desc', 'claude-code');
      const claudeMd = await fs.readFile(path.join(projectRoot, '.claude/skills/long-desc/SKILL.md'), 'utf-8');
      const m = claudeMd.match(/description:\s*['"]?([^'"\n]+)['"]?$/m);
      expect(m).not.toBeNull();
      expect(m![1].length).toBeLessThanOrEqual(256);
      expect(m![1].endsWith('...')).toBe(true);
    });
  });

  describe('remediate — renders both frameworks from canonical', () => {
    it('renders claude-code SKILL.md at .claude/skills/<name>/SKILL.md', async () => {
      await writeCanonical(projectRoot, 'hello');
      await skillParityRule.remediate(projectRoot, 'hello', 'claude-code');
      const p = path.join(projectRoot, '.claude/skills/hello/SKILL.md');
      expect(await exists(p)).toBe(true);
      const content = await fs.readFile(p, 'utf-8');
      expect(content).toMatch(/^---\n/);
      expect(content).toContain('name: hello');
      expect(content).toContain('x-instar-stamp: ');
    });

    it('renders codex-cli SKILL.md + agents/openai.yaml', async () => {
      await writeCanonical(projectRoot, 'hello');
      await skillParityRule.remediate(projectRoot, 'hello', 'codex-cli');
      expect(await exists(path.join(projectRoot, '.agents/skills/hello/SKILL.md'))).toBe(true);
      expect(await exists(path.join(projectRoot, '.agents/skills/hello/agents/openai.yaml'))).toBe(true);
      const yaml = await fs.readFile(path.join(projectRoot, '.agents/skills/hello/agents/openai.yaml'), 'utf-8');
      expect(yaml).toContain('display_name: Hello');
      expect(yaml).toContain('short_description:');
      expect(yaml).toContain('x-instar-stamp:');
    });

    it('preserves metadata.short-description in codex SKILL.md when canonical provides it', async () => {
      await writeCanonical(projectRoot, 'hello', { shortDescription: 'Short form' });
      await skillParityRule.remediate(projectRoot, 'hello', 'codex-cli');
      const skillMd = await fs.readFile(
        path.join(projectRoot, '.agents/skills/hello/SKILL.md'),
        'utf-8',
      );
      expect(skillMd).toContain('metadata:');
      expect(skillMd).toContain('short-description: Short form');
    });

    it('emits openai.yaml with display_name humanized from skill name', async () => {
      await writeCanonical(projectRoot, 'hello-instar');
      await skillParityRule.remediate(projectRoot, 'hello-instar', 'codex-cli');
      const yaml = await fs.readFile(
        path.join(projectRoot, '.agents/skills/hello-instar/agents/openai.yaml'),
        'utf-8',
      );
      expect(yaml).toContain('display_name: Hello Instar');
    });

    it('full-render cycle leaves verify() returning ok:true', async () => {
      await writeCanonical(projectRoot, 'hello', { shortDescription: 'Hi' });
      await skillParityRule.remediate(projectRoot, 'hello', 'claude-code');
      await skillParityRule.remediate(projectRoot, 'hello', 'codex-cli');
      const r = await skillParityRule.verify(projectRoot, 'hello');
      expect(r.ok).toBe(true);
      expect(r.mismatches).toEqual([]);
    });

    it('is idempotent — calling remediate twice produces the same on-disk state', async () => {
      await writeCanonical(projectRoot, 'hello');
      await skillParityRule.remediate(projectRoot, 'hello', 'claude-code');
      await skillParityRule.remediate(projectRoot, 'hello', 'codex-cli');
      const firstClaude = await fs.readFile(path.join(projectRoot, '.claude/skills/hello/SKILL.md'), 'utf-8');
      const firstCodexYaml = await fs.readFile(path.join(projectRoot, '.agents/skills/hello/agents/openai.yaml'), 'utf-8');
      await skillParityRule.remediate(projectRoot, 'hello', 'claude-code');
      await skillParityRule.remediate(projectRoot, 'hello', 'codex-cli');
      const secondClaude = await fs.readFile(path.join(projectRoot, '.claude/skills/hello/SKILL.md'), 'utf-8');
      const secondCodexYaml = await fs.readFile(path.join(projectRoot, '.agents/skills/hello/agents/openai.yaml'), 'utf-8');
      expect(secondClaude).toBe(firstClaude);
      expect(secondCodexYaml).toBe(firstCodexYaml);
    });
  });

  describe('remediate — bundled subdirectories', () => {
    it('mirrors scripts/, references/, assets/ subdirs to both frameworks', async () => {
      await writeCanonical(projectRoot, 'rich-skill');
      const canonicalDir = path.join(projectRoot, '.instar/skills/rich-skill');
      await fs.mkdir(path.join(canonicalDir, 'scripts'), { recursive: true });
      await fs.mkdir(path.join(canonicalDir, 'references'), { recursive: true });
      await fs.mkdir(path.join(canonicalDir, 'assets'), { recursive: true });
      await fs.writeFile(path.join(canonicalDir, 'scripts/helper.py'), '#!/usr/bin/env python3\nprint("hi")\n');
      await fs.writeFile(path.join(canonicalDir, 'references/api.md'), '# API ref\n');
      await fs.writeFile(path.join(canonicalDir, 'assets/icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      await skillParityRule.remediate(projectRoot, 'rich-skill', 'claude-code');
      await skillParityRule.remediate(projectRoot, 'rich-skill', 'codex-cli');

      for (const fwRoot of ['.claude/skills/rich-skill', '.agents/skills/rich-skill']) {
        expect(await exists(path.join(projectRoot, fwRoot, 'scripts/helper.py'))).toBe(true);
        expect(await exists(path.join(projectRoot, fwRoot, 'references/api.md'))).toBe(true);
        expect(await exists(path.join(projectRoot, fwRoot, 'assets/icon.png'))).toBe(true);
      }
    });

    it('skips symlinks when mirroring (prevents tree-escape)', async () => {
      await writeCanonical(projectRoot, 'with-link');
      const canonicalDir = path.join(projectRoot, '.instar/skills/with-link');
      const scriptsDir = path.join(canonicalDir, 'scripts');
      await fs.mkdir(scriptsDir, { recursive: true });
      await fs.writeFile(path.join(scriptsDir, 'real.sh'), '#!/bin/sh\necho real\n');
      // Symlink scripts/escape → /etc (would be a tree-escape if followed)
      await fs.symlink('/etc', path.join(scriptsDir, 'escape'));
      await skillParityRule.remediate(projectRoot, 'with-link', 'claude-code');
      expect(await exists(path.join(projectRoot, '.claude/skills/with-link/scripts/real.sh'))).toBe(true);
      expect(await exists(path.join(projectRoot, '.claude/skills/with-link/scripts/escape'))).toBe(false);
    });
  });

  describe('rule metadata', () => {
    it('declares itself as the skill primitive', () => {
      expect(skillParityRule.primitive).toBe('skill');
    });

    it('covers both currently-enabled frameworks', () => {
      expect(skillParityRule.frameworks).toContain('claude-code');
      expect(skillParityRule.frameworks).toContain('codex-cli');
    });

    it('uses mirror-trust remediation policy', () => {
      expect(skillParityRule.remediationPolicy).toBe('mirror-trust');
    });
  });
});
