/**
 * Wiring integrity for the leak fix itself (Testing Integrity Standard).
 *
 * The independent review found that the self-destruct scheduling could be deleted from
 * `makeTmuxTrustDriver` and every existing test would still pass — the helper was tested in
 * isolation and the one line that PREVENTS the leak had no coverage. This test drives the
 * real driver against a recording fake `tmux` (via a fake binary on PATH is not possible
 * here, so the driver's `execFileSync` dependency is exercised through its tmuxPath pointing
 * at a shell script that logs its argv) and asserts the self-destruct is issued BEFORE codex
 * is launched, with the exact `=session` kill target, and that the finally still tears down.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTmuxTrustDriver, ARM_SESSION_TTL_MS } from '../../src/core/codexHookArm.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('makeTmuxTrustDriver wiring — the self-destruct is actually issued', () => {
  let dir: string;
  let fakeTmux: string;
  let logFile: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-wiring-'));
    logFile = path.join(dir, 'tmux-calls.log');
    fakeTmux = path.join(dir, 'tmux');
    // Records every argv line; prints a fake pane that immediately shows the hook-trust
    // prompt so the driver's state machine completes in one iteration.
    fs.writeFileSync(fakeTmux, `#!/bin/sh
printf '%s\\n' "$*" >> "${logFile}"
case "$1" in
  capture-pane) echo "Hooks need review"; echo "2. Trust all and continue";;
esac
exit 0
`);
    fs.chmodSync(fakeTmux, 0o755);
  });
  afterAll(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/codex-hook-arm-driver-wiring.test.ts' });
  });

  it('creates the session and its self-destruct in ONE tmux request, before codex launches, and still tears down', () => {
    const logs: string[] = [];
    const drive = makeTmuxTrustDriver({ tmuxPath: fakeTmux, codexBinary: '/bin/true', log: (m) => logs.push(m) });
    drive({ projectDir: dir, codexHome: dir, hooksJsonPath: path.join(dir, 'hooks.json') });

    const calls = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
    const idxNew = calls.findIndex((c) => c.startsWith('new-session'));
    const idxLaunch = calls.findIndex((c) => c.startsWith('send-keys') && c.includes('/bin/true'));
    const idxKill = calls.findIndex((c) => c.startsWith('kill-session'));
    expect(idxNew).toBeGreaterThanOrEqual(0);
    expect(idxLaunch).toBeGreaterThan(idxNew);
    expect(idxKill).toBeGreaterThan(idxLaunch); // the finally still tears down

    // The creation request ITSELF carries the timer: no separate run-shell call, no window
    // in which the session exists without it (cross-model review finding).
    const create = calls[idxNew];
    const session = create.match(/-s (instar-codex-arm-[0-9a-z]+)/)?.[1];
    expect(session).toBeTruthy();
    expect(create).toContain(' ; run-shell -b ');
    expect(create).toContain(`sleep ${Math.ceil(ARM_SESSION_TTL_MS / 1000)};`);
    expect(create).toContain(`kill-session -t '=${session}'`); // exact target, never prefix
    expect(calls.filter((c) => c.startsWith('run-shell'))).toHaveLength(0); // never a second request
    expect(calls[idxKill]).toBe(`kill-session -t =${session}`);  // the finally's is exact too
    expect(logs.some((l) => l.includes('created with self-destruct scheduled'))).toBe(true);
  });

  it('when the timer cannot be built safely, NO session is created and codex is NOT launched', () => {
    const logs: string[] = [];
    // A tmux path with a `#` is refused by the two-interpreter quoting guard.
    const badDir = path.join(dir, 'bad#path');
    fs.mkdirSync(badDir, { recursive: true });
    const badTmux = path.join(badDir, 'tmux');
    fs.copyFileSync(fakeTmux, badTmux);
    fs.chmodSync(badTmux, 0o755);
    const before = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '';
    const drive = makeTmuxTrustDriver({ tmuxPath: badTmux, codexBinary: '/bin/true', log: (m) => logs.push(m) });
    drive({ projectDir: dir, codexHome: dir, hooksJsonPath: path.join(dir, 'hooks.json') });
    const after = fs.readFileSync(logFile, 'utf-8');
    const newCalls = after.slice(before.length);
    expect(newCalls).not.toContain('new-session'); // arming without a net is the leak — refused outright
    expect(newCalls).not.toContain('/bin/true');
    expect(logs.some((l) => l.includes('refusing to create an arm session without a self-destruct'))).toBe(true);
    expect(logs.some((l) => l.includes('NOT scheduled'))).toBe(false); // no misleading teardown line for a session that never existed
    expect(newCalls).not.toContain('kill-session'); // and no teardown ran against it
  });
});
