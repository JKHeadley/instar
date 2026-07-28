// safe-fs-allow: test file — tmpdir fixtures only.

/**
 * Tier-1 unit battery — SelfActionGovernor core admission machinery
 * (unified-self-action-backpressure companion §13; spec §Testing).
 *
 * Covers: three-way admission per class under pinned pressure; count floors
 * under targetAlwaysRejects and accept-but-ineffective; distinct-target flood
 * denial; granularity BOTH ways; census widen-only/clamp/stale-floor;
 * principal always-allow (incl. under a THROWING governor, unpaced);
 * vacuous-override immunity of the last-resort floor; demote alarm gating;
 * queueMaxTargets shed; drain fence/predicate rejections; atomic
 * check-and-mint; token binding/TTL/single-consume; the fail matrix; the
 * emergencyDisable pass-through + flip episode; the FD9 pool gate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SelfActionGovernorCore,
  initSelfActionGovernor,
  getSelfActionGovernor,
  consumeAdmissionToken,
  resetSelfActionGovernorModuleForTest,
  type SelfActionGovernorDeps,
} from '../../src/monitoring/selfaction/governor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { resetAnchorForTest } from '../../src/monitoring/selfaction/anchor.js';
import {
  DEMOTE_EXHAUSTION_N,
  PRINCIPAL_VOLUME_THRESHOLD,
  lastResortFloorPerWindow,
} from '../../src/monitoring/selfaction/policies.js';
import type { DerivedTarget, GovernorAttentionItem } from '../../src/monitoring/selfaction/types.js';

let tmp: string;
let vnow: number;
let attention: GovernorAttentionItem[];
let emergencyDisable: boolean;
let classesConfig: unknown;
let census: { value: number; asOf: number; confidence: 'high' | 'low' } | null;
let machineCount: number;

function deps(over: Partial<SelfActionGovernorDeps> = {}): SelfActionGovernorDeps {
  return {
    stateDir: tmp,
    readEmergencyDisable: () => emergencyDisable,
    readClassesConfig: () => classesConfig,
    readCensus: () => census,
    registeredMachineCount: () => machineCount,
    emitAttention: (item) => {
      attention.push(item);
    },
    now: () => vnow,
    ...over,
  };
}

function freshGovernor(over: Partial<SelfActionGovernorDeps> = {}): SelfActionGovernorCore {
  resetSelfActionGovernorModuleForTest();
  resetAnchorForTest();
  return initSelfActionGovernor(deps(over));
}

function target(key: string, classId = 'session', keyIsVolatile = false): DerivedTarget {
  return { key, classId, keyIsVolatile };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sag-'));
  vnow = 1_000_000_000;
  attention = [];
  emergencyDisable = false;
  classesConfig = undefined;
  census = null;
  machineCount = 1;
});

afterEach(() => {
  resetSelfActionGovernorModuleForTest();
  resetAnchorForTest();
  SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/self-action-governor.test.ts' });
});

describe('observe mode (FD1 — the shipped default)', () => {
  it('always ALLOWS and records the would-deny with the deciding sub-mechanism', () => {
    const gov = freshGovernor();
    const h = gov.for('age-kill-backoff');
    // Per-target ceiling is 5 — the 6th admit of the SAME target would deny.
    for (let i = 0; i < 5; i++) {
      const a = h.admitSync(target('session:s1'));
      expect(a.outcome).toBe('allow');
    }
    const sixth = h.admitSync(target('session:s1'));
    expect(sixth.outcome).toBe('allow'); // observe NEVER blocks
    expect(sixth.reason).toBe('observe-would-deny');
    expect(sixth.detail).toContain('per-target-ceiling');
    const posture = gov.getPosture();
    const row = posture.classes.find((c) => c.controllerId === 'age-kill-backoff')!;
    expect(row.mode).toBe('observe');
    expect(row.counters.wouldDeny).toBe(1);
    expect(row.bySubMechanism['per-target-ceiling']).toBe(1);
  });

  it('a new (unpolicied) controller inherits a conservative default bound by construction (FD3)', () => {
    const gov = freshGovernor();
    const h = gov.for('some-brand-new-controller');
    for (let i = 0; i < 20; i++) expect(h.admitSync(target('t1', 'thing')).reason).not.toBe('observe-would-deny');
    const over = h.admitSync(target('t1', 'thing'));
    expect(over.outcome).toBe('allow');
    expect(over.reason).toBe('observe-would-deny'); // perTarget default 20 reached
  });
});

describe('enforce mode — the load-bearing count floors (FD5)', () => {
  it('targetAlwaysRejects (age-kill veto shape): the SAME target is bounded at the per-target ceiling and QUEUED', () => {
    classesConfig = { 'age-kill-backoff': { mode: 'enforce' } };
    const gov = freshGovernor();
    const h = gov.for('age-kill-backoff');
    for (let i = 0; i < 5; i++) expect(h.admitSync(target('session:s1')).outcome).toBe('allow');
    const sixth = h.admitSync(target('session:s1'));
    expect(sixth.outcome).toBe('queue'); // three-way: never a silent drop
    expect(sixth.reason).toBe('per-target-ceiling');
  });

  it('accept-but-ineffective (external-hog shape): incarnation-varying keys COLLAPSE onto the stable class and hit perTargetBoundK', () => {
    classesConfig = { 'external-hog-kill-breaker': { mode: 'enforce' } };
    const gov = freshGovernor();
    const h = gov.for('external-hog-kill-breaker');
    // New pid each respawn (volatile key), same signature class — the kill
    // "accepts" every time but the signature respawns.
    for (let i = 0; i < 3; i++) {
      expect(h.admitSync(target(`pid:${1000 + i}`, 'sha256:sig-A', true)).outcome).toBe('allow');
    }
    const fourth = h.admitSync(target('pid:2000', 'sha256:sig-A', true));
    expect(fourth.outcome).toBe('queue');
    expect(fourth.reason).toBe('per-target-ceiling'); // bounded at perTargetBoundK=3
  });

  it('MIRROR granularity: N genuinely-distinct STABLE targets keep INDEPENDENT per-target ceilings', () => {
    classesConfig = { 'external-hog-kill-breaker': { mode: 'enforce' } };
    const gov = freshGovernor();
    const h = gov.for('external-hog-kill-breaker');
    for (const sig of ['sig-A', 'sig-B', 'sig-C']) {
      for (let i = 0; i < 3; i++) {
        expect(h.admitSync(target(`sha256:${sig}`, sig)).outcome).toBe('allow');
      }
    }
    // Each hit ITS OWN ceiling — 9 allows total, not 3.
    const posture = gov.getPosture().classes.find((c) => c.controllerId === 'external-hog-kill-breaker')!;
    expect(posture.counters.admits).toBe(9);
  });

  it('a distinct-target FLOOD past totalCountCeiling is count-denied (relief rate relaxation is NOT a count exemption)', () => {
    classesConfig = { 'age-kill-backoff': { mode: 'enforce' } };
    const gov = freshGovernor();
    const h = gov.for('age-kill-backoff');
    let denied: string | null = null;
    for (let i = 0; i < 70; i++) {
      const a = h.admitSync(target(`session:s${i}`));
      if (a.outcome !== 'allow') {
        denied = a.reason;
        break;
      }
    }
    expect(denied).toBe('total-ceiling'); // static floor 60 binds the flood
  });

  it('neutral/notify classes COALESCE on deny (the P17 fold), never queue', () => {
    classesConfig = { 'promise-beacon-notify': { mode: 'enforce', perTargetCountCeiling: 2 } };
    const gov = freshGovernor();
    const h = gov.for('promise-beacon-notify');
    expect(h.admitSync(target('topic:1', 'topic')).outcome).toBe('allow');
    expect(h.admitSync(target('topic:1', 'topic')).outcome).toBe('allow');
    const third = h.admitSync(target('topic:1', 'topic'));
    expect(third.outcome).toBe('coalesce');
  });

  it('eternalSentinel (liveness-heartbeat): rate-floored, never count-bounded (FD7)', () => {
    classesConfig = { 'liveness-heartbeat': { mode: 'enforce' } };
    const gov = freshGovernor();
    const h = gov.for('liveness-heartbeat');
    expect(h.admitSync(target('topic:1', 'topic')).outcome).toBe('allow');
    // Within the floor: coalesced (enforce) — the floor is the ONLY bound.
    const tooSoon = h.admitSync(target('topic:1', 'topic'));
    expect(tooSoon.outcome).toBe('coalesce');
    expect(tooSoon.reason).toBe('lane-floor');
    // Past the floor (60 min): allowed again, forever (never count-bounded).
    for (let i = 0; i < 30; i++) {
      vnow += 61 * 60_000;
      expect(h.admitSync(target('topic:1', 'topic')).outcome).toBe('allow');
    }
  });
});

describe('census discipline (companion §7)', () => {
  it('a fresh confident census WIDENS the relief ceiling mid-window (widen-only)', () => {
    classesConfig = { 'age-kill-backoff': { mode: 'enforce' } };
    const gov = freshGovernor();
    const h = gov.for('age-kill-backoff');
    census = { value: 1000, asOf: vnow, confidence: 'high' };
    gov.sampleCensus(vnow);
    let allows = 0;
    for (let i = 0; i < 200; i++) {
      if (h.admitSync(target(`session:s${i}`)).outcome === 'allow') allows++;
    }
    // 15% of 1000 = 150 — a legitimate mass-reap above the static floor passes.
    expect(allows).toBeGreaterThanOrEqual(120); // rate bucket (120/window) is the next bound
    expect(allows).toBeLessThanOrEqual(150);
  });

  it('an INFLATED census is clamped at censusAbsoluteMax with an audit row', () => {
    classesConfig = { 'age-kill-backoff': { mode: 'enforce' } };
    const gov = freshGovernor();
    census = { value: 1_000_000, asOf: vnow, confidence: 'high' };
    gov.sampleCensus(vnow);
    const rows = gov.peekAuditBuffer().filter((r) => r.type === 'census-clamp');
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('a STALE or low-confidence census falls to the static floor (never widens)', () => {
    classesConfig = { 'age-kill-backoff': { mode: 'enforce' } };
    const gov = freshGovernor();
    const h = gov.for('age-kill-backoff');
    census = { value: 1000, asOf: vnow - 60 * 60_000, confidence: 'high' }; // stale
    gov.sampleCensus(vnow);
    let allows = 0;
    for (let i = 0; i < 100; i++) {
      if (h.admitSync(target(`session:s${i}`)).outcome === 'allow') allows++;
    }
    expect(allows).toBe(60); // the static floor
  });
});

describe('fail matrix (companion §6)', () => {
  it('cost/safety (swap) with a THROWING admit fails CLOSED-to-QUEUE — never allow, never strand', async () => {
    classesConfig = { 'proactive-swap-monitor': { mode: 'enforce' } };
    const gov = freshGovernor();
    const h = gov.for('proactive-swap-monitor');
    gov.setThrowOnAdmitForTest('proactive-swap-monitor', true);
    const a = await h.admit(target('account:A', 'subscription-account'));
    expect(a.outcome).toBe('queue');
    expect(a.reason).toBe('errored-open');
  });

  it('non-recovery relief (age-kill) with a THROWING admit fails OPEN-with-audit, paced by the last-resort floor', () => {
    classesConfig = { 'age-kill-backoff': { mode: 'enforce' } };
    const gov = freshGovernor();
    const h = gov.for('age-kill-backoff');
    gov.setThrowOnAdmitForTest('age-kill-backoff', true);
    const floor = lastResortFloorPerWindow('age-kill-backoff');
    let opens = 0;
    let paced = 0;
    for (let i = 0; i < floor + 20; i++) {
      const a = h.admitSync(target(`session:s${i}`));
      if (a.outcome === 'allow') opens++;
      else paced++;
    }
    expect(opens).toBe(floor); // open — but PACED at the policy-free floor
    expect(paced).toBe(20);
    // Errored episode opened + CRITICAL/HIGH alarm raised once.
    const erroredItems = attention.filter((i) => i.id.includes(':errored:'));
    expect(erroredItems.length).toBe(1);
    // First-N verbatim rows then aggregation.
    const rows = gov.peekAuditBuffer().filter((r) => r.type === 'errored-admit');
    expect(rows.length).toBeLessThanOrEqual(20);
  });

  it('the last-resort floor is IMMUNE to a well-formed vacuous config override (ADV7-1)', () => {
    classesConfig = {
      'age-kill-backoff': { mode: 'enforce', totalCountCeiling: 1_000_000, perTargetCountCeiling: 1_000_000 },
    };
    const gov = freshGovernor();
    const h = gov.for('age-kill-backoff');
    gov.setThrowOnAdmitForTest('age-kill-backoff', true);
    const floor = lastResortFloorPerWindow('age-kill-backoff');
    let opens = 0;
    for (let i = 0; i < floor + 50; i++) {
      if (h.admitSync(target(`session:s${i}`)).outcome === 'allow') opens++;
    }
    // The floor derives from the CODE default (60), never the vacuous override.
    expect(opens).toBe(floor);
    expect(floor).toBeLessThan(1000);
  });

  it('disruption-only (notify) with a THROWING admit fails open-but-COALESCE', () => {
    classesConfig = { 'promise-beacon-notify': { mode: 'enforce' } };
    const gov = freshGovernor();
    const h = gov.for('promise-beacon-notify');
    gov.setThrowOnAdmitForTest('promise-beacon-notify', true);
    expect(h.admitSync(target('topic:1', 'topic')).outcome).toBe('coalesce');
  });

  it('respawn-recovery fails OPEN unconditionally — never queued, never dead-lettered, even THROWING', () => {
    classesConfig = { 'resume-queue-respawn': { mode: 'enforce' } };
    const gov = freshGovernor();
    const h = gov.for('resume-queue-respawn');
    gov.setThrowOnAdmitForTest('resume-queue-respawn', true);
    for (let i = 0; i < 500; i++) {
      expect(h.admitSync(target('run:1', 'autonomous-run')).outcome).toBe('allow');
    }
  });

  it('the governor recovering closes the errored episode', () => {
    classesConfig = { 'age-kill-backoff': { mode: 'enforce' } };
    const gov = freshGovernor();
    const h = gov.for('age-kill-backoff');
    gov.setThrowOnAdmitForTest('age-kill-backoff', true);
    h.admitSync(target('session:s1'));
    gov.setThrowOnAdmitForTest('age-kill-backoff', false);
    h.admitSync(target('session:s2'));
    const types = gov.peekAuditBuffer().map((r) => r.type);
    expect(types).toContain('errored-episode-open');
    expect(types).toContain('errored-episode-close');
  });
});

describe('emergencyDisable (FD2 — the ONLY unconditional allow-token path)', () => {
  it('degrades EVERY class to pass-through and the flip is episode-latched + audited', () => {
    classesConfig = { 'age-kill-backoff': { mode: 'enforce' } };
    const gov = freshGovernor();
    const h = gov.for('age-kill-backoff');
    for (let i = 0; i < 5; i++) h.admitSync(target('session:s1'));
    emergencyDisable = true;
    // The cached read refreshes within 1s of wall-clock; force it.
    vnow += 5_000;
    // (Date.now-based cache — wait it out deterministically via a fresh read window)
    const until = Date.now() + 1_100;
    while (Date.now() < until) {
      /* spin briefly — the disable cache TTL is 1s */
    }
    const a = h.admitSync(target('session:s1'));
    expect(a.outcome).toBe('allow');
    expect(a.reason).toBe('disabled-passthrough');
    const flips = gov.peekAuditBuffer().filter((r) => r.type === 'emergency-disable-flip');
    expect(flips.length).toBe(1);
    expect(attention.some((i) => i.priority === 'HIGH' && i.id.includes(':flip:'))).toBe(true);
  });
});

