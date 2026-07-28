/**
 * MeshUrlAdvertiser — populate a machine's `lastKnownUrl` so cross-machine
 * routing can actually reach it.
 *
 * THE BUG THIS FIXES (found via real-hardware dogfooding, 2026-05-29):
 * the Multi-Machine Session Pool routes every cross-machine RPC (deliver /
 * transfer / lease) to a peer by reading `registry.machines[id].lastKnownUrl`.
 * But the only writer of that field — `MachineIdentityManager.updateMachineUrl`
 * — had ZERO callers. So in production every peer's URL was null, the peer
 * filters (`!!e.lastKnownUrl`) dropped every peer, and no session could ever be
 * delivered or transferred across machines. The 3-tier tests missed it because
 * they inject peers with mock URLs and never exercise the runtime "where does
 * lastKnownUrl come from" path.
 *
 * A machine's reachable URL is its tunnel URL: a named tunnel's hostname is
 * known from config; a quick tunnel's URL is only known once `tunnel.start()`
 * resolves it. This module turns either into the value to advertise, and writes
 * it into the registry entry — from where the existing git-backed registry sync
 * (RegistrySyncDebouncer) propagates it to peers.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { MeshEndpoint } from './types.js';
import { isRfc1918, isTailscaleCgnat } from './PeerEndpointResolver.js';

export interface MeshTunnelConfig {
  enabled?: boolean;
  type?: string;
  hostname?: string;
}

/**
 * Resolve the URL this machine should advertise to the mesh.
 *
 * Preference order:
 *  1. A concretely-resolved tunnel URL (quick tunnels only know it at runtime;
 *     `tunnel.start()` returns it). This is authoritative when present.
 *  2. A named tunnel's deterministic `https://<hostname>`.
 *  3. null — no reachable URL (tunnel disabled / not configured). A machine
 *     with no tunnel is genuinely not reachable cross-machine; advertising
 *     nothing is correct (peers will skip it rather than route to a dead URL).
 */
export function resolveAdvertisedMeshUrl(
  tunnel: MeshTunnelConfig | undefined,
  resolvedTunnelUrl?: string | null,
): string | null {
  if (resolvedTunnelUrl && /^https?:\/\/\S+$/.test(resolvedTunnelUrl.trim())) {
    return resolvedTunnelUrl.trim().replace(/\/+$/, '');
  }
  if (tunnel?.enabled !== false && tunnel?.hostname && tunnel.hostname.trim()) {
    const host = tunnel.hostname.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (host) return `https://${host}`;
  }
  return null;
}

/** Minimal slice of MachineIdentityManager this module needs (keeps it testable). */
export interface MeshUrlRecorder {
  getMachineUrl(machineId: string): string | null;
  updateMachineUrl(machineId: string, url: string): void;
  /** multi-transport-mesh-comms — write this machine's advertised endpoint set. */
  getMachineEndpoints?(machineId: string): MeshEndpoint[] | undefined;
  updateMachineEndpoints?(machineId: string, endpoints: MeshEndpoint[]): void;
}

/**
 * Advertise this machine's reachable URL into its own registry entry so peers
 * can route to it. Idempotent (no write when unchanged), and tolerant when the
 * self entry isn't present yet (best-effort — boot ordering can race the
 * registration). Returns true iff it wrote a new value.
 */
export function advertiseSelfMeshUrl(
  recorder: MeshUrlRecorder,
  selfMachineId: string,
  url: string | null,
  log?: (msg: string) => void,
): boolean {
  if (!url || !selfMachineId) return false;
  try {
    if (recorder.getMachineUrl(selfMachineId) === url) return false; // idempotent
    recorder.updateMachineUrl(selfMachineId, url);
    log?.(`  Mesh: advertised self URL → ${url}`);
    return true;
  } catch {
    // Self entry not present yet — caller may retry on a later lifecycle event.
    return false;
  }
}

// ── multi-transport-mesh-comms (Layer 0) — endpoint discovery + advertisement ──
// This EXTENDS the advertiser above (NOT a second module racing the same registry
// write): computeSelfMeshEndpoints is computed alongside lastKnownUrl and written
// at the same updateMachineUrl write-point. Spec: docs/specs/multi-transport-mesh-comms.md.

/** Candidate macOS/Linux locations for the tailscale CLI (Decision 16 — not on PATH on macOS). */
const TAILSCALE_BIN_CANDIDATES = [
  'tailscale', // PATH (Linux / brew symlink)
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale', // macOS GUI app bundle
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
];

/** Resolve the tailscale binary path, or null if none present. */
export function resolveTailscaleBin(candidates: string[] = TAILSCALE_BIN_CANDIDATES, exists = existsSync): string | null {
  for (const c of candidates) {
    if (c === 'tailscale') {
      // PATH form — assume the OS resolves it; only used when absolute paths miss.
      continue;
    }
    if (exists(c)) return c;
  }
  // Fall back to the PATH name (execFile will ENOENT if truly absent → null IP).
  return 'tailscale';
}

export type ExecFileFn = (
  file: string,
  args: string[],
  cb: (err: Error | null, stdout: string) => void,
) => void;

const defaultExecFile: ExecFileFn = (file, args, cb) => {
  execFile(file, args, { timeout: 3000 }, (err, stdout) => cb(err, String(stdout ?? '')));
};

/**
 * Detect this machine's Tailscale IPv4 (Decision 16): `tailscale ip -4` via the
 * resolved bin, accept ONLY a single well-formed 100.64/10 CGNAT address. Bounded
 * 3s, fail-silent → null. Injectable exec + bin-exists for unit tests.
 */
