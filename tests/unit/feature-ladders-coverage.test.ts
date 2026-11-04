/**
 * The ratchet (docs/specs/feature-maturation-ladder.md §2): a switched-off
 * feature with no ladder fails the build. Derived from code, with no baseline
 * file, so it cannot be satisfied by leaving a flag out of a list.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseLadderRegistry, type LadderEntry } from '../../src/monitoring/MaturationLadder.js';
import { maturationUniverse } from '../../src/monitoring/maturationUniverse.js';
import { readShippedRegistry } from '../../src/monitoring/MaturationLadderService.js';

function entries(): LadderEntry[] {
  const parsed = parseLadderRegistry(readShippedRegistry());
  if (!parsed.ok) throw new Error(`shipped registry invalid: ${parsed.reason}`);
  return parsed.registry.entries;
}
const strip = (p: string) => p.replace(/\.(enabled|dryRun)$/, '');

describe('the shipped ladder registry', () => {
  const list = entries();
  const known = new Set(list.flatMap(e => [e.id, strip(e.flag?.path ?? e.id), ...e.aliases.map(strip)]));

  it('covers every switched-off feature in the code', () => {
    const missing = maturationUniverse().filter(m => !known.has(m.path)).map(m => m.path);
    expect(missing, `add an entry to src/data/feature-ladders.json for: ${missing.join(', ')}`).toEqual([]);
  });

  it('marks everything dark-for-everyone and load-bearing as sensitive', () => {
    const bySensitive = new Map(list.flatMap(e => [e.id, strip(e.flag?.path ?? e.id), ...e.aliases.map(strip)].map(k => [k, e.risk] as const)));
    const wrong = maturationUniverse().filter(m => m.mustBeSensitive && bySensitive.get(m.path) === 'standard').map(m => m.path);
    expect(wrong).toEqual([]);
  });

  it('uses no preference final until the article amendment merges', () => {
    // Today the article has one enumerated exit from the ladder. The amendment PR removes this test.
    expect(list.filter(e => e.final === 'default-off-by-preference').map(e => e.id)).toEqual([]);
  });

  it('keeps every ladder entry on a fleet rung unless it composes or retires', () => {
    const bad = list.filter(e => e.disposition === 'ladder' && !e.rungs.fleet).map(e => e.id);
    expect(bad).toEqual([]);
  });

  it('every spec that names a ladder names a real entry', () => {
    const specs = path.resolve('docs/specs');
    const ids = new Set(list.map(e => e.id));
    const dangling: string[] = [];
    for (const name of fs.readdirSync(specs)) {
      if (!name.endsWith('.md')) continue;
      const m = fs.readFileSync(path.join(specs, name), 'utf-8').match(/^\s*[-*+]\s+\*\*ladder:\*\*\s+(.+?)\s*$/im);
      // A spec with no flag says so with its reason; anything else must be a real entry.
      if (m && !ids.has(m[1]) && !/^not applicable: \S/.test(m[1])) dangling.push(`${name} → ${m[1]}`);
    }
    expect(dangling).toEqual([]);
  });

  it('a spec with no flag can say not applicable, but only with a reason', () => {
    const allowed = (v: string) => /^not applicable: \S/.test(v);
    expect(allowed('not applicable: no flag.')).toBe(true);
    expect(allowed('not applicable')).toBe(false);
    expect(allowed('not applicable: ')).toBe(false);
  });

  it('ships in the package', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8')) as { files: string[] };
    expect(pkg.files).toContain('src/data');
  });
});
