/**
 * OtelExporter — OpenTelemetry export configuration.
 *
 * OPTIONAL primitive — Codex-native. Enables native traces for API
 * requests, prompts, tool approvals. Useful when running Instar in
 * environments with OTel observability stacks.
 *
 * Maps to:
 *   - Codex: `[otel]` config block — `exporter`, `endpoint`, `headers`
 *   - Claude: no native OTel support. Adapter declares unsupported.
 */

import type { CancellationOptions } from '../../types.js';
import { CapabilityFlag } from '../../capabilities.js';

export interface OtelExporter {
  readonly capability: typeof CapabilityFlag.OtelExporter;

  /** Read current OTel config. */
  get(options?: CancellationOptions): Promise<OtelConfig | null>;

  /** Update OTel config. Set null to disable. */
  set(
    config: OtelConfig | null,
    options?: CancellationOptions,
  ): Promise<void>;
}

export interface OtelConfig {
  exporter: 'otlp-http' | 'otlp-grpc' | 'none';
  endpoint?: string;
  headers?: Readonly<Record<string, string>>;
  /** Service name attribute. */
  serviceName?: string;
  /** Service version attribute. */
  serviceVersion?: string;
}
