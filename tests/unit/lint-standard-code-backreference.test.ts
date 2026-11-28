// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    expect(run(root).code).toBe(0);
    fs.writeFileSync(path.join(root, 'src/core/WidgetGate.ts'), `// Governed by: *${LONG}*\nexport {};\n`);
    const r = run(root);
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
    expect(run(root).code).toBe(0);
    const again = write();
    expect(again.status).toBe(1);
    expect(`${again.stdout}${again.stderr}`).toContain('refusing --write-infrastructure-baseline');
  });
});
