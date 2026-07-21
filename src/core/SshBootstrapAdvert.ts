import net from 'node:net';

export interface SshBootstrapAdvert {
  machineId: string;
  agentId: string;
  pairingEpoch: number;
  observerBootId: string;
  clientKeyGeneration: number;
  hostKeyGeneration: number;
  clientPublicKey: string;
  sshHostPublicKeys: string[];
  endpoints: Array<{ host: string; port: number; source: 'tailscale' | 'lan' | 'configured' }>;
  issuedAt: string;
  expiresAt: string;
  hostKeyTransitionSignature?: string;
  machineSignature: string;
}

export function canonicalSshBootstrapAdvert(advert: Omit<SshBootstrapAdvert, 'machineSignature'>): string {
  return JSON.stringify({
    machineId: advert.machineId, agentId: advert.agentId, pairingEpoch: advert.pairingEpoch,
    observerBootId: advert.observerBootId, clientKeyGeneration: advert.clientKeyGeneration,
    hostKeyGeneration: advert.hostKeyGeneration, clientPublicKey: advert.clientPublicKey,
    sshHostPublicKeys: advert.sshHostPublicKeys, endpoints: advert.endpoints,
    issuedAt: advert.issuedAt, expiresAt: advert.expiresAt,
    ...(advert.hostKeyTransitionSignature ? { hostKeyTransitionSignature: advert.hostKeyTransitionSignature } : {}),
  });
}

/** Structural security floor; MachineAuth signature/principal validation precedes this call. */
export function validateSshBootstrapAdvert(input: unknown, principalMachineId: string, principalAgentId: string, now = Date.now()): SshBootstrapAdvert {
  if (!input || typeof input !== 'object') throw new Error('invalid-ssh-advert');
  const row = input as SshBootstrapAdvert;
  if (row.machineId !== principalMachineId || row.agentId !== principalAgentId) throw new Error('ssh-advert-principal-mismatch');
  if (!Number.isSafeInteger(row.pairingEpoch) || row.pairingEpoch < 1 || !Number.isSafeInteger(row.clientKeyGeneration) || !Number.isSafeInteger(row.hostKeyGeneration)) throw new Error('ssh-advert-generation-invalid');
  const issuedAt = Date.parse(row.issuedAt);
  const expiresAt = Date.parse(row.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now + 30_000 || expiresAt <= now || expiresAt - now > 300_000) throw new Error('ssh-advert-expired');
  if (!Array.isArray(row.sshHostPublicKeys) || !/^ssh-ed25519 [A-Za-z0-9+/=]+(?:\s|$)/.test(row.clientPublicKey) || row.sshHostPublicKeys.length < 1 || row.sshHostPublicKeys.length > 2 || row.sshHostPublicKeys.some(key => !/^ssh-ed25519 [A-Za-z0-9+/=]+(?:\s|$)/.test(key))) throw new Error('ssh-advert-key-invalid');
  if (!Array.isArray(row.endpoints) || row.endpoints.length > 8 || row.endpoints.some(endpoint => !validEndpoint(endpoint))) throw new Error('ssh-advert-endpoint-invalid');
  if (typeof row.observerBootId !== 'string' || row.observerBootId.length < 8 || row.observerBootId.length > 128 || typeof row.machineSignature !== 'string' || row.machineSignature.length < 32 || row.machineSignature.length > 512) throw new Error('ssh-advert-signature-invalid');
  if (row.hostKeyTransitionSignature !== undefined && (typeof row.hostKeyTransitionSignature !== 'string' || row.hostKeyTransitionSignature.length < 32 || row.hostKeyTransitionSignature.length > 512)) throw new Error('ssh-advert-transition-signature-invalid');
  return row;
}

function validEndpoint(endpoint: SshBootstrapAdvert['endpoints'][number]): boolean {
  if (!['tailscale', 'lan', 'configured'].includes(endpoint.source) || !Number.isInteger(endpoint.port) || endpoint.port < 1024 || endpoint.port > 65535) return false;
  if (net.isIP(endpoint.host) !== 4) return false;
  const [a, b] = endpoint.host.split('.').map(Number);
  return a === 10 || (a === 100 && b >= 64 && b <= 127) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
