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
    ], () => 'x');
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
