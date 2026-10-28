/**
 * The Bug-Fix Evidence Bar, satisfied for real: reproduce the leak and prove the fix
 * terminates the actual leaked session — not "the argv looks right".
 *
 * Scenario: a detached tmux session is created exactly as `makeTmuxTrustDriver` creates
 * one, via the REAL production argv builder `armSessionCreateArgv`
 * (with a short TTL injected), and then the creating code simply walks away — no
 * `finally`, no kill — which is precisely what a parent killed mid-poll does. The session
 * must be gone after the TTL, on an isolated tmux server (own socket) so nothing of the
 * operator's is touched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { armSessionCreateArgv } from '../../src/core/codexHookArm.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function which(bin: string): string | null {
  try { return execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf-8' }).trim() || null; } catch { return null; }
}

const TMUX = which('tmux');
const d = TMUX ? describe : describe.skip;

d('codex-arm self-destruct — real tmux reproduction (parent dies, session still dies)', () => {
  let dir: string;
  let socket: string;
  const tmux = (args: string[]): string =>
    execFileSync(TMUX!, ['-S', socket, ...args], { encoding: 'utf-8', timeout: 10_000 });

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-real-'));
    socket = path.join(dir, 'tmux.sock');
  });
  afterAll(() => {
    try { tmux(['kill-server']); } catch { /* already gone */ }
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/codex-arm-self-destruct-real-tmux.test.ts' });
  });

  it('creates + arms in ONE request, then kills the abandoned session after the TTL with no help from the creator', async () => {
    const session = `instar-codex-arm-${Date.now().toString(36)}`;
    // The real argv builder, with a 4 s TTL so the test is quick. The `tmux` the server's
    // job will exec must target OUR socket, so it is a wrapper script.
    const wrapper = path.join(dir, 'tmux');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${TMUX}' -S '${socket}' "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
    const argv = armSessionCreateArgv(wrapper, session, { projectDir: dir, codexHome: dir, ttlMs: 4_000 });
    expect(argv).not.toBeNull();
    tmux(argv!); // one request: new-session ; run-shell -b …
    expect(tmux(['ls', '-F', '#{session_name}'])).toContain(session);

    // The creator now "dies": we do nothing further. No finally, no kill.
    // Poll by EXIT CODE, never by parsing a possibly-failed `ls`: an unreadable list is
    // unknown, not "gone" (the swallowed-error pattern the spec's decision row 3 forbids).
    const has = (): boolean => { try { tmux(['has-session', '-t', `=${session}`]); return true; } catch { return false; } };
    const deadline = Date.now() + 15_000;
    let alive = true;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (!has()) { alive = false; break; }
    }
    expect(alive).toBe(false);
  }, 30_000);

  it('the FINALLY-FIRST path: when the timer fires on an already-dead target, a sibling pane is untouched', async () => {
    // The lessons-aware review reproduced this on tmux 3.7c: a bare `kill-session` on a
    // missing target makes tmux render the error into the active pane of ANOTHER session and
    // flip it into view-mode, where `send-keys` (instar's inbound injection) no longer reaches
    // the shell. Every SUCCESSFUL arm would have planted that 600 s later.
    const other = `other-${Date.now().toString(36)}`;
    tmux(['new-session', '-d', '-s', other, '-c', dir, '-x', '80', '-y', '24']);
    const session = `instar-codex-arm-${Date.now().toString(36)}`;
    const wrapper = path.join(dir, 'tmux');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${TMUX}' -S '${socket}' "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
    tmux(armSessionCreateArgv(wrapper, session, { projectDir: dir, codexHome: dir, ttlMs: 3_000 })!);
    // The happy path: the driver's finally kills the arm session right away.
    tmux(['kill-session', '-t', `=${session}`]);
    // Let the timer fire on the now-missing target.
    await new Promise((r) => setTimeout(r, 5_000));
    const mode = tmux(['display-message', '-p', '-t', `=${other}:`, '#{pane_in_mode}']).trim();
    expect(mode).toBe('0');
    // And keystrokes still reach the sibling's shell.
    const marker = `ok-${Date.now()}`;
    tmux(['send-keys', '-t', `=${other}:`, `echo ${marker}`, 'Enter']);
    await new Promise((r) => setTimeout(r, 800));
    const pane = tmux(['capture-pane', '-p', '-t', `=${other}:`]);
    expect(pane.split('\n').filter((l) => l.trim() === marker).length).toBeGreaterThanOrEqual(1);
    tmux(['kill-session', '-t', `=${other}`]);
  }, 30_000);

  it('the exact target form does not kill a longer-named sibling', () => {
    const base = `instar-codex-arm-${Date.now().toString(36)}`;
    const sibling = `${base}zz`;
    tmux(['new-session', '-d', '-s', sibling, '-c', dir]);
    // `=base` must refuse: there is no session named exactly `base`.
    expect(() => tmux(['kill-session', '-t', `=${base}`])).toThrow();
    expect(tmux(['ls', '-F', '#{session_name}'])).toContain(sibling);
    tmux(['kill-session', '-t', `=${sibling}`]);
  });
});
