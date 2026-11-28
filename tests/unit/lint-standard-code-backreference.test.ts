// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
// safe-git-allow: test file — git init/commit/checkout only inside a throwaway fixture repository.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// The return half of the reference graph (References Run From Both Ends — the Registry Names the
// Code, the Code Names the Standard): every file the registry cites as enforcement must name a
// real article back. This file drives the real lint over small fixture trees.
const LINT = path.resolve('scripts/lint-standard-code-backreference.mjs');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'lint-standard-code-backreference.test.ts' }); });

function fixture(opts: { articles: Array<{ title: string; cites: string[] }>; files: Record<string, string>; baseline?: string[] | null }): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backref-lint-')));
  dirs.push(root);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const registry = ['# Standards', ''].concat(opts.articles.flatMap((a) => [
    `### ${a.title}`, '**Rule.** A rule.', `**Applied through.** ${a.cites.map((c) => `\`${c}\``).join(', ')} — the guard.`, '',
  ])).join('\n');
  fs.writeFileSync(path.join(root, 'docs/STANDARDS-REGISTRY.md'), registry);
  if (opts.baseline !== null) fs.writeFileSync(path.join(root, 'docs/standards-backreference-baseline.json'), JSON.stringify({ grandfatheredNoBackreference: opts.baseline ?? [] }));
  for (const [rel, body] of Object.entries(opts.files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}
function run(root: string): { code: number; out: string } {
  const r = spawnSync(process.execPath, [LINT], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
}
const LONG = 'Capacity Safety — No Unbounded Self-Action';

describe('lint-standard-code-backreference', () => {
  it('passes when every cited file names the article, by full title or by the part before the dash', () => {
    const root = fixture({
      articles: [{ title: LONG, cites: ['scripts/a.mjs', 'src/b.ts'] }],
      files: { 'scripts/a.mjs': `// Governed by: *${LONG}*\nexport {};\n`, 'src/b.ts': '// Enforces Capacity Safety.\nexport {};\n' },
    });
    const r = run(root);
    expect(r.out).toContain('2 cited file(s), 2 naming a standard back, 0 grandfathered');
    expect(r.code).toBe(0);
  });

  it('fails a cited file that names no standard, and names the file', () => {
    const root = fixture({ articles: [{ title: LONG, cites: ['scripts/a.mjs'] }], files: { 'scripts/a.mjs': 'export {};\n' } });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('scripts/a.mjs is cited by the registry as enforcement but names NO standard back');
  });

  it('a marker that names no real article is not a back-reference', () => {
    const root = fixture({ articles: [{ title: LONG, cites: ['scripts/a.mjs'] }], files: { 'scripts/a.mjs': '// Governed by: the usual rules\nexport {};\n' } });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('carries a back-reference MARKER that names no real registry article');
  });

  it('a title of twelve characters or fewer counts only in its emphasised form', () => {
    const cited = { articles: [{ title: 'Self-Hosting', cites: ['src/f.ts'] }] };
    // Plain prose that happens to contain the words: not a reference.
    const prose = run(fixture({ ...cited, files: { 'src/f.ts': '// This module supports Self-Hosting setups.\nexport {};\n' } }));
    expect(prose.code).toBe(1);
    expect(prose.out).toContain('src/f.ts is cited by the registry as enforcement but names NO standard back');
    // The registry's own way of writing an article name: a reference.
    const emphasised = run(fixture({ ...cited, files: { 'src/f.ts': '// Governed by: *Self-Hosting*\nexport {};\n' } }));
    expect(emphasised.out).toContain('1 naming a standard back');
    expect(emphasised.code).toBe(0);
  });

  it('a long title is still matched as a bare substring (unchanged behaviour)', () => {
    const root = fixture({ articles: [{ title: 'Observable Intelligence — No Autonomous LLM Action Is Unauditable', cites: ['src/t.ts'] }], files: { 'src/t.ts': '/** Types for Observable Intelligence. */\nexport {};\n' } });
    expect(run(root).code).toBe(0);
  });

  it('only the first 4000 characters of a file count as its header', () => {
    const root = fixture({ articles: [{ title: LONG, cites: ['src/late.ts'] }], files: { 'src/late.ts': `${'// filler\n'.repeat(500)}// Governed by: *${LONG}*\n` } });
    expect(run(root).code).toBe(1);
  });

  it('the baseline may only shrink: a grandfathered file that now has a reference must leave it', () => {
    const root = fixture({ articles: [{ title: LONG, cites: ['scripts/a.mjs'] }], files: { 'scripts/a.mjs': `// Governed by: *${LONG}*\n` }, baseline: ['scripts/a.mjs'] });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('is baselined as lacking a back-reference but now has one');
  });

  it('a grandfathered file with no reference passes and is counted; a missing baseline fails', () => {
    const base = { articles: [{ title: LONG, cites: ['scripts/a.mjs'] }], files: { 'scripts/a.mjs': 'export {};\n' } };
    const ok = run(fixture({ ...base, baseline: ['scripts/a.mjs'] }));
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('1 grandfathered');
    const none = run(fixture({ ...base, baseline: null }));
    expect(none.code).toBe(1);
    expect(none.out).toContain('no baseline at docs/standards-backreference-baseline.json');
  });

  it('paths outside an enforcement field, or outside src/ scripts/ skills/, are not cited files', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backref-lint-')));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/STANDARDS-REGISTRY.md'), [`### ${LONG}`, '**Earned from.** `src/postmortem.ts` broke once.', '**Applied through.** `tests/unit/x.test.ts` and `docs/notes.js`.', ''].join('\n'));
    fs.writeFileSync(path.join(root, 'docs/standards-backreference-baseline.json'), JSON.stringify({ grandfatheredNoBackreference: [] }));
    const r = run(root);
    expect(r.out).toContain('0 cited file(s)');
    expect(r.code).toBe(0);
  });

  it('the live tree is clean with an empty baseline', () => {
    const r = spawnSync(process.execPath, [LINT], { cwd: path.resolve('.'), encoding: 'utf8' });
    expect(`${r.stdout}${r.stderr}`).toContain('0 grandfathered');
    expect(r.status).toBe(0);
    expect(JSON.parse(fs.readFileSync('docs/standards-backreference-baseline.json', 'utf8')).grandfatheredNoBackreference).toEqual([]);
  });
});

