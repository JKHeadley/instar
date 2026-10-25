import fs from 'node:fs';
import path from 'node:path';
import { requiredBetweenWindowCorpusMismatches } from '../../src/core/BetweenWindowAdmissionGate.js';

export function writeAdmissionStore(stateDir: string): string {
  fs.mkdirSync(stateDir, { recursive: true });
  const rows = [
    { topicId: 43003, messageId: 1001, text: 'Observer 1 full-history receipt' },
    { topicId: 43003, messageId: 1002, text: 'Observer 2 full-history receipt' },
    { topicId: 43003, messageId: 1101, text: 'Observer 1 assessment' },
    { topicId: 43003, messageId: 1102, text: 'Observer 2 assessment' },
    { topicId: 29723, messageId: 2001, text: 'W26 start tenet reaffirmation receipt' },
    { topicId: 43003, messageId: 2002, text: 'W26 middle tenet reaffirmation receipt' },
    { topicId: 36966, messageId: 2003, text: 'W26 end tenet reaffirmation receipt' },
  ];
  const storePath = path.join(stateDir, 'telegram-messages.jsonl');
  fs.writeFileSync(storePath, rows.map((row) => JSON.stringify({
    ...row,
    fromUser: false,
    timestamp: '2026-08-25T18:30:00.000Z',
    sessionName: 'observer',
  })).join('\n'));
  return storePath;
}

function observerReceipt(observer: 'observer-1' | 'observer-2', messageId: number, assessmentId: number, messages: number, authors: number): Record<string, unknown> {
  return {
    observer,
    topicId: 43003,
    messageId,
    receipt: {
      historyScope: 'full-history',
      canonicalSource: { name: `${observer} full-history archive`, uri: `telegram-topic://${observer}/full-history` },
      canonicalStore: { type: 'telegram-jsonl', topicId: 43003, path: '.instar/telegram-messages.jsonl' },
      dateSpan: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-25T18:30:00.000Z' },
      population: { messages, authors },
      extractionContract: { rule: 'read complete topic history from canonical store; no window-only truncation' },
      dedupeContract: { rule: 'dedupe by topicId:messageId after source union' },
      semanticAuthorArtifact: {
        artifactId: `${observer}-semantic-authors-v1`,
        agentThroughOperatorRows: [
          { account: `${observer}-agent-account`, accountKind: 'agent', classifiedAs: 'agent-through-operator' },
        ],
        justinRows: [
          { account: 'Justin Headley', accountKind: 'operator', classifiedAs: 'justin' },
        ],
      },
      corpusHash: `sha256:${observer === 'observer-1' ? 'a'.repeat(64) : 'b'.repeat(64)}`,
      quotes: [
        { messageId, topicId: 43003, text: 'receipt quote exists in the store' },
      ],
      assessment: {
        status: 'posted',
        summary: `${observer} assessment posted`,
        storedMessageIds: [assessmentId],
      },
      storedMessageIds: [messageId, assessmentId],
    },
  };
}

export function validAdmissionPackage(): Record<string, unknown> {
  return {
    activation: 'charter',
    fullHistoryReceipts: [
      observerReceipt('observer-1', 1001, 1101, 2469, 137),
      observerReceipt('observer-2', 1002, 1102, 2809, 122),
    ],
    tenetReaffirmationReceipts: [
      { phase: 'start', topicId: 29723, messageId: 2001, receipt: { canonicalStore: 'topic 29723 store', corpusHash: `sha256:${'c'.repeat(64)}` } },
      { phase: 'middle', topicId: 43003, messageId: 2002, receipt: { canonicalStore: 'topic 43003 store', corpusHash: `sha256:${'d'.repeat(64)}` } },
      { phase: 'end', topicId: 36966, messageId: 2003, receipt: { canonicalStore: 'topic 36966 store', corpusHash: `sha256:${'e'.repeat(64)}` } },
    ],
    knownCorpusMismatches: requiredBetweenWindowCorpusMismatches(),
  };
}
