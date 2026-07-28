/**
 * Model tier resolution for the anthropic-headless adapter.
 *
 * Maps the abstract ModelTier (fast/balanced/capable) to Claude CLI
 * model flags (haiku/sonnet/opus). Mirrors the existing CLI_MODEL_FLAGS
 * mapping in src/core/models.ts — kept in sync.
 */

import type { ModelTier } from '../../types.js';

const CLI_FLAG_MAP = {
  fast: 'haiku',
  balanced: 'sonnet',
  capable: 'opus',
} as const;

const API_MODEL_MAP = {
  fast: 'claude-haiku-4-5',
  balanced: 'claude-sonnet-4-6',
  capable: 'claude-opus-4-8',
} as const;

/** Resolve a tier to a Claude CLI model flag. */
export function resolveCliModelFlag(tier: ModelTier): string {
  return CLI_FLAG_MAP[tier];
}

/** Resolve a tier to a concrete Anthropic API model ID. */
export function resolveApiModelId(tier: ModelTier): string {
  return API_MODEL_MAP[tier];
}
