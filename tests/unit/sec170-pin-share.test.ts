// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * SEC-170 part 1 of 2 (docs/specs/pool-wide-pin-budget.md §3, §4, §6): the agent's 20 unknown-browser
 * PIN guesses per 5 minutes are divided into fixed per-machine shares that sum to 20; a machine may
 * lower its own share at any moment but never raises it on its own.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { canonicalShares, PinShareProvider, registryMembership, AGENT_PIN_BUDGET } from '../../src/core/PinShare.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `m_${String(i).padStart(3, '0')}`);

describe('SEC-170 — canonical division', () => {
  it('N = 1, 2, 3, 5, 20, 21 give 20; 10+10; 7,7,6; 4 each; 1 each; 1 each and one 0 — always 20 in total', () => {
    expect(Object.values(canonicalShares(ids(1)))).toEqual([20]);
    expect(Object.values(canonicalShares(ids(2)))).toEqual([10, 10]);
    expect(Object.values(canonicalShares(ids(3)))).toEqual([7, 7, 6]);
    expect(Object.values(canonicalShares(ids(5)))).toEqual([4, 4, 4, 4, 4]);
    expect(Object.values(canonicalShares(ids(20))).every((v) => v === 1)).toBe(true);
    const t21 = Object.values(canonicalShares(ids(21)));
    expect(t21.filter((v) => v === 1).length).toBe(20);
    expect(t21.filter((v) => v === 0).length).toBe(1);
    for (let n = 1; n <= 40; n++) expect(Object.values(canonicalShares(ids(n))).reduce((a, b) => a + b, 0)).toBe(20);
  });

  it('is independent of input order (every machine computes the same table)', () => {
    expect(canonicalShares(['c', 'a', 'b'])).toEqual(canonicalShares(['b', 'c', 'a']));
  });

  it('adding a machine never raises any existing machine\'s share, for every N up to 40 and every id position', () => {
    for (let n = 1; n <= 40; n++) {
      const base = ids(n).map((x) => `${x}_5`); // gaps so a newcomer can sort anywhere
      const before = canonicalShares(base);
      const slots = ['m_', ...base.map((x) => `${x}x`)]; // before all, and just after each existing id
      for (const nid of slots) {
        const after = canonicalShares([...base, nid]);
        for (const id of base) expect(after[id]).toBeLessThanOrEqual(before[id]);
      }
    }
  });
});

describe('SEC-170 — PinShareProvider', () => {
  let tmp: string;
  let enabled: boolean;
  let membership: { self: string; members: string[] } | null;
  let report: ReturnType<typeof vi.fn>;
  const make = () => new PinShareProvider({ stateDir: tmp, enabled: () => enabled, membership: () => membership });
  const file = () => path.join(tmp, 'state', 'pin-share.json');
  const prev = () => path.join(tmp, 'state', 'pin-share.prev.json');

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec170-share-'));
    enabled = true;
    membership = { self: 'm_a', members: ['m_a', 'm_b', 'm_c', 'm_d', 'm_e'] };
    report = vi.fn();
    vi.spyOn(DegradationReporter, 'getInstance').mockReturnValue({ report } as never);
  });
  afterEach(() => { vi.restoreAllMocks(); SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/sec170-pin-share.test.ts' }); });

  it('switch off: 20, and nothing is written', () => {
    enabled = false;
    expect(make().share()).toBe(AGENT_PIN_BUDGET);
    expect(fs.existsSync(file())).toBe(false);
  });

  it('never paired (no identity): 20', () => {
    membership = registryMembership({ hasIdentity: () => false, loadIdentity: () => ({ machineId: 'x' }), loadRegistry: () => ({ machines: {} }) })();
    expect(make().share()).toBe(20);
  });

  it('first table: five machines give 4, stored durably in both copies', () => {
    expect(make().share()).toBe(4);
    for (const f of [file(), prev()]) expect(JSON.parse(fs.readFileSync(f, 'utf-8')).applied).toBe(4);
  });

  it('a larger membership lowers the share at once and stores it', () => {
    const p = make();
    expect(p.share()).toBe(4);
    membership = { self: 'm_a', members: [...membership!.members, 'm_f', 'm_g', 'm_h', 'm_i', 'm_j'] };
    p.invalidate();
    expect(p.share()).toBe(2);
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8')).applied).toBe(2);
  });

  it('a retirement never raises the share on its own (raises need agreement: part 2)', () => {
    const p = make();
    expect(p.share()).toBe(4);
    membership = { self: 'm_a', members: ['m_a', 'm_b'] };
    p.invalidate();
    expect(p.share()).toBe(4);
    expect(make().share()).toBe(4); // and not after a restart either
  });

  it('a damaged primary copy is recovered from the second copy, and repaired', () => {
    make().share();
    fs.writeFileSync(file(), '{not json');
    membership = { self: 'm_a', members: ['m_a', 'm_b'] }; // would compute 10 if it recomputed
    expect(make().share()).toBe(4);
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8')).applied).toBe(4);
  });

  it('both copies damaged: share 0 (refuse new browsers) and one degradation report', () => {
    make().share();
    fs.writeFileSync(file(), 'x');
    fs.writeFileSync(prev(), 'y');
    const p = make();
    expect(p.share()).toBe(0);
    expect(p.state().basis).toBe('records-lost');
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ feature: 'PinBudget.recordsLost' }));
  });

  it('unknown membership keeps the stored share and never raises', () => {
    make().share();
    membership = null;
    expect(make().share()).toBe(4);
  });

  it('registryMembership counts active and pending entries, not revoked ones', () => {
    const m = registryMembership({
      hasIdentity: () => true,
      loadIdentity: () => ({ machineId: 'm_a' }),
      loadRegistry: () => ({ machines: { m_a: { status: 'active' }, m_b: { status: 'pending' }, m_c: { status: 'revoked' }, m_d: { status: 'active', revokedAt: '2026-01-01' } } }),
    })();
    expect(m).toEqual({ self: 'm_a', members: ['m_a', 'm_b'] });
  });
});
