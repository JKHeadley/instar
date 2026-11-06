import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { scanJsonlLog, SourceResolver, type LocalLookup, type PeerAnswer } from '../../../src/core/attribution/SourceResolver.js';
import type { SourceRef } from '../../../src/core/attribution/marker.js';

const ref: SourceRef = { channel: 'telegram', conversation: '1', message: '2', date: '2026-10-08' };
const row = { messageId: 2, topicId: 1, text: 'words' };
const miss = (retainedFrom: string | null = '2026-01-01'): LocalLookup => ({ row: null, retainedFrom });
const peer = (machine: string, lookup?: LocalLookup): PeerAnswer => ({ machine, answered: lookup !== undefined, lookup });
const make = (local: LocalLookup, peers: PeerAnswer[] = [], extra = {}) =>
  new SourceResolver({ machineName: 'studio', readLocal: async () => local, askPeers: async () => peers, ...extra });

describe('SourceResolver.resolve', () => {
  it('finds a local row without asking peers', async () => {
    const askPeers = vi.fn(async () => []);
    const result = await new SourceResolver({ machineName: 'studio', readLocal: async () => ({ row, retainedFrom: '2026-01-01' }), askPeers }).resolve(ref);
    expect(result).toMatchObject({ outcome: 'found', machine: 'studio' });
    expect(askPeers).not.toHaveBeenCalled();
  });

  it('finds a row on a peer and names the machine', async () => {
    const result = await make(miss(), [peer('mini', { row, retainedFrom: '2026-01-01' })]).resolve(ref);
    expect(result).toMatchObject({ outcome: 'found', machine: 'mini' });
  });

  it('calls it not-found only when every machine answered inside its retained range', async () => {
    expect((await make(miss(), [peer('mini', miss())]).resolve(ref)).outcome).toBe('not-found');
  });

  it('never calls a down machine a false citation', async () => {
    const result = await make(miss(), [peer('laptop')]).resolve(ref);
    expect(result).toMatchObject({ outcome: 'unreachable', failed: ['laptop'] });
  });

  it('treats a date older than a retained range as uncheckable, including a new machine', async () => {
    expect((await make(miss('2026-10-09')).resolve(ref)).outcome).toBe('unverifiable');
    expect((await make(miss(), [peer('new', miss('2026-11-01'))]).resolve(ref)).outcome).toBe('unverifiable');
  });

  it('treats an empty log as uncheckable', async () => {
    expect((await make(miss(null)).resolve(ref)).outcome).toBe('unverifiable');
  });

  it('treats a declared gap as uncheckable even with a machine down', async () => {
    const gaps = { recordGaps: [{ from: '2026-10-01', to: '2026-10-31' }] };
    expect((await make(miss(), [peer('laptop')], gaps).resolve(ref)).outcome).toBe('unverifiable');
  });

  it('answers from a pin as a copy once the row has gone', async () => {
    const result = await make(miss(), [], { readPin: () => row }).resolve(ref);
    expect(result).toMatchObject({ outcome: 'pinned-copy', row });
  });

  it('lets a deletion beat a pin and drops the pin, here and from a peer', async () => {
    const dropPin = vi.fn();
    const local = await make({ row: null, retainedFrom: null, removed: true }, [], { readPin: () => row, dropPin }).resolve(ref);
    expect(local.outcome).toBe('removed');
    const fromPeer = await make(miss(), [peer('mini', { row: null, retainedFrom: null, removed: true })], { readPin: () => row, dropPin }).resolve(ref);
    expect(fromPeer.outcome).toBe('removed');
    expect(dropPin).toHaveBeenCalledTimes(2);
  });

  it('answers peers from local data only', async () => {
    const askPeers = vi.fn(async () => []);
    await new SourceResolver({ machineName: 's', readLocal: async () => miss(), askPeers }).resolveLocal(ref);
    expect(askPeers).not.toHaveBeenCalled();
  });
});

describe('scanJsonlLog', () => {
  const write = (lines: string[]) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-scan-'));
    const file = path.join(dir, 'log.jsonl');
    fs.writeFileSync(file, lines.join('\n'));
    return file;
  };

  it('returns the matching row and the oldest date, skipping torn lines', async () => {
    const file = write(['{"torn', JSON.stringify({ messageId: 1, timestamp: '2026-08-26T01:00:00Z' }), JSON.stringify({ messageId: 2, timestamp: '2026-09-01T01:00:00Z' })]);
    const result = await scanJsonlLog(file, (r) => r.messageId === 2);
    expect(result.row).toMatchObject({ messageId: 2 });
    expect(result.retainedFrom).toBe('2026-08-26');
  });

  it('reports a miss with the range intact', async () => {
    const file = write([JSON.stringify({ messageId: 1, timestamp: '2026-08-26T01:00:00Z' })]);
    expect(await scanJsonlLog(file, () => false)).toEqual({ row: null, retainedFrom: '2026-08-26' });
  });

  it('reports an absent log as holding nothing', async () => {
    expect(await scanJsonlLog('/nonexistent/x.jsonl', () => true)).toEqual({ row: null, retainedFrom: null });
  });
});
