import { createHash } from 'node:crypto';

export const STANDING_DRIVE_SCHEMA_VERSION = 1 as const;
export type StandingDriveSource = 'telegram' | 'local-operator';
export type StandingDriveDisposition = 'active' | 'stopped' | 'abandoned' | 'superseded';
export type StandingDriveActionDomain = 'git' | 'external-operation' | 'message-review' | 'local-read-test' | 'operator-transition';

export interface StandingDriveAuthorityV1 {
  source: StandingDriveSource;
  verifiedEventId: string;
  operatorPrincipalHash: string;
  topicBindingDigest: string;
  projectBindingDigest: string;
  authorizedAt: string;
}

export interface FrozenActionRuleV1 {
  id: string;
  domain: StandingDriveActionDomain;
  operation: string;
  targets: string[];
  constraints?: Record<string, string | string[] | boolean>;
}

export interface FrozenPhaseV1 {
  id: string;
  domain: StandingDriveActionDomain;
  criterionIds: string[];
  actionRuleIds: string[];
}

export interface FrozenCriterionV1 { id: string; kind: string }

export interface StandingDriveEnvelopeV1 {
  digest: string;
  phases: FrozenPhaseV1[];
  acceptanceCriteria: FrozenCriterionV1[];
  allowedActions: FrozenActionRuleV1[];
}

export interface StandingDriveExtensionV1 {
  schemaVersion: typeof STANDING_DRIVE_SCHEMA_VERSION;
  requestDigest: string;
  creationKey: string;
  authority: StandingDriveAuthorityV1;
  envelope: StandingDriveEnvelopeV1;
  cursor: { phaseId: string; state: 'pending' | 'active' | 'completed' };
  disposition: {
    state: StandingDriveDisposition;
    at?: string;
    reasonCode?: string;
    supersededByRunId?: string;
  };
  commitmentRef?: string;
  semanticProgress: { fingerprint: string; lastProgressAt: string; version: number };
  breaker: {
    state: 'closed' | 'tripped';
    consecutiveNoProgress: number;
    trippedAt?: string;
    rearmBasis?: 'operator-transition' | 'semantic-progress';
  };
  revision: number;
}

export type StandingDriveActionRequest = {
  domain: StandingDriveActionDomain;
  operation: string;
  target: string;
  constraints?: Record<string, string | string[] | boolean>;
};

export type StandingDriveActionDecision =
  | 'allow'
  | 'hold:not-enumerated'
  | 'hold:phase-mismatch'
  | 'hold:constraint-mismatch'
  | 'hold:ineligible-extension'
  | 'hold:corrupt';

export interface StandingDriveActionDerivationV1 {
  decision: StandingDriveActionDecision;
  matchedRuleId: string | null;
  envelopeDigest: string | null;
  decisionDigest: string;
}

const HEX_64 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9._:-]{1,160}$/;
const MAX_PHASES = 64;
const MAX_RULES = 256;
const MAX_CRITERIA = 256;
const ACTION_DOMAINS: readonly StandingDriveActionDomain[] = ['git', 'external-operation', 'message-review', 'local-read-test', 'operator-transition'];
const boundedText = (value: unknown, max = 500): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value);
const canonicalIso = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
};
const uniqueStrings = (values: unknown[], max: number): values is string[] =>
  values.length <= max && values.every((value) => typeof value === 'string' && ID.test(value)) && new Set(values).size === values.length;
const validConstraints = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 64) return false;
  return Object.entries(value).every(([key, v]) => ID.test(key) && (
    typeof v === 'boolean' || boundedText(v) || (Array.isArray(v) && v.length <= 64 && v.every((item) => boundedText(item)))
  ));
};

const hash = (input: string): string => createHash('sha256').update(input).digest('hex');
const codeUnitCompare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const orderedObject = (value: Record<string, string | string[] | boolean> | undefined): unknown[] =>
  Object.entries(value ?? {}).sort(([a], [b]) => codeUnitCompare(a, b)).map(([k, v]) => [k, Array.isArray(v) ? [...v].sort(codeUnitCompare) : v]);
