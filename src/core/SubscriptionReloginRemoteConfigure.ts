/**
 * The point-of-use rules for a one-tap repair-setting change (spec one-tap-unattended-repair §3).
 * Pure: every input is passed in, so the rules are unit-tested on both sides of every boundary.
 * The routes do the I/O (mandate verification, the on-disk read, the apply) around this.
 */
import {
  validateSubscriptionReloginOperatorInput,
  type SubscriptionReloginConfigView,
  type SubscriptionReloginOperatorInput,
} from './SubscriptionReloginOperatorConfig.js';

export type ConfigureRefusal =
  | 'invalid-config'
  | 'operator-unlock-missing'
  | 'identity-not-on-this-machine'
  | 'not-unattended'
  | 'pool-unreadable'
  | 'stale-config';

export type ConfigureEvaluation =
  | { ok: true; alreadyApplied: boolean; config: SubscriptionReloginOperatorInput }
  | { ok: false; status: 400 | 403 | 409; error: ConfigureRefusal; detail?: string };

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Does the on-disk state already equal the requested config (closed fields only)? */
export function configAlreadyApplied(current: SubscriptionReloginConfigView, config: SubscriptionReloginOperatorInput): boolean {
  return current.enabled === config.enabled
    && current.dryRun === config.dryRun
    && current.mode === config.mode
    && current.minimumSuccessfulRepairs === config.unattendedPolicy.minimumSuccessfulRepairs
    && current.minimumEvidenceDays === config.unattendedPolicy.minimumEvidenceDays
    && sameList(current.identities, config.unattendedPolicy.identities);
}

/**
 * Evaluate one configure request against this machine's current on-disk state.
 * `remote` = arrived with a delivered mandate from another machine; false = the operator is
 * unlocked on THIS machine's own dashboard.
 * `operatorUnlockCarried` = (remote only) the verified mandate states, in its signed bytes, that it
 * was issued under a recent dashboard PIN unlock on the issuing machine. That carried unlock is the
 * authority for raising a machine to "without asking" from any machine's dashboard (operator rule
 * 2026-11-10, spec one-tap-unattended-repair "Amendment: any dashboard").
 * Steps 2–5 of §3 (step 1, the mandate, is checked by the caller first for remote requests).
 */
export function evaluateConfigureRequest(input: {
  current: SubscriptionReloginConfigView;
  rawConfig: unknown;
  expectedRevision: string;
  /** Sorted, normalised emails of this machine's own pool accounts; null = unreadable. */
  verifiedPoolEmails: string[] | null;
  remote: boolean;
  operatorUnlockCarried?: boolean;
}): ConfigureEvaluation {
  // Step 2 — closed set.
  const parsed = validateSubscriptionReloginOperatorInput(input.rawConfig);
  if (!parsed.ok) return { ok: false, status: 400, error: 'invalid-config', detail: parsed.error };
  const config = parsed.value;
  if (config.enabled !== true || config.dryRun !== false || (config.mode !== 'unattended' && config.mode !== 'approval')) {
    return { ok: false, status: 400, error: 'invalid-config', detail: 'only live unattended or live approval can be set here' };
  }

  // Step 3 — already applied: idempotent success whatever the expected revision says.
  if (configAlreadyApplied(input.current, config)) return { ok: true, alreadyApplied: true, config };

  const { current } = input;
  // Step 4 — authority, waits and identities.
  if (config.mode === 'approval') {
    if (current.mode !== 'unattended') return { ok: false, status: 409, error: 'not-unattended' };
    if (!sameList(current.identities, config.unattendedPolicy.identities)
      || current.minimumSuccessfulRepairs !== config.unattendedPolicy.minimumSuccessfulRepairs
      || current.minimumEvidenceDays !== config.unattendedPolicy.minimumEvidenceDays) {
      return { ok: false, status: 409, error: 'invalid-config', detail: 'switching back to asking first keeps the list and waits unchanged' };
    }
  } else {
    if (current.mode === 'unattended') {
      // Already "without asking": a tap (here or from another machine) only refreshes the list
      // and keeps the waits.
      if (current.minimumSuccessfulRepairs !== config.unattendedPolicy.minimumSuccessfulRepairs
        || current.minimumEvidenceDays !== config.unattendedPolicy.minimumEvidenceDays) {
        return { ok: false, status: 409, error: 'invalid-config', detail: 'refreshing the list keeps the waits' };
      }
    } else {
      // Raising off / watch-only / asks-first to "without asking". From another machine this needs
      // the operator's PIN unlock carried in the signed mandate; a mandate without it (an older
      // issuing machine, or anything not issued by the unlocked dashboard route) cannot raise.
      if (input.remote && input.operatorUnlockCarried !== true) {
        return { ok: false, status: 403, error: 'operator-unlock-missing' };
      }
      if (config.unattendedPolicy.minimumSuccessfulRepairs !== 0 || config.unattendedPolicy.minimumEvidenceDays !== 0) {
        return { ok: false, status: 400, error: 'invalid-config', detail: 'turning on sets no waits' };
      }
    }
    if (input.verifiedPoolEmails === null) return { ok: false, status: 409, error: 'pool-unreadable' };
    const allowed = new Set(input.verifiedPoolEmails);
    const foreign = config.unattendedPolicy.identities.filter((identity) => !allowed.has(identity));
    if (foreign.length > 0) return { ok: false, status: 409, error: 'identity-not-on-this-machine' };
  }

  // Step 5 — compare-and-set.
  if (current.revision !== input.expectedRevision) return { ok: false, status: 409, error: 'stale-config' };
  return { ok: true, alreadyApplied: false, config };
}
