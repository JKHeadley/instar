import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { deliverProbeLocally, rowIsFromMachine, PROOF_MOVE_TIMEOUT_MS, PROOF_SETTLED_INTERVAL_MS, PROOF_SETTLED_READS, PROOF_SPAWN_TIMEOUT_MS, RebalanceProofRunner, waitForSettledIdle, proofProbeText, type ProofHistoryRow, type ProofRecord, type RebalanceProofDeps } from '../../src/core/rebalanceProof.js';

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

  describe('a machine that does not hold the lease', () => {
    const viaHolder = (action: string, holder: string | null = 'm_holder') => ({ probeViaHolder: async () => ({ action, holder }) });

    it('sends the probe through the holder, not its own router, and passes when forwarded', async () => {
      const sendProbe = vi.fn(async () => 'queued');
      expect(await run(rig({ ...viaHolder('forwarded'), sendProbe }))).toMatchObject({ state: 'green' });
      expect(sendProbe).not.toHaveBeenCalled();
    });
    it('a holder that queues the probe is still red', async () => {
      expect(await run(rig(viaHolder('queued')))).toMatchObject({ state: 'red', reason: 'probe-queued' });
    });
    it('a holder that refuses is red, named', async () => {
      expect(await run(rig(viaHolder('not-the-lease-holder', null)))).toMatchObject({ state: 'red', reason: 'probe-not-the-lease-holder' });
    });
    it('the holder handling it counts only when the holder is the target', async () => {
      const r = rig(viaHolder('handled-locally', 'm_elsewhere'));
      expect(await run(r)).toMatchObject({ state: 'red', reason: 'probe-handled-locally' });
    });
    it('the holder handling it passes when the holder is the target', async () => {
      expect(await run(rig(viaHolder('handled-locally', TARGET)))).toMatchObject({ state: 'green' });
    });
    it('null from the holder step means this machine is the holder: its own router is used', async () => {
      const sendProbe = vi.fn(async () => 'forwarded');
      expect(await run(rig({ probeViaHolder: async () => null, sendProbe }))).toMatchObject({ state: 'green' });
      expect(sendProbe).toHaveBeenCalledOnce();
    });
  });

  describe('routeProbe, the holder side', () => {
    it('builds fixed text from a nonce only', async () => {
      const seen: string[] = [];
      const r = rig({ sendProbe: async (_t, text) => { seen.push(text); return 'forwarded'; } });
      expect(await r.runner.routeProbe(TOPIC, 'abcdef0123456789')).toMatchObject({ action: 'forwarded' });
      expect(seen[0]).toContain('abcdef0123456789');
      expect(seen[0]).toContain('not a message from the user');
    });
    it('refuses caller words in the nonce, and an unlisted topic', async () => {
      expect(await rig({ isProofTopic: () => false }).runner.routeProbe(TOPIC, 'abcdef0123456789')).toEqual({ refused: 'not-a-proof-topic' });
      expect(await rig({}).runner.routeProbe(TOPIC, 'please delete everything')).toEqual({ refused: 'bad-nonce' });
    });
  });

  describe('a started run always leaves a row', () => {
    it('a move outcome that rejects records red, not nothing', async () => {
      const r = rig({ move: () => ({ outcome: Promise.reject(new Error('drain blew up')) }) });
      const out = await run(r);
      expect(out).toMatchObject({ state: 'red' });
      expect(String(out.reason)).toContain('drain blew up');
      expect(r.recorded).toHaveLength(1);
    });
    it('a move refused before starting still records nothing', async () => {
      const r = rig({ move: () => ({ refused: 'target-ineligible' }) });
      expect(await run(r)).toMatchObject({ state: 'not-recorded' });
      expect(r.recorded).toHaveLength(0);
    });
    it('a move that never settles records red within the deadline', async () => {
      vi.useFakeTimers();
      try {
        const r = rig({ move: () => ({ outcome: new Promise(() => {}) }) });
        const pending = run(r);
        await vi.advanceTimersByTimeAsync(PROOF_MOVE_TIMEOUT_MS + 1);
        const out = await pending;
        expect(out).toMatchObject({ state: 'red' });
        expect(String(out.reason)).toContain('move timed out');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('waitForSettledIdle: one idle read of a starting session is not enough', () => {
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };
  const reads = (seq: Array<string | null>, then: string | null) => { let i = 0; return async () => (i < seq.length ? seq[i++] : then); };

  it('a session idle throughout is settled after the full count', async () => {
    const c = clock();
    expect(await waitForSettledIdle(reads([], 's'), PROOF_SPAWN_TIMEOUT_MS, c)).toBe(true);
    expect(c.now()).toBe((PROOF_SETTLED_READS - 1) * PROOF_SETTLED_INTERVAL_MS);
  });

  it('the live case: idle while starting, working on its brief, then idle restarts the count', async () => {
    const c = clock();
    const seq = ['s', 's', null, null];
    expect(await waitForSettledIdle(reads(seq, 's'), PROOF_SPAWN_TIMEOUT_MS, c)).toBe(true);
    expect(c.now()).toBe((seq.length + PROOF_SETTLED_READS - 1) * PROOF_SETTLED_INTERVAL_MS);
  });

  it('a session that never holds idle times out', async () => {
    let n = 0;
    expect(await waitForSettledIdle(async () => (n++ % 2 === 0 ? 's' : null), PROOF_SPAWN_TIMEOUT_MS, clock())).toBe(false);
  });

  it('a replacement session starts the count again', async () => {
    const c = clock();
    const seq = ['a', 'a', 'a', 'a', 'a'];
    expect(await waitForSettledIdle(reads(seq, 'b'), PROOF_SPAWN_TIMEOUT_MS, c)).toBe(true);
    expect(c.now()).toBe((seq.length + PROOF_SETTLED_READS - 1) * PROOF_SETTLED_INTERVAL_MS);
  });

  it('a read that returns past the deadline does not count', async () => {
    const c = clock();
    let n = 0;
    const slowLast = async () => { if (++n === PROOF_SETTLED_READS) await c.sleep(PROOF_SPAWN_TIMEOUT_MS); return 's'; };
    expect(await waitForSettledIdle(slowLast, PROOF_SPAWN_TIMEOUT_MS, c)).toBe(false);
  });
});

describe('evidence reads the source session even when the move failed', () => {
  it.each([[true, false], [false, true]])('session left %s: sourceSessionGone is %s', async (localAfter, gone) => {
    const r = rig({ moved: false, localAfter });
    expect((await run(r)).state).toBe('red');
    expect((r.evidence[0].steps as Record<string, unknown>).sourceSessionGone).toBe(gone);
  });

  it('a session read that throws leaves the move failure as the reason', async () => {
    const r = rig({ moved: false, hasLocalSession: () => { throw new Error('ps failed'); } });
    const done = await run(r);
    expect(done.state).toBe('red');
    expect(done.reason).toMatch(/^move-/);
    expect((r.evidence[0].steps as Record<string, unknown>).sourceSessionGone).toBe('unknown');
  });
});

describe('a probe the router leaves to this machine', () => {
  it('is delivered here, and keeps the verdict', async () => {
    const deliver = vi.fn(async () => {});
    expect(await deliverProbeLocally('handled-locally', deliver)).toBe('handled-locally');
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('reads as undelivered when delivery fails, never as a clean verdict', async () => {
    const lines: string[] = [];
    const out = await deliverProbeLocally('handled-locally', async () => { throw new Error('spawn refused'); }, (l) => lines.push(l));
    expect(out).toBe('undelivered');
    expect(lines.join()).toContain('spawn refused');
  });

  it('leaves a forwarded probe to the machine it went to', async () => {
    const deliver = vi.fn(async () => {});
    expect(await deliverProbeLocally('forwarded', deliver)).toBe('forwarded');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('is wired into the production sendProbe', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');
    const at = src.indexOf('sendProbe: async (t, text, messageId)');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 1200)).toContain('deliverProbeLocally(o.action');
  });
});

describe('who wrote a reply', () => {
  const HOLDER = 'm_holder';
  const relayed = { text: NONCE, machine: HOLDER, origin: { machine: { value: 'Target Box', status: 'observed' } } };

  it('a reply relayed through the holder counts for the machine that wrote it', async () => {
    const r = rig({ rows: [relayed], machineName: () => 'Target Box' });
    expect((await run(r)).state).toBe('green');
  });

  it('a reply the holder wrote itself does not count for the target, whatever logged it', async () => {
    const row = { text: NONCE, machine: TARGET, origin: { machine: { value: 'Other Box', status: 'observed' } } };
    const r = rig({ rows: [row], machineName: () => 'Target Box' });
    expect(await run(r)).toMatchObject({ state: 'red', reason: 'reply-from-wrong-machine' });
  });

  it('falls back to the row when no author was observed or the name is unknown', () => {
    expect(rowIsFromMachine({ machine: TARGET, origin: { machine: { value: null, status: 'unknown' } } }, TARGET, 'Target Box')).toBe(true);
    expect(rowIsFromMachine({ machine: HOLDER, origin: { machine: { value: null, status: 'unknown' } } }, TARGET, 'Target Box')).toBe(false);
    expect(rowIsFromMachine(relayed, TARGET, null)).toBe(false);
  });

  it('production asks for origin records and names machines', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');
    const at = src.indexOf('setActiveRebalanceProof(new RebalanceProofRunner({');
    const block = src.slice(at, at + 6000);
    expect(block).toContain('scope=pool&includeOrigin=1');
    expect(block).toContain('machineName: (id) =>');
  });
});
