/**
 * SessionManager live-tool-shell detection (reaper idle-coordinator fix).
 *
 * Fixture is the real `ps -eo pid,ppid,command` shape of a coordinating session
 * captured 2026-09-28: the pane process IS claude (no wrapper shell), its
 * `run_in_background` watch loops are `/bin/zsh -c source <config-home>/shell-
 * snapshots/…` direct children, each with a `sleep 60` child, alongside the
 * resident MCP servers.
 */

import { describe, it, expect } from 'vitest';
import { SessionManager } from '../../src/core/SessionManager.js';

const HEADER = '  PID  PPID COMMAND';
const CLAUDE = '49248  1194 /usr/local/bin/claude --dangerously-skip-permissions --resume c779 --model opus';
const MCP = [
  '49330 49248 node /x/node_modules/instar/dist/threadline/mcp-stdio-entry.js --state-dir /x/.instar',
  '49328 49248 npm exec @playwright/mcp@latest',
  '49626 49328 node /y/.bin/playwright-mcp',
];
const SHELL = "64338 49248 /bin/zsh -c source /Users/u/.claude-followme-x/shell-snapshots/snapshot-zsh-1790619212445-ue14tc.sh 2>/dev/null || true && eval 'until gh pr checks 1 ; do sleep 60; done'";
const SLEEP = '71573 64338 sleep 60';

const ps = (...lines: string[]): string => [HEADER, ...lines].join('\n');
// computeHasActiveProcesses is private; exercised directly (pure, no fork).
const hasActive = (panePid: string, out: string): boolean =>
  (SessionManager.prototype as unknown as { computeHasActiveProcesses(p: string, o: string): boolean })
    .computeHasActiveProcesses.call({}, panePid, out);

describe('SessionManager.computeHasLiveToolShell', () => {
  it('true when a background tool shell is running under the pane', () => {
    expect(SessionManager.computeHasLiveToolShell('49248', ps(CLAUDE, ...MCP, SHELL, SLEEP))).toBe(true);
  });

  it('false when only the resident MCP servers are alive (a genuinely idle session)', () => {
    expect(SessionManager.computeHasLiveToolShell('49248', ps(CLAUDE, ...MCP))).toBe(false);
  });

  it('ignores tool shells belonging to a DIFFERENT pane', () => {
    const other = SHELL.replace('64338 49248', '64338 55555');
    expect(SessionManager.computeHasLiveToolShell('49248', ps(CLAUDE, ...MCP, other))).toBe(false);
  });
});

describe('SessionManager.computeHasActiveProcesses — a tool shell is not the Claude main process', () => {
  it('a direct-child tool shell counts as active even between its children (no sleep running)', () => {
    // Its command contains "claude" (the config-home path) — it used to be
    // mistaken for the main process and filtered out.
    expect(hasActive('49248', ps(CLAUDE, ...MCP, SHELL))).toBe(true);
  });

  it('still false for claude + resident MCP servers only', () => {
    expect(hasActive('49248', ps(CLAUDE, ...MCP))).toBe(false);
  });

  it('still filters the claude main process when the pane is a wrapper shell', () => {
    const wrapped = ps('100 1 -zsh', '101 100 /usr/local/bin/claude --resume abc');
    expect(hasActive('100', wrapped)).toBe(false);
  });
});
