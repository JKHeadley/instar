/**
 * Awareness entry registry (docs/specs/awareness-entry-registry.md): entries are
 * data files in src/data/awareness/, rendered as one `## Feature notes` section.
 *
 * Fixtures are entry files in a temporary directory given to createRegistry();
 * the real directory is read through the default registry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { parseAwarenessUnits } from '../../src/scaffold/claudeMdLayout.js';
import {
  AWARENESS_ENTRY_DIR_URL,
  AWARENESS_REGISTRY_END,
  AWARENESS_REGISTRY_FEATURE,
  AWARENESS_REGISTRY_START,
  createRegistry,
  defaultRegistry,
  eligibleEntries,
  emptyRegistry,
  findRegistryBlock,
  holdRegistryBlock,
  registryErrors,
  renderRegistrySection,
  unreportedRegistryDegradations,
  unreportedRegistryErrorLines,
  withRegistry,
  withoutRegistryBlock,
  type AwarenessRegistry,
} from '../../src/awareness/registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CTX = { port: 4042, hasTelegram: true };
const NO_TG = { port: 4042, hasTelegram: false };

const entry = (title: string, body: string, extra = ''): string => `---\ntitle: ${title}\n${extra}---\n${body}\n`;

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-registry-')); });
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/awareness-entry-registry.test.ts' });
});

function registryOf(files: Record<string, string>): AwarenessRegistry {
  const dir = fs.mkdtempSync(path.join(tmp, 'entries-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return createRegistry(pathToFileURL(dir + path.sep));
}

/** The reason recorded for one fixture entry, or null when it was accepted. */
function reasonFor(text: string, name = 'sample.md'): string | null {
  const r = registryOf({ [name]: text });
  const errors = r.errors();
  if (errors.length === 0) {
    expect(r.eligibleEntries(CTX).map(e => e.id)).toEqual([name.replace(/\.md$/, '')]);
    return null;
  }
  expect(r.eligibleEntries(CTX)).toEqual([]);
  expect(errors).toHaveLength(1);
  return errors[0].reason;
}

