import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { TurnEvidence } from './TurnEvidence.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export type ClaimKind = 'temporal' | 'capacity-limit' | 'completion' | 'cross-agent-action'
  | 'operator-attribution' | 'state-fact' | 'external-fact' | 'unknown';
export type ClaimCriticality = 'low' | 'medium' | 'high' | 'irreversible-precondition';
export type SubjectKind = 'session' | 'commitment' | 'guard' | 'pull-request' | 'tool-action'
  | 'capacity-model' | 'operator' | 'external-entity' | 'unknown';
export type ClaimPredicate = 'session.elapsed-ms' | 'session.state' | 'commitment.state' | 'guard.state'
  | 'pull-request.merged' | 'pull-request.checks-pass' | 'tool-action.completed' | 'capacity.limit'
  | 'operator.attributed' | 'external.fact' | 'unknown';
export type TypedOperand = { type: 'duration-ms'; value: number }
  | { type: 'state-enum'; value: string; enumVersion: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'integer'; value: number; unit: string }
  | { type: 'none' };
export type Comparator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
export type SubjectSelector = { type: 'current-session' }
  | { type: 'explicit-id'; entityKind: 'commitment' | 'guard'; id: string }
  | { type: 'pull-request'; repository: string; number: number }
  | { type: 'same-turn-action'; actionIndex: number }
  | { type: 'unresolved' };
export interface ConsequenceRef {
  relation: 'premise-for' | 'none';
  actionClass: 'delete' | 'production-deploy' | 'merge' | 'publish' | 'external-send'
    | 'credential-change' | 'other' | 'none';
  actionStartByte?: number;
  actionEndByte?: number;
}
export interface ExtractedClaim {
  clauseId: number;
  kind: ClaimKind;
  subjectKind: SubjectKind;
  predicate: ClaimPredicate;
  operand: TypedOperand;
  comparator: Comparator;
  subjectSelector: SubjectSelector;
  consequence: ConsequenceRef;
  sourceStartByte: number;
  sourceEndByte: number;
  referencedEntityHints: string[];
  endorsed: boolean;
  negated: boolean;
  hedged: boolean;
  quoted: boolean;
  suggestedCriticality: ClaimCriticality;
  confidence: number;
  tenseScope: 'current' | 'past' | 'future' | 'timeless' | 'unknown';
}
export interface GeneralClaimEnvelope { schemaVersion: 1; claims: ExtractedClaim[]; saturated: boolean }
export interface PreparedClaimObservation {
  policy: 'standard-scrubbed' | 'restricted-local' | 'deny';
  message: string;
  evidence: TurnEvidence;
  candidates: Array<{ clauseId: number; text: string; sourceStartByte: number; sourceEndByte: number }>;
  scrubVersion: 'claim-scrub-v1';
  privacyPolicyVersion: 'claim-content-v1';
}
export interface ClaimAssessment {
  claimId: string;
  verdict: 'supported' | 'refuted' | 'unverifiable';
  reasonCode: string;
  sourceKind: string;
  sourceRevision?: string;
  observedAt: string;
  freshUntil?: string;
  latencyMs: number;
}

