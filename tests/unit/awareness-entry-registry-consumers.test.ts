/**
 * Awareness entry registry, the consumers (docs/specs/awareness-entry-registry.md 3.4):
 * generateClaudeMd, patchClaudeMdContent, buildCanonicalClaudeMd, the Codex/Gemini
 * mirror and the legacy-to-reference conversion. Each takes the registry as an
 * optional parameter that defaults to the real one, so these tests pass fixtures.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import {
  CLAUDE_MD_DIFFERING_LINES_REL,
  CLAUDE_MD_LEGACY_BACKUP_REL,
  REFERENCE_DIR_REL,
  findCoreRegion,
  normaliseTitle,
  parseAwarenessUnits,
  renderCoreRegion,
  renderReferenceFiles,
  splitAwareness,
} from '../../src/scaffold/claudeMdLayout.js';
import {
  AWARENESS_REGISTRY_END,
  AWARENESS_REGISTRY_START,
  createRegistry,
  defaultRegistry,
  emptyRegistry,
  findRegistryBlock,
  unreportedRegistryDegradations,
  type AwarenessRegistry,
} from '../../src/awareness/registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
type Result = { upgraded: string[]; skipped: string[]; errors: string[] };
const fresh = (): Result => ({ upgraded: [], skipped: [], errors: [] });
const entry = (title: string, body: string, extra = ''): string => `---\ntitle: ${title}\n${extra}---\n${body}\n`;
const count = (text: string, needle: string): number => text.split(needle).length - 1;
const trimEnd = (t: string): string => t.replace(/\n+$/, '');

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-consumers-')); });
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/awareness-entry-registry-consumers.test.ts' });
});

function registryOf(files: Record<string, string>): AwarenessRegistry {
  const dir = fs.mkdtempSync(path.join(tmp, 'entries-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return createRegistry(pathToFileURL(dir + path.sep));
}

const FIXTURE = {
  'held-replies.md': entry('Zylophone fixture note', 'A fixture reply is delivered late. Check `curl http://localhost:{{port}}/fixture/held`.'),
  'tg-fixture.md': entry('Quokka fixture note', 'Only for agents with a phone channel.', 'requires: telegram\n'),
};

function makeHome() {
  const projectDir = fs.mkdtempSync(path.join(tmp, 'agent-'));
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return { projectDir, stateDir, claudeMd: path.join(projectDir, 'CLAUDE.md'), agentsMd: path.join(projectDir, 'AGENTS.md'), refDir: path.join(projectDir, REFERENCE_DIR_REL) };
}
type Home = ReturnType<typeof makeHome>;

function migrator(h: Home, awarenessRegistry?: AwarenessRegistry, hasTelegram = false): PostUpdateMigrator {
  return new PostUpdateMigrator({ projectDir: h.projectDir, stateDir: h.stateDir, port: 4042, hasTelegram, projectName: 'tester', awarenessRegistry });
}

function run(m: PostUpdateMigrator, method: 'migrateClaudeMd' | 'migrateFrameworkShadowCapabilities'): Result {
  const r = fresh();
  (m as unknown as Record<string, (r: Result) => void>)[method](r);
  return r;
}

const read = (p: string): string => fs.readFileSync(p, 'utf-8');

describe('with no entries nothing changes: the default path against the empty-registry path', () => {
  const ctx = { port: 4042, hasTelegram: true };

  it('generateClaudeMd: the default registry adds exactly its own block and nothing else (byte-identical when the folder has no entry)', () => {
    for (const hasTelegram of [true, false]) {
      const bare = generateClaudeMd('tester', 'tester', 4042, hasTelegram, false, false, emptyRegistry());
      const real = generateClaudeMd('tester', 'tester', 4042, hasTelegram);
      expect(bare).not.toContain('instar:awareness-registry');
      expect(bare).not.toContain('## Feature notes');
      expect(real).toBe(defaultRegistry().withRegistry(bare, { port: 4042, hasTelegram }, { markers: true }).content);
      if (defaultRegistry().eligibleEntries({ port: 4042, hasTelegram }).length === 0) expect(real).toBe(bare);
    }
  });

  it('buildCanonicalClaudeMd: default = the empty-registry build + the bare section; { registry: false } = the empty-registry build', () => {
    const h = makeHome();
    const viaEmpty = migrator(h, emptyRegistry(), true).buildCanonicalClaudeMd();
    const real = migrator(h, undefined, true);
    const canonical = real.buildCanonicalClaudeMd();
    expect(real.buildCanonicalClaudeMd({ registry: false })).toBe(viaEmpty);
    expect(canonical).toBe(defaultRegistry().withRegistry(viaEmpty, ctx, { markers: false }).content);
    if (defaultRegistry().eligibleEntries(ctx).length === 0) expect(canonical).toBe(viaEmpty);
    expect(viaEmpty).not.toContain('instar:awareness-registry');
    // Regression check (spec 3.5): no real entry's title is the title of an existing unit.
    const taken = new Set(parseAwarenessUnits(viaEmpty).map(u => u.title));
    taken.add('feature notes');
    for (const e of defaultRegistry().eligibleEntries(ctx)) expect(taken.has(normaliseTitle(e.title)), e.id).toBe(false);
  });

  it('a legacy CLAUDE.md and a Codex copy are written the same with the default registry as with an empty one when the folder has no entry', () => {
    const a = makeHome();
    const b = makeHome();
    for (const h of [a, b]) {
      fs.writeFileSync(h.claudeMd, generateClaudeMd('tester', 'tester', 4042, false, false, false, emptyRegistry()) + '\n## Shop Rules\n\nNever ship on Fridays.\n');
      fs.writeFileSync(h.agentsMd, '# AGENTS.md — tester\n\nCodex shadow.\n');
    }
    const ma = migrator(a);
    run(ma, 'migrateClaudeMd');
    run(ma, 'migrateFrameworkShadowCapabilities');
    const mb = migrator(b, emptyRegistry());
    run(mb, 'migrateClaudeMd');
    run(mb, 'migrateFrameworkShadowCapabilities');
    const none = defaultRegistry().eligibleEntries({ port: 4042, hasTelegram: false }).length === 0;
    expect(read(a.claudeMd) === read(b.claudeMd)).toBe(none);
    expect(read(a.agentsMd) === read(b.agentsMd)).toBe(none);
    expect(read(b.claudeMd)).not.toContain('instar:awareness-registry');
    expect(read(b.agentsMd)).not.toContain('instar:awareness-registry');
  });
});

describe('generateClaudeMd and patchClaudeMdContent with a fixture entry', () => {
  it('generateClaudeMd holds the entry exactly once, in a marked block at the very end', () => {
    const reg = registryOf(FIXTURE);
    const doc = generateClaudeMd('tester', 'tester', 4042, false, false, false, reg);
    expect(count(doc, '**Zylophone fixture note** — A fixture reply is delivered late.')).toBe(1);
    expect(doc).toContain('http://localhost:4042/fixture/held');
    expect(doc).not.toContain('Quokka fixture note');
    expect(doc.endsWith(`${AWARENESS_REGISTRY_END}\n`)).toBe(true);
    expect(findRegistryBlock(doc).state).toBe('well-formed');
    expect(generateClaudeMd('tester', 'tester', 4042, true, false, false, reg)).toContain('**Quokka fixture note** — Only for agents with a phone channel.');
    expect(reg.withRegistry(doc, { port: 4042, hasTelegram: false }, { markers: true }).changed).toBe(false);
  });

  it('a legacy CLAUDE.md gets the block once; a second pass changes nothing; an edited body replaces the old text', () => {
    const h = makeHome();
    fs.writeFileSync(h.claudeMd, generateClaudeMd('tester', 'tester', 4042, false, false, false, emptyRegistry()) + '\n## Shop Rules\n\nNever ship on Fridays.\n');
    const reg = registryOf(FIXTURE);
    const first = run(migrator(h, reg), 'migrateClaudeMd');
    expect(first.errors).toEqual([]);
    expect(first.upgraded).toContain('CLAUDE.md: feature notes updated');
    const after = read(h.claudeMd);
    expect(findCoreRegion(after)).toBeNull();
    expect(count(after, AWARENESS_REGISTRY_START)).toBe(1);
    expect(count(after, '**Zylophone fixture note** — ')).toBe(1);
    expect(after.endsWith(`${AWARENESS_REGISTRY_END}\n`)).toBe(true);
    expect(after).toContain('Never ship on Fridays.');

    const second = run(migrator(h, reg), 'migrateClaudeMd');
    expect(second.upgraded).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(read(h.claudeMd)).toBe(after);

    const edited = registryOf({ 'held-replies.md': entry('Zylophone fixture note', 'Reworded fixture text.') });
    const third = run(migrator(h, edited), 'migrateClaudeMd');
    expect(third.upgraded).toEqual(['CLAUDE.md: feature notes updated']);
    const reworded = read(h.claudeMd);
    expect(reworded).toContain('**Zylophone fixture note** — Reworded fixture text.');
    expect(reworded).not.toContain('A fixture reply is delivered late.');
    expect(count(reworded, AWARENESS_REGISTRY_START)).toBe(1);

    const removed = run(migrator(h, emptyRegistry()), 'migrateClaudeMd');
    expect(removed.upgraded).toEqual(['CLAUDE.md: feature notes updated']);
    expect(read(h.claudeMd)).not.toContain('instar:awareness-registry');
    expect(read(h.claudeMd)).not.toContain('Zylophone');
  });

  it('a legacy CLAUDE.md with damaged markers is left exactly as it is and reported, on every pass', () => {
    const h = makeHome();
    const reg = registryOf(FIXTURE);
    fs.writeFileSync(h.claudeMd, generateClaudeMd('tester', 'tester', 4042, false, false, false, emptyRegistry()));
    run(migrator(h, reg), 'migrateClaudeMd');
    const damaged = `${read(h.claudeMd)}${AWARENESS_REGISTRY_START}\nstray text\n`;
    fs.writeFileSync(h.claudeMd, damaged);
    for (let pass = 0; pass < 2; pass++) {
      const r = run(migrator(h, registryOf({ 'held-replies.md': entry('Zylophone fixture note', 'Reworded fixture text.') })), 'migrateClaudeMd');
      expect(r.errors.filter(e => /feature-notes marker lines are damaged/.test(e))).toHaveLength(1);
      expect(r.upgraded).toEqual([]);
      expect(read(h.claudeMd)).toBe(damaged);
    }
  });
});

describe('entry text never takes part in the legacy chain\'s "already there?" guards', () => {
  // The body quotes strings the legacy chain sniffs for before it adds a section.
  const QUOTING = { 'quoter.md': entry('Zylophone fixture note', 'This note quotes `/corrections`, `INSTAR_JOB_FAILURE_FILE` and `## PR links ask for the review on GitHub too`.') };
  const TINY = '# CLAUDE.md — tester\n\n## Shop Rules\n\nNever ship on Fridays.\n';

  for (const hasTelegram of [true, false]) {
    it(`a legacy file that already holds the block gets every legacy section (hasTelegram ${hasTelegram})`, () => {
      const quoting = registryOf(QUOTING);
      const plain = makeHome();
      fs.writeFileSync(plain.claudeMd, TINY);
      run(migrator(plain, emptyRegistry(), hasTelegram), 'migrateClaudeMd');
      const expected = read(plain.claudeMd);
      expect(expected).toContain('/corrections');
      expect(expected).toContain('## PR links ask for the review on GitHub too');

      const h = makeHome();
      fs.writeFileSync(h.claudeMd, quoting.withRegistry(TINY, { port: 4042, hasTelegram }, { markers: true }).content);
      const first = run(migrator(h, quoting, hasTelegram), 'migrateClaudeMd');
      expect(first.errors).toEqual([]);
      // The block text is unchanged, so no "feature notes updated" note; the legacy notes are there.
      expect(first.upgraded).not.toContain('CLAUDE.md: feature notes updated');
      expect(first.upgraded.length).toBeGreaterThan(5);
      const after = read(h.claudeMd);
      expect(quoting.withRegistry(expected, { port: 4042, hasTelegram }, { markers: true }).content).toBe(after);
      expect(count(after, '## PR links ask for the review on GitHub too')).toBe(count(expected, '## PR links ask for the review on GitHub too') + 1);
      const second = run(migrator(h, quoting, hasTelegram), 'migrateClaudeMd');
      expect(second.upgraded).toEqual([]);
      expect(read(h.claudeMd)).toBe(after);
    });

    it(`the canonical document is the empty-registry build plus the section (hasTelegram ${hasTelegram})`, () => {
      const quoting = registryOf(QUOTING);
      const h = makeHome();
      const m = migrator(h, quoting, hasTelegram);
      const bare = migrator(h, emptyRegistry(), hasTelegram).buildCanonicalClaudeMd();
      expect(bare).toContain('/corrections');
      expect(m.buildCanonicalClaudeMd()).toBe(quoting.withRegistry(bare, { port: 4042, hasTelegram }, { markers: false }).content);
      expect(m.buildCanonicalClaudeMd({ registry: false })).toBe(bare);
    });
  }

  it('with no eligible entry, { registry: false } is the normal build (one build, not two)', () => {
    const h = makeHome();
    const m = migrator(h, registryOf({ 'tg-fixture.md': FIXTURE['tg-fixture.md'] }), false);
    expect(m.buildCanonicalClaudeMd({ registry: false })).toBe(m.buildCanonicalClaudeMd());
  });
});

describe('buildCanonicalClaudeMd with a fixture entry', () => {
  it('holds no marker line and ENDS with the section (guard on "last step"); { registry: false } holds no entry', () => {
    const h = makeHome();
    const reg = registryOf(FIXTURE);
    const m = migrator(h, reg, true);
    const canonical = m.buildCanonicalClaudeMd();
    const section = reg.renderSection({ port: 4042, hasTelegram: true });
    expect(section).toContain('**Quokka fixture note** — ');
    expect(canonical).not.toContain('instar:awareness-registry');
    expect(canonical.endsWith(`\n\n${section}`)).toBe(true);
    expect(count(canonical, '## Feature notes')).toBe(1);
    expect(count(canonical, '**Zylophone fixture note** — ')).toBe(1);
    const bare = m.buildCanonicalClaudeMd({ registry: false });
    expect(bare).not.toContain('Zylophone');
    expect(bare).not.toContain('## Feature notes');
    expect(bare).toBe(migrator(h, emptyRegistry(), true).buildCanonicalClaudeMd());
    // Both are cached separately: asking again returns each one unchanged.
    expect(m.buildCanonicalClaudeMd()).toBe(canonical);
    expect(m.buildCanonicalClaudeMd({ registry: false })).toBe(bare);
  });

  it('no entry lands in the core; every earlier unit keeps its text and its file; the entry is in one reference file and named in the core list', () => {
    const h = makeHome();
    const m = migrator(h, registryOf(FIXTURE), true);
    const without = splitAwareness(m.buildCanonicalClaudeMd({ registry: false }));
    const withEntries = splitAwareness(m.buildCanonicalClaudeMd());
    expect(withEntries.preamble).toBe(without.preamble);
    expect(trimEnd(withEntries.coreBody)).toBe(trimEnd(without.coreBody));
    expect(withEntries.coreBody).not.toContain('Zylophone');
    expect(withEntries.nestedOutsideCore).toEqual(without.nestedOutsideCore);
    expect([...withEntries.referenceBodies.keys()].sort()).toEqual([...without.referenceBodies.keys()].sort());
    for (const [file, body] of without.referenceBodies) {
      expect(withEntries.referenceBodies.get(file)!.startsWith(trimEnd(body)), file).toBe(true);
      const titles = withEntries.referenceTitles.get(file)!;
      expect(titles.slice(0, without.referenceTitles.get(file)!.length), file).toEqual(without.referenceTitles.get(file));
    }
    const files = renderReferenceFiles(m.buildCanonicalClaudeMd());
    const holding = [...files].filter(([name, text]) => name !== 'INDEX.md' && text.includes('**Zylophone fixture note** — A fixture reply is delivered late.'));
    expect(holding).toHaveLength(1);
    expect(files.get('INDEX.md')).toContain('Zylophone fixture note');
    const core = renderCoreRegion(m.buildCanonicalClaudeMd());
    expect(core).toContain('Zylophone fixture note');
    expect(core).toContain('Feature notes');
    expect(core).not.toContain('A fixture reply is delivered late.');
  });
});

describe('the Codex/Gemini mirror', () => {
  const SHADOW = '# AGENTS.md — tester\n\nCodex shadow.\n';

  function convertedHome(reg: AwarenessRegistry): Home {
    const h = makeHome();
    fs.writeFileSync(h.claudeMd, generateClaudeMd('tester', 'tester', 4042, false, false, false, emptyRegistry()));
    const m = migrator(h, reg);
    run(m, 'migrateClaudeMd');
    m.migrateClaudeMdReferenceLayout(fresh());
    expect(findCoreRegion(read(h.claudeMd))).not.toBeNull();
    return h;
  }

  it('canonical source (agent with core markers): the copy holds one start line and the block once; a second pass changes nothing', () => {
    const reg = registryOf(FIXTURE);
    const h = convertedHome(reg);
    fs.writeFileSync(h.agentsMd, SHADOW);
    const first = run(migrator(h, reg), 'migrateFrameworkShadowCapabilities');
    expect(first.errors).toEqual([]);
    const copy = read(h.agentsMd);
    expect(count(copy, AWARENESS_REGISTRY_START)).toBe(1);
    expect(count(copy, AWARENESS_REGISTRY_END)).toBe(1);
    expect(count(copy, '**Zylophone fixture note** — ')).toBe(1);
    expect(count(copy, '## Feature notes')).toBe(1);
    expect(copy.endsWith(`${AWARENESS_REGISTRY_END}\n`)).toBe(true);
    expect(copy).not.toContain('Quokka fixture note');
    expect(copy).toContain('### Quota-enforcement scheduler pause');

    const second = run(migrator(h, reg), 'migrateFrameworkShadowCapabilities');
    expect(second.upgraded).toEqual([]);
    expect(read(h.agentsMd)).toBe(copy);
  });

  it('an entry requiring Telegram reaches the copy only when the agent has Telegram', () => {
    const reg = registryOf(FIXTURE);
    const h = convertedHome(reg);
    fs.writeFileSync(h.agentsMd, SHADOW);
    run(migrator(h, reg, true), 'migrateFrameworkShadowCapabilities');
    expect(count(read(h.agentsMd), '**Quokka fixture note** — ')).toBe(1);
    run(migrator(h, reg, false), 'migrateFrameworkShadowCapabilities');
    expect(read(h.agentsMd)).not.toContain('Quokka fixture note');
    expect(count(read(h.agentsMd), AWARENESS_REGISTRY_START)).toBe(1);
  });

  it('on-disk source without core markers, last mirrored section directly before the block: no marker or note text rides along in the slice', () => {
    const reg = registryOf(FIXTURE);
    const h = makeHome();
    const base = '# CLAUDE.md — tester\n\n## Disk Steward\n\nSteward text line.\nSecond steward line.\n';
    fs.writeFileSync(h.claudeMd, reg.withRegistry(base, { port: 4042, hasTelegram: false }, { markers: true }).content);
    fs.writeFileSync(h.agentsMd, SHADOW);
    const first = run(migrator(h, reg), 'migrateFrameworkShadowCapabilities');
    expect(first.errors).toEqual([]);
    const copy = read(h.agentsMd);
    expect(copy).toBe(`${SHADOW}\n## Disk Steward\n\nSteward text line.\nSecond steward line.\n\n${AWARENESS_REGISTRY_START}\n${reg.renderSection({ port: 4042, hasTelegram: false })}${AWARENESS_REGISTRY_END}\n`);
    const second = run(migrator(h, reg), 'migrateFrameworkShadowCapabilities');
    expect(second.upgraded).toEqual([]);
    expect(read(h.agentsMd)).toBe(copy);
  });

  it('on-disk source with a damaged block: the slice stops at the marker line', () => {
    const reg = registryOf(FIXTURE);
    const h = makeHome();
    fs.writeFileSync(h.claudeMd, `# CLAUDE.md — tester\n\n## Disk Steward\n\nSteward text line.\n${AWARENESS_REGISTRY_START}\nstray registry text with no heading\n`);
    fs.writeFileSync(h.agentsMd, SHADOW);
    run(migrator(h, reg), 'migrateFrameworkShadowCapabilities');
    const copy = read(h.agentsMd);
    expect(copy).toContain('## Disk Steward\n\nSteward text line.\n');
    expect(copy).not.toContain('stray registry text');
    expect(count(copy, AWARENESS_REGISTRY_START)).toBe(1);
    expect(findRegistryBlock(copy).state).toBe('well-formed');
  });

  it('an entry that quotes a legacy marker neither produces a slice nor stops that section being mirrored into a copy that lacks it', () => {
    const quoting = registryOf({ 'quoter.md': entry('Zylophone fixture note', 'This note mentions the `## Disk Steward` section by name.') });
    const h = makeHome();
    const ctx = { port: 4042, hasTelegram: false };
    // The source has no Disk Steward section yet: the quoted marker must not be sliced out of the note.
    fs.writeFileSync(h.claudeMd, quoting.withRegistry('# CLAUDE.md — tester\n\n## Other\n\nOther text.\n', ctx, { markers: true }).content);
    fs.writeFileSync(h.agentsMd, SHADOW);
    run(migrator(h, quoting), 'migrateFrameworkShadowCapabilities');
    const noteOnly = read(h.agentsMd);
    expect(count(noteOnly, '## Disk Steward')).toBe(1); // only the quote inside the note
    expect(noteOnly).toBe(`${SHADOW}\n${AWARENESS_REGISTRY_START}\n${quoting.renderSection(ctx)}${AWARENESS_REGISTRY_END}\n`);
    // Now the source gains the real section; the copy's block already quotes its marker.
    fs.writeFileSync(h.claudeMd, quoting.withRegistry('# CLAUDE.md — tester\n\n## Disk Steward\n\nSteward text line.\n', ctx, { markers: true }).content);
    const r = run(migrator(h, quoting), 'migrateFrameworkShadowCapabilities');
    expect(r.upgraded.some(u => u.startsWith('AGENTS.md: mirrored 1 capability section(s)'))).toBe(true);
    const copy = read(h.agentsMd);
    expect(copy).toBe(`${SHADOW}\n## Disk Steward\n\nSteward text line.\n\n${AWARENESS_REGISTRY_START}\n${quoting.renderSection(ctx)}${AWARENESS_REGISTRY_END}\n`);
  });

  it('a copy whose own block is damaged: the registry does nothing to it and the mirror reports it; the older sections are still mirrored', () => {
    const reg = registryOf(FIXTURE);
    const h = makeHome();
    fs.writeFileSync(h.claudeMd, '# CLAUDE.md — tester\n\n## Disk Steward\n\nSteward text line.\n');
    const damaged = `${SHADOW}\n${AWARENESS_REGISTRY_START}\nold note text\n`;
    fs.writeFileSync(h.agentsMd, damaged);
    for (let pass = 0; pass < 2; pass++) {
      const r = run(migrator(h, reg), 'migrateFrameworkShadowCapabilities');
      expect(r.errors.filter(e => /^AGENTS\.md: the feature-notes marker lines are damaged/.test(e))).toHaveLength(1);
      const copy = read(h.agentsMd);
      expect(copy.startsWith(damaged.trimEnd())).toBe(true);
      expect(count(copy, AWARENESS_REGISTRY_START)).toBe(1);
      expect(copy).not.toContain('Zylophone');
      expect(count(copy, '## Disk Steward\n\nSteward text line.')).toBe(1);
    }
  });

  it('a CRLF copy is written back in CRLF and a second pass changes nothing; the count compares against the original copy', () => {
    const reg = registryOf(FIXTURE);
    const h = makeHome();
    fs.writeFileSync(h.claudeMd, '# CLAUDE.md — tester\n\n## Other\n\nOther text.\n');
    fs.writeFileSync(h.agentsMd, SHADOW.replace(/\n/g, '\r\n'));
    const first = run(migrator(h, reg), 'migrateFrameworkShadowCapabilities');
    expect(first.upgraded).toEqual(['AGENTS.md: mirrored 1 capability section(s) from CLAUDE.md']);
    const copy = read(h.agentsMd);
    expect(copy).not.toMatch(/[^\r]\n/);
    expect(count(copy, AWARENESS_REGISTRY_START)).toBe(1);
    const second = run(migrator(h, reg), 'migrateFrameworkShadowCapabilities');
    expect(second.upgraded).toEqual([]);
    expect(second.skipped).toContain('AGENTS.md: capability sections already present');
    expect(read(h.agentsMd)).toBe(copy);
    // A removed entry set takes the block out of the copy again, once.
    const third = run(migrator(h, emptyRegistry()), 'migrateFrameworkShadowCapabilities');
    expect(third.upgraded).toEqual(['AGENTS.md: mirrored 1 capability section(s) from CLAUDE.md']);
    expect(read(h.agentsMd)).toBe(SHADOW.replace(/\n/g, '\r\n'));
  });
});

describe('broken means the registry changes nothing, from the caller\'s side too', () => {
  const OLD_BLOCK = `${AWARENESS_REGISTRY_START}\n## Feature notes\n\n**Zylophone fixture note** — the wording an older version wrote.\n${AWARENESS_REGISTRY_END}\n`;
  // A ten-tilde fence: nothing the legacy chain appends can close it by accident.
  const OPEN_FENCE = '\n## Operator notes\n\n~~~~~~~~~~\nthis code block is never closed\n';

  it('legacy CLAUDE.md: a block followed by an unclosed fence keeps its original bytes; the legacy patches still apply; reported; stable', () => {
    const h = makeHome();
    const input = `# CLAUDE.md — tester\n\n## Shop Rules\n\nNever ship on Fridays.\n\n${OLD_BLOCK}${OPEN_FENCE}`;
    fs.writeFileSync(h.claudeMd, input);
    const reg = registryOf(FIXTURE);
    const first = run(migrator(h, reg), 'migrateClaudeMd');
    expect(first.errors.filter(e => /^CLAUDE\.md: a code block in the file is never closed/.test(e))).toHaveLength(1);
    expect(first.upgraded).not.toContain('CLAUDE.md: feature notes updated');
    expect(first.upgraded.length).toBeGreaterThan(5);
    const after = read(h.claudeMd);
    expect(count(after, OLD_BLOCK)).toBe(1);
    expect(count(after, AWARENESS_REGISTRY_START)).toBe(1);
    expect(after.startsWith(input)).toBe(true);
    expect(after).not.toContain('awareness-registry-held');
    expect(after).not.toContain('A fixture reply is delivered late.');
    expect(after).toContain('## PR links ask for the review on GitHub too');
    const second = run(migrator(h, reg), 'migrateClaudeMd');
    expect(second.errors.filter(e => /never closed/.test(e))).toHaveLength(1);
    expect(second.upgraded).toEqual([]);
    expect(read(h.claudeMd)).toBe(after);
  });

  it('Codex copy: a block followed by an unclosed fence keeps its original bytes; the older section is still mirrored; reported; stable', () => {
    const h = makeHome();
    fs.writeFileSync(h.claudeMd, '# CLAUDE.md — tester\n\n## Disk Steward\n\nSteward text line.\n');
    const copyBefore = `# AGENTS.md — tester\n\nCodex shadow.\n\n${OLD_BLOCK}${OPEN_FENCE}`;
    fs.writeFileSync(h.agentsMd, copyBefore);
    const reg = registryOf(FIXTURE);
    const first = run(migrator(h, reg), 'migrateFrameworkShadowCapabilities');
    expect(first.errors.filter(e => /^AGENTS\.md: a code block in the file is never closed/.test(e))).toHaveLength(1);
    expect(first.upgraded).toEqual(['AGENTS.md: mirrored 1 capability section(s) from CLAUDE.md']);
    const copy = read(h.agentsMd);
    expect(copy.startsWith(copyBefore.trimEnd())).toBe(true);
    expect(count(copy, OLD_BLOCK)).toBe(1);
    expect(count(copy, AWARENESS_REGISTRY_START)).toBe(1);
    expect(copy).not.toContain('awareness-registry-held');
    expect(copy).not.toContain('A fixture reply is delivered late.');
    expect(count(copy, '## Disk Steward\n\nSteward text line.')).toBe(1);
    const second = run(migrator(h, reg), 'migrateFrameworkShadowCapabilities');
    expect(second.errors.filter(e => /never closed/.test(e))).toHaveLength(1);
    expect(second.upgraded).toEqual([]);
    expect(read(h.agentsMd)).toBe(copy);
  });

  it('Codex copy with no block that ends in an open fence: unchanged by the registry, and reported', () => {
    const h = makeHome();
    fs.writeFileSync(h.claudeMd, '# CLAUDE.md — tester\n\n## Other\n\nOther text.\n');
    const copyBefore = `# AGENTS.md — tester\n\nCodex shadow.\n${OPEN_FENCE}`;
    fs.writeFileSync(h.agentsMd, copyBefore);
    for (let pass = 0; pass < 2; pass++) {
      const r = run(migrator(h, registryOf(FIXTURE)), 'migrateFrameworkShadowCapabilities');
      expect(r.errors.filter(e => /^AGENTS\.md: a code block in the file is never closed/.test(e))).toHaveLength(1);
      expect(r.upgraded).toEqual([]);
      expect(read(h.agentsMd)).toBe(copyBefore);
    }
    // With no entry to write there is nothing to report and nothing changes.
    const quiet = run(migrator(h, emptyRegistry()), 'migrateFrameworkShadowCapabilities');
    expect(quiet.errors).toEqual([]);
    expect(read(h.agentsMd)).toBe(copyBefore);
  });
});

describe('legacy-to-reference conversion', () => {
  it('a legacy file whose block was written by an older, different entry set converts with no kept unit and no differing-lines entry', () => {
    const h = makeHome();
    fs.writeFileSync(h.claudeMd, generateClaudeMd('tester', 'tester', 4042, false, false, false, emptyRegistry()));
    const older = registryOf({
      'held-replies.md': entry('Zylophone fixture note', 'Older wording of the fixture note.\nWith a second older line.\nAnd a third older line.'),
      'retired.md': entry('Retired fixture note', 'This entry was deleted in the newer version.\nIt had several lines.\nNone of them is current.'),
    });
    run(migrator(h, older), 'migrateClaudeMd');
    const legacy = read(h.claudeMd);
    expect(legacy).toContain('Retired fixture note');

    const newer = registryOf(FIXTURE);
    const r = fresh();
    migrator(h, newer).migrateClaudeMdReferenceLayout(r);
    expect(r.errors).toEqual([]);
    expect(r.upgraded.filter(u => u.startsWith('REVIEW'))).toEqual([]);
    expect(fs.existsSync(path.join(h.projectDir, CLAUDE_MD_DIFFERING_LINES_REL))).toBe(false);
    const now = read(h.claudeMd);
    expect(findCoreRegion(now)).not.toBeNull();
    expect(now).not.toContain('instar:awareness-registry');
    expect(now).not.toContain('Retired fixture note');
    expect(now).not.toContain('Older wording');
    // The backup keeps the true original, block included.
    expect(read(path.join(h.projectDir, CLAUDE_MD_LEGACY_BACKUP_REL))).toBe(legacy);
    const allRef = fs.readdirSync(h.refDir).map(f => read(path.join(h.refDir, f))).join('\n');
    expect(allRef).toContain('**Zylophone fixture note** — A fixture reply is delivered late.');
    expect(allRef).not.toContain('Retired fixture note');
    expect(allRef).not.toContain('instar:awareness-registry');
  });

  it('a damaged block cannot be removed by its markers: it goes through the ordinary comparison and the conversion says so', () => {
    const h = makeHome();
    fs.writeFileSync(h.claudeMd, `${generateClaudeMd('tester', 'tester', 4042, false, false, false, emptyRegistry())}\n${AWARENESS_REGISTRY_START}\n## Feature notes\n\n**Orphan fixture note** — text nobody owns now.\n`);
    const r = fresh();
    migrator(h, registryOf(FIXTURE)).migrateClaudeMdReferenceLayout(r);
    expect(r.upgraded.filter(u => /damaged feature-notes marker lines/.test(u))).toHaveLength(1);
    expect(read(h.claudeMd)).toContain('Orphan fixture note');
  });
});

describe('reporting an entry that failed its checks', () => {
  const BAD = { 'bad.md': entry('Bad', 'Uses {{nope}}.'), 'good.md': entry('Zylophone fixture note', 'Fine.') };

  it('the migrator adds each row to result.errors once per process; the valid entry is still written', () => {
    const h = makeHome();
    fs.writeFileSync(h.claudeMd, generateClaudeMd('tester', 'tester', 4042, false, false, false, emptyRegistry()));
    const reg = registryOf(BAD);
    const first = run(migrator(h, reg), 'migrateClaudeMd');
    expect(first.errors).toEqual([expect.stringMatching(/^awareness\.entry-registry: bad: unknown placeholder "\{\{nope\}\}"/)]);
    expect(read(h.claudeMd)).toContain('**Zylophone fixture note** — Fine.');
    expect(run(migrator(h, reg), 'migrateClaudeMd').errors).toEqual([]);
    expect(run(migrator(h, reg), 'migrateFrameworkShadowCapabilities').errors).toEqual([]);
  });

  it('the mirror reports it when it is the first to render', () => {
    const h = makeHome();
    fs.writeFileSync(h.claudeMd, '# CLAUDE.md — tester\n');
    fs.writeFileSync(h.agentsMd, '# AGENTS.md — tester\n');
    const r = run(migrator(h, registryOf(BAD)), 'migrateFrameworkShadowCapabilities');
    expect(r.errors).toEqual([expect.stringMatching(/^awareness\.entry-registry: bad: /)]);
  });

  it('the degradation reporter receives each row once per process, under feature awareness.entry-registry', () => {
    DegradationReporter.resetForTesting();
    try {
      const reporter = DegradationReporter.getInstance();
      const reg = registryOf(BAD);
      for (let start = 0; start < 2; start++) {
        for (const event of unreportedRegistryDegradations(reg)) reporter.report(event);
      }
      const events = reporter.getEvents().filter(e => e.feature === 'awareness.entry-registry');
      expect(events).toHaveLength(1);
      expect(events[0].reason).toMatch(/^bad: unknown placeholder/);
    } finally {
      DegradationReporter.resetForTesting();
    }
  });

  it('server start reports the real registry through the degradation reporter (wiring)', () => {
    const server = fs.readFileSync(path.join(ROOT, 'src', 'commands', 'server.ts'), 'utf-8');
    expect(server).toContain("import { unreportedRegistryDegradations } from '../awareness/registry.js';");
    const configure = server.indexOf('degradationReporter.configure({');
    const call = server.indexOf('for (const event of unreportedRegistryDegradations()) degradationReporter.report(event);');
    expect(configure).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(configure);
    expect(call - configure).toBeLessThan(600);
    // With the real folder free of errors, the call reports nothing.
    expect(defaultRegistry().errors()).toEqual([]);
  });
});