describe('an entry file: what is accepted and what is refused (spec 3.1, 3.5)', () => {
  it('accepts title + body, a title with a colon, CRLF, a byte-order mark and blank lines around the body', () => {
    expect(reasonFor(entry('Held replies', 'A reply held for review is delivered late.'))).toBeNull();
    expect(reasonFor(entry('Held replies: late ones', 'Body text.'))).toBeNull();
    const r = registryOf({ 'crlf.md': '﻿' + entry('Windows file', '\nFirst line.\nSecond line.\n').replace(/\n/g, '\r\n') });
    expect(r.errors()).toEqual([]);
    expect(r.renderSection(CTX)).toBe('## Feature notes\n\nNotes added by individual features, one per entry.\n\n**Windows file** — First line.\nSecond line.\n');
  });

  it('the id is the file name: a name that is not an id is an error row, README.md and non-.md files are skipped', () => {
    const r = registryOf({
      'good-one.md': entry('Good one', 'Body.'),
      'Bad_Name.md': entry('Bad name', 'Body.'),
      'double--hyphen.md': entry('Double hyphen', 'Body.'),
      'README.md': '# not an entry',
      'notes.txt': 'ignored',
      '.DS_Store': 'ignored',
    });
    expect(r.eligibleEntries(CTX).map(e => e.id)).toEqual(['good-one']);
    expect(r.errors().map(e => e.id).sort()).toEqual(['Bad_Name.md', 'double--hyphen.md']);
  });

  it('a subdirectory in the entry directory is ignored', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'with-subdir-'));
    fs.mkdirSync(path.join(dir, 'nested.md'));
    fs.writeFileSync(path.join(dir, 'one.md'), entry('One', 'Body.'));
    const r = createRegistry(pathToFileURL(dir + path.sep));
    expect(r.errors()).toEqual([]);
    expect(r.eligibleEntries(CTX).map(e => e.id)).toEqual(['one']);
  });

  it('front matter: unknown key, duplicate key, a line with no colon, missing or empty title, unclosed block', () => {
    expect(reasonFor(entry('T one', 'Body.', 'topic: messaging\n'))).toMatch(/unknown front-matter key "topic"/);
    expect(reasonFor(entry('T one', 'Body.', 'title: again\n'))).toMatch(/given twice/);
    expect(reasonFor(entry('T one', 'Body.', 'just some words\n'))).toMatch(/no colon/);
    expect(reasonFor('---\nrequires: telegram\n---\nBody.\n')).toMatch(/non-empty title/);
    expect(reasonFor('---\ntitle:\n---\nBody.\n')).toMatch(/non-empty title/);
    expect(reasonFor('---\ntitle: T one\nBody with no closing line.\n')).toMatch(/no colon|not closed/);
    expect(reasonFor('title: T one\n\nBody.\n')).toMatch(/must start with a front-matter block/);
  });

  it('title: no ** and no em dash; a single * or a one-character title cannot form the lead-in', () => {
    expect(reasonFor(entry('Bold **word**', 'Body.'))).toMatch(/may not contain \*\*/);
    expect(reasonFor(entry('Left — right', 'Body.'))).toMatch(/em dash/);
    expect(reasonFor(entry('Port {{port}} note', 'Body.'))).toMatch(/title may not contain \{\{/);
    expect(reasonFor(entry('Half {{ open', 'Body.'))).toMatch(/title may not contain \{\{/);
    expect(reasonFor(entry('Star * title', 'Body.'))).toMatch(/exactly one section/);
    expect(reasonFor(entry('X', 'Body.'))).toMatch(/exactly one section/);
  });

  it('requires: telegram is the only value', () => {
    expect(reasonFor(entry('T one', 'Body.', 'requires: telegram\n'))).toBeNull();
    expect(reasonFor(entry('T one', 'Body.', 'requires: slack\n'))).toMatch(/unknown requires value "slack"/);
  });

  it('body: empty is refused; {{port}} is the only placeholder and is replaced everywhere, inside fences too', () => {
    expect(reasonFor('---\ntitle: T one\n---\n\n  \n')).toMatch(/body is empty/);
    expect(reasonFor(entry('T one', 'See {{host}} for more.'))).toMatch(/unknown placeholder "\{\{host\}\}"/);
    expect(reasonFor(entry('T one', 'See {{ port }} for more.'))).toMatch(/unknown placeholder/);
    const r = registryOf({ 'ports.md': entry('Ports', 'Call `curl http://localhost:{{port}}/a`.\n\n```bash\ncurl http://localhost:{{port}}/b\n```') });
    expect(r.errors()).toEqual([]);
    const text = r.renderSection({ port: 5151, hasTelegram: false });
    expect(text).toContain('http://localhost:5151/a');
    expect(text).toContain('http://localhost:5151/b');
    expect(text).not.toContain('{{');
  });

  it('body: the first line must be prose', () => {
    for (const first of ['```bash', '~~~', '- a list item', '* a list item', '1. a numbered item', '## A heading', '> a quote', '| a | table |', '  indented']) {
      expect(reasonFor(entry('T one', `${first}\nmore\n`)), first).toMatch(/first line of the body must be prose/);
    }
    expect(reasonFor(entry('T one', 'Prose first.\n\n- then a list\n- of two'))).toBeNull();
  });

  it('body: code fences are balanced', () => {
    expect(reasonFor(entry('T one', 'Prose.\n\n```bash\ncurl x'))).toMatch(/never closed/);
    expect(reasonFor(entry('T one', 'Prose.\n\n````md\n```\ninner\n```\n'))).toMatch(/never closed/);
    expect(reasonFor(entry('T one', 'Prose.\n\n```bash\ncurl x\n```'))).toBeNull();
  });

  it('body: the marker name is forbidden, in the title too', () => {
    expect(reasonFor(entry('T one', 'Prose.\n<!-- instar:awareness-registry:end -->'))).toMatch(/may not contain "instar:awareness-registry"/);
    expect(reasonFor(entry('About instar:awareness-registry', 'Prose.'))).toMatch(/may not contain "instar:awareness-registry"/);
  });

  it('body: a heading or a second bold lead-in makes it more than one section; inside a fence they are fine', () => {
    expect(reasonFor(entry('T one', 'Prose.\n\n### A sub-heading\n\nMore.'))).toMatch(/exactly one section/);
    expect(reasonFor(entry('T one', 'Prose.\n\n**Second note** — more text.'))).toMatch(/exactly one section/);
    expect(reasonFor(entry('T one', 'Prose with **bold words** inside.\n\n```md\n## not a heading\n**Not a lead** — quoted\n```'))).toBeNull();
  });

  it('every accepted entry renders as exactly one unit whose title is its own, under the real parser', () => {
    const r = registryOf({ 'a.md': entry('Alpha `code` note', 'First.\n\nSecond paragraph.'), 'b.md': entry('Beta note', 'Only line.') });
    const units = parseAwarenessUnits(r.renderSection(CTX));
    expect(units.slice(1).map(u => u.title)).toEqual(['feature notes', 'alpha code note', 'beta note']);
    expect(units.slice(1).map(u => u.level)).toEqual([2, 0, 0]);
  });

  it('titles are unique ignoring case: both entries of a clashing pair are left out, the rest still render', () => {
    const r = registryOf({
      'first.md': entry('Same Title', 'One.'),
      'second.md': entry('same title', 'Two.'),
      'third.md': entry('Other title', 'Three.'),
    });
    expect(r.eligibleEntries(CTX).map(e => e.id)).toEqual(['third']);
    expect(r.errors().map(e => e.id).sort()).toEqual(['first', 'second']);
    expect(r.errors()[0].reason).toMatch(/is also the title of/);
  });

  it('an invalid entry yields an error row while the valid ones still render', () => {
    const r = registryOf({ 'bad.md': entry('Bad', 'Uses {{nope}}.'), 'good.md': entry('Good note', 'Fine.') });
    expect(r.errors()).toEqual([{ id: 'bad', reason: expect.stringMatching(/unknown placeholder/) }]);
    expect(r.renderSection(CTX)).toContain('**Good note** — Fine.');
    expect(r.renderSection(CTX)).not.toContain('Bad');
  });

  it('a missing directory yields one error row and no entries', () => {
    const r = createRegistry(pathToFileURL(path.join(tmp, 'does-not-exist') + path.sep));
    expect(r.eligibleEntries(CTX)).toEqual([]);
    expect(r.renderSection(CTX)).toBe('');
    expect(r.errors()).toHaveLength(1);
    expect(r.errors()[0]).toEqual({ id: '*', reason: expect.stringMatching(/could not be read/) });
    expect(r.withRegistry('doc\n', CTX, { markers: true })).toEqual({ content: 'doc\n', changed: false, broken: false });
  });

  it('the directory is read once: a file added after the first read is not seen by that registry', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'once-'));
    fs.writeFileSync(path.join(dir, 'one.md'), entry('One', 'Body.'));
    const r = createRegistry(pathToFileURL(dir + path.sep));
    expect(r.eligibleEntries(CTX).map(e => e.id)).toEqual(['one']);
    fs.writeFileSync(path.join(dir, 'two.md'), entry('Two', 'Body.'));
    expect(r.eligibleEntries(CTX).map(e => e.id)).toEqual(['one']);
  });
});

