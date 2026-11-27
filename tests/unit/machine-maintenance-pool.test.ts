/**
 * Unit: the machine-maintenance pool view (CMT-1199) — fan-out classification and merge.
 * Self + healthy peer + failed peer + an older peer without the route; never a URL,
 * token or raw error message in the output; read-only flags fixed.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyPeerStatus,
  fetchMaintenancePool,
  mergeMaintenancePool,
  routeForPart,
} from '../../src/server/machineMaintenancePool.js';

const json = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('classifyPeerStatus', () => {
  it('names each non-2xx answer', () => {
    expect(classifyPeerStatus(200)).toBeNull();
    expect(classifyPeerStatus(503)).toBe('not-enabled');
    expect(classifyPeerStatus(404)).toBe('route-missing');
    expect(classifyPeerStatus(401)).toBe('unauthorized');
    expect(classifyPeerStatus(403)).toBe('unauthorized');
    expect(classifyPeerStatus(500)).toBe('http-error');
  });
});

describe('fetchMaintenancePool', () => {
  const peers = [
    { machineId: 'm-ok', url: 'http://127.0.0.1:4101', kind: 'lan' },
    { machineId: 'm-dark', url: 'http://127.0.0.1:4102', kind: 'lan' },
    { machineId: 'm-old', url: 'http://127.0.0.1:4103', kind: 'lan' },
    { machineId: 'm-down', url: 'http://127.0.0.1:4104', kind: 'lan' },
    { machineId: 'm-garbage', url: 'http://127.0.0.1:4105', kind: 'lan' },
    { machineId: 'm-offline', url: 'http://127.0.0.1:4106', kind: 'lan' },
  ];

  it('asks each peer for its PLAIN route with the bearer, and classifies every failure', async () => {
    const asked: string[] = [];
    const out = await fetchMaintenancePool({
      peers,
      authToken: 'secret-token',
      getCapacity: (id) => (id === 'm-offline' ? { online: false } : { online: true }),
      fetchPeer: async (peer, path, init) => {
        asked.push(`${peer.machineId} ${path} ${(init?.headers as Record<string, string>).Authorization}`);
        if (peer.machineId === 'm-ok') return json(200, { mode: 'watch-only', canRestart: false, uptimeDays: 4 });
        if (peer.machineId === 'm-dark') return json(503, { enabled: false });
        if (peer.machineId === 'm-old') return json(404, 'Cannot GET /machine-maintenance');
        if (peer.machineId === 'm-garbage') return json(200, '[1,2]');
        throw new Error(`connect ECONNREFUSED ${peer.url}`);
      },
    }, 'status');
    expect(asked.every((a) => a.includes(' /machine-maintenance Bearer secret-token'))).toBe(true);
    expect(asked.some((a) => a.startsWith('m-offline'))).toBe(false);
    expect(out.results).toEqual([{ machineId: 'm-ok', body: { mode: 'watch-only', canRestart: false, uptimeDays: 4 } }]);
    const reasons = Object.fromEntries(out.failed.map((f) => [f.machineId, f.reason]));
    expect(reasons).toEqual({
      'm-dark': 'not-enabled', 'm-old': 'route-missing', 'm-down': 'peer-unreachable',
      'm-garbage': 'invalid-body', 'm-offline': 'offline',
    });
    const text = JSON.stringify(out.failed);
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).not.toContain('secret-token');
    expect(out.queried).toBe(peers.length);
  });

  it('refuses to send the token over a rejected rope', async () => {
    let dialled = false;
    const out = await fetchMaintenancePool({
      peers: [{ machineId: 'm-x', url: 'ftp://evil.example', kind: 'cloudflare' }], authToken: 't',
      fetchPeer: async () => { dialled = true; return json(200, {}); },
    }, 'lock-state');
    expect(dialled).toBe(false);
    expect(out.failed).toEqual([{ machineId: 'm-x', reason: 'url-rejected' }]);
  });

  it('caps the body size', async () => {
    const out = await fetchMaintenancePool({
      peers: [peers[0]], authToken: 't',
      fetchPeer: async () => json(200, { pad: 'x'.repeat(1024 * 1024 + 10) }),
    }, 'status');
    expect(out.failed).toEqual([{ machineId: 'm-ok', reason: 'too-large' }]);
  });

  it('uses the lock-state route for that part', () => {
    expect(routeForPart('lock-state')).toBe('/machine-maintenance/lock-state');
    expect(routeForPart('status')).toBe('/machine-maintenance');
  });
});

describe('mergeMaintenancePool', () => {
  it('tags self first, then peers by name, lists failures, and fixes the read-only flags', () => {
    const view = mergeMaintenancePool({
      part: 'status',
      selfMachineId: 'm-self',
      selfNickname: 'Studio',
      self: { body: { uptimeDays: 2 } },
      results: [
        { machineId: 'm-z', body: { uptimeDays: 9, canRestart: true } },
        { machineId: 'm-a', body: { uptimeDays: 1 } },
      ],
      failed: [{ machineId: 'm-old', reason: 'route-missing' }],
      queried: 3,
      stale: false,
      nicknameOf: (id) => ({ 'm-z': 'Mini', 'm-a': 'Laptop', 'm-old': 'Mama PC' } as Record<string, string>)[id],
    });
    expect(view).toMatchObject({ scope: 'pool', part: 'status', authority: 'none', readOnly: true, canRestart: false, canStopWork: false });
    expect(view.machines.map((m) => [m.machineId, m.machineNickname, m.self])).toEqual([
      ['m-self', 'Studio', true], ['m-a', 'Laptop', false], ['m-z', 'Mini', false],
    ]);
    // A peer's own claim is carried as data; the view's own flags stay false.
    expect(view.machines[2].state.canRestart).toBe(true);
    expect(view.pool).toEqual({
      selfMachineId: 'm-self', peersQueried: 3, peersOk: 2, stale: false,
      failed: [{ machineId: 'm-old', machineNickname: 'Mama PC', reason: 'route-missing' }],
    });
  });

  it('lists a dark self under failed instead of failing the whole view', () => {
    const view = mergeMaintenancePool({
      part: 'lock-state', selfMachineId: null, self: { reason: 'not-enabled' },
      results: [{ machineId: 'm-a', body: { lockState: 'unknown' } }], failed: [], queried: 1, stale: true,
    });
    expect(view.machines.map((m) => m.machineId)).toEqual(['m-a']);
    expect(view.pool.failed).toEqual([{ machineId: 'self', machineNickname: undefined, reason: 'not-enabled' }]);
    expect(view.pool.stale).toBe(true);
  });

  it('never shows an id-shaped nickname as a name', () => {
    const view = mergeMaintenancePool({
      part: 'status', selfMachineId: 'm-self', selfNickname: 'm-self', self: { body: {} },
      results: [{ machineId: 'm-b', body: {} }], failed: [], queried: 1, stale: false, nicknameOf: () => '0123abcd4567',
    });
    expect(view.machines.every((m) => m.machineNickname === undefined)).toBe(true);
  });
});
