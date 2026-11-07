/** Two machines' logs exchanging rows must end up the same (team-roles-and-access, "Step 2b"). */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256Hex, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { TeamAccessLog, rowPayload, type RequestRow, type TeamAccessRow } from '../../src/core/TeamAccessLog.js';
import { PeerHasNoLog, STRICT_STALENESS_MS, TeamAccessPuller, pullFromPeers, shouldRefuseForStaleness, type SyncPeer } from '../../src/core/TeamAccessSync.js';
import { findGaps } from '../../src/core/TeamAccessMerge.js';

const signerFor = (id: string): MachineSigner => ({
  machineId: () => id, signerKeyHash: () => `k-${id}`,
  sign: (payload) => ({ machineId: id, signerKeyHash: `k-${id}`, sig: sha256Hex(payload) }),
});
const verify = (row: TeamAccessRow) => {
  const { machineSig, ...rest } = row;
  return machineSig.sig === sha256Hex(rowPayload(rest as never)) ? 'verified' as const : 'failed' as const;
};
const machine = (id: string) => new TeamAccessLog({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), `team-sync-${id}-`)), signer: signerFor(id), verify });
const signed = (events: unknown[]): Pick<RequestRow, 'receivedAt' | 'signedOrigin' | 'receipt'> => {
  const body = Buffer.from(JSON.stringify({ events }));
  return {
    receivedAt: new Date().toISOString(),
    signedOrigin: { keyHash: 'owner-key', deviceId: 'd1', bodyB64: body.toString('base64'), bodySha256: sha256Hex(body) },
    receipt: { machineId: 'x', signerKeyHash: 'k', sig: crypto.randomBytes(4).toString('hex') },
  };
};
const bind = (log: TeamAccessLog) => log.appendMachineEvents([{ type: 'phone-bind', keyHash: 'owner-key', deviceId: 'd1', boundTo: 'owner' }]);
const start = (log: TeamAccessLog) => {
  bind(log);
  log.appendSignedRequest(signed([{ type: 'team-on' }, { type: 'owner-pin', personKey: 'o' }, { type: 'person-add', personKey: 'p', name: 'Mia', role: 'member' }]));
};
const sync = (a: TeamAccessLog, b: TeamAccessLog) => {
  b.ingest(a.rowsBeyond(b.vector()));
  a.ingest(b.rowsBeyond(a.vector()));
};
const view = (l: TeamAccessLog) => {
  const s = l.state();
  return JSON.stringify({ on: s.on, people: [...s.people.entries()].sort(), grants: [...s.grants].map(([k, v]) => [k, [...v].sort()]).sort() });
};

describe('two machines', () => {
  it('a row reaches the other machine, and a person exists there', () => {
    const a = machine('A'); const b = machine('B');
    start(a);
    expect(b.ingest(a.rowsBeyond(b.vector())).added).toBe(2);
    expect(b.state().people.get('p')?.name).toBe('Mia');
    expect(b.state().on).toBe(true);
  });

  it('sending the same rows twice changes nothing', () => {
    const a = machine('A'); const b = machine('B');
    start(a);
    b.ingest(a.rowsBeyond({}));
    expect(b.ingest(a.rowsBeyond({})).added).toBe(0);
    expect(b.allRows()).toHaveLength(2);
  });

  it('after a partition, both reach the same answer, and the removal wins', () => {
    const a = machine('A'); const b = machine('B');
    start(a);
    a.appendSignedRequest(signed([{ type: 'grant', personKey: 'p', ref: 'c', access: 'use' }]));
    sync(a, b);
    a.appendMachineEvents([{ type: 'lower', personKey: 'p', ref: 'c' }]); // removed on A
    b.appendSignedRequest(signed([{ type: 'grant', personKey: 'p', ref: 'c', access: 'use' }])); // re-granted on B, not knowing
    sync(a, b);
    expect(view(a)).toBe(view(b));
    expect(a.grantOf('p', 'c')).toBeNull();
  });

  it('a change made after seeing the other machine stands', () => {
    const a = machine('A'); const b = machine('B');
    start(a);
    a.appendSignedRequest(signed([{ type: 'grant', personKey: 'p', ref: 'c', access: 'use' }]));
    a.appendMachineEvents([{ type: 'lower', personKey: 'p', ref: 'c' }]);
    sync(a, b);
    b.appendSignedRequest(signed([{ type: 'grant', personKey: 'p', ref: 'c', access: 'read' }]));
    sync(a, b);
    expect(view(a)).toBe(view(b));
    expect(b.grantOf('p', 'c')).toBe('read');
  });

  it('a third machine can pass on rows from one that has gone to sleep', () => {
    const a = machine('A'); const b = machine('B'); const c = machine('C');
    start(a);
    b.ingest(a.rowsBeyond(b.vector()));
    c.ingest(b.rowsBeyond(c.vector())); // A is asleep; C hears from B
    expect(c.state().people.has('p')).toBe(true);
  });

  it('each machine numbers its own rows, and a reload keeps every row', () => {
    const a = machine('A'); const b = machine('B');
    start(a);
    b.ingest(a.rowsBeyond({}));
    const row = b.appendMachineEvents([{ type: 'conversation-own', ref: 'x', personKey: 'p' }]);
    expect(row.seq).toBe(1);
    const dir = (b as unknown as { dir: string }).dir;
    const again = new TeamAccessLog({ stateDir: path.resolve(dir, '..', '..'), signer: signerFor('B'), verify });
    expect(again.healthState()).toBe('ok');
    expect(again.allRows()).toHaveLength(3);
    expect(view(again)).toBe(view(b));
  });

  it('a forged row from a peer is refused and changes nothing', () => {
    const a = machine('A'); const b = machine('B');
    start(a);
    const rows = a.rowsBeyond({});
    const forged = { ...rows[1], machineSig: { ...rows[1].machineSig, sig: 'bad' } } as TeamAccessRow;
    expect(b.ingest([rows[0], forged])).toMatchObject({ added: 1, refused: 1 });
    expect(b.state().on).toBe(false);
  });

  it('any order of arrival gives the same state', () => {
    const a = machine('A'); const b = machine('B'); const c = machine('C');
    start(a);
    sync(a, b); sync(a, c);
    a.appendSignedRequest(signed([{ type: 'grant', personKey: 'p', ref: 'c', access: 'use' }]));
    b.appendSignedRequest(signed([{ type: 'grant', personKey: 'p', ref: 'c', access: 'read' }]));
    c.appendMachineEvents([{ type: 'lower', personKey: 'p', ref: 'd' }]);
    const x = machine('X'); const y = machine('Y');
    x.ingest(a.rowsBeyond({})); x.ingest(b.rowsBeyond({})); x.ingest(c.rowsBeyond({}));
    y.ingest(c.rowsBeyond({})); y.ingest(b.rowsBeyond({})); y.ingest(a.rowsBeyond({}));
    expect(view(x)).toBe(view(y));
    expect(x.grantOf('p', 'c')).toBe('read');
  });
});

describe('one machine', () => {
  it('stays exactly as it was: rows replay in order', () => {
    const a = machine('A');
    start(a);
    a.appendSignedRequest(signed([{ type: 'person-set', personKey: 'p', role: 'guest' }]));
    a.appendSignedRequest(signed([{ type: 'person-set', personKey: 'p', role: 'member' }]));
    expect(a.state().people.get('p')?.role).toBe('member');
  });
});

