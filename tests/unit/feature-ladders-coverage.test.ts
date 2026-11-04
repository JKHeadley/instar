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

  it('keeps every ladder entry on a fleet rung unless it composes or retires', () => {
    const bad = list.filter(e => e.disposition === 'ladder' && e.final === 'default-on' && !e.rungs.fleet).map(e => e.id);
    expect(bad).toEqual([]);
  });

  it('every spec that names a ladder names a real entry', () => {
    const specs = path.resolve('docs/specs');
    const ids = new Set(list.map(e => e.id));
    const dangling: string[] = [];
    for (const name of fs.readdirSync(specs)) {
      if (!name.endsWith('.md')) continue;
      const m = fs.readFileSync(path.join(specs, name), 'utf-8').match(/^\s*[-*+]\s+\*\*ladder:\*\*\s+(.+?)\s*$/im);
      if (m && !ids.has(m[1])) dangling.push(`${name} → ${m[1]}`);
    }
    expect(dangling).toEqual([]);
  });

  it('ships in the package', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8')) as { files: string[] };
    expect(pkg.files).toContain('src/data');
  });
});
