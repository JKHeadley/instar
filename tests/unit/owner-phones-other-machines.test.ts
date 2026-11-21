/**
 * The first-phone rule of home pairing counts owner phones on the agent's other machines (security
 * review of home pairing, 2026-11-21): device records stay where they paired, so every active machine
 * is asked live, and one that cannot be asked is named so the caller refuses.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ownerPhonesOnOtherMachines } from '../../src/server/mobilePairingRoutes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
const servers: http.Server[] = [];
afterAll(async () => {
  for (const s of servers) await new Promise((r) => s.close(() => r(null)));
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/owner-phones-other-machines.test.ts' });
});

function stateWith(machines: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'opom-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'machines'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'machines', 'registry.json'), JSON.stringify({ version: 1, machines }));
  return dir;
}

async function peer(status: number, body: unknown): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const srv = http.createServer((req, res) => { seen.push(`${req.url} ${req.headers.authorization}`); res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(typeof body === 'string' ? body : JSON.stringify(body)); });
  servers.push(srv);
  await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(null)));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen };
}

const ctxFor = (peers: Array<{ machineId: string; url: string }>) => ({
  config: { authToken: 'tok-1' }, resolvePeerUrls: () => peers.map((p) => ({ ...p, kind: 'lan' })),
}) as unknown as Parameters<typeof ownerPhonesOnOtherMachines>[0];

describe('owner phones on the agent\'s other machines', () => {
  it('a single machine has nothing to ask', async () => {
    expect(await ownerPhonesOnOtherMachines(null, stateWith({ m_self: { status: 'active' } }), 'm_self')).toEqual({ count: 0, unchecked: [] });
    const empty = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'opom-')); dirs.push(empty);
    expect(await ownerPhonesOnOtherMachines(null, empty, 'm_self')).toEqual({ count: 0, unchecked: [] });
  });

  it('counts an active owner phone on a peer, and ignores browsers, the app on that computer, team phones and inactive rows', async () => {
    const p = await peer(200, { devices: [
      { id: 'a', status: 'active', role: 'owner' },
      { id: 'b', status: 'active', client: 'browser' },
      { id: 'c', status: 'active', localInstall: true },
      { id: 'd', status: 'active', role: 'team' },
      { id: 'e', status: 'revoked' },
      { id: 'f', status: 'pending' },
    ] });
    const r = await ownerPhonesOnOtherMachines(ctxFor([{ machineId: 'm_peer', url: p.url }]), stateWith({ m_self: { status: 'active' }, m_peer: { status: 'active' } }), 'm_self');
    expect(r).toEqual({ count: 1, unchecked: [] });
    expect(p.seen[0]).toBe('/mobile/devices Bearer tok-1');
  });

  it('a peer too old to mark its rows counts its active phones (fails closed)', async () => {
    const p = await peer(200, { devices: [{ id: 'a', status: 'active' }] });
    const r = await ownerPhonesOnOtherMachines(ctxFor([{ machineId: 'm_peer', url: p.url }]), stateWith({ m_self: { status: 'active' }, m_peer: { status: 'active' } }), 'm_self');
    expect(r.count).toBe(1);
  });

  it('names every machine it could not ask: no address, an error answer, an unreadable answer, or unreachable', async () => {
    const bad = await peer(500, { error: 'x' });
    const junk = await peer(200, 'not json');
    const noList = await peer(200, { nope: true });
    const dir = stateWith({ m_self: { status: 'active' }, m_noaddr: { status: 'active' }, m_bad: { status: 'active' }, m_junk: { status: 'active' }, m_nolist: { status: 'active' }, m_down: { status: 'active' }, m_gone: { status: 'revoked', revokedAt: '2026-11-01T00:00:00Z' } });
    const r = await ownerPhonesOnOtherMachines(ctxFor([
      { machineId: 'm_bad', url: bad.url }, { machineId: 'm_junk', url: junk.url }, { machineId: 'm_nolist', url: noList.url }, { machineId: 'm_down', url: 'http://127.0.0.1:1' },
    ]), dir, 'm_self');
    expect(r.count).toBe(0);
    expect([...r.unchecked].sort()).toEqual(['m_bad', 'm_down', 'm_junk', 'm_noaddr', 'm_nolist']);
  });

  it('with other active machines but no way to reach the pool, every one is unchecked', async () => {
    const r = await ownerPhonesOnOtherMachines(null, stateWith({ m_self: { status: 'active' }, m_a: { status: 'active' }, m_b: { status: 'revoked', revokedAt: '2026-11-01T00:00:00Z' } }), 'm_self');
    expect(r).toEqual({ count: 0, unchecked: ['m_a'] });
  });

  it('a peer address the address guard refuses is unchecked', async () => {
    const r = await ownerPhonesOnOtherMachines(ctxFor([{ machineId: 'm_pub', url: 'http://8.8.8.8:4042' }]), stateWith({ m_self: { status: 'active' }, m_pub: { status: 'active' } }), 'm_self');
    expect(r.unchecked).toEqual(['m_pub']);
  });

  it('refuses to guess when this machine\'s own id or the registry is unknown', async () => {
    expect((await ownerPhonesOnOtherMachines(null, stateWith({ m_self: { status: 'active' }, m_peer: { status: 'active' } }), null)).unchecked).toEqual(['this-machine-id-unknown']);
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'opom-')); dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'machines')); fs.writeFileSync(path.join(dir, 'machines', 'registry.json'), '{broken');
    expect((await ownerPhonesOnOtherMachines(null, dir, 'm_self')).unchecked).toEqual(['machine-registry-unreadable']);
  });
});