describe('pulling from peers', () => {
  const peerOf = (log: TeamAccessLog, id = 'P') => ({ machineId: id, fetchRows: async (have: Record<string, number>) => ({ rows: log.rowsBeyond(have), vector: log.vector() }) });
  const asleep = (id: string) => ({ machineId: id, fetchRows: async () => { throw new Error('no route'); } });

  it('fetches only what is missing, and a second pull brings nothing', async () => {
    const a = machine('A'); const b = machine('B');
    start(a);
    expect((await pullFromPeers(b, [peerOf(a)])).outcomes[0]).toMatchObject({ answered: true, added: 2 });
    expect((await pullFromPeers(b, [peerOf(a)])).outcomes[0]).toMatchObject({ answered: true, added: 0 });
  });

  it('a sleeping peer is not an error, and the others still answer', async () => {
    const a = machine('A'); const b = machine('B');
    start(a);
    const r = await pullFromPeers(b, [asleep('L'), peerOf(a)]);
    expect(r.anyAnswered).toBe(true);
    expect(r.outcomes.map((o) => o.answered)).toEqual([false, true]);
    expect(b.state().on).toBe(true);
  });

  it('nobody answering changes nothing', async () => {
    const b = machine('B');
    const r = await pullFromPeers(b, [asleep('L')]);
    expect(r).toMatchObject({ anyAnswered: false, lastAnsweredAt: null });
  });

  it('a peer\'s row whose key has not arrived waits, and counts once it can be placed', () => {
    let placed = false;
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'team-wait-'));
    const a = machine('A');
    start(a);
    const b = new TeamAccessLog({ stateDir: dirB, signer: signerFor('B'), verify: (r) => (r.kind === 'request' && !placed ? 'unknown' : verify(r)) });
    b.ingest(a.rowsBeyond({}));
    expect(b.state().on).toBe(false);
    const reopened = new TeamAccessLog({ stateDir: dirB, signer: signerFor('B'), verify: (r) => (r.kind === 'request' && !placed ? 'unknown' : verify(r)) });
    expect(reopened.healthState()).toBe('ok');
    placed = true;
    expect(b.state().on).toBe(true);
    expect(reopened.state().on).toBe(true);
  });

  it('this machine\'s own row it cannot place still reads as unreadable', () => {
    const a = machine('A');
    start(a);
    const dir = path.resolve((a as unknown as { dir: string }).dir, '..', '..');
    expect(new TeamAccessLog({ stateDir: dir, signer: signerFor('A'), verify: (r) => (r.kind === 'request' ? 'unknown' : verify(r)) }).healthState()).toBe('unreadable');
  });
});

describe('when a machine must refuse its team phones', () => {
  const t = 10_000_000;
  const min = 60_000;
  it('a closed lid refuses nobody: no evidence means no judgement', () => {
    expect(shouldRefuseForStaleness([{ machineId: 'L', lastEvidenceAt: t - 8 * 60 * min, firstUnansweredAt: t - 8 * 60 * min }], t)).toBe(false);
    expect(shouldRefuseForStaleness([{ machineId: 'L', lastEvidenceAt: null, firstUnansweredAt: t - 60 * min }], t)).toBe(false);
  });
  it('a lid opening after a night refuses nobody: the clock starts at the first unanswered pull', () => {
    expect(shouldRefuseForStaleness([{ machineId: 'L', lastEvidenceAt: t, firstUnansweredAt: t - min }], t)).toBe(false);
    expect(shouldRefuseForStaleness([{ machineId: 'L', lastEvidenceAt: t, firstUnansweredAt: null }], t)).toBe(false);
  });
  it('a peer known awake that stays unanswered past the bound does', () => {
    expect(shouldRefuseForStaleness([{ machineId: 'L', lastEvidenceAt: t - min, firstUnansweredAt: t - 16 * min }], t)).toBe(true);
  });
  it('no peers at all is fine', () => {
    expect(shouldRefuseForStaleness([], t)).toBe(false);
  });
});

describe('the confined list across machines', () => {
  const ready = (l: TeamAccessLog) => { l.ensureConfinedFile(); return l; };

  it('a conversation locked on one machine is locked on the other', () => {
    const a = ready(machine('A')); const b = machine('B');
    start(a);
    a.confine({ ref: 'telegram:50' });
    b.ingest(a.rowsBeyond({}));
    expect(b.isConfined('telegram:50')).toBe(true);
  });

  it('a grant locks its conversation even if the confine row has not arrived', () => {
    const a = ready(machine('A')); const b = machine('B');
    start(a);
    a.appendSignedRequest(signed([{ type: 'grant', personKey: 'p', ref: 'telegram:50', access: 'read' }]));
    b.ingest(a.rowsBeyond({}));
    expect(b.isConfined('telegram:50')).toBe(true);
  });

  it('a grant locks even when its row cannot be placed yet', () => {
    const a = ready(machine('A'));
    start(a);
    a.appendSignedRequest(signed([{ type: 'grant', personKey: 'p', ref: 'telegram:50', access: 'read' }]));
    const b = new TeamAccessLog({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'team-lock-')), signer: signerFor('B'), verify: (r) => (r.kind === 'request' ? 'unknown' : verify(r)) });
    b.ingest(a.rowsBeyond({}));
    expect(b.state().on).toBe(false);
    expect(b.isConfined('telegram:50')).toBe(true);
  });

  it('owned beats shared for one conversation, in either order of arrival', () => {
    const a = ready(machine('A')); const b = ready(machine('B'));
    a.confine({ ref: 'r', placeKey: 'app:r' });
    b.confine({ ref: 'r', placeKey: 'app:r', personKey: 'mia' });
    const x = ready(machine('X')); const y = ready(machine('Y'));
    x.ingest(a.rowsBeyond({})); x.ingest(b.rowsBeyond({}));
    y.ingest(b.rowsBeyond({})); y.ingest(a.rowsBeyond({}));
    expect(x.readConfined()).toEqual(y.readConfined());
    expect(x.readConfined()?.[0].personKey).toBe('mia');
  });

  it('a restore sweep stays on its own machine', () => {
    const a = ready(machine('A')); const b = machine('B');
    start(a);
    const dir = (a as unknown as { dir: string }).dir;
    fs.writeFileSync(path.join(dir, 'confined.json'), 'not json');
    a.restore({ teamRefs: [], allRefs: () => [{ ref: 'telegram:9' }] });
    b.ingest(a.rowsBeyond({}));
    expect(b.isConfined('telegram:9')).toBe(false);
  });

  it('2a entries are told to peers once', () => {
    const a = ready(machine('A'));
    const dir = (a as unknown as { dir: string }).dir;
    fs.writeFileSync(path.join(dir, 'confined.json'), JSON.stringify({ entries: [{ ref: 'telegram:50' }] }));
    a.appendMachineEvents([{ type: 'conversation-own', ref: 'x', personKey: 'p' }]);
    expect(a.backfillConfineRows()).toBe(1);
    expect(a.backfillConfineRows()).toBe(0);
  });
});

