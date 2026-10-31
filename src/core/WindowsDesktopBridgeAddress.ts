import { execFileSync } from 'node:child_process';
import { withSyncOp } from './InFlightSyncOpMarker.js';

/** The WSL default route is the Windows host only in NAT mode. In mirrored
 * mode it can be the LAN router; Windows and WSL then share loopback. */
export function selectWindowsDesktopBridgeAddress(gateway: string, windowsAddresses: readonly string[]): string {
  const parts = gateway.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)
    || !(parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168))) {
    throw new Error('windows-desktop-wsl-gateway-not-private');
  }
  return windowsAddresses.includes(gateway) ? gateway : '127.0.0.1';
}

/** A persisted bridge address is never allowed to redirect the secret-bearing
 * companion protocol to an arbitrary network endpoint. */
export function validateWindowsDesktopBridgeAddress(
  address: string, gateway: string, windowsAddresses: readonly string[],
): string {
  if (address !== selectWindowsDesktopBridgeAddress(gateway, windowsAddresses)) {
    throw new Error('windows-desktop-bridge-address-invalid');
  }
  return address;
}

export function resolveWindowsDesktopBridgeAddress(
  persistedAddress: string | undefined, gateway: string, windowsAddresses: readonly string[],
): string {
  if (persistedAddress === undefined) throw new Error('windows-desktop-bridge-address-unavailable');
  return validateWindowsDesktopBridgeAddress(persistedAddress, gateway, windowsAddresses);
}

/** Ask Windows which addresses it owns before using a WSL route as a host
 * endpoint. The route itself is not proof: in mirrored mode it is a router. */
export function readWindowsDesktopUnicastAddresses(): string[] {
  let addresses: unknown;
  try {
    const output = withSyncOp(() => execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '[string[]]$ips = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | ForEach-Object { $_.GetIPProperties().UnicastAddresses | ForEach-Object { $_.Address.ToString() } }; ConvertTo-Json -InputObject $ips -Compress',
    ], { encoding: 'utf8', timeout: 8_000, maxBuffer: 16_384 })).trim();
    addresses = JSON.parse(output);
  } catch {
    throw new Error('windows-desktop-windows-addresses-unavailable');
  }
  if (!Array.isArray(addresses) || addresses.some(value => typeof value !== 'string')) {
    throw new Error('windows-desktop-windows-addresses-unavailable');
  }
  return addresses as string[];
}