const canonicalScopedPath = (value: string): string | null => {
  if (value === '.') return '.';
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes('\\') || value.includes('//')) return null;
  const withoutTrailingSlash = value.endsWith('/') ? value.slice(0, -1) : value;
  const segments = withoutTrailingSlash.split('/');
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) return null;
  return segments.join('/');
};
const targetMatches = (domain: StandingDriveActionDomain, frozenTarget: string, requestedTarget: string): boolean => {
  if (domain !== 'git' && domain !== 'local-read-test') return frozenTarget === requestedTarget;
  const frozen = canonicalScopedPath(frozenTarget);
  const requested = canonicalScopedPath(requestedTarget);
  if (!frozen || !requested) return false;
  return frozen === '.' || requested === frozen || requested.startsWith(`${frozen}/`);
};
const validActionRequest = (value: unknown): value is StandingDriveActionRequest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !['domain', 'operation', 'target', 'constraints'].includes(key))) return false;
  const request = value as Partial<StandingDriveActionRequest>;
  return ACTION_DOMAINS.includes(request.domain as StandingDriveActionDomain)
    && typeof request.operation === 'string' && ID.test(request.operation)
    && boundedText(request.target)
    && validConstraints(request.constraints);
};

export function canonicalizeCreationKey(
  topicId: string,
  source: StandingDriveSource,
  verifiedEventId: string,
  requestDigest: string,
): string {
  return JSON.stringify(['standing-drive-creation-v1', topicId, source, verifiedEventId, requestDigest]);
}

export function computeCreationKey(topicId: string, authority: Pick<StandingDriveAuthorityV1, 'source' | 'verifiedEventId'>, requestDigest: string): string {
  return hash(canonicalizeCreationKey(topicId, authority.source, authority.verifiedEventId, requestDigest));
}

export function canonicalizeEnvelope(input: Omit<StandingDriveEnvelopeV1, 'digest'>): string {
  const phases = [...input.phases].sort((a, b) => codeUnitCompare(a.id, b.id)).map((p) => [p.id, p.domain, [...p.criterionIds].sort(codeUnitCompare), [...p.actionRuleIds].sort(codeUnitCompare)]);
  const criteria = [...input.acceptanceCriteria].sort((a, b) => codeUnitCompare(a.id, b.id)).map((c) => [c.id, c.kind]);
  const rules = [...input.allowedActions].sort((a, b) => codeUnitCompare(a.id, b.id)).map((r) => [r.id, r.domain, r.operation, [...r.targets].sort(codeUnitCompare), orderedObject(r.constraints)]);
  return JSON.stringify(['standing-drive-envelope-v1', phases, criteria, rules]);
}

export function computeEnvelopeDigest(input: Omit<StandingDriveEnvelopeV1, 'digest'>): string {
  return hash(canonicalizeEnvelope(input));
}

export function computeSemanticFingerprint(input: {
  phaseStates: Array<{ id: string; state: string }>;
  evidenceIds: string[];
  closedDefectIds: string[];
  blockState: string;
}): string {
  return hash(JSON.stringify(['standing-drive-progress-v1',
    [...input.phaseStates].sort((a, b) => codeUnitCompare(a.id, b.id)).map((p) => [p.id, p.state]),
    [...input.evidenceIds].sort(codeUnitCompare), [...input.closedDefectIds].sort(codeUnitCompare), input.blockState,
  ]));
}

