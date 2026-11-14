/**
 * CLAUDE.md reference layout (docs/specs/claude-md-reference-layout.md).
 *
 * The full awareness document is ~570k characters; Claude Code warns above
 * 150k and loads all of it into every session. The layout keeps a small core
 * in CLAUDE.md and moves per-feature sections to .instar/reference/.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import {
  CLAUDE_MD_CORE_BUDGET_CHARS,
  CLAUDE_MD_CORE_END,
  CLAUDE_MD_CORE_HEADINGS,
  CLAUDE_MD_CORE_START,
  CLAUDE_MD_DIFFERING_LINES_REL,
  CLAUDE_MD_LEGACY_BACKUP_REL,
  MAX_REFERENCE_FILE_CHARS,
  REFERENCE_DIR_REL,
  REFERENCE_FILE_HEADER,
  extractOperatorContent,
  findCoreRegion,
  parseAwarenessUnits,
  renderCoreRegion,
  renderReferenceFiles,
  splitAwareness,
} from '../../src/scaffold/claudeMdLayout.js';

type Result = { upgraded: string[]; skipped: string[]; errors: string[] };
const fresh = (): Result => ({ upgraded: [], skipped: [], errors: [] });

function makeHome(prefix = 'claude-md-layout-') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const projectDir = path.join(tmp, 'agent');
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return { tmp, projectDir, stateDir, claudeMd: path.join(projectDir, 'CLAUDE.md'), refDir: path.join(projectDir, REFERENCE_DIR_REL) };
}

function migrator(h: ReturnType<typeof makeHome>, hasTelegram = false): PostUpdateMigrator {
  return new PostUpdateMigrator({ projectDir: h.projectDir, stateDir: h.stateDir, port: 4042, hasTelegram, projectName: 'tester' });
}

/** A legacy agent file: what migrateClaudeMd's chain produces over the template. */
function legacyFile(h: ReturnType<typeof makeHome>, extra = ''): string {
  fs.writeFileSync(h.claudeMd, generateClaudeMd('tester', 'tester', 4042, false) + extra);
  const m = migrator(h);
  m.migrateClaudeMd(fresh()); // legacy chain (no markers yet)
  return fs.readFileSync(h.claudeMd, 'utf-8');
}

