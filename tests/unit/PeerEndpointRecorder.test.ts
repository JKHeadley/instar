/**
 * Unit — PeerEndpointRecorder (mesh-endpoint-http-propagation, the record() chokepoint).
 *
 * Verifies the five invariants from the spec Receiver §: meshTransport gate (off ⇒
 * no-op), absence-is-no-op-never-a-wipe (undefined/null/[]/fully-invalid), synchronous
 * validation before storage, idempotent skip on an unchanged set, a valid changed set
 * records, and an unknown-machine write is swallowed (never throws). Uses an in-memory
 * fake registry so the deps are real call-shaped but I/O-free.
 */
import { describe, it, expect } from 'vitest';
import { PeerEndpointRecorder } from '../../src/core/PeerEndpointRecorder.js';
import type { MeshEndpoint } from '../../src/core/types.js';

const TS: MeshEndpoint = { kind: 'tailscale', url: 'http://100.64.0.9:4042' };
const LAN: MeshEndpoint = { kind: 'lan', url: 'http://192.168.87.60:4042' };
const CF: MeshEndpoint = { kind: 'cloudflare', url: 'https://peer.dawn-tunnel.dev' };

function mkRecorder(opts: {
  meshOn?: boolean;
  known?: Record<string, MeshEndpoint[]>;
  /** Invariant 2b evidence: `${machineId}:${kind}` ⇒ alive?  Absent key ⇒ no evidence. */
  alive?: Record<string, boolean>;
  aliveThrows?: boolean;
} = {}) {
  const store: Record<string, MeshEndpoint[]> = { ...(opts.known ?? {}) };
  let writes = 0;
  const rec = new PeerEndpointRecorder({
    getPeerEndpoints: (id) => store[id],
    updateMachineEndpoints: (id, eps) => {
      if (!(id in store) && !opts.known) {
        // simulate the registry knowing every passed id by default for the happy path
      }
      if (id === '__unknown__') throw new Error('MACHINE_NOT_FOUND');
      store[id] = eps;
      writes += 1;
    },
    meshTransportEnabled: () => opts.meshOn ?? true,
    ...(opts.alive || opts.aliveThrows
      ? {
        isEndpointAlive: (id: string, kind: MeshEndpoint['kind']) => {
          if (opts.aliveThrows) throw new Error('snapshot unavailable');
          return opts.alive?.[`${id}:${kind}`];
        },
      }
      : {}),
  });
  return { rec, store, getWrites: () => writes };
}

describe('PeerEndpointRecorder.record', () => {
  it('meshTransport OFF ⇒ strict no-op (returns false, no write)', () => {
    const { rec, getWrites } = mkRecorder({ meshOn: false });
    expect(rec.record('peer', [TS, CF])).toBe(false);
    expect(getWrites()).toBe(0);
  });

  it('absent / null ⇒ no-op (never a wipe)', () => {
    const { rec, store, getWrites } = mkRecorder({ known: { peer: [TS] } });
    expect(rec.record('peer', undefined)).toBe(false);
    expect(rec.record('peer', null)).toBe(false);
    expect(store.peer).toEqual([TS]); // prior set intact
    expect(getWrites()).toBe(0);
  });

  it('empty array [] ⇒ no-op (an empty advertised set is NOT a clear-all)', () => {
    const { rec, store, getWrites } = mkRecorder({ known: { peer: [TS] } });
    expect(rec.record('peer', [])).toBe(false);
    expect(store.peer).toEqual([TS]);
    expect(getWrites()).toBe(0);
  });

  it('a fully-invalid set ⇒ no-op (validates to [] ⇒ never a wipe)', () => {
    const { rec, store } = mkRecorder({ known: { peer: [TS] } });
    expect(rec.record('peer', [{ kind: 'lan', url: 'http://8.8.8.8:4042' }])).toBe(false);
    expect(store.peer).toEqual([TS]);
  });

  it('records a valid changed set (returns true, writes once)', () => {
    const { rec, store, getWrites } = mkRecorder({ known: { peer: [TS] } });
    expect(rec.record('peer', [TS, LAN, CF])).toBe(true);
    expect(store.peer).toEqual([TS, LAN, CF]);
    expect(getWrites()).toBe(1);
  });

  it('drops invalid elements but records the valid subset', () => {
    const { rec, store } = mkRecorder({ known: { peer: [] } });
    expect(rec.record('peer', [TS, { kind: 'lan', url: 'http://8.8.8.8:4042' }, CF])).toBe(true);
    expect(store.peer).toEqual([TS, CF]);
  });

  it('idempotent — an unchanged set (order/cosmetic-insensitive) skips the write', () => {
    const { rec, getWrites } = mkRecorder({ known: { peer: [TS, CF] } });
    // same value, reversed order + trailing slash on the cloudflare host
    const same = [{ kind: 'cloudflare', url: 'https://PEER.dawn-tunnel.dev/' }, TS] as MeshEndpoint[];
    expect(rec.record('peer', same)).toBe(false);
    expect(getWrites()).toBe(0);
  });

  it('an unknown-machine write is swallowed (never throws, returns false)', () => {
    const { rec } = mkRecorder();
    expect(() => rec.record('__unknown__', [TS])).not.toThrow();
    expect(rec.record('__unknown__', [TS])).toBe(false);
  });

  it('a blank machineId ⇒ no-op (the binding is load-bearing)', () => {
    const { rec, getWrites } = mkRecorder();
    expect(rec.record('', [TS])).toBe(false);
    expect(getWrites()).toBe(0);
  });
});

