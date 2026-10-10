/**
 * AgentIdentityRuntime — the one object the HTTP layer reads for everything about this
 * machine's AGENT identity (a2a-single-agent-identity §1–§2): the continuous coherence
 * detector, the key-free audit, the `identity-not-provisioned` posture, the adoption loop's
 * status, and the reload lever. Built by AgentServer (so the surfaces are alive on the
 * production init path even on a single machine) from the deps server.ts hands it.
 */

import type { IdentityCoherenceDetector } from './AgentIdentityCoherence.js';
import type { AgentIdentityAudit } from './AgentIdentityAudit.js';
import type { AdoptionLoopStatus } from './AgentIdentityAdoption.js';

export interface AgentIdentityReloadResult {
  fingerprint: string | null;
  connected: boolean;
  reason: string;
}

export interface AgentIdentityRuntime {
  coherence: IdentityCoherenceDetector;
  audit: AgentIdentityAudit;
  /** Live: true while this machine boots without a usable agent identity on a joined mesh. */
  notProvisioned: () => boolean;
  /**
   * The reload lever (§1.2): re-read THIS machine's own disk, rebuild its relay client,
   * answer the resulting fingerprint. Local effect only; carries no key; installs nothing.
   */
  reload: () => Promise<AgentIdentityReloadResult>;
  /** The adoption loop's status, or null when no loop runs here (provisioned at boot). */
  adoptionStatus: () => AdoptionLoopStatus | null;
  /** Every other active machine with a known URL — backs `?scope=pool` on the audit read. */
  resolvePeerUrls: () => Array<{ machineId: string; url: string }>;
  selfMachineId: string | null;
}

/**
 * The deps server.ts supplies when the multi-machine substrate exists. Every field is a
 * FUNCTION read lazily (the detector's first tick runs 90 s after boot; the mesh pieces are
 * constructed after the AgentServer). Absent ⇒ a single-machine agent: the detector still
 * runs (no siblings → `cannot-tell`), the reload lever re-reads disk, adoption is absent.
 */
export interface AgentIdentityRuntimeDeps {
  selfMachineId: () => string | null;
  selfNickname: () => string;
  listActiveSiblings: () => Array<{ machineId: string; nickname: string }>;
  listRevokedSiblings: () => Array<{ machineId: string; nickname: string }>;
  isMachineActive: (machineId: string) => boolean;
  /** Pool-registry presence (written by PeerPresencePuller): true/false, null unknown. */
  isOnline: (machineId: string) => boolean | null;
  holdsLease: () => boolean;
  connectedAs: () => string | null;
  notProvisioned: () => boolean;
  reload: () => Promise<AgentIdentityReloadResult>;
  adoptionStatus: () => AdoptionLoopStatus | null;
  refreshPresence?: (machineId: string) => Promise<void> | void;
  raiseItem: (item: { id: string; title: string; body: string; priority: 'high' | 'medium'; metadata?: Record<string, unknown> }) => void;
  resolveItem: (id: string) => void;
}