export function validateStandingDriveExtensionV1(value: unknown, topicId?: string): value is StandingDriveExtensionV1 {
  try {
    if (!value || typeof value !== 'object') return false;
    const v = value as StandingDriveExtensionV1;
    if (v.schemaVersion !== 1 || !HEX_64.test(v.requestDigest) || !HEX_64.test(v.creationKey)) return false;
    if (!v.authority || !['telegram', 'local-operator'].includes(v.authority.source) || !ID.test(v.authority.verifiedEventId)) return false;
    if (![v.authority.operatorPrincipalHash, v.authority.topicBindingDigest, v.authority.projectBindingDigest].every((x) => HEX_64.test(x))) return false;
    if (!canonicalIso(v.authority.authorizedAt)) return false;
    const e = v.envelope;
    if (!e || !Array.isArray(e.phases) || !Array.isArray(e.allowedActions) || !Array.isArray(e.acceptanceCriteria)) return false;
    if (!HEX_64.test(e.digest) || e.phases.length > MAX_PHASES || e.allowedActions.length > MAX_RULES || e.acceptanceCriteria.length > MAX_CRITERIA) return false;
    if (e.digest !== computeEnvelopeDigest(e)) return false;
    if (topicId && v.creationKey !== computeCreationKey(topicId, v.authority, v.requestDigest)) return false;
    if (new Set(e.phases.map((p) => p.id)).size !== e.phases.length) return false;
    if (new Set(e.allowedActions.map((r) => r.id)).size !== e.allowedActions.length) return false;
    if (new Set(e.acceptanceCriteria.map((c) => c.id)).size !== e.acceptanceCriteria.length) return false;
    if (!e.phases.every((p) => ID.test(p.id) && ACTION_DOMAINS.includes(p.domain)
      && Array.isArray(p.criterionIds) && uniqueStrings(p.criterionIds, MAX_CRITERIA)
      && Array.isArray(p.actionRuleIds) && uniqueStrings(p.actionRuleIds, MAX_RULES))) return false;
    if (!e.allowedActions.every((r) => ID.test(r.id) && ACTION_DOMAINS.includes(r.domain) && ID.test(r.operation) && Array.isArray(r.targets) && r.targets.length > 0 && r.targets.length <= 64
      && r.targets.every((t) => boundedText(t) && (!['git', 'local-read-test'].includes(r.domain) || canonicalScopedPath(t) !== null))
      && validConstraints(r.constraints))) return false;
    if (!e.acceptanceCriteria.every((c) => ID.test(c.id) && ID.test(c.kind))) return false;
    const criterionIds = new Set(e.acceptanceCriteria.map((c) => c.id));
    const rulesById = new Map(e.allowedActions.map((r) => [r.id, r]));
    if (!e.phases.every((p) => p.criterionIds.every((id) => criterionIds.has(id))
      && p.actionRuleIds.every((id) => rulesById.get(id)?.domain === p.domain))) return false;
    if (!e.phases.some((p) => p.id === v.cursor?.phaseId) || !['pending', 'active', 'completed'].includes(v.cursor?.state)) return false;
    if (!['active', 'stopped', 'abandoned', 'superseded'].includes(v.disposition?.state)) return false;
    if (v.disposition.at !== undefined && !canonicalIso(v.disposition.at)) return false;
    if (v.disposition.reasonCode !== undefined && !boundedText(v.disposition.reasonCode, 160)) return false;
    if (v.disposition.supersededByRunId !== undefined && !ID.test(v.disposition.supersededByRunId)) return false;
    if (v.commitmentRef !== undefined && !ID.test(v.commitmentRef)) return false;
    if (!Number.isSafeInteger(v.revision) || v.revision < 1 || !Number.isSafeInteger(v.semanticProgress?.version) || v.semanticProgress.version < 0) return false;
    if (!HEX_64.test(v.semanticProgress?.fingerprint) || !canonicalIso(v.semanticProgress?.lastProgressAt)) return false;
    if (!['closed', 'tripped'].includes(v.breaker?.state) || !Number.isSafeInteger(v.breaker.consecutiveNoProgress) || v.breaker.consecutiveNoProgress < 0) return false;
    if (v.breaker.trippedAt !== undefined && !canonicalIso(v.breaker.trippedAt)) return false;
    if (v.breaker.rearmBasis !== undefined && !['operator-transition', 'semantic-progress'].includes(v.breaker.rearmBasis)) return false;
    return true;
  } catch {
    /* @silent-fallback-ok — boundary validator converts malformed nested input to false;
       callers receive the explicit fail-closed corrupt/hold decision. */
    return false;
  }
}

