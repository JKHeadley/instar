/**
 * Remote-session close — dashboard piece (REMOTE-SESSION-CLOSE-SPEC §2.2):
 * remote tiles render the same × as local tiles, wired to an extended
 * closeSession(tmuxSession, sessionName, opts) that relays through
 * POST /sessions/:name/remote-close. The confirm dialog is the informed-
 * consent surface (names the machine, flags PROTECTED sessions, states
 * "protection status unknown" for flag-less pre-feature peer rows), and the
 * outcome toasts are honesty-calibrated (calm already-closed, delivery-honest
 * outcome-unknown — both trigger a pool refresh). Inspects the HTML/JS at
 * rest (no browser), following the dashboard-poolTileStatusFilter.test.ts
 * pattern.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard', 'index.html'), 'utf-8');

describe('dashboard remote-session close — × on remote tiles', () => {
  it('the old shape that hid the × on remote tiles is gone', () => {
    expect(html).not.toContain("session.remote ? '' : `<button class=\"session-close-btn\"");
  });

  it('remote tiles render the × carrying the relay args (uuid, machineId, nickname)', () => {
    const btn = html.match(/<button class="session-close-btn"[^>]*data-tmux=[^\n]+&times;<\/button>/);
    expect(btn, 'session-close-btn template not found — tile render restructured? update this test').toBeTruthy();
    const tpl = btn![0];
    // Remote-conditional relay args sourced from the pool row.
    expect(tpl).toContain('session.remote ?');
    expect(tpl).toContain('data-remote="1"');
    expect(tpl).toContain('data-uuid="${escapeHtml(session.id || \'\')}"');
    expect(tpl).toContain('data-machine-id="${escapeHtml(session.machineId || \'\')}"');
    expect(tpl).toContain('data-machine-nickname="${escapeHtml(session.machineNickname || \'\')}"');
    // Tri-state protected flag: '1' / '0' / '' (absent — pre-feature peer).
    expect(tpl).toContain("session.protected === true ? '1' : session.protected === false ? '0' : ''");
  });

  it('the × is wired to closeSession via the dataset helper, with the button for in-flight state', () => {
    expect(html).toContain('closeSessionFromBtn(this)');
    const helper = html.match(/function closeSessionFromBtn\(btn\)\s*{[\s\S]*?\n    }/);
    expect(helper, 'closeSessionFromBtn not found').toBeTruthy();
    const fn = helper![0];
    expect(fn).toContain("remote: d.remote === '1'");
    expect(fn).toContain('sessionUuid: d.uuid || undefined');
    expect(fn).toContain('machineId: d.machineId || undefined');
    expect(fn).toContain('machineNickname: d.machineNickname || undefined');
    expect(fn).toContain('button: btn');
  });
});

describe('dashboard remote-session close — informed-consent confirm', () => {
  // The whole extended closeSession body, for branch assertions.
  const fnMatch = html.match(/async function closeSession\(tmuxSession, sessionName, opts\)\s*{[\s\S]*?\n    }\n/);
  const fn = fnMatch ? fnMatch[0] : '';

  it('closeSession gains the backward-compatible opts parameter', () => {
    expect(fnMatch, 'extended closeSession(tmuxSession, sessionName, opts) not found').toBeTruthy();
    expect(fn).toContain('opts = opts || {}');
  });

  it('remote confirm names the machine', () => {
    expect(fn).toContain('`Close session "${sessionName}" on ${nickname}?`');
    // Local confirm unchanged.
    expect(fn).toContain('`Close session "${sessionName}"?`');
  });

  it('protected (flag === true) confirms with the PROTECTED warning — remote AND local (spec AC#6)', () => {
    expect(fn).toContain('opts.protected === true');
    expect(fn).toContain('`"${sessionName}" is a PROTECTED session on ${nickname} — close it anyway?`');
    expect(fn).toContain('`"${sessionName}" is a PROTECTED session — close it anyway?`');
  });

  it('flag ABSENT on a remote row appends the protection-status-unknown skew note', () => {
    expect(fn).toContain('opts.remote && opts.protected === undefined');
    expect(fn).toContain("' (protection status unknown — machine needs update)'");
  });
});

describe('dashboard remote-session close — relay call, in-flight state, outcome toasts', () => {
  const fnMatch = html.match(/async function closeSession\(tmuxSession, sessionName, opts\)\s*{[\s\S]*?\n    }\n/);
  const fn = fnMatch ? fnMatch[0] : '';

  it('remote closes POST /sessions/:name/remote-close with { machineId, sessionUuid }; local DELETE untouched', () => {
    expect(fn).toContain('/sessions/${encodeURIComponent(sessionName)}/remote-close');
    expect(fn).toContain('JSON.stringify({ machineId: opts.machineId, sessionUuid: opts.sessionUuid })');
    expect(fn).toContain('/sessions/${encodeURIComponent(tmuxSession)}');
    expect(fn).toContain("method: 'DELETE'");
  });

  it('the clicked × is disabled while the relay is in flight, re-enabled after', () => {
    expect(fn).toContain('closesInFlight.add(key)');
    expect(fn).toContain('opts.button.disabled = true');
    expect(fn).toContain('closesInFlight.delete(key)');
    expect(fn).toContain('opts.button.disabled = false');
    // Re-renders mid-flight keep the pending state (set-backed, not node-backed).
    expect(html).toContain('closesInFlight.has(closeKey(session.remote ? session.machineId : null, session.tmuxSession))');
  });

  it('success toast names the machine', () => {
    expect(fn).toContain('`Session "${sessionName}" closed on ${nickname}`');
  });

  it('alreadyClosed renders the CALM already-closed path and refreshes', () => {
    expect(fn).toContain('data.alreadyClosed');
    expect(fn).toContain('`Session "${sessionName}" already closed — refreshing`');
    expect(fn).not.toMatch(/alreadyClosed[\s\S]{0,200}?'error'/); // calm, never an error toast
  });

  it('outcomeUnknown (504) renders the delivery-honest outcome-unknown path and refreshes', () => {
    expect(fn).toContain('data.outcomeUnknown');
    expect(fn).toContain('`Session "${sessionName}" — outcome unknown — refreshing`');
  });

  it('both non-definitive paths trigger the pool refresh, which exists as a callable function', () => {
    const refreshCalls = fn.match(/refreshPoolSessions\(\)/g) || [];
    expect(refreshCalls.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('async function refreshPoolSessions()');
    // The 15s poll loop reuses it (no second fetch path to drift).
    expect(html).toContain('poolPollTimer = setInterval(refreshPoolSessions, 15000)');
  });

  it('other relay errors surface the server error string', () => {
    expect(fn).toContain("showToast(data.error || 'Failed to close remote session', 'error')");
  });
});
