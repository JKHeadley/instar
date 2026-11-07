/**
 * The team access log and role map. Spec: docs/specs/team-roles-and-access.md §3.1, §3.3, §3.5, §4.1.
 * Both sides of every rule.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { sha256Hex, type MachineSigner } from '../../src/core/AppRecordSignatures.js';
import { foldRows, rowPayload, TeamAccessLog, type RequestRow, type TeamAccessRow } from '../../src/core/TeamAccessLog.js';
import { parseSignedEvents, validateMachineEvent, validateRequestEvent } from '../../src/core/TeamAccessEvents.js';
import { mayDoAsTeam, tierAtLeast, tierOfRole } from '../../src/permissions/TeamAccess.js';

const signer: MachineSigner = {
  machineId: () => 'm1', signerKeyHash: () => 'k1',
  sign: (payload) => ({ machineId: 'm1', signerKeyHash: 'k1', sig: sha256Hex(payload) }),
};
/** A test verdict: the machine signature must match this row's bytes. */
const verify = (row: TeamAccessRow) => {
  const { machineSig, ...rest } = row;
  return machineSig.sig === sha256Hex(rowPayload(rest as never)) ? 'verified' as const : 'failed' as const;
};

const signed = (events: unknown[], keyHash = 'owner-key') => {
  const body = Buffer.from(JSON.stringify({ events }));
  return {
    receivedAt: '2026-11-07T00:00:00.000Z',
    signedOrigin: { keyHash, deviceId: 'd1', bodyB64: body.toString('base64'), bodySha256: sha256Hex(body) },
  } as Pick<RequestRow, 'receivedAt' | 'signedOrigin'>;
};

describe('tiers', () => {
  it('projects every org role', () => {
    expect(['owner', 'admin', 'operator', 'contributor', 'member', 'guest'].map((r) => tierOfRole(r as never)))
      .toEqual(['owner', 'admin', 'member', 'member', 'member', 'guest']);
  });

  it('orders tiers', () => {
    expect(tierAtLeast('admin', 'member')).toBe(true);
    expect(tierAtLeast('member', 'admin')).toBe(false);
    expect(tierAtLeast('guest', 'guest')).toBe(true);
  });

  const none = { own: false, grant: null };
  it.each([
    ['member', 'read', { own: true, grant: null }, true],
    ['member', 'delete', { own: true, grant: null }, true],
    ['member', 'read', none, false],
    ['member', 'send', { own: false, grant: 'use' }, true],
    ['member', 'upload', { own: false, grant: 'use' }, true],
    ['member', 'rename', { own: false, grant: 'use' }, false],
    ['member', 'delete', { own: false, grant: 'use' }, false],
    ['member', 'purge', { own: false, grant: 'use' }, false],
    ['member', 'read', { own: false, grant: 'read' }, true],
    ['member', 'send', { own: false, grant: 'read' }, false],
    ['guest', 'read', { own: false, grant: 'read' }, true],
    ['guest', 'send', { own: false, grant: 'use' }, false],
    ['guest', 'read', { own: true, grant: null }, true],
    ['guest', 'send', { own: true, grant: null }, false],
    ['guest', 'read', none, false],
    ['admin', 'read', none, false],
    ['admin', 'send', { own: true, grant: null }, true],
  ] as const)('%s %s %j → %s', (tier, op, facts, want) => {
    expect(mayDoAsTeam(tier, op, facts)).toBe(want);
  });

  it('refuses an unknown operation', () => {
    expect(mayDoAsTeam('member', 'nonsense' as never, { own: true, grant: 'use' })).toBe(false);
  });
});

describe('events', () => {
  it('never gives the owner role', () => {
    expect(validateRequestEvent({ type: 'person-add', personKey: 'p', name: 'Sam', role: 'owner' })).toBeNull();
    expect(validateRequestEvent({ type: 'person-set', personKey: 'p', role: 'owner' })).toBeNull();
    expect(validateMachineEvent({ type: 'lower', personKey: 'p', role: 'owner' })).toBeNull();
    expect(validateRequestEvent({ type: 'person-add', personKey: 'p', name: 'Sam', role: 'member' })).not.toBeNull();
  });

  it('one bad event voids the request', () => {
    expect(parseSignedEvents({ events: [{ type: 'team-on' }, { type: 'nope' }] })).toBeNull();
    expect(parseSignedEvents({ events: [] })).toBeNull();
    expect(parseSignedEvents({})).toBeNull();
    expect(parseSignedEvents({ events: [{ type: 'team-on' }] })).toEqual([{ type: 'team-on' }]);
  });

  it('refuses an unknown access level', () => {
    expect(validateRequestEvent({ type: 'grant', personKey: 'p', ref: 'r', access: 'admin' })).toBeNull();
  });
});

