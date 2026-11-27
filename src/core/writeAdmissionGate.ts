/**
 * writeAdmissionGate.ts — whether this machine builds its WriteAdmission layer.
 *
 * WriteAdmission is a development-agent dark feature (resolveDevAgentGate), but
 * the shared Conversations graph cannot open on a multi-machine agent without
 * it: the graph's fleet bundle requires a WriteAdmission instance, and a peer
 * whose bundle is incomplete refuses every graph bootstrap call
 * (`graph-bootstrap-native-unavailable`). Before this funnel, an agent with the
 * flag on only one machine (or a fleet agent with it on nowhere) never got a
 * shared efforts list: every other machine turned the bootstrap away.
 *
 * Resolution:
 *   1. An explicit `multiMachine.writeAdmission.enabled` always wins (false is
 *      the operator's off switch, even for Conversations).
 *   2. Otherwise the dev-agent gate decides as before.
 *   3. Otherwise, when the owned-default Conversations graph is on (no external
 *      witness configured, storage not disabled), build it so the graph can
 *      open. Its mode still comes from `dryRun` (default true), so forcing it
 *      on here only observes: the legacy guard keeps enforcing.
 */
import { resolveDevAgentGate, type DevAgentGateConfig } from './devAgentGate.js';

export interface WriteAdmissionGateConfig extends DevAgentGateConfig {
  multiMachine?: {
    writeAdmission?: { enabled?: boolean };
    conversationGraph?: { witness?: unknown; storage?: { enabled?: boolean } };
  };
}

export type WriteAdmissionGateReason = 'explicit' | 'dev-agent' | 'conversations' | 'off';

export function resolveWriteAdmissionGate(config: WriteAdmissionGateConfig | null | undefined): { enabled: boolean; reason: WriteAdmissionGateReason } {
  const explicit = config?.multiMachine?.writeAdmission?.enabled;
  if (typeof explicit === 'boolean') return { enabled: explicit, reason: 'explicit' };
  if (resolveDevAgentGate(undefined, config ?? undefined)) return { enabled: true, reason: 'dev-agent' };
  const graph = config?.multiMachine?.conversationGraph;
  if (!graph?.witness && graph?.storage?.enabled !== false) return { enabled: true, reason: 'conversations' };
  return { enabled: false, reason: 'off' };
}