describe('claudeMdLayout — pure split', () => {
  const full = new PostUpdateMigrator({ projectDir: '/nonexistent-x', stateDir: '/nonexistent-x/.instar', port: 4042, hasTelegram: true, projectName: 'tester' }).buildCanonicalClaudeMd();

  it('unit parser round-trips the document exactly', () => {
    expect(parseAwarenessUnits(full).map(u => u.text).join('')).toBe(full);
    const withFence = '# T\n\n## A\n```\n## not a heading\n**Bold** — inside fence\n```\n**Feat** — x\n';
    const units = parseAwarenessUnits(withFence);
    expect(units.map(u => u.text).join('')).toBe(withFence);
    expect(units.map(u => u.title)).toEqual(['', 'a', 'feat']);
  });

  it('every unit lands in exactly one output (core or one reference file)', () => {
    const split = splitAwareness(full);
    const pieces = [split.coreBody, ...split.referenceBodies.values()];
    const totalUnits = parseAwarenessUnits(full).length - 1;
    const placed = pieces.reduce((n, p) => n + parseAwarenessUnits(p).length - 1, 0);
    expect(placed).toBe(totalUnits);
    expect(split.preamble.length + pieces.reduce((n, p) => n + p.length, 0)).toBe(full.length);
  });

  it('the generated core is under the size budget, far below the 150k Claude Code limit', () => {
    expect(full.length).toBeGreaterThan(150_000); // the problem this layout exists for
    const core = renderCoreRegion(full);
    expect(core.length).toBeLessThan(CLAUDE_MD_CORE_BUDGET_CHARS);
    expect(CLAUDE_MD_CORE_BUDGET_CHARS).toBeLessThan(150_000);
  });

  it('core carries the always-needed headings and the dispatch table', () => {
    const core = renderCoreRegion(full);
    for (const h of ['Who I Am', 'API Authentication', 'Self-Discovery', 'Anti-Patterns to Override', 'Telegram Relay', 'Compaction Survival',
      'Gravity Wells', 'Feature Proactivity', 'Registry First', 'Outbound Message Gate', 'Cross-Agent Communication Discipline', 'If I am the session standing down']) {
      expect(core).toContain(h);
    }
    expect(CLAUDE_MD_CORE_HEADINGS.length).toBeGreaterThan(10);
    expect(core).toContain('## Instar Reference — read on demand');
    expect(core).toContain(`${REFERENCE_DIR_REL}/INDEX.md`);
    expect(core.startsWith(CLAUDE_MD_CORE_START)).toBe(true);
    expect(core.trimEnd().endsWith(CLAUDE_MD_CORE_END)).toBe(true);
  });

  it('INDEX lists every reference unit title and every reference file has the header', () => {
    const files = renderReferenceFiles(full);
    const index = files.get('INDEX.md')!;
    const split = splitAwareness(full);
    for (const [file, titles] of split.referenceTitles) {
      expect(index).toContain(`## ${file}`);
      for (const t of titles) expect(index).toContain(`- ${t}`);
    }
    for (const [, body] of files) expect(body.split('\n', 1)[0]).toBe(REFERENCE_FILE_HEADER);
    // Every row of the dispatch table points at a file that is written.
    const core = renderCoreRegion(full);
    for (const m of core.matchAll(/`\.instar\/reference\/([^`]+)`/g)) expect(files.has(m[1])).toBe(true);
  });

  it('the core names every reference capability (Agent Awareness: the agent knows it exists)', () => {
    const core = renderCoreRegion(full);
    expect(core).toContain('### Every capability in the reference files');
    const split = splitAwareness(full);
    for (const titles of split.referenceTitles.values()) {
      for (const t of titles) {
        const name = t.split(/ \(| — | - |: /)[0].replace(/`/g, '').trim().slice(0, 57);
        expect(core, t).toContain(name);
      }
    }
  });

  it('reference files stay readable in one call: big topics are cut into parts', () => {
    const files = renderReferenceFiles(full);
    for (const [name, body] of files) {
      if (name === 'INDEX.md') continue;
      // A part only exceeds the cap when it is a single unit larger than the cap.
      const units = parseAwarenessUnits(body).length - 1;
      if (units > 1) expect(body.length, name).toBeLessThan(MAX_REFERENCE_FILE_CHARS + 1_000);
    }
    expect([...files.keys()].some(f => /-2\.md$/.test(f))).toBe(true);
  });

  it('a generic sub-section follows its parent into the same reference file', () => {
    const doc = '# T\n\n## Threadline Network\n\nintro\n\n### What It Does\n\nthread stuff\n';
    expect(splitAwareness(doc).referenceBodies.get('agent-to-agent.md')).toContain('thread stuff');
  });

  it('no section of the canonical document is split away from a core section it sits inside', () => {
    // A heading nested under a core section must be core itself (add it to
    // CLAUDE_MD_CORE_HEADINGS) or move out from under it in the template.
    for (const tg of [false, true]) {
      const doc = new PostUpdateMigrator({ projectDir: '/nonexistent-x', stateDir: '/nonexistent-x/.instar', port: 4042, hasTelegram: tg, projectName: 'tester' }).buildCanonicalClaudeMd();
      expect(splitAwareness(doc).nestedOutsideCore).toEqual([]);
    }
    const bad = splitAwareness('# T\n\n## Gravity Wells (Persistent Traps)\n\ntraps\n\n### The Newest Trap\n\nnew\n');
    expect(bad.nestedOutsideCore).toEqual(['the newest trap']);
    // Children of the container heading are classified on their own.
    expect(splitAwareness('# T\n\n## Agent Infrastructure\n\nx\n\n### Brand New Widget\n\nw\n').nestedOutsideCore).toEqual([]);
  });

  it('a feature section added to the template lands in a reference file, not the core', () => {
    const extended = full + '\n### Brand New Widget (POST /widget)\n\nA long new capability description.\n';
    const core = renderCoreRegion(extended);
    expect(core).not.toContain('A long new capability description.');
    expect(core).toContain('Brand New Widget'); // named in the always-loaded capability list
    expect([...renderReferenceFiles(extended).values()].some(b => b.includes('A long new capability description.'))).toBe(true);
  });

  it('full layout fills the region with the whole canonical document', () => {
    const region = renderCoreRegion(full, 'full');
    expect(region).toContain(full.trimEnd());
  });

  it('findCoreRegion: absent → null, half pair or duplicate → broken', () => {
    expect(findCoreRegion('# x')).toBeNull();
    expect(findCoreRegion(`${CLAUDE_MD_CORE_START}\nonly start`)).toBe('broken');
    expect(findCoreRegion(`only end\n${CLAUDE_MD_CORE_END}`)).toBe('broken');
    expect(findCoreRegion(`${CLAUDE_MD_CORE_END}\n${CLAUDE_MD_CORE_START}`)).toBe('broken');
    const ok = `${CLAUDE_MD_CORE_START}\nbody\n${CLAUDE_MD_CORE_END}\nmine`;
    const loc = findCoreRegion(ok);
    expect(loc).not.toBeNull();
    expect(ok.slice((loc as { end: number }).end)).toBe('mine');
  });
});

