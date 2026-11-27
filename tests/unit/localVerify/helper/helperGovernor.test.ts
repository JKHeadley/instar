/**
 * Tier-1: the owner-first governor (docs/specs/local-verify-borrowed-unit-slices.md, E) — owner cores
 * exclude the sandbox's own CPU, the reserve, the memory ceiling, memory pressure, the battery
 * setting, deadline, cancel, pause, a stale Windows signal; the pressure hold-off; and the Windows
 * owner-signal parser (fresh, stale, malformed, forged owner) and the macOS readers' parsers.
 */
import { describe, expect, it } from 'vitest';
import {
  MacOwnerLoadReader, helperDriveFreeBytesFromSignal, PressureHoldOff, decideGovernor, parseMacPressureLevel, parseOwnerSignal, parsePmsetBattery, parseVirtualizationCpu, stopsSandbox, windowsPressure,
  type GovernorCtx, type OwnerSample,
} from '../../../../src/localVerify/helper/governor.js';

const NOW = 1_000_000;
const ctx = (o: Partial<GovernorCtx> = {}): GovernorCtx => ({ cpus: 8, reserveCores: 4, stopOnBattery: true, workerCeiling: 8, now: NOW, deadlineAt: NOW + 60_000, cancelled: false, paused: false, ...o });
const sample = (o: Partial<OwnerSample> = {}): OwnerSample => ({ ncpu: 16, hostBusyCores: 6, sandboxBusyCores: 4, memoryPressure: 'normal', onBattery: false, ...o });

describe('decideGovernor', () => {
  it('owner cores are host load minus the sandbox\'s own CPU; workers = min(cpus, ncpu − reserve − owner, ceiling)', () => {
    expect(decideGovernor(sample(), ctx())).toEqual({ ownerCores: 2, workersAllowed: 8, stop: null });
    expect(decideGovernor(sample({ hostBusyCores: 9, sandboxBusyCores: 1 }), ctx())).toEqual({ ownerCores: 8, workersAllowed: 4, stop: null });
    expect(decideGovernor(sample({ hostBusyCores: 2, sandboxBusyCores: 0 }), ctx({ workerCeiling: 3 })).workersAllowed).toBe(3);
    // The sandbox's load is never counted as the owner's: same host load, more of it the sandbox's.
    expect(decideGovernor(sample({ hostBusyCores: 12, sandboxBusyCores: 0 }), ctx()).stop).toBe('zero-workers');
    expect(decideGovernor(sample({ hostBusyCores: 12, sandboxBusyCores: 8 }), ctx()).workersAllowed).toBe(8);
  });

  it('always stops on pause, cancel, deadline; on memory pressure warn or worse or unknown; on an unreadable sample', () => {
    expect(decideGovernor(sample(), ctx({ paused: true })).stop).toBe('paused');
    expect(decideGovernor(sample(), ctx({ cancelled: true })).stop).toBe('cancelled');
    expect(decideGovernor(sample(), ctx({ deadlineAt: NOW })).stop).toBe('deadline');
    expect(decideGovernor(sample({ memoryPressure: 'warn' }), ctx()).stop).toBe('memory-pressure');
    expect(decideGovernor(sample({ memoryPressure: 'critical' }), ctx()).stop).toBe('memory-pressure');
    expect(decideGovernor(sample({ memoryPressure: null }), ctx()).stop).toBe('memory-pressure');
    expect(decideGovernor(null, ctx()).stop).toBe('sample-unreadable');
  });

  it('battery stops unless the owner turned stopOnBattery off; unknown power counts as battery', () => {
    expect(decideGovernor(sample({ onBattery: true }), ctx()).stop).toBe('battery');
    expect(decideGovernor(sample({ onBattery: null }), ctx()).stop).toBe('battery');
    expect(decideGovernor(sample({ onBattery: true }), ctx({ stopOnBattery: false })).stop).toBeNull();
  });

  it('Windows: a stale or missing owner signal never runs', () => {
    expect(decideGovernor(sample({ signalFresh: false }), ctx()).stop).toBe('owner-signal-stale');
    expect(decideGovernor(sample({ signalFresh: true }), ctx()).stop).toBeNull();
  });

  it('memory pressure, battery and pause stop the sandbox itself; deadline and zero workers do not', () => {
    expect(['memory-pressure', 'battery', 'paused'].every((s) => stopsSandbox(s as never))).toBe(true);
    expect(['deadline', 'zero-workers', 'cancelled'].some((s) => stopsSandbox(s as never))).toBe(false);
  });
});

describe('PressureHoldOff', () => {
  it('holds 5 min of normal memory after a pressure stop, doubling per repeat within an hour, capped at 1 h', () => {
    const h = new PressureHoldOff();
    let t = 0;
    expect(h.holding(t)).toBe(false);
    h.noteStop(t);
    expect(h.holding(t)).toBe(true);
    h.noteSample('normal', t);
    t += 5 * 60_000 - 1;
    expect(h.holding(t)).toBe(true);
    t += 1;
    expect(h.holding(t)).toBe(false);
    h.noteStop(t);
    expect(h.currentHoldMs()).toBe(10 * 60_000);
    h.noteSample('warn', t);
    h.noteSample('normal', t + 1);
    expect(h.holding(t + 1 + 10 * 60_000 - 1)).toBe(true);
    for (let i = 0; i < 6; i++) h.noteStop(t + i);
    expect(h.currentHoldMs()).toBe(60 * 60_000);
    // Stops older than an hour no longer double it.
    const later = new PressureHoldOff();
    later.noteStop(0);
    later.noteStop(61 * 60_000);
    expect(later.currentHoldMs()).toBe(5 * 60_000);
  });
});

