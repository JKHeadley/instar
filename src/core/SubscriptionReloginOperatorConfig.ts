import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import type { InstarConfig } from './types.js';

export interface SubscriptionReloginOperatorInput {
  enabled: boolean;
  mode: 'approval' | 'unattended';
  dryRun: boolean;
  unattendedPolicy: {
    identities: string[];
    minimumSuccessfulRepairs: number;
    minimumEvidenceDays: number;
  };
}

type AssistedReloginBlock = NonNullable<NonNullable<InstarConfig['subscriptionPool']>['assistedRelogin']>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateSubscriptionReloginOperatorInput(value: unknown):
  | { ok: true; value: SubscriptionReloginOperatorInput }
  | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'request body must be an object' };
  }
  const body = value as Record<string, unknown>;
  if (typeof body.enabled !== 'boolean' || typeof body.dryRun !== 'boolean') {
    return { ok: false, error: 'enabled and dryRun must be booleans' };
  }
  if (body.mode !== 'approval' && body.mode !== 'unattended') {
    return { ok: false, error: 'mode must be approval or unattended' };
  }
  const rawPolicy = body.unattendedPolicy;
  if (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) {
    return { ok: false, error: 'unattendedPolicy is required' };
  }
  const policy = rawPolicy as Record<string, unknown>;
  if (!Array.isArray(policy.identities) || policy.identities.some((identity) => typeof identity !== 'string')) {
    return { ok: false, error: 'unattendedPolicy.identities must be an array of email strings' };
  }
  // Canonical order (sorted) so the same set always produces the same digest and revision, and a
  // reorder alone is never a change (spec one-tap-unattended-repair §2).
  const identities = [...new Set((policy.identities as string[]).map((identity) => identity.trim().toLowerCase()))].sort();
  if (identities.some((identity) => !EMAIL.test(identity))) {
    return { ok: false, error: 'every unattended identity must be an exact email address' };
  }
  if (body.mode === 'unattended' && body.enabled && !body.dryRun && identities.length === 0) {
    return { ok: false, error: 'live unattended mode requires at least one exact identity' };
  }
  const minimumSuccessfulRepairs = policy.minimumSuccessfulRepairs;
  const minimumEvidenceDays = policy.minimumEvidenceDays;
  if (!Number.isSafeInteger(minimumSuccessfulRepairs) || (minimumSuccessfulRepairs as number) < 0 || (minimumSuccessfulRepairs as number) > 10_000) {
    return { ok: false, error: 'minimumSuccessfulRepairs must be an integer from 0 to 10000' };
  }
  if (!Number.isSafeInteger(minimumEvidenceDays) || (minimumEvidenceDays as number) < 0 || (minimumEvidenceDays as number) > 3650) {
    return { ok: false, error: 'minimumEvidenceDays must be an integer from 0 to 3650' };
  }
  return {
    ok: true,
    value: {
      enabled: body.enabled,
      mode: body.mode,
      dryRun: body.dryRun,
      unattendedPolicy: {
        identities,
        minimumSuccessfulRepairs: minimumSuccessfulRepairs as number,
        minimumEvidenceDays: minimumEvidenceDays as number,
      },
    },
  };
}

// ── Closed metadata, revision and digest (spec one-tap-unattended-repair §1–§3) ─────────────

/** The closed, operator-facing view of one machine's repair setting. Nothing else from config. */
export interface SubscriptionReloginConfigView {
  enabled: boolean;
  /** `observe` when dryRun, `off` when disabled or absent. */
  mode: 'off' | 'observe' | 'approval' | 'unattended';
  dryRun: boolean;
  identities: string[];
  /** Effective evidence floor (missing ⇒ the policy default 10). */
  minimumSuccessfulRepairs: number;
  /** Effective evidence age in days (missing ⇒ the policy default 30). */
  minimumEvidenceDays: number;
  generation: number;
  /** sha256 over the closed fields plus generation: the compare-and-set token. */
  revision: string;
}

