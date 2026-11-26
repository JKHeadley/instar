/**
 * Tier-1: which files may go to a borrowed helper (docs/specs/local-verify-borrowed-slices-count.md, D,
 * amending docs/specs/local-verify-borrowed-unit-slices.md, D): the requested lane, the fixed
 * Mac-only list, the learned list with the retrial bypass; the word scan as a RECORDED signal that
 * no longer excludes (call sites and string literals only, never identifiers or comments; hits in
 * the test file and its direct imports, deeper hits apart; every hit carries file / matchedFile /
 * line / pattern), the time-weighted share of files with a hit, and the canary fixtures staying
 * out of the normal unit lane.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BORROWED_EXCLUDE, directImports, excludedBy, isBorrowableTestFile, isBorrowedCanaryFile, judgeEligibility, laneOfTestFile, scanHitShare, scanSource, scanTestFile, type TreeReader,
} from '../../../src/localVerify/borrowedEligibility.js';
import { BORROWED_CANARY_FILES } from '../../../src/localVerify/borrowedCanary.js';
import { computeInventory, LANES } from '../../../src/localVerify/inventory.js';
import { matchesAny } from '../../../src/localVerify/glob.js';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const reader = (files: Record<string, string>): TreeReader => ({ read: async (f) => files[f] ?? null });

describe('the fixed exclude list', () => {
  it('excludes the desktop helper, Chrome/CDP, the Codex CLI, launchd and tmux tests', () => {
    expect(BORROWED_EXCLUDE.map((e) => e.id)).toEqual(['desktop-helper', 'chrome-cdp', 'codex-tool', 'launchd', 'tmux']);
    expect(excludedBy('tests/unit/DirectDesktopAccess.locked.test.ts')).toBe('desktop-helper');
    expect(excludedBy('tests/unit/ChromeCdpReloginBrowser.test.ts')).toBe('chrome-cdp');
    expect(excludedBy('tests/unit/codex-arm.test.ts')).toBe('codex-tool');
    expect(excludedBy('tests/unit/launchdSpawn.test.ts')).toBe('launchd');
    expect(excludedBy('tests/unit/tmux-send.test.ts')).toBe('tmux');
    expect(excludedBy('tests/unit/record.test.ts')).toBeNull();
  });
});

describe('the literal scan', () => {
  it('hits spawn/exec call sites whose command literal is launchctl, osascript, tmux, open or security', () => {
    const src = [
      "import { spawn, execFile } from 'node:child_process';",
      "spawn('launchctl', ['list']);",
      'execFile("osascript", ["-e", "x"]);',
      'child.exec(`tmux ls`);',
      "spawnSync('open', [url]);",
      "execFileSync('security', ['find-generic-password']);",
      "spawn('git', ['status']);",
    ].join('\n');
    expect(scanSource(src)).toEqual([
      { line: 2, pattern: 'spawn-launchctl' }, { line: 3, pattern: 'spawn-osascript' }, { line: 4, pattern: 'spawn-tmux' },
      { line: 5, pattern: 'spawn-open' }, { line: 6, pattern: 'spawn-security' },
    ]);
  });

  it('hits literal paths under /Library/ or ~/, homedir() calls and process.env.HOME reads', () => {
    const src = [
      "const a = '/Library/LaunchAgents/x.plist';",
      'const b = `~/Documents/${name}`;',
      'const c = os.homedir();',
      'const d = process.env.HOME;',
      "const e = process.env['HOME'];",
    ].join('\n');
    expect(scanSource(src).map((h) => [h.line, h.pattern])).toEqual([[1, 'literal-library-path'], [2, 'literal-home-path'], [3, 'homedir-call'], [4, 'env-home-read'], [5, 'env-home-read']]);
  });

  it('never matches identifiers, comments, or mentions inside other strings', () => {
    const src = [
      '// spawn(\'tmux\', []) in a comment',
      '/* os.homedir() and /Library/ in a block comment */',
      'const homedir = 1; const launchctl = homedir;',
      "const msg = 'call homedir() later';",
      "const re = /'tmux'/; spawn(cmd, []);",
      'const HOME_DIR = process.env.HOMEPATH;',
    ].join('\n');
    expect(scanSource(src)).toEqual([]);
  });

  it('direct imports are recorded as hits; deeper imports as deep hits; type-only imports are skipped', async () => {
    const files = {
      'tests/unit/a.test.ts': "import { x } from '../../src/x.js';\nimport type { T } from '../../src/t.js';\n",
      'src/x.ts': "import { y } from './y.js';\nexport const x = 1;\n",
      'src/y.ts': "export const y = require('os').homedir();\n",
      'src/t.ts': 'export const t = process.env.HOME;\n',
      'tests/unit/b.test.ts': "import { z } from '../../src/z';\n",
      'src/z/index.ts': "export const z = '~/x';\n",
    };
    expect(directImports('tests/unit/a.test.ts', files['tests/unit/a.test.ts'])).toEqual(['src/x.js']);
    const a = await scanTestFile('tests/unit/a.test.ts', reader(files));
    expect(a.hits).toEqual([]);
    expect(a.deepHits).toEqual([{ file: 'tests/unit/a.test.ts', matchedFile: 'src/y.ts', line: 1, pattern: 'homedir-call' }]);
    const b = await scanTestFile('tests/unit/b.test.ts', reader(files));
    expect(b.hits).toEqual([{ file: 'tests/unit/b.test.ts', matchedFile: 'src/z/index.ts', line: 1, pattern: 'literal-home-path' }]);
  });
});

