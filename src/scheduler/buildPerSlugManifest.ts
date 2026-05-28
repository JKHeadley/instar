/**
 * buildPerSlugManifest — the SINGLE typed constructor for a per-slug job manifest
 * (docs/specs/BUILTIN-JOB-MANIFEST-FIELDS-FIX.md).
 *
 * Why this exists: there were two hand-rolled manifest producers (InstallBuiltinJobs
 * and jobMigrate) that each built the manifest object literal inline, with no
 * compile-time link to the `PerSlugManifest` contract the loader REQUIRES. One drifted
 * — both dropped `priority` / `expectedDurationMinutes` / `model` — and every built-in
 * agentmd job failed to load fleet-wide (jobCount=0) silently for a week.
 *
 * This function is typed to RETURN `PerSlugManifest`, so if a required field is ever
 * dropped again it's a `tsc` error, not a runtime fleet outage. Both producers call it.
 * Callers must supply the required fields as typed arguments (TypeScript enforces it at
 * each call site) — that's the structural guarantee (Structure > Willpower).
 */
import type { PerSlugManifest } from './AgentMdJobLoader.js';
import type { JobPriority, ModelTier } from '../core/types.js';

export interface BuildPerSlugManifestInput {
  slug: string;
  origin: 'instar' | 'user';
  schedule: string;
  /** REQUIRED — the field whose omission caused the fleet-wide load failure. */
  priority: JobPriority;
  /** REQUIRED — must be a positive finite number (caller coerces + guards before calling). */
  expectedDurationMinutes: number;
  enabled: boolean;
  execute: PerSlugManifest['execute'];
  model?: ModelTier;
  // Optional pass-throughs the loader reads from the MANIFEST (manifestToJobDefinition),
  // not the body frontmatter — so they must be carried here or they're silently dropped.
  tags?: string[];
  unrestrictedTools?: boolean;
  gate?: string;
  telegramNotify?: boolean | 'on-alert';
  topicId?: number;
  machines?: string[];
  /** Preserved across regeneration (operator may have disabled the default). */
  disabledAtBodyHash?: string;
}

export function buildPerSlugManifest(input: BuildPerSlugManifestInput): PerSlugManifest {
  const m: PerSlugManifest = {
    slug: input.slug,
    origin: input.origin,
    schedule: input.schedule,
    priority: input.priority,
    expectedDurationMinutes: input.expectedDurationMinutes,
    enabled: input.enabled,
    execute: input.execute,
    manifestVersion: 1,
  };
  if (input.model !== undefined) m.model = input.model;
  if (input.tags !== undefined) m.tags = input.tags;
  if (input.unrestrictedTools !== undefined) m.unrestrictedTools = input.unrestrictedTools;
  if (input.gate !== undefined) m.gate = input.gate;
  if (input.telegramNotify !== undefined) m.telegramNotify = input.telegramNotify;
  if (input.topicId !== undefined) m.topicId = input.topicId;
  if (input.machines !== undefined) m.machines = input.machines;
  if (input.disabledAtBodyHash !== undefined) m.disabledAtBodyHash = input.disabledAtBodyHash;
  return m;
}

/**
 * Coerce a frontmatter/entry value (which may be a string under YAML FAILSAFE_SCHEMA,
 * or already a number) to a positive finite minutes count. Returns null when the value
 * is absent, non-numeric, or non-positive — the caller then fails loud (records an
 * error + skips), never writing a `NaN`/`null` into the manifest.
 */
export function coerceDurationMinutes(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Coerce a frontmatter unrestrictedTools value (boolean, or "true"/"false" string). */
export function coerceBool(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}