/** Scope membership only; effects must also compose aliveness, breaker eligibility, and authority rebind. */
export function deriveActionDecisionDetailed(extension: unknown, phaseId: unknown, request: unknown): StandingDriveActionDerivationV1 {
  let decision: StandingDriveActionDecision = 'hold:corrupt';
  let matchedRuleId: string | null = null;
  let envelopeDigest: string | null = null;
  let canonicalRequest: unknown = ['invalid-request'];

  if (extension && typeof extension === 'object' && (extension as { schemaVersion?: unknown }).schemaVersion !== 1) {
    decision = 'hold:ineligible-extension';
  } else if (validateStandingDriveExtensionV1(extension)) {
    envelopeDigest = extension.envelope.digest;
    if (typeof phaseId === 'string' && ID.test(phaseId) && validActionRequest(request)) {
      const canonicalTarget = request.domain === 'git' || request.domain === 'local-read-test'
        ? canonicalScopedPath(request.target) ?? ['invalid-scoped-path', request.target]
        : request.target;
      canonicalRequest = [request.domain, request.operation, canonicalTarget, orderedObject(request.constraints)];
      const phase = extension.envelope.phases.find((candidate) => candidate.id === phaseId);
      if (!phase || extension.cursor.phaseId !== phaseId || phase.domain !== request.domain) {
        decision = 'hold:phase-mismatch';
      } else {
        const candidates = extension.envelope.allowedActions.filter((rule) =>
          phase.actionRuleIds.includes(rule.id) && rule.domain === request.domain && rule.operation === request.operation)
          .sort((a, b) => codeUnitCompare(a.id, b.id));
        if (candidates.length === 0) {
          decision = 'hold:not-enumerated';
        } else {
          const matched = candidates.find((rule) => rule.targets.some((target) => targetMatches(rule.domain, target, request.target))
            && JSON.stringify(orderedObject(rule.constraints)) === JSON.stringify(orderedObject(request.constraints)));
          if (matched) {
            decision = 'allow';
            matchedRuleId = matched.id;
          } else {
            decision = 'hold:constraint-mismatch';
          }
        }
      }
    }
  }

  const decisionDigest = hash(JSON.stringify([
    'standing-drive-action-derivation-v1',
    envelopeDigest,
    typeof phaseId === 'string' ? phaseId : null,
    canonicalRequest,
    decision,
    matchedRuleId,
  ]));
  return { decision, matchedRuleId, envelopeDigest, decisionDigest };
}

/** Compatibility projection for callers that only need the closed decision enum. */
export function deriveActionDecision(extension: unknown, phaseId: string, request: StandingDriveActionRequest): StandingDriveActionDecision {
  return deriveActionDecisionDetailed(extension, phaseId, request).decision;
}

export function checkAuthorityRebind(extension: unknown, current: { operatorPrincipalHash: string; topicBindingDigest: string; projectBindingDigest: string }): boolean {
  if (!validateStandingDriveExtensionV1(extension)) return false;
  const a = extension.authority;
  return a.operatorPrincipalHash === current.operatorPrincipalHash && a.topicBindingDigest === current.topicBindingDigest && a.projectBindingDigest === current.projectBindingDigest;
}

export function readBreakerEligibility(extension: unknown): { eligible: boolean; reason: string } {
  if (!validateStandingDriveExtensionV1(extension)) return { eligible: false, reason: 'breaker-unreadable' };
  return extension.breaker.state === 'tripped' ? { eligible: false, reason: 'breaker-tripped' } : { eligible: true, reason: 'closed' };
}

export function isStandingDriveAlive(extension: unknown): boolean {
  return validateStandingDriveExtensionV1(extension) && extension.disposition.state === 'active';
}

export function applyDispositionTransition(
  extension: StandingDriveExtensionV1,
  next: StandingDriveDisposition,
  verifiedAuthority: boolean,
  at: string,
): StandingDriveExtensionV1 {
  if (!verifiedAuthority) throw new Error('standing-drive-authority-required');
  if (['abandoned', 'superseded'].includes(extension.disposition.state)) throw new Error('standing-drive-terminal');
  const allowed = extension.disposition.state === 'active'
    ? ['stopped', 'abandoned', 'superseded'].includes(next)
    : extension.disposition.state === 'stopped' && ['active', 'abandoned', 'superseded'].includes(next);
  if (!allowed) throw new Error('standing-drive-invalid-transition');
  return { ...extension, disposition: { ...extension.disposition, state: next, at }, revision: extension.revision + 1 };
}

export function composeStopDecision(sources: Array<boolean | 'unreadable'>): { stopped: boolean; reason: string } {
  if (sources.includes(true)) return { stopped: true, reason: 'operator-stop' };
  if (sources.includes('unreadable')) return { stopped: true, reason: 'stop-evidence-unreadable' };
  return { stopped: false, reason: 'clear' };
}