describe('what the scan cannot read is recorded, and blocks nothing', () => {
  it('an unreadable or oversized test file, or an unreadable or unresolvable direct import, is a recorded hit on an eligible file', async () => {
    const throwing: TreeReader = { read: async (f) => { if (f === 'tests/unit/locked.test.ts' || f === 'src/locked.ts') throw new Error('EACCES'); return files[f] ?? null; } };
    const files: Record<string, string> = {
      'tests/unit/big.test.ts': 'x'.repeat(1024 * 1024 + 1),
      'tests/unit/imp.test.ts': "import { a } from '../../src/locked.js';\n",
      'tests/unit/gone.test.ts': "import { b } from '../../src/gone.js';\n",
      'tests/unit/fine.test.ts': "it('x', () => {});\n",
    };
    expect((await scanTestFile('tests/unit/locked.test.ts', throwing)).hits).toEqual([{ file: 'tests/unit/locked.test.ts', matchedFile: 'tests/unit/locked.test.ts', line: 0, pattern: 'unreadable' }]);
    expect((await scanTestFile('tests/unit/big.test.ts', throwing)).hits.map((h) => h.pattern)).toEqual(['oversize']);
    expect((await scanTestFile('tests/unit/imp.test.ts', throwing)).hits).toEqual([{ file: 'tests/unit/imp.test.ts', matchedFile: 'src/locked.ts', line: 0, pattern: 'unreadable' }]);
    expect((await scanTestFile('tests/unit/gone.test.ts', throwing)).hits.map((h) => [h.matchedFile, h.pattern])).toEqual([['src/gone.js', 'unreadable']]);
    const v = await judgeEligibility(Object.keys(files).concat('tests/unit/locked.test.ts'), 'unit', throwing, new Set());
    expect(v.map((x) => [x.file, x.eligible, x.reason, x.hits.map((h) => h.pattern)])).toEqual([
      ['tests/unit/big.test.ts', true, null, ['oversize']], ['tests/unit/imp.test.ts', true, null, ['unreadable']], ['tests/unit/gone.test.ts', true, null, ['unreadable']],
      ['tests/unit/fine.test.ts', true, null, []], ['tests/unit/locked.test.ts', true, null, ['unreadable']],
    ]);
  });
});

