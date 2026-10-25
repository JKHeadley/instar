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
  const identities = [...new Set((policy.identities as string[]).map((identity) => identity.trim().toLowerCase()))];
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

export function applySubscriptionReloginOperatorConfig(input: {
  stateDir: string;
  runtimeConfig: InstarConfig;
  requested: SubscriptionReloginOperatorInput;
  now?: Date;
  pid?: number;
}): { config: NonNullable<NonNullable<InstarConfig['subscriptionPool']>['assistedRelogin']>; changed: boolean; restartRequested: boolean } {
  const configPath = path.join(input.stateDir, 'config.json');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as InstarConfig;
  const existing = raw.subscriptionPool?.assistedRelogin ?? {};
  const next = {
    ...existing,
    ...input.requested,
    unattendedPolicy: { ...input.requested.unattendedPolicy },
  };
  const existingPolicy = existing.unattendedPolicy;
  const unchanged = existing.enabled === next.enabled
    && existing.mode === next.mode
    && existing.dryRun === next.dryRun
    && existingPolicy?.minimumSuccessfulRepairs === next.unattendedPolicy.minimumSuccessfulRepairs
    && existingPolicy?.minimumEvidenceDays === next.unattendedPolicy.minimumEvidenceDays
    && (existingPolicy?.identities ?? []).length === next.unattendedPolicy.identities.length
    && (existingPolicy?.identities ?? []).every((identity, index) => identity === next.unattendedPolicy.identities[index]);
  if (unchanged) return { config: next, changed: false, restartRequested: false };
  raw.subscriptionPool = { ...(raw.subscriptionPool ?? {}), assistedRelogin: next };
  SafeFsExecutor.atomicWriteJsonSync(configPath, raw, {
    operation: 'subscription-relogin operator config',
    mode: 0o600,
  });

  const at = (input.now ?? new Date()).toISOString();
  const auditPath = path.join(input.stateDir, 'logs', 'subscription-relogin-config.jsonl');
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(auditPath, `${JSON.stringify({
    at,
    action: 'operator-configured',
    enabled: next.enabled,
    mode: next.mode,
    dryRun: next.dryRun,
    identities: next.unattendedPolicy?.identities ?? [],
    minimumSuccessfulRepairs: next.unattendedPolicy?.minimumSuccessfulRepairs,
    minimumEvidenceDays: next.unattendedPolicy?.minimumEvidenceDays,
  })}\n`, { mode: 0o600 });

  SafeFsExecutor.atomicWriteJsonSync(path.join(input.stateDir, 'state', 'restart-requested.json'), {
    requestedAt: at,
    requestedBy: 'subscription-relogin-operator-config',
    targetVersion: input.runtimeConfig.version ?? 'current',
    previousVersion: input.runtimeConfig.version ?? 'current',
    plannedRestart: true,
    expiresAt: new Date((input.now ?? new Date()).getTime() + 60 * 60_000).toISOString(),
    pid: input.pid ?? process.pid,
  }, { operation: 'subscription-relogin config restart request', mode: 0o600 });

  return { config: next, changed: true, restartRequested: true };
}
