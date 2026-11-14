/**
 * The documents dark gate (DEV_GATED_FEATURES: documents), in one place so the routes and the
 * old-link guarantee (§3.9b) can never disagree about whether documents are on.
 */
import { resolveDevAgentGate } from '../core/devAgentGate.js';

export function isDocumentsEnabled(config: unknown): boolean {
  const enabled = (config as { documents?: { enabled?: boolean } } | null)?.documents?.enabled;
  return resolveDevAgentGate(enabled, config as Parameters<typeof resolveDevAgentGate>[1]);
}