describe('eligibleEntries and renderSection (spec 3.3)', () => {
  const files = {
    'zebra.md': entry('Zebra note', 'Z body.'),
    'apple.md': entry('Apple note', 'A body on port {{port}}.'),
    'tg-only.md': entry('Telegram note', 'T body.', 'requires: telegram\n'),
  };

  it('filters requires for both hasTelegram values and sorts by id', () => {
    const r = registryOf(files);
    expect(r.eligibleEntries(CTX).map(e => e.id)).toEqual(['apple', 'tg-only', 'zebra']);
    expect(r.eligibleEntries(NO_TG).map(e => e.id)).toEqual(['apple', 'zebra']);
  });

  it('renders the heading, the one sentence, and one bold-lead paragraph per entry', () => {
    expect(registryOf(files).renderSection(NO_TG)).toBe(
      '## Feature notes\n\nNotes added by individual features, one per entry.\n\n**Apple note** — A body on port 4042.\n\n**Zebra note** — Z body.\n',
    );
  });

  it('is empty for zero entries, and for entries that all need Telegram on an agent without it', () => {
    expect(registryOf({}).renderSection(CTX)).toBe('');
    expect(emptyRegistry().renderSection(CTX)).toBe('');
    expect(registryOf({ 'tg-only.md': files['tg-only.md'] }).renderSection(NO_TG)).toBe('');
  });
});