describe('principal lane (FD13)', () => {
  it('always allows with a per-admit audit row, and pages on volume anomaly (episode-latched)', () => {
    const gov = freshGovernor();
    for (let i = 0; i < PRINCIPAL_VOLUME_THRESHOLD + 5; i++) {
      const a = gov.principalAdmit('dashboard-pin-session', { actionVerb: 'session-kill', target: `s${i}` });
      expect(a.outcome).toBe('allow');
      expect(a.reason).toBe('principal-lane');
    }
    const rows = gov.peekAuditBuffer().filter((r) => r.type === 'principal-admit');
    expect(rows.length).toBe(PRINCIPAL_VOLUME_THRESHOLD + 5);
    const pages = attention.filter((i) => i.id.includes(':principal:'));
    expect(pages.length).toBe(1); // ONE episode-latched HIGH page, not a stream
    expect(pages[0].priority).toBe('HIGH');
  });

  it('passes with every ceiling exhausted AND under a throwing governor, unpaced (SEC7-1)', () => {
    classesConfig = { 'age-kill-backoff': { mode: 'enforce' } };
    const gov = freshGovernor();
    const h = gov.for('age-kill-backoff');
    gov.setThrowOnAdmitForTest('age-kill-backoff', true);
    const floor = lastResortFloorPerWindow('age-kill-backoff');
    for (let i = 0; i < floor + 10; i++) h.admitSync(target(`session:s${i}`)); // exhaust the errored floor
    // Principal admits sail through — never routed through the errored-open
    // relief path, never paced by the last-resort floor.
    for (let i = 0; i < 50; i++) {
      expect(gov.principalAdmit('message-sentinel-verified-sender', { actionVerb: 'kill' }).outcome).toBe('allow');
    }
  });
});