const KINDS = new Set<ClaimKind>(['temporal', 'capacity-limit', 'completion', 'cross-agent-action', 'operator-attribution', 'state-fact', 'external-fact', 'unknown']);
const SUBJECTS = new Set<SubjectKind>(['session', 'commitment', 'guard', 'pull-request', 'tool-action', 'capacity-model', 'operator', 'external-entity', 'unknown']);
const PREDICATES = new Set<ClaimPredicate>(['session.elapsed-ms', 'session.state', 'commitment.state', 'guard.state', 'pull-request.merged', 'pull-request.checks-pass', 'tool-action.completed', 'capacity.limit', 'operator.attributed', 'external.fact', 'unknown']);
const COMPARATORS = new Set<Comparator>(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']);
const CRITICALITIES = new Set<ClaimCriticality>(['low', 'medium', 'high', 'irreversible-precondition']);
const TENSES = new Set<ExtractedClaim['tenseScope']>(['current', 'past', 'future', 'timeless', 'unknown']);
const IRREVERSIBLE = new Set<ConsequenceRef['actionClass']>(['delete', 'production-deploy', 'merge', 'publish', 'external-send', 'credential-change', 'other']);
const PROTECTED: Record<string, RegExp> = {
  capacity: /\b(?:capacity|cap(?:ped)?|limit|lane|slot|concurr\w*)\b/i,
  completion: /\b(?:done|complete\w*|finish\w*|pass(?:ed)?|green|merge\w*|deploy\w*|ship\w*|fix(?:ed)?)\b/i,
  attribution: /\b(?:approv\w*|authoriz\w*|credential|permission)\b/i,
  action: /\b(?:delete|remove|publish|send|restart|transfer)\b/i,
  state: /\b(?:running|stopped|open|closed|pending|active)\b/i,
  injection: /(?:ignore previous|ignore above|system prompt|developer message|<system|do not extract)/i,
};

export function buildClaimCandidates(message: string): PreparedClaimObservation['candidates'] {
  const out: PreparedClaimObservation['candidates'] = [];
  const bytes = Buffer.from(message, 'utf8');
  let start = 0;
  for (let i = 0; i < bytes.length && out.length < 24; i++) {
    const ch = bytes[i];
    if (ch !== 10 && ch !== 59 && ch !== 33 && ch !== 63 && ch !== 46) continue;
    pushCandidate(bytes, start, i + 1, out);
    start = i + 1;
  }
  if (start < bytes.length) pushCandidate(bytes, start, bytes.length, out);
  if (out.length === 24 && out[23].sourceEndByte < bytes.length) {
    out[23] = { ...out[23], text: bytes.subarray(out[23].sourceStartByte).toString('utf8').trim(), sourceEndByte: bytes.length };
  }
  return out;
}

function pushCandidate(bytes: Buffer, start: number, end: number, out: PreparedClaimObservation['candidates']): void {
  const raw = bytes.subarray(start, end).toString('utf8');
  const left = raw.length - raw.trimStart().length;
  const right = raw.trimEnd().length;
  const text = raw.trim();
  if (!text || out.length >= 24) return;
  out.push({ clauseId: out.length, text, sourceStartByte: start + Buffer.byteLength(raw.slice(0, left)), sourceEndByte: start + Buffer.byteLength(raw.slice(0, right)) });
}

export function prepareClaimObservation(message: string, evidence: TurnEvidence): PreparedClaimObservation {
  if (Buffer.byteLength(message, 'utf8') > 32_768) return denied('deny');
  let serial = 0;
  const placeholder = (kind: string): string => `[REDACTED_${kind}_${String(++serial).padStart(2, '0')}]`;
  const redact = (value: string): string => value
    .replace(/(?:gh[pousr]_[A-Za-z0-9]{20,}|\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b\d{6,12}:[A-Za-z0-9_-]{30,}\b|\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b)/gi,
      () => placeholder('SECRET'))
    .replace(/https?:\/\/[^\s)\]}]+/gi, () => placeholder('URL'))
    .replace(/(?:^|\s)(?:\/[A-Za-z0-9._-]+){2,}/g, (match) => `${match.startsWith(' ') ? ' ' : ''}${placeholder('PATH')}`)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, () => placeholder('IDENTITY'));
  const scrubbed = redact(message);
  if (Buffer.byteLength(scrubbed, 'utf8') > 16_384) return denied('deny');
  const safeEvidence: TurnEvidence = {
    hadToolCalls: evidence.hadToolCalls,
    truncated: evidence.truncated,
    unavailable: evidence.unavailable,
    canaryOk: evidence.canaryOk,
    ...(evidence.reason ? { reason: redact(evidence.reason).slice(0, 256) } : {}),
    toolCalls: evidence.toolCalls.slice(0, 200).map((item) => ({
      tool: redact(item.tool).slice(0, 100), actionKind: item.actionKind, ok: item.ok,
      ...(item.targetSummary ? { targetSummary: redact(item.targetSummary).slice(0, 256) } : {}),
      ...(item.errorClass ? { errorClass: redact(item.errorClass).slice(0, 100) } : {}),
    })),
  };
  return { policy: 'standard-scrubbed', message: scrubbed, evidence: safeEvidence,
    candidates: buildClaimCandidates(scrubbed), scrubVersion: 'claim-scrub-v1', privacyPolicyVersion: 'claim-content-v1' };
}

function denied(policy: 'deny' | 'restricted-local'): PreparedClaimObservation {
  return { policy, message: '', evidence: { hadToolCalls: false, toolCalls: [], truncated: false, unavailable: true, canaryOk: true, reason: 'privacy-boundary' }, candidates: [], scrubVersion: 'claim-scrub-v1', privacyPolicyVersion: 'claim-content-v1' };
}

export function parseGeneralClaimEnvelope(raw: string, message: string): GeneralClaimEnvelope | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match?.[0] ?? raw) as Record<string, unknown>;
    const general = parsed.general && typeof parsed.general === 'object' ? parsed.general as Record<string, unknown> : parsed;
    if (!onlyKeys(general, ['schemaVersion', 'claims']) || general.schemaVersion !== 1
      || !Array.isArray(general.claims) || general.claims.length > 4) return null;
    const claims = general.claims.map((value) => validateClaim(value, message));
    if (claims.some((claim) => claim === null)) return null;
    const unique: ExtractedClaim[] = [];
    const exact = new Set<string>();
    const spanPredicate = new Map<string, string>();
    for (const claim of claims as ExtractedClaim[]) {
      const tuple = `${claim.clauseId}|${claim.sourceStartByte}|${claim.sourceEndByte}|${claim.predicate}|${claim.comparator}|${JSON.stringify(claim.operand)}`;
      if (exact.has(tuple)) continue;
      const conflictKey = `${claim.clauseId}|${claim.sourceStartByte}|${claim.sourceEndByte}|${claim.predicate}`;
      const prior = spanPredicate.get(conflictKey);
      if (prior && prior !== tuple) return null;
      exact.add(tuple); spanPredicate.set(conflictKey, tuple); unique.push(claim);
    }
    return { schemaVersion: 1, claims: unique, saturated: general.claims.length === 4 };
  } catch { return null; }
}