describe('what holds every team person', () => {
  const copyOf = (l: TeamAccessLog, id: string): TeamAccessLog => {
    const c = machine(id);
    c.ingest(l.allRows() as TeamAccessRow[]);
    return c;
  };
  const forkOf = (row: TeamAccessRow, at: string): TeamAccessRow => {
    const { machineSig: _s, ...rest } = row as TeamAccessRow & { at?: string };
    const next = { ...rest, at } as never;
    return { ...(next as object), machineSig: signerFor((row.origin as string)).sign(rowPayload(next)) } as TeamAccessRow;
  };

  it('two healthy machines hold nobody', () => {
    const a = machine('A'); const b = machine('B');
    start(a); sync(a, b);
    b.appendMachineEvents([{ type: 'lower', personKey: 'p', role: 'guest' }]);
    a.appendMachineEvents([{ type: 'confine', ref: 'c1' }]);
    sync(a, b);
    expect(a.gaps()).toEqual([]);
    expect(b.gaps()).toEqual([]);
  });

  it('a row missing from the middle of a machine\'s rows is a gap', () => {
    const a = machine('A'); const b = machine('B');
    start(a);
    a.appendMachineEvents([{ type: 'confine', ref: 'c1' }]);
    a.appendMachineEvents([{ type: 'confine', ref: 'c2' }]);
    b.appendMachineEvents([{ type: 'confine', ref: 'c3' }]);
    const rows = a.allRows() as TeamAccessRow[];
    b.ingest(rows.filter((r) => r !== rows[rows.length - 2]));
    expect(b.gaps().map((g) => g.kind)).toEqual(['chain-break']);
    b.ingest([rows[rows.length - 2]]);
    expect(b.gaps()).toEqual([]);
  });

  it('a machine that only has an earlier part of the rows is pending, not held', () => {
    const a = machine('A'); const b = machine('B');
    start(a);
    b.appendMachineEvents([{ type: 'confine', ref: 'c3' }]);
    b.ingest((a.allRows() as TeamAccessRow[]).slice(0, 1));
    expect(b.gaps()).toEqual([]);
  });

  it('two rows with one number are found through the hash, though the vectors match', () => {
    const a = machine('A');
    start(a);
    const b = copyOf(a, 'B'); const c = copyOf(a, 'C');
    b.appendMachineEvents([{ type: 'confine', ref: 'c3' }]);
    const last = a.appendMachineEvents([{ type: 'confine', ref: 'c1' }]);
    b.ingest([last]);
    c.ingest([forkOf(last, '2020-01-01T00:00:00.000Z')]);
    expect(b.vector()).toMatchObject(c.vector());
    expect(c.rowsBeyond(b.vector())).toHaveLength(0);
    b.ingest(c.rowsBeyond(b.vector(), b.heads()));
    expect(b.gaps().map((g) => g.kind)).toContain('fork');
  });

  it('only the owner\'s phone can settle a gap', () => {
    const a = machine('A'); const b = machine('B');
    start(a);
    a.appendMachineEvents([{ type: 'confine', ref: 'c1' }]);
    const [stream] = Object.keys(a.vector());
    const [origin, incarnation] = stream.split('/');
    const rows = a.allRows() as TeamAccessRow[];
    bind(b);
    b.ingest(rows.filter((r) => r !== rows[1]));
    expect(b.gaps()).toHaveLength(1);
    const forged = signed([{ type: 'origin-gone', machine: origin, incarnation, throughSeq: 1 }]);
    forged.signedOrigin = { ...forged.signedOrigin, keyHash: 'stranger' };
    b.appendSignedRequest(forged);
    expect(b.gaps()).toHaveLength(1);
    b.appendSignedRequest(signed([{ type: 'origin-gone', machine: origin, incarnation, throughSeq: 1 }]));
    expect(b.gaps()).toEqual([]);
  });

  it('a machine named gone starts a new stream when it hears of it', () => {
    const a = machine('A'); const b = machine('B');
    start(a); sync(a, b);
    const [stream] = Object.keys(a.vector());
    const [origin, incarnation] = stream.split('/');
    bind(b);
    b.appendSignedRequest(signed([{ type: 'origin-gone', machine: origin, incarnation, throughSeq: 1 }]));
    sync(b, a);
    const row = a.appendMachineEvents([{ type: 'confine', ref: 'c1' }]);
    expect(row.incarnation).not.toBe(incarnation);
    sync(a, b);
    expect(b.gaps()).toEqual([]);
  });

  it('a machine that finds a peer holds more of its own stream moves to a new one, and that holds everyone', () => {
    const a = machine('A'); const b = machine('B');
    start(a); sync(a, b);
    b.appendMachineEvents([{ type: 'confine', ref: 'c0' }]);
    sync(a, b);
    const dir = path.resolve((a as unknown as { dir: string }).dir);
    const before = (a.allRows() as TeamAccessRow[]).slice();
    const late = a.appendMachineEvents([{ type: 'confine', ref: 'c1' }]);
    sync(a, b);
    // a backup from before the last row
    const lastGood = (a as unknown as { lastGoodDir: string }).lastGoodDir;
    fs.renameSync(lastGood, `${lastGood}.set-aside`);
    fs.writeFileSync(path.join(dir, 'log.jsonl'), before.map((r) => `${JSON.stringify(r)}\n`).join(''));
    const back = new TeamAccessLog({ stateDir: path.resolve(dir, '..', '..'), signer: signerFor('A'), verify });
    back.ingest(b.rowsBeyond(back.vector()));
    const next = back.appendMachineEvents([{ type: 'confine', ref: 'c2' }]);
    expect(next.incarnation).not.toBe(late.incarnation);
    expect(back.gaps().map((g) => g.kind)).toContain('new-incarnation');
  });

  it('a row that cannot be placed yet holds, on several machines only', () => {
    let placed = false;
    const v = (r: TeamAccessRow) => (r.kind === 'machine' && !placed && r.origin === 'A' ? 'unknown' as const : verify(r));
    const a = machine('A');
    bind(a);
    const b = new TeamAccessLog({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'team-gap-')), signer: signerFor('B'), verify: v });
    expect(b.gaps()).toEqual([]);
    b.ingest(a.allRows() as TeamAccessRow[]);
    expect(b.gaps()).toEqual([]);
    bind(b);
    expect(b.gaps().map((g) => g.kind)).toEqual(['unplaced']);
    placed = true;
    b.ingest([]);
    expect(b.gaps()).toEqual([]);
  });

  it('rows from before chains are not a gap', () => {
    const merged = findGaps([
      { origin: 'A', incarnation: 'v1', seq: 1, prev: null, hash: 'h1', seen: {}, events: [] },
      { origin: 'A', incarnation: 'v1', seq: 2, prev: null, hash: 'h2', seen: {}, events: [] },
      { origin: 'A', incarnation: 'x', seq: 3, prev: 'anchor', hash: 'h3', seen: {}, events: [] },
    ]);
    expect(merged).toEqual([]);
  });
});

