/** Mechanical fleet-coherence gate for live machine-identity trust mutation. */
import type { MachineCapacity } from './types.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MACHINE_IDENTITY_ACCEPT_ROUTE_MIN_VERSION = '1.3.1217';
export const MACHINE_IDENTITY_COHERENCE_FLAGS = [
  'identityReannounce.enabled',
  'observedEndpoints.enabled',
  'recoveryKeyEscrow.enabled',
] as const;

export type IdentityFeatureMode = 'off' | 'dry-run' | 'live';
export interface IdentityActivationPeerEvidence { machineId: string; advertHash: string; receivedAt: string }

function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string) => value.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((part) => Number(part));
  const a = parse(actual);
  const b = parse(minimum);
  if (a.length < 3 || b.length < 3 || a.some((n) => !Number.isSafeInteger(n))) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

export function evaluateMachineIdentityActivation(input: {
  selfMachineId: string;
  capacities: MachineCapacity[];
  localModes: Record<(typeof MACHINE_IDENTITY_COHERENCE_FLAGS)[number], IdentityFeatureMode>;
  requiredPeerMachineIds?: string[];
  minimumVersion?: string;
  now?: number;
  maxAdvertAgeMs?: number;
}): { allowed: true; evidence: IdentityActivationPeerEvidence[] } | { allowed: false; reasons: string[] } {
  if (!Object.values(input.localModes).includes('live')) return { allowed: true, evidence: [] };
  const reasons: string[] = [];
  const now = input.now ?? Date.now();
  const maxAdvertAgeMs = input.maxAdvertAgeMs ?? 2 * 60_000;
  const required = [...new Set(input.requiredPeerMachineIds
    ?? input.capacities.filter((row) => row.online && row.machineId !== input.selfMachineId).map((row) => row.machineId))].sort();
  const evidence: IdentityActivationPeerEvidence[] = [];
  for (const machineId of required) {
    const peer = input.capacities.find((row) => row.machineId === machineId && row.online);
    if (!peer) {
      reasons.push(`${machineId}:authenticated-presence-missing`);
      continue;
    }
    const advert = peer.coherenceAdvert;
    if (!advert) {
      reasons.push(`${peer.machineId}:accept-route-version-unverified`);
      continue;
    }
    const receivedAtMs = Date.parse(peer.coherenceAdvertReceivedAt ?? '');
    if (!Number.isFinite(receivedAtMs) || receivedAtMs > now || now - receivedAtMs > maxAdvertAgeMs) {
      reasons.push(`${peer.machineId}:coherence-advert-stale`);
      continue;
    }
    if (!versionAtLeast(advert.instarVersion, input.minimumVersion ?? MACHINE_IDENTITY_ACCEPT_ROUTE_MIN_VERSION)) {
      reasons.push(`${peer.machineId}:accept-route-version-too-old`);
    }
    for (const key of MACHINE_IDENTITY_COHERENCE_FLAGS) {
      if (advert.flags[key] !== input.localModes[key]) reasons.push(`${peer.machineId}:flag-skew:${key}`);
    }
    if (!reasons.some((reason) => reason.startsWith(`${peer.machineId}:`))) {
      evidence.push({
        machineId: peer.machineId,
        advertHash: crypto.createHash('sha256').update(JSON.stringify(advert)).digest('hex'),
        receivedAt: peer.coherenceAdvertReceivedAt!,
      });
    }
  }
  return reasons.length === 0 ? { allowed: true, evidence } : { allowed: false, reasons };
}

interface ActivationProof {
  version: 2;
  verifiedAt: string;
  localModes: Record<string, IdentityFeatureMode>;
  verifiedPeers: IdentityActivationPeerEvidence[];
}

export function recordMachineIdentityActivationProof(
  stateDir: string,
  localModes: Record<string, IdentityFeatureMode>,
  verifiedPeers: IdentityActivationPeerEvidence[],
  now = Date.now(),
): void {
  const file = path.join(stateDir, 'state', 'machine-identity-activation-proof.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({
    version: 2, verifiedAt: new Date(now).toISOString(), localModes,
    verifiedPeers: [...verifiedPeers].sort((a, b) => a.machineId.localeCompare(b.machineId)),
  }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function hasFreshMachineIdentityActivationProof(
  stateDir: string,
  localModes: Record<string, IdentityFeatureMode>,
  requiredPeerMachineIds: string[] = [],
  now = Date.now(),
  maxAgeMs = 24 * 60 * 60_000,
): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'machine-identity-activation-proof.json'), 'utf8')) as ActivationProof;
    const expectedPeers = [...new Set(requiredPeerMachineIds)].sort();
    return parsed?.version === 2
      && now - Date.parse(parsed.verifiedAt) >= 0
      && now - Date.parse(parsed.verifiedAt) <= maxAgeMs
      && JSON.stringify(parsed.localModes) === JSON.stringify(localModes)
      && Array.isArray(parsed.verifiedPeers)
      && JSON.stringify(parsed.verifiedPeers.map((row) => row.machineId).sort()) === JSON.stringify(expectedPeers)
      && parsed.verifiedPeers.every((row) => /^[a-f0-9]{64}$/.test(row.advertHash)
        && Number.isFinite(Date.parse(row.receivedAt)) && Date.parse(row.receivedAt) <= Date.parse(parsed.verifiedAt));
  } catch { // @silent-fallback-ok: missing/corrupt proof is the fail-closed false verdict and keeps mutation held
    return false;
  }
}

/** Production boot-order seam: authenticated presence must finish before the
 * activation verdict is evaluated or persisted. */
export async function activateMachineIdentityAfterAuthenticatedPull(input: {
  pullAuthenticatedPresence: () => Promise<unknown>;
  selfMachineId: string;
  requiredPeerMachineIds: string[];
  capacities: () => MachineCapacity[];
  localModes: Record<(typeof MACHINE_IDENTITY_COHERENCE_FLAGS)[number], IdentityFeatureMode>;
  stateDir: string;
  now?: () => number;
}): Promise<ReturnType<typeof evaluateMachineIdentityActivation>> {
  await input.pullAuthenticatedPresence();
  const now = input.now?.() ?? Date.now();
  const verdict = evaluateMachineIdentityActivation({
    selfMachineId: input.selfMachineId,
    capacities: input.capacities(),
    localModes: input.localModes,
    requiredPeerMachineIds: input.requiredPeerMachineIds,
    now,
  });
  if (verdict.allowed && Object.values(input.localModes).includes('live')) {
    recordMachineIdentityActivationProof(input.stateDir, input.localModes, verdict.evidence, now);
  }
  return verdict;
}