describe('finding a block (spec 3.3.1)', () => {
  const block = `${AWARENESS_REGISTRY_START}\n## Feature notes\n\n**A note** — text\n${AWARENESS_REGISTRY_END}\n`;

  it('none / well-formed / broken', () => {
    expect(findRegistryBlock('# Doc\n\ntext\n')).toEqual({ state: 'none' });
    const doc = `# Doc\n\n${block}tail\n`;
    const found = findRegistryBlock(doc);
    expect(found.state).toBe('well-formed');
    if (found.state === 'well-formed') expect(doc.slice(found.start, found.end)).toBe(block);
    for (const broken of [
      `# Doc\n${AWARENESS_REGISTRY_START}\ntext\n`,
      `# Doc\ntext\n${AWARENESS_REGISTRY_END}\n`,
      `${AWARENESS_REGISTRY_END}\ntext\n${AWARENESS_REGISTRY_START}\n`,
      `${block}${block}`,
      `${AWARENESS_REGISTRY_START}\n${block}`,
      `${block}${AWARENESS_REGISTRY_END}\n`,
    ]) {
      expect(findRegistryBlock(broken).state, broken).toBe('broken');
    }
  });

  it('a marker quoted in prose or inside a code fence does not count', () => {
    const prose = `# Doc\n\nThe line \`${AWARENESS_REGISTRY_START}\` opens the block.\n  ${AWARENESS_REGISTRY_END}\n`;
    expect(findRegistryBlock(prose)).toEqual({ state: 'none' });
    const fenced = `# Doc\n\n\`\`\`md\n${AWARENESS_REGISTRY_START}\n\`\`\`\n\n~~~\n${AWARENESS_REGISTRY_END}\n~~~\n`;
    expect(findRegistryBlock(fenced)).toEqual({ state: 'none' });
    expect(findRegistryBlock(`${fenced}\n${block}`).state).toBe('well-formed');
  });

  it('a marker line with a trailing carriage return still counts (CRLF file)', () => {
    const crlf = `# Doc\r\n\r\n${block.replace(/\n/g, '\r\n')}`;
    const found = findRegistryBlock(crlf);
    expect(found.state).toBe('well-formed');
    expect(withoutRegistryBlock(crlf)).toBe('# Doc\r\n');
  });

  it('withoutRegistryBlock removes a well-formed block and returns anything else as the same string', () => {
    expect(withoutRegistryBlock(`# Doc\n\n${block}`)).toBe('# Doc\n');
    expect(withoutRegistryBlock(`# Doc\n\n${block}\n\n## After\n`)).toBe('# Doc\n\n\n## After\n');
    const none = '# Doc\n';
    expect(withoutRegistryBlock(none)).toBe(none);
    const broken = `# Doc\n${AWARENESS_REGISTRY_START}\n`;
    expect(withoutRegistryBlock(broken)).toBe(broken);
  });
});

describe('holdRegistryBlock: the block is out of the way while a caller works, and comes back byte for byte', () => {
  const block = `${AWARENESS_REGISTRY_START}\n## Feature notes\n\n**A note** — text with \`/corrections\`\n${AWARENESS_REGISTRY_END}\n`;

  it('restore is the exact inverse, also for CRLF, a block with no final newline, and text added around the stand-in', () => {
    for (const doc of [`# Doc\n\n${block}\n## After\n`, `# Doc\n\n${block}`, `# Doc\n\n${block}`.replace(/\n/g, '\r\n'), `# Doc\n\n${block.replace(/\n$/, '')}`]) {
      const held = holdRegistryBlock(doc);
      expect(held.text).not.toContain('/corrections');
      expect(findRegistryBlock(held.text)).toEqual({ state: 'none' });
      expect(held.restore(held.text)).toBe(doc);
    }
    const held = holdRegistryBlock(`# Doc\n\n${block}\n## After\n`);
    expect(held.restore(`intro\n${held.text}tail\n`)).toBe(`intro\n# Doc\n\n${block}\n## After\ntail\n`);
    expect(held.restore(held.text.replace(/\n/g, '\r\n'))).toBe(`# Doc\r\n\r\n${block}\r\n## After\r\n`);
  });

  it('a document with no block, or a broken one, is held as the same string; a lost stand-in keeps the block at the end', () => {
    for (const doc of ['# Doc\n', `# Doc\n${AWARENESS_REGISTRY_START}\n`]) {
      const held = holdRegistryBlock(doc);
      expect(held.text).toBe(doc);
      expect(held.restore('anything\n')).toBe('anything\n');
    }
    expect(holdRegistryBlock(`# Doc\n\n${block}`).restore('rewritten\n')).toBe(`rewritten\n\n${block}`);
  });
});