describe('the regular exchange', () => {
  const MIN = 60_000;
  const rig = (peer: Partial<SyncPeer> = {}) => {
    const clock = { now: 1_000_000 };
    const local = machine('A');
    start(local);
    const remote = machine('B');
    const seen: string[][] = [];
    const evidence: { at: number | null } = { at: null };
    const up = { yes: true };
    const puller = new TeamAccessPuller({
      log: () => local,
      peers: () => [{
        machineId: 'B',
        fetchRows: async (have, heads) => {
          if (!up.yes) throw new Error('no route');
          return { rows: remote.rowsBeyond(have, heads), vector: remote.vector() };
        },
        pushRows: async (rows) => { remote.ingest(rows); },
        ...peer,
      }],
      leaseEvidenceAt: () => evidence.at,
      afterIngest: (t) => { seen.push(t); },
      now: () => clock.now,
    });
    return { clock, local, remote, seen, evidence, up, puller };
  };

  it('refuses until the first exchange has finished, then serves', async () => {
    const { puller } = rig();
    expect(puller.refusing()).toBe(true);
    await puller.tick();
    expect(puller.refusing()).toBe(false);
    puller.noteWake();
    expect(puller.refusing()).toBe(true);
  });

  it('with no peers there is nothing to wait for', () => {
    const local = machine('A');
    expect(new TeamAccessPuller({ log: () => local, peers: () => [], afterIngest: () => undefined }).refusing()).toBe(false);
  });

  it('a first exchange nobody answers still lets the machine serve: a closed lid stops nothing', async () => {
    const { puller, up } = rig();
    up.yes = false;
    await puller.tick();
    expect(puller.refusing()).toBe(false);
  });

  it('a peer shown awake that does not answer for 15 minutes refuses, and an answer clears it', async () => {
    const { puller, up, evidence, clock } = rig();
    up.yes = false;
    for (let i = 0; i <= 15; i += 1) {
      evidence.at = clock.now;
      await puller.tick();
      if (i < 15) expect(puller.refusing()).toBe(false);
      clock.now += i < 15 ? MIN : 0;
    }
    expect(puller.refusing()).toBe(true);
    expect(puller.waitingOn()).toEqual(['B']);
    up.yes = true;
    await puller.tick();
    expect(puller.refusing()).toBe(false);
  });

  it('when the evidence lapses the wait starts over', async () => {
    const { puller, up, evidence, clock } = rig();
    up.yes = false;
    evidence.at = clock.now;
    await puller.tick();
    clock.now += 10 * MIN;
    await puller.tick();
    evidence.at = clock.now;
    await puller.tick();
    clock.now += 6 * MIN;
    evidence.at = clock.now;
    await puller.tick();
    expect(puller.refusing()).toBe(false);
  });

  it('a peer that pushes counts as answering, though it cannot be dialled', async () => {
    const { puller, up, evidence, clock } = rig();
    up.yes = false;
    evidence.at = clock.now;
    await puller.tick();
    clock.now += 16 * MIN;
    evidence.at = clock.now;
    expect(puller.refusing()).toBe(true);
    puller.noteInbound('B', true);
    expect(puller.refusing()).toBe(false);
  });

  it('a peer with no log route is not waited for', async () => {
    const { puller, evidence, clock } = rig({ fetchRows: async () => { throw new PeerHasNoLog('B'); } });
    evidence.at = clock.now;
    await puller.tick();
    clock.now += 16 * MIN;
    evidence.at = clock.now;
    await puller.tick();
    expect(puller.refusing()).toBe(false);
  });

  it('rows reach the peer by push, and a change here is reported with its conversation', async () => {
    const { puller, local, remote, seen } = rig();
    await puller.tick();
    expect(view(remote)).toBe(view(local));
    remote.appendSignedRequest(signed([{ type: 'grant', personKey: 'p', ref: 'c1', access: 'use' }]));
    await puller.tick();
    expect(seen.flat()).toContain('c1');
    remote.appendSignedRequest(signed([{ type: 'person-remove', personKey: 'p' }]));
    await puller.tick();
    expect(seen.at(-1)).toEqual(['c1']);
  });

  it('strict staleness refuses after a day with no peer answering, and only when turned on', async () => {
    const local = machine('A');
    start(local);
    let strict = false;
    const clock = { now: 1 };
    const p = new TeamAccessPuller({
      log: () => local, afterIngest: () => undefined, now: () => clock.now, strictStaleness: () => strict,
      peers: () => [{ machineId: 'B', fetchRows: async () => { throw new Error('no'); } }],
    });
    await p.tick();
    clock.now += STRICT_STALENESS_MS;
    expect(p.refusing()).toBe(false);
    strict = true;
    expect(p.refusing()).toBe(true);
  });

  it('nonsense from a peer is refused without harm', () => {
    const local = machine('A');
    start(local);
    const before = local.allRows().length;
    const r = local.ingest([null, {}, { seq: 'x' }, { seq: 1, kind: 'machine', events: [{ type: 'nope' }], machineSig: { sig: 's', machineId: 'B' } }, { seq: 1, kind: 'machine', events: [null], machineSig: { sig: 's', machineId: 'B' } }] as never);
    expect(r.refused).toBe(5);
    expect(local.allRows()).toHaveLength(before);
  });
});

describe('who may read a message', () => {
  const grantTo = (log: TeamAccessLog, ref = 'c1') => log.appendSignedRequest(signed([{ type: 'grant', personKey: 'p', ref, access: 'use' }]));

  it('a reply written by a machine that had not heard of the grant is held, and a later grant that saw it opens it', () => {
    const studio = machine('A'); const laptop = machine('B');
    start(studio); sync(studio, laptop);
    const stale = laptop.stampMessage('c1', 'agent')!;
    grantTo(studio);
    studio.noteMessage(stale); // the reply replicates after the grant
    expect(studio.mayRead('p', 'c1', stale, null)).toBe(false);
    grantTo(studio);
    expect(studio.mayRead('p', 'c1', stale, null)).toBe(true);
  });

  it('the answer is the same on both machines, whatever arrived when', () => {
    const studio = machine('A'); const laptop = machine('B');
    start(studio); sync(studio, laptop);
    const stale = laptop.stampMessage('c1', 'agent')!;
    grantTo(studio);
    sync(studio, laptop);
    expect(laptop.mayRead('p', 'c1', stale, null)).toBe(studio.mayRead('p', 'c1', stale, null));
    expect(laptop.mayRead('p', 'c1', stale, null)).toBe(false);
  });

  it('a message older than the grant is open, because the grant had seen it: a grant opens history', () => {
    const studio = machine('A');
    start(studio);
    const old = studio.stampMessage('c1', 'agent')!;
    grantTo(studio);
    expect(studio.mayRead('p', 'c1', old, null)).toBe(true);
  });

  it('a message written after a machine knew of the grant is open', () => {
    const studio = machine('A'); const laptop = machine('B');
    start(studio);
    grantTo(studio);
    sync(studio, laptop);
    laptop.releaseAccess('c1'); // its sessions have ended
    const fresh = laptop.stampMessage('c1', 'agent')!;
    expect(studio.mayRead('p', 'c1', fresh, null)).toBe(true);
  });

  it('an author always sees their own words, and no one else gets through on that', () => {
    const studio = machine('A'); const laptop = machine('B');
    start(studio); sync(studio, laptop);
    const stale = laptop.stampMessage('c1', 'operator')!;
    grantTo(studio);
    expect(studio.mayRead('p', 'c1', stale, 'p')).toBe(true);
    expect(studio.mayRead('p', 'c1', stale, 'someone-else')).toBe(false);
  });

  it('owning a conversation counts as a grant', () => {
    const studio = machine('A');
    start(studio);
    const old = studio.stampMessage('c9', 'agent')!;
    expect(studio.mayRead('p', 'c9', old, null)).toBe(false);
    studio.appendMachineEvents([{ type: 'conversation-own', ref: 'c9', personKey: 'p' }]);
    expect(studio.mayRead('p', 'c9', old, null)).toBe(true);
  });

  it('a grant for another conversation or another person opens nothing', () => {
    const studio = machine('A');
    start(studio);
    const old = studio.stampMessage('c1', 'agent')!;
    grantTo(studio, 'c2');
    expect(studio.mayRead('p', 'c1', old, null)).toBe(false);
    grantTo(studio);
    expect(studio.mayRead('q', 'c1', old, null)).toBe(false);
  });

  it('only the owner\'s phone opens anything, however the row is signed', () => {
    const studio = machine('A');
    start(studio);
    const old = studio.stampMessage('c1', 'agent')!;
    const forged = signed([{ type: 'grant', personKey: 'p', ref: 'c1', access: 'use' }]);
    forged.signedOrigin = { ...forged.signedOrigin, keyHash: 'stranger' };
    studio.appendSignedRequest(forged);
    expect(studio.mayRead('p', 'c1', old, null)).toBe(false);
  });

  it('a grant from a machine the owner declared gone opens nothing past the settled row', () => {
    const studio = machine('A'); const laptop = machine('B');
    start(studio); sync(studio, laptop);
    const old = studio.stampMessage('c1', 'agent')!;
    laptop.noteMessage(old);
    bind(laptop);
    const row = grantTo(laptop);
    sync(laptop, studio);
    expect(studio.mayRead('p', 'c1', old, null)).toBe(true);
    studio.appendSignedRequest(signed([{ type: 'origin-gone', machine: 'B', incarnation: row.incarnation as string, throughSeq: row.seq - 1 }]));
    expect(studio.mayRead('p', 'c1', old, null)).toBe(false);
  });

  it('a reply racing the end of its session keeps what the session knew, until the session has ended', () => {
    const studio = machine('A'); const laptop = machine('B');
    start(studio); sync(studio, laptop);
    const row = grantTo(studio);
    laptop.ingest(studio.rowsBeyond(laptop.vector()));
    const racing = laptop.stampMessage('c1', 'agent')!;
    expect(racing.access[`A/${row.incarnation}`]).toBeLessThan(row.seq);
    const person = laptop.stampMessage('c1', 'operator')!;
    expect(person.access[`A/${row.incarnation}`]).toBe(row.seq);
    laptop.releaseAccess('c1');
    expect(laptop.stampMessage('c1', 'agent')!.access[`A/${row.incarnation}`]).toBe(row.seq);
  });

  it('message numbers keep rising, and survive a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-msg-'));
    const a = new TeamAccessLog({ stateDir: dir, signer: signerFor('A'), verify });
    const one = a.stampMessage('c', 'agent')!;
    const two = a.stampMessage('c', 'agent')!;
    expect(two.seq).toBe(one.seq + 1);
    const again = new TeamAccessLog({ stateDir: dir, signer: signerFor('A'), verify });
    expect(again.stampMessage('c', 'agent')!.seq).toBe(two.seq + 1);
  });
});