describe('capability tokens (FD6 — runtime consume is the authority)', () => {
  it('binds (controllerId, targetKey), single-consumes, and expires', () => {
    classesConfig = { 'age-kill-backoff': { mode: 'enforce' } };
    const gov = freshGovernor();
    const h = gov.for('age-kill-backoff');
    const a = h.admitSync(target('session:s1'));
    expect(a.outcome).toBe('allow');
    const token = a.outcome === 'allow' ? a.token : null;
    // Wrong controller: the sink pins its identity module-side.
    const wrong = gov.consumeToken(token, 'external-hog-kill-breaker');
    expect(wrong.valid).toBe(false);
    expect(wrong.reason).toContain('minted for');
    // Right controller + target: consumes once.
    const ok = gov.consumeToken(token, 'age-kill-backoff', { targetKey: 'session:s1' });
    expect(ok.valid).toBe(true);
    // Second consume: rejected.
    const second = gov.consumeToken(token, 'age-kill-backoff');
    expect(second.valid).toBe(false);
    expect(second.reason).toContain('consumed');
    // Expiry: a fresh token presented after TTL is rejected.
    const b = h.admitSync(target('session:s2'));
    const token2 = b.outcome === 'allow' ? b.token : null;
    vnow += 10 * 60_000;
    const expired = gov.consumeToken(token2, 'age-kill-backoff');
    expect(expired.valid).toBe(false);
    expect(expired.reason).toContain('expired');
  });

  it('sink verdicts BLOCK only in enforce mode (observe stays signal-only)', () => {
    const gov = freshGovernor();
    // Observe: a missing token is recorded invalid but the sink PROCEEDS.
    const observeVerdict = gov.consumeToken(null, 'age-kill-backoff');
    expect(observeVerdict.valid).toBe(false);
    expect(observeVerdict.proceed).toBe(true);
    // Enforce: proceed=false.
    gov.setModeForTest('age-kill-backoff', 'enforce');
    const enforceVerdict = gov.consumeToken(null, 'age-kill-backoff');
    expect(enforceVerdict.valid).toBe(false);
    expect(enforceVerdict.proceed).toBe(false);
  });

  it('atomic check-and-mint: two concurrent admits cannot both pass a ceiling of 1', async () => {
    classesConfig = { 'proactive-swap-monitor': { mode: 'enforce', totalCountCeiling: 1, perTargetCountCeiling: 1 } };
    const gov = freshGovernor();
    const h = gov.for('proactive-swap-monitor');
    const [a, b] = await Promise.all([
      h.admit(target('account:A', 'subscription-account')),
      h.admit(target('account:A', 'subscription-account')),
    ]);
    const allows = [a, b].filter((x) => x.outcome === 'allow').length;
    expect(allows).toBe(1); // single-writer in-memory CAS — never both
  });
});