function validateClaim(value: unknown, message: string): ExtractedClaim | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!onlyKeys(v, ['clauseId', 'kind', 'subjectKind', 'predicate', 'operand', 'comparator', 'subjectSelector',
    'consequence', 'sourceStartByte', 'sourceEndByte', 'referencedEntityHints', 'endorsed', 'negated',
    'hedged', 'quoted', 'suggestedCriticality', 'confidence', 'tenseScope'])) return null;
  const byteLength = Buffer.byteLength(message, 'utf8');
  if (!Number.isSafeInteger(v.clauseId) || !KINDS.has(v.kind as ClaimKind) || !SUBJECTS.has(v.subjectKind as SubjectKind)
    || !PREDICATES.has(v.predicate as ClaimPredicate) || !COMPARATORS.has(v.comparator as Comparator)
    || !CRITICALITIES.has(v.suggestedCriticality as ClaimCriticality) || !TENSES.has(v.tenseScope as ExtractedClaim['tenseScope'])
    || !Number.isInteger(v.sourceStartByte) || !Number.isInteger(v.sourceEndByte)
    || Number(v.sourceStartByte) < 0 || Number(v.sourceEndByte) <= Number(v.sourceStartByte) || Number(v.sourceEndByte) > byteLength
    || typeof v.endorsed !== 'boolean' || typeof v.negated !== 'boolean' || typeof v.hedged !== 'boolean' || typeof v.quoted !== 'boolean'
    || typeof v.confidence !== 'number' || v.confidence < 0 || v.confidence > 1
    || !Array.isArray(v.referencedEntityHints) || v.referencedEntityHints.length > 4
    || v.referencedEntityHints.some((x) => typeof x !== 'string' || Buffer.byteLength(x) > 200)
    || !validOperand(v.operand) || !validSelector(v.subjectSelector) || !validConsequence(v.consequence, byteLength)) return null;
  const consequence = v.consequence as ConsequenceRef;
  const operand = v.operand as TypedOperand;
  if ((operand.type === 'boolean' || operand.type === 'state-enum' || operand.type === 'none')
    && v.comparator !== 'eq' && v.comparator !== 'ne') return null;
  if (consequence.relation === 'premise-for' && consequence.actionStartByte !== undefined && consequence.actionEndByte !== undefined
    && consequence.actionStartByte < Number(v.sourceEndByte) && consequence.actionEndByte > Number(v.sourceStartByte)) return null;
  return v as unknown as ExtractedClaim;
}

function validOperand(value: unknown): value is TypedOperand {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!onlyKeys(v, v.type === 'duration-ms' ? ['type', 'value'] : v.type === 'boolean' ? ['type', 'value']
    : v.type === 'integer' ? ['type', 'value', 'unit'] : v.type === 'state-enum' ? ['type', 'value', 'enumVersion'] : ['type'])) return false;
  if (v.type === 'none') return true;
  if (v.type === 'duration-ms') return Number.isSafeInteger(v.value) && Number(v.value) >= 0;
  if (v.type === 'boolean') return typeof v.value === 'boolean';
  if (v.type === 'integer') return Number.isSafeInteger(v.value) && typeof v.unit === 'string' && v.unit.length <= 40;
  return v.type === 'state-enum' && typeof v.value === 'string' && typeof v.enumVersion === 'string';
}
function validSelector(value: unknown): value is SubjectSelector {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!onlyKeys(v, v.type === 'explicit-id' ? ['type', 'entityKind', 'id'] : v.type === 'pull-request' ? ['type', 'repository', 'number']
    : v.type === 'same-turn-action' ? ['type', 'actionIndex'] : ['type'])) return false;
  if (v.type === 'current-session' || v.type === 'unresolved') return true;
  if (v.type === 'same-turn-action') return Number.isInteger(v.actionIndex) && Number(v.actionIndex) >= 0 && Number(v.actionIndex) < 200;
  if (v.type === 'explicit-id') return (v.entityKind === 'commitment' || v.entityKind === 'guard') && typeof v.id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(v.id);
  return v.type === 'pull-request' && typeof v.repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(v.repository) && Number.isSafeInteger(v.number) && Number(v.number) > 0;
}
function validConsequence(value: unknown, messageBytes: number): value is ConsequenceRef {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!onlyKeys(v, v.relation === 'premise-for' ? ['relation', 'actionClass', 'actionStartByte', 'actionEndByte'] : ['relation', 'actionClass'])) return false;
  const relations = new Set(['premise-for', 'none']);
  const actions = new Set(['delete', 'production-deploy', 'merge', 'publish', 'external-send', 'credential-change', 'other', 'none']);
  if (!relations.has(String(v.relation)) || !actions.has(String(v.actionClass))) return false;
  if (v.relation === 'none') return v.actionClass === 'none';
  return Number.isInteger(v.actionStartByte) && Number.isInteger(v.actionEndByte)
    && Number(v.actionStartByte) >= 0 && Number(v.actionEndByte) > Number(v.actionStartByte) && Number(v.actionEndByte) <= messageBytes;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

