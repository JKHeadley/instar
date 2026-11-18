/**
 * SEC-114 (active form): a forged "cannot serve" answer must not make a sender give the agent token
 * to a peer whose SIGNED capacity advert says it serves the read. Both sides of every boundary.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SignedReadCapability, signedThenBearer, bearerFallbackBarredByVersionFloor, SIGNED_POOL_READS_MIN_VERSION, PeerVersionFloor } from '../../src/core/poolSignedReads.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MeshRpcClientResult } from '../../src/core/MeshRpcClient.js';

const NEW = '1.3.1900';
const OLD = '1.3.1700';
const noHandler: MeshRpcClientResult = { ok: false, status: 501, reason: 'no-handler' };
const unauthorized: MeshRpcClientResult = { ok: false, status: 403, reason: 'claim-unauthorized' };

function run(o: { res?: MeshRpcClientResult; throws?: Error; advert: string | null; peerVersion?: string | null; kind?: 'list' | 'transcript' | 'historyPool'; cap?: SignedReadCapability }) {
  const bearer = vi.fn(async () => ({ v: 'via-bearer' }));
  const refused = vi.fn();
  const cap = o.cap ?? new SignedReadCapability();
  const p = signedThenBearer<{ v: string }>({
    machineId: 'm_peer', kind: o.kind ?? 'list', peerVersion: o.peerVersion ?? o.advert, capability: cap,
    signed: async () => { if (o.throws) throw o.throws; return o.res!; },
    accept: (r) => (r && typeof r === 'object' && (r as { ok?: unknown }).ok === true ? { v: 'via-signed' } : 'refused'),
    bearer, versionFloor: o.advert, onFallbackRefused: refused,
  });
  return { p, bearer, refused, cap };
}

describe('SEC-114: no forced bearer fallback to a peer once seen at a serving version', () => {
  it('the bar starts exactly at the release that serves the reads', () => {
    expect(bearerFallbackBarredByVersionFloor(SIGNED_POOL_READS_MIN_VERSION)).toBe(true);
    expect(bearerFallbackBarredByVersionFloor(NEW)).toBe(true);
    expect(bearerFallbackBarredByVersionFloor('1.3.1739')).toBe(false);
    expect(bearerFallbackBarredByVersionFloor(null)).toBe(false);
    expect(bearerFallbackBarredByVersionFloor(undefined)).toBe(false);
  });

  it('a no-handler answer from a peer advertising a serving version is refused, reported, and sends no token', async () => {
    const { p, bearer, refused, cap } = run({ res: noHandler, advert: NEW });
    const out = await p;
    expect(out.via).toBeNull();
    expect((out as { error: string }).error).toMatch(/^bearer-fallback-refused/);
    expect(bearer).not.toHaveBeenCalled();
    expect(refused).toHaveBeenCalledOnce();
    expect(cap.status(['m_peer']).counts.fallbacksRefused).toBe(1);
    expect(cap.bearerRemembered('m_peer', 'list', NEW)).toBe(false);
  });

  it('the same answer with no signed advert still falls back, as before', async () => {
    const { p, bearer, refused } = run({ res: noHandler, advert: null, peerVersion: null });
    expect((await p).via).toBe('bearer');
    expect(bearer).toHaveBeenCalledOnce();
    expect(refused).not.toHaveBeenCalled();
  });

  it('an older signed advert still falls back on claim-unauthorized, as before', async () => {
    const { p, bearer } = run({ res: unauthorized, advert: OLD });
    expect((await p).via).toBe('bearer');
    expect(bearer).toHaveBeenCalledOnce();
  });

  it('an old-shape pool-history answer from a serving advert is refused too', async () => {
    const { p, bearer, refused } = run({ res: { ok: true, status: 200, result: { ok: true } }, advert: NEW, kind: 'historyPool' });
    expect((await p).via).toBeNull();
    expect(bearer).not.toHaveBeenCalled();
    expect(refused).toHaveBeenCalledOnce();
  });

  it('a remembered "needs bearer" is not honoured for a serving advert: it asks signed again', async () => {
    const cap = new SignedReadCapability();
    cap.recordBearerNeeded('m_peer', 'list', NEW);
    const { p, bearer } = run({ res: { ok: true, status: 200, result: { ok: true } }, advert: NEW, cap });
    expect((await p).via).toBe('signed');
    expect(bearer).not.toHaveBeenCalled();
  });

  it('a remembered "needs bearer" is still honoured with no signed advert', async () => {
    const cap = new SignedReadCapability();
    cap.recordBearerNeeded('m_peer', 'list', null);
    const { p, bearer } = run({ res: noHandler, advert: null, peerVersion: null, cap });
    expect((await p).via).toBe('bearer');
    expect(bearer).toHaveBeenCalledOnce();
  });

  it('a timeout still never falls back, with or without an advert', async () => {
    for (const advert of [NEW, null]) {
      const { p, bearer } = run({ throws: Object.assign(new Error('x'), { name: 'AbortError' }), advert });
      expect((await p).via).toBeNull();
      expect(bearer).not.toHaveBeenCalled();
    }
  });

  it('the version floor only rises, from any source, and survives a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec114-floor-'));
    try {
      const file = path.join(dir, 'peer-version-floor.json');
      const write = (f: string, d: unknown) => SafeFsExecutor.atomicWriteJsonSync(f, d, { operation: 'test' });
      const a = new PeerVersionFloor(file, write);
      expect(a.observe('m1', null, undefined)).toBeNull();
      expect(a.observe('m1', '1.3.1700', null)).toBe('1.3.1700');
      expect(a.observe('m1', null, '1.3.1900')).toBe('1.3.1900'); // a self-reported version raises it too
      expect(a.observe('m1', '1.3.1700', '1.3.1600')).toBe('1.3.1900'); // a lower report (forged or not) never lowers it
      expect(a.observe('m1', 'garbage')).toBe('1.3.1900');
      const b = new PeerVersionFloor(file, write); // a restart reads it back
      expect(b.observe('m1')).toBe('1.3.1900');
      expect(bearerFallbackBarredByVersionFloor(b.observe('m1', '1.3.1700'))).toBe(true);
      expect(b.observe('m2', '1.3.1700')).toBe('1.3.1700');
      expect(bearerFallbackBarredByVersionFloor(b.observe('m2'))).toBe(false);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/sec114-signed-read-forced-fallback.test.ts' });
    }
  });

  it('every signedThenBearer caller in the routes passes the version floor and a refusal reporter', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/server/routes.ts'), 'utf8');
    const calls = src.split('signedThenBearer<').slice(1);
    expect(calls.length).toBe(3);
    for (const c of calls) {
      const head = c.slice(0, 600);
      expect(head).toContain('versionFloor: versionFloorOf(');
      expect(head).toContain('onFallbackRefused: onSignedReadFallbackRefused(');
    }
  });
});
