/** Read-only preview computation. All artifact bodies stay in the admitted
 * worker; the parent receives bounded counts and scrubbed project provenance.
 * A result is returned only after every artifact and the final EOF validate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CHUNK_BYTES } from '../core/appMediaTypes.js';
import { ImportedHistoryStore } from './ImportedHistoryStore.js';
import { localHistoryFirstClaimPlanDigest, type LocalHistoryFirstClaimSizing } from './LocalHistoryFirstClaimPlanBinding.js';
import type { LocalSourceIdentity } from './LocalSourceIdentity.js';
import { visitPreparedArtifacts, type LocalHistoryPreparedArtifactDescriptor } from './LocalHistoryPreparedArtifacts.js';

export interface LocalHistoryPreparedPreviewInput {
  stateDir: string;
  ownerUserId: string;
  descriptors: readonly LocalHistoryPreparedArtifactDescriptor[];
  maxArtifactBytes: number;
  includeFirstClaimPlan?: true;
}
export interface LocalHistoryPreparedPreviewFile {
  fileId: string;
  source: LocalHistoryPreparedArtifactDescriptor['source'];
  projectPath: string;
  messages: number;
  newMessages: number;
  redactions: number;
  destinationFingerprint: string | null;
}
export interface LocalHistoryPreparedPreview {
  files: LocalHistoryPreparedPreviewFile[];
  messages: number;
  newMessages: number;
  firstClaimPlan?: LocalHistoryFirstClaimSizing & { planDigest: string };
}

export async function readLocalHistoryPreparedPreview(input: LocalHistoryPreparedPreviewInput,
  body: AsyncIterable<Uint8Array>, onArtifactStart?: (index: number) => void): Promise<LocalHistoryPreparedPreview> {
  if (!input || typeof input !== 'object' || typeof input.stateDir !== 'string' || !path.isAbsolute(input.stateDir)
    || input.stateDir.includes('\0') || typeof input.ownerUserId !== 'string' || !input.ownerUserId.trim()
    || input.ownerUserId.includes('\0') || Buffer.byteLength(input.ownerUserId) > 256) throw new Error('local-history-preview-header');
  // A missing store is a fresh destination. A present but unsafe/incomplete
  // store is refused by the existing-only constructor; it is never repaired here.
  let store: ImportedHistoryStore | undefined;
  try { fs.lstatSync(path.join(input.stateDir, 'imported-history')); store = new ImportedHistoryStore(input.stateDir, { existingOnly: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // ENOENT inside a present store is not an absent store.
    if (fs.existsSync(path.join(input.stateDir, 'imported-history'))) throw error;
  }
  if (input.includeFirstClaimPlan && !store) throw new Error('local-history-claim-plan-existing-store-required');
  const read = async () => {
    let firstIdentity: LocalSourceIdentity | undefined;
    const result: LocalHistoryPreparedPreview = { files: [], messages: 0, newMessages: 0 };
    await visitPreparedArtifacts(body, input.descriptors, { maxArtifactBytes: input.maxArtifactBytes,
      onArtifactStart: (_descriptor, index) => onArtifactStart?.(index) }, (descriptor, proposal) => {
      const identity: LocalSourceIdentity = { ownerUserId: input.ownerUserId, source: descriptor.source,
        originalId: proposal.conversation.originalId, projectPath: proposal.projectPath,
        representation: proposal.representation, parserContractVersion: 1 };
      if (input.includeFirstClaimPlan) firstIdentity ??= identity;
      const destination = store?.inspectLocalDestination(identity);
      const messages = proposal.conversation.messages.length;
      const newMessages = destination ? proposal.conversation.messages.reduce((total, message) =>
        total + (destination.knownMessageKeys.has(message.key) ? 0 : 1), 0) : messages;
      result.files.push({ fileId: descriptor.fileId, source: descriptor.source, projectPath: proposal.projectPath,
        messages, newMessages, redactions: proposal.conversation.stats.redactions,
        destinationFingerprint: destination?.fingerprint ?? null });
      result.messages += messages; result.newMessages += newMessages;
      if (!Number.isSafeInteger(result.messages) || !Number.isSafeInteger(result.newMessages)
        || Buffer.byteLength(JSON.stringify(result)) > CHUNK_BYTES) throw new Error('local-history-preview-capacity');
    });
    if (input.includeFirstClaimPlan) {
      if (!store || !firstIdentity) throw new Error('local-history-claim-plan-existing-store-required');
      const plan = store.planSourceClaimWrite(firstIdentity);
      if (plan.allocationInput.kind !== 'source-claim') throw new Error('local-history-claim-plan-kind');
      const first = result.files[0];
      if (!first?.destinationFingerprint) throw new Error('local-history-claim-plan-destination');
      const sizing = {
        fileId: first.fileId,
        contentBytes: plan.contentBytes,
        databaseCeilingBytes: plan.allocationInput.databaseCeilingBytes,
        journalBytes: plan.allocationInput.journalBytes,
      };
      result.firstClaimPlan = { ...sizing, planDigest: localHistoryFirstClaimPlanDigest(
        input.ownerUserId, input.descriptors[0], first.destinationFingerprint, sizing,
      ) };
      if (Buffer.byteLength(JSON.stringify(result)) > CHUNK_BYTES) throw new Error('local-history-preview-capacity');
    }
    return result;
  };
  return store ? store.withWriter(read) : read();
}