describe('what a peer says about itself', () => {
  const rigFor = (standing: unknown, file?: string, opts: { vector?: Record<string, number> } = {}) => {
    const local = machine('A');
    return new TeamAccessPuller({
      log: () => local, afterIngest: () => undefined, standingFile: file,
      peers: () => [{ machineId: 'B', fetchRows: async () => ({ rows: [], vector: opts.vector ?? {}, standing: standing as never }) }],
    });
  };
  const good = { enforcement: 1, native: true, privacy: true };

  it('a sound peer blocks nothing', async () => {
    const p = rigFor(good);
    await p.tick();
    expect(p.belowFloor()).toEqual([]);
  });

  it('an old build, native off and privacy off each block, with the reason', async () => {
    for (const [standing, reason] of [[{ ...good, enforcement: 0 }, 'old-build'], [{ ...good, native: false }, 'native-off'], [{ ...good, privacy: false }, 'memory-privacy-off']] as const) {
      const p = rigFor(standing);
      await p.tick();
      expect(p.belowFloor()).toEqual([{ machineId: 'B', reason }]);
    }
  });

  it('a peer never heard from blocks nothing: a sleeping laptop must not stop a team', () => {
    expect(rigFor(good).belowFloor()).toEqual([]);
  });

  it('a build with no log route is below the floor', async () => {
    const local = machine('A');
    const p = new TeamAccessPuller({ log: () => local, afterIngest: () => undefined, peers: () => [{ machineId: 'B', fetchRows: async () => { throw new PeerHasNoLog('B'); } }] });
    await p.tick();
    expect(p.belowFloor()).toEqual([{ machineId: 'B', reason: 'old-build' }]);
  });

  it('what a peer last said survives a restart, so a sleeping machine stays known', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'team-floor-')), 'peers.json');
    await rigFor({ ...good, native: false }, file).tick();
    expect(rigFor(good, file).belowFloor()).toEqual([{ machineId: 'B', reason: 'native-off' }]);
  });

  it('a machine behind a reachable peer says so until it has caught up', async () => {
    const p = rigFor(good, undefined, { vector: { 'B/i1': 5 } });
    await p.tick();
    expect(p.behind()).toBe(true);
    expect((await rigAt(p))).toBe(true);
    const clean = rigFor(good);
    await clean.tick();
    expect(clean.behind()).toBe(false);
  });
});
const rigAt = async (p: TeamAccessPuller): Promise<boolean> => { await p.tick(); return p.behind(); };

describe('an event from a newer build', () => {
  const fromNewer = (log: TeamAccessLog) => log.appendMachineEvents([{ type: 'from-the-future', personKey: 'p' } as never]);

  it('is kept, survives a restart and holds, rather than losing the log', () => {
    const a = machine('A'); const b = machine('B');
    start(a); sync(a, b);
    b.appendMachineEvents([{ type: 'confine', ref: 'c1' }]);
    fromNewer(a);
    sync(a, b);
    expect(b.healthState()).toBe('ok');
    expect(b.gaps().map((g) => g.kind)).toEqual(['unplaced']);
    b.load();
    expect(b.healthState()).toBe('ok');
    expect(view(b)).toBe(view(a));
  });

  it('it changes nothing in the state', () => {
    const a = machine('A');
    start(a);
    const before = view(a);
    fromNewer(a);
    expect(view(a)).toBe(before);
  });
});

describe('a damaged machine', () => {
  const pair = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-dmg-'));
    const a = new TeamAccessLog({ stateDir: dir, signer: signerFor('A'), verify });
    const b = machine('B');
    start(a);
    a.appendMachineEvents([{ type: 'confine', ref: 'c1' }]);
    sync(a, b);
    b.appendMachineEvents([{ type: 'confine', ref: 'c2' }]);
    sync(a, b);
    const peers = [{ machineId: 'B', fetchRows: async (have: Record<string, number>) => ({ rows: b.rowsBeyond(have), vector: b.vector() }) }];
    return { a, b, peers, files: a as unknown as { logFile: string; confinedFile: string } };
  };

  it('with a damaged log rebuilds from a peer, keeps the locks, and tells of what it touched', async () => {
    const { a, b, peers, files } = pair();
    fs.writeFileSync(files.logFile, 'not json\n{}\n');
    a.load();
    expect(a.healthState()).toBe('unreadable');
    const touched: string[][] = [];
    await new TeamAccessPuller({ log: () => a, peers: () => peers, afterIngest: (t) => { touched.push(t); } }).tick();
    expect(a.healthState()).toBe('ok');
    expect(view(a)).toBe(view(b));
    expect(a.isConfined('c1')).toBe(true);
    expect(a.isConfined('c2')).toBe(true);
    expect(touched[0]).toEqual(expect.arrayContaining(['c1', 'c2']));
    expect(fs.readdirSync(path.dirname(files.logFile)).some((f) => f.startsWith('log.jsonl.damaged-'))).toBe(true);
  });

  it('with only its lock list lost gets that back too', async () => {
    const { a, peers, files } = pair();
    fs.writeFileSync(files.confinedFile, 'broken');
    expect(a.readConfined()).toBeNull();
    await new TeamAccessPuller({ log: () => a, peers: () => peers, afterIngest: () => undefined }).tick();
    expect(a.isConfined('c1')).toBe(true);
  });

  it('writes on a new stream, which holds until the owner settles it', async () => {
    const { a, b, peers, files } = pair();
    const old = a.currentIncarnation();
    fs.writeFileSync(files.logFile, 'not json\n{}\n');
    a.load();
    await new TeamAccessPuller({ log: () => a, peers: () => peers, afterIngest: () => undefined }).tick();
    expect(a.currentIncarnation()).not.toBe(old);
    a.appendMachineEvents([{ type: 'confine', ref: 'c3' }]);
    expect(a.gaps().map((g) => g.kind)).toContain('new-incarnation');
    a.appendSignedRequest(signed([{ type: 'origin-gone', machine: 'A', incarnation: old, throughSeq: 3 }]));
    expect(a.gaps()).toEqual([]);
    sync(a, b);
    expect(b.gaps()).toEqual([]);
  });

  it('with no peer answering stays damaged, for the owner\'s restore', async () => {
    const { a, files } = pair();
    fs.writeFileSync(files.logFile, 'not json\n{}\n');
    a.load();
    await new TeamAccessPuller({ log: () => a, afterIngest: () => undefined, peers: () => [{ machineId: 'B', fetchRows: async () => { throw new Error('no'); } }] }).tick();
    expect(a.healthState()).toBe('unreadable');
  });
});

