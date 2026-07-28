import { FeedbackDrainStore, DrainConflictError } from '../../src/feedback-factory/drain/FeedbackDrainStore.ts';

const [dbPath, key, evidence] = process.argv.slice(2);
const store = new FeedbackDrainStore({ dbPath, tokenHmacKey: key });
try {
  store.approveReady({
    clusterId: 'cluster-race', approvalKey: 'same-approval-key', authorityId: 'authority', authorityGeneration: 1,
    evidenceHash: evidence, decisionNonce: 'decision-nonce-00000001', proposalSetHash: 'a'.repeat(64),
  });
} catch (error) {
  if (!(error instanceof DrainConflictError)) throw error;
} finally { store.close(); }
