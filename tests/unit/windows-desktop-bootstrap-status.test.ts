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
});
