/** The ledger: epoch fence, replication, hash binding, split (docs/specs/ecosystem-idea-pipeline.md §4). */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EcosystemLedger, ideaIdFor, recordHash, validateEvent } from '../../../src/ecosystem/EcosystemLedger.js';
import { buildEcosystemRecordData, ecosystemRecordStoreSchema, deriveEcosystemRecordKey } from '../../../src/ecosystem/EcosystemIdeasReplicatedStore.js';
import { EpochFencedError, type Sighting } from '../../../src/ecosystem/types.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-ledger-')); dirs.push(d); return new EcosystemLedger({ dir: d, machineId: () => 'm1' }); };
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/ecosystem/ecosystem-ledger.test.ts' }); });
const sighting = (id: string, commit: string, claim = 'a claim'): Sighting => ({ sightingId: id, project: 'o/p', commit, claim, evidence: [{ path: 'a', startLine: 1, endLine: 2 }], excerpts: [], maturity: 'prose-only', ageDays: 1, at: new Date().toISOString() });

describe('epoch fence', () => {
  it('refuses a write from an older epoch, and accepts the same or newer', () => {
    const l = mk();
    l.append('watchlist-add', { repo: 'a/b' }, 5);
    expect(() => l.append('watchlist-add', { repo: 'c/d' }, 4)).toThrow(EpochFencedError);
    expect(l.state().watchlist.has('c/d')).toBe(false);
    l.append('watchlist-add', { repo: 'e/f' }, 5);
    l.append('watchlist-add', { repo: 'g/h' }, 6);
    expect(l.state().watchlist.size).toBe(3);
  });
  it('a replicated event from a newer holder fences this machine too', () => {
    const a = mk(), b = mk();
    const ev = a.append('watchlist-add', { repo: 'a/b' }, 9);
    expect(b.ingestReplicated(ev)).toBe('landed');
    expect(() => b.append('watchlist-add', { repo: 'x/y' }, 8)).toThrow(EpochFencedError);
  });
});

describe('durability and replication', () => {
  it('reloads its state from disk, and survives a corrupt line by counting it', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-ledger-')); dirs.push(d);
    const l = new EcosystemLedger({ dir: d, machineId: () => 'm' });
    l.append('sighting', { ideaId: 'i', sighting: sighting('s1', 'c1') }, 0);
    fs.appendFileSync(path.join(d, 'events.jsonl'), 'not json\n');
    const again = new EcosystemLedger({ dir: d, machineId: () => 'm' });
    expect(again.state().ideas.get('i')?.sightings).toHaveLength(1);
    expect(again.corruptLines).toBe(1);
  });
  it('lands a peer event once, and refuses an invalid one', () => {
    const a = mk(), b = mk();
    const ev = a.append('sighting', { ideaId: 'i', sighting: sighting('s1', 'c1') }, 0);
    expect(b.ingestReplicated(ev)).toBe('landed');
    expect(b.ingestReplicated(ev)).toBe('duplicate');
    expect(b.ingestReplicated({ eventId: 'x', kind: 'made-up', at: 'nope' })).toBe('invalid');
    expect(b.state().ideas.get('i')?.sightings).toHaveLength(1);
  });
  it('two machines holding the same events reach the same state', () => {
    const a = mk(), b = mk();
    const e1 = a.append('sighting', { ideaId: 'i', sighting: sighting('s1', 'c1') }, 0);
    const e2 = a.append('stage', { ideaId: 'i', revision: recordHash(a.state().ideas.get('i')!), stage: 'gap-first' }, 0);
    b.ingestReplicated(e2); b.ingestReplicated(e1);
    expect(b.state().ideas.get('i')?.stage).toBe(a.state().ideas.get('i')?.stage);
  });
  it('the wire record round-trips through the store schema; a tampered kind does not', () => {
    const a = mk();
    const ev = a.append('watchlist-add', { repo: 'a/b' }, 0);
    const data = buildEcosystemRecordData(ev)({ physical: 1, logical: 0, node: 'm' } as never, 'm');
    expect(data?.recordKey).toBe(deriveEcosystemRecordKey(ev.eventId));
    expect(ecosystemRecordStoreSchema.validate({ event: (data as { event: unknown }).event }, {} as never)).toEqual({ event: ev });
    expect(ecosystemRecordStoreSchema.validate({ event: { ...ev, kind: 'nope' } }, {} as never)).toBeNull();
  });
  it('scrubs a credential before it is saved', () => {
    const l = mk();
    const key = `ghp_${'b'.repeat(36)}`;
    l.append('watchlist-proposal', { repo: 'a/b', reason: `found ${key}` }, 0);
    expect(l.state().proposals.get('a/b')?.reason).not.toContain(key);
  });
});