describe('forged-advert-set-from-non-owner-rejected (U4.2 R-r2-5b — the per-entry authenticated binding)', () => {
  it('a write under authenticated peer B NEVER mutates peer A\'s entry (the binding the stale-owner disproof rests on)', () => {
    // A's advert set is the multi-transport truth the U4.2 all-ropes disproof
    // reads. B (a non-owner) advertising a shrunk, attacker-controlled set must
    // land in B's OWN entry only — record()'s peerMachineId is the
    // cryptographically-verified sender at every callsite, and the write
    // target is keyed on exactly that id.
    const { rec, store } = mkRecorder({ known: { m_A: [TS, LAN], m_B: [] } });
    const wrote = rec.record('m_B', [CF]);
    expect(wrote).toBe(true);
    expect(store['m_B']).toEqual([CF]);
    // A's entry is byte-identical — B cannot shrink A's advert set to a rope
    // it controls and manufacture "unreachable on every transport".
    expect(store['m_A']).toEqual([TS, LAN]);
  });
});


/**
 * Invariant 2b — a NON-EMPTY advertisement that omits a PROVEN kind must not discard it.
 *
 * Regression origin (2026-08-29): a peer whose agent runs inside a NAT'd VM could only
 * see an unreachable virtual NIC, so it advertised `[lan]` alone. The recorder replaced
 * `[tailscale, lan]` with `[lan]` and the mesh lost its only working route to that
 * machine — while the tailscale rope was carrying live traffic at that very moment.
 * Invariant 2 guarded the EMPTY advertisement; nothing guarded the degraded one.
 */
describe('PeerEndpointRecorder.record — invariant 2b (omitted-but-proven retention)', () => {
  it('retains an omitted kind the health record says is ALIVE (the regression case)', () => {
    // The merged set equals what is already stored, so invariant 4 correctly skips the
    // write — the POINT is that tailscale survives the degraded advertisement.
    const { rec, store } = mkRecorder({
      known: { peer: [TS, LAN] },
      alive: { 'peer:tailscale': true },
    });
    expect(rec.record('peer', [LAN])).toBe(false);
    expect(store.peer.map((e) => e.kind).sort()).toEqual(['lan', 'tailscale']);
    expect(store.peer.find((e) => e.kind === 'tailscale')).toEqual(TS);
  });

  it('retains the proven kind AND writes when the advertised kind actually changed', () => {
    const movedLan: MeshEndpoint = { kind: 'lan', url: 'http://192.168.87.99:4042' };
    const { rec, store } = mkRecorder({
      known: { peer: [TS, LAN] },
      alive: { 'peer:tailscale': true },
    });
    expect(rec.record('peer', [movedLan])).toBe(true);
    expect(store.peer.map((e) => e.kind).sort()).toEqual(['lan', 'tailscale']);
    expect(store.peer.find((e) => e.kind === 'lan')).toEqual(movedLan);
    expect(store.peer.find((e) => e.kind === 'tailscale')).toEqual(TS);
  });

  it('DROPS an omitted kind the health record says is DEAD (a retired rope does not linger)', () => {
    const { rec, store } = mkRecorder({
      known: { peer: [TS, LAN] },
      alive: { 'peer:tailscale': false },
    });
    expect(rec.record('peer', [LAN])).toBe(true);
    expect(store.peer.map((e) => e.kind)).toEqual(['lan']);
  });

  it('DROPS an omitted kind with NO health evidence (never dialed ⇒ not proven)', () => {
    const { rec, store } = mkRecorder({ known: { peer: [TS, LAN] }, alive: {} });
    expect(rec.record('peer', [LAN])).toBe(true);
    expect(store.peer.map((e) => e.kind)).toEqual(['lan']);
  });

  it('a health source that THROWS retains nothing (error ⇒ no evidence, never a retain)', () => {
    const { rec, store } = mkRecorder({ known: { peer: [TS, LAN] }, aliveThrows: true });
    expect(rec.record('peer', [LAN])).toBe(true);
    expect(store.peer.map((e) => e.kind)).toEqual(['lan']);
  });

  it('an advertisement RE-advertising a kind with a new url still wins (upgrade lands)', () => {
    const moved: MeshEndpoint = { kind: 'tailscale', url: 'http://100.64.0.77:4042' };
    const { rec, store } = mkRecorder({
      known: { peer: [TS] },
      alive: { 'peer:tailscale': true },
    });
    expect(rec.record('peer', [moved])).toBe(true);
    expect(store.peer).toEqual([moved]);
  });

  it('stays idempotent — a re-advertisement that merges to the SAME set skips the write', () => {
    const { rec, getWrites } = mkRecorder({
      known: { peer: [LAN, TS] },
      alive: { 'peer:tailscale': true },
    });
    expect(rec.record('peer', [LAN])).toBe(false);
    expect(getWrites()).toBe(0);
  });

  it('with NO health dep wired, behaviour is byte-identical to plain replace', () => {
    const { rec, store } = mkRecorder({ known: { peer: [TS, LAN] } });
    expect(rec.record('peer', [LAN])).toBe(true);
    expect(store.peer.map((e) => e.kind)).toEqual(['lan']);
  });
});
