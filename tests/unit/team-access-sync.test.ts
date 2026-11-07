/** Two machines' logs exchanging rows must end up the same (team-roles-and-access, "Step 2b"). */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256Hex, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { TeamAccessLog, rowPayload, type RequestRow, type TeamAccessRow } from '../../src/core/TeamAccessLog.js';
import { pullFromPeers, shouldRefuseForStaleness } from '../../src/core/TeamAccessSync.js';

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
    expect(b.ingest([rows[0], forged])).toEqual({ added: 1, refused: 1 });
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
