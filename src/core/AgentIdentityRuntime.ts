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
  /** The adoption loop's status, or null when no loop runs here (a machine that is not part of a joined mesh). */
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
  /** Base ids of items still open in this machine's attention store under a prefix (re-adopted after a restart). */
  openItemIds?: (prefix: string) => string[];
}

/**
 * A registry reader that never throws. `loadRegistry()` throws on a corrupt file, and a
 * corrupt registry is one of the postures this feature serves (§1.1 `unreadable`: refuse to
 * mint, stay loud, KEEP SERVING) — so the readers behind the adoption loop and the detector
 * must not turn it into a crash. An unreadable registry reads as "no machines known"; the
 * failure is reported once per distinct message, and again after it has recovered and broken
 * anew.
 */
export function tolerantRegistryMachines<E>(
  load: () => Record<string, E> | undefined,
  onUnreadable: (message: string) => void,
): () => Record<string, E> {
  let lastError: string | null = null;
  return () => {
    try {
      const machines = load() ?? {};
      lastError = null;
      return machines;
    } catch (err) {
      // @silent-fallback-ok — an unreadable registry is the typed `unreadable` posture (mint refused, item raised by the mint guard); here it reads as no known machines rather than crashing the round, and is reported through onUnreadable.
      const message = err instanceof Error ? err.message : String(err);
      if (message !== lastError) {
        lastError = message;
        onUnreadable(message);
      }
      return {};
    }
  };
}