describe('a machine that has only received rows', () => {
  it('has a log, and it survives a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-recv-'));
    const a = machine('A');
    start(a);
    const b = new TeamAccessLog({ stateDir: dir, signer: signerFor('B'), verify });
    expect(b.healthState()).toBe('absent');
    b.ingest(a.allRows() as TeamAccessRow[]);
    expect(b.healthState()).toBe('ok');
    expect(new TeamAccessLog({ stateDir: dir, signer: signerFor('B'), verify }).healthState()).toBe('ok');
  });
});

describe('what must survive a crash', () => {
  it('a lost message record starts a new stream, so an old grant cannot pass a reused number', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-seen-'));
    const a = new TeamAccessLog({ stateDir: dir, signer: signerFor('A'), verify });
    start(a);
    a.stampMessage('c', 'agent'); a.stampMessage('c', 'agent');
    a.appendSignedRequest(signed([{ type: 'grant', personKey: 'p', ref: 'c', access: 'use' }]));
    const file = path.join((a as unknown as { dir: string }).dir, 'message-seen.json');
    fs.writeFileSync(file, '{"torn');
    const back = new TeamAccessLog({ stateDir: dir, signer: signerFor('A'), verify });
    const stale = { ...back.stampMessage('c', 'agent')!, access: {} };
    expect(stale.seq).toBe(1);
    expect(back.mayRead('p', 'c', stale, null)).toBe(false);
  });

  it('what a session knew survives a restart, and its end is tried again until it works', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-frz-'));
    const studio = machine('A');
    start(studio);
    const b = new TeamAccessLog({ stateDir: dir, signer: signerFor('B'), verify });
    b.ingest(studio.allRows() as TeamAccessRow[]);
    b.releaseAccess('c1');
    const row = studio.appendSignedRequest(signed([{ type: 'grant', personKey: 'p', ref: 'c1', access: 'use' }]));
    b.ingest([row]);
    const back = new TeamAccessLog({ stateDir: dir, signer: signerFor('B'), verify });
    expect(back.pendingEnds()).toEqual(['c1']);
    expect(back.stampMessage('c1', 'agent')!.access[`A/${row.incarnation}`]).toBeLessThan(row.seq);
    const seen: string[][] = [];
    const p = new TeamAccessPuller({ log: () => back, peers: () => [], afterIngest: (t) => { seen.push(t); } });
    await p.tick();
    expect(seen).toEqual([['c1']]);
    back.releaseAccess('c1');
    await p.tick();
    expect(seen).toHaveLength(1);
  });

  it('a grant added after a read is counted at once, though answers are remembered', () => {
    const a = machine('A');
    start(a);
    const old = a.stampMessage('c1', 'agent')!;
    expect(a.mayRead('p', 'c1', old, null)).toBe(false);
    a.appendSignedRequest(signed([{ type: 'grant', personKey: 'p', ref: 'c1', access: 'use' }]));
    expect(a.mayRead('p', 'c1', old, null)).toBe(true);
  });
});

