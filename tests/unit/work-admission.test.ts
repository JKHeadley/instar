/**
 * WorkAdmission (trustworthy-machine-load-and-mesh-floor spec, Part C1/C2/C4):
 * the close/reopen state machine on both sides of every boundary, dry-run vs
 * enforced, the host-wide recovery slot, and self-help once per episode.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { HostSpawnSemaphore } from '../../src/core/hostSpawnSemaphore.js';
import { WorkAdmission, SLOT_STARTUP_GRACE_MS, type WorkAdmissionConfig } from '../../src/core/workAdmission.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-admission-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/work-admission.test.ts' }); });

function make(cfg: Partial<WorkAdmissionConfig> = {}, extra: { running?: string[]; onSustained?: () => void; now?: () => number } = {}) {
  const config: WorkAdmissionConfig = { enabled: true, dryRun: false, reopenAfterGoodSamples: 5, selfHelpAfterSaturatedSamples: 3, ...cfg };
  const slot = new HostSpawnSemaphore({ holdersPath: path.join(dir, 'slot.json'), cap: 1, isPathHostLocal: () => true });
  const wa = new WorkAdmission({
    config: () => config,
    recoverySlot: slot,
    agentName: 'echo',
    runningSessionNames: () => extra.running ?? [],
    onSustainedOverload: extra.onSustained,
    auditPath: path.join(dir, 'audit.jsonl'),
    now: extra.now,
  });
  return { wa, slot, config };
}

describe('C1 close / reopen', () => {
  it('starts open; ok, elevated and unknown never close it', () => {
    const { wa } = make();
    for (const v of ['ok', 'elevated', 'unknown', 'unknown', 'elevated'] as const) wa.observe(v);
    expect(wa.acceptingWork()).toBe(true);
    expect(wa.admit('automatic').allowed).toBe(true);
  });

  it('one saturated or impaired sample closes it (the verdict already carries the 2-of-3 quorum)', () => {
    for (const v of ['saturated', 'impaired'] as const) {
      const { wa } = make();
      wa.observe(v);
      expect(wa.acceptingWork()).toBe(false);
    }
  });

  it('reopens only after 5 consecutive ok/elevated samples; 4 is not enough', () => {
    const { wa } = make();
    wa.observe('saturated');
    for (let i = 0; i < 4; i++) wa.observe(i % 2 ? 'ok' : 'elevated');
    expect(wa.acceptingWork()).toBe(false);
    wa.observe('ok');
    expect(wa.acceptingWork()).toBe(true);
  });

  it('an unknown sample breaks the reopening streak; a saturated one restarts it', () => {
    const { wa } = make();
    wa.observe('impaired');
    for (let i = 0; i < 4; i++) wa.observe('ok');
    wa.observe('unknown');
    for (let i = 0; i < 4; i++) wa.observe('ok');
    expect(wa.acceptingWork()).toBe(false);
    wa.observe('ok');
    expect(wa.acceptingWork()).toBe(true);
  });

  it('disabled: never closes, advertises nothing, admits everything', () => {
    const { wa } = make({ enabled: false });
    wa.observe('impaired');
    expect(wa.acceptingWork()).toBe(true);
    expect(wa.advert()).toBeNull();
    expect(wa.admit('automatic').allowed).toBe(true);
  });
});

describe('dry-run vs enforced', () => {
  it('dry-run: closed state is advertised as not enforced, automatic work is admitted and counted as would-refuse', () => {
    const { wa } = make({ dryRun: true });
    wa.observe('saturated');
    expect(wa.advert()).toEqual({ acceptingWork: false, enforced: false });
    const d = wa.admit('automatic');
    expect(d.allowed).toBe(true);
    expect(d.wouldRefuse).toBe(true);
    expect((wa.status().counters as { wouldRefuse: number }).wouldRefuse).toBe(1);
  });

  it('dry-run never takes the real recovery slot', () => {
    const { wa, slot } = make({ dryRun: true });
    wa.observe('saturated');
    expect(wa.admit('operator', 's1').allowed).toBe(true);
    expect(slot.peek().liveHolders).toBe(0);
  });

  it('enforced: automatic work is refused with reason overloaded; it is admitted again after reopening', () => {
    const { wa } = make();
    wa.observe('saturated');
    const d = wa.admit('automatic');
    expect(d).toMatchObject({ allowed: false, reason: 'overloaded' });
    expect(wa.advert()).toEqual({ acceptingWork: false, enforced: true });
    for (let i = 0; i < 5; i++) wa.observe('ok');
    expect(wa.admit('automatic').allowed).toBe(true);
  });
});

describe('C2 host-wide recovery slot', () => {
  it('while closed, the first operator session takes the slot and a second is refused', () => {
    const { wa, slot } = make({}, { running: ['s1'] });
    wa.observe('impaired');
    expect(wa.admit('operator', 's1')).toMatchObject({ allowed: true, recoverySlot: true });
    expect(slot.peek().liveHolders).toBe(1);
    expect(wa.admit('operator', 's2')).toMatchObject({ allowed: false, reason: 'recovery-slot-in-use' });
  });

  it('the slot is freed when its session ends (explicit release, or — past the startup grace — the session is no longer running)', () => {
    let t = 1_000_000;
    const running = ['s1'];
    const { wa, slot } = make({}, { running, now: () => t });
    wa.observe('impaired');
    wa.admit('operator', 's1');
    wa.releaseSlotFor('s1');
    expect(slot.peek().liveHolders).toBe(0);

    wa.admit('operator', 's1');
    running.length = 0; // s1 ended without the completion event
    expect(wa.admit('operator', 's2')).toMatchObject({ allowed: false, reason: 'recovery-slot-in-use' }); // inside the grace: still "booting"
    t += SLOT_STARTUP_GRACE_MS + 1;
    expect(wa.admit('operator', 's2')).toMatchObject({ allowed: true, recoverySlot: true });
  });

  it('the slot is shared by every agent on the host: another agent holding it blocks this one', () => {
    const { wa, slot } = make({}, { running: ['mine'] });
    slot.acquire('other-agent:99999:theirs');
    wa.observe('saturated');
    expect(wa.admit('operator', 'mine')).toMatchObject({ allowed: false, reason: 'recovery-slot-in-use' });
  });

  it('while open, operator sessions do not touch the slot', () => {
    const { wa, slot } = make();
    expect(wa.admit('operator', 's1')).toEqual({ allowed: true });
    expect(slot.peek().liveHolders).toBe(0);
  });
});

describe('C4 self-help', () => {
  it('fires once after 3 consecutive overloaded samples, not again until the episode ends', () => {
    let fired = 0;
    const { wa } = make({}, { onSustained: () => { fired += 1; } });
    wa.observe('saturated');
    wa.observe('saturated');
    expect(fired).toBe(0);
    wa.observe('impaired');
    expect(fired).toBe(1);
    for (let i = 0; i < 5; i++) wa.observe('saturated');
    expect(fired).toBe(1);
    for (let i = 0; i < 5; i++) wa.observe('ok'); // reopen ends the episode
    for (let i = 0; i < 3; i++) wa.observe('saturated');
    expect(fired).toBe(2);
  });

  it('a non-consecutive run does not fire', () => {
    let fired = 0;
    const { wa } = make({}, { onSustained: () => { fired += 1; } });
    for (const v of ['saturated', 'saturated', 'elevated', 'saturated', 'saturated'] as const) wa.observe(v);
    expect(fired).toBe(0);
  });
});

describe('audit', () => {
  it('writes one row per transition and refusal', () => {
    const { wa } = make();
    wa.observe('saturated');
    wa.admit('automatic');
    const rows = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((r) => r.event)).toEqual(['closed', 'refused']);
  });
});

describe('second-pass fixes', () => {
  it('a granted slot is not reclaimed as "ended" while its session is still booting (startup grace), but is after it', () => {
    let t = 1_000_000;
    const running: string[] = [];
    const config: WorkAdmissionConfig = { enabled: true, dryRun: false, reopenAfterGoodSamples: 5, selfHelpAfterSaturatedSamples: 3 };
    const slot = new HostSpawnSemaphore({ holdersPath: path.join(dir, 'slot.json'), cap: 1, isPathHostLocal: () => true });
    const wa = new WorkAdmission({ config: () => config, recoverySlot: slot, agentName: 'echo', runningSessionNames: () => running, now: () => t });
    wa.observe('impaired');
    expect(wa.admit('operator', 'booting')).toMatchObject({ allowed: true, recoverySlot: true });
    // Still not listed as running 10 s later: a second operator session must NOT steal the slot.
    t += 10_000;
    expect(wa.admit('operator', 'second')).toMatchObject({ allowed: false, reason: 'recovery-slot-in-use' });
    // Past the grace and still never running → it really ended: reclaimable.
    t += 6 * 60_000;
    expect(wa.admit('operator', 'second')).toMatchObject({ allowed: true, recoverySlot: true });
  });

  it('a holders-lock failure with no real holder admits the operator session (fail open) and is counted, never "recovery-slot-in-use"', () => {
    const { wa } = make({}, { running: ['s1'] });
    wa.observe('saturated');
    // Simulate lock contention: acquire answers false while nobody holds the slot.
    const slot = (wa as unknown as { slot: HostSpawnSemaphore }).slot;
    slot.acquire = () => false;
    const d = wa.admit('operator', 's1');
    expect(d).toMatchObject({ allowed: true, recoverySlot: false });
    expect((wa.status().counters as { slotLockFailures: number }).slotLockFailures).toBe(1);
    expect((wa.status().counters as { recoverySlotRefused: number }).recoverySlotRefused).toBe(0);
  });

  it('check() answers the scheduler without inflating the refusal counters or the audit', () => {
    const { wa } = make();
    wa.observe('saturated');
    for (let i = 0; i < 50; i++) expect(wa.check().allowed).toBe(false);
    const c = wa.status().counters as { refused: number; schedulerChecksRefused: number };
    expect(c.refused).toBe(0);
    expect(c.schedulerChecksRefused).toBe(50);
    const rows = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf-8').trim().split('\n');
    expect(rows).toHaveLength(1); // only the `closed` transition
    const { wa: dry } = make({ dryRun: true });
    dry.observe('saturated');
    expect(dry.check()).toMatchObject({ allowed: true, wouldRefuse: true });
  });

  it('self-help receives the episode id (the close time), the same id for the whole episode', () => {
    let t = 5_000;
    const ids: number[] = [];
    const config: WorkAdmissionConfig = { enabled: true, dryRun: false, reopenAfterGoodSamples: 5, selfHelpAfterSaturatedSamples: 3 };
    const slot = new HostSpawnSemaphore({ holdersPath: path.join(dir, 'slot.json'), cap: 1, isPathHostLocal: () => true });
    const wa = new WorkAdmission({ config: () => config, recoverySlot: slot, now: () => t, onSustainedOverload: (_v, id) => { ids.push(id); } });
    wa.observe('saturated'); t += 15_000; wa.observe('saturated'); t += 15_000; wa.observe('saturated');
    expect(ids).toEqual([5_000]);
  });

  it('enabled:false read live reopens on the next sample and advertises nothing', () => {
    const config: WorkAdmissionConfig = { enabled: true, dryRun: false, reopenAfterGoodSamples: 5, selfHelpAfterSaturatedSamples: 3 };
    const slot = new HostSpawnSemaphore({ holdersPath: path.join(dir, 'slot.json'), cap: 1, isPathHostLocal: () => true });
    const wa = new WorkAdmission({ config: () => config, recoverySlot: slot });
    wa.observe('impaired');
    expect(wa.admit('automatic').allowed).toBe(false);
    config.enabled = false;
    expect(wa.admit('automatic').allowed).toBe(true);
    expect(wa.acceptingWork()).toBe(true);
    expect(wa.advert()).toBeNull();
    wa.observe('ok'); // a sample while disabled clears the stale closed episode
    config.enabled = true;
    expect(wa.acceptingWork()).toBe(true); // re-enable starts open, not in the old closed state
    expect(wa.status().closedAt).toBeNull();
  });
});