describe('withRegistry (spec 3.3)', () => {
  const one = { 'note.md': entry('A note', 'Text on {{port}}.') };
  const DOC = '# Doc\n\n## Section\n\nBody.\n';

  it('appends at the end when no block exists, with marker lines around the section', () => {
    const r = registryOf(one);
    const out = r.withRegistry(DOC, CTX, { markers: true });
    expect(out.changed).toBe(true);
    expect(out.broken).toBe(false);
    expect(out.content).toBe(`${DOC}\n${AWARENESS_REGISTRY_START}\n## Feature notes\n\nNotes added by individual features, one per entry.\n\n**A note** — Text on 4042.\n${AWARENESS_REGISTRY_END}\n`);
    const found = findRegistryBlock(out.content);
    expect(found.state).toBe('well-formed');
    if (found.state === 'well-formed') expect(found.end).toBe(out.content.length);
  });

  it('markers: false appends the bare section and no marker line', () => {
    const out = registryOf(one).withRegistry(DOC, CTX, { markers: false });
    expect(out.content).toBe(`${DOC}\n## Feature notes\n\nNotes added by individual features, one per entry.\n\n**A note** — Text on 4042.\n`);
    expect(out.content).not.toContain('instar:awareness-registry');
  });

  it('keeps the text already in the document byte for byte, whatever its ending', () => {
    const r = registryOf(one);
    for (const doc of ['# Doc', '# Doc\n', '# Doc\n\n', '# Doc\r\n', '']) {
      const out = r.withRegistry(doc, CTX, { markers: true }).content;
      expect(out.startsWith(doc), JSON.stringify(doc)).toBe(true);
      expect(r.withRegistry(out, CTX, { markers: true })).toEqual({ content: out, changed: false, broken: false });
    }
  });

  it('is idempotent: a second pass returns the same string and reports no change', () => {
    const r = registryOf(one);
    const first = r.withRegistry(DOC, CTX, { markers: true }).content;
    const second = r.withRegistry(first, CTX, { markers: true });
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first);
  });

  it('replaces an older block (a changed body, a removed entry) instead of adding beside it', () => {
    const old = registryOf({ 'note.md': entry('A note', 'Old words.'), 'gone.md': entry('Gone note', 'Removed later.') })
      .withRegistry(DOC, CTX, { markers: true }).content;
    expect(old).toContain('Old words.');
    const next = registryOf(one).withRegistry(old, CTX, { markers: true });
    expect(next.changed).toBe(true);
    expect(next.content).not.toContain('Old words.');
    expect(next.content).not.toContain('Gone note');
    expect(next.content.split(AWARENESS_REGISTRY_START)).toHaveLength(2);
    expect(next.content).toBe(registryOf(one).withRegistry(DOC, CTX, { markers: true }).content);
  });

  it('moves a block that is not last to the end; the text that followed it is kept', () => {
    const r = registryOf(one);
    const withBlock = r.withRegistry(DOC, CTX, { markers: true }).content;
    const grown = `${withBlock}\n\n## Added later\n\nOperator text.\n`;
    const out = r.withRegistry(grown, CTX, { markers: true });
    expect(out.changed).toBe(true);
    expect(out.content).toContain('## Added later\n\nOperator text.\n');
    expect(out.content.endsWith(`${AWARENESS_REGISTRY_END}\n`)).toBe(true);
    expect(out.content.indexOf('## Added later')).toBeLessThan(out.content.indexOf(AWARENESS_REGISTRY_START));
    expect(out.content.split(AWARENESS_REGISTRY_START)).toHaveLength(2);
    expect(r.withRegistry(out.content, CTX, { markers: true }).changed).toBe(false);
  });

  it('an empty registry adds nothing at all, and only removes an existing block', () => {
    const empty = emptyRegistry();
    const untouched = empty.withRegistry(DOC, CTX, { markers: true });
    expect(untouched.content).toBe(DOC);
    expect(untouched.changed).toBe(false);
    const withBlock = registryOf(one).withRegistry(DOC, CTX, { markers: true }).content;
    const removed = empty.withRegistry(withBlock, CTX, { markers: true });
    expect(removed.changed).toBe(true);
    expect(removed.content).toBe(DOC);
  });

  it('ignores a marker quoted in prose or inside a code fence', () => {
    const r = registryOf(one);
    const doc = `# Doc\n\nWrite \`${AWARENESS_REGISTRY_START}\` to open it.\n\n\`\`\`md\n${AWARENESS_REGISTRY_START}\n${AWARENESS_REGISTRY_END}\n\`\`\`\n`;
    const out = r.withRegistry(doc, CTX, { markers: true });
    expect(out.broken).toBe(false);
    expect(out.content.startsWith(doc)).toBe(true);
    expect(findRegistryBlock(out.content).state).toBe('well-formed');
    expect(r.withRegistry(out.content, CTX, { markers: true }).changed).toBe(false);
  });

  it('a document that ends inside an unclosed code fence is broken: unchanged on a first and a second pass', () => {
    const r = registryOf(one);
    const open = `${DOC}\n\`\`\`bash\ncurl x\n`;
    const first = r.withRegistry(open, CTX, { markers: true });
    expect(first).toEqual({ content: open, changed: false, broken: true });
    expect(r.withRegistry(first.content, CTX, { markers: true })).toEqual({ content: open, changed: false, broken: true });
    // With nothing to add there is nothing to read back: the document is simply left alone.
    expect(emptyRegistry().withRegistry(open, CTX, { markers: true })).toEqual({ content: open, changed: false, broken: false });
  });

  it('a document whose existing block sits inside an open code fence is broken, not appended to again', () => {
    const r = registryOf(one);
    const block = `${AWARENESS_REGISTRY_START}\n## Feature notes\n\n**A note** — old text\n${AWARENESS_REGISTRY_END}\n`;
    const hidden = `${DOC}\n~~~\nnever closed\n\n${block}`;
    expect(findRegistryBlock(hidden)).toEqual({ state: 'none' });
    const first = r.withRegistry(hidden, CTX, { markers: true });
    expect(first).toEqual({ content: hidden, changed: false, broken: true });
    expect(r.withRegistry(first.content, CTX, { markers: true })).toEqual({ content: hidden, changed: false, broken: true });
    // A block quoted inside a CLOSED fence is only a quotation: the real block is appended once.
    const quoted = `${DOC}\n~~~\n${block}~~~\n`;
    const out = r.withRegistry(quoted, CTX, { markers: true });
    expect(out.broken).toBe(false);
    expect(out.content.startsWith(quoted)).toBe(true);
    expect(r.withRegistry(out.content, CTX, { markers: true }).changed).toBe(false);
  });

  it('markers: false is NOT idempotent and never guesses at a "## Feature notes" heading: it is called once', () => {
    const r = registryOf(one);
    const once = r.withRegistry(DOC, CTX, { markers: false }).content;
    const twice = r.withRegistry(once, CTX, { markers: false });
    expect(twice.changed).toBe(true);
    expect(twice.content.split('## Feature notes')).toHaveLength(3);
    expect(twice.content.startsWith(once)).toBe(true);
    // An operator's own section of that name is never touched, with or without markers.
    const operators = `${DOC}\n## Feature notes\n\nMy own notes.\n`;
    expect(r.withRegistry(operators, CTX, { markers: true }).content.startsWith(operators)).toBe(true);
    expect(emptyRegistry().withRegistry(operators, CTX, { markers: false }).content).toBe(operators);
  });

  it('a broken document is returned unchanged, on a first and on a second pass', () => {
    const r = registryOf(one);
    const block = `${AWARENESS_REGISTRY_START}\nold\n${AWARENESS_REGISTRY_END}\n`;
    for (const broken of [
      `${DOC}\n${AWARENESS_REGISTRY_START}\nold text\n`,
      `${DOC}\nold text\n${AWARENESS_REGISTRY_END}\n`,
      `${AWARENESS_REGISTRY_END}\n${DOC}${AWARENESS_REGISTRY_START}\n`,
      `${DOC}${block}${block}`,
    ]) {
      for (const markers of [true, false]) {
        const first = r.withRegistry(broken, CTX, { markers });
        expect(first).toEqual({ content: broken, changed: false, broken: true });
        expect(r.withRegistry(first.content, CTX, { markers })).toEqual({ content: broken, changed: false, broken: true });
      }
      expect(emptyRegistry().withRegistry(broken, CTX, { markers: true })).toEqual({ content: broken, changed: false, broken: true });
    }
  });
});