export function applyClaimCriticalityFloor(claim: ExtractedClaim): ClaimCriticality {
  if (claim.consequence.relation === 'premise-for' && IRREVERSIBLE.has(claim.consequence.actionClass)) return 'irreversible-precondition';
  const floor: ClaimCriticality = ['capacity.limit', 'tool-action.completed', 'operator.attributed'].includes(claim.predicate) ? 'high'
    : ['session.elapsed-ms', 'session.state', 'commitment.state', 'guard.state', 'pull-request.merged', 'pull-request.checks-pass'].includes(claim.predicate) ? 'medium'
      : claim.kind === 'unknown' || claim.predicate === 'unknown' ? 'medium' : 'low';
  const rank: ClaimCriticality[] = ['low', 'medium', 'high', 'irreversible-precondition'];
  return rank[Math.max(rank.indexOf(floor), rank.indexOf(claim.suggestedCriticality))];
}

export function assessClaim(claim: ExtractedClaim, ctx: { evidence: TurnEvidence; now?: Date;
  sessionSnapshot?: { state: string; elapsedMs: number; revision: string; observedAt: string };
  commitmentSnapshots?: Record<string, { state: string; revision: string; observedAt: string }>;
  guardSnapshots?: Record<string, { state: string; revision: string; observedAt: string }> }): ClaimAssessment {
  const started = performance.now();
  const observedAt = (ctx.now ?? new Date()).toISOString();
  const base = { claimId: createHash('sha256').update(JSON.stringify(claim)).digest('hex'), observedAt, latencyMs: 0 };
  if (claim.predicate === 'capacity.limit' || claim.predicate === 'pull-request.merged' || claim.predicate === 'pull-request.checks-pass') {
    return { ...base, verdict: 'unverifiable', reasonCode: 'no-canonical-oracle', sourceKind: 'none', latencyMs: performance.now() - started };
  }
  if (claim.predicate === 'tool-action.completed') {
    if ((claim.tenseScope !== 'past' && claim.tenseScope !== 'current') || claim.subjectSelector.type !== 'same-turn-action') {
      return { ...base, verdict: 'unverifiable', reasonCode: 'unsupported-tense-or-selector', sourceKind: 'turn-evidence', latencyMs: performance.now() - started };
    }
    const item = ctx.evidence.toolCalls[claim.subjectSelector.actionIndex];
    if (!item || ctx.evidence.unavailable || ctx.evidence.truncated) return { ...base, verdict: 'unverifiable', reasonCode: 'evidence-incomplete', sourceKind: 'turn-evidence', latencyMs: performance.now() - started };
    const expected = claim.operand.type === 'boolean' ? claim.operand.value : true;
    const actual = item.ok;
    const matches = claim.comparator === 'ne' ? actual !== expected : actual === expected;
    return { ...base, verdict: matches ? 'supported' : 'refuted', reasonCode: 'same-turn-evidence', sourceKind: 'turn-evidence', sourceRevision: 'turn-evidence-v1', latencyMs: performance.now() - started };
  }
  if (claim.predicate === 'session.elapsed-ms' || claim.predicate === 'session.state') {
    if (claim.tenseScope !== 'current' || claim.subjectSelector.type !== 'current-session') {
      return { ...base, verdict: 'unverifiable', reasonCode: 'unsupported-tense-or-selector', sourceKind: 'session-registry', latencyMs: performance.now() - started };
    }
    const snapshot = ctx.sessionSnapshot;
    if (!snapshot || Math.abs(Date.parse(observedAt) - Date.parse(snapshot.observedAt)) > 2_000) {
      return { ...base, verdict: 'unverifiable', reasonCode: 'missing-or-stale-snapshot', sourceKind: 'session-registry', latencyMs: performance.now() - started };
    }
    const actual = claim.predicate === 'session.elapsed-ms' ? snapshot.elapsedMs : snapshot.state;
    const expected = claim.operand.type === 'duration-ms' || claim.operand.type === 'state-enum' ? claim.operand.value : undefined;
    if (expected === undefined) return { ...base, verdict: 'unverifiable', reasonCode: 'operand-type-mismatch', sourceKind: 'session-registry', latencyMs: performance.now() - started };
    const matches = claim.predicate === 'session.elapsed-ms' && typeof actual === 'number' && typeof expected === 'number'
      && (claim.comparator === 'eq' || claim.comparator === 'ne')
      ? (claim.comparator === 'eq') === (Math.abs(actual - expected) <= Math.max(15 * 60_000, actual * 0.2))
      : compare(actual, expected, claim.comparator);
    return { ...base, verdict: matches ? 'supported' : 'refuted', reasonCode: 'fresh-exact-session-snapshot',
      sourceKind: 'session-registry', sourceRevision: snapshot.revision, latencyMs: performance.now() - started };
  }
  if (claim.predicate === 'commitment.state' || claim.predicate === 'guard.state') {
    if (claim.tenseScope !== 'current' || claim.subjectSelector.type !== 'explicit-id'
      || (claim.predicate === 'commitment.state' && claim.subjectSelector.entityKind !== 'commitment')
      || (claim.predicate === 'guard.state' && claim.subjectSelector.entityKind !== 'guard')) {
      return { ...base, verdict: 'unverifiable', reasonCode: 'unsupported-tense-or-selector', sourceKind: 'registry', latencyMs: performance.now() - started };
    }
    const snapshot = claim.predicate === 'commitment.state' ? ctx.commitmentSnapshots?.[claim.subjectSelector.id]
      : ctx.guardSnapshots?.[claim.subjectSelector.id];
    if (!snapshot || Math.abs(Date.parse(observedAt) - Date.parse(snapshot.observedAt)) > 2_000) {
      return { ...base, verdict: 'unverifiable', reasonCode: 'missing-or-stale-snapshot', sourceKind: 'registry', latencyMs: performance.now() - started };
    }
    if (claim.operand.type !== 'state-enum') return { ...base, verdict: 'unverifiable', reasonCode: 'operand-type-mismatch', sourceKind: 'registry', latencyMs: performance.now() - started };
    const matches = compare(snapshot.state, claim.operand.value, claim.comparator);
    return { ...base, verdict: matches ? 'supported' : 'refuted', reasonCode: 'fresh-exact-registry-snapshot',
      sourceKind: claim.predicate === 'commitment.state' ? 'commitment-registry' : 'guard-registry',
      sourceRevision: snapshot.revision, latencyMs: performance.now() - started };
  }
  return { ...base, verdict: 'unverifiable', reasonCode: 'no-supported-verifier', sourceKind: 'none', latencyMs: performance.now() - started };
}

