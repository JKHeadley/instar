/**
 * Normal-Chrome browser — Agent Awareness + Migration Parity
 * (spec docs/specs/normal-chrome-builtin-skill.md).
 *
 *  - generateClaudeMd carries the section (new agents).
 *  - migrateClaudeMd appends the SAME text to an existing CLAUDE.md, idempotently.
 *  - migrateScripts refreshes the three .instar/scripts/browser/ helpers.
 *  - The section is on the framework-shadow marker list (the scripts are framework-neutral).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator, NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { BROWSER_SCRIPT_NAMES } from '../../src/commands/init.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const HEADING = '### Normal-Chrome browser (account-bound web tasks, macOS)';

function call(m: PostUpdateMigrator, method: 'migrateClaudeMd' | 'migrateScripts'): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as Record<string, (r: MigrationResult) => void>)[method](result);
  return result;
}

describe('NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION', () => {
  it('names the skill, the scripts, the trigger, the safety rules and the platform limit', () => {
    const text = NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION();
    expect(text).toContain(HEADING);
    expect(text).toContain('`/normal-chrome-browser`');
    for (const name of BROWSER_SCRIPT_NAMES) expect(text).toContain(name);
    expect(text).toContain('BEFORE ever telling the operator a browser task "can\'t be done"');
    expect(text).toContain('only take actions the operator asked for');
    expect(text).toContain('never for reaching actions the page does not offer this account');
    expect(text).toContain('ERR macos-only');
  });

  it('generateClaudeMd carries the section verbatim (Agent Awareness)', () => {
    const md = generateClaudeMd('fixture', 'Fixture', 4042, true);
    expect(md).toContain(NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION().trim());
  });

  it('is on the framework-shadow marker list', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/core/PostUpdateMigrator.ts'), 'utf-8');
    const start = src.indexOf('const markers = [');
    const block = src.slice(start, src.indexOf('];', start));
    expect(block).toContain(`'${HEADING}'`);
  });
});

describe('PostUpdateMigrator — normal-Chrome browser', () => {
  let projectDir: string;
  let m: PostUpdateMigrator;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-normal-chrome-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# CLAUDE.md — existing agent\n\nSome prior content.\n');
    m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test-agent' });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-normalChromeBrowser.test.ts' });
  });

  it('migrateClaudeMd appends the section once', () => {
    const first = call(m, 'migrateClaudeMd');
    expect(first.upgraded).toContain('CLAUDE.md: added Normal-Chrome browser section');
    const second = call(m, 'migrateClaudeMd');
    expect(second.upgraded).not.toContain('CLAUDE.md: added Normal-Chrome browser section');
    const md = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(md.split(HEADING).length - 1).toBe(1);
    expect(md).toContain(NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION().trim());
  });

  it('migrateScripts installs the helpers and refreshes a stale copy on every run', () => {
    const dir = path.join(projectDir, '.instar', 'scripts', 'browser');
    const first = call(m, 'migrateScripts');
    for (const name of BROWSER_SCRIPT_NAMES) {
      expect(first.upgraded).toContain(`scripts/browser/${name} (normal-Chrome helper)`);
      expect(fs.statSync(path.join(dir, name)).mode & 0o777).toBe(0o755);
    }
    expect(first.errors.filter(e => e.startsWith('scripts/browser'))).toEqual([]);
    fs.writeFileSync(path.join(dir, 'chrome-launch.sh'), 'stale');
    call(m, 'migrateScripts');
    expect(fs.readFileSync(path.join(dir, 'chrome-launch.sh'), 'utf-8')).toContain('open -na "Google Chrome"');
  });
});
