import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isTailscaleCgnat } from '../core/PeerEndpointResolver.js';
import { isValidMeshEndpointShape } from '../core/MeshEndpointValidator.js';
import { isPeerUrlAllowedForCredentials, type PeerEndpointKind } from './peerUrlGuard.js';

// E2E-PAIRING: EXEMPT — this commit only annotates existing fail-closed catches in this server file; the desktop mesh production-boot test was paired with their implementation.

const execFileAsync = promisify(execFile);
type Peer = { url: string; kind: PeerEndpointKind };

/** A desktop-only exception for the tailnet rope. The ordinary Bearer-token
 * guard remains unchanged. No local daemon proof means this route stays dark. */
export async function desktopPeerUrlAllowed(peer: Peer,
  statusJson: () => Promise<string> = async () => (await execFileAsync('tailscale', ['status', '--json'], {
    timeout: 2_000, maxBuffer: 1_000_000,
  })).stdout): Promise<boolean> {
  let url: URL;
  try { url = new URL(peer.url); } catch {
    // @silent-fallback-ok — malformed URL is an explicit fail-closed denial.
    return false;
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return false;
  if (peer.kind !== 'last-known-url' && !isValidMeshEndpointShape(peer)) return false;
  if (isPeerUrlAllowedForCredentials(peer).ok) return true;
  if (peer.kind !== 'tailscale') return false;
  if (url.protocol !== 'http:' || !isTailscaleCgnat(url.hostname)) return false;
  try {
    const status = JSON.parse(await statusJson()) as {
      BackendState?: unknown;
      Peer?: Record<string, { Online?: unknown; PublicKey?: unknown; TailscaleIPs?: unknown }>;
    };
    if (status.BackendState !== 'Running' || !status.Peer || typeof status.Peer !== 'object') return false;
    return Object.values(status.Peer).some(candidate => candidate.Online === true
      && typeof candidate.PublicKey === 'string' && candidate.PublicKey.startsWith('nodekey:')
      && Array.isArray(candidate.TailscaleIPs)
      && candidate.TailscaleIPs.includes(url.hostname));
  } catch {
    // @silent-fallback-ok — absent or unreadable local Tailscale proof denies the credential-bearing call.
    return false;
  }
}