describe('reporting (spec 3.5)', () => {
  it('each error row is handed to a channel once per registry; another channel still gets it', () => {
    const r = registryOf({ 'bad.md': entry('Bad', 'Uses {{nope}}.'), 'worse.md': 'no front matter' });
    const first = unreportedRegistryErrorLines(r);
    expect(first).toHaveLength(2);
    expect(first[0]).toMatch(new RegExp(`^${AWARENESS_REGISTRY_FEATURE.replace('.', '\\.')}: bad: unknown placeholder`));
    expect(unreportedRegistryErrorLines(r)).toEqual([]);
    const events = unreportedRegistryDegradations(r);
    expect(events).toHaveLength(2);
    expect(events[0].feature).toBe('awareness.entry-registry');
    expect(events[0].reason).toMatch(/^bad: /);
    for (const key of ['primary', 'fallback', 'impact'] as const) expect(events[0][key].length).toBeGreaterThan(10);
    expect(unreportedRegistryDegradations(r)).toEqual([]);
  });

  it('a registry without errors reports nothing', () => {
    const r = registryOf({ 'good.md': entry('Good note', 'Fine.') });
    expect(unreportedRegistryErrorLines(r)).toEqual([]);
    expect(unreportedRegistryDegradations(r)).toEqual([]);
  });
});