export async function detectTailscaleIp(opts?: {
  execFileFn?: ExecFileFn;
  bin?: string | null;
}): Promise<string | null> {
  const bin = opts?.bin === undefined ? resolveTailscaleBin() : opts.bin;
  if (!bin) return null;
  const exec = opts?.execFileFn ?? defaultExecFile;
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const done = (v: string | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      exec(bin, ['ip', '-4'], (err, stdout) => {
        if (err) return done(null);
        const first = String(stdout).split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(first) && isTailscaleCgnat(first)) return done(first);
        return done(null);
      });
    } catch {
      done(null);
    }
  });
}

/** A minimal os.networkInterfaces()-shaped input (keeps the picker pure/testable). */
export type NetIfaces = Record<string, Array<{ address: string; family: string | number; internal: boolean }> | undefined>;

/**
 * Pick this machine's PRIMARY private IPv4 (Decision: first non-internal RFC-1918
 * IPv4 on an "en" or "eth" interface). Returns null if none. Pure over the
 * supplied interfaces map.
 */
export function pickPrimaryLanIp(ifaces: NetIfaces): string | null {
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!/^(en|eth)\d+$/i.test(name)) continue;
    for (const a of addrs ?? []) {
      const isV4 = a.family === 'IPv4' || a.family === 4;
      if (isV4 && !a.internal && isRfc1918(a.address)) return a.address;
    }
  }
  return null;
}

/**
 * Compute this machine's advertised endpoint set. Pure assembly over the resolved
 * inputs (cloudflare from the tunnel, lan from os, tailscale from detection). The
 * resolved lastKnownUrl is the cloudflare rope. Ordered cloudflare→lan→tailscale
 * here is irrelevant (the resolver re-orders by priority); the set is what matters.
 */
export function computeSelfMeshEndpoints(inputs: {
  cloudflareUrl: string | null;
  lanIp: string | null;
  tailscaleIp: string | null;
  port: number;
  tailscaleEnabled?: boolean;
}): MeshEndpoint[] {
  const out: MeshEndpoint[] = [];
  if (inputs.tailscaleEnabled !== false && inputs.tailscaleIp) {
    out.push({ kind: 'tailscale', url: `http://${inputs.tailscaleIp}:${inputs.port}` });
  }
  if (inputs.lanIp) {
    out.push({ kind: 'lan', url: `http://${inputs.lanIp}:${inputs.port}` });
  }
  if (inputs.cloudflareUrl) {
    out.push({ kind: 'cloudflare', url: inputs.cloudflareUrl });
  }
  return out;
}

/**
 * multi-transport-mesh-comms (Layer 0.5) — resolve the HTTP server bind host.
 *
 * Precedence: an EXPLICIT non-loopback `configHost` wins → else `meshBindHostOverride`
 * (meshTransport.bindHost) → else the mesh default (`0.0.0.0` when multi-machine +
 * mesh active, `127.0.0.1` otherwise).
 *
 * The load-bearing subtlety (the 1.3.630 bind-inert bug, caught in live-verify):
 * `loadConfig` ALWAYS defaults `host` to '127.0.0.1' when unset, so a naive
 * `configHost || meshBindDefault` can NEVER reach meshBindDefault. We therefore treat
 * a LOOPBACK configHost as NON-explicit (indistinguishable from the default), so the
 * mesh default applies; a genuinely explicit non-loopback host still wins, and
 * meshTransport.bindHost is the escape hatch to force loopback on a mesh agent.
 *
 * Extracted as a pure function precisely because the original inline version was
 * untestable — every mocked-config unit test passed while the real bind stayed
 * 127.0.0.1.
 */
export function resolveMeshBindHost(opts: {
  configHost?: string;
  meshBindActive: boolean;
  meshBindHostOverride?: string;
}): string {
  const { configHost, meshBindActive, meshBindHostOverride } = opts;
  const isLoopback = (h?: string): boolean => h === '127.0.0.1' || h === 'localhost' || h === '::1';
  const explicitHost = configHost && !isLoopback(configHost) ? configHost : undefined;
  const meshBindDefault = meshBindActive ? '0.0.0.0' : '127.0.0.1';
  return explicitHost || meshBindHostOverride || meshBindDefault;
}

/** Shallow value-equality of two endpoint sets (order-independent) — for idempotent writes. */
export function endpointsEqual(a: MeshEndpoint[] | undefined, b: MeshEndpoint[] | undefined): boolean {
  const norm = (x: MeshEndpoint[] | undefined) =>
    (x ?? []).map((e) => `${e.kind} ${e.url}`).sort().join('|');
  return norm(a) === norm(b);
}

/**
 * Advertise this machine's endpoint set into its own registry entry (idempotent).
 * Returns true iff it wrote a new value. No-op when the recorder doesn't support
 * endpoints (un-upgraded) or the set is unchanged.
 */
export function advertiseSelfMeshEndpoints(
  recorder: MeshUrlRecorder,
  selfMachineId: string,
  endpoints: MeshEndpoint[],
  log?: (msg: string) => void,
): boolean {
  if (!selfMachineId || !recorder.updateMachineEndpoints) return false;
  try {
    const current = recorder.getMachineEndpoints?.(selfMachineId);
    if (endpointsEqual(current, endpoints)) return false; // idempotent
    recorder.updateMachineEndpoints(selfMachineId, endpoints);
    log?.(`  Mesh: advertised ${endpoints.length} endpoint(s) [${endpoints.map((e) => e.kind).join(',')}]`);
    return true;
  } catch {
    // @silent-fallback-ok: best-effort advertisement — a registry write race/absence
    // means peers simply keep the prior endpoint set; the next heartbeat retries. Not
    // a degradation (mesh transport degrades gracefully to the remaining ropes).
    return false;
  }
}
