import { FeedbackDrainStore } from '../../src/feedback-factory/drain/FeedbackDrainStore.ts';

const [dbPath, hmacKey] = process.argv.slice(2);
const store = new FeedbackDrainStore({ dbPath, tokenHmacKey: hmacKey });
try {
  store.enqueue({
    clusterId: 'cluster-process', title: 'Concurrent cluster', summary: 'bounded summary', priority: 'normal',
    reportCount: 2, firstSeenAt: 1, lastSeenAt: 2, authorityRef: 'authority:1', evidenceRef: 'cluster:cluster-process',
  });
} finally {
  store.close();
}