describe('what the access review found', () => {
  const twoWith = () => { const a = machine('A'); const b = machine('B'); start(a); sync(a, b); return { a, b }; };
  const files = (l: TeamAccessLog) => l as unknown as { logFile: string; confinedFile: string; lastGoodDir: string; dir: string };
  const pullerFor = (a: TeamAccessLog, b: TeamAccessLog) => new TeamAccessPuller({
    log: () => a, afterIngest: () => undefined,
    peers: () => [{ machineId: 'B', fetchRows: async (have, heads) => ({ rows: b.rowsBeyond(have, heads), vector: b.vector() }) }],
  });

  it('a torn lock list leaves a healthy log alone, so a removal only this machine holds stands', async () => {
    const { a, b } = twoWith();
    a.ensureConfinedFile();
    a.confine({ ref: 'c1' });
    a.appendMachineEvents([{ type: 'lower', personKey: 'p', remove: true }]);
    fs.writeFileSync(files(a).confinedFile, 'broken');
    const stream = a.currentIncarnation();
    await pullerFor(a, b).tick();
    expect(a.state().people.has('p')).toBe(false);
    expect(a.currentIncarnation()).toBe(stream);
    expect(a.isConfined('c1')).toBe(true);
    expect(fs.readdirSync(files(a).dir).some((f) => f.startsWith('log.jsonl.damaged-'))).toBe(false);
  });

  it('a damaged log keeps every row that still reads', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-salv-'));
    const a = new TeamAccessLog({ stateDir: dir, signer: signerFor('A'), verify });
    const b = machine('B');
    start(a); sync(a, b);
    a.appendMachineEvents([{ type: 'lower', personKey: 'p', remove: true }]);
    fs.appendFileSync(files(a).logFile, 'not json\n');
    if (fs.existsSync(files(a).lastGoodDir)) fs.renameSync(files(a).lastGoodDir, `${files(a).lastGoodDir}.aside`);
    a.load();
    expect(a.healthState()).toBe('unreadable');
    await pullerFor(a, b).tick();
    expect(a.healthState()).toBe('ok');
    expect(a.state().people.has('p')).toBe(false);
  });

  it('a rebuild never takes a lock away, even one no row ever told of', async () => {
    const { a, b } = twoWith();
    a.ensureConfinedFile();
    a.confine({ ref: 'c1' });
    const list = files(a).confinedFile;
    const entries = JSON.parse(fs.readFileSync(list, 'utf8'));
    const held = Array.isArray(entries) ? entries : entries.entries;
    held.push({ ref: 'swept' });
    fs.writeFileSync(list, JSON.stringify(Array.isArray(entries) ? held : { ...entries, entries: held }));
    expect(a.isConfined('swept')).toBe(true);
    fs.writeFileSync(files(a).logFile, 'not json\n{}\n');
    a.load();
    await pullerFor(a, b).tick();
    expect(a.isConfined('swept')).toBe(true);
  });

  it('naming a machine gone stops it being waited for or blocking, until it returns on a new stream', async () => {
    const { a, b } = twoWith();
    const clock = { now: 1_000_000 };
    let up = true;
    const p = new TeamAccessPuller({
      log: () => a, afterIngest: () => undefined, now: () => clock.now, leaseEvidenceAt: () => clock.now,
      peers: () => [{ machineId: 'B', fetchRows: async (have, heads) => { if (!up) throw new Error('no'); return { rows: b.rowsBeyond(have, heads), vector: b.vector(), standing: { enforcement: 0, native: true, privacy: true } }; } }],
    });
    await p.tick();
    expect(p.belowFloor()).toHaveLength(1);
    up = false;
    await p.tick();
    clock.now += 16 * 60_000;
    expect(p.refusing()).toBe(true);
    a.appendSignedRequest(signed([{ type: 'origin-gone', machine: 'B', incarnation: 'none', throughSeq: 0 }]));
    expect(p.refusing()).toBe(false);
    expect(p.belowFloor()).toEqual([]);
    const back = b.appendMachineEvents([{ type: 'confine', ref: 'c2' }]);
    a.ingest([back]);
    expect(a.isGone('B')).toBe(false);
    expect(p.belowFloor()).toHaveLength(1);
  });

  it('a restore keeps rows from every machine, though their numbers overlap', () => {
    const { a, b } = twoWith();
    b.appendMachineEvents([{ type: 'confine', ref: 'c1' }]);
    b.appendMachineEvents([{ type: 'lower', personKey: 'p', remove: true }]);
    sync(a, b);
    const before = a.allRows().length;
    fs.writeFileSync(files(a).confinedFile, 'broken');
    a.restore({ teamRefs: [], allRefs: () => [] });
    expect(a.allRows().length).toBeGreaterThanOrEqual(before);
    expect(a.state().people.has('p')).toBe(false);
  });

  it('a row refused on arrival comes again once it can be taken', () => {
    let refuseIt: string | null = null;
    const v = (r: TeamAccessRow) => (r.kind === 'machine' && r.events.some((e) => (e as { ref?: string }).ref === refuseIt) ? 'failed' as const : verify(r));
    const a = machine('A');
    start(a);
    const b = new TeamAccessLog({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'team-ref-')), signer: signerFor('B'), verify: v });
    bind(b);
    a.appendMachineEvents([{ type: 'confine', ref: 'c1' }]);
    a.appendMachineEvents([{ type: 'confine', ref: 'c2' }]);
    refuseIt = 'c1';
    b.ingest(a.rowsBeyond(b.unbroken()));
    expect(b.gaps().map((g) => g.kind)).toEqual(['chain-break']);
    refuseIt = null;
    b.ingest(a.rowsBeyond(b.unbroken(), b.heads()));
    expect(b.gaps()).toEqual([]);
  });

  it('a row no known machine signed is not taken in, and locks nothing', () => {
    const a = machine('A');
    start(a);
    const row = a.appendMachineEvents([{ type: 'confine', ref: 'owner-private' }]);
    const b = new TeamAccessLog({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'team-unk-')), signer: signerFor('B'), verify: () => 'unknown', machineSigned: () => false });
    expect(b.ingest([row]).refused).toBe(1);
    expect(b.allRows()).toHaveLength(0);
    expect(b.isConfined('owner-private')).not.toBe(true);
  });

  it('a team can be seen before its rows can be verified, for the lease', () => {
    const a = machine('A');
    start(a);
    const b = new TeamAccessLog({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'team-may-')), signer: signerFor('B'), verify: () => 'unknown' });
    b.ingest(a.allRows() as TeamAccessRow[]);
    expect(b.state().on).toBe(false);
    expect(b.mayHaveTeam()).toBe(true);
    expect(machine('C').mayHaveTeam()).toBe(false);
  });

  const lose = (log: TeamAccessLog) => { (log as unknown as { mintIncarnation(): string }).mintIncarnation(); };

  it('a new stream names the one before it, and settling that clears it, whatever the random names', () => {
    for (let i = 0; i < 12; i += 1) {
      const { a, b } = twoWith();
      bind(b);
      const old = a.currentIncarnation();
      const through = a.vector()[`A/${old}`];
      lose(a);
      a.appendMachineEvents([{ type: 'confine', ref: 'c1' }]);
      sync(a, b);
      const [gap] = b.gaps() as Array<{ incarnation: string; previous: string; throughSeq: number }>;
      expect(gap).toMatchObject({ incarnation: a.currentIncarnation(), previous: old, throughSeq: through });
      a.appendSignedRequest(signed([{ type: 'origin-gone', machine: 'A', incarnation: gap.previous, throughSeq: gap.throughSeq }]));
      expect(a.gaps()).toEqual([]);
    }
  });

  it('a second loss on a machine already settled once is still seen', () => {
    const { a } = twoWith();
    const first = a.currentIncarnation();
    lose(a);
    const b = machine('B');
    a.appendMachineEvents([{ type: 'confine', ref: 'c1' }]);
    a.appendSignedRequest(signed([{ type: 'origin-gone', machine: 'A', incarnation: first, throughSeq: 2 }]));
    bind(b); b.ingest(a.allRows() as TeamAccessRow[]);
    expect(b.gaps()).toEqual([]);
    lose(a);
    a.appendMachineEvents([{ type: 'confine', ref: 'c2' }]);
    b.ingest(a.allRows() as TeamAccessRow[]);
    expect(b.gaps().map((g) => g.kind)).toContain('new-incarnation');
  });

  it('a machine can lower a role but never raise one, on one machine or several', () => {
    const { a, b } = twoWith();
    a.appendSignedRequest(signed([{ type: 'person-set', personKey: 'p', role: 'guest' }]));
    sync(a, b);
    b.appendMachineEvents([{ type: 'lower', personKey: 'p', role: 'admin' as never }]);
    sync(a, b);
    expect(a.state().people.get('p')?.role).toBe('guest');
    const solo = machine('S');
    start(solo);
    solo.appendMachineEvents([{ type: 'lower', personKey: 'p', role: 'admin' as never }]);
    expect(solo.state().people.get('p')?.role).toBe('member');
    solo.appendMachineEvents([{ type: 'lower', personKey: 'p', role: 'guest' }]);
    expect(solo.state().people.get('p')?.role).toBe('guest');
  });

  it('a lower role from a machine named gone still counts: it narrows', () => {
    const { a, b } = twoWith();
    const row = b.appendMachineEvents([{ type: 'confine', ref: 'c0' }]);
    b.appendSignedRequest(signed([{ type: 'person-set', personKey: 'p', role: 'guest' }]));
    sync(a, b);
    a.appendSignedRequest(signed([{ type: 'origin-gone', machine: 'B', incarnation: row.incarnation as string, throughSeq: row.seq }]));
    expect(a.state().people.get('p')?.role).toBe('guest');
  });

  it('owned beats shared in the grants too, on every machine', () => {
    const { a, b } = twoWith();
    a.appendSignedRequest(signed([{ type: 'person-add', personKey: 'q', name: 'Bo', role: 'member' }]));
    sync(a, b);
    a.appendSignedRequest(signed([{ type: 'grant', personKey: 'p', ref: 'c1', access: 'use' }]));
    b.appendMachineEvents([{ type: 'conversation-own', ref: 'c1', personKey: 'q' }]);
    sync(a, b);
    for (const l of [a, b]) {
      expect(l.state().owned.get('c1')).toBe('q');
      expect(l.state().grants.get('p')?.has('c1') ?? false).toBe(false);
    }
  });

  it('ownership from a range the owner voided does not count', () => {
    const { a, b } = twoWith();
    const row = b.appendMachineEvents([{ type: 'confine', ref: 'c0' }]);
    b.appendMachineEvents([{ type: 'conversation-own', ref: 'c9', personKey: 'p' }]);
    sync(a, b);
    expect(a.state().owned.get('c9')).toBe('p');
    a.appendSignedRequest(signed([{ type: 'origin-gone', machine: 'B', incarnation: row.incarnation as string, throughSeq: row.seq }]));
    expect(a.state().owned.has('c9')).toBe(false);
  });

  it('two claims to one conversation settle the same way in either arrival order', () => {
    const { a, b } = twoWith();
    a.appendMachineEvents([{ type: 'conversation-own', ref: 'c1', personKey: 'p' }]);
    b.appendMachineEvents([{ type: 'conversation-own', ref: 'c1', personKey: 'q' }]);
    sync(a, b);
    expect(a.state().owned.get('c1')).toBe(b.state().owned.get('c1'));
  });

  it('only a verified removal counts as one', () => {
    const { a } = twoWith();
    expect(a.wasRemoved('p')).toBe(false);
    a.appendMachineEvents([{ type: 'lower', personKey: 'p', remove: true }]);
    expect(a.wasRemoved('p')).toBe(true);
  });
});

