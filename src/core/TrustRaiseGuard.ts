/**
 * TrustRaiseGuard: what counts as widening the agent's authority, and the proof a widening needs.
 *
 * Spec: docs/specs/trust-journey.md, decision 4 and section 6 (stage 0).
 *
 * A raise is any change that makes effective authority less restrictive. A raise needs an
 * `OperatorProof`; a narrowing never does. `OperatorProof` values are issued only by the
 * account-path approval check (decision 5), which records a consumed receipt against the exact
 * proposal hash. Until that check is installed, nothing issues a proof, so every raise is refused
 * and every narrowing still applies. The classifiers here are pure and deterministic: they compare
 * structured settings, never words.
 */
import crypto from 'node:crypto';
import { PROFILE_DEFAULTS } from './AutonomyProfileManager.js';
import type { AutonomyProfileLevel } from './types.js';
import type { TrustLevel } from './ExternalOperationGate.js';

// ── The proof ─────────────────────────────────────────────────────────

/** Evidence that a person approved one exact change through the account path. */
export interface OperatorProof {
  readonly kind: 'accepted-account';
  /** The proposal hash of the exact change approved. */
  readonly proposalHash: string;
  /** The consumed receipt record id. */
  readonly receiptRef: string;
  /** The acceptance record in force when the receipt was consumed. */
  readonly acceptanceRef: string;
  /** Who approved (the person's key). */
  readonly principal: string;
}

/**
 * Proofs issued in this process. A plain object with the right fields is not a proof: only a value
 * registered here by the approval check counts. Request bodies, config and files can never reach it.
 */
const issuedProofs = new WeakSet<object>();

// Stage 0 PR A installs no issuer: nothing can register a proof, so every raise is refused.
// The account-path approval check (trust-journey PR B, CMT-1837) adds the only issuer, in the
// module that consumes receipts.

/**
 * Test-only issuer, so unit tests can exercise the proven-raise branch before the account-path
 * approval check exists. Refuses outside the vitest runner. Production code never imports it; the
 * approval check (PR B) adds the only production issuer.
 * @internal
 */
export function issueOperatorProofForTesting(change: unknown, principal = 'test-person'): OperatorProof {
  if (process.env.VITEST !== 'true') {
    throw new Error('issueOperatorProofForTesting is only available inside the test runner');
  }
  const proof: OperatorProof = Object.freeze({
    kind: 'accepted-account' as const,
    proposalHash: proposalHashOf(change),
    receiptRef: 'test-receipt',
    acceptanceRef: 'test-acceptance',
    principal,
  });
  issuedProofs.add(proof);
  return proof;
}

/** Canonical JSON (sorted keys) of an exact change, hashed: the value a proof must name. */
export function proposalHashOf(change: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canon(change))).digest('hex');
}

/** True only for a proof the approval check issued, for exactly this proposal. */
export function proofCovers(proof: OperatorProof | null | undefined, proposalHash: string): boolean {
  return !!proof && typeof proof === 'object' && issuedProofs.has(proof) && proof.proposalHash === proposalHash;
}

/** The person-facing refusal: what was refused and the approval it needs. */
export interface RaiseRefusal {
  error: 'operator-approval-required' | 'org-policy-cap';
  message: string;
  /** The approval this change needs. */
  needs: string;
  /** What in the request widens authority. */
  raises: string[];
}

export const RAISE_NEEDS =
  "the person's approval from their own direct chat with the agent (they reply `approve <code>` to the request card)";

export function raiseRefusal(raises: string[]): RaiseRefusal {
  return {
    error: 'operator-approval-required',
    message: `This would widen what the agent may do (${raises.join('; ')}). Widening needs ${RAISE_NEEDS}. `
      + 'Narrowing never needs it. That approval path is not installed on this version yet, so the setting stays as it is.',
    needs: RAISE_NEEDS,
    raises,
  };
}

/** An organization's independence cap refused a raise (org-pack-and-join §D). */
export function orgCapRefusal(cap: { level: AutonomyProfileLevel; orgName: string }): RaiseRefusal {
  const words: Record<AutonomyProfileLevel, string> = { cautious: 'Careful', supervised: 'Balanced', collaborative: 'Trusting', autonomous: 'Independent' };
  return {
    error: 'org-policy-cap',
    message: `${cap.orgName}'s policy allows at most ${words[cap.level]}, so the setting stays as it is.`,
    needs: `a change to ${cap.orgName}'s policy`,
    raises: [],
  };
}

export class TrustRaiseRefusedError extends Error {
  constructor(readonly refusal: RaiseRefusal) {
    super(refusal.message);
    this.name = 'TrustRaiseRefusedError';
  }
}

