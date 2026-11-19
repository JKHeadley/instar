/**
 * Tier-1: which files may go to a borrowed helper (docs/specs/local-verify-borrowed-unit-slices.md, D):
 * the fixed exclude list, the literal scan as a hard floor (call sites and string literals only, never
 * identifiers or comments; the test file and its direct imports exclude, deeper hits are recorded only;
 * every hit carries file / matchedFile / line / pattern), the learned list with the retrial bypass,
 * the time-weighted scan share, and the canary fixtures staying out of the normal unit lane.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BORROWED_EXCLUDE, directImports, excludedBy, isBorrowableTestFile, isBorrowedCanaryFile, judgeEligibility, scanIneligibleShare, scanSource, scanTestFile, type TreeReader,
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

  it('direct imports exclude; deeper imports are recorded only; type-only imports are skipped', async () => {
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

describe('the scan fails closed', () => {
  it('an unreadable or oversized test file, or an unreadable or unresolvable direct import, is a counted hit', async () => {
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
    const v = await judgeEligibility(Object.keys(files).concat('tests/unit/locked.test.ts'), throwing, new Set());
    expect(v.map((x) => [x.file, x.reason])).toEqual([
      ['tests/unit/big.test.ts', 'scan-hit'], ['tests/unit/imp.test.ts', 'scan-hit'], ['tests/unit/gone.test.ts', 'scan-hit'],
      ['tests/unit/fine.test.ts', null], ['tests/unit/locked.test.ts', 'scan-hit'],
    ]);
  });
});

describe('judgeEligibility and the learned list', () => {
  const files = {
    'tests/unit/ok.test.ts': "it('x', () => {});\n",
    'tests/unit/home.test.ts': 'const h = process.env.HOME;\n',
    'tests/unit/tmux-a.test.ts': "it('x', () => {});\n",
    'tests/unit/learned.test.ts': "it('x', () => {});\n",
    'tests/integration/i.test.ts': "it('x', () => {});\n",
  };
  it('passes only unit files that clear all three checks; a retrial bypasses only the learned exclusion', async () => {
    const v = await judgeEligibility(Object.keys(files), reader(files), new Set(['tests/unit/learned.test.ts']));
    expect(v.map((x) => [x.file, x.reason])).toEqual([
      ['tests/unit/ok.test.ts', null], ['tests/unit/home.test.ts', 'scan-hit'], ['tests/unit/tmux-a.test.ts', 'excluded'],
      ['tests/unit/learned.test.ts', 'learned'], ['tests/integration/i.test.ts', 'not-unit'],
    ]);
    const r = await judgeEligibility(['tests/unit/learned.test.ts', 'tests/unit/home.test.ts'], reader(files), new Set(['tests/unit/learned.test.ts']), { bypassLearned: new Set(['tests/unit/learned.test.ts', 'tests/unit/home.test.ts']) });
    expect(r.map((x) => x.reason)).toEqual([null, 'scan-hit']);
  });

  it('audits the time-weighted share of unit time the scan keeps local', async () => {
    const v = await judgeEligibility(['tests/unit/ok.test.ts', 'tests/unit/home.test.ts'], reader(files), new Set());
    expect(scanIneligibleShare(v, { 'tests/unit/ok.test.ts': 3000, 'tests/unit/home.test.ts': 1000 })).toBe(0.25);
  });
});

describe('the canary fixtures', () => {
  it('exist, are borrowable, and are NOT in the normal unit lane inventory or the unit vitest config', () => {
    for (const f of BORROWED_CANARY_FILES) {
      expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
      expect(isBorrowedCanaryFile(f)).toBe(true);
      expect(isBorrowableTestFile(f)).toBe(true);
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
