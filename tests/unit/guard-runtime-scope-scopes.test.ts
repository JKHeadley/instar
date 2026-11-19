/**
 * docs/specs/guard-runtime-state-scope.md §3: each named scope allows exactly its targets
 * and verbs, under its own root predicate, and refuses a git-tracked target. Run in
 * `enforce` through SafeFsExecutor so the refusal is real, from a home under `/.instar/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor, SourceTreeGuardError } from '../../src/core/SafeFsExecutor.js';
import {
  configureGuardRuntimeScope,
  evaluateRuntimeScopePolicy,
  lsFilesCounter,
  _resetGuardRuntimeScopeForTesting,
  _setLsFilesRunnerForTesting,
} from '../../src/core/guardRuntimeScope.js';
import { _resetLedgerMemoryForTesting } from '../../src/core/guardScopeLedger.js';
import { git, makeGuardFixture, type GuardFixture } from '../fixtures/guardScopeFixture.js';

let fx: GuardFixture;
let wtDir: string;
const prevLedger = process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR;

beforeEach(() => {
  fx = makeGuardFixture();
  wtDir = path.join(fx.home, '.worktrees');
  process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR = fx.ledgerDir;
  _resetGuardRuntimeScopeForTesting();
  _resetLedgerMemoryForTesting();
  configureGuardRuntimeScope({ mode: 'enforce' });
});
afterEach(() => {
  _setLsFilesRunnerForTesting(null);
  _resetGuardRuntimeScopeForTesting();
  process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR = prevLedger;
  fx.cleanup();
});

const refused = (fn: () => void): void => { expect(fn).toThrow(SourceTreeGuardError); };

describe('feedbackCanaryScope', () => {
  const nonce = 'ab12cd34';
  const sib = () => path.join(wtDir, `.feedback-canary-sib-${nonce}`);
  const scope = () => ({ feedbackCanaryScope: { worktreesDir: wtDir } });

  beforeEach(() => {
    fs.mkdirSync(sib());
    fs.writeFileSync(path.join(sib(), `sib-${nonce}.txt`), 'n');
    fs.writeFileSync(path.join(sib(), 'w.txt'), 'w');
  });

  it('allows unlinking sib-<nonce>.txt and w.txt, then a non-recursive rmdir of the sibling folder', () => {
    SafeFsExecutor.safeUnlinkSync(path.join(sib(), `sib-${nonce}.txt`), { operation: 't', ...scope() });
    SafeFsExecutor.safeUnlinkSync(path.join(sib(), 'w.txt'), { operation: 't', ...scope() });
    SafeFsExecutor.safeRmdirSync(sib(), { operation: 't', ...scope() });
    expect(fs.existsSync(sib())).toBe(false);
  });

  it('allows unlinking hl/link/siblink leftovers directly inside a feedback workspace', () => {
    const ws = path.join(wtDir, 'feedback-fb-1-abcd1234-a1');
    fs.mkdirSync(ws);
    for (const kind of ['hl', 'link', 'siblink']) {
      const f = path.join(ws, `.feedback-canary-${kind}-${nonce}`);
      fs.writeFileSync(f, '');
      SafeFsExecutor.safeUnlinkSync(f, { operation: 't', ...scope() });
      expect(fs.existsSync(f)).toBe(false);
    }
  });

  it('refuses rm (any form) of the sibling folder and leaves unexpected contents', () => {
    fs.writeFileSync(path.join(sib(), 'unexpected.txt'), 'x');
    refused(() => SafeFsExecutor.safeRmSync(sib(), { recursive: true, force: true, operation: 't', ...scope() }));
    refused(() => SafeFsExecutor.safeRmdirSync(sib(), { recursive: true, operation: 't', ...scope() } as never));
    expect(fs.existsSync(path.join(sib(), 'unexpected.txt'))).toBe(true);
  });

  it('after a refused (non-empty) canary rmdir the contents survive', () => {
    fs.writeFileSync(path.join(sib(), 'unexpected.txt'), 'x');
    expect(() => SafeFsExecutor.safeRmdirSync(sib(), { operation: 't', ...scope() })).toThrow(); // ENOTEMPTY
    expect(fs.readFileSync(path.join(sib(), 'unexpected.txt'), 'utf8')).toBe('x');
  });

  it('refuses a caller-chosen name outside the shapes, a sibling, a deeper path and a wrong nonce', () => {
    const other = path.join(sib(), 'other.txt');
    fs.writeFileSync(other, '');
    refused(() => SafeFsExecutor.safeUnlinkSync(other, { operation: 't', ...scope() }));
    const sibling = path.join(wtDir, `.feedback-canary-${nonce}`);
    fs.writeFileSync(sibling, '');
    refused(() => SafeFsExecutor.safeUnlinkSync(sibling, { operation: 't', ...scope() }));
    fs.mkdirSync(path.join(sib(), 'deeper'));
    fs.writeFileSync(path.join(sib(), 'deeper', 'w.txt'), '');
    refused(() => SafeFsExecutor.safeUnlinkSync(path.join(sib(), 'deeper', 'w.txt'), { operation: 't', ...scope() }));
    fs.writeFileSync(path.join(sib(), 'sib-ffff0000.txt'), '');
    refused(() => SafeFsExecutor.safeUnlinkSync(path.join(sib(), 'sib-ffff0000.txt'), { operation: 't', ...scope() }));
  });

  it('refuses a .. in the path even when it normalises into a scope shape', () => {
    refused(() => SafeFsExecutor.safeUnlinkSync(`${sib()}/../.feedback-canary-sib-${nonce}/w.txt`, { operation: 't', ...scope() }));
  });

  it('refuses a root that fails its predicate (<checkout>/src as worktreesDir)', () => {
    const srcSib = path.join(fx.home, 'src', `.feedback-canary-sib-${nonce}`);
    fs.mkdirSync(srcSib);
    fs.writeFileSync(path.join(srcSib, 'w.txt'), '');
    const v = evaluateRuntimeScopePolicy({ target: path.join(srcSib, 'w.txt'), verb: 'unlink', recursive: false, force: false, scopes: { feedbackCanaryScope: { worktreesDir: path.join(fx.home, 'src') } } });
    expect(v).toMatchObject({ allow: false, reason: 'scope-refused', scope: 'scope:feedbackCanaryScope' });
  });

  it('refuses a git-tracked target inside the scope shape', () => {
    // Track a file at a canary shape (force-add past .gitignore).
    git(fx.home, ['add', '-f', path.join(sib(), 'w.txt')]);
    git(fx.home, ['commit', '-q', '-m', 'track']);
    refused(() => SafeFsExecutor.safeUnlinkSync(path.join(sib(), 'w.txt'), { operation: 't', ...scope() }));
    expect(fs.existsSync(path.join(sib(), 'w.txt'))).toBe(true);
  });

  it('refuses when git cannot answer (indeterminate) in enforce', () => {
    _setLsFilesRunnerForTesting(() => 'indeterminate');
    refused(() => SafeFsExecutor.safeUnlinkSync(path.join(sib(), 'w.txt'), { operation: 't', ...scope() }));
  });
});

describe('gitRebaseStateScope', () => {
  it('allows a recursive rm of exactly .git/rebase-merge and .git/rebase-apply', () => {
    for (const name of ['rebase-merge', 'rebase-apply']) {
      const d = path.join(fx.home, '.git', name);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'head-name'), 'x');
      SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 't', gitRebaseStateScope: { projectDir: fx.home } });
      expect(fs.existsSync(d)).toBe(false);
    }
  });

  it('runs no ls-files (git never tracks .git)', () => {
    const d = path.join(fx.home, '.git', 'rebase-merge');
    fs.mkdirSync(d);
    const before = lsFilesCounter.count;
    SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 't', gitRebaseStateScope: { projectDir: fx.home } });
    expect(lsFilesCounter.count).toBe(before);
  });

  it('refuses .git/config, a deeper rebase path, a non-recursive form and a non-checkout root', () => {
    const scope = { gitRebaseStateScope: { projectDir: fx.home } };
    refused(() => SafeFsExecutor.safeUnlinkSync(path.join(fx.home, '.git', 'config'), { operation: 't', ...scope }));
    fs.mkdirSync(path.join(fx.home, '.git', 'rebase-merge', 'sub'), { recursive: true });
    refused(() => SafeFsExecutor.safeRmSync(path.join(fx.home, '.git', 'rebase-merge', 'sub'), { recursive: true, force: true, operation: 't', ...scope }));
    refused(() => SafeFsExecutor.safeRmdirSync(path.join(fx.home, '.git', 'rebase-merge', 'sub'), { operation: 't', ...scope }));
    const v = evaluateRuntimeScopePolicy({ target: path.join(fx.home, 'src', '.git', 'rebase-merge'), verb: 'rm', recursive: true, force: true, scopes: { gitRebaseStateScope: { projectDir: path.join(fx.home, 'src') } } });
    expect(v.allow).toBe(false);
  });
});

describe('learnedSkillScope', () => {
  it('allows a recursive rm of one untracked folder directly under .claude/skills/ or .agents/skills/', () => {
    for (const root of ['.claude', '.agents']) {
      const d = path.join(fx.home, root, 'skills', 'learned-x');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'SKILL.md'), '# x');
      SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 't', learnedSkillScope: { projectDir: fx.home } });
      expect(fs.existsSync(d)).toBe(false);
    }
  });

  it('refuses a tracked skill folder (one holding tracked files)', () => {
    const d = path.join(fx.home, '.claude', 'skills', 'builtin');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), '# builtin');
    git(fx.home, ['add', path.join(d, 'SKILL.md')]);
    git(fx.home, ['commit', '-q', '-m', 'skill']);
    refused(() => SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 't', learnedSkillScope: { projectDir: fx.home } }));
    expect(fs.existsSync(path.join(d, 'SKILL.md'))).toBe(true);
  });

  it('refuses the skills folder itself, a deeper path and a non-recursive verb', () => {
    const scope = { learnedSkillScope: { projectDir: fx.home } };
    const d = path.join(fx.home, '.claude', 'skills', 'x', 'deeper');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(fx.home, '.claude', 'skills', 'x', 'SKILL.md'), '');
    refused(() => SafeFsExecutor.safeRmSync(path.join(fx.home, '.claude', 'skills'), { recursive: true, force: true, operation: 't', ...scope }));
    refused(() => SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 't', ...scope }));
    refused(() => SafeFsExecutor.safeUnlinkSync(path.join(fx.home, '.claude', 'skills', 'x', 'SKILL.md'), { operation: 't', ...scope }));
  });
});

describe('nodeModulesCloneStagingScope', () => {
  let wt: string;
  beforeEach(() => {
    wt = path.join(wtDir, 'echo-x');
    git(fx.home, ['worktree', 'add', '-q', wt]);
  });

  it('allows a recursive forced rm of exactly node_modules.clone-<digits>-<digits> in a listed worktree', () => {
    const staging = path.join(wt, 'node_modules.clone-123-1700000000000');
    fs.mkdirSync(path.join(staging, 'pkg'), { recursive: true });
    SafeFsExecutor.safeRmSync(staging, { recursive: true, force: true, operation: 't', nodeModulesCloneStagingScope: { worktreeRoot: wt } });
    expect(fs.existsSync(staging)).toBe(false);
  });

  it('refuses a non-forced rm, node_modules itself, a wrong shape, and an unlisted root', () => {
    const scope = { nodeModulesCloneStagingScope: { worktreeRoot: wt } };
    const staging = path.join(wt, 'node_modules.clone-1-2');
    fs.mkdirSync(staging);
    refused(() => SafeFsExecutor.safeRmSync(staging, { recursive: true, operation: 't', ...scope }));
    fs.mkdirSync(path.join(wt, 'node_modules'));
    refused(() => SafeFsExecutor.safeRmSync(path.join(wt, 'node_modules'), { recursive: true, force: true, operation: 't', ...scope }));
    fs.mkdirSync(path.join(wt, 'node_modules.clone-x-2'));
    refused(() => SafeFsExecutor.safeRmSync(path.join(wt, 'node_modules.clone-x-2'), { recursive: true, force: true, operation: 't', ...scope }));
    const unlisted = path.join(wtDir, 'not-a-worktree');
    fs.mkdirSync(path.join(unlisted, 'node_modules.clone-1-2'), { recursive: true });
    refused(() => SafeFsExecutor.safeRmSync(path.join(unlisted, 'node_modules.clone-1-2'), { recursive: true, force: true, operation: 't', nodeModulesCloneStagingScope: { worktreeRoot: unlisted } }));
  });

  it('the main checkout is a listed worktree too', () => {
    const staging = path.join(fx.home, 'node_modules.clone-9-9');
    fs.mkdirSync(staging);
    SafeFsExecutor.safeRmSync(staging, { recursive: true, force: true, operation: 't', nodeModulesCloneStagingScope: { worktreeRoot: fx.home } });
    expect(fs.existsSync(staging)).toBe(false);
  });
});

describe('localVerifyScopeOk', () => {
  it('allows the verify-root clone paths as today', () => {
    const verifyRoot = path.join(wtDir, '.verify');
    const run = path.join(verifyRoot, 'runs', 'r1');
    fs.mkdirSync(run, { recursive: true });
    SafeFsExecutor.safeRmSync(run, { recursive: true, force: true, operation: 't', localVerifyScopeOk: { verifyRoot } });
    expect(fs.existsSync(run)).toBe(false);
  });

  it('refuses a path outside the verify root', () => {
    const verifyRoot = path.join(wtDir, '.verify');
    fs.mkdirSync(verifyRoot, { recursive: true });
    const other = path.join(wtDir, 'other');
    fs.mkdirSync(other);
    refused(() => SafeFsExecutor.safeRmSync(other, { recursive: true, force: true, operation: 't', localVerifyScopeOk: { verifyRoot } }));
  });
});

describe('ls-files runs only for scope-shaped paths', () => {
  it('a plain delete outside any scope shape never runs git', () => {
    configureGuardRuntimeScope({ mode: 'report' });
    const before = lsFilesCounter.count;
    const f = path.join(fx.outside, 'plain.txt');
    fs.writeFileSync(f, '');
    SafeFsExecutor.safeUnlinkSync(f, { operation: 't', feedbackCanaryScope: { worktreesDir: wtDir } });
    const s = path.join(fx.home, '.instar', 'state', 'x');
    fs.writeFileSync(s, '');
    SafeFsExecutor.safeUnlinkSync(s, { operation: 't' });
    expect(lsFilesCounter.count).toBe(before);
  });
});
