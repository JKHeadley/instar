import { describe, expect, it } from 'vitest';
import {
  classifyFrameworkInfrastructureProcess,
  classifyProtectedWait,
} from '../../src/monitoring/SessionWatchdog.js';

describe('SessionWatchdog interruption attribution', () => {
  it('protects safe-merge and GitHub watch commands from stuck intervention', () => {
    expect(classifyProtectedWait('node scripts/safe-merge.mjs 1981 --squash --admin')).toEqual({
      protected: true,
      reason: 'safe-merge-wait',
    });
    expect(classifyProtectedWait('gh run watch 123 --exit-status').protected).toBe(true);
    expect(classifyProtectedWait('gh pr checks 1981 --watch').protected).toBe(true);
  });

  it('protects an explicit bounded waiter but not an ordinary quiet command', () => {
    expect(classifyProtectedWait('node worker.mjs', 'waiting for checks (deadline 1200s)').protected).toBe(true);
    expect(classifyProtectedWait('node worker.mjs', 'processing records').protected).toBe(false);
  });

  it('does not protect a command that merely passes safe-merge as argument data', () => {
    expect(classifyProtectedWait('node worker.mjs --label safe-merge')).toEqual({ protected: false });
    expect(classifyProtectedWait("node worker.mjs --label 'gh run watch 123'")).toEqual({ protected: false });
  });

  it('returns long-lived waiters to the contextual judge after the bounded floor', () => {
    expect(classifyProtectedWait('node scripts/safe-merge.mjs 1981', '', 2 * 60 * 60 * 1_000 + 1)).toEqual({ protected: false });
  });

  it('preserves an exact suspected Codex host without claiming confirmed provenance', () => {
    expect(classifyFrameworkInfrastructureProcess(
      '/opt/instar/bin/codex-code-mode-host --stdio',
      'codex-cli',
    )).toEqual({ protected: true, confirmed: false, reason: 'ownership-unknown' });
    expect(classifyFrameworkInfrastructureProcess(
      '/opt/instar/bin/codex-code-mode-host --stdio',
      'claude-code',
    )).toEqual({ protected: false, confirmed: false });
  });

  it('does not grant host immunity when user argv merely mentions the host name', () => {
    expect(classifyFrameworkInfrastructureProcess(
      '/bin/sh -c echo codex-code-mode-host',
      'codex-cli',
    )).toEqual({ protected: false, confirmed: false });
  });
});