describe('judgeEligibility: the lane, the Mac-only list and the learned list', () => {
  const files = {
    'tests/unit/ok.test.ts': "it('x', () => {});\n",
    'tests/unit/home.test.ts': 'const h = process.env.HOME;\n',
    'tests/unit/tmux-a.test.ts': "it('x', () => {});\n",
    'tests/unit/learned.test.ts': "it('x', () => {});\n",
    'tests/integration/i.test.ts': "it('x', () => {});\n",
    'tests/integration/home-i.test.ts': "import os from 'node:os';\nconst h = os.homedir();\n",
    'tests/integration/launchd-install.test.ts': "it('x', () => {});\n",
    'tests/e2e/life.test.ts': "it('x', () => {});\n",
    'tests/e2e/chrome-login.test.ts': "it('x', () => {});\n",
  };

  it('a file belongs to exactly the lane the inventory gives it', () => {
    expect(laneOfTestFile('tests/unit/ok.test.ts')).toBe('unit');
    expect(laneOfTestFile('tests/unit/localVerify/helper/deep.test.ts')).toBe('unit');
    expect(laneOfTestFile('tests/integration/i.test.ts')).toBe('integration');
    expect(laneOfTestFile('tests/e2e/life.test.ts')).toBe('e2e');
    // Not a laned test file: a fixture, a source file, a helper, a stray test outside the lanes.
    expect(laneOfTestFile('tests/fixtures/borrowed-canary/canary-pass.test.ts')).toBeNull();
    expect(laneOfTestFile('src/localVerify/record.ts')).toBeNull();
    expect(laneOfTestFile('tests/helpers/fakeSandboxDriver.ts')).toBeNull();
    expect(laneOfTestFile('src/x.test.ts')).toBeNull();
    expect(isBorrowableTestFile('tests/integration/i.test.ts', 'integration')).toBe(true);
    expect(isBorrowableTestFile('tests/integration/i.test.ts', 'unit')).toBe(false);
    expect(isBorrowableTestFile('tests/unit/ok.test.ts', 'e2e')).toBe(false);
  });

  it('a unit request: unit files go unless Mac-only or learned; a file of another lane is wrong-lane; a scan hit goes and is recorded', async () => {
    const v = await judgeEligibility(Object.keys(files), 'unit', reader(files), new Set(['tests/unit/learned.test.ts']));
    expect(v.map((x) => [x.file, x.reason])).toEqual([
      ['tests/unit/ok.test.ts', null], ['tests/unit/home.test.ts', null], ['tests/unit/tmux-a.test.ts', 'excluded'],
      ['tests/unit/learned.test.ts', 'learned'], ['tests/integration/i.test.ts', 'wrong-lane'], ['tests/integration/home-i.test.ts', 'wrong-lane'],
      ['tests/integration/launchd-install.test.ts', 'wrong-lane'], ['tests/e2e/life.test.ts', 'wrong-lane'], ['tests/e2e/chrome-login.test.ts', 'wrong-lane'],
    ]);
    const home = v.find((x) => x.file === 'tests/unit/home.test.ts')!;
    expect(home.eligible).toBe(true);
    // The recorded shape is the first design's, so a later audit reads old and new rows alike.
    expect(home.hits).toEqual([{ file: 'tests/unit/home.test.ts', matchedFile: 'tests/unit/home.test.ts', line: 1, pattern: 'env-home-read' }]);
    expect(v.find((x) => x.file === 'tests/unit/tmux-a.test.ts')).toMatchObject({ eligible: false, excludeId: 'tmux' });
  });

  it('an integration request and an e2e request: the same rules, each on its own lane', async () => {
    const i = await judgeEligibility(Object.keys(files), 'integration', reader(files), new Set());
    expect(i.filter((x) => x.reason !== 'wrong-lane').map((x) => [x.file, x.eligible, x.reason, x.hits.length])).toEqual([
      ['tests/integration/i.test.ts', true, null, 0], ['tests/integration/home-i.test.ts', true, null, 1], ['tests/integration/launchd-install.test.ts', false, 'excluded', 0],
    ]);
    expect(i.filter((x) => x.reason === 'wrong-lane').length).toBe(6);
    const e = await judgeEligibility(Object.keys(files), 'e2e', reader(files), new Set(['tests/e2e/life.test.ts']));
    expect(e.filter((x) => x.reason !== 'wrong-lane').map((x) => [x.file, x.reason])).toEqual([['tests/e2e/life.test.ts', 'learned'], ['tests/e2e/chrome-login.test.ts', 'excluded']]);
  });

  it('a retrial bypasses only the learned exclusion; the Mac-only list and the lane still refuse', async () => {
    const learned = new Set(['tests/unit/learned.test.ts', 'tests/unit/tmux-a.test.ts', 'tests/integration/i.test.ts']);
    const r = await judgeEligibility(['tests/unit/learned.test.ts', 'tests/unit/home.test.ts', 'tests/unit/tmux-a.test.ts', 'tests/integration/i.test.ts'], 'unit', reader(files), learned, { bypassLearned: learned });
    expect(r.map((x) => x.reason)).toEqual([null, null, 'excluded', 'wrong-lane']);
  });

  it('a learned-list file keeps its recorded hits; scan: false (the helper) reads nothing and records nothing', async () => {
    const learned = new Set(['tests/unit/home.test.ts']);
    const on = await judgeEligibility(['tests/unit/home.test.ts'], 'unit', reader(files), learned);
    expect(on[0]).toMatchObject({ eligible: false, reason: 'learned' });
    expect(on[0].hits.map((h) => h.pattern)).toEqual(['env-home-read']);
    let reads = 0;
    const counting: TreeReader = { read: async (f) => { reads++; return (files as Record<string, string>)[f] ?? null; } };
    const off = await judgeEligibility(['tests/unit/home.test.ts', 'tests/unit/ok.test.ts'], 'unit', counting, new Set(), { scan: false });
    expect(off.map((x) => [x.eligible, x.hits, x.deepHits])).toEqual([[true, [], []], [true, [], []]]);
    expect(reads).toBe(0);
  });

  it('records the time-weighted share of the lane that carries a scan hit', async () => {
    const v = await judgeEligibility(['tests/unit/ok.test.ts', 'tests/unit/home.test.ts'], 'unit', reader(files), new Set());
    expect(scanHitShare(v, { 'tests/unit/ok.test.ts': 3000, 'tests/unit/home.test.ts': 1000 })).toBe(0.25);
    expect(scanHitShare(v, {})).toBe(0);
    expect(scanHitShare(v.filter((x) => x.hits.length === 0), { 'tests/unit/ok.test.ts': 3000 })).toBe(0);
  });
});

describe('the canary fixtures', () => {
  it('exist, are borrowable under a request of any lane, and are NOT in the normal unit lane inventory or the unit vitest config', () => {
    for (const f of BORROWED_CANARY_FILES) {
      expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
      expect(isBorrowedCanaryFile(f)).toBe(true);
      for (const lane of ['unit', 'integration', 'e2e'] as const) expect(isBorrowableTestFile(f, lane), `${f} ${lane}`).toBe(true);
    }
    const inv = computeInventory([...BORROWED_CANARY_FILES, 'tests/unit/a.test.ts']);
    expect(inv.files.map((x) => x.path)).toEqual(['tests/unit/a.test.ts']);
    expect(inv.errors).toEqual([]);
    const unitInclude = LANES.find((l) => l.name === 'unit')!.include;
    expect(BORROWED_CANARY_FILES.some((f) => matchesAny(f, unitInclude))).toBe(false);
    const cfg = fs.readFileSync(path.join(ROOT, 'vitest.config.ts'), 'utf-8');
    expect(cfg).not.toContain('borrowed-canary');
    expect(cfg).not.toMatch(/'tests\/fixtures/);
  });
});