describe('the real directory, src/data/awareness/ (regression checks that keep a bad entry from merging)', () => {
  const dir = fileURLToPath(AWARENESS_ENTRY_DIR_URL);

  it('exists, is the package data folder, and holds the author README', () => {
    expect(path.relative(ROOT, dir)).toBe(path.join('src', 'data', 'awareness'));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf-8');
    expect(readme).toContain('The first line of the body must be prose');
    expect(readme).toContain('{{port}}');
  });

  it('the error list is empty, for both hasTelegram values and two ports', () => {
    for (const hasTelegram of [true, false]) {
      for (const port of [4040, 61234]) {
        const section = renderRegistrySection({ port, hasTelegram });
        expect(section).toBe(defaultRegistry().renderSection({ port, hasTelegram }));
        expect(section).not.toContain('{{');
        expect(registryErrors()).toEqual([]);
      }
    }
  });

  it('every .md file in it other than README.md is a rendered entry', () => {
    const ids = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md').map(f => f.replace(/\.md$/, '')).sort();
    expect(eligibleEntries({ port: 4040, hasTelegram: true }).map(e => e.id)).toEqual(ids);
  });

  it('the module-level functions are the default registry', () => {
    const doc = '# Doc\n';
    expect(withRegistry(doc, CTX, { markers: true })).toEqual(defaultRegistry().withRegistry(doc, CTX, { markers: true }));
    if (eligibleEntries(CTX).length === 0) expect(withRegistry(doc, CTX, { markers: true }).content).toBe(doc);
  });

  it('packaging: src/data is in the package file list and nothing ignores the entry folder', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { files: string[] };
    expect(pkg.files).toContain('src/data');
    for (const ignoreFile of ['.npmignore', path.join('src', '.npmignore'), path.join('src', 'data', '.npmignore')]) {
      const p = path.join(ROOT, ignoreFile);
      if (fs.existsSync(p)) expect(fs.readFileSync(p, 'utf-8')).not.toMatch(/awareness|README|\*\.md/);
    }
  });

  it('the registry is a leaf: it imports only node built-ins and claudeMdLayout.ts', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'awareness', 'registry.ts'), 'utf-8');
    const imports = Array.from(source.matchAll(/^import [^;]*? from '([^']+)';$/gm)).map(m => m[1]).sort();
    expect(imports).toEqual(['../scaffold/claudeMdLayout.js', 'node:fs']);
    expect(source).not.toMatch(/\bawait\b|\bimport\(/);
    const layout = fs.readFileSync(path.join(ROOT, 'src', 'scaffold', 'claudeMdLayout.ts'), 'utf-8');
    expect(Array.from(layout.matchAll(/^import [^;]*? from '([^']+)';$/gm)).map(m => m[1])).toEqual(['node:crypto']);
  });
});