// ── Trust levels ──────────────────────────────────────────────────────

const TRUST_ORDER: readonly TrustLevel[] = ['blocked', 'approve-always', 'approve-first', 'log', 'autonomous'];

/** Is `to` less restrictive than `from`? An unknown level is treated as the most permissive. */
export function isTrustLevelRaise(from: TrustLevel | undefined, to: TrustLevel): boolean {
  const a = from === undefined ? -1 : TRUST_ORDER.indexOf(from);
  const b = TRUST_ORDER.indexOf(to);
  if (b < 0) return true;
  return b > a;
}

export function isKnownTrustLevel(x: unknown): x is TrustLevel {
  return typeof x === 'string' && (TRUST_ORDER as readonly string[]).includes(x);
}

// ── Autonomy profiles ─────────────────────────────────────────────────

const AGENT_AUTONOMY_ORDER = ['supervised', 'collaborative', 'autonomous'] as const;

/**
 * The fields of a profile that are permissions (decision 4: agent autonomy, safety, autonomous
 * evolution). Updates and discovery are not authority and are not compared.
 */
export function profileRaises(from: AutonomyProfileLevel, to: AutonomyProfileLevel): string[] {
  const a = PROFILE_DEFAULTS[from];
  const b = PROFILE_DEFAULTS[to];
  if (!a || !b) return ['an unknown autonomy profile'];
  const out: string[] = [];
  if (AGENT_AUTONOMY_ORDER.indexOf(b.agentAutonomyLevel as typeof AGENT_AUTONOMY_ORDER[number])
    > AGENT_AUTONOMY_ORDER.indexOf(a.agentAutonomyLevel as typeof AGENT_AUTONOMY_ORDER[number])) {
    out.push(`agent autonomy ${a.agentAutonomyLevel} → ${b.agentAutonomyLevel}`);
  }
  if (b.safetyLevel > a.safetyLevel) out.push('risky commands without asking first');
  if (b.evolutionApprovalMode === 'autonomous' && a.evolutionApprovalMode !== 'autonomous') {
    out.push('approving its own evolution proposals');
  }
  return out;
}

// ── PATCH /config ─────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The one-level merge PATCH /config applies, so the comparison sees exactly what would be written. */
export function mergedConfigValue(before: unknown, patchValue: unknown): unknown {
  if (isObj(patchValue) && isObj(before)) return { ...before, ...patchValue };
  return patchValue;
}

/** A list field the gate reads with `.includes()` must be an array: a string would match substrings. */
function malformedList(entry: Obj, key: string): boolean {
  return key in entry && entry[key] !== undefined && !Array.isArray(entry[key]);
}

function servicePermissionsRaises(name: string, before: unknown, after: unknown): string[] {
  const out: string[] = [];
  if (before !== undefined && !isObj(after)) {
    out.push(`removing the limits on ${name}`);
    return out;
  }
  if (!isObj(after)) return out;
  for (const key of ['permissions', 'blocked', 'requireApproval']) {
    if (malformedList(after, key)) out.push(`a ${key} value for ${name} that is not a list`);
  }
  const b = isObj(before) ? before : undefined;
  // An existing entry with no permissions list makes the gate refuse every call to it (it fails
  // closed), so giving it one is a widening.
  if (b && !Array.isArray(b.permissions) && Array.isArray(after.permissions)) {
    out.push(`making ${name} usable (its entry had no permission list, so every call was refused)`);
  }
  const bBlocked = strList(b?.blocked), aBlocked = strList(after.blocked);
  const bReq = strList(b?.requireApproval), aReq = strList(after.requireApproval);
  for (const op of bBlocked) if (!aBlocked.includes(op)) out.push(`unblocking ${op} on ${name}`);
  for (const op of bReq) if (!aReq.includes(op)) out.push(`no longer asking before ${op} on ${name}`);
  const bPerm = b ? strList(b.permissions) : null;
  const aPerm = strList(after.permissions);
  // An empty permissions list means "no per-operation limit" (ExternalOperationGate.ts:349).
  if (bPerm === null) {
    // A new entry. It can only narrow if it lists permissions (a limit) or blocks/asks.
    if (aPerm.length === 0 && aBlocked.length === 0 && aReq.length === 0) return out;
  } else if (bPerm.length > 0) {
    if (aPerm.length === 0) out.push(`removing the permission limit on ${name}`);
    else for (const op of aPerm) if (!bPerm.includes(op)) out.push(`allowing ${op} on ${name}`);
  }
  const bBatch = typeof b?.batchLimit === 'number' ? b.batchLimit : undefined;
  const aBatch = typeof after.batchLimit === 'number' ? after.batchLimit : undefined;
  if (bBatch !== undefined && (aBatch === undefined || aBatch > bBatch)) out.push(`a larger batch limit on ${name}`);
  return out;
}

