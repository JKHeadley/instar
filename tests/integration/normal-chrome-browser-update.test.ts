/**
 * Update path for an EXISTING agent (Migration Parity): a full PostUpdateMigrator.migrate() on an
 * agent home that carries the PR 2283 state (the first shipped skill copy, the three macOS scripts,
 * the macOS-only CLAUDE.md section mirrored into AGENTS.md) ends with the cross-platform skill, all
 * five scripts, one new-heading section in CLAUDE.md and AGENTS.md, zero old-heading sections; a
 * second run is clean; an edited skill copy survives with the Windows appendix added once.
 * Specs: docs/specs/normal-chrome-builtin-skill.md, docs/specs/normal-chrome-cross-platform.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator, NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION_V1, NORMAL_CHROME_BROWSER_CLAUDEMD_HEADING, NORMAL_CHROME_BROWSER_CLAUDEMD_HEADING_V1, NORMAL_CHROME_BROWSER_SKILL_MARKER } from '../../src/core/PostUpdateMigrator.js';
import { BROWSER_SCRIPT_NAMES } from '../../src/commands/init.js';
import { NORMAL_CHROME_BROWSER_SKILL_CONTENT } from '../../src/data/builtinSkillContent.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const V1_FIXTURE = path.resolve(process.cwd(), 'tests/fixtures/skills/normal-chrome-browser-v1.md');
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('PostUpdateMigrator.migrate() — normal-Chrome browser (macOS + Windows) reaches an existing agent', () => {
  let projectDir: string;
  const skillPath = () => path.join(projectDir, '.claude', 'skills', 'normal-chrome-browser', 'SKILL.md');

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-normal-chrome-update-'));
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'old-agent', port: 4042 }));
    // The PR 2283 state: the macOS-only section at the end of CLAUDE.md and mirrored in AGENTS.md.
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), `# CLAUDE.md — old agent\n${NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION_V1()}`);
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), `# AGENTS.md — old agent\n${NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION_V1().trimEnd()}\n`);
    fs.mkdirSync(path.dirname(skillPath()), { recursive: true });
    fs.writeFileSync(skillPath(), fs.readFileSync(V1_FIXTURE, 'utf-8'));
    fs.mkdirSync(path.join(stateDir, 'scripts', 'browser'), { recursive: true });
    for (const name of ['chrome-launch.sh', 'chrome-js.sh', 'chrome-mainworld.sh']) fs.writeFileSync(path.join(stateDir, 'scripts', 'browser', name), '#!/bin/bash\necho v1\n');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/integration/normal-chrome-browser-update.test.ts' });
  });

  it('upgrades skill, scripts and awareness in place, and is idempotent', () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'old-agent' });
    const first = m.migrate();
    expect(first.errors.filter(e => /browser|normal-chrome/i.test(e))).toEqual([]);

    expect(fs.readFileSync(skillPath(), 'utf-8')).toBe(NORMAL_CHROME_BROWSER_SKILL_CONTENT);
    for (const name of BROWSER_SCRIPT_NAMES) {
      const p = path.join(projectDir, '.instar', 'scripts', 'browser', name);
      expect(fs.statSync(p).mode & 0o111, name).not.toBe(0);
      expect(fs.readFileSync(p, 'utf-8'), name).not.toBe('#!/bin/bash\necho v1\n');
    }
    for (const doc of ['CLAUDE.md', 'AGENTS.md']) {
      const md = fs.readFileSync(path.join(projectDir, doc), 'utf-8');
      expect(count(md, NORMAL_CHROME_BROWSER_CLAUDEMD_HEADING), doc).toBe(1);
      expect(md, doc).not.toContain(NORMAL_CHROME_BROWSER_CLAUDEMD_HEADING_V1);
    }

    // Second run: nothing to do for this feature; the scripts are still refreshed.
    fs.writeFileSync(path.join(projectDir, '.instar', 'scripts', 'browser', 'ndrive.sh'), 'stale');
    const second = m.migrate();
    expect(second.upgraded.filter(u => /Normal-Chrome browser section|normal-chrome-browser\/SKILL/.test(u))).toEqual([]);
    expect(fs.readFileSync(path.join(projectDir, '.instar', 'scripts', 'browser', 'ndrive.sh'), 'utf-8')).toContain('Register-ScheduledTask');
    for (const doc of ['CLAUDE.md', 'AGENTS.md']) {
      expect(count(fs.readFileSync(path.join(projectDir, doc), 'utf-8'), NORMAL_CHROME_BROWSER_CLAUDEMD_HEADING), doc).toBe(1);
    }
  });

  it('an agent-edited skill copy keeps its edits and gains the Windows appendix exactly once across runs', () => {
    fs.writeFileSync(skillPath(), fs.readFileSync(V1_FIXTURE, 'utf-8') + '\n## My notes\n\nkeep this\n');
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'old-agent' });
    m.migrate();
    m.migrate();
    const skill = fs.readFileSync(skillPath(), 'utf-8');
    expect(skill).toContain('## My notes\n\nkeep this');
    expect(count(skill, NORMAL_CHROME_BROWSER_SKILL_MARKER)).toBe(1);
    expect(fs.readFileSync(path.join(path.dirname(skillPath()), 'SKILL.shipped.md'), 'utf-8')).toBe(NORMAL_CHROME_BROWSER_SKILL_CONTENT);
  });
});
