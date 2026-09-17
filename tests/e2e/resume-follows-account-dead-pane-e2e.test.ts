/**
 * E2E — Resume Follows the Account §3.2/§3.3 against a REAL tmux server.
 *
 * The incident's Link 2: a Claude process that exits non-zero under
 * `remain-on-exit failed` leaves a dead pane inside a tmux session that still
 * exists. These tests prove, with real tmux on a private socket (never the
 * shared server other agents use), that the production detectors see the
 * pane-exit fact: SessionManager.isPaneDead, and the TopicResumeMap heartbeat
 * that must not record a dead pane's conversation.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { TopicResumeMap } from '../../src/core/TopicResumeMap.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const tmuxBinary = (() => {
  const r = spawnSync('which', ['tmux'], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : '';
})();

const UUID = '56f6396f-85ff-4e3a-8003-9ed6c3bf5ca2';

describe.skipIf(!tmuxBinary)('Resume Follows the Account — real tmux dead pane (e2e)', () => {
  let dir: string;
  let tmuxWrapper: string;
  const socket = `instar-rfa-e2e-${process.pid}`;
  let manager: SessionManager;
  let origHome: string | undefined;

  const tmux = (...args: string[]) => execFileSync(tmuxBinary, ['-L', socket, ...args], { encoding: 'utf-8' });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfa-e2e-'));
    tmuxWrapper = path.join(dir, 'tmux.sh');
    fs.writeFileSync(tmuxWrapper, `#!/bin/sh\nexec "${tmuxBinary}" -L ${socket} "$@"\n`);
    fs.chmodSync(tmuxWrapper, 0o755);
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    origHome = process.env.HOME;
    process.env.HOME = dir;

    // A pane that exits non-zero while remain-on-exit=failed keeps it.
    tmux('new-session', '-d', '-s', 'crashed', 'sleep 1; exit 3', ';', 'set-option', '-t', 'crashed', 'remain-on-exit', 'failed');
    // A pane that stays running.
    tmux('new-session', '-d', '-s', 'running', 'sleep 60');
    await new Promise((r) => setTimeout(r, 2500));

    manager = new SessionManager({
      tmuxPath: tmuxWrapper, claudePath: '/usr/local/bin/claude', projectDir: dir,
      maxSessions: 5, protectedSessions: [], completionPatterns: ['done'], framework: 'claude-code',
    }, new StateManager(path.join(dir, 'state')));
  }, 30_000);

  afterAll(() => {
    manager?.stopMonitoring();
    try { tmux('kill-server'); } catch { /* @silent-fallback-ok — server may already be gone */ }
    process.env.HOME = origHome;
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/resume-follows-account-dead-pane-e2e.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('a crashed pane still reports as an existing session (the incident symbol)', () => {
    expect(manager.tmuxSessionExists('crashed')).toBe(true);
  });

  it('isPaneDead reads the real exit fact: dead for the crashed pane, alive for the running one, false for a missing session', () => {
    expect(manager.isPaneDead('crashed')).toBe(true);
    expect(manager.isPaneDead('running')).toBe(false);
    expect(manager.isPaneDead('no-such-session')).toBe(false);
  });

  it('the resume heartbeat records the running pane and skips the dead one', () => {
    const projectDir = path.join(dir, 'project');
    const slugDir = path.join(dir, '.claude-followme-b', 'projects', projectDir.replace(/[/.]/g, '-'));
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, `${UUID}.jsonl`), '{}\n');
    const other = '11111111-2222-3333-4444-555555555555';
    fs.writeFileSync(path.join(slugDir, `${other}.jsonl`), '{}\n');

    const stateDir = path.join(dir, 'resume-state');
    fs.mkdirSync(stateDir, { recursive: true });
    const map = new TopicResumeMap(stateDir, projectDir, tmuxWrapper);
    map.refreshResumeMappings(new Map([
      [1, { sessionName: 'crashed', claudeSessionId: UUID }],
      [2, { sessionName: 'running', claudeSessionId: other }],
      [3, { sessionName: 'no-such-session', claudeSessionId: UUID }],
    ]));

    expect(map.getEntryRaw(1)).toBeNull();
    expect(map.getEntryRaw(3)).toBeNull();
    expect(map.get(2)).toBe(other);
  });
});
