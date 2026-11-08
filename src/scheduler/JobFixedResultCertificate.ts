/** Exact, owner-reviewed fixed-result contracts. No certificate is inferred from config. */
import crypto from 'node:crypto';
import type { ParsedScriptRun } from './jobScriptProtocol.js';
import type { SupervisionAttempt } from './JobSupervisionStore.js';

export interface FixedResultCertificate {
  id: string;
  version: number;
  registryEpoch: number;
  slug: string;
  templateDigest: string;
  featureStateHash: string;
  result: 'success' | 'skipped';
  summary: string;
  reasonCode: string;
  fields: Record<string, string>;
  observedOutcomes: number;
  gradableOutcomes: number;
  confirmedMisses: number;
  /** Latest writer-accepted miss epoch for this exact contract that both reviewers considered. */
  reviewedMissEpoch: number;
  testEvidenceId: string;
  shadowEvidenceId: string;
  canaryAssertionId: string;
  canaryPassedAt: string;
  owner: string;
  reviewer: string;
  ownerSignature: string;
  reviewerSignature: string;
}

export interface FixedCertificateAuthority {
  /** The latest epoch from the pool authority; null means it cannot be read. */
  epoch: number | null;
  ownerPublicKeys: Readonly<Record<string, string>>;
  reviewerPublicKeys: Readonly<Record<string, string>>;
  activeIds: ReadonlySet<string>;
  revokedIds: ReadonlySet<string>;
  now: number;
}

/** The bounded, scrubbed subset needed to compare an exact result shape. */
export type FixedShapeObservation = Pick<ParsedScriptRun, 'result' | 'summary' | 'reasonCode' | 'fields'
  | 'missingResultLine' | 'overCap' | 'ignoredAnomalies' | 'anomalies' | 'droppedFields'>;

export type FixedCertificateDecision =
  | { kind: 'fixed'; certificateId: string }
  | { kind: 'judgment'; reason: string }
  | { kind: 'hold'; reason: string };

/** Canonical bytes signed by both independent principals. */
export function fixedCertificateBody(cert: FixedResultCertificate): string {
  const { ownerSignature: _ownerSignature, reviewerSignature: _reviewerSignature, ...body } = cert;
  return JSON.stringify({ ...body, fields: Object.fromEntries(Object.entries(body.fields).sort(([a], [b]) => a.localeCompare(b))) });
}

/** The exact semantic contract affected by a confirmed miss. */
export function fixedContractKey(cert: FixedResultCertificate): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    slug: cert.slug, templateDigest: cert.templateDigest,
    featureStateHash: cert.featureStateHash, result: cert.result,
    summary: cert.summary, reasonCode: cert.reasonCode,
    fields: Object.fromEntries(Object.entries(cert.fields).sort(([a], [b]) => a.localeCompare(b))),
  })).digest('hex');
}

export function signatureValid(body: string, signature: string, key: string | undefined): boolean {
  if (!key || !/^[A-Za-z0-9+/=]+$/.test(signature)) return false;
  try { return crypto.verify(null, Buffer.from(body), key, Buffer.from(signature, 'base64')); }
  catch { return false; /* @silent-fallback-ok — a signature parse failure denies fixed closure. */ }
}

/** Issuance check before the single pool writer activates a reviewed shape. */
export function fixedCertificateIssuanceValid(cert: FixedResultCertificate, input: {
  epoch: number; ownerPublicKeys: Readonly<Record<string, string>>;
  reviewerPublicKeys: Readonly<Record<string, string>>; now: number;
}): boolean {
  if (!cert || cert.version !== 1 || !Number.isSafeInteger(cert.registryEpoch)
    || !cert.id || !cert.slug || !cert.templateDigest || !cert.featureStateHash
    || cert.registryEpoch !== input.epoch || cert.owner === cert.reviewer
    || !cert.owner || !cert.reviewer || cert.observedOutcomes < 300
    || cert.gradableOutcomes < 300 || cert.confirmedMisses !== 0
    || !Number.isSafeInteger(cert.observedOutcomes) || !Number.isSafeInteger(cert.gradableOutcomes)
    || !Number.isSafeInteger(cert.confirmedMisses)
    || !Number.isSafeInteger(cert.reviewedMissEpoch) || cert.reviewedMissEpoch < 0
    || (cert.result !== 'success' && cert.result !== 'skipped')
    || typeof cert.summary !== 'string' || typeof cert.reasonCode !== 'string'
    || !cert.fields || typeof cert.fields !== 'object' || Array.isArray(cert.fields)
    || Object.values(cert.fields).some(value => typeof value !== 'string')
    || !cert.testEvidenceId || !cert.shadowEvidenceId || !cert.canaryAssertionId) return false;
  const canaryAge = input.now - Date.parse(cert.canaryPassedAt);
  if (!Number.isFinite(canaryAge) || canaryAge < 0 || canaryAge > 36 * 60 * 60_000) return false;
  const body = fixedCertificateBody(cert);
  return signatureValid(body, cert.ownerSignature, input.ownerPublicKeys[cert.owner])
    && signatureValid(body, cert.reviewerSignature, input.reviewerPublicKeys[cert.reviewer]);
}

