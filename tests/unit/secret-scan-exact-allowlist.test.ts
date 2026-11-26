// safe-git-allow: test-tmpdir-cleanup — each test removes its own mkdtempSync tmpdir.
/**
 * The pull-request secret scan: its exceptions file may list exact values only,
 * nothing else may excuse a finding, and its workflow runs on every pull request
 * with a pinned, checksummed gitleaks.
 *
 * Why: on 2026-11-21 a folder-wide exception let a planted fake token through a
 * secret scan. The checker here is what the Secret Scan workflow runs first.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import {
  DESCRIPTION,
  TITLE,
  allowlistProblems,
  canonicalText,
  checkFile,
  ignoreFileProblem,
  literalRegexProblem,
  regexForExactValue,
  shadowedByDefaultPaths,
  shadowedChangedPaths,
  secretScanRange,
  tomlLineForExactValue,
} from '../../scripts/lint-gitleaks-allowlist-exact.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG = path.join(ROOT, '.gitleaks.toml');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'secret-scan.yml');

const BASE = { title: TITLE, extend: { useDefault: true } };
const AL = { description: DESCRIPTION, regexTarget: 'secret' as const };

describe('regexForExactValue', () => {
  it('escapes a value so the regex matches that value and nothing else', () => {
    const v = 'sk-live.AbC_9/+=\t"x"\n-----END-----';
    const re = regexForExactValue(v);
    expect(literalRegexProblem(re)).toBeNull();
    const js = new RegExp(re);
    expect(js.test(v)).toBe(true);
    expect(js.test(v + 'x')).toBe(false);
    expect(js.test('sk-live.AbC_9/+=\t"x"\n-----END----')).toBe(false);
    expect(js.test('sk-liveXAbC_9/+=\t"x"\n-----END-----')).toBe(false); // the dot is literal
  });

  it('prints a TOML basic-string line that parses back to the same regex', () => {
    const v = 'k"ey\\with"quotes';
    const line = tomlLineForExactValue(v);
    const parsed = parse(`regexes = [\n${line}\n]`) as { regexes: string[] };
    expect(parsed.regexes).toEqual([regexForExactValue(v)]);
  });
});

describe('literalRegexProblem', () => {
  it('accepts an anchored escaped literal and refuses anything wider', () => {
    expect(literalRegexProblem('^abc_-9\\./ =日\\n$')).toBeNull(); // space, slash and non-ASCII stay literal
    expect(literalRegexProblem('^a\\/b$')).toMatch(/invalid escape/); // RE2 refuses an escaped slash
    expect(literalRegexProblem('abc')).toMatch(/anchored/);
    expect(literalRegexProblem('^sk-.*$')).toMatch(/unescaped '\.'/);
    expect(literalRegexProblem('^ghp_[a-z]+$')).toMatch(/unescaped '\['/);
    expect(literalRegexProblem('^a|b$')).toMatch(/unescaped '\|'/);
    expect(literalRegexProblem('^(?i)abc$')).toMatch(/unescaped '\('/); // no flags
    expect(literalRegexProblem('^\\d+$')).toMatch(/character class/);
    expect(literalRegexProblem('^\\x41$')).toMatch(/character class|invalid escape/);
    expect(literalRegexProblem('^$')).toMatch(/empty/);
    expect(literalRegexProblem('^a\\$')).toMatch(/trailing backslash|unescaped/);
  });
});

describe('allowlistProblems', () => {
  it('refuses a path or folder exception, the 2026-11-21 escape', () => {
    const p = allowlistProblems({ ...BASE, allowlist: { ...AL, paths: ['tests/.*'] } });
    expect(p.join('\n')).toMatch(/paths is refused.*path or folder/);
  });

  it('refuses commit, stopword, rule-scoped and custom-rule exceptions, and other extend keys', () => {
    expect(allowlistProblems({ ...BASE, allowlist: { ...AL, commits: ['abc'] } }).join()).toMatch(/commits is refused/);
    expect(allowlistProblems({ ...BASE, allowlist: { ...AL, stopwords: ['x'] } }).join()).toMatch(/stopwords is refused/);
    expect(allowlistProblems({ ...BASE, allowlist: { ...AL, targetRules: ['x'] } }).join()).toMatch(/targetRules is refused/);
    expect(allowlistProblems({ ...BASE, rules: [{ id: 'x', regex: '.*' }] }).join()).toMatch(/custom \[\[rules\]\]/);
    expect(allowlistProblems({ ...BASE, allowlists: [{ regexTarget: 'secret' }] }).join()).toMatch(/unexpected top-level key "allowlists"/);
    expect(allowlistProblems({ ...BASE, allowlist: [{ ...AL }, { ...AL }] }).join()).toMatch(/more than one/);
    expect(allowlistProblems({ title: TITLE, extend: { useDefault: true, path: 'other.toml' } }).join()).toMatch(/may only set useDefault/);
    expect(allowlistProblems({ title: TITLE, extend: { useDefault: true, disabledRules: ['x'] } }).join()).toMatch(/may only set useDefault/);
  });

  it('fixes title and description, so a token cannot sit in either', () => {
    const tok = 'ghp_' + 'A'.repeat(36);
    expect(allowlistProblems({ ...BASE, allowlist: { regexTarget: 'secret', description: DESCRIPTION } })).toEqual([]);
    expect(allowlistProblems({ ...BASE, allowlist: { regexTarget: 'secret', description: `see ${tok}` } }).join()).toMatch(/description must be exactly/);
    expect(allowlistProblems({ ...BASE, allowlist: { regexTarget: 'secret' } }).join()).toMatch(/description must be exactly/);
    expect(allowlistProblems({ title: `x ${tok}`, extend: { useDefault: true } }).join()).toMatch(/title must be exactly/);
    expect(allowlistProblems({ extend: { useDefault: true } }).join()).toMatch(/title must be exactly/);
  });

  it('refuses a regex that is not one exact value, a wrong target, and a disabled default rule set', () => {
    expect(allowlistProblems({ ...BASE, allowlist: { ...AL, regexes: ['^sk-.*$'] } }).join()).toMatch(/regexes\[0\] is not one exact value/);
    expect(allowlistProblems({ ...BASE, allowlist: { ...AL, regexTarget: 'line', regexes: ['^abc$'] } }).join()).toMatch(/regexTarget must be "secret"/);
    expect(allowlistProblems({ title: TITLE, extend: { useDefault: false }, allowlist: { ...AL } }).join()).toMatch(/useDefault must be true/);
    expect(allowlistProblems({ ...BASE, allowlist: { ...AL, regexes: ['^abc$', '^abc$'] } }).join()).toMatch(/repeats/);
  });

  it('accepts exact values only, and a config with no exceptions at all', () => {
    expect(allowlistProblems({ ...BASE, allowlist: { ...AL, regexes: ['^abc$', regexForExactValue('ghp_x.y')] } })).toEqual([]);
    expect(allowlistProblems(BASE)).toEqual([]);
  });
});

describe('ignoreFileProblem', () => {
  it('refuses a .gitleaksignore in the tree and accepts its absence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-ignore-'));
    try {
      expect(ignoreFileProblem(dir)).toBeNull();
      fs.writeFileSync(path.join(dir, '.gitleaksignore'), 'abc:tests/x.ts:github-pat:1\n');
      expect(ignoreFileProblem(dir)).toMatch(/\.gitleaksignore is refused/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(ignoreFileProblem(ROOT)).toBeNull(); // the repository has none
  });
});

describe('shadowedByDefaultPaths', () => {
  it('names the changed files gitleaks would skip by path alone, global and per-rule, except the policed exceptions file', () => {
    const shadowed = shadowedByDefaultPaths([
      'tests/x/node_modules/a.ts', 'vendor/github.com/x/y.go', 'docs/a.svg', 'assets/f.woff2',
      'notes.gitleaks.toml.md', 'package-lock.json', 'sub/yarn.lock', 'go.sum', 'src/a.ts', 'README.md', '.gitleaks.toml',
      'recipes/x.bb', 'conf/layer.inc', 'docs/@octokit/auth-token/README.md',
    ]);
    expect(shadowed).toEqual([
      'tests/x/node_modules/a.ts', 'vendor/github.com/x/y.go', 'docs/a.svg', 'assets/f.woff2',
      'notes.gitleaks.toml.md', 'package-lock.json', 'sub/yarn.lock', 'go.sum',
      'recipes/x.bb', 'conf/layer.inc', 'docs/@octokit/auth-token/README.md',
    ]);
    expect(shadowedByDefaultPaths(['src/core/a.ts', 'tests/unit/b.test.ts', 'docs/spec.md'])).toEqual([]);
    expect(shadowedByDefaultPaths(['.gitleaks.toml'])).toEqual([]); // the checker polices it; its escaped entries read as keys
    expect(shadowedByDefaultPaths(['sub/.gitleaks.toml'])).toEqual(['sub/.gitleaks.toml']); // only the root file is exempt
  });
});

describe('the committed .gitleaks.toml', () => {
  it('parses, extends the default rules, lists exact values only, and is byte for byte its canonical form', () => {
    const r = checkFile(CONFIG);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.entries).toBeGreaterThan(0);
    const text = fs.readFileSync(CONFIG, 'utf8');
    expect(text).toMatch(/EXACT VALUES ONLY/);
    expect(text).not.toMatch(/^\s*paths\s*=/m);
    expect(text).toBe(canonicalText(parse(text)));
  });

  it('refuses a value hidden in a comment, a blank line, a stray line, the title or the description: the file has no free text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-canon-'));
    try {
      const base = fs.readFileSync(CONFIG, 'utf8');
      const planted = path.join(dir, 'planted.toml');
      fs.writeFileSync(planted, base + '# const t = "ghp_' + 'A'.repeat(36) + '"\n');
      expect(checkFile(planted).problems.join()).toMatch(/not in its canonical form/);
      fs.writeFileSync(planted, base.replace('regexes = [', '# a note that nothing scans\nregexes = ['));
      expect(checkFile(planted).problems.join()).toMatch(/not in its canonical form/);
      fs.writeFileSync(planted, base.replace('regexTarget = "secret"\n', 'regexTarget = "secret"\n\n'));
      expect(checkFile(planted).problems.join()).toMatch(/not in its canonical form/);
      fs.writeFileSync(planted, base.replace(`title = "${TITLE}"`, 'title = "x ghp_' + 'A'.repeat(36) + '"'));
      expect(checkFile(planted).problems.join()).toMatch(/title must be exactly/);
      fs.writeFileSync(planted, base.replace(`description = "${DESCRIPTION}"`, 'description = "ghp_' + 'A'.repeat(36) + '"'));
      expect(checkFile(planted).problems.join()).toMatch(/description must be exactly/);
      fs.writeFileSync(planted, base); // the canonical text itself is accepted
      expect(checkFile(planted).problems).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the Secret Scan workflow', () => {
  const text = fs.readFileSync(WORKFLOW, 'utf8');
  const has = (s: string) => expect(text.includes(s), `workflow should contain ${JSON.stringify(s)}`).toBe(true);

  it('runs on pull requests to main and pushes to main, installs dependencies, and runs the checker before gitleaks', () => {
    has('pull_request:');
    has('push:');
    expect(text.match(/branches: \[main\]/g)?.length).toBe(2);
    const npmci = text.indexOf('npm ci');
    const checker = text.indexOf('node scripts/lint-gitleaks-allowlist-exact.mjs');
    const install = text.indexOf('Install gitleaks');
    const scan = text.indexOf('gitleaks git ');
    expect(npmci).toBeGreaterThan(0);
    expect(npmci).toBeLessThan(checker);
    expect(checker).toBeLessThan(install);
    expect(install).toBeLessThan(scan);
  });

  it('pins the gitleaks release and its sha256, and verifies before running it', () => {
    expect(text).toMatch(/GITLEAKS_VERSION: \d+\.\d+\.\d+/);
    expect(text).toMatch(/GITLEAKS_SHA256: [0-9a-f]{64}/);
    has('sha256sum --check --strict');
    has('gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz');
  });

  it('scans the commits the change adds with every excuse closed, redacted, failing on a finding', () => {
    has('github.event.pull_request.base.sha || github.event.before');
    has('--config .gitleaks.toml');
    has('--redact');
    has('--exit-code 42');
    has('--ignore-gitleaks-allow');
    has('--gitleaks-ignore-path');
    has('gitleaks stdin');
    has('--shadowed-paths');
    has("read -r -d ''"); // NUL-separated list read from a file written under set -e, never a process substitution
    expect(text).not.toMatch(/done < <\(/);
    has('refusing to pass on a short loop');
    has('fetch-depth: 0');
    has('persist-credentials: false');
    expect(text).toMatch(/permissions:\s*\n\s*contents: read/);
    expect(text).toMatch(/timeout-minutes: \d+/);
    // Scanner crashes cannot trigger the credential rotation message.
    expect(text).toMatch(/if: failure\(\) && \(steps\.scan\.outputs\.finding == 'true' \|\| steps\.shadow\.outputs\.finding == 'true'\)/);
  });
});

it('uses complete reachable history and the shadowed head tree for missing and divergent push bases', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-range-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    const commit = (name: string) => {
      fs.writeFileSync(path.join(dir, name), 'synthetic text');
      git('add', name);
      git('commit', '-qm', name);
      return git('rev-parse', 'HEAD');
    };
    const root = commit('package-lock.json');
    const before = commit('old.txt');
    git('switch', '-qc', 'rewritten', root);
    const head = commit('new.txt');
    expect(secretScanRange(root, head, 'push', dir)).toBe(root + '..' + head);
    expect(secretScanRange(root, head, 'pull_request', dir)).toBe(root + '..' + head);
    expect(secretScanRange(before, head, 'push', dir)).toBe(head);
    expect(secretScanRange('0'.repeat(40), head, 'push', dir)).toBe(head);
    expect(secretScanRange('f'.repeat(40), head, 'push', dir)).toBe(head);
    expect(() => secretScanRange('f'.repeat(40), head, 'pull_request', dir)).toThrow();
    expect(shadowedChangedPaths(head, dir)).toContain('package-lock.json');
    expect(shadowedChangedPaths(root + '..' + head, dir)).not.toContain('package-lock.json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('sets the rotation advisory flag only for a confirmed scanner finding', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-finding-'));
  try {
    const block = fs.readFileSync(WORKFLOW, 'utf8').split('        id: scan\n')[1].split('      - name: Scan the content')[0];
    const run = block.split('        run: |\n')[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
    const scanner = path.join(dir, 'gitleaks');
    fs.writeFileSync(scanner, '#!/bin/sh\nexit "$FIXTURE_STATUS"\n', { mode: 0o700 });
    const output = path.join(dir, 'output');
    for (const status of [0, 2, 42]) {
      fs.writeFileSync(output, '');
      const result = spawnSync('/bin/bash', ['-c', run], {
        cwd: dir, encoding: 'utf8',
        env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, GITHUB_OUTPUT: output,
          FIXTURE_STATUS: String(status), RUNNER_TEMP: dir, SCAN_RANGE: 'a'.repeat(40) },
      });
      expect(result.status).toBe(status);
      expect(fs.readFileSync(output, 'utf8')).toBe(status === 42 ? 'finding=true\n' : '');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
