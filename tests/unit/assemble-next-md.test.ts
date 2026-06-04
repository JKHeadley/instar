/**
 * Unit tests — assemble-next-md.mjs (per-PR release-note fragments).
 *
 * The release pipeline historically consumed a single shared upgrades/NEXT.md
 * per merge, so concurrent PRs collided on that one file within minutes. The
 * fix is per-PR FRAGMENTS (upgrades/next/<slug>.md) that an assemble pre-step
 * folds into NEXT.md before the existing pipeline runs. This suite hammers the
 * pure assembler: it is the critical new code that must merge sections
 * deterministically, pick the max bump tier, fold a legacy NEXT.md, no-op
 * cleanly when there's nothing, fail loudly on malformation, and stay
 * idempotent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
// @ts-expect-error — .mjs script, no type declarations; runtime import is fine under vitest
import {
  assembleNextMd,
  parseBumpType,
  parseSections,
  gatherFragmentInputs,
  hasInternalOnlyMarker,
  INTERNAL_ONLY_FILL,
  CANONICAL_SECTIONS,
} from '../../scripts/assemble-next-md.mjs';
// @ts-expect-error — .mjs script, no type declarations
import { validateGuideContent } from '../../scripts/upgrade-guide-validator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const scriptPath = path.join(ROOT, 'scripts', 'assemble-next-md.mjs');

function frag(name: string, content: string) {
  return { name, content };
}

// A minimal well-formed fragment body for a given "What Changed" line.
function makeFragment(opts: {
  bump?: string;
  whatChanged?: string;
  wttyu?: string;
  capabilities?: string;
  evidence?: string;
}): string {
  const lines: string[] = ['# Upgrade Guide — vNEXT', ''];
  if (opts.bump) lines.push(`<!-- bump: ${opts.bump} -->`, '');
  if (opts.whatChanged) lines.push('## What Changed', '', opts.whatChanged, '');
  if (opts.wttyu) lines.push('## What to Tell Your User', '', opts.wttyu, '');
  if (opts.capabilities) lines.push('## Summary of New Capabilities', '', opts.capabilities, '');
  if (opts.evidence) lines.push('## Evidence', '', opts.evidence, '');
  return lines.join('\n');
}

describe('parseBumpType', () => {
  it('extracts patch/minor/major', () => {
    expect(parseBumpType('<!-- bump: patch -->')).toBe('patch');
    expect(parseBumpType('<!-- bump: minor -->')).toBe('minor');
    expect(parseBumpType('<!-- bump: major -->')).toBe('major');
  });
  it('is case-insensitive and tolerant of spacing', () => {
    expect(parseBumpType('<!--bump:MINOR-->')).toBe('minor');
  });
  it('returns null when absent', () => {
    expect(parseBumpType('## What Changed\n\nstuff')).toBeNull();
  });
});

describe('parseSections', () => {
  it('splits H2 sections in source order, dropping pre-H2 preamble', () => {
    const secs = parseSections('# H1\n<!-- bump: patch -->\n## A\n\nbody a\n## B\n\nbody b\n');
    expect(secs.map((s: { title: string }) => s.title)).toEqual(['A', 'B']);
    expect(secs[0].body.trim()).toBe('body a');
    expect(secs[1].body.trim()).toBe('body b');
  });
  it('returns empty array when there are no H2 sections', () => {
    expect(parseSections('# only an h1\n\nsome prose')).toEqual([]);
  });
});

describe('assembleNextMd — merging', () => {
  it('merges multiple fragments into ONE of each canonical section', () => {
    const a = makeFragment({
      bump: 'patch',
      whatChanged: 'Fragment A changed the scheduler.',
      wttyu: 'I tuned up the scheduler.',
      capabilities: '| Scheduler tune | automatic |',
    });
    const b = makeFragment({
      bump: 'patch',
      whatChanged: 'Fragment B changed the relay.',
      wttyu: 'I tuned up the relay.',
      capabilities: '| Relay tune | automatic |',
    });
    const out = assembleNextMd([frag('next/a.md', a), frag('next/b.md', b)]);

    // Exactly ONE of each canonical heading.
    expect((out.match(/^## What Changed$/gm) || []).length).toBe(1);
    expect((out.match(/^## What to Tell Your User$/gm) || []).length).toBe(1);
    expect((out.match(/^## Summary of New Capabilities$/gm) || []).length).toBe(1);

    // Both fragments' content present under the merged section.
    expect(out).toContain('Fragment A changed the scheduler.');
    expect(out).toContain('Fragment B changed the relay.');
    expect(out).toContain('Scheduler tune');
    expect(out).toContain('Relay tune');
  });

  it('orders sections canonically: What Changed, WTTYU, Summary, Evidence', () => {
    const a = makeFragment({
      bump: 'patch',
      whatChanged: 'Fixed the stall.',
      wttyu: 'I fixed a stall.',
      capabilities: '| x | automatic |',
      evidence: 'Reproduced the stall on a live box; after the fix it no longer hangs at the prompt.',
    });
    const out = assembleNextMd([frag('next/a.md', a)]);
    const iWhat = out.indexOf('## What Changed');
    const iUser = out.indexOf('## What to Tell Your User');
    const iSum = out.indexOf('## Summary of New Capabilities');
    const iEvi = out.indexOf('## Evidence');
    expect(iWhat).toBeGreaterThanOrEqual(0);
    expect(iWhat).toBeLessThan(iUser);
    expect(iUser).toBeLessThan(iSum);
    expect(iSum).toBeLessThan(iEvi);
  });

  it('appends non-canonical sections after the canonical ones, also merged', () => {
    const a = makeFragment({ bump: 'patch', whatChanged: 'A' });
    const withExtra = a + '\n## Migration Notes\n\nrun the migrator\n';
    const b = makeFragment({ bump: 'patch', whatChanged: 'B' });
    const withExtraB = b + '\n## Migration Notes\n\nand restart\n';
    const out = assembleNextMd([frag('next/a.md', withExtra), frag('next/b.md', withExtraB)]);
    expect((out.match(/^## Migration Notes$/gm) || []).length).toBe(1);
    expect(out.indexOf('## Migration Notes')).toBeGreaterThan(out.indexOf('## What Changed'));
    expect(out).toContain('run the migrator');
    expect(out).toContain('and restart');
  });

  it('processes fragments in the order provided (deterministic)', () => {
    const a = makeFragment({ bump: 'patch', whatChanged: 'AAA first' });
    const b = makeFragment({ bump: 'patch', whatChanged: 'BBB second' });
    const out = assembleNextMd([frag('next/a.md', a), frag('next/b.md', b)]);
    expect(out.indexOf('AAA first')).toBeLessThan(out.indexOf('BBB second'));
  });
});

describe('assembleNextMd — bump tier', () => {
  it('takes the MAX tier across fragments (major > minor > patch)', () => {
    const p = makeFragment({ bump: 'patch', whatChanged: 'a' });
    const mi = makeFragment({ bump: 'minor', whatChanged: 'b' });
    const ma = makeFragment({ bump: 'major', whatChanged: 'c' });
    expect(assembleNextMd([frag('p', p), frag('mi', mi)])).toContain('<!-- bump: minor -->');
    expect(assembleNextMd([frag('mi', mi), frag('ma', ma)])).toContain('<!-- bump: major -->');
    expect(assembleNextMd([frag('p', p)])).toContain('<!-- bump: patch -->');
  });

  it('defaults to patch when no fragment declares a bump', () => {
    const noBump = '## What Changed\n\nsomething\n';
    expect(assembleNextMd([frag('x', noBump)])).toContain('<!-- bump: patch -->');
  });
});

describe('assembleNextMd — single fragment', () => {
  it('passes a single fragment through as a well-formed guide', () => {
    const a = makeFragment({
      bump: 'minor',
      whatChanged: 'Added the fragment system.',
      wttyu: 'Release notes now compose from per-change pieces.',
      capabilities: '| Fragments | automatic |',
    });
    const out = assembleNextMd([frag('next/a.md', a)]);
    expect(out).toMatch(/^# Upgrade Guide — vNEXT$/m);
    expect(out).toContain('<!-- bump: minor -->');
    expect(out).toContain('Added the fragment system.');
  });
});

describe('assembleNextMd — malformation', () => {
  it('throws on a fragment with content but no "## " section', () => {
    expect(() => assembleNextMd([frag('next/bad.md', '# H1 only\n\njust prose, no headings')]))
      .toThrow(/no recognizable "## " section/);
  });

  it('throws on an effectively-empty fragment (only comments/whitespace)', () => {
    expect(() => assembleNextMd([frag('next/empty.md', '<!-- bump: patch -->\n\n   \n')]))
      .toThrow(/no recognizable "## " section/);
  });

  it('throws when every section across inputs is comment-only (nothing to fold)', () => {
    const onlyComments = '## What Changed\n\n<!-- placeholder -->\n';
    expect(() => assembleNextMd([frag('next/c.md', onlyComments)]))
      .toThrow(/no content/);
  });
});

describe('assembleNextMd — idempotency', () => {
  it('running twice (feeding output back in) yields the same result', () => {
    const a = makeFragment({
      bump: 'minor',
      whatChanged: 'Did a thing.',
      wttyu: 'I did a thing.',
      capabilities: '| Thing | automatic |',
    });
    const first = assembleNextMd([frag('next/a.md', a)]);
    // Feed the generated NEXT.md back in as the sole input — must be stable.
    const second = assembleNextMd([frag('NEXT.md', first)]);
    expect(second).toBe(first);
  });
});

describe('assembleNextMd — WTTYU stays backtick-free', () => {
  it('preserves a backtick-free "What to Tell Your User" when inputs are clean', () => {
    const a = makeFragment({
      bump: 'patch',
      whatChanged: 'internal `config` key change',
      wttyu: 'Nothing changes about how I talk to you. I picked up a tune-up.',
    });
    const out = assembleNextMd([frag('next/a.md', a)]);
    // Extract the WTTYU section body (until the next H2 or EOF) and assert no
    // inline code leaked in from "What Changed".
    const m = out.match(/## What to Tell Your User\n\n([\s\S]*?)(?:\n## |$)/);
    expect(m).not.toBeNull();
    expect(m![1]).not.toMatch(/`/);
  });
});

// ── Disk-level: gatherFragmentInputs + legacy fold + no-op ───────────────

describe('gatherFragmentInputs + legacy NEXT.md fold', () => {
  let scratch: string;
  let upgrades: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'assemble-next-'));
    upgrades = path.join(scratch, 'upgrades');
    fs.mkdirSync(path.join(upgrades, 'next'), { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(scratch, { recursive: true, force: true, operation: 'tests/unit/assemble-next-md.test.ts:afterEach' });
  });

  it('folds legacy NEXT.md FIRST, then fragments sorted by filename', () => {
    fs.writeFileSync(
      path.join(upgrades, 'NEXT.md'),
      makeFragment({ bump: 'patch', whatChanged: 'Legacy NEXT content.' }),
    );
    // Write fragments out of lexical order to prove the sort.
    fs.writeFileSync(path.join(upgrades, 'next', 'zzz.md'), makeFragment({ bump: 'patch', whatChanged: 'Zed fragment.' }));
    fs.writeFileSync(path.join(upgrades, 'next', 'aaa.md'), makeFragment({ bump: 'minor', whatChanged: 'Aay fragment.' }));

    const { inputs, hadLegacy, fragmentCount } = gatherFragmentInputs(upgrades);
    expect(hadLegacy).toBe(true);
    expect(fragmentCount).toBe(2);
    expect(inputs.map((i: { name: string }) => i.name)).toEqual(['NEXT.md', 'next/aaa.md', 'next/zzz.md']);

    const out = assembleNextMd(inputs);
    // Legacy content leads, fragments follow in filename order.
    expect(out.indexOf('Legacy NEXT content.')).toBeLessThan(out.indexOf('Aay fragment.'));
    expect(out.indexOf('Aay fragment.')).toBeLessThan(out.indexOf('Zed fragment.'));
    // Max tier across legacy(patch)+aaa(minor)+zzz(patch) = minor.
    expect(out).toContain('<!-- bump: minor -->');
  });

  it('skips a content-free legacy NEXT.md (bare template) so it does not masquerade as content', () => {
    fs.writeFileSync(path.join(upgrades, 'NEXT.md'), '<!-- bump: patch -->\n\n   \n');
    fs.writeFileSync(path.join(upgrades, 'next', 'a.md'), makeFragment({ bump: 'patch', whatChanged: 'real frag' }));
    const { inputs } = gatherFragmentInputs(upgrades);
    // hadLegacy true on disk, but a whitespace/comment-only NEXT.md is NOT fed in.
    expect(inputs.map((i: { name: string }) => i.name)).toEqual(['next/a.md']);
  });

  it('returns no inputs when there are NO fragments and NO legacy NEXT.md', () => {
    const { inputs, fragmentCount } = gatherFragmentInputs(upgrades);
    expect(inputs).toEqual([]);
    expect(fragmentCount).toBe(0);
  });
});

// ── CLI behavior: no-op exit 0, write, loud failure ──────────────────────

describe('assemble-next-md.mjs CLI', () => {
  let scratch: string;
  let upgrades: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'assemble-cli-'));
    upgrades = path.join(scratch, 'upgrades');
    fs.mkdirSync(path.join(upgrades, 'next'), { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(scratch, { recursive: true, force: true, operation: 'tests/unit/assemble-next-md.test.ts:afterEach' });
  });

  function run(): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, [scriptPath, '--upgrades-dir', upgrades], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it('exits 0 quietly and writes NOTHING when there are no fragments + no NEXT.md', () => {
    const { status } = run();
    expect(status).toBe(0);
    expect(fs.existsSync(path.join(upgrades, 'NEXT.md'))).toBe(false);
  });

  it('writes upgrades/NEXT.md from a fragment and exits 0', () => {
    fs.writeFileSync(
      path.join(upgrades, 'next', 'feature.md'),
      makeFragment({ bump: 'minor', whatChanged: 'Shipped the thing.', wttyu: 'I shipped the thing.' }),
    );
    const { status } = run();
    expect(status).toBe(0);
    const written = fs.readFileSync(path.join(upgrades, 'NEXT.md'), 'utf-8');
    expect(written).toContain('Shipped the thing.');
    expect(written).toContain('<!-- bump: minor -->');
  });

  it('exits non-zero and prints a clear error on a malformed fragment', () => {
    fs.writeFileSync(path.join(upgrades, 'next', 'bad.md'), 'no headings here, just text');
    const { status, stderr } = run();
    expect(status).not.toBe(0);
    expect(stderr).toContain('no recognizable "## " section');
    // Must not have written a broken NEXT.md.
    expect(fs.existsSync(path.join(upgrades, 'NEXT.md'))).toBe(false);
  });

  it('is idempotent on disk — running twice produces identical NEXT.md', () => {
    fs.writeFileSync(
      path.join(upgrades, 'next', 'a.md'),
      makeFragment({ bump: 'patch', whatChanged: 'A.', wttyu: 'I did A.', capabilities: '| A | automatic |' }),
    );
    run();
    const first = fs.readFileSync(path.join(upgrades, 'NEXT.md'), 'utf-8');
    run();
    const second = fs.readFileSync(path.join(upgrades, 'NEXT.md'), 'utf-8');
    expect(second).toBe(first);
  });
});

describe('CANONICAL_SECTIONS export', () => {
  it('matches the four sections the publish validator knows', () => {
    expect(CANONICAL_SECTIONS).toEqual([
      'What Changed',
      'What to Tell Your User',
      'Summary of New Capabilities',
      'Evidence',
    ]);
  });
});

describe('internal-only ship lane', () => {
  // An internal/test-only fragment opts in with <!-- internal-only --> and may
  // omit the two user-facing sections.
  const INTERNAL = [
    '<!-- bump: patch -->',
    '<!-- internal-only -->',
    '',
    '## What Changed',
    '',
    'Refactored an internal test helper; no shipped behavior change.',
    '',
    '## Evidence',
    '',
    'Unit tests pass; tsc clean.',
    '',
  ].join('\n');

  const USER_FACING = [
    '<!-- bump: patch -->',
    '',
    '## What Changed',
    '',
    'Added a user-visible widget.',
    '',
    '## What to Tell Your User',
    '',
    'You can now use the widget.',
    '',
    '## Summary of New Capabilities',
    '',
    'Widget support.',
    '',
    '## Evidence',
    '',
    'Tests.',
    '',
  ].join('\n');

  it('detects the <!-- internal-only --> marker', () => {
    expect(hasInternalOnlyMarker(INTERNAL)).toBe(true);
    expect(hasInternalOnlyMarker(USER_FACING)).toBe(false);
    expect(hasInternalOnlyMarker('<!--internal-only-->\n## What Changed\nx')).toBe(true);
  });

  it('auto-fills both user-facing sections when EVERY fragment is internal-only', () => {
    const out = assembleNextMd([frag('a.md', INTERNAL)]);
    expect(out).toContain('## What to Tell Your User');
    expect(out).toContain('## Summary of New Capabilities');
    // both missing sections filled with the canonical internal text
    expect(out.match(new RegExp(INTERNAL_ONLY_FILL.replace(/[().]/g, '\\$&'), 'g'))).toHaveLength(2);
  });

  it('the auto-filled all-internal guide passes the shared publish validator', () => {
    const out = assembleNextMd([frag('a.md', INTERNAL)]);
    expect(validateGuideContent(out)).toEqual([]);
  });

  it('does NOT auto-fill when any fragment is user-facing (real content wins)', () => {
    const out = assembleNextMd([frag('a.md', INTERNAL), frag('b.md', USER_FACING)]);
    expect(out).toContain('You can now use the widget.');
    expect(out).toContain('Widget support.');
    expect(out).not.toContain(INTERNAL_ONLY_FILL);
    // and the mixed guide is still valid (user sections came from the user fragment)
    expect(validateGuideContent(out)).toEqual([]);
  });

  it('preserves a user section an internal fragment DID write, and fills only the missing one', () => {
    const internalWithOneUserSection = [
      '<!-- bump: patch -->',
      '<!-- internal-only -->',
      '',
      '## What Changed',
      '',
      'Internal change that happens to note one thing.',
      '',
      '## What to Tell Your User',
      '',
      'A genuine note.',
      '',
      '## Evidence',
      '',
      'Tests.',
      '',
    ].join('\n');
    const out = assembleNextMd([frag('a.md', internalWithOneUserSection)]);
    expect(out).toContain('A genuine note.'); // preserved, not overwritten
    expect(out).toContain(INTERNAL_ONLY_FILL); // Summary was missing → filled
    expect(validateGuideContent(out)).toEqual([]);
  });
});
