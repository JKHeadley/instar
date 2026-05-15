/**
 * ComplianceApi — org-level audit log endpoint.
 *
 * OPTIONAL primitive — provider-specific. Used by organizations with
 * regulatory requirements to capture every agent interaction in an
 * external audit trail.
 *
 * Maps to:
 *   - Codex: OpenAI Compliance API endpoint (usage events flow there)
 *   - Anthropic: Admin API events (different shape; not a 1-to-1 map)
 *
 * Asymmetric on event shapes — the abstraction presents a uniform
 * "subscribe to compliance events" interface; consumers MUST treat the
 * payload shape as provider-specific via `providerSpecific`.
 */

import type { CancellationOptions, ProviderSpecific } from '../../types.js';
import { CapabilityFlag } from '../../capabilities.js';

export interface ComplianceApi {
  readonly capability: typeof CapabilityFlag.ComplianceApi;

  /** Read current compliance endpoint config. */
  config(options?: CancellationOptions): Promise<ComplianceEndpointConfig | null>;

  /** Update compliance endpoint config. */
  setConfig(
    config: ComplianceEndpointConfig | null,
    options?: CancellationOptions,
  ): Promise<void>;

  /** Subscribe to compliance events as they are emitted. */
  subscribe(options?: CancellationOptions): AsyncIterable<ComplianceEvent>;
}

export interface ComplianceEndpointConfig {
  endpoint: string;
  /** Auth for the endpoint. */
  auth?: { kind: 'bearer'; tokenEnvVar: string } | { kind: 'api-key'; keyEnvVar: string };
  /** Whether to wait for endpoint acknowledgment before allowing actions. */
  blocking?: boolean;
}

export interface ComplianceEvent {
  timestamp: string;
  /** Provider-specific event type (e.g., 'usage.recorded', 'session.ended'). */
  eventType: string;
  /** Provider-specific payload. */
  payload: Readonly<Record<string, unknown>>;
  providerSpecific?: ProviderSpecific;
}
