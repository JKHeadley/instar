/**
 * The repair admission state of a passkey cell (spec agent-held-google-passkey §3.4, §4, §5.1).
 * Only `ready` admits; every other value is a named refusal. Each boundary is tested both ways.
 */
import { describe, expect, it } from 'vitest';
import { newPasskeyCellHealth, type PasskeyCellHealthRecord } from '../../src/core/PasskeyCellHealth.js';
import { passkeyRepairAdmissionState, type PasskeyRepairAdmissionInput } from '../../src/core/PasskeyRepairAdmission.js';

const NOW = Date.parse('2026-11-27T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;

function health(patch: Partial<PasskeyCellHealthRecord> = {}): PasskeyCellHealthRecord {
  return { ...newPasskeyCellHealth('agent@example.com', 'm_local', NOW - 30 * DAY), state: 'healthy',
    lastReadyAt: new Date(NOW - DAY).toISOString(), lastProofOutcome: 'ready', ...patch };
}
function input(patch: Partial<PasskeyRepairAdmissionInput> = {}): PasskeyRepairAdmissionInput {
  return { granted: true, custody: 'present', chromeGate: 'passed', health: health(), suspended: false, nowMs: NOW, ...patch };
}

describe('passkeyRepairAdmissionState', () => {
  it('admits a granted, held, Chrome-verified cell proven ready recently', () => {
    expect(passkeyRepairAdmissionState(input())).toBe('ready');
    expect(passkeyRepairAdmissionState(input({ custody: 'legacy-adopted' }))).toBe('ready');
    expect(passkeyRepairAdmissionState(input({ health: health({ state: 'degraded' }) }))).toBe('ready');
  });

  it('refuses without an active grant, a usable credential or a passed Chrome gate', () => {
    expect(passkeyRepairAdmissionState(input({ granted: false }))).toBe('unknown');
    expect(passkeyRepairAdmissionState(input({ custody: 'absent' }))).toBe('unknown');
    expect(passkeyRepairAdmissionState(input({ custody: 'unreadable' }))).toBe('unknown');
    expect(passkeyRepairAdmissionState(input({ custody: 'quarantined' }))).toBe('quarantined');
    expect(passkeyRepairAdmissionState(input({ chromeGate: 'unchecked' }))).toBe('chrome-unverified');
    expect(passkeyRepairAdmissionState(input({ chromeGate: 'failed' }))).toBe('chrome-unverified');
  });

  it('refuses a cell that was never proven, or not proven ready inside 21 days', () => {
    expect(passkeyRepairAdmissionState(input({ health: null }))).toBe('unknown');
    expect(passkeyRepairAdmissionState(input({ health: health({ lastReadyAt: null }) }))).toBe('unknown');
    expect(passkeyRepairAdmissionState(input({ health: health({ lastReadyAt: new Date(NOW - 22 * DAY).toISOString() }) }))).toBe('unknown');
    expect(passkeyRepairAdmissionState(input({ health: health({ lastReadyAt: new Date(NOW - 20 * DAY).toISOString() }) }))).toBe('ready');
    // Paused pool-degraded time extends the window, as the health clocks do.
    expect(passkeyRepairAdmissionState(input({ health: health({ lastReadyAt: new Date(NOW - 22 * DAY).toISOString(), pausedMs: 2 * DAY }) }))).toBe('ready');
    expect(passkeyRepairAdmissionState(input({ health: health({ state: 'unverified' }) }))).toBe('unknown');
  });

  it('maps rejected and the terminal states to their own refusals', () => {
    expect(passkeyRepairAdmissionState(input({ health: health({ state: 'rejected' }) }))).toBe('rejected');
    expect(passkeyRepairAdmissionState(input({ health: health({ state: 'breaker-open' }) }))).toBe('breaker-open');
    expect(passkeyRepairAdmissionState(input({ health: health({ state: 'unverified-stopped' }) }))).toBe('unverified-stopped');
    expect(passkeyRepairAdmissionState(input({ health: health({ state: 'security' }) }))).toBe('security');
  });

  it('a suspension stops use, and terminal health still outranks it and custody', () => {
    expect(passkeyRepairAdmissionState(input({ suspended: true }))).toBe('suspended');
    expect(passkeyRepairAdmissionState(input({ suspended: true, health: health({ state: 'security' }) }))).toBe('security');
    expect(passkeyRepairAdmissionState(input({ custody: 'quarantined', health: health({ state: 'security' }) }))).toBe('security');
    expect(passkeyRepairAdmissionState(input({ granted: false, health: health({ state: 'breaker-open' }) }))).toBe('breaker-open');
  });
});

describe('createPasskeyCellStateReader', () => {
  async function setup(opts: { granted?: boolean; major?: number | null; gate?: 'passed' | 'failed' | null } = {}) {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { PasskeyChromeGateStore } = await import('../../src/core/PasskeyChromeGate.js');
    const { createPasskeyCellStateReader } = await import('../../src/core/PasskeyCellStateReader.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-reader-'));
    const gate = new PasskeyChromeGateStore({ stateDir: dir });
    if (opts.gate) gate.write({ chromeMajor: 131, result: opts.gate, checkedAt: new Date(NOW - 5 * DAY).toISOString(), reason: null });
    let majorReads = 0;
    const runs: number[] = [];
    let release: () => void = () => {};
    const reader = createPasskeyCellStateReader({
      hasActiveGrant: () => opts.granted ?? true,
      custodyOf: () => 'present',
      health: () => health(),
      chromeGate: gate,
      readChromeMajor: () => { majorReads += 1; return opts.major === undefined ? 131 : opts.major; },
      runChromeGate: (major) => { runs.push(major); return new Promise<void>((r) => { release = r; }); },
      suspended: () => false,
      now: () => NOW,
    });
    return { reader, runs, majorReads: () => majorReads, release: () => release(), gate, dir };
  }

  it('admits when every store says so, reading the Chrome version once per window', async () => {
    const s = await setup({ gate: 'passed' });
    expect(s.reader({ canonicalEmail: 'Agent@Example.com' })).toBe('ready');
    expect(s.reader({ canonicalEmail: 'agent@example.com' })).toBe('ready');
    expect(s.majorReads()).toBe(1);
    expect(s.runs).toEqual([]);
  });

  it('an unchecked Chrome refuses now and starts exactly one background self-test', async () => {
    const s = await setup();
    expect(s.reader({ canonicalEmail: 'agent@example.com' })).toBe('chrome-unverified');
    expect(s.reader({ canonicalEmail: 'agent@example.com' })).toBe('chrome-unverified');
    expect(s.runs).toEqual([131]);
    s.release();
    await new Promise((r) => setTimeout(r, 0));
    s.gate.write({ chromeMajor: 131, result: 'passed', checkedAt: new Date(NOW - 5 * DAY).toISOString(), reason: null });
    expect(s.reader({ canonicalEmail: 'agent@example.com' })).toBe('ready');
  });

  it('never runs a self-test for an ungranted cell or an unreadable Chrome version', async () => {
    const ungranted = await setup({ granted: false });
    expect(ungranted.reader({ canonicalEmail: 'agent@example.com' })).toBe('unknown');
    expect(ungranted.runs).toEqual([]);
    const noChrome = await setup({ major: null });
    expect(noChrome.reader({ canonicalEmail: 'agent@example.com' })).toBe('chrome-unverified');
    expect(noChrome.runs).toEqual([]);
  });

  it('a failed Chrome gate stays refused and is not re-run automatically', async () => {
    const s = await setup({ gate: 'failed' });
    expect(s.reader({ canonicalEmail: 'agent@example.com' })).toBe('chrome-unverified');
    expect(s.runs).toEqual([]);
  });
});

