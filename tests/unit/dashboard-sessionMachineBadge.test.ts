/**
 * Smoke tests for cross-machine session visibility in the dashboard sessions
 * list (operator requirement, 2026-06-05 topic 13481: "all sessions should
 * show on the dashboard and should state which machine the session is on").
 * Inspects the HTML/JS at rest (no browser): the pool poll, the machine badge,
 * remote-row namespacing, and the remote-row interaction guards.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.resolve(__dirname, '../../dashboard/index.html'), 'utf-8');

describe('dashboard: sessions list — machine badges + pool-wide visibility', () => {
  it('polls the pool-wide sessions view', () => {
    expect(HTML).toContain('function startPoolSessionsPolling()');
    expect(HTML).toContain(`fetch('/sessions?scope=pool'`);
  });

  it('starts the pool poll on BOTH auth-success paths (PIN login + stored-token auto-login)', () => {
    const count = HTML.split('startPoolSessionsPolling();').length - 1;
    expect(count).toBe(2); // exactly the two auth-success call sites
  });

  it('keeps remote sessions separate from the WebSocket-replaced local array', () => {
    expect(HTML).toContain('let remoteSessions = []');
    expect(HTML).toMatch(/remoteSessions = \(j\.sessions \|\| \[\]\)\.filter\(s => s\.remote === true\)/);
  });

  it('renders a machine badge stating where the session runs (XSS-escaped)', () => {
    expect(HTML).toContain('class="machine-badge"');
    expect(HTML).toContain('escapeHtml(session.machineNickname)');
    expect(HTML).toContain('.machine-badge {'); // the style exists
  });

  it('local rows inherit this machine\'s nickname from the pool response', () => {
    expect(HTML).toContain('selfMachineNickname');
    expect(HTML).toMatch(/j\.pool && j\.pool\.selfMachineNickname/);
  });

  it('namespaces remote rows by machine so tmux names never collide across machines', () => {
    expect(HTML).toContain('function sessionRowKey(s)');
    expect(HTML).toMatch(/remote:\$\{s\.machineId \|\| '\?'\}:\$\{s\.tmuxSession\}/);
  });

  it('remote rows are informational: no terminal subscribe, no close button', () => {
    // No onclick → selectSession for remote rows; tooltip explains where it runs.
    expect(HTML).toMatch(/if \(session\.remote\) \{[\s\S]{0,400}el\.title = `Running on /);
    // The close (×) button is gated off for remote sessions.
    expect(HTML).toMatch(/\$\{session\.remote \? '' : `<button class="session-close-btn"/);
  });

  it('the active-terminal highlight never matches a remote row', () => {
    expect(HTML).toContain('const isActive = !session.remote && session.tmuxSession === activeSession;');
  });
});
