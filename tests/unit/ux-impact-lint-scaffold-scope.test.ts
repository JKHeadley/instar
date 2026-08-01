// safe-git-allow: test file — direct execFileSync builds a throwaway git
//   fixture repo under a per-test tmpdir; the lint under test shells out to
//   git itself and is exercised as a black box. fs.rmSync is tmpdir cleanup.

/**
 * Unit tests for scripts/ux-impact-lint.mjs — user-facing path scope.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Agent Awareness Standard (CLAUDE.md) names `src/scaffold/templates.ts`
 * as THE user-awareness surface: "Every feature added to Instar MUST include a
 * corresponding update to the CLAUDE.md template (`src/scaffold/templates.ts`
 * -> generateClaudeMd()). An agent that doesn't know about a capability
 * effectively doesn't have it."
 *
 * The UX-impact gate's allowlist did not contain that path. A PR touching ONLY
 * that file therefore hit `allowlisted.length === 0` and exited 0 — the gate
 * skipped the change that alters what every agent tells its users.
 *
 * Verified against real commit e29259c49 before this fix: it touches
 * src/scaffold/templates.ts and ZERO allowlisted paths, and the shipping lint
 * answered "UX lint: out of scope" (exit 0).
 *
 * Covers BOTH sides of the decision boundary:
 *   - scaffold/templates.ts alone -> gate ENGAGES (in scope)
 *   - a genuinely internal path alone -> gate still SKIPS (no over-reach)
 *   - a correct declaration quoting the scaffold diff -> PASSES
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LINT = resolve(process.cwd(), 'scripts/ux-impact-lint.mjs');

let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

/** Write `file`, commit it, and return the new HEAD sha. */
function commitFile(file: string, contents: string, message: string): string {
  const full = join(repo, file);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, contents);
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', message);
  return git('rev-parse', 'HEAD');
}

/** Run the lint as CI does and return its exit code + combined output. */
function runLint(base: string, head: string, body: string) {
  const r = spawnSync(
    process.execPath,
    [LINT, '--base', base, '--head', head, '--scope', '', '--pusher', '', '--body', body],
    { cwd: repo, encoding: 'utf8' },
  );
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const DECLARATION_NONE = '## UX Impact\n\nUX-Impact: none';

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'ux-lint-scope-'));
  git('init', '-q');
  commitFile('README.md', 'seed\n', 'seed');
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('ux-impact-lint: user-facing path scope', () => {
  it('ENGAGES on a change touching only src/scaffold/templates.ts', () => {
    const base = git('rev-parse', 'HEAD');
    const head = commitFile(
      'src/scaffold/templates.ts',
      "export const generateClaudeMd = () => `\\n**Widgets are internal by default:** no user output.\\n`;\n",
      'feat: agent-visible widgets guidance',
    );

    const { code, out } = runLint(base, head, DECLARATION_NONE);

    // Must NOT be the skip path — this is the regression under test.
    expect(out).not.toContain('out of scope');
    expect(code).toBe(1);
    expect(out).toContain('UX-Impact: none is not allowed');
  });

  it('PASSES when the declaration quotes a concrete string from the scaffold diff', () => {
    const base = git('rev-parse', 'HEAD');
    const head = commitFile(
      'src/scaffold/templates.ts',
      "export const generateClaudeMd = () => `\\n**Gadgets are internal by default:** no user output.\\n`;\n",
      'feat: agent-visible gadgets guidance',
    );

    const body = [
      '## UX Impact',
      '',
      'Who sees it: every new or upgraded agent. User-visible behavior: the',
      'generated CLAUDE.md now states `Gadgets are internal by default:` so the',
      'agent stops narrating gadget activity. First contact: none.',
    ].join('\n');

    const { code, out } = runLint(base, head, body);
    expect(code).toBe(0);
    expect(out).toContain('PASS');
  });

  it('still SKIPS a genuinely internal path (the allowlist did not over-reach)', () => {
    const base = git('rev-parse', 'HEAD');
    const head = commitFile(
      'src/core/InternalWidget.ts',
      'export const x = 1;\n',
      'refactor: internal only',
    );

    const { code, out } = runLint(base, head, DECLARATION_NONE);
    expect(code).toBe(0);
    expect(out).toContain('out of scope');
  });
});