export function decideFixedResult(input: {
  attempt: SupervisionAttempt;
  parsed: FixedShapeObservation;
  certificate: FixedResultCertificate | null;
  authority: FixedCertificateAuthority;
}): FixedCertificateDecision {
  const { attempt, parsed, certificate: cert, authority } = input;
  if (!cert) return { kind: 'judgment', reason: 'no-certificate' };
  if (authority.epoch === null) return { kind: 'hold', reason: 'registry-unreadable' };
  if (authority.revokedIds.has(cert.id)) return { kind: 'hold', reason: 'certificate-revoked' };
  if (cert.registryEpoch > authority.epoch || !authority.activeIds.has(cert.id)) {
    return { kind: 'hold', reason: 'stale-certificate' };
  }
  if (cert.owner === cert.reviewer || !cert.owner || !cert.reviewer) return { kind: 'hold', reason: 'reviewers-not-independent' };
  if (cert.version !== 1 || !Number.isSafeInteger(cert.registryEpoch)
    || (cert.result !== 'success' && cert.result !== 'skipped')
    || !cert.fields || typeof cert.fields !== 'object' || Array.isArray(cert.fields)
    || Object.values(cert.fields).some(value => typeof value !== 'string')) {
    return { kind: 'hold', reason: 'certificate-schema-invalid' };
  }
  const body = fixedCertificateBody(cert);
  if (!signatureValid(body, cert.ownerSignature, authority.ownerPublicKeys[cert.owner])
    || !signatureValid(body, cert.reviewerSignature, authority.reviewerPublicKeys[cert.reviewer])) {
    return { kind: 'hold', reason: 'certificate-signature-invalid' };
  }
  if (!Number.isSafeInteger(cert.observedOutcomes) || !Number.isSafeInteger(cert.gradableOutcomes)
    || !Number.isSafeInteger(cert.confirmedMisses)
    || cert.observedOutcomes < 300 || cert.gradableOutcomes < 300 || cert.confirmedMisses !== 0
    || !Number.isSafeInteger(cert.reviewedMissEpoch) || cert.reviewedMissEpoch < 0
    || !cert.testEvidenceId || !cert.shadowEvidenceId || !cert.canaryAssertionId) {
    return { kind: 'hold', reason: 'certificate-evidence-incomplete' };
  }
  const canaryAge = authority.now - Date.parse(cert.canaryPassedAt);
  if (!Number.isFinite(canaryAge) || canaryAge < 0 || canaryAge > 36 * 60 * 60_000) {
    return { kind: 'hold', reason: 'canary-stale' };
  }
  if (cert.slug !== attempt.slug || !attempt.templateDigest || !attempt.featureStateHash
    || cert.templateDigest !== attempt.templateDigest || cert.featureStateHash !== attempt.featureStateHash) {
    return { kind: 'hold', reason: 'run-snapshot-mismatch' };
  }
  if (parsed.result === 'failure' || parsed.missingResultLine || parsed.overCap || parsed.ignoredAnomalies > 0
    || parsed.anomalies.length > 0 || parsed.droppedFields > 0) {
    return { kind: 'judgment', reason: 'not-exact-routine-shape' };
  }
  if (parsed.result !== cert.result || parsed.summary !== cert.summary || parsed.reasonCode !== cert.reasonCode
    || JSON.stringify(Object.entries(parsed.fields).sort(([a], [b]) => a.localeCompare(b)))
      !== JSON.stringify(Object.entries(cert.fields).sort(([a], [b]) => a.localeCompare(b)))) {
    return { kind: 'judgment', reason: 'shape-changed' };
  }
  return { kind: 'fixed', certificateId: cert.id };
}
