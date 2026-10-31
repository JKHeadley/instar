import { describe, expect, it } from 'vitest';
import { resolveWindowsDesktopBridgeAddress, selectWindowsDesktopBridgeAddress, validateWindowsDesktopBridgeAddress } from '../../src/core/WindowsDesktopBridgeAddress.js';

describe('Windows desktop WSL bridge address', () => {
  it('uses the Windows-owned NAT gateway', () => {
    expect(selectWindowsDesktopBridgeAddress('172.30.96.1', ['127.0.0.1', '172.30.96.1']))
      .toBe('172.30.96.1');
  });

  it('uses loopback when the WSL default route points at a LAN router in mirrored mode', () => {
    expect(selectWindowsDesktopBridgeAddress('192.168.87.1', ['127.0.0.1', '192.168.87.61']))
      .toBe('127.0.0.1');
  });

  it('rejects a non-private gateway or a redirected persisted address', () => {
    expect(() => selectWindowsDesktopBridgeAddress('8.8.8.8', ['8.8.8.8'])).toThrow();
    expect(() => validateWindowsDesktopBridgeAddress('192.168.87.61', '192.168.87.1', ['192.168.87.61'])).toThrow();
    expect(validateWindowsDesktopBridgeAddress('127.0.0.1', '192.168.87.1', ['192.168.87.61']))
      .toBe('127.0.0.1');
  });

  it('does not route to an unowned mirrored-mode gateway when the address file is missing or stale', () => {
    const windowsAddresses = ['127.0.0.1', '192.168.87.61'];
    expect(() => resolveWindowsDesktopBridgeAddress(undefined, '192.168.87.1', windowsAddresses))
      .toThrow('windows-desktop-bridge-address-unavailable');
    expect(() => resolveWindowsDesktopBridgeAddress('192.168.87.1', '192.168.87.1', windowsAddresses))
      .toThrow('windows-desktop-bridge-address-invalid');
    expect(() => resolveWindowsDesktopBridgeAddress('10.0.0.2', '192.168.87.1', windowsAddresses))
      .toThrow('windows-desktop-bridge-address-invalid');
  });

  it('accepts a persisted NAT gateway only when Windows currently owns it', () => {
    expect(resolveWindowsDesktopBridgeAddress('172.30.96.1', '172.30.96.1', ['172.30.96.1']))
      .toBe('172.30.96.1');
    expect(() => resolveWindowsDesktopBridgeAddress('172.30.96.1', '172.30.96.1', ['127.0.0.1']))
      .toThrow('windows-desktop-bridge-address-invalid');
  });
});
