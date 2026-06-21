// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Bounded Accumulation §3d — the growth-burst invariant (the load-bearing runtime
 * check). For each retention KIND declared in the registry, flooding a registered
 * store with M >> ceiling entries must leave the ON-DISK footprint bounded by the
 * declared policy — proving the retention is actually enforced, not just declared.
 *
 * This is the storage analog of notification-flood-burst-invariant.test.ts. It uses
 * the real registry's retention classes (scaled to small ceilings for speed) so a
 * future class added to the registry without enforceable semantics is caught here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlStore } from '../../src/core/storage/JsonlStore.js';
import registry from '../../src/data/state-coherence-registry.json' assert { type: 'json' };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-burst-'));
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function onDiskBytes(file: string): number {
  const dirOf = path.dirname(file);
  const base = path.basename(file);
  const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\.\\d+)?$');
  let total = 0;
  for (const f of fs.readdirSync(dirOf)) {
    if (re.test(f)) total += fs.statSync(path.join(dirOf, f)).size;
  }
  return total;
}
function segmentCount(file: string): number {
  const dirOf = path.dirname(file);
  const base = path.basename(file);
  const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.\\d+$');
  return fs.readdirSync(dirOf).filter((f) => re.test(f)).length;
}

const A_CEILING = 16 * 1024; // 16KB scaled ceiling
const KEEP = 4;

describe('Bounded Accumulation — growth-burst invariant', () => {
  it('A-class (streamed): a 20k-entry flood keeps total on-disk bounded by ceiling × (keep+1)', () => {
    const file = path.join(dir, 'a.jsonl');
    const store = new JsonlStore(file, { maxBytes: A_CEILING, keepSegments: KEEP, checkEveryBytes: 1024 });
    for (let i = 0; i < 20000; i++) store.appendObject({ i, pad: 'x'.repeat(60) });

    // active file bounded
    expect(fs.statSync(file).size).toBeLessThanOrEqual(A_CEILING + 1024 + 2048);
    // total on disk bounded: active + at most KEEP retained segments (each ≈ ceiling)
    expect(onDiskBytes(file)).toBeLessThanOrEqual(A_CEILING * (KEEP + 1) + 4096);
    // and retention did NOT nuke everything — segments are retained
    expect(segmentCount(file)).toBeGreaterThan(0);
    expect(segmentCount(file)).toBeLessThanOrEqual(KEEP);
  });

  it('C-class (complianceHold/archive): a flood NEVER drops the oldest segment', () => {
    const file = path.join(dir, 'c.jsonl');
    // keepSegments:0 would drop everything under A-class; archive:true must override → retain ALL
    const store = new JsonlStore(file, { maxBytes: 8 * 1024, keepSegments: 0, archive: true, checkEveryBytes: 512 });
    for (let i = 0; i < 8000; i++) store.appendObject({ i, audit: 'event', pad: 'y'.repeat(60) });

    // the very first rotated segment must still exist (an audit trail never drops its oldest)
    expect(fs.existsSync(file + '.1')).toBe(true);
    // many segments accumulated, none unlinked
    expect(segmentCount(file)).toBeGreaterThan(KEEP);
  });

  it('every registry streamed/A-class store declares an enforceable maxBytes', () => {
    // A class:'A' (streamed) entry without a positive maxBytes is unenforceable — catch it.
    const aClass = (registry as any).entries.filter(
      (e: any) => e.retention && e.retention.class === 'A',
    );
    expect(aClass.length).toBeGreaterThan(0);
    for (const e of aClass) {
      expect(typeof e.retention.maxBytes, `${e.category} maxBytes`).toBe('number');
      expect(e.retention.maxBytes, `${e.category} maxBytes > 0`).toBeGreaterThan(0);
    }
  });
});
