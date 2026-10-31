import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { classifyWindowsDesktopBootstrapError, readWindowsDesktopBootstrapStatus,
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
