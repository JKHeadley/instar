import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AspAuthorshipJoin } from '../../src/core/AspAuthorshipJoin.js';

const TOPIC = 43003;
const AFTER = '2026-08-22T21:32:10.808Z';

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('AspAuthorshipJoin', () => {
  it('joins all authority outcomes and keeps unresolved distinct from pre-layer history', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-join-'));
    const ledger = path.join(dir, 'asp-classifications.jsonl');
    fs.writeFileSync(ledger, [
      { messageId: 1, topicId: TOPIC, classification: 'agent-verified', bodyHash: hash('plain agent prose') },
      { messageId: 2, topicId: TOPIC, classification: 'human', bodyHash: hash('Justin prose') },
      { messageId: 3, topicId: TOPIC, classification: 'rejected', bodyHash: hash('forged prose') },
    ].map((r) => JSON.stringify(r)).join('\n'));

    const rows = new AspAuthorshipJoin(ledger).join([
      { messageId: 1, topicId: TOPIC, text: 'plain agent prose', fromUser: true, timestamp: AFTER },
      { messageId: 2, topicId: TOPIC, text: 'Justin prose', fromUser: true, timestamp: AFTER },
      { messageId: 3, topicId: TOPIC, text: 'forged prose', fromUser: true, timestamp: AFTER },
      { messageId: 4, topicId: TOPIC, text: 'missing verdict', fromUser: true, timestamp: AFTER },
      { messageId: 5, topicId: TOPIC, text: 'old', fromUser: true, timestamp: '2026-08-15T00:00:00Z' },
      { messageId: 6, topicId: TOPIC, text: 'normal outbound', fromUser: false, timestamp: AFTER },
    ]);

    expect(rows.map((r) => r.authorship)).toEqual([
      'agent-verified', 'human', 'rejected', 'UNRESOLVED', 'unclassifiable', 'agent-outbound',
    ]);
  });

  it('fails a body-hash mismatch visibly instead of misjoining by id', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-join-'));
    const ledger = path.join(dir, 'asp-classifications.jsonl');
    fs.writeFileSync(ledger, JSON.stringify({
      messageId: 7, topicId: TOPIC, classification: 'agent-verified', bodyHash: hash('original'),
    }) + '\n');
    const [row] = new AspAuthorshipJoin(ledger).join([
      { messageId: 7, topicId: TOPIC, text: 'altered', fromUser: true, timestamp: AFTER },
    ]);
    expect(row.authorship).toBe('UNRESOLVED');
  });

  it('regression: ledger join catches 14 agent rows that a text-prefix heuristic misses', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-join-'));
    const ledger = path.join(dir, 'asp-classifications.jsonl');
    const ids = [48501, 48510, 48524, 48535, 48548, 48556, 48561, 48567, 48572, 48594, 48616, 48656, 48700, 48726];
    const messages = ids.map((messageId, i) => ({
      messageId, topicId: TOPIC, text: `ordinary sentence ${i}`, fromUser: true, timestamp: AFTER,
    }));
    fs.writeFileSync(ledger, messages.map((m) => JSON.stringify({
      messageId: m.messageId, topicId: TOPIC, classification: 'agent-verified', bodyHash: hash(m.text),
    })).join('\n'));

    const joined = new AspAuthorshipJoin(ledger).join(messages);
    const prefixHeuristic = (text: string) => /^(ECHO|OBSERVER|UPDATE|ACK)/.test(text);
    expect(joined.every((r) => r.authorship === 'agent-verified')).toBe(true);
    expect(messages.filter((m) => prefixHeuristic(m.text))).toHaveLength(0); // negative control
  });
});
