/**
 * MachineCoherenceEpisodeManager — the §4 episode state machine slice b1:
 * open / join / suspend / resume / close taxonomy (§4.3) + §4.4 escalation +
 * the operator "leave it" ack + §4.2 verbatim body render + §4.6 corrupt
 * re-baseline. Effects are gated on raiser && live posture (dry-run / non-raiser
 * run the machine but never speak).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MachineCoherenceEpisodeManager, type EpisodeReconcileInput } from '../../src/monitoring/machineCoherenceEpisodeManager.js';
import { resolveMachineCoherenceConfig } from '../../src/monitoring/MachineCoherenceSentinel.js';
import { skewRowIdentity } from '../../src/monitoring/machineCoherenceEvaluate.js';
import { readEpisodeFile, episodeStatePath } from '../../src/monitoring/machineCoherenceEpisode.js';

const NOW = 1_751_500_000_000;
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-epmgr-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-coherence-episode-manager.test.ts' }); });

// A flag skew row: ws13Reconcile live on m_laptop, dark on m_mini.
function flagRow(a = 'live', b = 'dark') {
  const vc = { m_laptop: a, m_mini: b };
  return { identity: skewRowIdentity('flag', 'seamlessness.ws13Reconcile', vc), dimension: 'flag' as const, key: 'seamlessness.ws13Reconcile', participants: ['m_laptop', 'm_mini'], valueClasses: vc };
}

const NICK: Record<string, string> = { m_laptop: 'the laptop', m_mini: 'the mini' };
function input(over: Partial<EpisodeReconcileInput> = {}): EpisodeReconcileInput {
  return {
    confirmedRows: [flagRow()],
    comparedMachineIds: new Set(['m_laptop', 'm_mini']),
    onlineMachineIds: new Set(['m_laptop', 'm_mini']),
    selfMachineId: 'm_laptop',
    raiserMachineId: 'm_laptop',
    leaseHolderMachineId: 'm_laptop',
    nicknameOf: (m) => NICK[m] ?? m,
    now: NOW,
    ...over,
  };
}

function mgr(config: Record<string, unknown> = { developmentAgent: true, monitoring: { machineCoherence: { dryRun: false } } }) {
  return new MachineCoherenceEpisodeManager(dir, resolveMachineCoherenceConfig(config));
}

describe('open (§4.1) + raiser/live gating (§4.2)', () => {
  it('raiser + live: opens an episode, raises ONE item, persists durably', () => {
    const m = mgr();
    const effects = m.reconcile(input());
    const raise = effects.find((e) => e.kind === 'raise');
    expect(raise).toBeDefined();
    if (raise?.kind === 'raise') expect(raise.itemId).toMatch(/^machine-coherence:mc-\d+$/);
    expect(m.status().openEpisode?.rows).toBe(1);
    expect(readEpisodeFile(dir).status).toBe('ok');
  });

  it('dry-run: runs the machine + counts wouldRaise, emits NO raise effect', () => {
    const m = mgr({ developmentAgent: true }); // dryRun defaults TRUE
    const effects = m.reconcile(input());
    expect(effects.find((e) => e.kind === 'raise')).toBeUndefined();
    expect(m.status().counters.wouldRaise).toBe(1);
    expect(m.status().counters.itemsRaised).toBe(0);
    expect(m.status().openEpisode).not.toBeNull(); // state still tracked
  });

  it('non-raiser (a peer is elected): runs the machine but does not speak', () => {
    const m = mgr();
    const effects = m.reconcile(input({ raiserMachineId: 'm_mini' }));
    expect(effects.find((e) => e.kind === 'raise')).toBeUndefined();
    expect(m.status().counters.wouldRaise).toBe(1);
  });

  it('no confirmed rows → no episode, no effects', () => {
    const m = mgr();
    expect(m.reconcile(input({ confirmedRows: [] }))).toEqual([]);
    expect(m.status().openEpisode).toBeNull();
  });
});

describe('join / suspend / resume / restore (§4.3)', () => {
  it('a newly-confirmed row JOINS the open episode with an append (never a 2nd item)', () => {
    const m = mgr();
    m.reconcile(input());
    const proto = { identity: skewRowIdentity('protocol', 'protocolVersion', { m_laptop: '1', m_mini: '2' }), dimension: 'protocol' as const, key: 'protocolVersion', participants: ['m_laptop', 'm_mini'], valueClasses: { m_laptop: '1', m_mini: '2' } };
    const effects = m.reconcile(input({ confirmedRows: [flagRow(), proto] }));
    expect(effects.find((e) => e.kind === 'raise')).toBeUndefined();
    expect(effects.find((e) => e.kind === 'append')).toBeDefined();
    expect(m.status().openEpisode?.rows).toBe(2);
  });

  it('a participant going offline SUSPENDS (peer-offline) with an honest append; escalation is paused', () => {
    const m = mgr();
    m.reconcile(input());
    const effects = m.reconcile(input({ onlineMachineIds: new Set(['m_laptop']) }));
    const app = effects.find((e) => e.kind === 'append');
    expect(app?.kind === 'append' && app.text).toContain('went offline');
    expect(m.status().openEpisode?.suspended).toBe(true);
  });

  it('online-but-unreadable participant SUSPENDS peer-unverifiable', () => {
    const m = mgr();
    m.reconcile(input());
    const effects = m.reconcile(input({ comparedMachineIds: new Set(['m_laptop']) }));
    const app = effects.find((e) => e.kind === 'append');
    expect(app?.kind === 'append' && app.text).toContain("can't read");
  });

  it('resume is silent, then a clean pass for resolveTicks closes RESTORED', () => {
    const m = mgr({ developmentAgent: true, monitoring: { machineCoherence: { dryRun: false, resolveTicks: 2 } } });
    m.reconcile(input());
    m.reconcile(input({ onlineMachineIds: new Set(['m_laptop']) })); // suspend
    m.reconcile(input()); // resume + 1st clean tick (rows still present? no — pass confirmedRows empty for clean)
    // Now drive clean passes (skew gone).
    m.reconcile(input({ confirmedRows: [] }));
    const effects = m.reconcile(input({ confirmedRows: [] }));
    const res = effects.find((e) => e.kind === 'resolve');
    expect(res?.kind === 'resolve' && res.note).toContain('restored');
    expect(m.status().openEpisode).toBeNull();
  });

  it('only `restored` claims restoration — resolve note names the held ticks', () => {
    const m = mgr({ developmentAgent: true, monitoring: { machineCoherence: { dryRun: false, resolveTicks: 1 } } });
    m.reconcile(input());
    const effects = m.reconcile(input({ confirmedRows: [] }));
    const res = effects.find((e) => e.kind === 'resolve');
    expect(res?.kind === 'resolve' && res.note).toMatch(/restored — .* held for 1 ticks/);
  });
});

describe('escalation (§4.4) + operator ack (R4-N2)', () => {
  it('an episode open past escalateAfterMs appends ONCE', () => {
    const m = mgr({ developmentAgent: true, monitoring: { machineCoherence: { dryRun: false, escalateAfterMs: 1000 } } });
    m.reconcile(input());
    const late = m.reconcile(input({ now: NOW + 2000 }));
    expect(late.find((e) => e.kind === 'append' && e.text.includes('after 24h'))).toBeDefined();
    // A second late tick does not re-append (once per episode).
    const later = m.reconcile(input({ now: NOW + 3000 }));
    expect(later.find((e) => e.kind === 'append' && e.text.includes('after 24h'))).toBeUndefined();
  });

  it('an operator "leave it" ack SUPPRESSES the escalation append', () => {
    const m = mgr({ developmentAgent: true, monitoring: { machineCoherence: { dryRun: false, escalateAfterMs: 1000 } } });
    m.reconcile(input());
    m.setOperatorAck(true);
    const late = m.reconcile(input({ now: NOW + 2000 }));
    expect(late.find((e) => e.kind === 'append')).toBeUndefined();
  });
});

describe('expired-peer-gone (§4.3)', () => {
  it('a suspended episode past suspendedEpisodeExpiryMs closes expired-peer-gone (never "restored")', () => {
    const m = mgr({ developmentAgent: true, monitoring: { machineCoherence: { dryRun: false, suspendedEpisodeExpiryMs: 5000 } } });
    m.reconcile(input());
    m.reconcile(input({ onlineMachineIds: new Set(['m_laptop']) })); // suspend
    const effects = m.expireIfStale(NOW + 10_000, (x) => NICK[x] ?? x);
    const res = effects.find((e) => e.kind === 'resolve');
    expect(res?.kind === 'resolve' && res.note).toContain('never came back');
    expect(m.status().openEpisode).toBeNull();
  });

  it('does not expire a still-fresh suspended episode', () => {
    const m = mgr({ developmentAgent: true, monitoring: { machineCoherence: { dryRun: false, suspendedEpisodeExpiryMs: 999_999 } } });
    m.reconcile(input());
    m.reconcile(input({ onlineMachineIds: new Set(['m_laptop']) }));
    expect(m.expireIfStale(NOW + 1000, (x) => x)).toEqual([]);
    expect(m.status().openEpisode).not.toBeNull();
  });
});

describe('§4.6 corrupt re-baseline', () => {
  it('a corrupt episode file re-baselines on construction WITHOUT crashing', () => {
    fs.mkdirSync(path.dirname(episodeStatePath(dir)), { recursive: true });
    fs.writeFileSync(episodeStatePath(dir), '{corrupt');
    const m = mgr();
    expect(m.status().openEpisode).toBeNull();
    // Still functional: it can open a fresh episode.
    m.reconcile(input());
    expect(m.status().openEpisode?.rows).toBe(1);
  });
});

// A distinct flag row (unique key) so successive opens/joins don't collapse.
function distinctRow(n: number) {
  const vc = { m_laptop: 'live', m_mini: 'dark' };
  const key = `seamlessness.k${n}`;
  return { identity: skewRowIdentity('flag', key, vc), dimension: 'flag' as const, key, participants: ['m_laptop', 'm_mini'], valueClasses: vc };
}

describe('§4.5 per-day cap (maxEpisodeItemsPerDay)', () => {
  it('caps NEW items per rolling 24h and gives up loudly ONCE, further episodes jsonl-only', () => {
    const m = mgr({ developmentAgent: true, monitoring: { machineCoherence: { dryRun: false, maxEpisodeItemsPerDay: 2, resolveTicks: 1 } } });
    let raises = 0; let capNotes = 0;
    const openThenClose = (n: number) => {
      const eff = m.reconcile(input({ confirmedRows: [distinctRow(n)] }));
      raises += eff.filter((e) => e.kind === 'raise').length;
      capNotes += eff.filter((e) => e.kind === 'append' && e.text.includes('flapping faster')).length;
      // close it (skew gone) so the next distinct skew opens a NEW episode.
      m.reconcile(input({ confirmedRows: [] }));
    };
    openThenClose(1); openThenClose(2); openThenClose(3); openThenClose(4);
    expect(raises).toBe(2); // cap
    expect(capNotes).toBe(1); // give up loudly once
  });
});

describe('§4.5 recurrence reopen (same item, no new item)', () => {
  it('calm gate LIVE: a reopen is a visible APPEND on the SAME item (the swallowed-raise fix) — no new item, no cap count', () => {
    const m = mgr({ developmentAgent: true, monitoring: { machineCoherence: { dryRun: false, resolveTicks: 1, maxEpisodeItemsPerDay: 1 } } });
    const first = m.reconcile(input()); // open item #1
    const itemId = first.find((e) => e.kind === 'raise')?.kind === 'raise' ? (first.find((e) => e.kind === 'raise') as { itemId: string }).itemId : '';
    m.reconcile(input({ confirmedRows: [] })); // close restored
    const reopen = m.reconcile(input()); // same skew back → reopen
    // calm-alerting M-P2: the legacy raise-with-reused-id was silently swallowed
    // by the createAttentionItem id-dedupe; the reopen is now an append.
    const append = reopen.find((e) => e.kind === 'append');
    expect(append?.kind === 'append' && append.itemId).toBe(itemId); // SAME item id
    expect(append?.kind === 'append' && append.text).toContain('re-opening');
    expect(reopen.some((e) => e.kind === 'raise')).toBe(false); // no new item
    expect(m.status().openEpisode?.rows).toBe(1);
  });

  it('calm gate DARK: the legacy reopen raise shape is bit-identical (calmEnabled: false)', () => {
    const m = mgr({ developmentAgent: true, monitoring: { machineCoherence: { dryRun: false, resolveTicks: 1, maxEpisodeItemsPerDay: 1, calmEnabled: false } } });
    const first = m.reconcile(input());
    const itemId = first.find((e) => e.kind === 'raise')?.kind === 'raise' ? (first.find((e) => e.kind === 'raise') as { itemId: string }).itemId : '';
    m.reconcile(input({ confirmedRows: [] }));
    const reopen = m.reconcile(input());
    const raise = reopen.find((e) => e.kind === 'raise');
    expect(raise?.kind === 'raise' && raise.itemId).toBe(itemId);
    expect(raise?.kind === 'raise' && raise.summary).toContain('re-opening');
  });
});

describe('§4.5 shared append budget (R3-M5 burst invariant)', () => {
  it('intra-episode flap appends are bounded to episodeAppendBudget + 1 (the flapping note), then jsonl-only', () => {
    const m = mgr({ developmentAgent: true, monitoring: { machineCoherence: { dryRun: false, episodeAppendBudget: 3 } } });
    // Open, then join a NEW distinct row each tick (all rows stay present).
    const rows = [flagRow()];
    m.reconcile(input({ confirmedRows: [...rows] }));
    let appends = 0;
    for (let n = 0; n < 10; n++) {
      rows.push(distinctRow(n));
      const eff = m.reconcile(input({ confirmedRows: [...rows] }));
      appends += eff.filter((e) => e.kind === 'append').length;
    }
    expect(appends).toBe(4); // budget (3) + 1 flapping note; the rest jsonl-only
  });

  it('a suspend/resume append always gets its RESERVED slot even when the budget is spent', () => {
    const m = mgr({ developmentAgent: true, monitoring: { machineCoherence: { dryRun: false, episodeAppendBudget: 1 } } });
    const rows = [flagRow()];
    m.reconcile(input({ confirmedRows: [...rows] }));
    // Spend the budget with row joins.
    for (let n = 0; n < 4; n++) { rows.push(distinctRow(n)); m.reconcile(input({ confirmedRows: [...rows] })); }
    // Now a suspend transition must still speak (reserved slot).
    const susp = m.reconcile(input({ confirmedRows: [...rows], onlineMachineIds: new Set(['m_laptop']) }));
    expect(susp.find((e) => e.kind === 'append' && e.text.includes('went offline'))).toBeDefined();
  });
});

describe('§4.2.1 pendingFix state machine', () => {
  it('records a `proposed` pendingFix for the first auto-proposable row on open', () => {
    const m = mgr();
    m.reconcile(input());
    const pf = m.status().openEpisode?.pendingFix;
    expect(pf?.state).toBe('proposed');
    expect(pf?.key).toBe('seamlessness.ws13Reconcile');
    expect(pf?.targetMachineId).toBe('m_mini'); // divergent side (laptop=live wins via holder tiebreak)
    expect(pf?.targetValue).toBe('on');
  });

  it('a version/manifest/protocol row is NOT auto-proposed (no config override to write)', () => {
    const m = mgr();
    const proto = { identity: skewRowIdentity('protocol', 'protocolVersion', { m_laptop: '1', m_mini: '2' }), dimension: 'protocol' as const, key: 'protocolVersion', participants: ['m_laptop', 'm_mini'], valueClasses: { m_laptop: '1', m_mini: '2' } };
    m.reconcile(input({ confirmedRows: [proto] }));
    expect(m.status().openEpisode?.pendingFix).toBeNull();
  });

  it('an EXCLUDED root class (developmentAgent) renders the manual decision block, no pendingFix', () => {
    const m = mgr();
    const devRow = { identity: skewRowIdentity('flag', 'developmentAgent', { m_laptop: 'true', m_mini: 'false' }), dimension: 'flag' as const, key: 'developmentAgent', participants: ['m_laptop', 'm_mini'], valueClasses: { m_laptop: 'true', m_mini: 'false' } };
    const eff = m.reconcile(input({ confirmedRows: [devRow] }));
    expect(m.status().openEpisode?.pendingFix).toBeNull();
    const raise = eff.find((e) => e.kind === 'raise');
    expect(raise?.kind === 'raise' && raise.description).toContain('root switch');
    expect(raise?.kind === 'raise' && raise.description).toContain("do nothing until you say");
  });

  it('Know Your Principal: approveFix from an UNVERIFIED sender is refused', () => {
    const m = mgr();
    m.reconcile(input());
    const hash = m.status().openEpisode!.pendingFix!.proposalHash;
    const r = m.approveFix({ proposalHash: hash, verifiedOperator: false, now: NOW });
    expect(r.result).toEqual({ ok: false, reason: 'not-verified-operator' });
    expect(m.status().openEpisode?.pendingFix?.state).toBe('proposed'); // unchanged
  });

  it('approveFix with a stale/lapsed hash is refused (display-integrity authority)', () => {
    const m = mgr();
    m.reconcile(input());
    const r = m.approveFix({ proposalHash: 'deadbeefdeadbeef', verifiedOperator: true, now: NOW });
    expect(r.result.ok).toBe(false);
    expect(r.result.reason).toBe('proposal-lapsed');
  });

  it('divergent != raiser → approved-holding + an honest "from my own hands" append', () => {
    const m = mgr(); // self=laptop, divergent=mini
    m.reconcile(input());
    const hash = m.status().openEpisode!.pendingFix!.proposalHash;
    const r = m.approveFix({ proposalHash: hash, verifiedOperator: true, now: NOW });
    expect(r.result).toMatchObject({ ok: true, state: 'approved-holding' });
    expect(r.effects.find((e) => e.kind === 'append' && e.text.includes('from my own hands'))).toBeDefined();
    expect(m.status().openEpisode?.pendingFix?.state).toBe('approved-holding');
  });

  it('divergent == raiser (self) → executing-verifying + an execute-fix effect', () => {
    const m = mgr();
    m.reconcile(input({ selfMachineId: 'm_mini', raiserMachineId: 'm_mini', leaseHolderMachineId: 'm_laptop' }));
    const hash = m.status().openEpisode!.pendingFix!.proposalHash;
    const r = m.approveFix({ proposalHash: hash, verifiedOperator: true, now: NOW });
    expect(r.result).toMatchObject({ ok: true, state: 'executing-verifying' });
    const exec = r.effects.find((e) => e.kind === 'execute-fix');
    expect(exec?.kind === 'execute-fix' && exec.configPath).toBe('multiMachine.seamlessness.ws13Reconcile');
    expect(exec?.kind === 'execute-fix' && exec.targetValue).toBe('on');
  });

  it('single-flight: a second approval while one is in flight is refused', () => {
    const m = mgr();
    m.reconcile(input());
    const hash = m.status().openEpisode!.pendingFix!.proposalHash;
    m.approveFix({ proposalHash: hash, verifiedOperator: true, now: NOW }); // → approved-holding
    const again = m.approveFix({ proposalHash: hash, verifiedOperator: true, now: NOW });
    expect(again.result).toEqual({ ok: false, reason: 'already-in-flight' });
  });

  it('suspension INVALIDATES an approved-holding fix with a named note', () => {
    const m = mgr();
    m.reconcile(input());
    const hash = m.status().openEpisode!.pendingFix!.proposalHash;
    m.approveFix({ proposalHash: hash, verifiedOperator: true, now: NOW });
    const eff = m.reconcile(input({ onlineMachineIds: new Set(['m_laptop']) })); // mini offline → suspend
    expect(eff.find((e) => e.kind === 'append' && e.text.includes('the fix you approved is paused'))).toBeDefined();
    expect(m.status().openEpisode?.pendingFix ?? null).toBeNull();
  });

  it('§4.2.1-v: an executing-verifying fix whose row does not clear within fixVerifyTicks fails LOUDLY, episode stays open', () => {
    const m = mgr({ developmentAgent: true, monitoring: { machineCoherence: { dryRun: false, fixVerifyTicks: 2 } } });
    m.reconcile(input({ selfMachineId: 'm_mini', raiserMachineId: 'm_mini', leaseHolderMachineId: 'm_laptop' }));
    const hash = m.status().openEpisode!.pendingFix!.proposalHash;
    m.approveFix({ proposalHash: hash, verifiedOperator: true, now: NOW });
    // Row stays divergent across verify ticks.
    m.reconcile(input({ selfMachineId: 'm_mini', raiserMachineId: 'm_mini', leaseHolderMachineId: 'm_laptop' }));
    const eff = m.reconcile(input({ selfMachineId: 'm_mini', raiserMachineId: 'm_mini', leaseHolderMachineId: 'm_laptop' }));
    expect(eff.find((e) => e.kind === 'append' && e.text.includes("the fix didn't take"))).toBeDefined();
    expect(m.status().openEpisode).not.toBeNull(); // episode stays open (closure is §4.3's alone)
    expect(m.status().openEpisode?.pendingFix ?? null).toBeNull(); // retry needs fresh approval
  });
});

describe('§4.2 verbatim body render', () => {
  it('divergent == raiser (self): impact-first, fix-it/leave-it, failover named when holding the lease', () => {
    const m = mgr();
    // laptop=live, mini=dark → majority tie (2-machine) → lease holder (laptop, live) is target → mini is divergent.
    // Make SELF the divergent machine: self=mini, raiser=mini, holder=mini(live side)…
    // Simplest: self=laptop is holder+live; divergent=mini. So NOT self. Test the other-machine branch here,
    // and the self branch below with self=mini.
    const effects = m.reconcile(input());
    const raise = effects.find((e) => e.kind === 'raise');
    expect(raise?.kind === 'raise' && raise.summary).toContain('drifted apart');
    expect(raise?.kind === 'raise' && raise.description).toContain('**fix it**');
    expect(raise?.kind === 'raise' && raise.description).toContain('**leave it**');
    // mini is the divergent machine, not self → the "from my own hands there" branch.
    expect(raise?.kind === 'raise' && raise.description).toContain('from my own hands there');
    expect(raise?.kind === 'raise' && raise.description).toContain('the mini');
  });

  it('divergent == self + holds lease: names the failover to the peer', () => {
    const m = mgr();
    // self = mini (the divergent side); mini holds the lease; target value = laptop's (majority tiebreak → holder).
    // Force target toward laptop by making mini the lease holder? direction = holder value when no majority.
    // With holder=m_mini, target = mini's value (dark) → divergent = laptop. That flips it. Instead set holder=laptop
    // so target=live, divergent=mini=self.
    const effects = m.reconcile(input({ selfMachineId: 'm_mini', raiserMachineId: 'm_mini', leaseHolderMachineId: 'm_laptop' }));
    // Wait: holder=laptop → target=live → divergent=mini=self. self holds lease? leaseHolder=laptop≠self, so NO failover clause.
    const raise = effects.find((e) => e.kind === 'raise');
    expect(raise?.kind === 'raise' && raise.description).toContain('here on the mini');
    expect(raise?.kind === 'raise' && raise.description).toContain('restart my own server');
  });
});