function compare(actual: number | string, expected: number | string, comparator: Comparator): boolean {
  if (typeof actual !== typeof expected) return false;
  switch (comparator) {
    case 'eq': return actual === expected;
    case 'ne': return actual !== expected;
    case 'gt': return actual > expected;
    case 'gte': return actual >= expected;
    case 'lt': return actual < expected;
    case 'lte': return actual <= expected;
  }
}

export function protectedCueGaps(message: string, claims: ExtractedClaim[]): string[] {
  const ranges = claims.filter((claim) => claim.endorsed && !claim.quoted && !claim.hedged)
    .map((claim) => [claim.sourceStartByte, claim.sourceEndByte] as const);
  const candidates = buildClaimCandidates(message);
  const gaps: string[] = [];
  for (const [name, pattern] of Object.entries(PROTECTED)) {
    for (const candidate of candidates) {
      if (!pattern.test(candidate.text)) continue;
      if (!ranges.some(([start, end]) => start < candidate.sourceEndByte && end > candidate.sourceStartByte)) gaps.push(name);
      break;
    }
  }
  return [...new Set(gaps)];
}

export function newMessageAttemptId(): string { return randomUUID(); }

export interface ClaimObservationRecordInput {
  messageAttemptId: string;
  topicId?: number;
  claim: ExtractedClaim;
  assessment: ClaimAssessment;
  finalCriticality: ClaimCriticality;
  dryRun: boolean;
  modelDoor?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  bootId: string;
}