describe('queue (companion §5.4)', () => {
  it('same-target intents COALESCE; a distinct-target overflow dead-letters LOUDLY (coalesced notice)', () => {
    classesConfig = { 'proactive-swap-monitor': { mode: 'enforce', totalCountCeiling: 1, queueMaxTargets: 3 } };
    const gov = freshGovernor();
    const h = gov.for('proactive-swap-monitor');
    // Exhaust the ceiling, then flood the queue with distinct targets.
    void h.admitSync(target('account:A', 'subscription-account'));
    for (let i = 0; i < 10; i++) {
      const a = h.admitSync(target(`account:q${i}`, 'subscription-account'));
      expect(a.outcome).toBe('queue');
    }
    const posture = gov.getPosture().classes.find((c) => c.controllerId === 'proactive-swap-monitor')!;
    expect(posture.queueDistinctTargets).toBeLessThanOrEqual(3);
    const sheds = gov.peekAuditBuffer().filter((r) => r.type === 'dead-letter-shed');
    expect(sheds.length).toBeGreaterThanOrEqual(1);
    // ONE coalesced notice per (controller, window) — swap sheds are HIGH.
    const shedNotices = attention.filter((i) => i.id.includes(':shed:'));
    expect(shedNotices.length).toBe(1);
    expect(shedNotices[0].priority).toBe('HIGH');
  });

  it('drain REJECTS on incarnation-fence mismatch and on a dead eligibility predicate (audited drops)', () => {
    classesConfig = { 'age-kill-backoff': { mode: 'enforce', perTargetCountCeiling: 1 } };
    const gov = freshGovernor();
    const h = gov.for('age-kill-backoff');
    let fired = 0;
    void h.admitSync(target('session:s1'), { incarnation: 'uuid-old' });
    // Queue an intent whose target incarnation will die and be replaced.
    const q = h.admitSync(target('session:s1'), {
      incarnation: 'uuid-old',
      eligible: () => false, // the condition no longer holds at drain
      onAdmitted: () => {
        fired++;
      },
    });
    expect(q.outcome).toBe('queue');
    gov.drainQueues(vnow + 60_000);
    expect(fired).toBe(0); // never fired blind against changed conditions
    const drops = gov.peekAuditBuffer().filter((r) => r.type === 'queue-drain-drop');
    expect(drops.length).toBeGreaterThanOrEqual(1);
  });

  it('BOTH-unavailable at drain (no fence AND un-evaluable predicate) = audited drop, never fire-blind', () => {
    classesConfig = { 'age-kill-backoff': { mode: 'enforce', perTargetCountCeiling: 1 } };
    const gov = freshGovernor();
    const h = gov.for('age-kill-backoff');
    let fired = 0;
    void h.admitSync(target('session:s2'));
    const q = h.admitSync(target('session:s2'), {
      onAdmitted: () => {
        fired++;
      },
      // no incarnation, no eligible predicate
    });
    expect(q.outcome).toBe('queue');
    gov.drainQueues(vnow + 60_000);
    expect(fired).toBe(0);
    expect(gov.peekAuditBuffer().some((r) => r.type === 'queue-drain-drop' && r.detail?.includes('un-evaluable'))).toBe(true);
  });

  it('a queued intent whose ceiling clears at drain FIRES via onAdmitted with a fresh token', () => {
    classesConfig = { 'age-kill-backoff': { mode: 'enforce', perTargetCountCeiling: 1, windowMs: 60_000 } };
    const gov = freshGovernor();
    const h = gov.for('age-kill-backoff');
    let fired = 0;
    void h.admitSync(target('session:s3'), { incarnation: 'uuid-1' });
    const q = h.admitSync(target('session:s3'), {
      incarnation: 'uuid-1',
      eligible: () => true,
      onAdmitted: (token) => {
        fired++;
        expect(gov.consumeToken(token, 'age-kill-backoff').valid).toBe(true);
      },
    });
    expect(q.outcome).toBe('queue');
    // The window slides + per-target entry expires: drain re-admits.
    vnow += 90 * 60_000;
    gov.drainQueues(vnow);
    expect(fired).toBe(1);
  });
});

