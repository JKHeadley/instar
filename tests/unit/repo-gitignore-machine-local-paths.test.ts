/**
 * Structural guard for EVO-027: the repo's OWN tracked .gitignore must keep
 * machine-local agent state out of `git add -A`.
 *
 * WHY THIS TEST EXISTS. An agent home is itself a clone of this repo, so this
 * repo's .gitignore is what stops that agent's runtime state from being
 * committed. Before this guard those paths were covered only by (a) per-clone
 * `.git/info/exclude` entries and (b) PostUpdateMigrator writing rules into the
 * WORKING-TREE copy of .gitignore at update time. Neither survives a fresh
 * clone, and (b) does not survive the agent-home checkout reset that
 * auto-update performs. Measured on one agent home 2026-10-03: 3,056 Jev
 * evidence packs (12MB of scrubbed job output, documented machine-local and
 * never exported) and 72GB of foreign-repo worktree contents sat one
 * `git add -A` away from being staged.
 *
 * WHY IT STAGES RATHER THAN CALLING `git check-ignore`. Two reasons.
 *   1. `git add -A` is the operation that actually leaks — it is the step the
 *      git-sync skill runs. Asserting on what it stages tests the consumer,
 *      not a classifier that merely predicts it.
 *   2. Run against THIS repo, `check-ignore` also reads `.git/info/exclude` and
 *      the user's global core.excludesFile, so on the machine where this bug was
 *      found it answers IGNORED for a reason that holds on no other machine — a
 *      probe that passes while the guarantee is absent, which is the exact shape
 *      of the defect.
 *
 * The sandbox is a throwaway repo holding ONLY the tracked .gitignore, with its
 * own `.git/info/exclude` emptied and a local `core.excludesFile` pointed at an
 * empty file (local config beats global), so the committed file is the only
 * thing that can match. MUST_BE_STAGED is a control group: without it this suite
 * could pass because nothing was written or `git add` silently did nothing,
 * rather than because the rules are right.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/repo-gitignore-machine-local-paths.test.ts';
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Paths that must NOT be staged by `git add -A`. Each names the concrete thing
 * that leaks if its rule is removed from .gitignore.
 */
const MUST_NOT_BE_STAGED: Array<{ p: string; why: string }> = [
  {
    p: '.instar/jev-supervision-evidence/correction-class-review-xyz.json',
    why: 'Jev evidence packs — scrubbed job output, documented machine-local and never exported',
  },
  { p: '.instar/secrets/vault.json', why: 'credential store' },
  { p: '.instar/secrets/pr-gate/token', why: 'credential-gate material' },
  { p: '.instar/paste/note.txt', why: 'pasted content, may be sensitive' },
  { p: 'state/judgment-provenance/2026-10-03.jsonl', why: 'machine-local decision context' },
  { p: '.worktrees/some-branch/README.md', why: 'per-machine worktrees, multi-GB foreign-repo contents' },
  { p: '.instar/origin-sessions-abc', why: 'Telegram origin session file' },
  { p: '.instar/origin-notice.sock', why: 'Telegram origin runtime socket' },
  { p: 'docs/research/jev/harness/batch1/sample-7.json', why: 'Jev harness samples contain real message text' },
  { p: 'docs/research/jev/harness/batch1/corpus-2.json', why: 'Jev harness corpora contain real message text' },
  { p: '.instar/state/anything.db', why: 'machine-local agent state' },
];

/** Control group: ordinary repo content that MUST still be staged. */
const MUST_BE_STAGED = [
  'src/core/SomeModule.ts',
  'tests/unit/some.test.ts',
  'docs/research/jev/harness/batch1/README.md',
  'package.json',
];

let sandbox: string;
let staged: Set<string>;

function writeFixture(rel: string): void {
  const abs = path.join(sandbox, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'fixture\n');
}

describe('repo .gitignore keeps machine-local agent state out of `git add -A` (EVO-027)', () => {
  beforeAll(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-gitignore-guard-'));
    SafeGitExecutor.execSync(['init', '--quiet'], { cwd: sandbox, operation: OP });

    // Isolate from every ignore source except the file under test:
    //  - `git init` seeds .git/info/exclude from a template; empty it.
    //  - a local core.excludesFile overrides the user's global one.
    fs.writeFileSync(path.join(sandbox, '.git', 'info', 'exclude'), '');
    const emptyExcludes = path.join(sandbox, '.git', 'empty-excludes');
    fs.writeFileSync(emptyExcludes, '');
    SafeGitExecutor.execSync(['config', 'core.excludesFile', emptyExcludes], {
      cwd: sandbox,
      operation: OP,
    });

    fs.copyFileSync(path.join(REPO_ROOT, '.gitignore'), path.join(sandbox, '.gitignore'));
    for (const { p } of MUST_NOT_BE_STAGED) writeFixture(p);
    for (const p of MUST_BE_STAGED) writeFixture(p);

    // The operation under test — the same one the git-sync skill performs.
    SafeGitExecutor.execSync(['add', '-A'], { cwd: sandbox, operation: OP });

    staged = new Set(
      SafeGitExecutor.readSync(['diff', '--cached', '--name-only'], { cwd: sandbox, operation: OP })
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
  });

  afterAll(() => {
    if (sandbox) {
      SafeFsExecutor.safeRmSync(sandbox, { recursive: true, force: true, operation: OP });
    }
  });

  it.each(MUST_BE_STAGED)('control group: `git add -A` does stage %s', (p) => {
    expect(
      staged.has(p),
      `${p} was NOT staged, so this suite cannot distinguish "correctly ignored" from ` +
        `"nothing was written / git add did nothing". Fix the harness before trusting the ` +
        `assertions below.`,
    ).toBe(true);
  });

  it.each(MUST_NOT_BE_STAGED)('does not stage $p ($why)', ({ p, why }) => {
    expect(
      staged.has(p),
      `${p} WAS staged by \`git add -A\` — ${why}. The tracked .gitignore must cover it. ` +
        `A per-clone .git/info/exclude entry does not count: it does not exist on a fresh ` +
        `clone or on any other machine, and the git-sync skill runs \`git add -A\`.`,
    ).toBe(false);
  });
});