/** Bounded metadata-only local projection. It is never a verifier or routing authority. */
export class ClaimObservationRecorder {
  private readonly auditPath: string;
  private readonly corpusPath: string;
  private readonly keyId: string;
  private corpusRows = 0;
  private lastCorpusCompactionDay = '';
  constructor(private readonly opts: { stateDir: string; pseudonymKey: Buffer; maxAuditBytes?: number; maxCorpusBytes?: number }) {
    const root = path.join(opts.stateDir, 'state', 'claim-verification');
    this.auditPath = path.join(root, 'claim-observation-audit-v2.jsonl');
    this.corpusPath = path.join(root, 'claim-benchmark-v1.jsonl');
    this.keyId = this.hmac('instar.claim-pseudonym-key-id.v1').slice(0, 32);
    this.corpusRows = this.compactCorpus();
  }
  record(input: ClaimObservationRecordInput): boolean {
    const consequenceClass = input.claim.consequence.actionClass;
    const shape = `shape-v1|${input.claim.predicate}|${input.claim.subjectKind}|${input.claim.operand.type}|${input.claim.tenseScope}|${consequenceClass}`;
    const claimId = this.hmac(`instar.claim-id.v1|${input.messageAttemptId}|${input.claim.clauseId}|${input.claim.sourceStartByte}|${input.claim.sourceEndByte}|${input.claim.predicate}|${JSON.stringify(input.claim.operand)}`);
    const topicPseudonym = input.topicId === undefined ? undefined : this.hmac(`instar.claim-topic.v1|${input.topicId}`);
    const messagePseudonym = this.hmac(`instar.claim-message.v1|${input.messageAttemptId}`);
    const row = {
      schemaVersion: 1, eventUuid: randomUUID(), messageAttemptId: input.messageAttemptId,
      claimId, messagePseudonym, originMachinePseudonym: this.hmac('instar.claim-origin-machine.v1'),
      pseudonymKeyId: this.keyId, ...(topicPseudonym ? { topicPseudonym } : {}),
      policyVersion: 'claim-policy-v1', scrubVersion: 'claim-scrub-v1', privacyPolicyVersion: 'claim-content-v1',
      contentClass: 'standard-scrubbed', kind: input.claim.kind, predicate: input.claim.predicate,
      finalCriticality: input.finalCriticality, confidenceBucket: bucket(input.claim.confidence),
      verifierId: input.assessment.sourceKind, verifierVersion: 'claim-verifier-v1', verdict: input.assessment.verdict,
      reasonCode: input.assessment.reasonCode, sourceKind: input.assessment.sourceKind,
      ...(input.assessment.sourceRevision ? { sourceRevision: input.assessment.sourceRevision } : {}),
      observedAt: input.assessment.observedAt, latencyBucket: latencyBucket(input.assessment.latencyMs),
      actualLatencyMs: Math.max(0, Math.round(input.assessment.latencyMs)),
      detectorOutcome: input.claim.endorsed ? 'endorsed-claim' : 'non-endorsed', coverageReason: input.assessment.reasonCode,
      inputTokens: input.inputTokens ?? null, outputTokens: input.outputTokens ?? null,
      monetaryBucket: input.inputTokens === undefined ? 'unknown' : 'provider-usage-no-price-envelope',
      modelDoor: input.modelDoor ?? 'claude-code', modelId: input.modelId ?? 'fast',
      claimObservationBootId: input.bootId, dryRun: input.dryRun,
      counterfactualAdvisory: input.assessment.verdict === 'refuted' ? 'CLAIM_CONTRADICTION'
        : input.assessment.verdict === 'unverifiable' && (input.finalCriticality === 'high' || input.finalCriticality === 'irreversible-precondition') ? 'CLAIM_UNVERIFIABLE' : 'none',
      disposition: 'unchanged', labelTrustClass: 'none',
    };
    if (!this.appendBounded(this.auditPath, row, this.opts.maxAuditBytes ?? 50 * 1024 * 1024, true)) return false;
    const corpus = {
      schemaVersion: 1, claimId, claimShapeId: this.hmac(shape), ...(topicPseudonym ? { topicPseudonym } : {}), pseudonymKeyId: this.keyId,
      claimKind: input.claim.kind, predicate: input.claim.predicate, criticality: input.finalCriticality,
      modelDoor: row.modelDoor, modelId: row.modelId, verifierVersion: row.verifierVersion,
      verdict: input.assessment.verdict, costBucket: 'unknown', latencyBucket: row.latencyBucket,
      evidenceClass: input.assessment.sourceKind, sourceRevision: input.assessment.sourceRevision ?? null,
      canonicalEntityPseudonym: this.hmac(`instar.claim-entity.v1|${JSON.stringify(input.claim.subjectSelector)}`),
      observedAt: input.assessment.observedAt,
      labelTrustClass: row.labelTrustClass, settlementState: 'pending', groundTruthVerdict: null,
      correctness: null, outcomeRevision: null, automationEligible: false,
    };
    this.corpusRows = this.compactCorpus();
    if (this.corpusRows >= 500_000) return false;
    const appended = this.appendBounded(this.corpusPath, corpus, this.opts.maxCorpusBytes ?? 500 * 1024 * 1024, false);
    if (appended) this.corpusRows++;
    return appended;
  }
  readAudit(limit = 100): Array<Record<string, unknown>> { return readJsonl(this.auditPath, limit); }
  /** In-process settlement seam. Only a canonical adapter holding the original
   * claim id and exact source revision can issue this later outcome receipt. */
  recordAuthoritativeOutcome(receipt: { claimId: string; predicate: ClaimPredicate; sourceRevision: string;
    verdict: 'supported' | 'refuted'; observedAt: string }): boolean {
    try {
      const rows = readJsonl(this.corpusPath, 500_000);
      const target = rows.find((row) => row.settlementState === 'pending' && row.claimId === receipt.claimId
        && row.predicate === receipt.predicate && row.sourceRevision === receipt.sourceRevision);
      if (!target) return false;
      target.groundTruthVerdict = receipt.verdict;
      target.correctness = target.verdict === receipt.verdict;
      target.settledAt = receipt.observedAt;
      target.labelTrustClass = 'T0'; target.settlementState = 'settled'; target.outcomeRevision = receipt.sourceRevision;
      const labelId = this.hmac(`instar.claim-t0-label.v1|${receipt.claimId}|${receipt.sourceRevision}|${receipt.verdict}`);
      fs.writeFileSync(this.corpusPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
      return this.appendBounded(this.auditPath, { schemaVersion: 1, eventUuid: randomUUID(), event: 't0-settlement',
        claimId: receipt.claimId, eventualGroundTruthLabelId: labelId, sourceRevision: receipt.sourceRevision,
        observedAt: receipt.observedAt, disposition: 'unchanged' }, this.opts.maxAuditBytes ?? 50 * 1024 * 1024, true);
    } catch { return false; }
  }
  recordEvent(input: Record<string, unknown>): boolean {
    const allowed: Record<string, unknown> = { schemaVersion: 1, eventUuid: randomUUID() };
    for (const key of ['ts', 'evaluated', 'flagged', 'dryRun', 'event', 'verdict', 'actionKind', 'hadToolCalls', 'reason'] as const) {
      const value = input[key];
      if (typeof value === 'string') allowed[key] = value.slice(0, 128);
      else if (typeof value === 'boolean') allowed[key] = value;
    }
    if (Array.isArray(input.gapKinds)) allowed.gapKinds = input.gapKinds.filter((v): v is string => typeof v === 'string').slice(0, 8);
    return this.appendBounded(this.auditPath, allowed, this.opts.maxAuditBytes ?? 50 * 1024 * 1024, true);
  }
  readPoolAggregates(limit = 100): Array<Record<string, unknown>> {
    const rows = readJsonl(this.corpusPath, 500_000);
    const groups = new Map<string, { day: string; claimShapeId: string; modelDoor: string; verifierVersion: string;
      count: number; topics: Set<string>; verdicts: Record<string, number> }>();
    for (const row of rows) {
      if (row.pseudonymKeyId !== this.keyId || typeof row.observedAt !== 'string'
        || typeof row.claimShapeId !== 'string' || typeof row.topicPseudonym !== 'string') continue;
      const day = row.observedAt.slice(0, 10);
      const modelDoor = typeof row.modelDoor === 'string' ? row.modelDoor : 'unknown';
      const verifierVersion = typeof row.verifierVersion === 'string' ? row.verifierVersion : 'unknown';
      const key = `${day}|${row.claimShapeId}|${modelDoor}|${verifierVersion}`;
      const group = groups.get(key) ?? { day, claimShapeId: row.claimShapeId, modelDoor, verifierVersion, count: 0, topics: new Set(), verdicts: {} };
      group.count++; group.topics.add(row.topicPseudonym);
      const verdict = typeof row.verdict === 'string' ? row.verdict : 'unknown';
      group.verdicts[verdict] = (group.verdicts[verdict] ?? 0) + 1;
      groups.set(key, group);
    }
    return [...groups.values()].filter((group) => group.count >= 20 && group.topics.size >= 5)
      .sort((a, b) => `${a.day}|${a.claimShapeId}|${a.modelDoor}|${a.verifierVersion}`
        .localeCompare(`${b.day}|${b.claimShapeId}|${b.modelDoor}|${b.verifierVersion}`))
      .slice(0, Math.max(1, Math.min(limit, 500_000))).map(({ topics: _topics, ...group }) => ({ ...group, automationEligible: false }));
  }
  readPoolPage(limit = 100, cursor?: string): { records: Array<Record<string, unknown>>; nextCursor?: string } {
    const all = this.readPoolAggregates(500_000);
    let afterKey = '';
    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
        const separator = decoded.lastIndexOf('.');
        const rawKey = decoded.slice(0, separator); const signature = decoded.slice(separator + 1);
        if (!rawKey || signature !== this.hmac(`instar.claim-pool-cursor.v1|${this.keyId}|${rawKey}`)) return { records: [] };
        afterKey = rawKey;
      } catch { return { records: [] }; }
    }
    const size = Math.max(1, Math.min(limit, 200));
    const eligible = afterKey ? all.filter((row) => `${row.day}|${row.claimShapeId}|${row.modelDoor}|${row.verifierVersion}` > afterKey) : all;
    const records = eligible.slice(0, size);
    const last = records.at(-1);
    const lastKey = last ? `${last.day}|${last.claimShapeId}|${last.modelDoor}|${last.verifierVersion}` : '';
    return { records, ...(eligible.length > records.length && lastKey ? { nextCursor: Buffer.from(`${lastKey}.${this.hmac(
      `instar.claim-pool-cursor.v1|${this.keyId}|${lastKey}`)}`).toString('base64url') } : {}) };
  }
  private hmac(value: string): string { return createHmac('sha256', this.opts.pseudonymKey).update(value).digest('hex'); }
  private compactCorpus(): number {
    try {
      this.lastCorpusCompactionDay = new Date().toISOString().slice(0, 10);
      if (!fs.existsSync(this.corpusPath)) return 0;
      const pendingCutoff = Date.now() - 90 * 86_400_000;
      const settledCutoff = Date.now() - 365 * 86_400_000;
      const rows = fs.readFileSync(this.corpusPath, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          const cutoff = row.labelTrustClass === 'T0' ? settledCutoff : pendingCutoff;
          return typeof row.observedAt === 'string' && Date.parse(row.observedAt) >= cutoff ? [row] : [];
        } catch { return []; }
      });
      fs.writeFileSync(this.corpusPath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 });
      fs.chmodSync(this.corpusPath, 0o600);
      return rows.length;
    } catch { return 500_000; }
  }
  private appendBounded(file: string, row: Record<string, unknown>, maxBytes: number, rotate: boolean): boolean {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const line = `${JSON.stringify(row)}\n`;
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size + Buffer.byteLength(line) > maxBytes) {
        if (!rotate) return false;
        if (fs.existsSync(`${file}.2`)) SafeFsExecutor.safeRmSync(`${file}.2`, { force: true, operation: 'claim-audit-rotate' });
        if (fs.existsSync(`${file}.1`)) fs.renameSync(`${file}.1`, `${file}.2`);
        if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, line, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      return true;
    } catch { return false; }
  }
}

