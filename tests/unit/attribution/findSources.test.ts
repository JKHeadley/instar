import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttributionJudge } from '../../../src/core/attribution/AttributionJudge.js';
import { ChannelReaders } from '../../../src/core/attribution/channelReaders.js';
import { findSources, searchWords } from '../../../src/core/attribution/findSources.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const row = { messageId: 5, topicId: 9, text: 'please never spawn on the laptop today', fromUser: true, telegramUserId: 42, forwarded: false, provenance: 'user', timestamp: '2026-10-08T00:00:00.000Z' };

describe('find', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-find-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/attribution/findSources.test.ts:cleanup' }); });
  const identity = (_c: string, id: string) => (id === '42' ? 'Justin' : null);
  const write = (rows: unknown[]) => fs.writeFileSync(path.join(dir, 'telegram-messages.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const judge = (reply: string) => new AttributionJudge({ evaluate: async () => reply });
  const deps = (reply: string, extra = {}) => ({ readers: new ChannelReaders({ stateDir: dir }), identity, machine: 'studio', judge: judge(reply), ...extra });

  it('picks distinctive words', () => {
    expect(searchWords('Justin said never spawn on the laptop', 'Justin')).toEqual(['spawn', 'laptop']);
  });

  it('suggests an eligible record the judge ranks, with its marker', async () => {
    write([row]);
    const result = await findSources(deps('{"ranked":[0]}'), { person: 'Justin', claim: 'never spawn on the laptop' });
    expect(result.note).toBe('found');
    expect(result.suggestions[0].marker).toBe('[source: telegram 9/5 2026-10-08]');
  });

  it('never suggests someone else\'s row, an agent post or a forward', async () => {
    write([{ ...row, telegramUserId: 7 }, { ...row, messageId: 6, provenance: 'agent' }, { ...row, messageId: 7, forwarded: true }]);
    const result = await findSources(deps('{"ranked":[0]}'), { person: 'Justin', claim: 'never spawn on the laptop' });
    expect(result).toMatchObject({ suggestions: [], note: 'no-literal-match' });
  });

  it('a miss is no-literal-match, and the judge is not asked', async () => {
    write([row]);
    const evaluate = vi.fn(async () => '{}');
    const result = await findSources({ ...deps(''), judge: new AttributionJudge({ evaluate }) }, { person: 'Justin', claim: 'something entirely different' });
    expect(result.note).toBe('no-literal-match');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('a model failure offers nothing and fails nothing', async () => {
    write([row]);
    const failing = new AttributionJudge({ evaluate: async () => { throw new Error('down'); } });
    expect((await findSources({ ...deps(''), judge: failing }, { person: 'Justin', claim: 'never spawn on the laptop' })).suggestions).toEqual([]);
  });

  it('reads peers through the same fan-out and says which did not answer', async () => {
    write([]);
    const remote = { ref: { channel: 'telegram', conversation: '9', message: '5', date: '2026-10-08' }, text: 'never spawn', marker: '[source: telegram 9/5 2026-10-08]', strength: 'verified', machine: 'mini' };
    const askPeers = vi.fn(async () => [{ machine: 'mini', answered: true, candidates: [remote] }, { machine: 'laptop', answered: false }]);
    const result = await findSources(deps('{"ranked":[0]}', { askPeers }), { person: 'Justin', claim: 'never spawn on the laptop' });
    expect(result.suggestions[0].machine).toBe('mini');
    expect(result.failed).toEqual(['laptop']);
  });

  it('searches through TopicMemory when it is up, then reads only those rows', async () => {
    write([row, { ...row, messageId: 6, text: 'other text entirely' }]);
    const search = vi.fn(() => [{ topicId: 9, messageId: 5, fromUser: true }]);
    const topicMemory = () => ({ isReady: () => true, search }) as never;
    const result = await findSources(deps('{"ranked":[0]}', { topicMemory }), { person: 'Justin', claim: 'never spawn on the laptop', around: { topicId: 9 } });
    expect(search).toHaveBeenCalledWith('spawn', { limit: 30, topicId: 9 });
    expect(result.suggestions).toHaveLength(1);
  });

  it('widens by the date a note names', async () => {
    write([row]);
    expect((await findSources(deps('{"ranked":[0]}'), { person: 'Justin', claim: 'never spawn', around: { date: '2026-01-01' } })).suggestions).toEqual([]);
    expect((await findSources(deps('{"ranked":[0]}'), { person: 'Justin', claim: 'never spawn', around: { date: '2026-10-20' } })).suggestions).toHaveLength(1);
  });
});