describe('what the second review found', () => {
  const files = (l: TeamAccessLog) => l as unknown as { logFile: string; confinedFile: string; lastGoodDir: string; dir: string };
  const peer = (b: TeamAccessLog, id = 'B') => ({ machineId: id, fetchRows: async (have: Record<string, number>, heads: Record<string, string>) => ({ rows: b.rowsBeyond(have, heads), vector: b.vector(), starts: b.starts() }), pushRows: async (rows: TeamAccessRow[]) => { b.ingest(rows); } });
  const pulling = (a: TeamAccessLog, ...peers: Array<ReturnType<typeof peer>>) => new TeamAccessPuller({ log: () => a, afterIngest: () => undefined, peers: () => peers });

  it('a repaired machine that later receives its own lost rows still boots healthy', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-boot-'));
    const open = () => new TeamAccessLog({ stateDir: dir, signer: signerFor('A'), verify });
    const a = open();
    const mini = machine('M'); const laptop = machine('L');
    start(a); sync(a, mini); sync(a, laptop);
    const lost = a.appendMachineEvents([{ type: 'confine', ref: 'c7' }]);
    laptop.ingest([lost]);
    fs.writeFileSync(files(a).logFile, 'not json\n{}\n');
    if (fs.existsSync(files(a).lastGoodDir)) fs.renameSync(files(a).lastGoodDir, `${files(a).lastGoodDir}.aside`);
    a.load();
    await pulling(a, peer(mini, 'M')).tick();
    a.appendMachineEvents([{ type: 'confine', ref: 'c8' }]);
    a.ingest(laptop.rowsBeyond(a.unbroken()));
    a.load();
    expect(a.healthState()).toBe('ok');
    expect(open().healthState()).toBe('ok');
  });

  it('a read that failed once does not cost a good log', async () => {
    let bad = true;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-once-'));
    const v = (r: TeamAccessRow) => (bad && r.kind === 'request' ? 'unknown' as const : verify(r));
    const seed = new TeamAccessLog({ stateDir: dir, signer: signerFor('A'), verify });
    start(seed);
    const a = new TeamAccessLog({ stateDir: dir, signer: signerFor('A'), verify: v });
    expect(a.healthState()).toBe('unreadable');
    bad = false;
    const stream = a.currentIncarnation();
    const b = machine('B');
    await pulling(a, peer(b)).tick();
    expect(a.healthState()).toBe('ok');
    expect(a.currentIncarnation()).toBe(stream);
  });

  it('a restore\'s sweep is not told to peers at a later boot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-swp-'));
    const open = () => new TeamAccessLog({ stateDir: dir, signer: signerFor('A'), verify });
    const a = open();
    start(a);
    a.ensureConfinedFile();
    a.backfillConfineRows();
    fs.writeFileSync(files(a).confinedFile, 'broken');
    fs.writeFileSync(files(a).logFile, 'not json\n{}\n');
    a.load();
    a.restore({ teamRefs: [], allRefs: () => [{ ref: 'swept' }] });
    expect(a.isConfined('swept')).toBe(true);
    const again = open();
    expect(again.backfillConfineRows()).toBe(0);
    expect(JSON.stringify(again.allRows())).not.toContain('swept');
  });

  it('what 2a confined is told once', () => {
    const a = machine('A');
    start(a);
    a.ensureConfinedFile();
    (a as unknown as { confineHere(e: { ref: string }): boolean }).confineHere({ ref: 'old' });
    expect(a.backfillConfineRows()).toBe(1);
    expect(a.backfillConfineRows()).toBe(0);
  });

  it('a peer that stopped answering does not keep this machine behind', async () => {
    const a = machine('A');
    let up = true;
    const p = new TeamAccessPuller({ log: () => a, afterIngest: () => undefined, peers: () => [{ machineId: 'B', fetchRows: async () => { if (!up) throw new Error('no'); return { rows: [], vector: { 'B/i': 5 } }; } }] });
    await p.tick();
    expect(p.behind()).toBe(true);
    up = false;
    await p.tick();
    expect(p.behind()).toBe(false);
  });

  it('a fork found by one machine reaches the other', async () => {
    const a = machine('A'); const b = machine('B');
    start(a); sync(a, b);
    bind(b);
    const row = a.appendMachineEvents([{ type: 'confine', ref: 'c1' }]);
    const next = a.appendMachineEvents([{ type: 'confine', ref: 'c2' }]);
    b.ingest([row, next]);
    const { machineSig: _s, ...rest } = row;
    const other = { ...rest, at: '2020-01-01T00:00:00.000Z' };
    const c = machine('C');
    c.ingest((a.allRows() as TeamAccessRow[]).filter((r) => r !== row && r !== next));
    bind(c);
    c.ingest([{ ...other, machineSig: signerFor('A').sign(rowPayload(other as never)) } as TeamAccessRow]);
    await pulling(c, peer(b)).tick();
    expect(c.gaps().map((g) => g.kind)).toContain('fork');
    expect(b.gaps().map((g) => g.kind)).toContain('fork');
  });

  it('a refused first row of a stream comes again', async () => {
    let refuse = true;
    const a = machine('A');
    const rows = [a.appendMachineEvents([{ type: 'confine', ref: 'first' }]), a.appendMachineEvents([{ type: 'confine', ref: 'second' }])];
    const b = new TeamAccessLog({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'team-head-')), signer: signerFor('B'), verify: (r) => (refuse && r === rows[0] ? 'failed' : verify(r)) });
    bind(b);
    b.ingest(rows);
    expect(b.allRows()).toHaveLength(2);
    refuse = false;
    await pulling(b, peer(a, 'A')).tick();
    expect(b.allRows()).toHaveLength(3);
  });

  it('naming a machine\'s stream covers its rows from before chains', () => {
    const a = machine('A');
    const b = machine('B');
    start(a); start(b);
    const row = b.allRows()[0] as TeamAccessRow;
    const { origin: _o, incarnation: _i, prev: _p, seen: _n, machineSig: _m, ...bare } = row as never as Record<string, unknown>;
    const old = { ...bare, seq: 9 };
    a.ingest([{ ...old, machineSig: signerFor('B').sign(rowPayload(old as never)) } as never]);
    a.ingest(b.allRows() as TeamAccessRow[]);
    a.appendSignedRequest(signed([{ type: 'origin-gone', machine: 'B', incarnation: b.currentIncarnation(), throughSeq: 0 }]));
    expect(a.isGone('B')).toBe(true);
  });

  it('an old team-off is not a removal of someone added since, or never held', () => {
    const a = machine('A');
    start(a);
    a.appendSignedRequest(signed([{ type: 'team-off' }]));
    expect(a.wasRemoved('p')).toBe(true);
    a.appendSignedRequest(signed([{ type: 'team-on' }, { type: 'person-add', personKey: 'n', name: 'New', role: 'member' }]));
    expect(a.wasRemoved('n')).toBe(false);
    expect(a.wasRemoved('never-here')).toBe(false);
    const forged = signed([{ type: 'person-remove', personKey: 'n' }]);
    forged.signedOrigin = { ...forged.signedOrigin, keyHash: 'stranger' };
    a.appendSignedRequest(forged);
    expect(a.wasRemoved('n')).toBe(false);
  });

  it('each row is verified once, however often it is asked about', () => {
    let calls = 0;
    const a = new TeamAccessLog({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'team-memo-')), signer: signerFor('A'), verify: (r) => { calls += 1; return verify(r); } });
    start(a);
    a.isGone('B');
    const after = calls;
    for (let i = 0; i < 20; i += 1) { a.isGone('B'); a.state(); a.mayRead('p', 'c', { origin: 'A', incarnation: 'i', seq: 1, access: {} }, null); }
    expect(calls - after).toBeLessThanOrEqual(0);
  });
});
