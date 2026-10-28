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

export type FixedCertificateDecision =
  | { kind: 'fixed'; certificateId: string }
  | { kind: 'judgment'; reason: string }
  | { kind: 'hold'; reason: string };

/** Canonical bytes signed by both independent principals. */
export function fixedCertificateBody(cert: FixedResultCertificate): string {
  const { ownerSignature: _ownerSignature, reviewerSignature: _reviewerSignature, ...body } = cert;
  return JSON.stringify({ ...body, fields: Object.fromEntries(Object.entries(body.fields).sort(([a], [b]) => a.localeCompare(b))) });
}

function signatureValid(body: string, signature: string, key: string | undefined): boolean {
  if (!key || !/^[A-Za-z0-9+/=]+$/.test(signature)) return false;
  try { return crypto.verify(null, Buffer.from(body), key, Buffer.from(signature, 'base64')); }
  catch { return false; }
}

export function decideFixedResult(input: {
  attempt: SupervisionAttempt;
  parsed: ParsedScriptRun;
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
  const body = fixedCertificateBody(cert);
  if (!signatureValid(body, cert.ownerSignature, authority.ownerPublicKeys[cert.owner])
    || !signatureValid(body, cert.reviewerSignature, authority.reviewerPublicKeys[cert.reviewer])) {
    return { kind: 'hold', reason: 'certificate-signature-invalid' };
  }
  if (cert.observedOutcomes < 300 || cert.gradableOutcomes < 300 || cert.confirmedMisses !== 0
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
