/**
 * StructuredOneShot — single prompt → schema-validated JSON response.
 *
 * Distinct from OneShotCompletion because schema-shape affects which
 * providers can satisfy it. Some providers (OpenAI) have native
 * `response_format: json_schema` enforcement; others (Anthropic via CLI)
 * require prompt-engineering the JSON and validating caller-side.
 *
 * Used for: stall-triage diagnosis (returns TriageDiagnosis JSON), content
 * classification with confidence scores, structured extraction.
 *
 * Maps to:
 *   - Claude: prompt-engineered JSON via `claude -p`, caller validates
 *   - OpenAI Responses API: `response_format: { type: 'json_schema', schema }`
 *   - Codex: `codex exec` + prompt-side JSON request, validate caller-side
 *
 * The interface accepts a generic schema-validation function so callers
 * can use Zod, JSON Schema, ajv, or hand-rolled validators. Adapters MAY
 * use the schema to drive provider-side enforcement when supported, but
 * MUST still call the caller's validator on the result for consistency.
 */

import type { CancellationOptions, ModelTier, ProviderSpecific, UsageReport } from '../../types.js';
import { CapabilityFlag } from '../../capabilities.js';

export interface StructuredOneShot {
  readonly capability: typeof CapabilityFlag.StructuredOneShot;

  /**
   * Send a prompt and get a typed, validated response.
   *
   * The caller provides a `validate` function that returns `{ ok: true, value }`
   * or `{ ok: false, error }`. Implementations call the validator; on
   * `ok: false` the implementation MAY retry up to `options.maxRetries` (default 1)
   * with a follow-up "your response failed validation; here's why" prompt before
   * giving up and throwing.
   *
   * @typeParam T - The validated response shape.
   */
  evaluate<T>(
    prompt: string,
    validate: SchemaValidator<T>,
    options?: StructuredOneShotOptions,
  ): Promise<StructuredOneShotResult<T>>;
}

export type SchemaValidator<T> = (raw: string) => SchemaValidationResult<T>;

export type SchemaValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface StructuredOneShotOptions extends CancellationOptions {
  model?: ModelTier;
  maxTokens?: number;
  temperature?: number;
  system?: string;
  /** Max number of retry attempts on validation failure. Default: 1. */
  maxRetries?: number;
  /**
   * Optional JSON Schema for provider-side enforcement. Adapters that
   * support native structured output (OpenAI) MAY use this. Adapters
   * that don't ignore it. Schema MUST still match what `validate` accepts.
   */
  jsonSchema?: Readonly<Record<string, unknown>>;
}

export interface StructuredOneShotResult<T> {
  value: T;
  /** Raw text the model produced (useful for debugging validation issues). */
  raw: string;
  /** How many validation attempts were needed (1 = first try succeeded). */
  attempts: number;
  usage: UsageReport | null;
  providerSpecific?: ProviderSpecific;
}
