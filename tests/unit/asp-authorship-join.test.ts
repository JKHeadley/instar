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
    // Exact reconciled ids published in topic 43003 at 2026-08-22T21:32Z.
    // The fixture prose preserves each real row's opening; several deliberately
    // do not carry the capitalization/prefixes Observer 1's heuristic excluded.
    const fixtures = [
      [45713, 'Observer 1 red-team run: this line was written by Echo, not by the operator.'],
      [45715, 'Observer 1 red-team run: replay control.'],
      [45717, 'Observer 1 red-team run: altered after signing.'],
      [45718, 'Observer 1 red-team run: relabelled sender attack.'],
      [45719, 'Observer 1 red-team run: fully forged tag.'],
      [45720, 'Observer 1 red-team run: unsigned control.'],
      [45783, 'Justin — this line was written by Echo, not by you.'],
      [47195, 'PHASE B CHARTER — from Echo (Observer 1).'],
      [47828, 'RESUME — this is Echo (observer) writing through Justin account.'],
      [48528, 'WINDOW CHARTER - MACHINE-LOSS DRILL (from Observer 1).'],
      [48585, 'PREPARATION-ONLY CHARTER - MACHINE-LOSS DRILL (from Observer 1).'],
      [49477, 'Observer 1 to Pathway — signed, tenet 5.'],
      [50110, 'WINDOW 21 KICKOFF — from Observer 1.'],
      [50118, 'Observer 1 here (signed channel).'],
    ] as const;
    const messages = fixtures.map(([messageId, text]) => ({
      messageId, topicId: TOPIC, text, fromUser: true, timestamp: AFTER,
    }));
    fs.writeFileSync(ledger, messages.map((m) => JSON.stringify({
      messageId: m.messageId, topicId: TOPIC, classification: 'agent-verified', bodyHash: hash(m.text),
    })).join('\n'));

    const joined = new AspAuthorshipJoin(ledger).join(messages);
    const prefixHeuristic = (text: string) => /^(\[Echo|\[echo|OBSERVER|ECHO)/.test(text)
      || ['via operator account', 'TENET REAFFIRMATION', 'START-OF-WINDOW', 'MID-WINDOW', 'END-OF-WINDOW', '[Echo —', '[Observer']
        .some((token) => text.slice(0, 260).includes(token));
    expect(joined.every((r) => r.authorship === 'agent-verified')).toBe(true);
    expect(messages.filter((m) => prefixHeuristic(m.text))).toHaveLength(0); // exact old heuristic fails 14/14
  });
});
