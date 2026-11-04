import { describe, it, expect } from 'vitest';
import { RebalanceProofRunner, proofProbeText, type ProofHistoryRow, type ProofRecord, type RebalanceProofDeps } from '../../src/core/rebalanceProof.js';

const SELF = 'm_a'; const TARGET = 'm_b'; const TOPIC = 700; const NONCE = 'nonce-1';

function rig(over: Partial<RebalanceProofDeps> & { after?: ProofRecord | null; rows?: ProofHistoryRow[]; failed?: string[]; moved?: boolean; localAfter?: boolean } = {}) {
  let now = 1_000_000;
  let movedYet = false;
  const recorded: string[] = [];
  const evidence: Array<Record<string, unknown>> = [];
  const probes: string[] = [];
  const after = over.after === undefined ? { ownerMachineId: TARGET, status: 'active', ownershipEpoch: 6 } : over.after;
  const deps: RebalanceProofDeps = {
    selfMachineId: () => SELF,
    isProofTopic: (t) => t === TOPIC,
    stageAllowsProof: () => true,
    stage: () => 'live-transfer',
    readRecord: () => (movedYet ? after : { ownerMachineId: SELF, status: 'active', ownershipEpoch: 4 }),
    hasLocalSession: () => over.localAfter === true,
    ensureIdleSession: async () => true,
    move: () => ({ outcome: (async () => { movedYet = true; return { moved: over.moved ?? true, outcome: { status: (over.moved ?? true) ? 'drained' : 'aborted-not-quiet' } }; })() }),
    sendProbe: async (_t, text) => { probes.push(text); return 'forwarded'; },
    readHistory: async () => ({ rows: over.rows ?? [{ text: NONCE, machine: TARGET }], failed: over.failed ?? [] }),
    record: (r) => recorded.push(r),
    writeEvidence: (e) => { evidence.push(e); return '/ev.json'; },
    newNonce: () => NONCE,
    now: () => now,
    sleep: async (ms) => { now += ms; },
    ...over,
  };
  return { runner: new RebalanceProofRunner(deps), recorded, evidence, probes };
}
async function run(r: ReturnType<typeof rig>) {
  const s = r.runner.start(TOPIC, TARGET);
  if ('refused' in s) throw new Error(s.refused);
  return s.finished;
}

describe('RebalanceProofRunner: green only when all three hold', () => {
  it('moved, source session gone, one reply from the target: green', async () => {
    const r = rig();
    expect((await run(r)).state).toBe('green');
    expect(r.recorded).toEqual(['green']);
  });

  it.each([
    ['no reply', { rows: [] }, 'no-reply'],
    ['a reply tagged with another machine', { rows: [{ text: NONCE, machine: SELF }] }, 'reply-from-wrong-machine'],
    ['two replies', { rows: [{ text: NONCE, machine: TARGET }, { text: NONCE, machine: TARGET }] }, 'duplicate-reply'],
    ['the source session still running', { localAfter: true }, 'source-session-left-running'],
    ['a drain that did not move', { moved: false }, 'move-aborted-not-quiet'],
    ['ownership mid-transfer: owner names the target, status does not', { after: { ownerMachineId: TARGET, status: 'transferring', ownershipEpoch: 5 } }, 'ownership-not-landed'],
    ['no epoch advance', { after: { ownerMachineId: TARGET, status: 'active', ownershipEpoch: 4 } }, 'ownership-not-landed'],
  ])('%s is red', async (_n, over, reason) => {
    const r = rig(over);
    const out = await run(r);
    expect(out).toMatchObject({ state: 'red', reason });
    expect(r.recorded).toEqual(['red']);
  });

  it('the probe text echoed back as a user row, or our own text, is not a reply', async () => {
    const r = rig({ rows: [{ text: proofProbeText(NONCE), fromUser: true }, { text: proofProbeText(NONCE), machine: TARGET }] });
    expect(await run(r)).toMatchObject({ state: 'red', reason: 'no-reply' });
  });

  it('a route that does not forward is red, and the stage changing during the run is red', async () => {
    expect(await run(rig({ sendProbe: async () => 'handled-locally' }))).toMatchObject({ state: 'red', reason: 'probe-handled-locally' });
    let reads = 0;
    expect(await run(rig({ stage: () => (reads++ === 0 ? 'live-transfer' : 'shadow') }))).toMatchObject({ state: 'red', reason: 'stage-changed-during-run' });
  });

  it('the probe is fixed text labelled automated, carrying only the nonce', async () => {
    const r = rig();
    await run(r);
    expect(r.probes).toEqual([proofProbeText(NONCE)]);
    expect(r.probes[0]).toMatch(/not a message from the user/);
  });
});

