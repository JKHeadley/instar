import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiskSteward } from '../../src/monitoring/diskSteward/wiring.js';
import { readPeerDiskStatus } from '../../src/monitoring/diskSteward/peerRead.js';
import type { DuePost } from '../../src/monitoring/DiskSteward.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const folders: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const p of folders.splice(0)) SafeFsExecutor.safeRmSync(p, { recursive: true, force: true, operation: 'tests/unit/diskSteward-peer-fallback.test.ts' });
});

describe('scheduled disk peer read production wiring', () => {
  it('uses the shared fallback and records both transport outcomes during a holder tick', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-peer-fallback-')); folders.push(tmp);
    const lan = 'http://192.168.87.61:4062';
    const secure = 'https://m5.dawn-tunnel.dev';
    const record = vi.fn();
    const dial = vi.fn(async (url: string) => {
      if (url === `${lan}/disk-steward`) throw new TypeError('fetch failed');
      expect(url).toBe(`${secure}/disk-steward`);
      return Response.json({ machine: { id: 'm_peer' }, duePost: null });
    });
    vi.stubGlobal('fetch', dial);
    const wired = createDiskSteward({
      readConfig: () => ({ diskSteward: { prune: { enabled: false } }, developmentAgent: false }),
      stateDir: path.join(tmp, '.instar'), agentHome: tmp, agentName: 'test', machineId: 'm_self', machineName: () => 'Self',
      isHolder: () => true, authToken: 'test-disk-peer-fallback',
      peers: () => [{ machineId: 'm_peer', url: lan, kind: 'lan', allowed: true, ropes: [{ url: secure, kind: 'cloudflare' }] }],
      ...{ recordRopeResult: record },
      getTopicId: () => null, setTopicId: () => {}, canCreateTopic: () => false,
    });
    try {
      await wired.steward.tick();
      expect(dial).toHaveBeenCalledTimes(2);
      expect(record).toHaveBeenCalledWith('m_peer', 'lan', false, expect.any(Number), lan);
      expect(record).toHaveBeenCalledWith('m_peer', 'cloudflare', true, expect.any(Number), secure);
    } finally { wired.steward.stop(); }
  });

  it('the server passes actual resolver candidates and shared recorder to both consumers', () => {
    const source = fs.readFileSync(new URL('../../src/commands/server.ts', import.meta.url), 'utf8');
    const block = source.slice(source.indexOf('async function wireDiskSteward('), source.indexOf('async function wireDiskSteward(') + 10_000);
    expect(block).toContain('kind: p.kind');
    expect(block).toContain('ropes: p.ropes');
    expect(block).toContain('(...args) => _recordRopeResult?.(...args)');
    expect(block.match(/recordRopeResult: _dsRecord/g)?.length).toBe(2);
  });
});


describe('disk read connection identity and acknowledgement', () => {
  it('normalizes only the dial while retaining raw resolver keys and avoiding duplicate primary attempts', async () => {
    const lan = 'http://192.168.87.61:4062/';
    const secure = 'https://m5.dawn-tunnel.dev/';
    const record = vi.fn();
    const dial = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      if (url === 'http://192.168.87.61:4062/disk-steward') throw new TypeError('fetch failed');
      expect(url).toBe('https://m5.dawn-tunnel.dev/disk-steward');
      return Response.json({ measured: true });
    });
    vi.stubGlobal('fetch', dial);
    const read = await readPeerDiskStatus(record, { machineId: 'm_peer', url: lan, kind: 'lan',
      ropes: [{ url: lan, kind: 'lan' }, { url: secure, kind: 'cloudflare' }] }, 'test-auth');
    expect(read.response.ok).toBe(true);
    expect(read.readUrl).toBe(secure);
    expect(dial).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledWith('m_peer', 'lan', false, expect.any(Number), lan);
    expect(record).toHaveBeenCalledWith('m_peer', 'cloudflare', true, expect.any(Number), secure);
  });

  it.each([true, false])('makes exactly one acknowledgement over the successful read connection (ack succeeds: %s)', async (ackSucceeds) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-peer-ack-')); folders.push(tmp);
    const lan = 'http://192.168.87.61:4062';
    const secure = 'https://m5.dawn-tunnel.dev/';
    const due: DuePost = {
      postId: 'peer-recovery', machineId: 'm_peer', machineName: 'Peer', kind: 'recovery', level: 'ok', critical: false,
      episodeStart: Date.now(), stage: 0, createdAt: Date.now(), free: 200 * 1024 ** 3, total: 900 * 1024 ** 3,
      change24h: null, daysToFloor: null, cleared: [], cacheReclaimableBytes: 0, reaperArmed: false,
      pruneEnabled: false, cleanupNotHelping: false, failures: 0, nextAttemptAt: 0,
    };
    let pending: DuePost | null = due;
    const sent = vi.fn(async () => ({}));
    const ackUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `${lan}/disk-steward`) throw new TypeError('fetch failed');
      if (init?.method === 'POST') {
        ackUrls.push(url);
        expect(url).toBe('https://m5.dawn-tunnel.dev/disk-steward/posted');
        expect(init.redirect).toBe('manual');
        expect(JSON.parse(String(init.body))).toEqual({ postId: due.postId, outcome: 'posted' });
        if (!ackSucceeds) throw new TypeError('ack connection lost');
        pending = null;
        return Response.json({ ok: true });
      }
      expect(url).toBe('https://m5.dawn-tunnel.dev/disk-steward');
      return Response.json({ machine: { id: 'm_peer' }, duePost: pending });
    }));
    const wired = createDiskSteward({
      readConfig: () => ({ diskSteward: { prune: { enabled: false } }, developmentAgent: false }),
      stateDir: path.join(tmp, '.instar'), agentHome: tmp, agentName: 'test', machineId: 'm_self', machineName: () => 'Self',
      isHolder: () => true, authToken: 'test-auth',
      peers: () => [{ machineId: 'm_peer', url: lan, kind: 'lan', allowed: true, ropes: [{ url: secure, kind: 'cloudflare' }] }],
      getTopicId: () => 123, setTopicId: () => {}, canCreateTopic: () => false, sendToTopic: sent,
    });
    try {
      await wired.steward.tick();
      expect(sent).toHaveBeenCalledTimes(1);
      expect(ackUrls).toHaveLength(1);
      expect(pending === null).toBe(ackSucceeds);
      if (ackSucceeds) {
        await wired.steward.tick();
        expect(sent).toHaveBeenCalledTimes(1);
        expect(ackUrls).toHaveLength(1);
      }
    } finally { wired.steward.stop(); }
  });
});
