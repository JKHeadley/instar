// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup, no production path
/**
 * driveFollowMeEnrollment — the connector's orchestration heart. Uses the REAL
 * single-flight + outbox stores (temp files) with a mocked wizard/surface/revocation,
 * so the integration logic is proven: point-of-use deny, single-flight dedup, the
 * no-silent-stall failure surfacing, and outbox idempotency.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountFollowMeSingleFlight } from '../../src/coordination/AccountFollowMeSingleFlight.js';
import { AccountFollowMeOperatorOutbox } from '../../src/coordination/AccountFollowMeOperatorOutbox.js';
import { driveFollowMeEnrollment, type DriveEnrollDeps, type LoginArtifact } from '../../src/coordination/driveFollowMeEnrollment.js';

let dir: string;
let clock = 1_000_000;
const LOGIN: LoginArtifact = { verificationUrl: 'https://claude.ai/device', userCode: 'WXYZ-1234', ttlMs: 900_000 };

const INPUT = {
  mandateId: 'mandate-1',
  expiresAt: new Date(9_000_000_000_000).toISOString(),
  bounds: { accountId: 'adriana', targetMachineId: 'm_4cbc' },
  requested: { accountId: 'adriana', targetMachineId: 'm_4cbc' },
  eventId: 'evt-1',
};

function makeDeps(over: Partial<DriveEnrollDeps> = {}): { deps: DriveEnrollDeps; surfaced: any[] } {
  const surfaced: any[] = [];
  const deps: DriveEnrollDeps = {
    singleFlight: new AccountFollowMeSingleFlight({ filePath: path.join(dir, 'sf.json'), now: () => clock }),
    outbox: new AccountFollowMeOperatorOutbox({ filePath: path.join(dir, 'ob.json'), now: () => clock }),
    isRevoked: () => false,
    startEnrollment: async () => LOGIN,
    surfaceToOperator: async (m) => { surfaced.push(m); return true; },
    now: () => clock,
    frontingMachineId: 'm_cc2e',
    holder: 'run-A',
    claimTtlMs: 60_000,
    loginTtlMs: 900_000,
    ...over,
  };
  return { deps, surfaced };
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-')); clock = 1_000_000; });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('driveFollowMeEnrollment', () => {
  it('happy path → login-issued + exactly one login-link message', async () => {
    const { deps, surfaced } = makeDeps();
    const r = await driveFollowMeEnrollment(deps, INPUT);
    expect(r).toMatchObject({ ok: true, state: 'login-issued' });
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]).toMatchObject({ kind: 'login-link', login: LOGIN });
  });

  it('REVOKED mandate → denied, no enroll, no message (the #3 critical)', async () => {
    let enrollCalled = false;
    const { deps, surfaced } = makeDeps({ isRevoked: () => true, startEnrollment: async () => { enrollCalled = true; return LOGIN; } });
    const r = await driveFollowMeEnrollment(deps, INPUT);
    expect(r).toMatchObject({ ok: false, state: 'denied', reason: 'revoked' });
    expect(enrollCalled).toBe(false);
    expect(surfaced).toHaveLength(0);
  });

  it('EXPIRED mandate → denied, no enroll', async () => {
    const { deps } = makeDeps();
    const r = await driveFollowMeEnrollment(deps, { ...INPUT, expiresAt: new Date(500).toISOString() });
    expect(r).toMatchObject({ ok: false, state: 'denied', reason: 'expired' });
  });

  it('single-flight: a concurrent second drive is refused (no duplicate login)', async () => {
    const { deps } = makeDeps();
    // First drive holds enroll-in-flight; simulate a second drive (different holder) before completion.
    const sf = deps.singleFlight;
    sf.tryClaim({ accountId: 'adriana', targetMachineId: 'm_4cbc', frontingMachineId: 'm_cc2e', mandateId: 'mandate-1', holder: 'run-A', ttlMs: 60_000 });
    const { deps: deps2, surfaced } = makeDeps({ singleFlight: sf, holder: 'run-B' });
    let enrollCalled = false;
    deps2.startEnrollment = async () => { enrollCalled = true; return LOGIN; };
    const r = await driveFollowMeEnrollment(deps2, INPUT);
    expect(r).toMatchObject({ ok: false, state: 'in-flight' });
    expect(enrollCalled).toBe(false);
    expect(surfaced).toHaveLength(0);
  });

  it('enroll drive THROWS → failed + exactly one honest failure message (NO silent stall)', async () => {
    const { deps, surfaced } = makeDeps({ startEnrollment: async () => { throw new Error('device-code flow unreachable'); } });
    const r = await driveFollowMeEnrollment(deps, INPUT);
    expect(r).toMatchObject({ ok: false, state: 'failed' });
    expect((r as any).reason).toContain('device-code');
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]).toMatchObject({ kind: 'failure' });
    // and the ledger records 'failed' (not a silent dangling enroll-in-flight)
    const rec = deps.singleFlight.get('adriana::m_4cbc');
    expect(rec?.state).toBe('failed');
  });

  it('idempotency: a redelivery of the same event does not double-message', async () => {
    const { deps, surfaced } = makeDeps();
    await driveFollowMeEnrollment(deps, INPUT);
    // redelivery: same pair, terminal->re-arm would happen, but the outbox suppresses a duplicate login-issued msg for this state
    // simulate a re-drive that reaches login-issued again with the SAME eventId
    deps.singleFlight.remove('adriana::m_4cbc'); // allow re-claim
    await driveFollowMeEnrollment(deps, INPUT);
    const loginMsgs = surfaced.filter((m) => m.kind === 'login-link');
    expect(loginMsgs).toHaveLength(1); // outbox deduped the second login-issued emit
  });

  it('a surfacing throw does not crash the drive (still returns the outcome)', async () => {
    const { deps } = makeDeps({ surfaceToOperator: async () => { throw new Error('relay down'); } });
    const r = await driveFollowMeEnrollment(deps, INPUT);
    expect(r.ok).toBe(true); // the drive completed; surfacing failure is non-fatal
  });
});