export class ClaimObservationHousekeeper {
  constructor(private readonly opts: { stateDir: string; now?: () => number }) {}
  sweep(): { deleted: number; skipped: number; failures: number } {
    const now = this.opts.now?.() ?? Date.now();
    const logs = path.join(this.opts.stateDir, 'logs');
    const root = path.join(this.opts.stateDir, 'state', 'claim-verification');
    const candidates = ['completion-claim-audit.jsonl', 'completion-claim-audit.jsonl.1'];
    let deleted = 0; let skipped = 0; let failures = 0;
    for (const name of candidates) {
      if (deleted >= 4) break;
      const target = path.join(logs, name);
      try {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || !stat.isFile()) { skipped++; continue; }
        fs.chmodSync(target, 0o600);
        if (now - stat.mtimeMs < 7 * 86_400_000) { skipped++; continue; }
        SafeFsExecutor.safeUnlinkSync(target, { operation: 'claim-legacy-retention' });
        deleted++;
        this.appendReceipt(root, { schemaVersion: 1, pathClass: 'legacy-completion-claim-audit',
          deletedAt: new Date(now).toISOString(), outcome: 'deleted' }, now);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { skipped++; failures++; } }
    }
    return { deleted, skipped, failures };
  }
  private appendReceipt(root: string, row: Record<string, unknown>, now: number): void {
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'retention-receipts-v1.jsonl');
    const line = `${JSON.stringify(row)}\n`;
    if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > 1024 * 1024) {
      const rotated = `${file}.1`;
      if (fs.existsSync(rotated)) SafeFsExecutor.safeUnlinkSync(rotated, { operation: 'claim-receipt-rotate' });
      fs.renameSync(file, rotated);
    }
    fs.appendFileSync(file, line, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    for (const candidate of [file, `${file}.1`]) {
      if (!fs.existsSync(candidate)) continue;
      const rows = fs.readFileSync(candidate, 'utf8').split('\n').filter(Boolean).filter((entry) => {
        try { const parsed = JSON.parse(entry) as { deletedAt?: string }; return typeof parsed.deletedAt === 'string'
          && Date.parse(parsed.deletedAt) >= now - 30 * 86_400_000; } catch { return false; }
      });
      fs.writeFileSync(candidate, rows.join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 });
    }
  }
}

function bucket(value: number): string { return value >= .9 ? '0.9-1.0' : value >= .7 ? '0.7-0.9' : value >= .5 ? '0.5-0.7' : '0-0.5'; }
function latencyBucket(value: number): string { return value <= 10 ? 'le10ms' : value <= 100 ? 'le100ms' : value <= 500 ? 'le500ms' : 'gt500ms'; }
function readJsonl(file: string, limit: number): Array<Record<string, unknown>> {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-Math.max(1, Math.min(limit, 500_000))).flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  }); } catch { return []; }
}