describe('old holders and bad rows', () => {
  it('a stale write that replicates in after a newer epoch is left out of state', () => {
    const a = mk(), b = mk(), c = mk();
    b.append('watchlist-add', { repo: 'new/holder' }, 9);
    const stale = a.append('watchlist-add', { repo: 'old/holder' }, 3);
    for (const e of [...(b as unknown as { events: Map<string, unknown> }).events.values()]) c.ingestReplicated(e);
    c.ingestReplicated({ ...stale, seq: 99 });
    expect(c.state().watchlist.has('new/holder')).toBe(true);
    expect(c.state().watchlist.has('old/holder')).toBe(false);
  });
  it.each([
    ['run', {}], ['cursor', { project: 'p' }], ['cursor', { project: 'p', cursor: { filesDone: 123 } }], ['cursor', { project: 'p', cursor: { madeUp: 'x' } }],
    ['gap-read', { ideaId: 'i', which: 'first', read: { framework: 'a', verdict: 'adopt', effectClass: 'additive-dark', searchMode: 'hybrid', singleFamily: false, terms: [], citations: [] } }], ['sighting', { ideaId: 'i' }], ['stage', { ideaId: 'i', stage: 'nope' }],
    ['gap-read', { ideaId: 'i', which: 'first', read: {} }], ['goal-review', { ideaId: 'i', review: {} }], ['decision', { ideaId: 'i', decision: {} }], ['outcome', { ideaId: 'i', result: 'guess' }],
  ])('refuses a %s event with an incomplete payload, so reduction can trust what lands', (kind, data) => {
    const l = mk();
    expect(l.ingestReplicated({ eventId: 'e1', kind, seq: 1, at: new Date().toISOString(), epoch: 0, machineId: 'm', data })).toBe('invalid');
    expect(() => l.state()).not.toThrow();
  });
  it('a review event with no revision, or the wrong one, changes nothing', () => {
    const l = mk();
    l.append('sighting', { ideaId: 'i', sighting: sighting('s1', 'c1') }, 0);
    expect(() => l.append('stage', { ideaId: 'i', stage: 'done' }, 0)).toThrow(/invalid/);
    l.append('stage', { ideaId: 'i', revision: 'wrong', stage: 'done' }, 0);
    expect(l.state().ideas.get('i')?.stage).toBe('candidate');
  });
  it('a new sighting clears the old review, and an old decision is still in the log', () => {
    const l = mk();
    l.append('sighting', { ideaId: 'i', sighting: sighting('s1', 'c1') }, 0);
    l.append('stage', { ideaId: 'i', revision: recordHash(l.state().ideas.get('i')!), stage: 'done' }, 0);
    l.append('decision', { ideaId: 'i', decision: { action: 'lower-class', recordHash: 'h', at: 'x', by: 'operator', ref: 'r', effectClass: 'additive-dark' } }, 0);
    expect(l.state().ideas.get('i')?.classLoweredTo).toBe('additive-dark');
    l.append('sighting', { ideaId: 'i', sighting: sighting('s2', 'c2') }, 0);
    const idea = l.state().ideas.get('i')!;
    expect(idea).toMatchObject({ stage: 'candidate', verdict: null, goal: null, classLoweredTo: null });
    expect(idea.decisions).toHaveLength(1);
  });
});

describe('revisions and hash binding', () => {
  it('a later sighting changes the record hash, so a decision cannot be inherited', () => {
    const l = mk();
    l.append('sighting', { ideaId: 'i', sighting: sighting('s1', 'c1') }, 0);
    const h1 = recordHash(l.state().ideas.get('i')!);
    l.append('sighting', { ideaId: 'i', sighting: sighting('s2', 'c2') }, 0);
    expect(recordHash(l.state().ideas.get('i')!)).not.toBe(h1);
  });
  it('a split moves one sighting to a new idea and leaves both in the log', () => {
    const l = mk();
    l.append('sighting', { ideaId: 'i', sighting: sighting('s1', 'c1') }, 0);
    l.append('sighting', { ideaId: 'i', sighting: sighting('s2', 'c2', 'different') }, 0);
    l.append('split', { ideaId: 'i', sightingId: 's2', newIdeaId: 'j' }, 0);
    expect(l.state().ideas.get('i')?.sightings.map((s) => s.sightingId)).toEqual(['s1']);
    expect(l.state().ideas.get('j')?.sightings.map((s) => s.sightingId)).toEqual(['s2']);
    expect(l.eventCount()).toBe(3);
  });
  it('idea ids are stable across wording case and punctuation', () => {
    expect(ideaIdFor('o/p', 'A Real, Thing!')).toBe(ideaIdFor('o/p', 'a real thing'));
    expect(ideaIdFor('o/p', 'a')).not.toBe(ideaIdFor('o/q', 'a'));
  });
  it('rejects a repository name that is not one', () => {
    const l = mk();
    l.append('watchlist-add', { repo: '../../etc/passwd' }, 0);
    expect(l.state().watchlist.size).toBe(0);
    expect(validateEvent(null)).toBeNull();
  });
});
