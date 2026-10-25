/**
 * Normal-Chrome browser — Agent Awareness + Migration Parity
 * (specs docs/specs/normal-chrome-builtin-skill.md, docs/specs/normal-chrome-cross-platform.md).
 *
 *  - generateClaudeMd carries the (macOS + Windows) section (new agents).
 *  - migrateClaudeMd appends it to an existing CLAUDE.md, REPLACES the shipped v1 (macOS-only)
 *    section in place, keeps an edited v1 section, removes a stale v1 copy beside the new one,
 *    handles CRLF documents, and is idempotent.
 *  - migrateScripts refreshes all five .instar/scripts/browser/ helpers.
 *  - migrateNormalChromeBrowserSkill replaces a first-shipped skill copy, appends the Windows
 *    appendix (with the shared rules) to an edited copy and writes the shipped text beside it.
 *  - The framework-shadow pass strips an exact v1 section and keeps an edited one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  PostUpdateMigrator,
  NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION,
  NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION_V1,
  NORMAL_CHROME_BROWSER_CLAUDEMD_HEADING,
  NORMAL_CHROME_BROWSER_CLAUDEMD_HEADING_V1,
  NORMAL_CHROME_BROWSER_SKILL_MARKER,
  NORMAL_CHROME_BROWSER_SKILL_V1_SHA256,
  markdownSectionBounds,
  replaceOrAppendMarkdownSection,
} from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { BROWSER_SCRIPT_NAMES } from '../../src/commands/init.js';
import { NORMAL_CHROME_BROWSER_SKILL_CONTENT, NORMAL_CHROME_BROWSER_SHARED_RULES, NORMAL_CHROME_BROWSER_WINDOWS_SECTION } from '../../src/data/builtinSkillContent.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const HEADING = NORMAL_CHROME_BROWSER_CLAUDEMD_HEADING;
const HEADING_V1 = NORMAL_CHROME_BROWSER_CLAUDEMD_HEADING_V1;
const V1_FIXTURE = path.resolve(process.cwd(), 'tests/fixtures/skills/normal-chrome-browser-v1.md');

function call(m: PostUpdateMigrator, method: 'migrateClaudeMd' | 'migrateScripts' | 'migrateNormalChromeBrowserSkill' | 'migrateFrameworkShadowCapabilities'): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as Record<string, (r: MigrationResult) => void>)[method](result);
  return result;
}
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION', () => {
  it('names the skill, all five scripts, both platforms, the trigger, the safety rules and the Linux statement', () => {
    const text = NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION();
    expect(text).toContain(HEADING);
    expect(text).toContain('`/normal-chrome-browser`');
    for (const name of BROWSER_SCRIPT_NAMES) expect(text).toContain(name);
    expect(text).toContain('BEFORE ever telling the operator a browser task "can\'t be done"');
    expect(text).toContain('only take actions the operator asked for');
    expect(text).toContain('never for reaching actions the page does not offer this account');
    expect(text).toContain('written by PP');
    expect(text).toContain('an agent in WSL is on Windows for this');
    expect(text).toContain('ACT-138');
    expect(text).toContain('never take focus or send input while the operator is using the machine');
    expect(text).not.toContain('macOS only');
    expect(text.length).toBeLessThan(NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION_V1().length * 2); // a pointer-sized card, not the skill
  });

  it('generateClaudeMd carries the section verbatim and not the v1 heading (Agent Awareness)', () => {
    const md = generateClaudeMd('fixture', 'Fixture', 4042, true);
    expect(md).toContain(NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION().trim());
    expect(md).not.toContain(HEADING_V1 + '\n');
  });

  it('is on the framework-shadow marker list (by its constant)', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/core/PostUpdateMigrator.ts'), 'utf-8');
    const start = src.indexOf('const markers = [');
    const block = src.slice(start, src.indexOf('];', start));
    expect(block).toContain(`'${HEADING}'`);
    expect(block).not.toContain(`'${HEADING_V1}'`);
  });
});

describe('markdownSectionBounds / replaceOrAppendMarkdownSection', () => {
  const V1 = NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION_V1();
  const NEW = NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION();

  it('bounds a section at the next heading of any level or a blank-line-led **Bold** block, and only at a line start', () => {
    const doc = `# Top\n\nintro\n${V1}\n**Live-User-Channel Proof Before Done** — a bold-led section.\n\n### Later\n\nmore\n`;
    const b = markdownSectionBounds(doc, HEADING_V1)!;
    expect(doc.slice(b.start, b.end).trim()).toBe(V1.trim());
    expect(doc.slice(b.end)).toMatch(/^\*\*Live-User-Channel/);
    // A quoted mention is not the section; a demoted #### copy is not the section.
    expect(markdownSectionBounds(`text that says ${HEADING_V1} inline\n`, HEADING_V1)).toBeNull();
    expect(markdownSectionBounds(`#${HEADING_V1}\n\nbody\n`, HEADING_V1)).toBeNull();
    // End of file.
    const eof = `# Top\n${V1}`;
    const be = markdownSectionBounds(eof, HEADING_V1)!;
    expect(eof.slice(be.start, be.end).trim()).toBe(V1.trim());
  });

  it('replaces the exact shipped v1 section in place, keeping what follows', () => {
    const doc = `# Top\n\nintro\n${V1}\n- **Claude sessions launch from a retained per-version copy** of the executable.\n\n### Later\n\nmore\n`;
    const r = replaceOrAppendMarkdownSection(doc, HEADING_V1, HEADING, NEW, V1);
    expect(r.action).toBe('replaced');
    expect(r.content).toContain(NEW.trim());
    expect(r.content).not.toContain(HEADING_V1);
    expect(r.content).toContain('- **Claude sessions launch from a retained per-version copy**');
    expect(r.content).toContain('### Later\n\nmore');
    expect(r.content.indexOf(HEADING)).toBeLessThan(r.content.indexOf('- **Claude sessions'));
  });

  it('keeps an edited v1 section (or one with heading-less text after it) and appends the new section beside it', () => {
    const edited = V1.replace('never touch the operator\'s own Chrome', 'never touch the operator\'s own Chrome (my note: or Safari)');
    const r = replaceOrAppendMarkdownSection(`# Top\n${edited}`, HEADING_V1, HEADING, NEW, V1);
    expect(r.action).toBe('appended-old-kept');
    expect(r.content).toContain('my note: or Safari');
    expect(r.content).toContain(NEW.trim());
    const trailing = replaceOrAppendMarkdownSection(`# Top\n${V1}\nA paragraph the agent added right after, with no heading.\n`, HEADING_V1, HEADING, NEW, V1);
    expect(trailing.action).toBe('appended-old-kept');
    expect(trailing.content).toContain('A paragraph the agent added right after');
  });

  it('replaces the exact v1 copy in place even when an edited v1 copy precedes it (new heading absent)', () => {
    const edited = V1.replace('list that folder instead', 'list that folder instead (my edit)');
    const r = replaceOrAppendMarkdownSection(`# Top\n${edited}\n### Between\n\ntext\n${V1}`, HEADING_V1, HEADING, NEW, V1);
    expect(r.action).toBe('replaced');
    expect(r.content).toContain('(my edit)'); // the edited copy stays
    expect(count(r.content, HEADING_V1)).toBe(1);
    expect(count(r.content, HEADING)).toBe(1);
    expect(r.content.indexOf('### Between')).toBeLessThan(r.content.indexOf(HEADING));
  });

  it('removes a stale exact v1 copy when the new section is already present; is a no-op otherwise', () => {
    const both = `# Top\n${NEW}\n${V1}`;
    const r = replaceOrAppendMarkdownSection(both, HEADING_V1, HEADING, NEW, V1);
    expect(r.action).toBe('removed-stale');
    expect(count(r.content, HEADING)).toBe(1);
    expect(r.content).not.toContain(HEADING_V1);
    const again = replaceOrAppendMarkdownSection(r.content, HEADING_V1, HEADING, NEW, V1);
    expect(again.action).toBe('present');
    expect(again.content).toBe(r.content);
    expect(replaceOrAppendMarkdownSection('# Top\n', HEADING_V1, HEADING, NEW, V1).action).toBe('appended');
  });

  it('handles a CRLF document and writes it back in CRLF', () => {
    const doc = `# Top\r\n\r\nintro\r\n${V1.replace(/\n/g, '\r\n')}\r\n### Later\r\n\r\nmore\r\n`;
    const r = replaceOrAppendMarkdownSection(doc, HEADING_V1, HEADING, NEW, V1);
    expect(r.action).toBe('replaced');
    expect(r.content).not.toContain(HEADING_V1);
    expect(r.content).toContain(HEADING + '\r\n');
    expect(r.content).not.toMatch(/[^\r]\n/);
    expect(r.content).toContain('### Later\r\n\r\nmore');
  });
});

describe('PostUpdateMigrator — normal-Chrome browser', () => {
  let projectDir: string;
  let m: PostUpdateMigrator;
  const skillPath = () => path.join(projectDir, '.claude', 'skills', 'normal-chrome-browser', 'SKILL.md');
  const claudeMd = () => fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');

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
    expect(second.upgraded.filter(u => /Normal-Chrome/.test(u))).toEqual([]);
    expect(count(claudeMd(), HEADING)).toBe(1);
    expect(claudeMd()).toContain(NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION().trim());
  });

  it('migrateClaudeMd replaces the shipped v1 section in place (the PR 2283 agent), keeping a heading-less block after it', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), `# CLAUDE.md — agent on PR 2283\n${NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION_V1()}\n**A2A cross-route copies are labelled:** one peer can reach me under more than one kind of identity.\n`);
    const r = call(m, 'migrateClaudeMd');
    expect(r.upgraded).toContain('CLAUDE.md: replaced Normal-Chrome browser section (macOS + Windows)');
    const md = claudeMd();
    expect(count(md, HEADING)).toBe(1);
    expect(md).not.toContain(HEADING_V1);
    expect(md).toContain('**A2A cross-route copies are labelled:**');
    expect(call(m, 'migrateClaudeMd').upgraded.filter(u => /Normal-Chrome/.test(u))).toEqual([]);
  });

  it('migrateClaudeMd keeps an edited v1 section and removes a stale shipped v1 copy after a revert-then-upgrade', () => {
    const edited = NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION_V1().replace('list that folder instead', 'list that folder instead (my edit)');
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), `# CLAUDE.md\n${edited}`);
    const r = call(m, 'migrateClaudeMd');
    expect(r.upgraded.some(u => u.includes('the edited macOS-only section was kept'))).toBe(true);
    expect(claudeMd()).toContain('(my edit)');
    expect(count(claudeMd(), HEADING)).toBe(1);
    // A release revert re-appends the shipped v1; the next upgrade removes it.
    fs.appendFileSync(path.join(projectDir, 'CLAUDE.md'), NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION_V1());
    const again = call(m, 'migrateClaudeMd');
    expect(again.upgraded).toContain('CLAUDE.md: removed the stale macOS-only Normal-Chrome browser section');
    expect(count(claudeMd(), HEADING_V1)).toBe(1); // only the edited copy remains
    expect(claudeMd()).toContain('(my edit)');
  });

  it('migrateScripts installs all five helpers and refreshes a stale copy on every run', () => {
    const dir = path.join(projectDir, '.instar', 'scripts', 'browser');
    const first = call(m, 'migrateScripts');
    for (const name of BROWSER_SCRIPT_NAMES) {
      expect(first.upgraded).toContain(`scripts/browser/${name} (normal-Chrome helper)`);
      expect(fs.statSync(path.join(dir, name)).mode & 0o777).toBe(0o755);
    }
    expect(first.errors.filter(e => e.startsWith('scripts/browser'))).toEqual([]);
    fs.writeFileSync(path.join(dir, 'chrome-launch.sh'), 'stale');
    fs.writeFileSync(path.join(dir, 'ndrive.sh'), 'stale');
    call(m, 'migrateScripts');
    expect(fs.readFileSync(path.join(dir, 'chrome-launch.sh'), 'utf-8')).toContain('open -g -na "Google Chrome"');
    expect(fs.readFileSync(path.join(dir, 'ndrive.sh'), 'utf-8')).toContain('Register-ScheduledTask');
  });

  describe('migrateNormalChromeBrowserSkill', () => {
    it('replaces a copy installed from the first shipped version (hash re-derived from the fixture, CRLF tolerated)', () => {
      const v1 = fs.readFileSync(V1_FIXTURE, 'utf-8');
      expect(createHash('sha256').update(v1).digest('hex')).toBe(NORMAL_CHROME_BROWSER_SKILL_V1_SHA256);
      fs.mkdirSync(path.dirname(skillPath()), { recursive: true });
      fs.writeFileSync(skillPath(), v1);
      const r = call(m, 'migrateNormalChromeBrowserSkill');
      expect(r.upgraded).toContain('skills/normal-chrome-browser/SKILL.md (macOS + Windows drivers)');
      expect(fs.readFileSync(skillPath(), 'utf-8')).toBe(NORMAL_CHROME_BROWSER_SKILL_CONTENT);
      expect(fs.existsSync(path.join(path.dirname(skillPath()), 'SKILL.shipped.md'))).toBe(false);
      // Idempotent on the marker.
      expect(call(m, 'migrateNormalChromeBrowserSkill').upgraded).toEqual([]);
      // A CRLF copy of the shipped text is still recognized.
      fs.writeFileSync(skillPath(), v1.replace(/\n/g, '\r\n'));
      expect(call(m, 'migrateNormalChromeBrowserSkill').upgraded).toContain('skills/normal-chrome-browser/SKILL.md (macOS + Windows drivers)');
    });

    it('appends the Windows appendix once to an edited copy, keeps the edits, and writes the shipped text beside it', () => {
      const edited = fs.readFileSync(V1_FIXTURE, 'utf-8') + '\n## My notes\n\nfire events that page code listens for\n';
      fs.mkdirSync(path.dirname(skillPath()), { recursive: true });
      fs.writeFileSync(skillPath(), edited);
      const r = call(m, 'migrateNormalChromeBrowserSkill');
      expect(r.upgraded).toContain('skills/normal-chrome-browser/SKILL.md (appended the Windows driver section; local edits kept; shipped text in SKILL.shipped.md)');
      const after = fs.readFileSync(skillPath(), 'utf-8');
      expect(after.startsWith(edited.trimEnd())).toBe(true);
      expect(after).toContain('fire events that page code listens for'); // the agent's text is never removed
      expect(r.upgraded.some(u => u.includes('still describes dispatching synthetic focus/mouse/pointer events'))).toBe(true); // surfaced, not rewritten
      expect(count(after, NORMAL_CHROME_BROWSER_SKILL_MARKER)).toBe(1);
      expect(after).toContain(NORMAL_CHROME_BROWSER_SHARED_RULES.trim()); // the current rules are on disk
      expect(after).toContain(NORMAL_CHROME_BROWSER_WINDOWS_SECTION.trim());
      expect(after).toContain('win over any older instruction above that conflicts');
      expect(fs.readFileSync(path.join(path.dirname(skillPath()), 'SKILL.shipped.md'), 'utf-8')).toBe(NORMAL_CHROME_BROWSER_SKILL_CONTENT);
      expect(call(m, 'migrateNormalChromeBrowserSkill').upgraded).toEqual([]);
      expect(count(fs.readFileSync(skillPath(), 'utf-8'), NORMAL_CHROME_BROWSER_SKILL_MARKER)).toBe(1);
    });

    it('a CRLF edited copy gets a CRLF appendix (no mixed line endings), and the shipped sibling is refreshed on later runs', () => {
      const edited = (fs.readFileSync(V1_FIXTURE, 'utf-8') + '\n## My notes\n\nkeep\n').replace(/\n/g, '\r\n');
      fs.mkdirSync(path.dirname(skillPath()), { recursive: true });
      fs.writeFileSync(skillPath(), edited);
      call(m, 'migrateNormalChromeBrowserSkill');
      const after = fs.readFileSync(skillPath(), 'utf-8');
      expect(after).not.toMatch(/[^\r]\n/); // every newline is CRLF
      expect(after.replace(/\r\n/g, '\n')).toContain(NORMAL_CHROME_BROWSER_SKILL_MARKER);
      // The sibling is never agent-edited: a stale one is refreshed even though SKILL.md already carries the marker.
      const shipped = path.join(path.dirname(skillPath()), 'SKILL.shipped.md');
      fs.writeFileSync(shipped, 'older shipped text');
      const r = call(m, 'migrateNormalChromeBrowserSkill');
      expect(r.upgraded).toContain('skills/normal-chrome-browser/SKILL.shipped.md (refreshed to the current shipped text)');
      expect(fs.readFileSync(shipped, 'utf-8')).toBe(NORMAL_CHROME_BROWSER_SKILL_CONTENT);
      expect(fs.readFileSync(skillPath(), 'utf-8')).toBe(after); // the agent's SKILL.md is untouched by the refresh
    });

    it('leaves a file that is not this skill alone and a missing file to installBuiltinSkills', () => {
      fs.mkdirSync(path.dirname(skillPath()), { recursive: true });
      fs.writeFileSync(skillPath(), '---\nname: something-else\n---\nmine');
      const r = call(m, 'migrateNormalChromeBrowserSkill');
      expect(r.upgraded).toEqual([]);
      expect(r.skipped.some(s => s.includes('not the built-in skill'))).toBe(true);
      expect(fs.readFileSync(skillPath(), 'utf-8')).toBe('---\nname: something-else\n---\nmine');
      SafeFsExecutor.safeRmSync(skillPath(), { force: true, operation: 'tests/unit/PostUpdateMigrator-normalChromeBrowser.test.ts' });
      expect(call(m, 'migrateNormalChromeBrowserSkill')).toEqual({ upgraded: [], skipped: [], errors: [] });
    });
  });

  it('the shadow pass strips an exact shipped v1 section from AGENTS.md and mirrors the new one once; an edited v1 section is kept', () => {
    call(m, 'migrateClaudeMd');
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), `# AGENTS.md\n${NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION_V1().trimEnd()}\n`);
    call(m, 'migrateFrameworkShadowCapabilities');
    const agents = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8');
    expect(count(agents, HEADING)).toBe(1);
    expect(agents).not.toContain(HEADING_V1);
    call(m, 'migrateFrameworkShadowCapabilities');
    expect(count(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8'), HEADING)).toBe(1);

    const edited = NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION_V1().replace('list that folder instead', 'list that folder instead (my edit)');
    fs.writeFileSync(path.join(projectDir, 'GEMINI.md'), `# GEMINI.md\n${edited}`);
    call(m, 'migrateFrameworkShadowCapabilities');
    const gemini = fs.readFileSync(path.join(projectDir, 'GEMINI.md'), 'utf-8');
    expect(gemini).toContain('(my edit)');
    expect(count(gemini, HEADING)).toBe(1);
    // A CRLF shadow with the exact v1 section is stripped too, and stays CRLF.
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), `# AGENTS.md\n${NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION_V1().trimEnd()}\n`.replace(/\n/g, '\r\n'));
    call(m, 'migrateFrameworkShadowCapabilities');
    const crlf = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8');
    expect(crlf).not.toContain(HEADING_V1);
    expect(crlf).toContain(HEADING);
    expect(crlf.split('\r\n').length).toBeGreaterThan(5);
  });
});
