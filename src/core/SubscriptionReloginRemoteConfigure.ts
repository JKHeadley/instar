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
  | 'owner-must-enable-here'
  | 'identity-not-on-this-machine'
  | 'not-unattended'
  | 'pool-unreadable'
  | 'stale-config';

export type ConfigureEvaluation =
  | { ok: true; alreadyApplied: boolean; config: SubscriptionReloginOperatorInput }
  | { ok: false; status: 400 | 409; error: ConfigureRefusal; detail?: string };

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
 * `remote` = arrived with a delivered mandate from another machine (the owner-consent clauses
 * apply); false = the operator is unlocked on THIS machine's own dashboard.
 * Steps 2–5 of §3 (step 1, the mandate, is checked by the caller first for remote requests).
 */
export function evaluateConfigureRequest(input: {
  current: SubscriptionReloginConfigView;
  rawConfig: unknown;
  expectedRevision: string;
  /** Sorted, normalised emails of this machine's own pool accounts; null = unreadable. */
  verifiedPoolEmails: string[] | null;
  remote: boolean;
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
  // Step 4 — owner consent and identities.
  if (config.mode === 'approval') {
    if (current.mode !== 'unattended') return { ok: false, status: 409, error: 'not-unattended' };
    if (!sameList(current.identities, config.unattendedPolicy.identities)
      || current.minimumSuccessfulRepairs !== config.unattendedPolicy.minimumSuccessfulRepairs
      || current.minimumEvidenceDays !== config.unattendedPolicy.minimumEvidenceDays) {
      return { ok: false, status: 409, error: 'invalid-config', detail: 'switching back to asking first keeps the list and waits unchanged' };
    }
  } else {
    if (input.remote) {
      if (current.mode !== 'unattended') return { ok: false, status: 409, error: 'owner-must-enable-here' };
      if (current.minimumSuccessfulRepairs !== config.unattendedPolicy.minimumSuccessfulRepairs
        || current.minimumEvidenceDays !== config.unattendedPolicy.minimumEvidenceDays) {
        return { ok: false, status: 409, error: 'invalid-config', detail: 'a remote tap never changes the waits' };
      }
    } else if (current.mode === 'unattended') {
      // Already "without asking" here: a tap only refreshes the list and keeps the waits.
      if (current.minimumSuccessfulRepairs !== config.unattendedPolicy.minimumSuccessfulRepairs
        || current.minimumEvidenceDays !== config.unattendedPolicy.minimumEvidenceDays) {
        return { ok: false, status: 409, error: 'invalid-config', detail: 'refreshing the list keeps the waits' };
      }
    } else if (config.unattendedPolicy.minimumSuccessfulRepairs !== 0 || config.unattendedPolicy.minimumEvidenceDays !== 0) {
      return { ok: false, status: 400, error: 'invalid-config', detail: 'turning on here sets no waits' };
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