describe('extractOperatorContent — what the conversion keeps', () => {
  const canonical = '# CLAUDE.md — a\n\n## Who I Am\n\nI am a, the autonomous agent for this project.\n\n### Feature X (GET /x)\n\nline one of x\nline two of x\nline three of x\nline four of x\n';

  it('moves template sections and keeps operator-written ones', () => {
    const legacy = canonical + '\n## My Own Notes\n\nOnly the operator wrote this.\n';
    const ex = extractOperatorContent(legacy, canonical);
    expect(ex.kept).toContain('My Own Notes');
    expect(ex.kept).not.toContain('Feature X');
    expect(ex.movedUnits).toBe(2);
  });

  it('moves an older wording of a reference section by title', () => {
    // 2 of 4 lines verbatim (50%): drifted instar wording measured at 40–57%.
    const legacy = '### Feature X (GET /x)\n\nline one of x\nline two of x\nold wording here\nmore old wording\n';
    expect(extractOperatorContent(legacy, canonical).kept).toBe('');
  });

  it('keeps a personalised core section even though its title matches (e.g. "Who I Am")', () => {
    const legacy = '## Who I Am\n\nI\'m Luna, calm and thoughtful, the agent for Sagemind.\n\nI investigate first.\n';
    const ex = extractOperatorContent(legacy, canonical);
    expect(ex.kept).toContain('I\'m Luna');
  });

  it('an instar heading over lines the operator wrote is kept (the heading itself is not evidence)', () => {
    // 1 of 3 body lines is instar's (33%, under the 40% title threshold): kept. It
    // would reach 50% only if the heading line counted as a match.
    const legacy = '### Feature X (GET /x)\n\nmine one\nmine two\nline one of x\n';
    expect(extractOperatorContent('### Feature X (GET /x)\n\nmine one\nmine two\nmine three\n', canonical).kept).toContain('mine one');
    expect(extractOperatorContent(legacy, canonical).kept).toContain('mine one');
    // A heading with no body: kept unless instar has exactly that heading.
    expect(extractOperatorContent('## My Empty Heading\n', canonical).kept).toContain('My Empty Heading');
    expect(extractOperatorContent('### Feature X (GET /x)\n', canonical).kept).toBe('');
  });

  it('a unique line in non-template text before the first heading is listed for review', () => {
    const legacy = '# CLAUDE.md — a\n\nI am a, the autonomous agent for this project.\nline one of x\nline two of x\nOPERATOR PREAMBLE NOTE\n';
    const ex = extractOperatorContent(legacy, canonical);
    expect(ex.kept).toBe('');
    expect(ex.movedDiffering.some(d => d.lines.includes('OPERATOR PREAMBLE NOTE'))).toBe(true);
  });

  it('headings inside ~~~ fences or longer backtick fences never start a unit', () => {
    const doc = '# T\n\n## A\n\n~~~\n## not a heading\n~~~\n\n````\n```\n## still code\n```\n````\n\n## B\n';
    const units = parseAwarenessUnits(doc);
    expect(units.map(u => u.text).join('')).toBe(doc);
    expect(units.map(u => u.title)).toEqual(['', 'a', 'b']);
  });

  it('a ##### sub-section (skipped level) and its bold-lead stay with the parent', () => {
    const doc = '# T\n\n### Browser Automation\n\nb\n\n##### Restrictions\n\n**Outbound gate** — never send from here\n';
    expect(splitAwareness(doc).referenceBodies.get('principles-and-practices.md')).toContain('never send from here');
  });

  it('a bold-lead paragraph inside a #### sub-section stays with it', () => {
    const doc = '# T\n\n### Browser Automation\n\nb\n\n#### Restrictions\n\n**Outbound gate** — never send from here\n';
    expect(splitAwareness(doc).referenceBodies.get('principles-and-practices.md')).toContain('never send from here');
  });

  it('reference parts are never cut between a section and its #### sub-section', () => {
    const big = 'x'.repeat(MAX_REFERENCE_FILE_CHARS - 100);
    const doc = `# T\n\n### Browser Automation\n\n${big}\n\n#### Permissions and approvals\n\nrules\n\n### Web Content Fetching\n\nw\n`;
    const parts = splitAwareness(doc).referenceParts.get('principles-and-practices.md')!;
    const withParent = parts.find(p => p.body.includes('### Browser Automation'))!;
    expect(withParent.body).toContain('#### Permissions and approvals');
  });

  it('a #### sub-section stays with its parent even when its title matches another topic', () => {
    const doc = '# T\n\n### Browser Automation\n\nb\n\n#### Permissions and approvals\n\nrules\n';
    const split = splitAwareness(doc);
    expect(split.referenceBodies.get('principles-and-practices.md')).toContain('rules');
  });

  it('keeps operator text placed under an instar title when almost none of its lines are instar\'s', () => {
    const legacy = '### Feature X (GET /x)\n\nmy rule one\nmy rule two\nmy rule three\nmy rule four\nmy rule five\n';
    expect(extractOperatorContent(legacy, canonical).kept).toContain('my rule one');
  });
});

