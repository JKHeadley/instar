import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { classifyWindowsDesktopBootstrapError, classifyWindowsDesktopPrepareFailure, readWindowsDesktopBootstrapStatus,
  writeWindowsDesktopBootstrapStatus } from '../../src/core/WindowsDesktopBootstrapStatus.js';

describe('Windows desktop bootstrap status', () => {
  it('returns a fixed phase and code without echoing installer paths or addresses', () => {
    const error = Object.assign(new Error('Command failed: powershell.exe -BindAddress 172.30.96.1'), {
      stderr: Buffer.from('C:\\Users\\Justin\\AppData\\secret\ninstar-desktop-installer-phase:stage\nWindows companion stage did not confirm its task state'),
    });
    expect(classifyWindowsDesktopBootstrapError(error)).toEqual({
      state: 'install-failed', phase: 'stage', code: 'stage-unconfirmed',
    });
    expect(classifyWindowsDesktopBootstrapError({ stderr: 'instar-desktop-installer-phase:install\nprivate token' }))
      .toEqual({ state: 'install-failed', phase: 'install', code: 'installer-process-failed' });
    expect(classifyWindowsDesktopBootstrapError({ stderr: 'instar-desktop-installer-phase:stage\nAdd-Type: error CS1002' }))
      .toEqual({ state: 'install-failed', phase: 'stage', code: 'companion-compile-failed' });
  });

  it('distinguishes update transport failures using only fixed codes', () => {
    for (const code of ['prepare-http-forbidden', 'prepare-http-not-found', 'prepare-http-other',
      'prepare-connect-refused', 'prepare-connect-unavailable', 'prepare-timeout', 'prepare-reply-invalid',
      'prepare-local-timeout', 'prepare-local-forbidden', 'prepare-local-unavailable', 'prepare-local-reply-invalid']) {
      const error = { stderr: `instar-desktop-installer-phase:update\nC:\\Users\\private\\companion.secret\nRunning Windows companion did not prepare for update: ${code}` };
      expect(classifyWindowsDesktopBootstrapError(error)).toEqual({ state: 'install-failed', phase: 'update', code });
    }
  });

  it('classifies the actual update request failures without exposing network details', () => {
    expect(classifyWindowsDesktopPrepareFailure(new Error('companion-reply-http-403'))).toBe('prepare-http-forbidden');
    expect(classifyWindowsDesktopPrepareFailure(new Error('companion-reply-http-404'))).toBe('prepare-http-not-found');
    expect(classifyWindowsDesktopPrepareFailure(new Error('companion-reply-http-500'))).toBe('prepare-http-other');
    expect(classifyWindowsDesktopPrepareFailure(new TypeError('fetch failed', { cause: Object.assign(new Error('private 10.0.0.1'), { code: 'ECONNREFUSED' }) }))).toBe('prepare-connect-refused');
    expect(classifyWindowsDesktopPrepareFailure({ name: 'TimeoutError', message: 'private address' })).toBe('prepare-timeout');
    expect(classifyWindowsDesktopPrepareFailure(new Error('private path'))).toBe('prepare-reply-invalid');
  });

  it('writes one bounded maintenance status and rejects malformed or forged data', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-bootstrap-status-'));
    try {
      expect(readWindowsDesktopBootstrapStatus(root)).toBeNull();
      writeWindowsDesktopBootstrapStatus(root, { state: 'install-failed', phase: 'address', code: 'windows-addresses-unavailable' });
      expect(readWindowsDesktopBootstrapStatus(root)).toEqual({ state: 'install-failed', phase: 'address', code: 'windows-addresses-unavailable' });
      const file = path.join(root, 'state', 'windows-desktop-bootstrap.json');
      const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(file, JSON.stringify({ ...current, bootNonce: 'previous-boot' }));
      expect(readWindowsDesktopBootstrapStatus(root)).toBeNull();
      fs.writeFileSync(file, JSON.stringify({ state: 'install-failed', phase: 'address', code: 'secret' }));
      expect(readWindowsDesktopBootstrapStatus(root)).toBeNull();
      fs.writeFileSync(file, 'x'.repeat(1_025));
      expect(readWindowsDesktopBootstrapStatus(root)).toBeNull();
      writeWindowsDesktopBootstrapStatus(root, { state: 'ready' });
      expect(readWindowsDesktopBootstrapStatus(root)).toEqual({ state: 'ready' });
    } finally {
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'desktop bootstrap status test cleanup' });
    }
  });

  it('names fast installer failures that used to fall back to installer-process-failed', () => {
    const cases: Array<[unknown, string, string]> = [
      // execFileSync spells a missing program "spawnSync <file> ENOENT".
      [{ stderr: 'instar-desktop-installer-phase:preflight\nspawnSync cmd.exe ENOENT' }, 'preflight', 'cmd-unavailable'],
      [{ stderr: 'instar-desktop-installer-phase:preflight\nspawnSync wslpath ENOENT' }, 'preflight', 'wslpath-unavailable'],
      [{ stderr: 'instar-desktop-installer-phase:stage\nspawnSync powershell.exe ENOENT' }, 'stage', 'powershell-unavailable'],
      [{ stderr: 'instar-desktop-installer-phase:preflight\nspawnSync cmd.exe ETIMEDOUT' }, 'preflight', 'windows-command-timeout'],
      [{ stderr: 'instar-desktop-installer-phase:preflight\n/mnt/c/Windows/system32/cmd.exe: cannot execute binary file: Exec format error' }, 'preflight', 'windows-interop-unavailable'],
      [{ stderr: 'instar-desktop-installer-phase:preflight\n<3>WSL ERROR: UtilBindVsockAnyPort:307: socket failed 1' }, 'preflight', 'windows-interop-unavailable'],
      // A load failure has no phase marker, because the handler is not yet registered.
      [{ stderr: "SyntaxError: The requested module '../dist/core/WindowsDesktopBridgeAddress.js' does not provide an export named 'x'" }, 'preflight', 'installer-module-load-failed'],
      [{ stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/opt/private/dist/core/WindowsDesktopBootstrapStatus.js'" }, 'preflight', 'installer-module-load-failed'],
    ];
    for (const [error, phase, code] of cases) {
      expect(classifyWindowsDesktopBootstrapError(error)).toEqual({ state: 'install-failed', phase, code });
    }
  });

  it('covers the remaining spellings and alternatives of each Windows command failure', () => {
    const cases: Array<[string, string]> = [
      ['spawn powershell.exe ENOENT', 'powershell-unavailable'], // the async spelling still works
      ['spawn wslpath ENOENT', 'wslpath-unavailable'],
      ['/bin/sh: 1: cmd.exe: not found', 'cmd-unavailable'],
      ['spawnSync wslpath ETIMEDOUT', 'windows-command-timeout'],
      ['spawnSync powershell.exe ETIMEDOUT', 'windows-command-timeout'],
      ['spawnSync cmd.exe ENOEXEC', 'windows-interop-unavailable'],
      ['<3>WSL ERROR: UtilAcceptVsock:271: accept4 failed 110', 'windows-interop-unavailable'],
      ['spawnSync powershell.exe ENOBUFS', 'installer-output-overflow'],
      ['spawnSync flock ENOENT', 'flock-unavailable'],
    ];
    for (const [text, code] of cases) {
      expect(classifyWindowsDesktopBootstrapError({ stderr: `instar-desktop-installer-phase:preflight\n${text}` }).code).toBe(code);
    }
    // A load error mentioning EACCES or a CS-like path segment is still a load failure.
    expect(classifyWindowsDesktopBootstrapError({ stderr: "Error: Cannot find module '/home/u/CS2024/dist/x.js' (EACCES)" }).code)
      .toBe('installer-module-load-failed');
  });

  it('reads the real nested flock layout: the locked child, a flock kill, and a busy lock', () => {
    // What the parent sees: the outer installer copies the locked child's stderr,
    // then its own handler prints the outer phase and the execFileSync message.
    // Node's execFileSync appends the child's stderr to its own message, as here.
    const outer = (inner: string, message: string) => {
      const stderr = `${inner}instar-desktop-installer-phase:address\n${message}\n`;
      return Object.assign(new Error(`Command failed: /usr/bin/node install-windows-desktop-companion.mjs --enable\n${stderr}`),
        { status: 1, stderr });
    };
    const flockFailed = 'Command failed: flock -n -F /mnt/c/Users/private/InstarDesktop/install.lock /usr/bin/node x --enable --locked';
    // The locked child failed for its own reason: its phase and cause win.
    expect(classifyWindowsDesktopBootstrapError(outer(
      'instar-desktop-installer-phase:stage\nWindows companion stage did not confirm its task state\n', `${flockFailed}\nprivate`)))
      .toEqual({ state: 'install-failed', phase: 'stage', code: 'stage-unconfirmed' });
    // flock killed the child at its 130 s limit.
    expect(classifyWindowsDesktopBootstrapError(outer('', 'spawnSync flock ETIMEDOUT')))
      .toEqual({ state: 'install-failed', phase: 'address', code: 'installer-timeout' });
    // Another install holds the lock: flock -n exits 1 with no output.
    expect(classifyWindowsDesktopBootstrapError(outer('', flockFailed)))
      .toEqual({ state: 'install-failed', phase: 'address', code: 'install-lock-busy' });
    // The child failed for a reason with no pattern: not mistaken for a busy lock.
    expect(classifyWindowsDesktopBootstrapError(outer('instar-desktop-installer-phase:install\nsomething private\n', flockFailed)))
      .toEqual({ state: 'install-failed', phase: 'install', code: 'installer-process-failed' });
    // A plain nonzero exit carries no error code, so a child's own command timeout is not an installer timeout.
    expect(classifyWindowsDesktopBootstrapError(Object.assign(new Error('Command failed: node x\nspawnSync cmd.exe ETIMEDOUT'), { status: 1 })).code)
      .toBe('windows-command-timeout');
  });

  it('reports the parent time limit and output cap from the error code, ahead of any output text', () => {
    expect(classifyWindowsDesktopBootstrapError(Object.assign(new Error('spawnSync /usr/bin/node ETIMEDOUT'), {
      code: 'ETIMEDOUT', signal: 'SIGTERM', stderr: 'instar-desktop-installer-phase:stage\nAccess is denied',
    }))).toEqual({ state: 'install-failed', phase: 'stage', code: 'installer-timeout' });
    expect(classifyWindowsDesktopBootstrapError(Object.assign(new Error('spawnSync /usr/bin/node ENOBUFS'), { code: 'ENOBUFS' })))
      .toEqual({ state: 'install-failed', phase: 'preflight', code: 'installer-output-overflow' });
    // An unrelated code field is ignored, and an unknown failure keeps the fallback.
    expect(classifyWindowsDesktopBootstrapError(Object.assign(new Error('Command failed'), { code: 'toString', stderr: 'private' })))
      .toEqual({ state: 'install-failed', phase: 'preflight', code: 'installer-process-failed' });
  });

  it('accepts every new code back from the status file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-bootstrap-codes-'));
    try {
      for (const code of ['cmd-unavailable', 'windows-command-timeout', 'windows-interop-unavailable',
        'installer-module-load-failed', 'installer-timeout', 'installer-output-overflow', 'flock-unavailable',
        'install-lock-busy']) {
        writeWindowsDesktopBootstrapStatus(root, { state: 'install-failed', phase: 'preflight', code });
        expect(readWindowsDesktopBootstrapStatus(root)).toEqual({ state: 'install-failed', phase: 'preflight', code });
      }
    } finally {
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'desktop bootstrap codes test cleanup' });
    }
  });
});
