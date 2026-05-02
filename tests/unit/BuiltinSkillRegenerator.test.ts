/**
 * PROP-337 v1 — BuiltinSkillRegenerator
 *
 * Verifies the fingerprint-based drift / regeneration logic for
 * built-in SKILL.md templates.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  regenerateBuiltinSkills,
  renderBundledSkills,
} from '../../src/core/BuiltinSkillRegenerator.js';

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function makeTempProject(): { projectDir: string; stateDir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-regen-test-'));
  const projectDir = path.join(root, 'project');
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  return {
    projectDir,
    stateDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

describe('BuiltinSkillRegenerator (PROP-337 v1)', () => {
  let tmp: ReturnType<typeof makeTempProject>;
  const PORT = 4321;

  beforeEach(() => {
    tmp = makeTempProject();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('renderBundledSkills produces non-empty SKILL.md for known builtins', () => {
    const rendered = renderBundledSkills(PORT);
    // We don't enumerate every slug — just spot-check the headline ones
    // PROP-337 mentions are at risk of stale upgrades.
    expect(Object.keys(rendered).length).toBeGreaterThan(0);
    expect(rendered.evolve).toBeDefined();
    expect(rendered.evolve).toContain('# /evolve');
    expect(rendered.learn).toContain('# /learn');
  });

  it('installs missing skills and seeds fingerprints', () => {
    const result = regenerateBuiltinSkills({
      projectDir: tmp.projectDir,
      stateDir: tmp.stateDir,
      port: PORT,
    });

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(s => s.includes('skills/evolve/SKILL.md'))).toBe(true);

    const fp = JSON.parse(
      fs.readFileSync(path.join(tmp.stateDir, 'state', 'builtin-skill-fingerprints.json'), 'utf-8'),
    );
    expect(fp.skills.evolve).toBeDefined();
    expect(fp.skills.evolve.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is idempotent — second run reports all in-sync', () => {
    regenerateBuiltinSkills({
      projectDir: tmp.projectDir,
      stateDir: tmp.stateDir,
      port: PORT,
    });
    const second = regenerateBuiltinSkills({
      projectDir: tmp.projectDir,
      stateDir: tmp.stateDir,
      port: PORT,
    });

    expect(second.errors).toEqual([]);
    expect(second.upgraded).toEqual([]);
    expect(second.skipped.some(s => s.includes('in sync'))).toBe(true);
  });

  it('regenerates when bundled template differs from on-disk AND on-disk matches fingerprint', () => {
    // Seed: install everything, then mutate one skill's fingerprint to
    // claim it was previously a DIFFERENT version. This simulates the
    // upgrade case: the package shipped a new version of the inline
    // template, the user never customized it, and we should overwrite.
    regenerateBuiltinSkills({
      projectDir: tmp.projectDir,
      stateDir: tmp.stateDir,
      port: PORT,
    });

    const skillPath = path.join(tmp.projectDir, '.claude', 'skills', 'evolve', 'SKILL.md');
    const stalePrior = '# /evolve\n\n[old version of template]\n';
    fs.writeFileSync(skillPath, stalePrior);

    // Update the fingerprint to point at the stale-prior content. This
    // is the state we'd be in mid-upgrade: previous package wrote
    // stalePrior, we recorded its hash, then user upgraded and the
    // bundled template is now different.
    const fpPath = path.join(tmp.stateDir, 'state', 'builtin-skill-fingerprints.json');
    const fp = JSON.parse(fs.readFileSync(fpPath, 'utf-8'));
    fp.skills.evolve = {
      contentHash: sha256(stalePrior),
      observedAt: new Date().toISOString(),
    };
    fs.writeFileSync(fpPath, JSON.stringify(fp));

    const result = regenerateBuiltinSkills({
      projectDir: tmp.projectDir,
      stateDir: tmp.stateDir,
      port: PORT,
    });

    expect(result.errors).toEqual([]);
    const regenerated = result.upgraded.find(s => s.includes('skills/evolve/SKILL.md'));
    expect(regenerated).toBeDefined();
    expect(regenerated).toContain('regenerated from upgraded template');

    const after = fs.readFileSync(skillPath, 'utf-8');
    expect(after).not.toBe(stalePrior);
    expect(after).toContain('Propose an evolution improvement');
  });

  it('preserves user customizations (on-disk diverges from fingerprint)', () => {
    // Seed: install everything (this records fingerprints).
    regenerateBuiltinSkills({
      projectDir: tmp.projectDir,
      stateDir: tmp.stateDir,
      port: PORT,
    });

    const skillPath = path.join(tmp.projectDir, '.claude', 'skills', 'evolve', 'SKILL.md');
    const userCustom = fs.readFileSync(skillPath, 'utf-8') + '\n\n## My Custom Section\n\nUser edits.\n';
    fs.writeFileSync(skillPath, userCustom);

    // Run again — the fingerprint reflects the original install hash,
    // not the user's edited hash, so this should be classified as
    // "user-modified" and preserved.
    const result = regenerateBuiltinSkills({
      projectDir: tmp.projectDir,
      stateDir: tmp.stateDir,
      port: PORT,
    });

    expect(result.errors).toEqual([]);
    const skipped = result.skipped.find(s => s.includes('skills/evolve/SKILL.md'));
    expect(skipped).toBeDefined();
    expect(skipped).toContain('user-modified');

    const after = fs.readFileSync(skillPath, 'utf-8');
    expect(after).toBe(userCustom);
  });

  it('seeds fingerprint on first observe of a pre-existing user-modified file', () => {
    // Pre-existing skill that PROP-337 has never seen — write it
    // BEFORE running the regenerator and DO NOT seed any fingerprints.
    const skillDir = path.join(tmp.projectDir, '.claude', 'skills', 'evolve');
    fs.mkdirSync(skillDir, { recursive: true });
    const customContent = '# /evolve\n\nMy custom evolve before regen ever ran.\n';
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), customContent);

    const result = regenerateBuiltinSkills({
      projectDir: tmp.projectDir,
      stateDir: tmp.stateDir,
      port: PORT,
    });

    expect(result.errors).toEqual([]);
    const skipped = result.skipped.find(s => s.includes('skills/evolve/SKILL.md'));
    expect(skipped).toContain('user-modified');

    // Fingerprint should now reflect the on-disk hash so future
    // upgrades can distinguish "user edited again" from "user never
    // touched it since now".
    const fp = JSON.parse(
      fs.readFileSync(path.join(tmp.stateDir, 'state', 'builtin-skill-fingerprints.json'), 'utf-8'),
    );
    expect(fp.skills.evolve.contentHash).toBe(sha256(customContent));
  });

  it('apply=false leaves the disk untouched (dry run)', () => {
    const skillPath = path.join(tmp.projectDir, '.claude', 'skills', 'evolve', 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(false);

    const result = regenerateBuiltinSkills({
      projectDir: tmp.projectDir,
      stateDir: tmp.stateDir,
      port: PORT,
      apply: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(s => s.includes('would install'))).toBe(true);
    expect(fs.existsSync(skillPath)).toBe(false);
    expect(fs.existsSync(path.join(tmp.stateDir, 'state', 'builtin-skill-fingerprints.json'))).toBe(false);
  });
});
