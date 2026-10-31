/** Locate the Windows host's interactive companion from an Instar process
 * running under WSL 2. No network or Windows process is started by discovery. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withSyncOp } from './InFlightSyncOpMarker.js';
import { readWindowsDesktopUnicastAddresses, resolveWindowsDesktopBridgeAddress } from './WindowsDesktopBridgeAddress.js';

export interface WindowsDesktopCompanionLocation {
  endpoint: string;
  secret: Buffer;
  appDataPath: string;
  localTransportScript: string;
}

function wslGateway(): string {
  const routes = fs.readFileSync('/proc/net/route', 'utf8').split('\n');
  const defaultRoute = routes.slice(1).map(line => line.trim().split(/\s+/))
    .find(parts => parts[1] === '00000000' && /^[A-Fa-f0-9]{8}$/.test(parts[2] || ''));
  if (!defaultRoute) throw new Error('windows-desktop-wsl-gateway-unavailable');
  const bytes = (defaultRoute[2] || '').match(/../g);
  if (!bytes || bytes.length !== 4) throw new Error('windows-desktop-wsl-gateway-invalid');
  const octets = bytes.reverse().map(byte => Number.parseInt(byte, 16));
  const privateIp = octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
  if (!privateIp) throw new Error('windows-desktop-wsl-gateway-not-private');
  return octets.join('.');
}

export function discoverWindowsDesktopCompanion(): WindowsDesktopCompanionLocation {
  if (process.platform !== 'linux'
    || !/microsoft|wsl/i.test(fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8'))) {
    throw new Error('windows-desktop-wsl-unavailable');
  }
  const windowsAppData = withSyncOp(() => execFileSync('cmd.exe', ['/c', 'echo', '%LOCALAPPDATA%'], {
    encoding: 'utf8', timeout: 3_000, maxBuffer: 4_096,
  })).replace(/\r/g, '').trim();
  if (!/^[A-Za-z]:\\/.test(windowsAppData) || windowsAppData.includes('%')) {
    throw new Error('windows-desktop-appdata-unavailable');
  }
  const appDataPath = withSyncOp(() => execFileSync('wslpath', ['-u', windowsAppData], {
    encoding: 'utf8', timeout: 3_000, maxBuffer: 4_096,
  })).trim();
  const secretPath = path.join(appDataPath, 'InstarDesktop', 'companion.secret');
  const secret = fs.readFileSync(secretPath);
  if (secret.length !== 32) throw new Error('windows-desktop-companion-secret-invalid');
  const gateway = wslGateway();
  const addressPath = path.join(appDataPath, 'InstarDesktop', 'bridge.address');
  const persistedAddress = fs.existsSync(addressPath) ? fs.readFileSync(addressPath, 'utf8').trim() : undefined;
  const windowsAddresses = readWindowsDesktopUnicastAddresses();
  const address = resolveWindowsDesktopBridgeAddress(persistedAddress, gateway, windowsAddresses);
  const localTransportPath = path.join(appDataPath, 'InstarDesktop', 'local-transport.ps1');
  if (!fs.existsSync(localTransportPath)) throw new Error('windows-desktop-local-transport-unavailable');
  return { endpoint: `http://${address}:44818/`, secret, appDataPath,
    localTransportScript: path.win32.join(windowsAppData, 'InstarDesktop', 'local-transport.ps1') };
}
