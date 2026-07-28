// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup only.
/**
 * Wiring: every failure-learning git read against the agent's projectDir must
 * carry `sourceTreeReadOk: true`. Without it, SourceTreeGuard silently blocks
 * the read on dogfooding agents whose checkout IS the instar source tree
 * (the Echo case surfaced 2026-05-29, where RevertDetector's every-poll
 * `SourceTreeGuardError: Refusing to run failure-learning:revert-detect…`
 * warning sat in server-stderr.log for hours while the loop's `/failures/*`
 * API kept reporting "1 captured" — i.e. zero from CI/revert sources).
 *
 * Approach: static introspection. Each of the three canonical callsites
 * (RevertDetector default, AgentServer commitTouchedFiles for the
 * attribution engine, AgentServer resolveRepo for the CI poller) must
 * include `sourceTreeReadOk: true` in its SafeGitExecutor.readSync options
 * block. Static check is lightweight, runs every CI shard, and catches the
 * regression class without spinning up a stub server.
 *
 * Why not runtime: a runtime test could inject a SafeGitExecutor mock and
 * assert on its arguments, but mocks are how the existing tests masked this
 * gap (they bypass SafeGitExecutor entirely). The static check pins the
 * call-shape directly so future maintainers can't refactor it away by
 * accident.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Match: SafeGitExecutor.readSync( <args>, { … sourceTreeReadOk: true … } )
 * — across multiple lines, with the option potentially anywhere in the opts
 * object.
 */
function readSyncBlocksIn(file: string): Array<{ opsIdx: number; hasFlag: boolean; operation: string }> {
  const src = fs.readFileSync(file, 'utf-8');
  // Match SafeGitExecutor.readSync(…, { …opts… }) across multiple lines.
  // Greedy across the args + opts. We scan with an iterative regex on
  // `SafeGitExecutor.readSync(` and balance-count parens to find the call's
  // end — robust to nested options.
  const out: Array<{ opsIdx: number; hasFlag: boolean; operation: string }> = [];
  const needle = 'SafeGitExecutor.readSync(';
  let i = 0;
  while ((i = src.indexOf(needle, i)) !== -1) {
    const start = i + needle.length;
    // Walk forward, counting parens; end when we close the readSync(...)
    let depth = 1;
    let j = start;
    while (j < src.length && depth > 0) {
      const c = src[j];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      j++;
    }
    const callText = src.slice(start, j - 1); // inner args, excluding the closing )
    const hasFlag = /\bsourceTreeReadOk\s*:\s*true\b/.test(callText);
    const opMatch = callText.match(/operation\s*:\s*['"]([^'"]+)['"]/);
    out.push({
      opsIdx: i,
      hasFlag,
      operation: opMatch ? opMatch[1] : '<no operation literal>',
    });
    i = j;
  }
  return out;
}

describe('Failure-learning sources: sourceTreeReadOk wiring', () => {
  it('RevertDetector default git invocation passes sourceTreeReadOk: true', () => {
    const file = path.join(REPO_ROOT, 'src/monitoring/RevertDetector.ts');
    const calls = readSyncBlocksIn(file).filter(c => c.operation.startsWith('failure-learning:'));
    expect(calls.length, 'expected ≥1 SafeGitExecutor.readSync call tagged failure-learning:*').toBeGreaterThan(0);
    const bad = calls.filter(c => !c.hasFlag);
    expect(
      bad.map(c => c.operation),
      'every failure-learning git read must include sourceTreeReadOk: true to work on dogfooding agents',
    ).toEqual([]);
  });

  it('AgentServer attribution-engine commitTouchedFiles passes sourceTreeReadOk: true', () => {
    const file = path.join(REPO_ROOT, 'src/server/AgentServer.ts');
    const calls = readSyncBlocksIn(file)
      .filter(c => c.operation === 'failure-learning:commit-touched-files');
    expect(calls.length, 'expected the commit-touched-files readSync to exist').toBe(1);
    expect(calls[0].hasFlag, 'commit-touched-files must carry sourceTreeReadOk: true').toBe(true);
  });

  it('AgentServer CI-poller resolveRepo passes sourceTreeReadOk: true', () => {
    const file = path.join(REPO_ROOT, 'src/server/AgentServer.ts');
    const calls = readSyncBlocksIn(file)
      .filter(c => c.operation === 'failure-learning:ci-resolve-repo');
    expect(calls.length, 'expected the ci-resolve-repo readSync to exist').toBe(1);
    expect(calls[0].hasFlag, 'ci-resolve-repo must carry sourceTreeReadOk: true').toBe(true);
  });

  it('every failure-learning:* readSync in src/ carries the flag (catch-all)', () => {
    // Catch-all: any future failure-learning readSync added without the flag
    // surfaces here even if the per-callsite tests above haven't been updated
    // to enumerate it.
    const filesToCheck = [
      path.join(REPO_ROOT, 'src/monitoring/RevertDetector.ts'),
      path.join(REPO_ROOT, 'src/monitoring/CiFailurePoller.ts'),
      path.join(REPO_ROOT, 'src/server/AgentServer.ts'),
      path.join(REPO_ROOT, 'src/monitoring/FailureAttributionEngine.ts'),
      path.join(REPO_ROOT, 'src/monitoring/FailureLedger.ts'),
    ];
    const offenders: Array<{ file: string; operation: string }> = [];
    for (const f of filesToCheck) {
      if (!fs.existsSync(f)) continue;
      for (const c of readSyncBlocksIn(f)) {
        if (c.operation.startsWith('failure-learning:') && !c.hasFlag) {
          offenders.push({ file: path.relative(REPO_ROOT, f), operation: c.operation });
        }
      }
    }
    expect(offenders, 'failure-learning git reads without sourceTreeReadOk silently fail on dogfooding agents').toEqual([]);
  });
});
