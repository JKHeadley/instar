/**
 * The /subscription-signin skill (operator directive 2026-09-24): one proven sign-in procedure
 * installed in every agent. Asserts install, frontmatter, the load-bearing rules, and that a
 * re-run never overwrites an agent's own edits.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installBuiltinSkills } from '../../src/commands/init.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let skillsDir: string;
beforeEach(() => { skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-signin-skill-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(skillsDir, { recursive: true, force: true, operation: 'tests/unit/init-subscriptionSigninSkill.test.ts' }); });
const skillPath = () => path.join(skillsDir, 'subscription-signin', 'SKILL.md');

describe('installBuiltinSkills — subscription-signin', () => {
  it('installs a user-invocable skill with valid frontmatter', () => {
    installBuiltinSkills(skillsDir, 4042);
    const content = fs.readFileSync(skillPath(), 'utf-8');
    expect(content).toMatch(/^---\nname: subscription-signin\n/);
    expect(content).toContain('user_invocable: "true"');
  });

  it('carries the load-bearing rules: normal browser only, no CAPTCHA work-arounds, no secrets in chat, no cross-machine copies', () => {
    installBuiltinSkills(skillsDir, 4042);
    const content = fs.readFileSync(skillPath(), 'utf-8');
    expect(content).toContain('Sign-ins always run in a NORMAL browser');
    expect(content).toContain('Never solve or work around a CAPTCHA');
    expect(content).toContain('Never put a password, code, or token in chat');
    expect(content).toContain('Never copy a Chrome profile or a login between machines');
    expect(content).toContain('GET /subscription-relogin');
    // Template-literal escaping survived: shell variables are literal, not interpolated away.
    expect(content).toContain('$INSTAR_PORT');
    expect(content).toContain('`GET /subscription-pool`');
  });

  it('never overwrites an existing copy', () => {
    fs.mkdirSync(path.dirname(skillPath()), { recursive: true });
    fs.writeFileSync(skillPath(), 'custom');
    installBuiltinSkills(skillsDir, 4042);
    expect(fs.readFileSync(skillPath(), 'utf-8')).toBe('custom');
  });
});
