import type { RequestListener } from 'node:http';
import { MachineIdentityManager } from '../core/MachineIdentity.js';
import { startHostedRelayAgentTlsListener } from './agentTlsListener.js';
import { normalizeHostedRelayHostname } from './clientHello.js';
import { createHostedRelayOwnerEvidenceReader } from './ownerLeaseReader.js';
import { startHostedRelayRuntime } from './runtimeAdmission.js';
import { createHostedRelayVerifiedDialer } from './verifiedDialer.js';

/** Explicit boot composition. All assignment inputs come from boot-owned
 * configuration and committed stores, never the pairing request. */
export async function startVerifiedHostedRelay(options: {
  enabled: boolean;
  stateDir: string;
  signal: AbortSignal;
  scope: { hostname: string; agentId: string; assignment: string; pinnedGenesis: string };
  evidence: Parameters<typeof createHostedRelayOwnerEvidenceReader>[0];
  relay: Parameters<typeof createHostedRelayVerifiedDialer>[0];
  agentTls: { cert: string | Buffer; key: string | Buffer };
  handlePhoneRequest: RequestListener;
  holdsLocalAuthority(): boolean;
}) {
  if (!options.enabled || options.signal.aborted) return undefined;
  const { hostname, agentId, assignment, pinnedGenesis } = options.scope;
  if (normalizeHostedRelayHostname(hostname) !== hostname || !agentId
    || !/^[a-f0-9]{64}$/.test(assignment) || !/^[a-f0-9]{64}$/.test(pinnedGenesis)) {
    throw new Error('relay-startup-invalid-scope');
  }
  const { machineId } = new MachineIdentityManager(options.stateDir).loadIdentity();
  const read = createHostedRelayOwnerEvidenceReader(options.evidence);
  function current() {
    try {
      if (!options.holdsLocalAuthority()) return undefined;
    } catch { return undefined; } // @silent-fallback-ok — unreadable local authority cannot authorize relay traffic
    const evidence = read(hostname);
    if (!evidence || evidence.agentId !== agentId || evidence.record.genesis !== pinnedGenesis
      || evidence.serving.assignment !== assignment || evidence.serving.holder !== machineId) return undefined;
    return evidence;
  }
  const initial = current();
  const expectedSpkiSha256 = initial?.record.tlsKeys[machineId];
  if (!initial || !expectedSpkiSha256) return undefined;
  const connectVerified = createHostedRelayVerifiedDialer(options.relay);
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const listener = await startHostedRelayAgentTlsListener({
    hostname, ...options.agentTls, assignment, expectedSpkiSha256, signal,
    handlePhoneRequest(req, res) {
      if (current()?.record.tlsKeys[machineId] !== expectedSpkiSha256) {
        res.writeHead(503, { 'Cache-Control': 'no-store', Connection: 'close' }).end();
        return;
      }
      options.handlePhoneRequest(req, res);
    },
  });
  void listener.closed.then(() => controller.abort());
  try {
    const runtime = startHostedRelayRuntime({
      enabled: true, stateDir: options.stateDir, hostname, assignment, signal,
      localTlsPort: listener.port, connectVerified, holdsLocalAuthority: options.holdsLocalAuthority,
      readCommittedLease() {
        const evidence = current();
        return evidence?.record.tlsKeys[machineId] === expectedSpkiSha256 ? evidence.committed : undefined;
      },
    });
    if (!runtime) {
      await listener.stop();
      return undefined;
    }
    const closed = runtime.closed.finally(() => listener.stop());
    return {
      available: runtime.available,
      issuePairingCode: runtime.issuePairingCode,
      closed,
      async stop() {
        controller.abort();
        await closed;
      },
    };
  } catch (err) {
    controller.abort();
    await listener.stop();
    throw err;
  }
}
