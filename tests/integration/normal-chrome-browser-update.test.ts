/**
 * Update path for an EXISTING agent (Migration Parity): a full PostUpdateMigrator.migrate()
 * on an agent home that predates the normal-Chrome skill delivers the skill, the three
 * .instar/scripts/browser/ helpers and the CLAUDE.md section, and a second run is clean.
 * Spec: docs/specs/normal-chrome-builtin-skill.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { BROWSER_SCRIPT_NAMES } from '../../src/commands/init.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('PostUpdateMigrator.migrate() — normal-Chrome browser reaches an existing agent', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-normal-chrome-update-'));
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'old-agent', port: 4042 }));
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# CLAUDE.md — old agent\n');
    fs.mkdirSync(path.join(projectDir, '.claude', 'skills'), { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/integration/normal-chrome-browser-update.test.ts' });
  });

  it('installs skill, scripts and awareness, and is idempotent', () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'old-agent' });
    const first = m.migrate();
    expect(first.errors.filter(e => /browser|normal-chrome/i.test(e))).toEqual([]);

    const skill = fs.readFileSync(path.join(projectDir, '.claude', 'skills', 'normal-chrome-browser', 'SKILL.md'), 'utf-8');
    expect(skill).toMatch(/^---\nname: normal-chrome-browser\n/);
    for (const name of BROWSER_SCRIPT_NAMES) {
      const p = path.join(projectDir, '.instar', 'scripts', 'browser', name);
      expect(fs.statSync(p).mode & 0o111).not.toBe(0);
    }
    const md = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(md).toContain('### Normal-Chrome browser (account-bound web tasks, macOS)');

    // An agent's own edit to the skill survives the next update; the scripts are refreshed.
    const skillPath = path.join(projectDir, '.claude', 'skills', 'normal-chrome-browser', 'SKILL.md');
    fs.writeFileSync(skillPath, 'my edited copy');
    fs.writeFileSync(path.join(projectDir, '.instar', 'scripts', 'browser', 'chrome-js.sh'), 'stale');
    m.migrate();
    expect(fs.readFileSync(skillPath, 'utf-8')).toBe('my edited copy');
    expect(fs.readFileSync(path.join(projectDir, '.instar', 'scripts', 'browser', 'chrome-js.sh'), 'utf-8')).toContain('CrSu');
    const md2 = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(md2.split('### Normal-Chrome browser (account-bound web tasks, macOS)').length - 1).toBe(1);
  });
});