describe('PostUpdateMigrator — reference layout conversion', () => {
  let h: ReturnType<typeof makeHome>;
  beforeEach(() => { h = makeHome(); });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(h.tmp, { recursive: true, force: true, operation: 'tests/unit/claude-md-reference-layout.test.ts' });
  });

  it('converts a legacy file: small CLAUDE.md, backup, reference files, operator section kept', () => {
    const legacy = legacyFile(h, '\n## Operator Runbook\n\nRestart the printer every Monday.\n');
    expect(legacy.length).toBeGreaterThan(150_000);
    const r = fresh();
    migrator(h).migrateClaudeMdReferenceLayout(r);
    expect(r.errors).toEqual([]);
    const now = fs.readFileSync(h.claudeMd, 'utf-8');
    expect(now.length).toBeLessThan(CLAUDE_MD_CORE_BUDGET_CHARS);
    expect(findCoreRegion(now)).not.toBeNull();
    expect(now).toContain('Restart the printer every Monday.');
    expect(fs.readFileSync(path.join(h.projectDir, CLAUDE_MD_LEGACY_BACKUP_REL), 'utf-8')).toBe(legacy);
    expect(fs.existsSync(path.join(h.refDir, 'INDEX.md'))).toBe(true);
    expect(r.upgraded.some(u => u.includes('REVIEW') && u.includes('Operator Runbook'))).toBe(true);
  });

  it('a second migrator run changes nothing', () => {
    legacyFile(h);
    const m = migrator(h);
    m.migrateClaudeMdReferenceLayout(fresh());
    const snapshot = fs.readFileSync(h.claudeMd, 'utf-8');
    const refSnap = fs.readdirSync(h.refDir).map(f => fs.readFileSync(path.join(h.refDir, f), 'utf-8'));
    const r = fresh();
    const m2 = migrator(h);
    m2.migrateClaudeMd(r);
    m2.migrateClaudeMdReferenceLayout(r);
    expect(r.upgraded).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(fs.readFileSync(h.claudeMd, 'utf-8')).toBe(snapshot);
    expect(fs.readdirSync(h.refDir).map(f => fs.readFileSync(path.join(h.refDir, f), 'utf-8'))).toEqual(refSnap);
  });

  it('refresh rewrites only the instar block; operator text below it is untouched', () => {
    legacyFile(h);
    migrator(h).migrateClaudeMdReferenceLayout(fresh());
    const tail = '\n## Mine\n\nnever touch this\n';
    const stale = fs.readFileSync(h.claudeMd, 'utf-8').replace('## Who I Am', '## Who I Am (stale)') + tail;
    fs.writeFileSync(h.claudeMd, stale);
    const r = fresh();
    migrator(h).migrateClaudeMd(r);
    const now = fs.readFileSync(h.claudeMd, 'utf-8');
    expect(now).not.toContain('(stale)');
    expect(now.endsWith(tail)).toBe(true);
    expect(r.upgraded.some(u => u.includes('refreshed the instar block'))).toBe(true);
  });

  it('removes stale generated reference files but never a file without the header', () => {
    legacyFile(h);
    migrator(h).migrateClaudeMdReferenceLayout(fresh());
    fs.writeFileSync(path.join(h.refDir, 'retired-topic.md'), `${REFERENCE_FILE_HEADER}\n# old\n`);
    fs.writeFileSync(path.join(h.refDir, 'my-notes.md'), '# my notes\n');
    migrator(h).migrateClaudeMd(fresh());
    expect(fs.existsSync(path.join(h.refDir, 'retired-topic.md'))).toBe(false);
    expect(fs.existsSync(path.join(h.refDir, 'my-notes.md'))).toBe(true);
  });

  it('instar sections an older instar appended below the end marker are taken back out', () => {
    legacyFile(h);
    migrator(h).migrateClaudeMdReferenceLayout(fresh());
    const converted = fs.readFileSync(h.claudeMd, 'utf-8');
    // A rolled-back instar (or an older machine of a synced agent) runs its
    // legacy chain on the small file: whole instar sections land below the end marker.
    const tmpl = generateClaudeMd('tester', 'tester', 4042, false);
    // An older chain re-appends many sections at once.
    const start = tmpl.indexOf('### Web Content Fetching');
    const end = tmpl.indexOf('### Outbound Message Gate');
    expect(start).toBeGreaterThan(0);
    const legacyAppend = '\n' + tmpl.slice(start, end) + '\n## Mine\n\nkeep me\n';
    fs.writeFileSync(h.claudeMd, converted + legacyAppend);
    const r = fresh();
    migrator(h).migrateClaudeMd(r);
    const now = fs.readFileSync(h.claudeMd, 'utf-8');
    expect(now).toContain('keep me');
    expect(now).not.toContain('### Web Content Fetching');
    expect(r.upgraded.some(u => u.startsWith('REVIEW') && u.includes('below the instar block'))).toBe(true);
    expect(fs.existsSync(path.join(h.stateDir, 'CLAUDE.md.before-cleanup.md'))).toBe(true);
    // Stable afterwards.
    const r2 = fresh();
    migrator(h).migrateClaudeMd(r2);
    expect(fs.readFileSync(h.claudeMd, 'utf-8')).toBe(now);
  });

  it('an older instar append after the operator edited their notes is still cleaned', () => {
    legacyFile(h, '\n## Operator Notes\n\nOperator line one.\n');
    migrator(h).migrateClaudeMdReferenceLayout(fresh());
    const converted = fs.readFileSync(h.claudeMd, 'utf-8').replace('Operator line one.', 'Operator line one, edited.');
    const tmpl = generateClaudeMd('tester', 'tester', 4042, false);
    const legacyAppend = '\n' + tmpl.slice(tmpl.indexOf('### Web Content Fetching'), tmpl.indexOf('### Outbound Message Gate'));
    fs.writeFileSync(h.claudeMd, converted + legacyAppend);
    const r = fresh();
    migrator(h).migrateClaudeMd(r);
    const now = fs.readFileSync(h.claudeMd, 'utf-8');
    expect(now).toContain('Operator line one, edited.');
    expect(now).not.toContain('### Web Content Fetching');
    expect(r.upgraded.some(u => u.includes('below the instar block'))).toBe(true);
  });

  it('an operator copying an instar section below the block, or marking one instar:keep, keeps it', () => {
    legacyFile(h);
    migrator(h).migrateClaudeMdReferenceLayout(fresh());
    const converted = fs.readFileSync(h.claudeMd, 'utf-8');
    const tmpl = generateClaudeMd('tester', 'tester', 4042, false);
    const copy = tmpl.slice(tmpl.indexOf('### Web Content Fetching'), tmpl.indexOf('### Browser Automation'));
    fs.writeFileSync(h.claudeMd, converted + '\n' + copy);
    migrator(h).migrateClaudeMd(fresh());
    expect(fs.readFileSync(h.claudeMd, 'utf-8')).toContain('### Web Content Fetching');
    // Operator edits below the block change the recorded text: later runs leave it alone too.
    const edited = fs.readFileSync(h.claudeMd, 'utf-8') + '\n## Mine\n\nnote\n';
    fs.writeFileSync(h.claudeMd, edited);
    migrator(h).migrateClaudeMd(fresh());
    // Below the block is untouched; only the block's fingerprint line follows it.
    expect(fs.readFileSync(h.claudeMd, 'utf-8').endsWith(edited.slice(edited.indexOf(CLAUDE_MD_CORE_END) + CLAUDE_MD_CORE_END.length))).toBe(true);
    const settled = fs.readFileSync(h.claudeMd, 'utf-8');
    migrator(h).migrateClaudeMd(fresh());
    expect(fs.readFileSync(h.claudeMd, 'utf-8')).toBe(settled);
    // instar:keep protects a unit from the ownership rule.
    const kept = extractOperatorContent(copy.replace('\n\n', '\n\n<!-- instar:keep -->\n'), generateClaudeMd('tester', 'tester', 4042, false));
    expect(kept.kept).toContain('### Web Content Fetching');
  });

  it('lines of a moved instar section that differ from instar text are listed for review, with a pointer in CLAUDE.md', () => {
    // An instar section with one hand-added line: still ≥60% verbatim, so it moves.
    const tmpl = generateClaudeMd('tester', 'tester', 4042, false);
    const edited = tmpl.replace('### Browser Automation', 'MY HAND-ADDED RULE: always ask Bob first.\n\n### Browser Automation');
    expect(edited).not.toBe(tmpl);
    fs.writeFileSync(h.claudeMd, edited);
    const r = fresh();
    migrator(h).migrateClaudeMdReferenceLayout(r);
    const review = fs.readFileSync(path.join(h.projectDir, CLAUDE_MD_DIFFERING_LINES_REL), 'utf-8');
    expect(review).toContain('MY HAND-ADDED RULE: always ask Bob first.');
    expect(fs.readFileSync(h.claudeMd, 'utf-8')).toContain(CLAUDE_MD_DIFFERING_LINES_REL);
    expect(r.upgraded.some(u => u.includes(CLAUDE_MD_DIFFERING_LINES_REL))).toBe(true);
  });

  it('claudeMd.layout "full": no conversion before; whole document inside the markers after', () => {
    const legacy = legacyFile(h);
    fs.writeFileSync(path.join(h.stateDir, 'config.json'), JSON.stringify({ claudeMd: { layout: 'full' } }));
    const r = fresh();
    migrator(h).migrateClaudeMdReferenceLayout(r);
    expect(fs.readFileSync(h.claudeMd, 'utf-8')).toBe(legacy);
    expect(r.skipped.some(s => s.includes('"full"'))).toBe(true);

    fs.writeFileSync(path.join(h.stateDir, 'config.json'), '{}');
    migrator(h).migrateClaudeMdReferenceLayout(fresh());
    fs.writeFileSync(path.join(h.stateDir, 'config.json'), JSON.stringify({ claudeMd: { layout: 'full' } }));
    migrator(h).migrateClaudeMd(fresh());
    const now = fs.readFileSync(h.claudeMd, 'utf-8');
    expect(now.length).toBeGreaterThan(150_000);
    expect(findCoreRegion(now)).not.toBeNull();
  });

  it('a half marker pair is left alone and reported', () => {
    const text = `${CLAUDE_MD_CORE_START}\n# my file\n`;
    fs.writeFileSync(h.claudeMd, text);
    const r = fresh();
    const m = migrator(h);
    m.migrateClaudeMd(r);
    m.migrateClaudeMdReferenceLayout(r);
    expect(fs.readFileSync(h.claudeMd, 'utf-8')).toBe(text);
    expect(r.upgraded.some(u => u.startsWith('REVIEW') && u.includes('core markers'))).toBe(true);
  });

  it('freshInit writes the layout with no kept text and no backup', () => {
    fs.writeFileSync(path.join(h.stateDir, 'AGENT.md'), '# Tessa\n\n## Who I Am\n');
    fs.writeFileSync(h.claudeMd, generateClaudeMd('tester', 'tester', 4042, false));
    const r = fresh();
    migrator(h).migrateClaudeMdReferenceLayout(r, { freshInit: true });
    const now = fs.readFileSync(h.claudeMd, 'utf-8');
    expect(now.trimEnd().endsWith(CLAUDE_MD_CORE_END)).toBe(true);
    expect(now).toContain('I am Tessa,');
    expect(fs.existsSync(path.join(h.projectDir, CLAUDE_MD_LEGACY_BACKUP_REL))).toBe(false);
  });

  it('context-death step skips CLAUDE.md with markers (the canonical document carries the block)', () => {
    legacyFile(h);
    migrator(h).migrateClaudeMdReferenceLayout(fresh());
    const before = fs.readFileSync(h.claudeMd, 'utf-8');
    const r = fresh();
    (migrator(h) as unknown as { migrateContextDeathAntiPattern(r: Result): void }).migrateContextDeathAntiPattern(r);
    expect(fs.readFileSync(h.claudeMd, 'utf-8')).toBe(before);
    const all = fs.readdirSync(h.refDir).map(f => fs.readFileSync(path.join(h.refDir, f), 'utf-8')).join('\n') + before;
    expect(all).toContain('INSTAR:ANTI-PATTERN-CONTEXT-DEATH');
  });
});