describe('demote latch (P22 — heal exhaustion gating)', () => {
  it('a demote→clean-re-promote cycle is AUDIT-ONLY; the alarm fires only after N failed cooldowns', () => {
    const gov = freshGovernor();
    gov.demoteReliefClass('age-kill-backoff', vnow);
    vnow += 6 * 60_000; // past the cooldown
    gov.repromoteReliefClass('age-kill-backoff', vnow);
    expect(attention.filter((i) => i.id.includes(':demote:')).length).toBe(0); // transient = silent
    // Now a sustained episode: N failed cooldowns.
    gov.demoteReliefClass('age-kill-backoff', vnow);
    for (let i = 0; i < DEMOTE_EXHAUSTION_N; i++) {
      vnow += 60_000; // within the cooldown — heal fails
      gov.demoteReliefClass('age-kill-backoff', vnow);
    }
    const alarms = attention.filter((i) => i.id.includes(':demote:'));
    expect(alarms.length).toBe(1); // exhausted → ONE alarm
  });
});

describe('FD9 — pool-shared enforce gate (level-triggered on REGISTERED count)', () => {
  it('a pool-shared class enforcing via the N=1 carve-out AUTO-DEMOTES on a 1→2 enrollment', () => {
    classesConfig = { 'proactive-swap-monitor': { mode: 'enforce' } };
    machineCount = 1;
    const gov = freshGovernor();
    expect(gov.getClassMode('proactive-swap-monitor')).toBe('enforce'); // N=1 carve-out
    machineCount = 2; // a second machine is ENROLLED
    gov.runSlowTickForTest();
    expect(gov.getClassMode('proactive-swap-monitor')).toBe('demoted');
    expect(gov.readAllAuditRowsForTest().some((r) => r.type === 'auto-demote-pool-gate')).toBe(true);
    // Re-promotes ONLY on genuine de-enrollment.
    machineCount = 1;
    gov.runSlowTickForTest();
    expect(gov.getClassMode('proactive-swap-monitor')).toBe('enforce');
  });

  it('hardware-bound classes are unaffected by the pool gate', () => {
    classesConfig = { 'age-kill-backoff': { mode: 'enforce' } };
    machineCount = 3;
    const gov = freshGovernor();
    gov.runSlowTickForTest();
    expect(gov.getClassMode('age-kill-backoff')).toBe('enforce');
  });
});

