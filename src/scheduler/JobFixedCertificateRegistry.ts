/** Signed pool snapshot for exact-result certificates. A replica is evidence,
 * never authority: a fixed closure requires a fresh response from the pinned
 * writer at the point of decision. */
import crypto from 'node:crypto';
import { verifyMachineSignature, type MachineKeyLookup, type MachineSignature,
  type MachineSigner } from '../core/AppRecordSignatures.js';
import { fixedCertificateIssuanceValid, type FixedCertificateAuthority, type FixedResultCertificate,
  FixedShapeObservation } from './JobFixedResultCertificate.js';

export interface FixedCertificateRegistrySnapshot {
  version: 1;
  authorityMachineId: string;
  epoch: number;
  issuedAt: string;
  certificates: FixedResultCertificate[];
  activeIds: string[];
  revokedIds: string[];
  ownerPublicKeys: Record<string, string>;
  reviewerPublicKeys: Record<string, string>;
  missEpochs: Record<string, number>;
  signature: MachineSignature;
}

type UnsignedSnapshot = Omit<FixedCertificateRegistrySnapshot, 'signature'>;

/** Canonical bytes are independent of array insertion order and object key order. */
export function fixedRegistryPayload(snapshot: UnsignedSnapshot): string {
  const ordered = (value: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return `instar-fixed-certificate-registry-v1\n${JSON.stringify({
    version: snapshot.version,
    authorityMachineId: snapshot.authorityMachineId,
    epoch: snapshot.epoch,
    issuedAt: snapshot.issuedAt,
    certificates: [...snapshot.certificates].sort((a, b) => a.id.localeCompare(b.id)).map(cert => ({
      ...cert, fields: ordered(cert.fields),
    })),
    activeIds: [...snapshot.activeIds].sort(),
    revokedIds: [...snapshot.revokedIds].sort(),
    ownerPublicKeys: ordered(snapshot.ownerPublicKeys),
    reviewerPublicKeys: ordered(snapshot.reviewerPublicKeys),
    missEpochs: Object.fromEntries(Object.entries(snapshot.missEpochs).sort(([a], [b]) => a.localeCompare(b))),
  })}`;
}

export function signFixedRegistrySnapshot(snapshot: UnsignedSnapshot, signer: MachineSigner): FixedCertificateRegistrySnapshot {
  if (signer.machineId() !== snapshot.authorityMachineId) throw new Error('fixed registry signer is not pinned authority');
  return { ...snapshot, signature: signer.sign(fixedRegistryPayload(snapshot)) };
}

export function verifyFixedRegistrySnapshot(snapshot: FixedCertificateRegistrySnapshot, input: {
  pinnedAuthorityMachineId: string;
  keyLookup: MachineKeyLookup;
  now: number;
  /** Highest authority epoch this reader has durably observed. */
  minimumEpoch: number;
  maxAgeMs?: number;
}): { authority: FixedCertificateAuthority; certificates: ReadonlyMap<string, FixedResultCertificate> } | null {
  const maxAgeMs = input.maxAgeMs ?? 5_000;
  if (snapshot.version !== 1 || snapshot.authorityMachineId !== input.pinnedAuthorityMachineId
    || snapshot.signature?.machineId !== input.pinnedAuthorityMachineId
    || !Number.isSafeInteger(snapshot.epoch) || snapshot.epoch < 0 || snapshot.epoch < input.minimumEpoch
    || !Number.isFinite(input.now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return null;
  const issuedAt = Date.parse(snapshot.issuedAt);
  if (!Number.isFinite(issuedAt) || issuedAt > input.now || input.now - issuedAt > maxAgeMs) return null;
  if (!Array.isArray(snapshot.certificates) || !Array.isArray(snapshot.activeIds) || !Array.isArray(snapshot.revokedIds)) return null;
  if (snapshot.certificates.length > 1000 || snapshot.activeIds.length > 1000 || snapshot.revokedIds.length > 1000
    || !snapshot.ownerPublicKeys || typeof snapshot.ownerPublicKeys !== 'object'
    || Array.isArray(snapshot.ownerPublicKeys) || !snapshot.reviewerPublicKeys
    || typeof snapshot.reviewerPublicKeys !== 'object' || Array.isArray(snapshot.reviewerPublicKeys)
    || !snapshot.missEpochs || typeof snapshot.missEpochs !== 'object' || Array.isArray(snapshot.missEpochs)
    || Object.keys(snapshot.missEpochs).length > 1000
    || Object.entries(snapshot.missEpochs).some(([key, epoch]) => !/^[0-9a-f]{64}$/.test(key)
      || !Number.isSafeInteger(epoch) || epoch < 1 || epoch > snapshot.epoch)) return null;
  const unique = (ids: string[]): boolean => ids.every(id => typeof id === 'string' && id.length > 0)
    && new Set(ids).size === ids.length;
  if (!unique(snapshot.activeIds) || !unique(snapshot.revokedIds)) return null;
  const active = new Set(snapshot.activeIds);
  const revoked = new Set(snapshot.revokedIds);
  if ([...active].some(id => revoked.has(id))) return null;
  const certificates = new Map<string, FixedResultCertificate>();
  for (const cert of snapshot.certificates) {
    if (!cert || typeof cert.id !== 'string' || certificates.has(cert.id)
      || !cert.fields || typeof cert.fields !== 'object' || Array.isArray(cert.fields)
      || Object.values(cert.fields).some(value => typeof value !== 'string')
      || typeof cert.slug !== 'string' || typeof cert.templateDigest !== 'string'
      || typeof cert.featureStateHash !== 'string' || typeof cert.summary !== 'string'
      || typeof cert.reasonCode !== 'string'
      || !Number.isSafeInteger(cert.registryEpoch) || cert.registryEpoch > snapshot.epoch) return null;
    certificates.set(cert.id, cert);
  }
  if ([...active, ...revoked].some(id => !certificates.has(id))) return null;
  let payload: string;
  try { payload = fixedRegistryPayload(snapshot); }
  catch { return null; /* @silent-fallback-ok — malformed signed state cannot grant fixed closure. */ }
  if (verifyMachineSignature(input.keyLookup, snapshot.signature, payload, issuedAt) !== 'ok') return null;
  return { authority: { epoch: snapshot.epoch, ownerPublicKeys: snapshot.ownerPublicKeys,
    reviewerPublicKeys: snapshot.reviewerPublicKeys, activeIds: active, revokedIds: revoked,
    now: input.now }, certificates };
}

/** Digest of registry STATE, excluding the freshness stamp on each read. */
export function fixedRegistryDigest(snapshot: FixedCertificateRegistrySnapshot): string {
  return crypto.createHash('sha256').update(fixedRegistryPayload({ ...snapshot, issuedAt: '' })).digest('hex');
}

/** Find the sole registered exact shape. Revoked entries remain candidates so
 * the decision gate sees revocation instead of treating the shape as novel. */
export function selectFixedCertificate(registry: {
  certificates: ReadonlyMap<string, FixedResultCertificate>;
  authority: FixedCertificateAuthority;
}, attempt: { slug: string; templateDigest: string | null; featureStateHash: string | null },
shape: FixedShapeObservation): { certificate: FixedResultCertificate | null; ambiguous: boolean } {
  const fields = JSON.stringify(Object.entries(shape.fields).sort(([a], [b]) => a.localeCompare(b)));
  const matching = [...registry.certificates.values()].filter(cert => cert.slug === attempt.slug
    && cert.templateDigest === attempt.templateDigest && cert.featureStateHash === attempt.featureStateHash
    && cert.result === shape.result && cert.summary === shape.summary
    && cert.reasonCode === shape.reasonCode
    && JSON.stringify(Object.entries(cert.fields).sort(([a], [b]) => a.localeCompare(b))) === fields);
  const active = matching.filter(cert => registry.authority.activeIds.has(cert.id));
  if (active.length > 1) return { certificate: null, ambiguous: true };
  if (active.length === 1) return { certificate: active[0], ambiguous: false };
  const revoked = matching.filter(cert => registry.authority.revokedIds.has(cert.id))
    .sort((a, b) => b.registryEpoch - a.registryEpoch);
  return { certificate: revoked[0] ?? null, ambiguous: false };
}

/** A revoked slug can return to script admission only when every revoked
 * shape has a newer reviewed replacement for the exact same shape, or a new
 * script template with a reviewed certificate for its current digest. */
export function fixedSlugRecertified(registry: {
  certificates: ReadonlyMap<string, FixedResultCertificate>;
  authority: FixedCertificateAuthority;
}, slug: string, currentTemplateDigest: string | null, currentFeatureStateHash: string | null): boolean {
  const revoked = [...registry.certificates.values()].filter(cert => cert.slug === slug
    && registry.authority.revokedIds.has(cert.id));
  if (revoked.length === 0) return false;
  const active = [...registry.certificates.values()].filter(cert => cert.slug === slug
    && registry.authority.activeIds.has(cert.id)
    && cert.templateDigest === currentTemplateDigest
    && cert.featureStateHash === currentFeatureStateHash
    && fixedCertificateIssuanceValid(cert, { epoch: cert.registryEpoch,
      ownerPublicKeys: registry.authority.ownerPublicKeys,
      reviewerPublicKeys: registry.authority.reviewerPublicKeys, now: registry.authority.now }));
  return revoked.every(old => active.some(next => next.registryEpoch > old.registryEpoch
    && (next.templateDigest !== old.templateDigest
      || (next.featureStateHash === old.featureStateHash
        && next.result === old.result && next.summary === old.summary
        && next.reasonCode === old.reasonCode
        && JSON.stringify(Object.entries(next.fields).sort(([a], [b]) => a.localeCompare(b)))
          === JSON.stringify(Object.entries(old.fields).sort(([a], [b]) => a.localeCompare(b)))))));
}
