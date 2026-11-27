/**
 * The People read and the notice pass. Spec: docs/specs/team-roles-and-access.md §3.10.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { mergeRows, readTeamPeople, runReachNotices, sanitizePeerRow, type PeerTarget } from '../../src/server/teamPeople.js';
import { ReachablePeople, type PersonRow } from '../../src/users/ReachablePeople.js';

const peer: PeerTarget = { machineId: 'm-peer', url: 'http://192.168.1.20:4040', kind: 'last-known-url' };
const answer = (status: number, body: unknown) => (async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;

describe('team people', () => {
  let dir: string;
  let slack: string[];
  let privacyOn: boolean;
  const people = () => new ReachablePeople({
    stateDir: dir, users: () => [], reachable: () => ({ slackAuthorizedIds: slack }), sharedMemoryPeople: () => [],
    privacyOn: () => privacyOn, ownerUserId: () => null, ownerName: () => 'Ann', phones: () => [],
  });
  const deps = (p: ReachablePeople, fetchImpl?: typeof fetch, peers: PeerTarget[] = [peer]) => ({
    people: p, selfMachineId: 'm-self', authToken: () => 't', peers: () => peers, fetchImpl,
  });

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-people-')); slack = ['U1']; privacyOn = false; });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/team-people.test.ts' }));

  it('re-validates a peer row, and an unknown tier reads as unknown', () => {
    expect(sanitizePeerRow({ key: 'k', name: 'N\u0007ame', tier: 'root', reach: [{ via: 'slack', detail: 'Slack' }, 'x'], sees: 's', relationship: 'boss' }))
      .toEqual({ key: 'k', name: 'N ame', tier: 'unknown', reach: [{ via: 'slack', detail: 'Slack' }], sees: 's', warnings: [] });
    expect(sanitizePeerRow({ name: 'no key' })).toBeNull();
    expect(sanitizePeerRow('x')).toBeNull();
  });

  it('merges one person seen on two machines', () => {
    const a: PersonRow = { key: 'k', name: 'Sam', tier: 'member', reach: [{ via: 'slack', detail: 'Slack' }], sees: '', warnings: ['w'] };
    const b: PersonRow = { ...a, reach: [{ via: 'phone', detail: 'Phone: X' }], warnings: ['w', 'v'] };
    const out = mergeRows([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].reach).toHaveLength(2);
    expect(out[0].warnings).toEqual(['w', 'v']);
  });

  it('answers locally without asking any peer', async () => {
    const r = await readTeamPeople(deps(people(), (() => { throw new Error('asked'); }) as never), 'local');
    expect(r.count).toBe(1);
    expect(r.pool).toBeUndefined();
  });

  it('a peer that does not answer marks the list incomplete and is named', async () => {
    const r = await readTeamPeople(deps(people(), answer(500, {})), 'pool');
    expect(r.pool).toEqual({ complete: false, failed: [{ machineId: 'm-peer', reason: 'http-500' }] });
  });

  it('counts a sender only a peer saw', async () => {
    const r = await readTeamPeople(deps(people(), answer(200, { people: [], observedKeys: ['slack:U9'] })), 'pool');
    expect(r.pool?.complete).toBe(true);
    expect(r.count).toBe(2);
  });

  it('refuses to send the token to a peer URL that is not allowed', async () => {
    const r = await readTeamPeople(deps(people(), (() => { throw new Error('asked'); }) as never, [{ ...peer, url: 'http://evil.example.com' }]), 'pool');
    expect(r.pool?.failed[0]).toEqual({ machineId: 'm-peer', reason: 'url-rejected' });
  });

  it('raises once on the lease holder, and not again at the same count', async () => {
    slack = ['U1', 'U2'];
    const p = people();
    const raised: string[] = [];
    const notice = { ...deps(p, answer(200, {}), []), holdsLease: () => true, raise: async (n: { conditionKey: string }) => { raised.push(n.conditionKey); return true; } };
    await runReachNotices(notice);
    await runReachNotices(notice);
    expect(raised).toEqual(['team:second-person']);
    p.observeSender('slack:U3');
    await runReachNotices(notice);
    expect(raised).toHaveLength(2);
  });

  it('retries when the item did not land', async () => {
    slack = ['U1', 'U2'];
    const p = people();
    let ok = false;
    const calls: boolean[] = [];
    const notice = { ...deps(p, answer(200, {}), []), holdsLease: () => true, raise: async () => { calls.push(ok); return ok; } };
    await runReachNotices(notice);
    ok = true;
    await runReachNotices(notice);
    await runReachNotices(notice);
    expect(calls).toEqual([false, true]);
  });

  it('a machine without the lease stays quiet', async () => {
    slack = ['U1', 'U2'];
    const raised: unknown[] = [];
    await runReachNotices({ ...deps(people(), answer(200, {}), []), holdsLease: () => false, raise: async (n) => { raised.push(n); return true; } });
    expect(raised).toEqual([]);
  });

  it('a failing pass never throws', async () => {
    await expect(runReachNotices({ ...deps(people()), holdsLease: () => { throw new Error('x'); }, raise: async () => true })).resolves.toEqual([]);
  });
});