describe('TeamAccessLog', () => {
  let dir: string;
  const open = () => new TeamAccessLog({ stateDir: dir, signer, verify });
  const logPath = () => path.join(dir, 'state', 'team-access', 'log.jsonl');
  const bindOwner = (log: TeamAccessLog) => log.appendMachineEvents([{ type: 'phone-bind', keyHash: 'owner-key', deviceId: 'd1', boundTo: 'owner' }]);

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-log-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/team-access-log.test.ts' }));

  it('a never-team agent has no files and reads as absent', () => {
    const log = open();
    expect(log.healthState()).toBe('absent');
    expect(fs.existsSync(path.join(dir, 'state', 'team-access'))).toBe(false);
    expect(log.readConfined()).toEqual([]);
    expect(log.state().on).toBe(false);
  });

  it('applies an owner request and folds events from the signed body only', () => {
    const log = open();
    bindOwner(log);
    log.appendSignedRequest(signed([{ type: 'team-on' }, { type: 'person-add', personKey: 'sam', name: 'Sam', role: 'member' }, { type: 'grant', personKey: 'sam', ref: 'telegram:7', access: 'read' }]));
    expect(log.state().on).toBe(true);
    expect(log.grantOf('sam', 'telegram:7')).toBe('read');
    expect(log.grantOf('sam', 'telegram:8')).toBeNull();
  });

  it('ignores a request whose key is not bound as the owner', () => {
    const log = open();
    log.appendMachineEvents([{ type: 'phone-bind', keyHash: 'msp-key', deviceId: 'd2', boundTo: 'msp' }]);
    log.appendSignedRequest(signed([{ type: 'team-on' }], 'msp-key'));
    expect(log.state().on).toBe(false);
  });

  it('reads standing at that point: a phone rebound later loses owner standing from then on', () => {
    const log = open();
    bindOwner(log);
    log.appendSignedRequest(signed([{ type: 'team-on' }]));
    log.appendMachineEvents([{ type: 'phone-bind', keyHash: 'owner-key', deviceId: 'd1', boundTo: 'msp' }]);
    log.appendSignedRequest(signed([{ type: 'team-off' }]));
    expect(log.state().on).toBe(true);
  });

  it('ignores a body that does not match its hash', () => {
    const log = open();
    bindOwner(log);
    const req = signed([{ type: 'team-on' }]);
    req.signedOrigin.bodySha256 = 'tampered';
    log.appendSignedRequest(req);
    expect(log.state().on).toBe(false);
  });

  it('a row that fails verification counts for nothing', () => {
    const log = open();
    bindOwner(log);
    log.appendSignedRequest(signed([{ type: 'team-on' }]));
    const lines = fs.readFileSync(logPath(), 'utf8').trim().split('\n');
    const row = JSON.parse(lines[1]);
    row.machineSig.sig = 'forged';
    fs.writeFileSync(logPath(), `${lines[0]}\n${JSON.stringify(row)}\n`);
    expect(open().state().on).toBe(false);
  });

  it('a later removal beats an earlier grant whatever the clock did', () => {
    let t = Date.parse('2026-11-07T00:00:10Z');
    const log = new TeamAccessLog({ stateDir: dir, signer, verify, now: () => t });
    bindOwner(log);
    log.appendSignedRequest({ ...signed([{ type: 'person-add', personKey: 'sam', name: 'Sam', role: 'member' }, { type: 'grant', personKey: 'sam', ref: 'r', access: 'use' }]), receivedAt: '2026-11-07T00:00:10.000Z' });
    t -= 60_000;
    log.appendSignedRequest({ ...signed([{ type: 'grant-remove', personKey: 'sam', ref: 'r' }]), receivedAt: '2026-11-07T00:00:01.000Z' });
    expect(log.grantOf('sam', 'r')).toBeNull();
    expect(open().grantOf('sam', 'r')).toBeNull();
  });

  it('a removal and regrant in one request leaves the grant', () => {
    const log = open();
    bindOwner(log);
    log.appendSignedRequest(signed([{ type: 'person-add', personKey: 'sam', name: 'Sam', role: 'member' }, { type: 'grant', personKey: 'sam', ref: 'r', access: 'read' }, { type: 'grant-remove', personKey: 'sam', ref: 'r' }, { type: 'grant', personKey: 'sam', ref: 'r', access: 'use' }]));
    expect(log.grantOf('sam', 'r')).toBe('use');
  });

  it('folding is the same in any row order, and fresh rebuild equals incremental', () => {
    const log = open();
    bindOwner(log);
    log.appendSignedRequest(signed([{ type: 'person-add', personKey: 'sam', name: 'Sam', role: 'member' }]));
    log.appendSignedRequest(signed([{ type: 'grant', personKey: 'sam', ref: 'r', access: 'read' }]));
    const rows = fs.readFileSync(logPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TeamAccessRow);
    expect(foldRows([...rows].reverse(), verify).grants.get('sam')?.get('r')).toBe('read');
    expect(open().grantOf('sam', 'r')).toBe(log.grantOf('sam', 'r'));
  });

  it('a machine-signed lower can remove a person, and cannot name the owner role', () => {
    const log = open();
    bindOwner(log);
    log.appendSignedRequest(signed([{ type: 'person-add', personKey: 'sam', name: 'Sam', role: 'member' }, { type: 'grant', personKey: 'sam', ref: 'r', access: 'use' }]));
    log.appendMachineEvents([{ type: 'lower', personKey: 'sam', remove: true }]);
    expect(log.state().people.has('sam')).toBe(false);
    expect(log.grantOf('sam', 'r')).toBeNull();
  });

  it('truncates a torn final line at boot, and the next append is clean', () => {
    const log = open();
    bindOwner(log);
    fs.appendFileSync(logPath(), '{"seq":2,"kind":"mach');
    const again = open();
    expect(again.healthState()).toBe('ok');
    again.appendSignedRequest(signed([{ type: 'team-on' }]));
    expect(open().state().on).toBe(true);
  });

  it('a bad middle line is unreadable, not a partial read', () => {
    const log = open();
    bindOwner(log);
    log.appendMachineEvents([{ type: 'conversation-own', ref: 'r', personKey: 'sam' }]);
    const lines = fs.readFileSync(logPath(), 'utf8').trim().split('\n');
    fs.writeFileSync(logPath(), `${lines[0]}\nnot json\n${lines[1]}\n`);
    const bad = open();
    expect(bad.healthState()).toBe('unreadable');
    expect(bad.state().on).toBe(false);
  });

  it('a log rolled back below last-good reads as lost', () => {
    const log = open();
    bindOwner(log);
    log.ensureConfinedFile();
    log.appendSignedRequest(signed([{ type: 'team-on' }]));
    log.writeLastGood();
    const first = fs.readFileSync(logPath(), 'utf8').trim().split('\n')[0];
    fs.writeFileSync(logPath(), `${first}\n`);
    expect(open().healthState()).toBe('unreadable');
  });

  it('seeds seq from last-good, so a post-loss row sorts after restored ones', () => {
    const log = open();
    bindOwner(log);
    log.ensureConfinedFile();
    log.appendSignedRequest(signed([{ type: 'team-on' }]));
    log.writeLastGood();
    SafeFsExecutor.safeUnlinkSync(logPath(), { operation: 'tests/unit/team-access-log.test.ts' });
    const next = open();
    // A lost log takes no writes until the owner restores it: a row here would hide the loss.
    expect(() => next.appendMachineEvents([{ type: 'conversation-own', ref: 'r', personKey: 'sam' }])).toThrow('unreadable');
    next.restore({ teamRefs: [], allRefs: () => [] });
    const row = next.appendMachineEvents([{ type: 'conversation-own', ref: 'r', personKey: 'sam' }]);
    expect(row.seq).toBeGreaterThan(2);
  });

  describe('confined list', () => {
    it('keeps the first audience for good', () => {
      const log = open();
      log.ensureConfinedFile();
      log.confine({ ref: 'r', placeKey: 'p1' });
      log.confine({ ref: 'r', placeKey: 'p2' });
      expect(log.readConfined()).toEqual([{ ref: 'r', placeKey: 'p1' }]);
      expect(log.isConfined('r')).toBe(true);
      expect(log.isConfined('other')).toBe(false);
    });

    it('survives team-off', () => {
      const log = open();
      bindOwner(log);
      log.ensureConfinedFile();
      log.confine({ ref: 'r', placeKey: 'p1' });
      log.appendSignedRequest(signed([{ type: 'team-on' }]));
      log.appendSignedRequest(signed([{ type: 'team-off' }]));
      expect(log.state().on).toBe(false);
      expect(log.isConfined('r')).toBe(true);
    });

    it('an unreadable list answers null, never false', () => {
      const log = open();
      log.ensureConfinedFile();
      fs.writeFileSync(path.join(dir, 'state', 'team-access', 'confined.json'), '{bad');
      expect(log.isConfined('r')).toBeNull();
      expect(() => log.confine({ ref: 'r' })).toThrow('team-access-confined-unreadable');
    });

    it('a missing list with team on is not read as empty', () => {
      const log = open();
      bindOwner(log);
      log.appendSignedRequest(signed([{ type: 'team-on' }]));
      expect(log.readConfined()).toBeNull();
    });

    it('a whole folder gone reads as lost when last-good shows team use, never as empty', () => {
      const log = open();
      bindOwner(log);
      log.ensureConfinedFile();
      log.appendSignedRequest(signed([{ type: 'team-on' }]));
      log.writeLastGood();
      SafeFsExecutor.safeRmSync(path.join(dir, 'state', 'team-access'), { recursive: true, force: true, operation: 'tests/unit/team-access-log.test.ts' });
      expect(open().readConfined()).toBeNull();
    });

    it('an invite with no grants still has a readable list', () => {
      const log = open();
      bindOwner(log);
      log.ensureConfinedFile();
      log.appendSignedRequest(signed([{ type: 'team-on' }]));
      expect(log.readConfined()).toEqual([]);
    });
  });

  describe('restore', () => {
    const seeded = () => {
      const log = open();
      bindOwner(log);
      log.ensureConfinedFile();
      log.appendSignedRequest(signed([{ type: 'team-on' }, { type: 'person-add', personKey: 'sam', name: 'Sam', role: 'member' }]));
      log.writeLastGood();
      return log;
    };

    it('keeps a conversation confined after the snapshot, and revocations made since', () => {
      const log = seeded();
      log.confine({ ref: 'late', placeKey: 'p' });
      log.appendSignedRequest(signed([{ type: 'person-remove', personKey: 'sam' }]));
      const out = log.restore({ teamRefs: [], allRefs: () => [{ ref: 'everything' }] });
      expect(out).toEqual({ logLost: false, listLost: false });
      expect(log.isConfined('late')).toBe(true);
      expect(log.isConfined('everything')).toBe(false);
      expect(log.state().people.has('sam')).toBe(false);
    });

    it('rebuilds from team rows when the list is lost and the log is not, with no sweep', () => {
      const log = seeded();
      fs.writeFileSync(path.join(dir, 'state', 'team-access', 'confined.json'), '{bad');
      const out = log.restore({ teamRefs: [{ ref: 'team-chat', placeKey: 'p' }], allRefs: () => [{ ref: 'everything' }] });
      expect(out.listLost).toBe(true);
      expect(log.isConfined('team-chat')).toBe(true);
      expect(log.isConfined('everything')).toBe(false);
    });

    it('confines everything offered when both are lost', () => {
      const log = seeded();
      SafeFsExecutor.safeRmSync(path.join(dir, 'state', 'team-access'), { recursive: true, force: true, operation: 'tests/unit/team-access-log.test.ts' });
      const again = open();
      const out = again.restore({ teamRefs: [], allRefs: () => [{ ref: 'everything' }] });
      expect(out).toEqual({ logLost: true, listLost: true });
      expect(again.isConfined('everything')).toBe(true);
      expect(again.state().on).toBe(true);
    });

    it('keeps rows that still parse around a bad one', () => {
      const log = seeded();
      log.appendSignedRequest(signed([{ type: 'person-remove', personKey: 'sam' }]));
      const lines = fs.readFileSync(logPath(), 'utf8').trim().split('\n');
      fs.writeFileSync(logPath(), `${lines[0]}\nnot json\n${lines.slice(1).join('\n')}\n`);
      const again = open();
      expect(again.healthState()).toBe('unreadable');
      again.restore({ teamRefs: [], allRefs: () => [] });
      expect(again.healthState()).toBe('ok');
      expect(again.state().people.has('sam')).toBe(false);
    });
  });
});
