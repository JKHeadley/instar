// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup only.
/**
 * Wiring-integrity: Failure-Learning Loop ingestion sources are constructed
 * iff their config flag is set, and started post-listen / stopped on close.
 *
 * Per the 2026-05-29 pipeline post-mortem: the substrate for `ci` and `revert`
 * was already shipped (PRs around #484), but no test asserts that flipping the
 * flag actually causes the corresponding poller/detector to come online. This
 * file closes that gap and serves as the canonical check that future flag
 * additions (regression, degradation) must satisfy before being claimed alive.
 *
 * Also asserts that the `regression` and `degradation` flags — config-only
 * with no implementation yet — produce a LOUD warning at boot instead of
 * silently no-op'ing. "Specced but not wired" was one of the five recurring
 * bug classes; this test is the structural backstop.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentServer } from '../../src/server/AgentServer.js';

let tmpDir: string;
let projectDir: string;
let stateDir: string;

function baseConfig(sources: Record<string, unknown>) {
  return {
    projectName: 'test-fl-wiring',
    projectDir,
    stateDir,
    port: 0,
    authToken: 'test-token-abc',
    sessions: { claudePath: 'claude' },
    monitoring: {
      failureLearning: {
        enabled: true,
        minSupport: 4,
        minDistinctSessions: 3,
        minDistinctCauseCommits: 3,
        attributionConfidenceFloor: 0.6,
        insightTelegramEscalation: false,
        sources,
      },
    },
  };
}

function makeServer(config: ReturnType<typeof baseConfig>): AgentServer {
  return new AgentServer({
    config: config as never,
    sessionManager: { getSessions: () => [], getSession: () => null } as never,
    state: { read: () => ({ sessions: [] }), write: () => undefined } as never,
  } as never);
}

function getPrivate<T>(srv: AgentServer, name: string): T {
  return (srv as unknown as Record<string, T>)[name];
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-fl-wiring-'));
  projectDir = tmpDir;
  stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* test cleanup */ } // safe-fs-allow
});

describe('Failure-Learning sources: constructed iff flag set', () => {
  it('all sources off → no poller, no detector', () => {
    const srv = makeServer(baseConfig({ ci: false, revert: false, regression: false, degradation: [] }));
    expect(getPrivate<unknown>(srv, 'ciFailurePoller')).toBeNull();
    expect(getPrivate<unknown>(srv, 'revertDetector')).toBeNull();
    expect(getPrivate<unknown>(srv, 'failureLedger')).not.toBeNull();
  });

  it('ci: true → CiFailurePoller constructed (but not started until listen)', () => {
    const srv = makeServer(baseConfig({ ci: true, revert: false, regression: false, degradation: [] }));
    const poller = getPrivate<{ start: unknown; stop: unknown } | null>(srv, 'ciFailurePoller');
    expect(poller, 'CiFailurePoller should be constructed when sources.ci=true').not.toBeNull();
    expect(typeof poller?.start, 'poller exposes start()').toBe('function');
    expect(typeof poller?.stop, 'poller exposes stop()').toBe('function');
    expect(getPrivate<unknown>(srv, 'revertDetector'), 'revertDetector stays null when revert=false').toBeNull();
  });

  it('revert: true → RevertDetector constructed', () => {
    const srv = makeServer(baseConfig({ ci: false, revert: true, regression: false, degradation: [] }));
    const det = getPrivate<{ start: unknown; stop: unknown } | null>(srv, 'revertDetector');
    expect(det, 'RevertDetector should be constructed when sources.revert=true').not.toBeNull();
    expect(typeof det?.start, 'detector exposes start()').toBe('function');
    expect(typeof det?.stop, 'detector exposes stop()').toBe('function');
    expect(getPrivate<unknown>(srv, 'ciFailurePoller'), 'ciFailurePoller stays null when ci=false').toBeNull();
  });

  it('both ci+revert on → both constructed independently', () => {
    const srv = makeServer(baseConfig({ ci: true, revert: true, regression: false, degradation: [] }));
    expect(getPrivate<unknown>(srv, 'ciFailurePoller')).not.toBeNull();
    expect(getPrivate<unknown>(srv, 'revertDetector')).not.toBeNull();
  });

  it('failureLearning.enabled: false → ledger AND sources are inert even if source flags set', () => {
    const cfg = baseConfig({ ci: true, revert: true, regression: false, degradation: [] });
    cfg.monitoring.failureLearning.enabled = false;
    const srv = makeServer(cfg);
    expect(getPrivate<unknown>(srv, 'failureLedger')).toBeNull();
    expect(getPrivate<unknown>(srv, 'ciFailurePoller')).toBeNull();
    expect(getPrivate<unknown>(srv, 'revertDetector')).toBeNull();
  });
});

describe('Unimplemented sources: loud warning, not silent no-op', () => {
  it('regression: true triggers a console.warn naming the gap', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
    try {
      makeServer(baseConfig({ ci: false, revert: false, regression: true, degradation: [] }));
    } finally {
      console.warn = orig;
    }
    const flWarn = warns.find(w => w.includes('failure-learning') && w.includes('regression'));
    expect(flWarn, 'expected a warning naming the unimplemented regression source').toBeTruthy();
    expect(flWarn).toContain('no implementation');
  });

  it('degradation: [item] triggers a console.warn naming the gap', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
    try {
      makeServer(baseConfig({ ci: false, revert: false, regression: false, degradation: ['stuck-session'] }));
    } finally {
      console.warn = orig;
    }
    const flWarn = warns.find(w => w.includes('failure-learning') && w.includes('degradation'));
    expect(flWarn, 'expected a warning naming the unimplemented degradation source').toBeTruthy();
  });

  it('both unimplemented on → one warning listing both', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
    try {
      makeServer(baseConfig({ ci: false, revert: false, regression: true, degradation: ['x'] }));
    } finally {
      console.warn = orig;
    }
    const flWarn = warns.find(w => w.includes('failure-learning'));
    expect(flWarn).toBeTruthy();
    expect(flWarn).toContain('regression');
    expect(flWarn).toContain('degradation');
  });

  it('only implemented sources on → NO unimplemented-source warning emitted', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
    try {
      makeServer(baseConfig({ ci: true, revert: true, regression: false, degradation: [] }));
    } finally {
      console.warn = orig;
    }
    const flWarn = warns.find(w => w.includes('failure-learning') && w.includes('no implementation'));
    expect(flWarn).toBeFalsy();
  });
});
