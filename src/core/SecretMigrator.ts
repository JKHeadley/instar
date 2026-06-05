/**
 * Config Secret Migrator — extracts secrets from config.json into SecretStore.
 *
 * When transitioning to multi-machine, secrets must leave the git-tracked
 * config.json and move into the encrypted SecretStore. The migrator:
 *
 * 1. Scans config.json for fields annotated with { "secret": true }
 * 2. Extracts their actual values into the SecretStore
 * 3. Replaces those fields with { "secret": true } placeholders
 * 4. On loadConfig, merges config.json + SecretStore transparently
 *
 * This runs during `instar pair` (initial multi-machine setup) and can be
 * re-run safely (idempotent — already-migrated fields are skipped).
 *
 * Part of Phase 4 (secret sync via tunnel).
 */

import fs from 'node:fs';
import path from 'node:path';
import { SecretStore } from './SecretStore.js';
import type { Secrets } from './SecretStore.js';

// ── Types ────────────────────────────────────────────────────────────

export interface MigrationResult {
  /** Number of secret fields extracted. */
  extracted: number;
  /** Paths of extracted fields (e.g., ['messaging.0.config.token']). */
  fields: string[];
  /** Whether config.json was modified. */
  configModified: boolean;
}

// ── Secret Field Detection ───────────────────────────────────────────

/**
 * Known secret fields in the Instar config schema.
 * These are the fields that should be migrated to the encrypted store.
 *
 * Format: dot-notation paths with array wildcards (*).
 */
const KNOWN_SECRET_FIELDS = [
  'authToken',
  'dashboardPin',
  'messaging.*.config.token',
  'messaging.*.config.chatId',
  'tunnel.token',
];

// ── Migrator ─────────────────────────────────────────────────────────

/**
 * Extract secrets from config.json into the encrypted SecretStore.
 *
 * Idempotent: fields already replaced with { "secret": true } are skipped.
 * Fields that are undefined or null are skipped.
 */
export function migrateSecrets(configPath: string, stateDir: string): MigrationResult {
  if (!fs.existsSync(configPath)) {
    return { extracted: 0, fields: [], configModified: false };
  }

  const configRaw = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(configRaw);
  // Write/read SYMMETRY (spec keychain-per-agent-master-key §2): the migrator
  // previously wrote with forceFileKey:true while the merge path read
  // keychain-first — the asymmetry that armed the 2026-06-05 poisoning
  // incident. Both paths now resolve through the same store-scoped,
  // ciphertext-verified key resolution inside SecretStore.
  const store = new SecretStore({ stateDir });
  const existingSecrets = store.read();

  const extracted: string[] = [];

  for (const pattern of KNOWN_SECRET_FIELDS) {
    const matches = resolvePattern(config, pattern);
    for (const { path: fieldPath, value } of matches) {
      // Skip if already migrated (placeholder)
      if (isSecretPlaceholder(value)) continue;
      // Skip null/undefined
      if (value === null || value === undefined) continue;
      // Skip empty strings
      if (typeof value === 'string' && value.trim() === '') continue;

      // Extract the value to the secret store
      setNestedValue(existingSecrets, fieldPath, value);

      // Replace in config with placeholder
      setNestedValue(config, fieldPath, { secret: true });
      extracted.push(fieldPath);
    }
  }

  if (extracted.length === 0) {
    return { extracted: 0, fields: [], configModified: false };
  }

  // Write the updated secrets
  store.write(existingSecrets);

  // Write the sanitized config
  const sanitized = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(configPath, sanitized);

  return {
    extracted: extracted.length,
    fields: extracted,
    configModified: true,
  };
}

/**
 * Merge config.json + SecretStore, replacing { "secret": true } placeholders
 * with actual values from the encrypted store.
 *
 * This is called by loadConfig() to transparently merge the two sources.
 */
export function mergeConfigWithSecrets(config: Record<string, unknown>, stateDir: string): Record<string, unknown> {
  const store = new SecretStore({ stateDir, forceFileKey: false });
  if (!store.exists) return config;

  const secrets = store.read();
  return deepMergeSecrets(config, secrets);
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Check if a value is the { "secret": true } placeholder left in config.json
 *  after a field is externalized to the encrypted secret store. Exported so
 *  readiness/coherence checks can tell "field is externalized (present)" apart
 *  from "field is genuinely missing" — a plain string-type guard reads the
 *  placeholder as missing and false-alarms. */
export function isSecretPlaceholder(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'secret' in value && (value as any).secret === true;
}

/**
 * Resolve a dot-notation pattern with array wildcards into actual paths and values.
 *
 * 'messaging.*.config.token' resolves to:
 *   [{ path: 'messaging.0.config.token', value: 'bot123:ABC' }]
 */
function resolvePattern(obj: unknown, pattern: string): Array<{ path: string; value: unknown }> {
  const parts = pattern.split('.');
  return resolvePatternParts(obj, parts, '');
}

function resolvePatternParts(
  current: unknown,
  remainingParts: string[],
  prefix: string,
): Array<{ path: string; value: unknown }> {
  if (remainingParts.length === 0) {
    return [{ path: prefix, value: current }];
  }

  const [head, ...tail] = remainingParts;

  if (head === '*') {
    // Wildcard — iterate array or object
    if (Array.isArray(current)) {
      const results: Array<{ path: string; value: unknown }> = [];
      for (let i = 0; i < current.length; i++) {
        const subPath = prefix ? `${prefix}.${i}` : `${i}`;
        results.push(...resolvePatternParts(current[i], tail, subPath));
      }
      return results;
    }
    return [];
  }

  if (current === null || current === undefined || typeof current !== 'object') {
    return [];
  }

  const next = (current as Record<string, unknown>)[head];
  if (next === undefined) return [];

  const subPath = prefix ? `${prefix}.${head}` : head;
  return resolvePatternParts(next, tail, subPath);
}

/** Set nested value in object using dot notation with array index support. */
function setNestedValue(obj: Record<string, unknown>, keyPath: string, value: unknown): void {
  const parts = keyPath.split('.');
  let current: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const nextPart = parts[i + 1];
    if (!(part in current) || current[part] === null || typeof current[part] !== 'object') {
      // Create array or object based on next part
      current[part] = isNumeric(nextPart) ? [] : {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

/** Deep merge secrets into config, replacing { "secret": true } placeholders. */
function deepMergeSecrets(
  config: Record<string, unknown>,
  secrets: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...config };

  for (const [key, secretValue] of Object.entries(secrets)) {
    const configValue = result[key];

    if (isSecretPlaceholder(configValue)) {
      // Replace placeholder with secret value
      result[key] = secretValue;
    } else if (
      typeof configValue === 'object' && configValue !== null &&
      typeof secretValue === 'object' && secretValue !== null
    ) {
      if (Array.isArray(configValue) && Array.isArray(secretValue)) {
        // Merge arrays element-by-element
        result[key] = configValue.map((item, i) => {
          if (typeof item === 'object' && item !== null && typeof secretValue[i] === 'object' && secretValue[i] !== null) {
            return deepMergeSecrets(item as Record<string, unknown>, secretValue[i] as Record<string, unknown>);
          }
          return isSecretPlaceholder(item) ? secretValue[i] : item;
        });
      } else {
        // Recurse into objects
        result[key] = deepMergeSecrets(
          configValue as Record<string, unknown>,
          secretValue as Record<string, unknown>,
        );
      }
    }
  }

  return result;
}

function isNumeric(s: string): boolean {
  return /^\d+$/.test(s);
}
