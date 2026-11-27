/** Requests to the owner, in isolation (team-roles-and-access §3.3). */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TeamRequests, eventsMatchChange, parseRequestChange, requestSummary, type RequestChange } from '../../src/core/TeamRequests.js';
import { memorySessionAllows } from '../../src/server/memorySessionGuard.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'team-req-'));
const mia = { kind: 'person' as const, key: 'mia', label: 'Mia' };
const grant: RequestChange = { kind: 'grant', personKey: 'mia', ref: 'telegram:50', access: 'read' };

describe('TeamRequests', () => {
  it('survives a restart', () => {
    const d = dir();
    new TeamRequests(d).add(mia, grant, null, undefined);
    expect(new TeamRequests(d).open()).toHaveLength(1);
  });
  it('a request expires, and an expired one no longer blocks asking', () => {
    let t = 1_000_000;
    const r = new TeamRequests(dir(), () => t);
    expect(r.add(mia, grant, null, undefined).ok).toBe(true);
    t += 4 * 24 * 60 * 60 * 1000;
    expect(r.open()).toEqual([]);
    expect(r.add(mia, grant, null, undefined).ok).toBe(true);
  });
  it('an asked-for expiry cannot run past a week', () => {
    const t = 1_000_000;
    const r = new TeamRequests(dir(), () => t).add(mia, grant, null, new Date(t + 400 * 24 * 60 * 60 * 1000).toISOString());
    expect(r.ok && Date.parse(r.request.expiresAt)).toBe(t + 7 * 24 * 60 * 60 * 1000);
  });
  it('the agent may hold a few at once, up to a limit; a person one', () => {
    const r = new TeamRequests(dir());
    const agent = { kind: 'agent' as const, key: 'agent', label: 'The agent' };
    for (let i = 0; i < 20; i++) expect(r.add(agent, grant, null, undefined).ok).toBe(true);
    expect(r.add(agent, grant, null, undefined).ok).toBe(false);
    expect(r.add(mia, grant, null, undefined).ok).toBe(true);
    expect(r.add(mia, grant, null, undefined).ok).toBe(false);
  });
  it('a long reason is cut, and an unreadable file is an empty list', () => {
    const d = dir();
    const r = new TeamRequests(d).add(mia, grant, 'x'.repeat(900), undefined);
    expect(r.ok && r.request.reason?.length).toBe(280);
    fs.writeFileSync(path.join(d, 'state', 'team-access', 'requests.json'), 'not json');
    expect(new TeamRequests(d).open()).toEqual([]);
  });
});

describe('parseRequestChange', () => {
  it('takes the three typed changes', () => {
    expect(parseRequestChange(grant)).toEqual(grant);
    expect(parseRequestChange({ kind: 'role', personKey: 'p', role: 'guest' })).toMatchObject({ kind: 'role' });
    expect(parseRequestChange({ kind: 'invite', name: 'Bo', role: 'member' })).toMatchObject({ kind: 'invite' });
  });
  it('drops anything extra a request carries', () => {
    expect(parseRequestChange({ ...grant, role: 'owner', run: 'x' })).toEqual(grant);
  });
  it.each([[null], ['grant'], [{ kind: 'role', personKey: 'p', role: 'owner' }], [{ kind: 'role', personKey: 'p', role: 'admin' }], [{ kind: 'invite', name: '', role: 'member' }], [{ kind: 'grant', personKey: 'p', ref: 'r' }]])('refuses %j', (raw) => {
    expect(parseRequestChange(raw)).toBeNull();
  });
});

describe('eventsMatchChange', () => {
  const g = { type: 'grant' as const, personKey: 'mia', ref: 'telegram:50', access: 'read' as const };
  it('a grant must be that grant alone', () => {
    expect(eventsMatchChange(grant, [g])).toBe(true);
    expect(eventsMatchChange(grant, [{ ...g, access: 'use' }])).toBe(false);
    expect(eventsMatchChange(grant, [{ ...g, personKey: 'bo' }])).toBe(false);
    expect(eventsMatchChange(grant, [g, { ...g, ref: 'telegram:51' }])).toBe(false);
  });
  it('an invite allows what a first invite always carries, and nothing else', () => {
    const invite: RequestChange = { kind: 'invite', name: 'Bo', role: 'member' };
    const add = { type: 'person-add' as const, personKey: 'k', name: 'Bo', role: 'member' as const };
    expect(eventsMatchChange(invite, [{ type: 'team-on' }, { type: 'owner-pin', personKey: 'o' }, add])).toBe(true);
    expect(eventsMatchChange(invite, [add, g])).toBe(false);
    expect(eventsMatchChange(invite, [{ ...add, role: 'admin' as never }])).toBe(false);
  });
});

describe('requestSummary', () => {
  it('is built from typed fields, so a reason cannot change what it says', () => {
    const line = requestSummary({ requester: mia, change: grant }, () => 'Mia', () => 'Client work');
    expect(line).toBe('Mia asks to read Client work');
  });
  it('names the other person when someone asks on their behalf', () => {
    const agent = { kind: 'agent' as const, key: 'agent', label: 'The agent' };
    expect(requestSummary({ requester: agent, change: grant }, () => 'Mia', () => 'Client work')).toBe('The agent asks that Mia can read Client work');
  });
});

describe('a confined session', () => {
  const session = { sessionId: 's', audience: { kind: 'place' as const, placeKey: 'p' }, placeKey: 'p' };
  it('can ask', () => {
    expect(memorySessionAllows('POST', '/team/proposals', session as never)).toBe(true);
  });
  it('cannot see people or change access', () => {
    expect(memorySessionAllows('GET', '/team/people', session as never)).toBe(false);
    expect(memorySessionAllows('POST', '/team/people/x/lower', session as never)).toBe(false);
    expect(memorySessionAllows('GET', '/mobile/team/requests', session as never)).toBe(false);
  });
});
