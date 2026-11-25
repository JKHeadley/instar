// E2E-PAIRING: EXEMPT — this verifier has no production evidence provider or route mount.
import { signerKeyHashOf, verifyMachineSignature, type MachineSignature } from '../core/AppRecordSignatures.js';
import { CLAUDE_CODE_FRAMEWORK } from '../core/frameworkFacts.js';
import { canonicalJson } from '../core/WorkCardStore.js';
import type { readLocalHistoryConsentSources } from './localHistoryConsentSlip.js';

type Resolver = Parameters<typeof readLocalHistoryConsentSources>[1];
type Destination = Parameters<Resolver>[1];
type Capture = NonNullable<ReturnType<Resolver>>;

export interface LocalHistoryCaptureProof {
  readonly proofId: string;
  readonly operationId: string;
  readonly destination: Destination;
  readonly sourceOwnerId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly files: Capture['files'];
  readonly signature: MachineSignature;
}

/** The source signer must sign this only after recording an authorized capture. */
export function localHistoryCaptureProofMessage(proof: Omit<LocalHistoryCaptureProof, 'signature'>,
  source: Pick<MachineSignature, 'machineId' | 'signerKeyHash'>): string {
  const { proofId, operationId, destination, sourceOwnerId, issuedAt, expiresAt, files } = proof;
  return 'instar-local-history-owner-capture-v1\n' + canonicalJson({
    proofId, operationId, destination, sourceOwnerId, issuedAt, expiresAt, files,
    machineId: source.machineId, signerKeyHash: source.signerKeyHash,
  });
}

const id = /^[a-f0-9]{32}$/;
const digest = /^[a-f0-9]{64}$/;
const opaque = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const fileId = /^[A-Za-z0-9_-]{1,128}$/;
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === 'string' && pattern.test(value);
const targetFields = ['machineId', 'machineKeyHash', 'agentId', 'ownerUserId', 'bootId', 'origin'] as const;

function sameDestination(expected: Destination, supplied: Destination): boolean {
  return supplied !== null && typeof supplied === 'object' && !Array.isArray(supplied)
    && Object.keys(supplied).length === targetFields.length
    && targetFields.every(field => Object.hasOwn(supplied, field) && supplied[field] === expected[field]);
}

/** Current authority is a server-owned lookup scoped to this proof and target.
 * It must independently verify active source enrollment, evidence revocation
 * and a current cross-home owner binding. An identity-key lookup alone cannot
 * establish that binding. No process-wide affirmative result is cached here. */
export function createLocalHistoryCaptureResolver(options: {
  loadProof(operationId: string, destination: Destination): LocalHistoryCaptureProof | undefined;
  currentAuthority(query: Readonly<{ proofId: string; operationId: string; destination: Destination;
    machineId: string; signerKeyHash: string; sourceOwnerId: string }>): { publicKeyPem: string; destinationOwnerId: string } | undefined;
  now?: () => number;
}): Resolver {
  return (operationId, destination) => {
    try {
      const proof = options.loadProof(operationId, destination);
      const now = (options.now ?? Date.now)();
      if (!proof || !matches(id, proof.proofId) || !matches(id, operationId) || operationId !== proof.operationId
        || !sameDestination(destination, proof.destination) || !matches(opaque, proof.sourceOwnerId)
        || !Number.isSafeInteger(now) || !Number.isSafeInteger(proof.issuedAt) || !Number.isSafeInteger(proof.expiresAt)
        || proof.issuedAt < 0 || proof.issuedAt > now || proof.expiresAt <= now) return undefined;
      const { signature, files } = proof;
      if (!signature || !matches(opaque, signature.machineId) || !matches(digest, signature.signerKeyHash)
        || typeof signature.sig !== 'string' || signature.sig.length > 128 || !Array.isArray(files)
        || files.length < 1 || files.length > 1024) return undefined;
      const selected = Array.from(files, file => {
        if (!file || !matches(fileId, file.fileId) || !matches(digest, file.captureDigest)
          || (file.kind !== 'codex' && file.kind !== CLAUDE_CODE_FRAMEWORK)) throw new Error('local-history-capture-file');
        return Object.freeze({ fileId: file.fileId, kind: file.kind, captureDigest: file.captureDigest });
      });
      if (new Set(selected.map(file => file.fileId)).size !== selected.length) return undefined;
      const message = localHistoryCaptureProofMessage({ ...proof, destination, files: selected }, signature);
      const authority = options.currentAuthority(Object.freeze({ proofId: proof.proofId, operationId, destination,
        machineId: signature.machineId, signerKeyHash: signature.signerKeyHash, sourceOwnerId: proof.sourceOwnerId }));
      if (!authority || authority.destinationOwnerId !== destination.ownerUserId
        || signerKeyHashOf(authority.publicKeyPem) !== signature.signerKeyHash
        || verifyMachineSignature(() => ({ status: 'ok', publicKeyPem: authority.publicKeyPem }), signature, message, proof.issuedAt) !== 'ok') {
        return undefined;
      }
      return Object.freeze({ operationId, ownerUserId: authority.destinationOwnerId,
        machineId: signature.machineId, files: Object.freeze(selected) });
    } catch { return undefined; } // @silent-fallback-ok — unreadable, malformed or unverifiable evidence confers no authority
  };
}