describe('RebalanceProofRunner: reads and restarts', () => {
  it('a read that could not reach the target never erases a reply already seen', async () => {
    let reads = 0;
    const r = rig({ readHistory: async () => (reads++ === 1 ? { rows: [], failed: [TARGET] } : { rows: [{ text: NONCE, machine: TARGET }], failed: [] }) });
    expect((await run(r)).state).toBe('green');
  });

  it('a reply seen once, then a target that stays unreadable, is not green: a duplicate was never ruled out', async () => {
    let reads = 0;
    const r = rig({ readHistory: async () => (reads++ === 0 ? { rows: [{ text: NONCE, machine: TARGET }], failed: [] } : { rows: [], failed: [TARGET] }) });
    expect(await run(r)).toMatchObject({ state: 'red', reason: 'target-history-unreadable' });
  });

  it('a reply seen once, then history reads that throw, is not green either', async () => {
    let reads = 0;
    const r = rig({ readHistory: async () => {
      if (reads++ === 0) return { rows: [{ text: NONCE, machine: TARGET }], failed: [] };
      throw new Error('history unavailable');
    } });
    expect(await run(r)).toMatchObject({ state: 'red', reason: 'target-history-unreadable' });
  });

  it('one thrown read during the settle window does not block a green once reads recover', async () => {
    let reads = 0;
    const r = rig({ readHistory: async () => {
      if (reads++ === 1) throw new Error('blip');
      return { rows: [{ text: NONCE, machine: TARGET }], failed: [] };
    } });
    expect(await run(r)).toMatchObject({ state: 'green' });
  });

  it('a target that stays unreadable is red with its own reason, not "no reply"', async () => {
    const r = rig({ rows: [], failed: [TARGET] });
    expect(await run(r)).toMatchObject({ state: 'red', reason: 'target-history-unreadable' });
  });

  it('a run cut off by a restart is recorded red at the next boot, once', async () => {
    let marker: string | null = null;
    const r = rig({ readInFlight: () => marker, clearInFlight: () => { marker = null; }, markInFlight: (id) => { marker = id; } });
    marker = 'proof-1';
    r.runner.recoverInterrupted();
    expect(r.recorded).toEqual(['red']);
    r.runner.recoverInterrupted();
    expect(r.recorded).toEqual(['red']);
  });

  it('a finished run clears its marker, and a refused one never sets it', async () => {
    let marks = 0; let clears = 0;
    await run(rig({ markInFlight: () => { marks += 1; }, clearInFlight: () => { clears += 1; } }));
    expect([marks, clears]).toEqual([1, 1]);
    marks = 0;
    await run(rig({ move: () => ({ refused: 'target-ineligible' }), markInFlight: () => { marks += 1; } }));
    expect(marks).toBe(0);
  });
});

describe('RebalanceProofRunner: nothing recorded unless a move started', () => {
  it.each([
    ['not listed', { isProofTopic: () => false }, 'not-a-proof-topic'],
    ['stage too low', { stageAllowsProof: () => false }, 'stage-too-low'],
    ['not the owner', { readRecord: () => ({ ownerMachineId: TARGET, status: 'active', ownershipEpoch: 1 }) }, 'not-owner'],
  ])('%s is refused with no row', (_n, over, refused) => {
    const r = rig(over);
    expect(r.runner.start(TOPIC, TARGET)).toEqual({ refused });
    expect(r.recorded).toEqual([]);
  });

  it('a second proof while one runs is refused', () => {
    const r = rig();
    r.runner.start(TOPIC, TARGET);
    expect(r.runner.start(TOPIC, TARGET)).toEqual({ refused: 'proof-running' });
  });

  it('an ineligible target or a session that never went idle records nothing, with evidence kept', async () => {
    const a = rig({ move: () => ({ refused: 'target-ineligible' }) });
    expect(await run(a)).toMatchObject({ reason: 'target-ineligible' });
    expect(a.recorded).toEqual([]);
    expect(a.evidence[0].result).toBe('not-recorded');
    const b = rig({ ensureIdleSession: async () => false });
    await run(b);
    expect(b.recorded).toEqual([]);
  });

  it('a failure after the move started leaves a red row, so old authorization cannot outlive it', async () => {
    const r = rig({ sendProbe: async () => { throw new Error('router down'); } });
    expect((await run(r)).state).toBe('red');
    expect(r.recorded).toEqual(['red']);
  });
});
