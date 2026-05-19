/**
 * Unit tests for hookParityRule.
 *
 * Specs:
 *   - specs/instar-concepts/hook.md
 *   - specs/frameworks/claude-code/hooks.md
 *   - specs/frameworks/codex-cli/hooks.md
 *
 * Reuses Skill prototype hardening patterns (slug grammar, stamp, symmetric
 * verify, user-edit-conflict). v0.1 scope: session-start event only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hookParityRule } from '../../../../src/providers/parity/rules/hookParityRule.js';

async function tmpProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hook-parity-test-'));
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

const SAMPLE_HOOK_BODY = '#!/bin/bash\n# session-start hook body\necho "session started"\n';

async function writeCanonicalHook(
  projectRoot: string,
  event: string,
  fileName: string,
  body: string = SAMPLE_HOOK_BODY,
): Promise<void> {
  const dir = path.join(projectRoot, '.instar/hooks', event);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, fileName), body);
}

describe('hookParityRule', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await tmpProject();
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  describe('listInstances + slug grammar', () => {
    it('returns empty when canonical hooks dir is missing', async () => {
      expect(await hookParityRule.listInstances(projectRoot)).toEqual([]);
    });

    it('lists canonical hooks as event/name.ext composite', async () => {
      await writeCanonicalHook(projectRoot, 'session-start', 'identity-injection.sh');
      await writeCanonicalHook(projectRoot, 'session-start', 'coherence-check.sh');
      const result = await hookParityRule.listInstances(projectRoot);
      expect(result).toEqual([
        'session-start/coherence-check.sh',
        'session-start/identity-injection.sh',
      ]);
    });

    it('filters out events not in the v0.1 supported set', async () => {
      await writeCanonicalHook(projectRoot, 'session-start', 'ok.sh');
      // pre-compact is not in v0.1 EVENT_NAME_MAPPING
      await writeCanonicalHook(projectRoot, 'pre-compact', 'deferred.sh');
      const result = await hookParityRule.listInstances(projectRoot);
      expect(result).toEqual(['session-start/ok.sh']);
    });

    it('filters out canonical scripts whose name violates slug grammar', async () => {
      await writeCanonicalHook(projectRoot, 'session-start', 'valid.sh');
      const dir = path.join(projectRoot, '.instar/hooks/session-start');
      await fs.writeFile(path.join(dir, 'Bad_Name.sh'), '#!/bin/bash\n');
      await fs.writeFile(path.join(dir, 'with space.sh'), '#!/bin/bash\n');
      const result = await hookParityRule.listInstances(projectRoot);
      expect(result).toEqual(['session-start/valid.sh']);
    });

    it('filters out canonical scripts with unsupported extension', async () => {
      await writeCanonicalHook(projectRoot, 'session-start', 'ok.sh');
      const dir = path.join(projectRoot, '.instar/hooks/session-start');
      await fs.writeFile(path.join(dir, 'wrong.py'), 'print("x")\n');
      const result = await hookParityRule.listInstances(projectRoot);
      expect(result).toEqual(['session-start/ok.sh']);
    });
  });

  describe('verify — canonical-read errors', () => {
    it('tags canonical-read-error with framework: "canonical"', async () => {
      const r = await hookParityRule.verify(projectRoot, 'session-start/missing.sh');
      expect(r.ok).toBe(false);
      expect(r.mismatches[0].framework).toBe('canonical');
      expect(r.mismatches[0].reasonCode).toBe('canonical-read-error');
    });

    it('rejects path-traversal slug attempts', async () => {
      const r = await hookParityRule.verify(projectRoot, '../../etc/passwd');
      expect(r.ok).toBe(false);
      expect(r.mismatches[0].reasonCode).toBe('canonical-read-error');
    });

    it('rejects unsupported event names', async () => {
      const r = await hookParityRule.verify(projectRoot, 'pre-compact/x.sh');
      expect(r.ok).toBe(false);
      expect(r.mismatches[0].detail).toContain('not in the v0.1 supported set');
    });

    it('rejects unsupported extensions', async () => {
      const r = await hookParityRule.verify(projectRoot, 'session-start/x.py');
      expect(r.ok).toBe(false);
      expect(r.mismatches[0].reasonCode).toBe('canonical-read-error');
    });
  });

  describe('remediate — renders both frameworks', () => {
    it('renders claude script at .claude/hooks/<event>/<name>.<ext> with executable bit + stamp', async () => {
      await writeCanonicalHook(projectRoot, 'session-start', 'inject.sh');
      await hookParityRule.remediate(projectRoot, 'session-start/inject.sh', 'claude-code');
      const scriptPath = path.join(projectRoot, '.claude/hooks/session-start/inject.sh');
      expect(await exists(scriptPath)).toBe(true);
      const content = await fs.readFile(scriptPath, 'utf-8');
      expect(content).toMatch(/^#!\/bin\/bash\n# x-instar-stamp: [a-f0-9]{64}/);
      const stat = await fs.stat(scriptPath);
      // executable bit set (any of u+x, g+x, o+x)
      expect(stat.mode & 0o111).not.toBe(0);
    });

    it('adds settings.json entry with native CamelCase event', async () => {
      await writeCanonicalHook(projectRoot, 'session-start', 'inject.sh');
      await hookParityRule.remediate(projectRoot, 'session-start/inject.sh', 'claude-code');
      const settings = JSON.parse(
        await fs.readFile(path.join(projectRoot, '.claude/settings.json'), 'utf-8'),
      );
      expect(settings.hooks).toBeDefined();
      expect(settings.hooks.SessionStart).toBeDefined();
      expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('inject.sh');
    });

    it('renders codex script at .agent/openai/hooks/<event>/<name>.<ext> + hooks.json entry with snake_case event', async () => {
      await writeCanonicalHook(projectRoot, 'session-start', 'inject.sh');
      await hookParityRule.remediate(projectRoot, 'session-start/inject.sh', 'codex-cli');
      expect(await exists(path.join(projectRoot, '.agent/openai/hooks/session-start/inject.sh'))).toBe(true);
      const config = JSON.parse(
        await fs.readFile(path.join(projectRoot, '.agent/openai/hooks.json'), 'utf-8'),
      );
      expect(config.hooks).toBeDefined();
      expect(config.hooks[0].event).toBe('session_start');
      expect(config.hooks[0].script).toContain('inject.sh');
    });

    it('preserves existing settings.json keys when merging hook entries', async () => {
      const settingsPath = path.join(projectRoot, '.claude/settings.json');
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(
        settingsPath,
        JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { PreToolUse: [] } }, null, 2),
      );
      await writeCanonicalHook(projectRoot, 'session-start', 'inject.sh');
      await hookParityRule.remediate(projectRoot, 'session-start/inject.sh', 'claude-code');
      const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
      expect(settings.permissions).toEqual({ allow: ['Read'] });
      expect(settings.hooks.PreToolUse).toEqual([]);
      expect(settings.hooks.SessionStart).toBeDefined();
    });

    it('full-render cycle leaves verify ok:true', async () => {
      await writeCanonicalHook(projectRoot, 'session-start', 'inject.sh');
      await hookParityRule.remediate(projectRoot, 'session-start/inject.sh', 'claude-code');
      await hookParityRule.remediate(projectRoot, 'session-start/inject.sh', 'codex-cli');
      const r = await hookParityRule.verify(projectRoot, 'session-start/inject.sh');
      expect(r.ok).toBe(true);
    });

    it('is idempotent — calling remediate twice yields identical state', async () => {
      await writeCanonicalHook(projectRoot, 'session-start', 'inject.sh');
      await hookParityRule.remediate(projectRoot, 'session-start/inject.sh', 'claude-code');
      await hookParityRule.remediate(projectRoot, 'session-start/inject.sh', 'codex-cli');
      const claudeAfter1 = await fs.readFile(
        path.join(projectRoot, '.claude/hooks/session-start/inject.sh'),
        'utf-8',
      );
      const settings1 = await fs.readFile(path.join(projectRoot, '.claude/settings.json'), 'utf-8');
      await hookParityRule.remediate(projectRoot, 'session-start/inject.sh', 'claude-code');
      await hookParityRule.remediate(projectRoot, 'session-start/inject.sh', 'codex-cli');
      const claudeAfter2 = await fs.readFile(
        path.join(projectRoot, '.claude/hooks/session-start/inject.sh'),
        'utf-8',
      );
      const settings2 = await fs.readFile(path.join(projectRoot, '.claude/settings.json'), 'utf-8');
      expect(claudeAfter2).toBe(claudeAfter1);
      expect(settings2).toBe(settings1);
    });
  });

  describe('verify — user-edit-conflict via stamp', () => {
    it('distinguishes user-edit-conflict from body-content-mismatch', async () => {
      await writeCanonicalHook(projectRoot, 'session-start', 'inject.sh');
      await hookParityRule.remediate(projectRoot, 'session-start/inject.sh', 'claude-code');
      // Append user edit to claude rendering, preserving the stamp
      const scriptPath = path.join(projectRoot, '.claude/hooks/session-start/inject.sh');
      const raw = await fs.readFile(scriptPath, 'utf-8');
      await fs.writeFile(scriptPath, raw + '\necho "user added"\n');
      const r = await hookParityRule.verify(projectRoot, 'session-start/inject.sh');
      const conflict = r.mismatches.find(
        (m) => m.framework === 'claude-code' && m.reasonCode === 'user-edit-conflict',
      );
      expect(conflict).toBeDefined();
    });

    it('remediate refuses on user-edit-conflict', async () => {
      await writeCanonicalHook(projectRoot, 'session-start', 'inject.sh');
      await hookParityRule.remediate(projectRoot, 'session-start/inject.sh', 'claude-code');
      const scriptPath = path.join(projectRoot, '.claude/hooks/session-start/inject.sh');
      const raw = await fs.readFile(scriptPath, 'utf-8');
      await fs.writeFile(scriptPath, raw + '\necho "user"\n');
      await expect(
        hookParityRule.remediate(projectRoot, 'session-start/inject.sh', 'claude-code'),
      ).rejects.toThrow(/user-edit-conflict/);
    });
  });

  describe('orphan detection + removal', () => {
    it('listOrphans surfaces rendered hooks with no canonical counterpart', async () => {
      await writeCanonicalHook(projectRoot, 'session-start', 'alive.sh');
      await hookParityRule.remediate(projectRoot, 'session-start/alive.sh', 'claude-code');
      // Plant orphan rendered file
      await fs.mkdir(path.join(projectRoot, '.claude/hooks/session-start'), { recursive: true });
      await fs.writeFile(
        path.join(projectRoot, '.claude/hooks/session-start/orphan.sh'),
        '#!/bin/bash\necho orphan\n',
      );
      const orphans = await hookParityRule.listOrphans(projectRoot);
      const claudeOrphans = orphans.filter((o) => o.framework === 'claude-code');
      expect(claudeOrphans.length).toBe(1);
      expect(claudeOrphans[0].instanceName).toBe('session-start/orphan.sh');
      expect(claudeOrphans[0].reasonCode).toBe('orphan-rendering-found');
    });

    it('removeOrphans deletes only the orphan files', async () => {
      await writeCanonicalHook(projectRoot, 'session-start', 'alive.sh');
      await hookParityRule.remediate(projectRoot, 'session-start/alive.sh', 'claude-code');
      await fs.writeFile(
        path.join(projectRoot, '.claude/hooks/session-start/orphan.sh'),
        '#!/bin/bash\necho orphan\n',
      );
      const removed = await hookParityRule.removeOrphans(projectRoot, 'claude-code');
      expect(removed.length).toBe(1);
      expect(await exists(path.join(projectRoot, '.claude/hooks/session-start/alive.sh'))).toBe(true);
      expect(await exists(path.join(projectRoot, '.claude/hooks/session-start/orphan.sh'))).toBe(false);
    });
  });

  describe('rule metadata', () => {
    it('declares itself as the hook primitive', () => {
      expect(hookParityRule.primitive).toBe('hook');
    });
    it('covers both currently-enabled frameworks', () => {
      expect(hookParityRule.frameworks).toContain('claude-code');
      expect(hookParityRule.frameworks).toContain('codex-cli');
    });
    it('uses mirror-trust remediation policy', () => {
      expect(hookParityRule.remediationPolicy).toBe('mirror-trust');
    });
  });
});
