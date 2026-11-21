/**
 * The pull-request secret scan: its exceptions file may list exact values only,
 * and its workflow runs on every pull request with a pinned, checksummed gitleaks.
 *
 * Why: on 2026-11-21 a folder-wide exception let a planted fake token through a
 * secret scan. The checker here is what the Secret Scan workflow runs first.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import {
  allowlistProblems,
  checkFile,
  literalRegexProblem,
  regexForExactValue,
  tomlLineForExactValue,
} from '../../scripts/lint-gitleaks-allowlist-exact.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG = path.join(ROOT, '.gitleaks.toml');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'secret-scan.yml');

const BASE = { title: 't', extend: { useDefault: true } };

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
    expect(literalRegexProblem('^\\d+$')).toMatch(/character class/);
    expect(literalRegexProblem('^$')).toMatch(/empty/);
    expect(literalRegexProblem('^a\\$')).toMatch(/trailing backslash|unescaped/);
  });
});

describe('allowlistProblems', () => {
  it('refuses a path or folder exception, the 2026-11-21 escape', () => {
    const p = allowlistProblems({ ...BASE, allowlist: { regexTarget: 'secret', paths: ['tests/.*'] } });
    expect(p.join('\n')).toMatch(/paths is refused.*path or folder/);
  });

  it('refuses commit, stopword, rule-scoped and custom-rule exceptions', () => {
    expect(allowlistProblems({ ...BASE, allowlist: { regexTarget: 'secret', commits: ['abc'] } }).join()).toMatch(/commits is refused/);
    expect(allowlistProblems({ ...BASE, allowlist: { regexTarget: 'secret', stopwords: ['x'] } }).join()).toMatch(/stopwords is refused/);
    expect(allowlistProblems({ ...BASE, allowlist: { regexTarget: 'secret', targetRules: ['x'] } }).join()).toMatch(/targetRules is refused/);
    expect(allowlistProblems({ ...BASE, rules: [{ id: 'x', regex: '.*' }] }).join()).toMatch(/custom \[\[rules\]\]/);
    expect(allowlistProblems({ ...BASE, allowlist: [{ regexTarget: 'secret' }, { regexTarget: 'secret' }] }).join()).toMatch(/more than one/);
  });

  it('refuses a regex that is not one exact value, a wrong target, and a disabled default rule set', () => {
    expect(allowlistProblems({ ...BASE, allowlist: { regexTarget: 'secret', regexes: ['^sk-.*$'] } }).join()).toMatch(/regexes\[0\] is not one exact value/);
    expect(allowlistProblems({ ...BASE, allowlist: { regexTarget: 'line', regexes: ['^abc$'] } }).join()).toMatch(/regexTarget must be "secret"/);
    expect(allowlistProblems({ title: 't', extend: { useDefault: false }, allowlist: { regexTarget: 'secret' } }).join()).toMatch(/useDefault must be true/);
    expect(allowlistProblems({ ...BASE, allowlist: { regexTarget: 'secret', regexes: ['^abc$', '^abc$'] } }).join()).toMatch(/repeats/);
  });

  it('accepts exact values only, and a config with no exceptions at all', () => {
    expect(allowlistProblems({ ...BASE, allowlist: { description: 'd', regexTarget: 'secret', regexes: ['^abc$', regexForExactValue('ghp_x.y')] } })).toEqual([]);
    expect(allowlistProblems(BASE)).toEqual([]);
  });
});

describe('the committed .gitleaks.toml', () => {
  it('parses, extends the default rules, and lists exact values only', () => {
    const r = checkFile(CONFIG);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.entries).toBeGreaterThan(0);
    const text = fs.readFileSync(CONFIG, 'utf8');
    expect(text).toMatch(/EXACT VALUES ONLY/);
    expect(text).not.toMatch(/^\s*paths\s*=/m);
  });
});

describe('the Secret Scan workflow', () => {
  const text = fs.readFileSync(WORKFLOW, 'utf8');

  it('runs on every pull request to main and on pushes to main, with the checker first', () => {
    expect(text).toMatch(/on:\s*\n\s*pull_request:\s*\n\s*branches: \[main\]\s*\n\s*push:\s*\n\s*branches: \[main\]/);
    const checker = text.indexOf('node scripts/lint-gitleaks-allowlist-exact.mjs');
    const install = text.indexOf('Install gitleaks');
    const scan = text.indexOf('gitleaks git ');
    expect(checker).toBeGreaterThan(0);
    expect(checker).toBeLessThan(install);
    expect(install).toBeLessThan(scan);
  });

  it('pins the gitleaks release and its sha256, and verifies before running it', () => {
    expect(text).toMatch(/GITLEAKS_VERSION: \d+\.\d+\.\d+/);
    expect(text).toMatch(/GITLEAKS_SHA256: [0-9a-f]{64}/);
    expect(text).toMatch(/sha256sum --check --strict/);
    expect(text).toMatch(/gitleaks_\$\{GITLEAKS_VERSION\}_linux_x64\.tar\.gz/);
  });

  it('scans only the commits the pull request adds, with the exceptions file, redacted, and fails on a finding', () => {
    expect(text).toMatch(/BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}/);
    expect(text).toMatch(/--log-opts="\$RANGE"/);
    expect(text).toMatch(/--config \.gitleaks\.toml/);
    expect(text).toMatch(/--redact --exit-code 1/);
    expect(text).toMatch(/fetch-depth: 0/);
    expect(text).toMatch(/persist-credentials: false/);
    expect(text).toMatch(/permissions:\s*\n\s*contents: read/);
    expect(text).toMatch(/timeout-minutes: \d+/);
  });
});