// The widened population (STD-SUBCOUNTDOWN-backreference-completion, second half): decision
// infrastructure the registry has never cited must also name its standard, with a shrink-only
// baseline for files that predate the check.
describe('lint-standard-code-backreference — widened infrastructure population', () => {
  const INFRA = 'docs/standards-backreference-infrastructure-baseline.json';
  function withInfra(root: string, entries: string[]): void {
    fs.writeFileSync(path.join(root, INFRA), JSON.stringify({ grandfatheredInfrastructure: entries }));
  }
  // The real script carries the reviewed ceiling for the real baseline. A fixture with its own small
  // baseline runs a COPY of the lint whose ceiling is set to the fixture's size — no environment
  // override exists, because one would be a way to switch the ceiling off.
  // Pins the ceiling and the content hash in a copy of the lint. By default the hash is taken from
  // the fixture's own baseline (the reviewed list); `pinned` pins a different list, to test a swap.
  function runWithCeiling(root: string, ceiling: number, args: string[] = [], pinned?: string[]): { code: number; out: string } {
    const src = fs.readFileSync(LINT, 'utf8');
    expect(src).toMatch(/const INFRA_BASELINE_CEILING = \d+;/);
    expect(src).toMatch(/const INFRA_BASELINE_SHA256 = '[0-9a-f]{64}';/);
    let entries: unknown[] = pinned ?? [];
    if (!pinned) {
      try { entries = JSON.parse(fs.readFileSync(path.join(root, 'docs/standards-backreference-infrastructure-baseline.json'), 'utf8')).grandfatheredInfrastructure ?? []; } catch { entries = []; }
    }
    const hash = createHash('sha256').update(JSON.stringify([...entries].map(String).sort())).digest('hex');
    const copy = path.join(root, 'lint-copy.mjs');
    fs.writeFileSync(copy, src
      .replace(/const INFRA_BASELINE_CEILING = \d+;/, `const INFRA_BASELINE_CEILING = ${ceiling};`)
      .replace(/const INFRA_BASELINE_SHA256 = '[0-9a-f]{64}';/, `const INFRA_BASELINE_SHA256 = '${hash}';`));
    const r = spawnSync(process.execPath, [copy, ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    return { code: r.status ?? -1, out: `${r.stdout}\n${r.stderr}` };
  }

  it('fails a new guard-named file that names no standard, though the registry never cites it', () => {
    const root = fixture({ articles: [{ title: LONG, cites: [] }], files: { 'src/core/WidgetGuard.ts': 'export {};\n' } });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/core/WidgetGuard.ts is decision infrastructure');
  });

  it('treats lint scripts and hook sources as infrastructure, and passes them once they name a standard', () => {
    const files = { 'scripts/lint-widgets.mjs': 'export {};\n', 'src/hooks/stop-thing.ts': 'export {};\n' };
    const bad = run(fixture({ articles: [{ title: LONG, cites: [] }], files }));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('scripts/lint-widgets.mjs is decision infrastructure');
    expect(bad.out).toContain('src/hooks/stop-thing.ts is decision infrastructure');
    const good = run(fixture({
      articles: [{ title: LONG, cites: [] }],
      files: Object.fromEntries(Object.keys(files).map((k) => [k, `// Governed by: *${LONG}*\nexport {};\n`])),
    }));
    expect(good.code).toBe(0);
    expect(good.out).toContain('2 further infrastructure file(s), 2 naming a standard back, 0 grandfathered');
  });

  it('a baselined infrastructure file passes, and must leave the baseline once it names a standard', () => {
    const root = fixture({ articles: [{ title: LONG, cites: [] }], files: { 'src/core/WidgetGate.ts': 'export {};\n' } });
    withInfra(root, ['src/core/WidgetGate.ts']);
    expect(runWithCeiling(root, 1).code).toBe(0);
    fs.writeFileSync(path.join(root, 'src/core/WidgetGate.ts'), `// Governed by: *${LONG}*\nexport {};\n`);
    const r = runWithCeiling(root, 1);
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/core/WidgetGate.ts is in the infrastructure baseline but now names a standard');
  });

  it('ignores ordinary files, templates and declaration files', () => {
    const root = fixture({
      articles: [{ title: LONG, cites: [] }],
      files: { 'src/core/Widget.ts': 'export {};\n', 'src/scaffold/templates/x/FooGuard.ts': 'export {};\n', 'src/types/BarGate.d.ts': 'export {};\n' },
    });
    const r = run(root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('0 further infrastructure file(s)');
  });

  it('an absent infrastructure baseline counts as empty, so deleting it cannot switch the check off', () => {
    const root = fixture({ articles: [{ title: LONG, cites: [] }], files: { 'src/core/WidgetSentinel.ts': 'export {};\n' } });
    expect(fs.existsSync(path.join(root, INFRA))).toBe(false);
    expect(run(root).code).toBe(1);
  });

  it('writes the infrastructure baseline once, and refuses to rewrite it', () => {
    const root = fixture({ articles: [{ title: LONG, cites: [] }], files: { 'src/core/WidgetWatchdog.ts': 'export {};\n' } });
    const write = () => spawnSync(process.execPath, [LINT, '--write-infrastructure-baseline'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    expect(write().status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(root, INFRA), 'utf8')).grandfatheredInfrastructure).toEqual(['src/core/WidgetWatchdog.ts']);
    expect(runWithCeiling(root, 1).code).toBe(0);
    const again = write();
    expect(again.status).toBe(1);
    expect(`${again.stdout}${again.stderr}`).toContain('refusing --write-infrastructure-baseline');
  });

  it('refuses a hand-added baseline entry: the ceiling in the reviewed lint must equal the baseline size', () => {
    const root = fixture({ articles: [{ title: LONG, cites: [] }], files: { 'src/core/OldGate.ts': 'export {};\n', 'src/core/NewGate.ts': 'export {};\n' } });
    withInfra(root, ['src/core/OldGate.ts', 'src/core/NewGate.ts']);
    const over = runWithCeiling(root, 1);
    expect(over.code).toBe(1);
    expect(over.out).toContain('above the ceiling of 1');
    const under = runWithCeiling(root, 3);
    expect(under.code).toBe(1);
    expect(under.out).toContain('Lower INFRA_BASELINE_CEILING');
    expect(runWithCeiling(root, 2).code).toBe(0);
  });

  it('a corrupt or malformed baseline is a named failure, never a silent empty or pass', () => {
    const root = fixture({ articles: [{ title: LONG, cites: [] }], files: { 'src/core/WidgetGuard.ts': `// Governed by: *${LONG}*\nexport {};\n` } });
    fs.writeFileSync(path.join(root, INFRA), '{ not json');
    const bad = runWithCeiling(root, 0);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('baseline.json is unreadable');
    fs.writeFileSync(path.join(root, INFRA), JSON.stringify({ grandfatheredInfrastructure: 'src/core/WidgetGuard.ts' }));
    const malformed = runWithCeiling(root, 0);
    expect(malformed.code).toBe(1);
    expect(malformed.out).toContain('baseline.json is malformed');
  });

  it('flags a stale baseline entry for a file that was deleted or is no longer infrastructure', () => {
    const root = fixture({ articles: [{ title: LONG, cites: [] }], files: { 'src/core/Widget.ts': 'export {};\n' } });
    withInfra(root, ['src/core/GoneGuard.ts']);
    const r = runWithCeiling(root, 1);
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/core/GoneGuard.ts is in the infrastructure baseline but is no longer infrastructure here');
  });

  it('matches guard words as whole words of the file name, not as substrings', () => {
    const root = fixture({
      articles: [{ title: LONG, cites: [] }],
      files: {
        'src/core/DesktopDelegatedSessionStore.ts': 'export {};\n', 'src/core/navigateTo.ts': 'export {};\n',
        'src/core/aggregateStats.ts': 'export {};\n', 'src/core/SendGateway.ts': 'export {};\n', 'src/threadline/A2AGateway.ts': 'export {};\n',
        'src/core/FencedLease.ts': 'export {};\n', 'src/core/leaseGatedSpawn.ts': 'export {};\n', 'src/core/rate-limiter.ts': 'export {};\n',
        'src/core/GuardedWrite.ts': 'export {};\n', 'src/core/SafeguardStore.ts': 'export {};\n', 'src/core/RunWatchdogs.ts': 'export {};\n',
        'src/core/Regatta.ts': 'export {};\n', 'src/core/Fenceless.ts': 'export {};\n',
      },
    });
    const r = run(root);
    expect(r.code).toBe(1);
    for (const hit of ['FencedLease.ts', 'leaseGatedSpawn.ts', 'rate-limiter.ts', 'SendGateway.ts', 'GuardedWrite.ts', 'SafeguardStore.ts', 'RunWatchdogs.ts']) {
      expect(r.out).toContain(`src/core/${hit} is decision infrastructure`);
    }
    expect(r.out).toContain('src/threadline/A2AGateway.ts is decision infrastructure');
    for (const miss of ['DesktopDelegatedSessionStore.ts', 'navigateTo.ts', 'aggregateStats.ts', 'Regatta.ts', 'Fenceless.ts']) expect(r.out).not.toContain(`src/core/${miss}`);
  });

  it('refuses a swapped entry: same count, different list, against the reviewed hash', () => {
    const root = fixture({ articles: [{ title: LONG, cites: [] }], files: { 'src/core/OldGate.ts': `// Governed by: *${LONG}*\nexport {};\n`, 'src/core/NewGate.ts': 'export {};\n' } });
    withInfra(root, ['src/core/NewGate.ts']);
    // The reviewed list held OldGate; it was fixed and NewGate took its place.
    const r = runWithCeiling(root, 1, [], ['src/core/OldGate.ts']);
    expect(r.code).toBe(1);
    expect(r.out).toContain("entries differ from the reviewed list pinned in scripts/lint-standard-code-backreference.mjs, though the count matches");
    expect(runWithCeiling(root, 1).code).toBe(0); // the same list, pinned, passes
  });

  it('refuses a shrink-and-add against main, even when the ceiling and hash are updated to match', () => {
    const root = fixture({ articles: [{ title: LONG, cites: [] }], files: {
      'src/core/OldGate.ts': 'export {};\n', 'src/core/FixedGate.ts': 'export {};\n',
    } });
    withInfra(root, ['src/core/FixedGate.ts', 'src/core/OldGate.ts']);
    const git = (...a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', HOME: root } });
    git('init', '-q', '-b', 'main'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'main');
    git('checkout', '-q', '-b', 'change');
    // Fix FixedGate (it leaves the list) and slip an unreferenced NewGate into the freed place.
    fs.writeFileSync(path.join(root, 'src/core/FixedGate.ts'), `// Governed by: *${LONG}*\nexport {};\n`);
    fs.writeFileSync(path.join(root, 'src/core/NewGate.ts'), 'export {};\n');
    withInfra(root, ['src/core/NewGate.ts', 'src/core/OldGate.ts']);
    const r = runWithCeiling(root, 2); // ceiling and hash both pinned to the new list
    expect(r.code).toBe(1);
    expect(r.out).toContain("adds 1 entry that main's copy does not hold: src/core/NewGate.ts");
    // An honest shrink passes against main.
    SafeFsExecutor.safeRmSync(path.join(root, 'src/core/NewGate.ts'), { force: true, operation: 'lint-standard-code-backreference.test.ts' });
    withInfra(root, ['src/core/OldGate.ts']);
    expect(runWithCeiling(root, 1).code).toBe(0);
  });

  it('says so (a NOTE, not a silent pass) when main does not hold the baseline yet', () => {
    const root = fixture({ articles: [{ title: LONG, cites: [] }], files: { 'src/core/OldGate.ts': 'export {};\n' } });
    const git = (...a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', HOME: root } });
    git('init', '-q', '-b', 'main'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'main without a baseline');
    git('checkout', '-q', '-b', 'change');
    withInfra(root, ['src/core/OldGate.ts']);
    const r = runWithCeiling(root, 1);
    expect(r.code).toBe(0);
    expect(r.out).toContain('content check against main skipped');
    expect(r.out).toContain('is not on main yet');
  });

  it("names the failure when main's copy of the baseline is unreadable", () => {
    const root = fixture({ articles: [{ title: LONG, cites: [] }], files: { 'src/core/OldGate.ts': 'export {};\n' } });
    fs.writeFileSync(path.join(root, INFRA), '{ broken json on main');
    const git = (...a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', HOME: root } });
    git('init', '-q', '-b', 'main'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'main with a corrupt baseline');
    git('checkout', '-q', '-b', 'change');
    withInfra(root, ['src/core/OldGate.ts']);
    const r = runWithCeiling(root, 1);
    expect(r.code).toBe(1);
    expect(r.out).toContain("main's copy of docs/standards-backreference-infrastructure-baseline.json");
    expect(r.out).toContain('is unreadable');
  });

  it('refuses duplicate and non-text baseline entries, and a null baseline list', () => {
    const root = fixture({ articles: [{ title: LONG, cites: [] }], files: { 'src/core/OldGate.ts': 'export {};\n' } });
    withInfra(root, ['src/core/OldGate.ts', 'src/core/OldGate.ts']);
    expect(runWithCeiling(root, 1).out).toContain('lists a path more than once');
    fs.writeFileSync(path.join(root, INFRA), JSON.stringify({ grandfatheredInfrastructure: ['src/core/OldGate.ts', 7] }));
    expect(runWithCeiling(root, 1, [], ['src/core/OldGate.ts']).out).toContain('baseline.json is malformed');
    fs.writeFileSync(path.join(root, INFRA), JSON.stringify({ grandfatheredInfrastructure: null }));
    const nul = runWithCeiling(root, 0);
    expect(nul.code).toBe(1);
    expect(nul.out).toContain('baseline.json is malformed');
  });
});
