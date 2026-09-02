/**
 * AspAuthorshipJoin exposes the signing agent id ONLY on a verified verdict, so
 * a thread-history line can name the agent without ever naming one it could not
 * prove.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AspAuthorshipJoin } from '../../src/core/AspAuthorshipJoin.js';

const TOPIC = 52075;
const AFTER = '2026-09-02T07:00:00.000Z';
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

describe('AspAuthorshipJoin — authorshipAgentId', () => {
  it('rides a verified verdict and nothing else', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-join-agent-'));
    const ledger = path.join(dir, 'asp-classifications.jsonl');
    fs.writeFileSync(ledger, [
      { messageId: 1, topicId: TOPIC, classification: 'agent-verified', agentId: 'echo', bodyHash: hash('signed prose') },
      { messageId: 2, topicId: TOPIC, classification: 'rejected', agentId: 'echo', bodyHash: hash('replayed prose') },
      { messageId: 3, topicId: TOPIC, classification: 'human', agentId: null, bodyHash: hash('Justin prose') },
    ].map((r) => JSON.stringify(r)).join('\n'));

    const rows = new AspAuthorshipJoin(ledger).join([
      { messageId: 1, topicId: TOPIC, text: 'signed prose', fromUser: true, timestamp: AFTER },
      { messageId: 2, topicId: TOPIC, text: 'replayed prose', fromUser: true, timestamp: AFTER },
      { messageId: 3, topicId: TOPIC, text: 'Justin prose', fromUser: true, timestamp: AFTER },
      { messageId: 4, topicId: TOPIC, text: 'unresolved', fromUser: true, timestamp: AFTER },
      { messageId: 5, topicId: TOPIC, text: 'ours', fromUser: false, timestamp: AFTER },
    ]);
    expect(rows.map((r) => [r.authorship, r.authorshipAgentId])).toEqual([
      ['agent-verified', 'echo'],
      ['rejected', null],
      ['human', null],
      ['UNRESOLVED', null],
      ['agent-outbound', null],
    ]);
  });
});