/** What a `externalOperations` patch widens. */
export function externalOperationsRaises(before: unknown, patchValue: unknown): string[] {
  const after = mergedConfigValue(before, patchValue);
  const b: Obj = isObj(before) ? before : {};
  if (!isObj(after)) return ['replacing the external-operation safety settings'];
  const out: string[] = [];
  if (b.enabled !== false && after.enabled === false) out.push('turning off the external-operation gate');
  const bSent = isObj(b.sentinel) ? b.sentinel : {};
  const aSent = isObj(after.sentinel) ? after.sentinel : undefined;
  if (bSent.enabled !== false && (aSent === undefined ? b.sentinel !== undefined : aSent.enabled === false)) {
    out.push('turning off the emergency-stop sentinel');
  }
  const bSvc = isObj(b.services) ? b.services : {};
  const aSvc = isObj(after.services) ? after.services : {};
  if (b.services !== undefined && !isObj(after.services) && Object.keys(bSvc).length > 0) {
    out.push('removing every per-service limit');
  } else {
    for (const name of new Set([...Object.keys(bSvc), ...Object.keys(aSvc)])) {
      out.push(...servicePermissionsRaises(name, bSvc[name], aSvc[name]));
    }
  }
  if (malformedList(after, 'readOnlyServices')) out.push('a read-only service value that is not a list');
  const bRo = strList(b.readOnlyServices), aRo = strList(after.readOnlyServices);
  for (const s of bRo) if (!aRo.includes(s)) out.push(`letting ${s} make changes (no longer read-only)`);
  const bTrust = isObj(b.trust) ? b.trust : {};
  const aTrust = isObj(after.trust) ? after.trust : {};
  if (aTrust.floor === 'collaborative' && bTrust.floor === 'supervised') out.push('a wider trust floor');
  if (aTrust.autoElevateEnabled === true && bTrust.autoElevateEnabled === false) out.push('turning on trust auto-elevation');
  return out;
}

/**
 * The evolution approval mode in force: an explicit value, or (when unset or null) the profile's
 * default, exactly as AutonomyProfileManager.getResolvedState resolves it. With no known profile the
 * fallback is assumed to be the widest, so an unset value is never read as a narrowing.
 */
function resolvedEvolutionMode(evo: Obj, profile: AutonomyProfileLevel | undefined): unknown {
  const v = evo.approvalMode;
  if (v !== undefined && v !== null) return v;
  return profile && PROFILE_DEFAULTS[profile] ? PROFILE_DEFAULTS[profile].evolutionApprovalMode : 'autonomous';
}

/** What an `evolution` patch widens, compared on the values in force before and after. */
export function evolutionRaises(before: unknown, patchValue: unknown, profile?: AutonomyProfileLevel): string[] {
  const after = mergedConfigValue(before, patchValue);
  const b: Obj = isObj(before) ? before : {};
  const a: Obj = isObj(after) ? after : {};
  const out: string[] = [];
  if (resolvedEvolutionMode(a, profile) === 'autonomous' && resolvedEvolutionMode(b, profile) !== 'autonomous') {
    out.push('approving its own evolution proposals');
  }
  if (a.autoImplement === true && b.autoImplement !== true) out.push('implementing evolution proposals on its own');
  return out;
}

/**
 * Every widening a PATCH /config body would cause, compared against the file config it merges into.
 * `profile` is the current autonomy profile, whose defaults fill unset values.
 */
export function configPatchRaises(fileConfig: Obj, patch: Obj, profile?: AutonomyProfileLevel): string[] {
  const out: string[] = [];
  if ('externalOperations' in patch) out.push(...externalOperationsRaises(fileConfig.externalOperations, patch.externalOperations));
  if ('evolution' in patch) out.push(...evolutionRaises(fileConfig.evolution, patch.evolution, profile));
  return out;
}

// ── Slack roles ───────────────────────────────────────────────────────

/** Registering or approving a Slack principal as owner or admin is a raise (decision 4). */
export function slackRoleRaises(role: unknown): string[] {
  return role === 'owner' || role === 'admin' ? [`making a Slack account ${role}`] : [];
}

// ── Work board policy ─────────────────────────────────────────────────

/** Any board policy other than `every-agent-card` is a raise (decision 4). */
export function boardPolicyRaises(policy: unknown): string[] {
  return policy === undefined || policy === 'every-agent-card' ? [] : [`work board policy ${String(policy)}`];
}