describe('Windows owner signal', () => {
  const uid = 1000;
  const good = (o: Record<string, unknown> = {}) => JSON.stringify({ v: 1, writer: 'instar-owner-signal', writtenAtMs: NOW - 3_000, ncpu: 8, cpuPercent: 25, availableMemMb: 8000, totalMemMb: 16000, onBattery: false, ...o });
  it('fresh', () => {
    const r = parseOwnerSignal(good(), { uid, mode: 0o100644 }, { now: NOW, uid });
    expect(r).toMatchObject({ ok: true, fresh: true, signal: { ncpu: 8, cpuPercent: 25 } });
  });
  it('stale (older than 10 s), and from the future', () => {
    expect(parseOwnerSignal(good({ writtenAtMs: NOW - 10_001 }), { uid, mode: 0o100644 }, { now: NOW, uid })).toEqual({ ok: false, reason: 'stale' });
    expect(parseOwnerSignal(good({ writtenAtMs: NOW + 5_000 }), { uid, mode: 0o100644 }, { now: NOW, uid })).toEqual({ ok: false, reason: 'stale' });
  });
  it('malformed', () => {
    expect(parseOwnerSignal('{', { uid, mode: 0o100644 }, { now: NOW, uid })).toEqual({ ok: false, reason: 'malformed' });
    expect(parseOwnerSignal(good({ writer: 'someone' }), { uid, mode: 0o100644 }, { now: NOW, uid })).toEqual({ ok: false, reason: 'malformed' });
    expect(parseOwnerSignal(good({ cpuPercent: 140 }), { uid, mode: 0o100644 }, { now: NOW, uid })).toEqual({ ok: false, reason: 'malformed' });
    expect(parseOwnerSignal(null, null, { now: NOW, uid })).toEqual({ ok: false, reason: 'missing' });
  });
  it('forged owner: another user\'s file, or one others can write', () => {
    expect(parseOwnerSignal(good(), { uid: 61002, mode: 0o100644 }, { now: NOW, uid })).toEqual({ ok: false, reason: 'forged-owner' });
    expect(parseOwnerSignal(good(), { uid, mode: 0o100666 }, { now: NOW, uid })).toEqual({ ok: false, reason: 'forged-owner' });
  });
  it('pressure from available memory', () => {
    const s = { writtenAtMs: 0, ncpu: 8, cpuPercent: 0, onBattery: false, totalMemMb: 1000 };
    expect(windowsPressure({ ...s, availableMemMb: 400 })).toBe('normal');
    expect(windowsPressure({ ...s, availableMemMb: 90 })).toBe('warn');
    expect(windowsPressure({ ...s, availableMemMb: 40 })).toBe('critical');
  });
});

describe('macOS readers', () => {
  it('parses the VM process CPU, the kernel pressure level and the power source', () => {
    expect(parseVirtualizationCpu(' 250.0 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine\n  12.0 /Applications/Safari.app/x\n')).toBe(2.5);
    expect(parseMacPressureLevel('1\n')).toBe('normal');
    expect(parseMacPressureLevel('2')).toBe('warn');
    expect(parseMacPressureLevel('4')).toBe('critical');
    expect(parseMacPressureLevel('x')).toBeNull();
    expect(parsePmsetBattery("Now drawing from 'Battery Power'\n")).toBe(true);
    expect(parsePmsetBattery("Now drawing from 'AC Power'\n")).toBe(false);
    expect(parsePmsetBattery('')).toBeNull();
  });
});

describe('second-pass: readers', () => {
  it('Mac: the first sample after a start is a real reading (a priming snapshot one second earlier), not unreadable', async () => {
    let t = 0;
    let busy = 0;
    const cpus = () => Array.from({ length: 4 }, () => ({ model: 'x', speed: 1, times: { user: busy, nice: 0, sys: 0, idle: 1000 + t - busy, irq: 0 } }));
    const exec = async (cmd: string) => (cmd === 'ps' ? '  50.0 com.apple.Virtualization.VirtualMachine\n' : cmd === 'sysctl' ? '1\n' : "Now drawing from 'AC Power'\n");
    const r = new MacOwnerLoadReader({ exec, cpus, now: () => t, sleep: async (ms) => { t += ms; busy += ms / 2; } });
    const s = await r.sample();
    expect(s).not.toBeNull();
    expect(s!.hostBusyCores).toBeCloseTo(2, 5); // half of each of 4 cores over the priming second
    expect(s!.sandboxBusyCores).toBe(0.5);
  });

  it('Windows host disk: free bytes of the helper distro\'s drive come from a fresh owner signal; a signal without them is unknown', () => {
    const uid = 1000;
    const base = { v: 1, writer: 'instar-owner-signal', writtenAtMs: NOW - 1_000, ncpu: 8, cpuPercent: 10, availableMemMb: 8000, totalMemMb: 16000, onBattery: false };
    const read = (o: Record<string, unknown>) => parseOwnerSignal(JSON.stringify({ ...base, ...o }), { uid, mode: 0o100644 }, { now: NOW, uid });
    expect(helperDriveFreeBytesFromSignal(read({ helperDriveFreeBytes: 123_000_000_000 }))).toBe(123_000_000_000);
    expect(helperDriveFreeBytesFromSignal(read({}))).toBeNull();
    expect(helperDriveFreeBytesFromSignal(read({ helperDriveFreeBytes: 5, writtenAtMs: NOW - 60_000 }))).toBeNull();
    expect(read({ helperDriveFreeBytes: -1 })).toEqual({ ok: false, reason: 'malformed' });
  });
});
