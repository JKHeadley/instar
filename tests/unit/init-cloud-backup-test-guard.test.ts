/**
 * Regression guard: `instar init` must never create a real GitHub repository from a
 * test run.
 *
 * `initProject`'s standalone path ends its cloud-backup step in `gh repo create`
 * against whatever account the ambient `gh` CLI is authenticated as. Seven test files
 * call `initProject`, and they isolate the FILESYSTEM (HOME is redirected to a temp
 * dir) but nothing isolated the NETWORK — so each run created real private repos on
 * the operator's account, and the temp-dir cleanup never knew they existed. 377 empty
 * `instar-*-test-<random>` repos accumulated on one account between 2026-06-14 and
 * 2026-08-15, three per run of a single unit test.
 *
 * The guard is in the setup routine rather than in the tests on purpose: patching the
 * one test that was noticed leaves the other six, and every test written after it,
 * free to do the same thing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initProject, isAutomatedTestRun } from '../../src/commands/init.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('isAutomatedTestRun', () => {
  it('detects vitest and NODE_ENV=test', () => {
    expect(isAutomatedTestRun({ VITEST: 'true' })).toBe(true);
    expect(isAutomatedTestRun({ NODE_ENV: 'test' })).toBe(true);
  });

  it('is false for an ordinary run', () => {
    expect(isAutomatedTestRun({})).toBe(false);
    expect(isAutomatedTestRun({ NODE_ENV: 'production' })).toBe(false);
  });

  // CI is deliberately not a signal: a genuine `instar init` inside someone's own
  // automation should still get the backup it asked for.
  it('does NOT treat CI alone as a test run', () => {
    expect(isAutomatedTestRun({ CI: 'true' })).toBe(false);
    expect(isAutomatedTestRun({ CI: '1', GITHUB_ACTIONS: 'true' })).toBe(false);
  });

  it('reads the live environment by default, which is a test run here', () => {
    expect(isAutomatedTestRun()).toBe(true);
  });
});

describe('standalone init under a test run', () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-backup-guard-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    SafeFsExecutor.safeRmSync(tmpHome, {
      recursive: true,
      force: true,
      operation: 'tests/unit/init-cloud-backup-test-guard.test.ts',
    });
  });

  // The cloud-backup step is the ONLY thing that runs `git init` on the standalone
  // path, so an absent `.git` is the observable proof that the step did not run —
  // and therefore that `gh repo create` was never reached. Asserting on the absence
  // of a local artifact keeps the test honest without stubbing the network, which
  // would only prove the stub works.
  it('creates the agent WITHOUT running the cloud-backup step', async () => {
    const agentName = 'backup-guard-test-' + Math.random().toString(36).slice(2, 8);
    await initProject({
      name: agentName,
      standalone: true,
      port: 4098,
      skipPrereqs: true,
    });

    const agentDir = path.join(tmpHome, '.instar', 'agents', agentName);
    expect(fs.existsSync(agentDir)).toBe(true);
    expect(fs.existsSync(path.join(agentDir, '.git'))).toBe(false);
  });
});