describe('createPasskeyCellStateReader — risk and throttle pauses', () => {
  it('a paused account is refused like a suspension; an unpaused one is not', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { PasskeyChromeGateStore } = await import('../../src/core/PasskeyChromeGate.js');
    const { createPasskeyCellStateReader } = await import('../../src/core/PasskeyCellStateReader.js');
    const gate = new PasskeyChromeGateStore({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pk-reader-pause-')) });
    gate.write({ chromeMajor: 131, result: 'passed', checkedAt: new Date(NOW - 5 * DAY).toISOString(), reason: null });
    const paused = new Set(['paused@example.com']);
    const reader = createPasskeyCellStateReader({ hasActiveGrant: () => true, custodyOf: () => 'present', health: () => health(), chromeGate: gate,
      readChromeMajor: () => 131, runChromeGate: async () => {}, suspended: () => false, paused: (e) => paused.has(e), now: () => NOW });
    expect(reader({ canonicalEmail: 'Paused@Example.com' })).toBe('suspended');
    expect(reader({ canonicalEmail: 'agent@example.com' })).toBe('ready');
  });
});

describe('the first use on a newly verified Chrome major is a cold proof, not a repair', () => {
  it('a ready proof from before this Chrome passed the gate does not admit; one after it does', () => {
    const passedAt = NOW - 2 * DAY;
    expect(passkeyRepairAdmissionState(input({ chromeVerifiedAtMs: passedAt, health: health({ lastReadyAt: new Date(NOW - 3 * DAY).toISOString() }) }))).toBe('chrome-unverified');
    expect(passkeyRepairAdmissionState(input({ chromeVerifiedAtMs: passedAt, health: health({ lastReadyAt: new Date(NOW - DAY).toISOString() }) }))).toBe('ready');
  });
});
