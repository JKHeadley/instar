/**
 * F5 — interactive-priority reservation in the host spawn cap
 * (docs/specs/spawn-cap-interactive-priority.md §C).
 *
 * The reservation SUBDIVIDES within the existing cap N; it NEVER raises it. These
 * tests lock the safety-critical invariants: the OOM floor (liveTotal < N) is the
 * unconditional first predicate; a garbage/missing lane is counted as background and
 * NEVER drops a holder; the symmetric reserve protects each lane; the clamp keeps
 * Ri/Rb valid for any N; and `enabled:false` is byte-identical to the all-or-nothing
 * cap (no `lane` written).
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  HostSpawnSemaphore,
  clampInteractiveReserves,
  type InteractivePriorityConfig,
} from '../../src/core/hostSpawnSemaphore.js';

function tmpHolders(): string {
  const p = path.join(os.tmpdir(), `f5-holders-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  return p;
}

function makeSem(cap: number, priority?: InteractivePriorityConfig, holdersPath = tmpHolders()): HostSpawnSemaphore {
  // Force host-local + pid-alive so prune never reclaims our synthetic holders.
  return new HostSpawnSemaphore({
    holdersPath,
    cap,
    interactivePriority: priority,
    isPathHostLocal: () => true,
    pidAlive: () => true,
  });
}

describe('clampInteractiveReserves', () => {
  it('clamps Ri then Rb to keep Ri+Rb ≤ N-1 (≥1 contended slot)', () => {
    expect(clampInteractiveReserves(8, 2, 2)).toEqual({ ri: 2, rb: 2 });
    // oversized: Ri honored first, Rb takes the remainder
    expect(clampInteractiveReserves(8, 10, 10)).toEqual({ ri: 7, rb: 0 });
    expect(clampInteractiveReserves(4, 2, 5)).toEqual({ ri: 2, rb: 1 });
  });
  it('permits a legitimate 0 (>=0, not the cap >0 filter)', () => {
    expect(clampInteractiveReserves(8, 0, 0)).toEqual({ ri: 0, rb: 0 });
  });
  it('NaN/negative fall to default 2', () => {
    expect(clampInteractiveReserves(8, NaN, -3)).toEqual({ ri: 2, rb: 2 });
  });
  it('N=1 → both clamp to 0 (feature inert, lone slot fully contended)', () => {
    expect(clampInteractiveReserves(1, 2, 2)).toEqual({ ri: 0, rb: 0 });
  });
  it('N=2 → Ri=1, Rb=0 (valid, never zeros the cap)', () => {
    expect(clampInteractiveReserves(2, 2, 2)).toEqual({ ri: 1, rb: 0 });
  });
});

describe('HostSpawnSemaphore — interactive priority OFF (byte-identical to today)', () => {
  it('lane is ignored; acquire is all-or-nothing within N; no lane written', () => {
    const hp = tmpHolders();
    const sem = makeSem(2, { enabled: false, ri: 2, rb: 2 }, hp);
    expect(sem.acquire('a', 'interactive')).toBe(true);
    expect(sem.acquire('b', 'background')).toBe(true);
    expect(sem.acquire('c', 'interactive')).toBe(false); // at cap=2
    const raw = JSON.parse(fs.readFileSync(hp, 'utf-8'));
    // disabled → no `lane` field on any holder (clean rollback / mixed-version safety)
    for (const h of raw.holders) expect(h.lane).toBeUndefined();
    const st = sem.status();
    expect(st.interactivePriority.enabled).toBe(false);
    expect(st.liveInteractive).toBe(0);
    expect(st.liveBackground).toBe(2);
  });
});

describe('HostSpawnSemaphore — interactive priority ON (symmetric reserve)', () => {
  it('interactive admitted when background fills the contended band but interactive reserve is free', () => {
    // N=8, Ri=2, Rb=2 → background capped at N-Ri=6; interactive reserve (2) free.
    const sem = makeSem(8, { enabled: true, ri: 2, rb: 2 });
    for (let i = 0; i < 6; i++) expect(sem.acquire(`bg${i}`, 'background')).toBe(true);
    // 7th background refused (liveBackground=6 == N-Ri), even though total=6 < 8
    expect(sem.acquire('bg6', 'background')).toBe(false);
    // interactive still admitted into its reserve
    expect(sem.acquire('int0', 'interactive')).toBe(true);
    expect(sem.acquire('int1', 'interactive')).toBe(true);
    // 3rd interactive refused: liveInteractive=2 == N-Rb=6? no — liveInteractive(2) < 6,
    // but total is now 8 → OOM floor refuses.
    expect(sem.acquire('int2', 'interactive')).toBe(false);
    const st = sem.status();
    expect(st.liveBackground).toBe(6);
    expect(st.liveInteractive).toBe(2);
    expect(st.liveHolders).toBe(8);
  });

  it('symmetric: background reserve protected from an interactive flood', () => {
    // interactive capped at N-Rb=6; background reserve (2) stays free.
    const sem = makeSem(8, { enabled: true, ri: 2, rb: 2 });
    for (let i = 0; i < 6; i++) expect(sem.acquire(`int${i}`, 'interactive')).toBe(true);
    expect(sem.acquire('int6', 'interactive')).toBe(false); // liveInteractive=6 == N-Rb
    expect(sem.acquire('bg0', 'background')).toBe(true); // background reserve protected
    expect(sem.acquire('bg1', 'background')).toBe(true);
  });

  it('OOM floor is unconditional: total < N refuses BOTH lanes regardless of reserve', () => {
    const sem = makeSem(3, { enabled: true, ri: 1, rb: 1 });
    expect(sem.acquire('a', 'interactive')).toBe(true);
    expect(sem.acquire('b', 'background')).toBe(true);
    expect(sem.acquire('c', 'interactive')).toBe(true); // total=3 == N
    expect(sem.acquire('d', 'interactive')).toBe(false); // OOM floor
    expect(sem.acquire('e', 'background')).toBe(false);
  });
});

describe('HostSpawnSemaphore — garbage/missing lane is background, never dropped (OOM floor safety)', () => {
  it('a holder with a garbage lane value is counted as background and NOT dropped', () => {
    const hp = tmpHolders();
    // Seed a holders file with a malformed lane + a missing lane.
    fs.writeFileSync(
      hp,
      JSON.stringify({
        version: 1,
        holders: [
          { id: 'g1', pid: process.pid, hostname: os.hostname(), heartbeat: Date.now(), lane: 'frobnicate' },
          { id: 'g2', pid: process.pid, hostname: os.hostname(), heartbeat: Date.now() },
        ],
      }),
    );
    const sem = makeSem(8, { enabled: true, ri: 2, rb: 2 }, hp);
    const st = sem.status();
    // both garbage/missing-lane holders survive (never dropped) and count as background
    expect(st.liveHolders).toBe(2);
    expect(st.liveInteractive).toBe(0);
    expect(st.liveBackground).toBe(2);
  });
});
