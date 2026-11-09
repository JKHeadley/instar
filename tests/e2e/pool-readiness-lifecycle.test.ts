/**
 * Pool readiness on the production path: a real MachinePoolRegistry fed the way the presence
 * puller feeds it, a real git repo for the takeover reading, and the wiring in server.ts.
 */
import { describe, expect, it } from 'vitest';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MachinePoolRegistry } from '../../src/core/MachinePoolRegistry.js';
import { computePoolReadiness, PoolReadinessLog, type PoolReadinessDeps, type PoolReadinessReport } from '../../src/core/poolReadiness.js';
import { narrowSessionStatusToPeerCapacity } from '../../src/core/PeerPresencePuller.js';
import { noRemoteTakeoverApplies, takeoverSwitchOnDisk } from '../../src/commands/machine.js';

function deps(reg: MachinePoolRegistry, ids: () => string[]): PoolReadinessDeps {
  return {
    peerIds: ids, capacity: (id) => reg.getCapacityForReport(id), ownChannels: () => ({ telegram: { chatIds: ['-100'] } }),
    durableOwnership: () => true, duplicateCheck: () => ({ enabled: true, substrate: { ready: true } }),
    takeover: () => ({ state: 'unknown', reason: 'only a real takeover proves this' }),
  };
}

describe('pool readiness lifecycle', () => {
  it('a real session-status payload reaches ready, and a coarse beat does not change the report', () => {
    const reg = new MachinePoolRegistry({
      listMachines: () => [{ machineId: 'm_self', nickname: 'A' }, { machineId: 'm_peer', nickname: 'B' }],
      clockSkewToleranceMs: 300_000, failoverThresholdMs: 90_000, selfMachineId: () => 'm_self',
    } as ConstructorParameters<typeof MachinePoolRegistry>[0]);
    const cap = narrowSessionStatusToPeerCapacity({
      selfReportedLastSeen: new Date().toISOString(),
      quotaState: { blocked: false },
      servesChannels: { telegram: { chatIds: ['-100'] } },
      seamlessnessFlags: { ws11DeliverReceive: true },
      loadReport: { bootId: 'b', seq: 1, sampleAgeMs: 100, platform: 'darwin', cores: 8, totalMemBytes: 1e10, loadPerCore: 0.1, sessionsActive: 1, sessionsMax: 10, verdict: 'ok' },
    })!;
    expect(cap).not.toBeNull();
    // The same field set PeerPresencePuller records.
    reg.recordHeartbeat({ machineId: 'm_peer', selfReportedLastSeen: cap.selfReportedLastSeen as string, rttMs: 5, loadReport: cap.loadReport, quotaState: cap.quotaState, seamlessnessFlags: cap.seamlessnessFlags, servesChannels: cap.servesChannels });
    const read = () => computePoolReadiness(deps(reg, () => ['m_peer'])) as PoolReadinessReport;
    const first = read();
    expect(first.peers[0].lines).toMatchObject({ contact: { state: 'ok' }, clock: { state: 'ok' }, capacity: { state: 'ok' }, noStartFailure: { state: 'ok' }, channels: { state: 'ok' }, followUps: { state: 'ok' } });
    expect(first.ready).toBe(true);
    reg.recordHeartbeat({ machineId: 'm_peer', selfReportedLastSeen: new Date().toISOString(), coarseHeartbeat: true });
    expect(read().peers[0].lines).toEqual(first.peers[0].lines);
    // Placement's own view keeps its fail-open rule: the coarse beat still clears it there.
    expect(reg.getCapacity('m_peer')?.quotaState).toBeUndefined();
  });

  it('a registered peer never heard from is not ready, and no line pretends otherwise', () => {
    const reg = new MachinePoolRegistry({
      listMachines: () => [{ machineId: 'm_self', nickname: 'A' }, { machineId: 'm_peer', nickname: 'B' }],
      clockSkewToleranceMs: 300_000, failoverThresholdMs: 90_000, selfMachineId: () => 'm_self',
    } as ConstructorParameters<typeof MachinePoolRegistry>[0]);
    const r = computePoolReadiness(deps(reg, () => ['m_peer'])) as PoolReadinessReport;
    expect(r).toMatchObject({ machines: 2, ready: false });
    expect(r.peers[0].lines.contact.state).not.toBe('ok');
    for (const name of ['clock', 'capacity', 'noStartFailure', 'channels', 'followUps']) expect(r.peers[0].lines[name].state).toBe('unknown');
  });

  it('a single-machine agent gets no log file and no folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-readiness-e2e-'));
    const reg = new MachinePoolRegistry({
      listMachines: () => [{ machineId: 'm_self', nickname: 'A' }],
      clockSkewToleranceMs: 300_000, failoverThresholdMs: 90_000, selfMachineId: () => 'm_self',
    } as ConstructorParameters<typeof MachinePoolRegistry>[0]);
    new PoolReadinessLog(deps(reg, () => []), path.join(dir, 'logs', 'pool-readiness.jsonl')).tick();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('the pair and join note reads a real repo: no remote applies, a remote does not, backup off does not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-readiness-git-'));
    const registry = path.join(dir, '.instar', 'machines', 'registry.json');
    expect(noRemoteTakeoverApplies(dir, true, registry)).toBe(false);
    SafeGitExecutor.execSync(['init', '-q'], { cwd: dir, operation: 'tests/e2e/pool-readiness-lifecycle.test.ts' });
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(registry, '{}');
    expect(noRemoteTakeoverApplies(dir, true, registry)).toBe(true);
    expect(noRemoteTakeoverApplies(dir, false, registry)).toBe(false);
    // A git-ignored registry runs on the local store, so the note would be false there.
    fs.writeFileSync(path.join(dir, '.gitignore'), '.instar/machines/\n');
    expect(noRemoteTakeoverApplies(dir, true, registry)).toBe(false);
    fs.writeFileSync(path.join(dir, '.gitignore'), '');
    SafeGitExecutor.execSync(['remote', 'add', 'origin', 'https://example.invalid/x.git'], { cwd: dir, operation: 'tests/e2e/pool-readiness-lifecycle.test.ts' });
    expect(noRemoteTakeoverApplies(dir, true, registry)).toBe(false);
  });

  it('server.ts wires the report and the log to real deps on the pool beat', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
    expect(src).toContain('readinessMod.setActivePoolReadiness(poolReadinessDeps)');
    expect(src).toContain('poolReadinessLog.tick()');
    expect(src).toContain('setInterval(poolBeat, 30_000)');
    expect(src).toMatch(/gitLeaseHasNoRemote\(config\.projectDir\) === true/);
  });

  it('a hold needs the lasting link only where pairing asked for it, and the live resolver proves it', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');
    expect(src).toMatch(/soloCaptainHold\?\.requireLastingLink === true/);
    expect(src).toMatch(/lastingLinkUnproved\(\{/);
    expect(src).toMatch(/&& !acquireHeldBack\(\);/);
    expect(src).toMatch(/survivorMayHold,\s+acquireHeldBack,/);
    expect(src).toMatch(/onSignedConfirmation: \(peer, kind, url\) => lastingLink\.record\(peer, kind, url\)/);
    expect(src).toMatch(/takeover: \(\) => _noLastingLinkYet\?\.\(\)/);
  });

  it('the pairing note stays quiet once pairing has turned the takeover switch on', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-note-'));
    const write = (heal: unknown) => fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ multiMachine: { leaseSelfHeal: heal } }));
    expect(takeoverSwitchOnDisk(stateDir)).toBe(false);
    write({ soloCaptainHold: { enabled: false } });
    expect(takeoverSwitchOnDisk(stateDir)).toBe(false);
    write({ soloCaptainHold: { enabled: true } });
    expect(takeoverSwitchOnDisk(stateDir)).toBe(true);
    write({ soloCaptainHold: { enabled: true }, preferredAwakeMachineId: 'm_a' });
    expect(takeoverSwitchOnDisk(stateDir)).toBe(false);
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/e2e/pool-readiness-lifecycle' });
  });
});
