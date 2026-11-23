/** Durable provenance for a local session. This describes source identity, not
 * permission to upload or copy. The caller must supply the actual stable owner
 * profile and parser-verified source fields under current admission. */
import { createHash } from 'node:crypto';
import { CHUNK_BYTES } from '../core/appMediaTypes.js';
import { CLAUDE_CODE_FRAMEWORK } from '../core/frameworkFacts.js';
import type { LocalSessionRepresentation, LocalSessionSource } from './localSessionParsers.js';

export interface LocalSourceIdentity {
  ownerUserId: string;
  source: LocalSessionSource;
  originalId: string;
  projectPath: string;
  representation: LocalSessionRepresentation;
  parserContractVersion: 1;
}
export interface LocalSourceClaim extends LocalSourceIdentity {
  version: 1;
  destinationId: string;
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

export function localSourceDestination(identity: Pick<LocalSourceIdentity, 'ownerUserId' | 'source' | 'originalId'>): string {
  const { ownerUserId, source, originalId } = identity;
  if (!text(ownerUserId) || !text(originalId) || (source !== 'codex' && source !== CLAUDE_CODE_FRAMEWORK)) {
    throw new Error('local-source-identity-invalid');
  }
  return 'local-v1-' + createHash('sha256').update(JSON.stringify([
    'instar-local-source-destination-v1', ownerUserId, source, originalId,
  ])).digest('hex');
}

export function createLocalSourceClaim(input: LocalSourceIdentity): Readonly<LocalSourceClaim> {
  const { ownerUserId, source, originalId, projectPath, representation, parserContractVersion } = input;
  const destinationId = localSourceDestination({ ownerUserId, source, originalId });
  if (!text(projectPath) || parserContractVersion !== 1
    || (source === 'codex' ? !['canonical', 'event-fallback'].includes(representation) : representation !== 'claude-records')) {
    throw new Error('local-source-identity-invalid');
  }
  const claim: LocalSourceClaim = { version: 1, ownerUserId, source, originalId, projectPath,
    representation, parserContractVersion, destinationId };
  if (Buffer.byteLength(JSON.stringify(claim)) > CHUNK_BYTES) throw new Error('local-source-identity-capacity');
  return Object.freeze(claim);
}

export function parseLocalSourceClaim(value: unknown): Readonly<LocalSourceClaim> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('unknown-source-identity');
  const row = value as Record<string, unknown>;
  const fields = ['version', 'ownerUserId', 'source', 'originalId', 'projectPath', 'representation', 'parserContractVersion', 'destinationId'];
  if (row.version !== 1 || Object.keys(row).length !== fields.length || Object.keys(row).some(key => !fields.includes(key))) {
    throw new Error('unknown-source-identity');
  }
  try {
    const claim = createLocalSourceClaim(row as unknown as LocalSourceIdentity);
    if (row.destinationId !== claim.destinationId) throw new Error();
    return claim;
  } catch { throw new Error('unknown-source-identity'); }
}