function sha256(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

/** Deterministic JSON with sorted object keys (arrays keep their order). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function safeGeneration(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

/** Build the closed view (with revision) from a raw `assistedRelogin` block (or undefined). */
export function describeSubscriptionReloginConfig(block: AssistedReloginBlock | undefined | null): SubscriptionReloginConfigView {
  const b = block ?? {};
  // EXACTLY the runtime's derivation (src/commands/server.ts, createSubscriptionReloginRuntime):
  // the runtime starts only when `enabled === true`, runs watch-only unless `dryRun === false`,
  // and defaults a missing mode to approval. Any looser reading would let a block that is
  // watch-only at runtime look live, and pass the owner-consent check.
  const enabled = b.enabled === true;
  const dryRun = b.dryRun !== false;
  const rawMode = b.mode ?? 'approval';
  const mode: SubscriptionReloginConfigView['mode'] = !enabled ? 'off' : dryRun ? 'observe' : rawMode;
  const policy = b.unattendedPolicy ?? {};
  const identities = [...new Set((Array.isArray(policy.identities) ? policy.identities : [])
    .filter((identity): identity is string => typeof identity === 'string')
    .map((identity) => identity.trim().toLowerCase()))].sort();
  // Effective values, as unattendedGraduated() applies them (missing ⇒ 10 repairs / 30 days).
  const minimumSuccessfulRepairs = Math.max(0, Math.floor(Number.isFinite(policy.minimumSuccessfulRepairs) ? policy.minimumSuccessfulRepairs as number : 10));
  const minimumEvidenceDays = Math.max(0, Math.floor(Number.isFinite(policy.minimumEvidenceDays) ? policy.minimumEvidenceDays as number : 30));
  const generation = safeGeneration(b.generation);
  const closed = { enabled, mode: rawMode, dryRun, identities, minimumSuccessfulRepairs, minimumEvidenceDays, generation };
  return { enabled, mode, dryRun, identities, minimumSuccessfulRepairs, minimumEvidenceDays, generation, revision: sha256(canonicalJson(closed)) };
}

/** Read the ON-DISK `assistedRelogin` block (never the running ctx.config). Throws on unreadable config. */
export function readOnDiskSubscriptionReloginBlock(stateDir: string): AssistedReloginBlock | undefined {
  const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8')) as InstarConfig;
  return raw.subscriptionPool?.assistedRelogin;
}

/**
 * The digest a configure mandate binds: the exact validated config plus the revision the operator
 * saw. Both sides compute it from the same canonical form (sorted identities, sorted keys).
 */
export function subscriptionReloginConfigureDigest(config: SubscriptionReloginOperatorInput, expectedRevision: string): string {
  return sha256(canonicalJson({ config, expectedRevision }));
}

// ── Apply ───────────────────────────────────────────────────────────────────────────────────

export interface SubscriptionReloginConfigProvenance {
  via: 'local-session' | 'configure-pool-self' | 'mandate';
  mandateId?: string;
  deliveredBy?: string;
}

export const SUBSCRIPTION_RELOGIN_RESTART_REQUESTED_BY = 'subscription-relogin-operator-config';

/**
 * Write an UNVERSIONED restart request (no targetVersion), the shape the supervisor treats as an
 * ordinary planned restart: it is never counted against the per-version update-restart cap and
 * does not restart the lifeline. A pending UPDATE restart (one carrying a targetVersion) is left
 * alone: that restart applies the new setting too. Returns true when a restart is (or already
 * was) queued.
 */
export function writeSubscriptionReloginRestartRequest(stateDir: string, now: Date, pid: number): boolean {
  const dir = path.join(stateDir, 'state');
  fs.mkdirSync(dir, { recursive: true });
  const flagPath = path.join(dir, 'restart-requested.json');
  try {
    const existing = JSON.parse(fs.readFileSync(flagPath, 'utf8')) as { targetVersion?: unknown; expiresAt?: string };
    const live = !existing.expiresAt || Date.parse(existing.expiresAt) > now.getTime();
    if (live && typeof existing.targetVersion === 'string' && existing.targetVersion) return true;
  } catch { /* @silent-fallback-ok — no pending request (or unreadable): write ours below */ }
  const countFile = path.join(dir, 'restart-version-count.json');
  try {
    const count = JSON.parse(fs.readFileSync(countFile, 'utf8')) as { targetVersion?: string };
    if (!count.targetVersion) SafeFsExecutor.safeUnlinkSync(countFile, { operation: 'src/core/SubscriptionReloginOperatorConfig.ts:unversioned-restart-count' });
  } catch { /* @silent-fallback-ok — no count file, nothing to clear */ }
  SafeFsExecutor.atomicWriteJsonSync(flagPath, {
    requestedAt: now.toISOString(),
    requestedBy: SUBSCRIPTION_RELOGIN_RESTART_REQUESTED_BY,
    reason: 'sign-in repair setting changed at the operator\'s request',
    plannedRestart: true,
    expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    pid,
  }, { operation: 'subscription-relogin config restart request', mode: 0o600 });
  return true;
}

export function applySubscriptionReloginOperatorConfig(input: {
  stateDir: string;
  runtimeConfig: InstarConfig;
  requested: SubscriptionReloginOperatorInput;
  provenance?: SubscriptionReloginConfigProvenance;
  /** The revision of the block the running server loaded at boot; when the on-disk revision
   *  differs, an identical (unchanged) write still re-queues the restart (activation pending). */
  bootRevision?: string;
  now?: Date;
  pid?: number;
}): { config: AssistedReloginBlock; changed: boolean; restartRequested: boolean; generation: number } {
  const configPath = path.join(input.stateDir, 'config.json');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as InstarConfig;
  const existing = raw.subscriptionPool?.assistedRelogin ?? {};
  const existingPolicy = existing.unattendedPolicy;
  const existingIdentities = [...(existingPolicy?.identities ?? [])].map((identity) => String(identity).trim().toLowerCase()).sort();
  const currentGeneration = safeGeneration(existing.generation);
  const unchanged = existing.enabled === input.requested.enabled
    && existing.mode === input.requested.mode
    && existing.dryRun === input.requested.dryRun
    && existingPolicy?.minimumSuccessfulRepairs === input.requested.unattendedPolicy.minimumSuccessfulRepairs
    && existingPolicy?.minimumEvidenceDays === input.requested.unattendedPolicy.minimumEvidenceDays
    && existingIdentities.length === input.requested.unattendedPolicy.identities.length
    && existingIdentities.every((identity, index) => identity === input.requested.unattendedPolicy.identities[index]);
  const now = input.now ?? new Date();
  const pid = input.pid ?? process.pid;
  if (unchanged) {
    const activationPending = input.bootRevision !== undefined && input.bootRevision !== describeSubscriptionReloginConfig(existing).revision;
    const restartRequested = activationPending ? writeSubscriptionReloginRestartRequest(input.stateDir, now, pid) : false;
    return { config: existing, changed: false, restartRequested, generation: currentGeneration };
  }
  const generation = currentGeneration + 1;
  const next: AssistedReloginBlock = {
    ...existing,
    ...input.requested,
    unattendedPolicy: { ...input.requested.unattendedPolicy },
    generation,
  };
  raw.subscriptionPool = { ...(raw.subscriptionPool ?? {}), assistedRelogin: next };
  SafeFsExecutor.atomicWriteJsonSync(configPath, raw, {
    operation: 'subscription-relogin operator config',
    mode: 0o600,
  });

  const auditPath = path.join(input.stateDir, 'logs', 'subscription-relogin-config.jsonl');
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  const provenance = input.provenance ?? { via: 'local-session' };
  fs.appendFileSync(auditPath, `${JSON.stringify({
    at: now.toISOString(),
    action: 'operator-configured',
    via: provenance.via,
    ...(provenance.mandateId ? { mandateId: provenance.mandateId } : {}),
    ...(provenance.deliveredBy ? { deliveredBy: provenance.deliveredBy } : {}),
    generation,
    enabled: next.enabled,
    mode: next.mode,
    dryRun: next.dryRun,
    identities: next.unattendedPolicy?.identities ?? [],
    minimumSuccessfulRepairs: next.unattendedPolicy?.minimumSuccessfulRepairs,
    minimumEvidenceDays: next.unattendedPolicy?.minimumEvidenceDays,
  })}\n`, { mode: 0o600 });

  const restartRequested = writeSubscriptionReloginRestartRequest(input.stateDir, now, pid);
  return { config: next, changed: true, restartRequested, generation };
}

/** The digest a restart-only ("Finish restarting") mandate binds (spec §6). */
export function subscriptionReloginFinishRestartDigest(expectedRevision: string): string {
  return sha256(canonicalJson({ action: 'finish-restart', expectedRevision }));
}