describe('config override validation (LOAD-time, never throw-in-admit)', () => {
  it('a malformed override falls back to the code default with an audit row', () => {
    classesConfig = { 'age-kill-backoff': { perTargetCountCeiling: 'lots' } };
    const gov = freshGovernor();
    const h = gov.for('age-kill-backoff');
    for (let i = 0; i < 5; i++) expect(h.admitSync(target('session:s1')).reason).not.toBe('observe-would-deny');
    expect(h.admitSync(target('session:s1')).reason).toBe('observe-would-deny'); // code default 5 applied
    expect(gov.peekAuditBuffer().some((r) => r.type === 'policy-override-invalid')).toBe(true);
  });

  it('a numeric override marks the class overridden with the ceiling-vs-default ratio (SEC5-2)', () => {
    classesConfig = { 'age-kill-backoff': { totalCountCeiling: 120 } };
    const gov = freshGovernor();
    gov.for('age-kill-backoff');
    const row = gov.getPosture().classes.find((c) => c.controllerId === 'age-kill-backoff')!;
    expect(row.overridden).toBe(true);
    expect(row.ceilingVsDefaultRatio).toBe(2);
  });
});

describe('route read surface (scrubbed, lock-free)', () => {
  it('emits NO target identities in the posture projection (SEC6)', () => {
    const gov = freshGovernor();
    const h = gov.for('age-kill-backoff');
    h.admitSync(target('session:super-secret-session-name'));
    const json = JSON.stringify(gov.getPosture());
    expect(json).not.toContain('super-secret-session-name');
  });
});

describe('module surface', () => {
  it('getSelfActionGovernor + consumeAdmissionToken are the same core the module handles ride', () => {
    resetSelfActionGovernorModuleForTest();
    resetAnchorForTest();
    const core = initSelfActionGovernor(deps());
    expect(getSelfActionGovernor()).toBe(core);
    const h = core.for('promise-beacon-notify');
    const a = h.admitSync(target('topic:9', 'topic'));
    expect(a.outcome).toBe('allow');
    const verdict = consumeAdmissionToken(a.outcome === 'allow' ? a.token : null, 'promise-beacon-notify');
    expect(verdict.valid).toBe(true);
  });
});
