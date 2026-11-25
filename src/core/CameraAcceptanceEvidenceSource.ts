import { z } from 'zod';
import type { CameraJournalScope } from './CameraAcceptanceJournalRecord.js';
import type { CameraOwnerEvidence } from './CameraOwnerAcceptance.js';
import { canonicalHash, canonicalJson } from './GraphWitnessTypes.js';

const token = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({ offset: true });
const grant = z.strictObject({
  id: token, phone: token, computer: token, access: token,
  expiresAt: timestamp.nullable(), revokedAt: timestamp.nullable(),
});
const trial = z.strictObject({
  before: z.array(grant).max(256), after: z.array(grant).max(256), visibleComputer: token.nullable(),
});
const evidenceRecord = z.strictObject({
  requestId: z.uuidv4(),
  principal: token,
  scopeDigest: digest,
  evidence: z.strictObject({
    candidate: token, phone: token, computer: token, expectedGrant: grant, observedAt: timestamp,
    redirected: z.boolean(), success: trial, cancellation: trial, expiry: trial, replay: trial,
  }),
  signature: z.string().regex(/^[A-Za-z0-9+/=_-]{1,1024}$/),
});

type CameraEvidenceRecord = z.infer<typeof evidenceRecord>;

export function parseCameraEvidenceRecord(input: unknown): CameraEvidenceRecord | null {
  const parsed = evidenceRecord.safeParse(input);
  return parsed.success ? parsed.data : null;
}

interface CameraEvidenceSourceDeps {
  /** Load a bounded, immutable artifact for this request from protected storage. */
  readProtected(requestId: string): Promise<unknown>;
  /** Verify the enrolled attester, actual trial challenge use and observation freshness relative to issuance. */
  verifyAttester(scope: CameraJournalScope, principal: string, text: string, signature: string): boolean;
}

export function cameraEvidenceSigningText(record: CameraEvidenceRecord): string {
  const { signature: _signature, ...body } = record;
  return `instar.camera-evidence.v1\n${canonicalJson(body)}`;
}

export function cameraAcceptanceEvidenceSource(deps: CameraEvidenceSourceDeps) {
  return async (scope: CameraJournalScope, principal: string, requestId: string): Promise<CameraOwnerEvidence | null> => {
    if (!z.uuidv4().safeParse(requestId).success || !token.safeParse(principal).success) return null;
    try {
      const record = parseCameraEvidenceRecord(await deps.readProtected(requestId));
      if (!record) return null;
      if (record.requestId !== requestId || record.principal !== principal || record.scopeDigest !== canonicalHash(scope)) return null;
      return deps.verifyAttester(scope, principal, cameraEvidenceSigningText(record), record.signature) === true
        ? record.evidence : null;
    } catch {
      // @silent-fallback-ok: unavailable or unverifiable protected evidence holds the receipt.
      return null;
    }
  };
}
