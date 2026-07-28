// safe-fs-allow: test file — tmpdir fixtures only.

/**
 * Tier-1 — the process-global anchor + single-mint registry (companion §5.3;
 * spec ADV8-1/ADV9-1/SC9-1).
 *
 * Covers: a DUAL-LOADED second copy of the governor module colliding on the
 * process-global mint key — the losing copy's mints fail loudly (dead-handle
 * posture, mint-collision audit row) and there is never a second independent
 * budget; the ATTACH case — a later claimant attaches to the SAME shared
 * state, never re-initializes, never starts a second flusher; the test-only
 * dispose/reset lifecycle (key-salt override).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { KEY_SALT_OVERRIDE, resetAnchorForTest, getAnchor, mintController, claimSharedState } from '../../src/monitoring/selfaction/anchor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sag-anchor-'));
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for(KEY_SALT_OVERRIDE)];
  resetAnchorForTest();
  vi.resetModules();
  SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/self-action-governor-anchor.test.ts' });
});

describe('single-mint registry', () => {
  it('a duplicate mint of the SAME controller id COLLIDES loudly (dead handle, never process-fatal)', () => {
    resetAnchorForTest();
    const collided: string[] = [];
    getAnchor().onMintCollision = (id) => collided.push(id);
    expect(mintController('age-kill-backoff').ok).toBe(true);
    const second = mintController('age-kill-backoff');
    expect(second.ok).toBe(false);
    expect(collided).toEqual(['age-kill-backoff']);
  });

  it('claimSharedState: the FIRST claimant initializes; a LATER claimant ATTACHES to the same state', () => {
    resetAnchorForTest();
    let inits = 0;
    const first = claimSharedState(() => {
      inits++;
      return { marker: 'shared' };
    });
    expect(first.role).toBe('initialized');
    const second = claimSharedState(() => {
      inits++;
      return { marker: 'second-copy' };
    });
    expect(second.role).toBe('attached');
    expect(inits).toBe(1); // NEVER re-initialized
    expect(second.state).toBe(first.state); // read-write on the SAME state
  });
});

describe('dual-load collision (ADV8-1 — two module copies, one global anchor)', () => {
  it('two FRESHLY-IMPORTED module copies share ONE anchor via the key-salt override: the losing mint is dead, no second budget, no second flusher', async () => {
    // Pin the two copies onto a SHARED global key (production shape) — the
    // per-graph test isolation is deliberately bypassed by the salt override.
    (globalThis as Record<symbol, unknown>)[Symbol.for(KEY_SALT_OVERRIDE)] = `dual-${Date.now()}`;

    vi.resetModules();
    const copyA = await import('../../src/monitoring/selfaction/governor.js');
    vi.resetModules();
    const copyB = await import('../../src/monitoring/selfaction/governor.js');
    expect(copyB).not.toBe(copyA); // genuinely two module instances

    const deps = {
      stateDir: tmp,
      readEmergencyDisable: () => false,
      readClassesConfig: () => ({ 'age-kill-backoff': { mode: 'enforce' } }),
    };
    const coreA = copyA.initSelfActionGovernor(deps);
    const coreB = copyB.initSelfActionGovernor(deps);
    // The later claimant ATTACHED — its init did not re-initialize (the
    // shared budget below proves it) and did not start a second flusher
    // (role visible on the core).
    expect(coreA.role).toBe('initialized');
    expect(coreB.role).toBe('attached');

    // Copy A mints the controller; copy B's SAME mint collides → dead handle.
    const hA = copyA.governor.for('age-kill-backoff');
    const hB = copyB.governor.for('age-kill-backoff');
    expect(hA.isDead()).toBe(false);
    expect(hB.isDead()).toBe(true);

    // ONE budget: copy A consumes the per-target ceiling; the ceiling state is
    // SHARED — there is never a second independent full-budget counter.
    const t = { key: 'session:s1', classId: 'session', keyIsVolatile: false };
    for (let i = 0; i < 5; i++) expect(hA.admitSync(t).outcome).toBe('allow');
    expect(hA.admitSync(t).outcome).toBe('queue');
    // The dead handle resolves through the per-class fail direction
    // (age-kill = relief, open-audited) — LOUD, never a fresh budget.
    const bVerdict = hB.admitSync(t);
    expect(bVerdict.reason).toBe('errored-open');
    // The collision landed a mint-collision audit row on the shared state.
    expect(coreA.readAllAuditRowsForTest().some((r) => r.type === 'mint-collision')).toBe(true);

    copyA.resetSelfActionGovernorModuleForTest();
    copyB.resetSelfActionGovernorModuleForTest();
  });
});

describe('test lifecycle (SC9-1)', () => {
  it('resetAnchorForTest releases mints so a fixture can re-instantiate within one process', () => {
    resetAnchorForTest();
    expect(mintController('re-mintable').ok).toBe(true);
    expect(mintController('re-mintable').ok).toBe(false);
    resetAnchorForTest();
    expect(mintController('re-mintable').ok).toBe(true);
  });

  it('refuses outside a test environment unless forced', () => {
    const savedVitest = process.env.VITEST;
    const savedNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => resetAnchorForTest()).toThrow(/test-only/);
      expect(() => resetAnchorForTest(true)).not.toThrow();
    } finally {
      if (savedVitest !== undefined) process.env.VITEST = savedVitest;
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
    }
  });
});
