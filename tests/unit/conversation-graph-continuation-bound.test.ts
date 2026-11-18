/** reconcilePending bounds uncertified continuations the way it already bounds resumed deliveries:
 * after one does not finish, no other is tried in that pass, and a record that keeps not finishing is
 * tried less and less often (never dropped). Each continuation re-validates and submits under the
 * mutation lane, so an unbounded pass over a backlog starved peer observe calls (accept-all rig,
 * 2026-11-18). Runs the real method against a stub runtime. */
import { describe, expect, it } from 'vitest';
import { ConversationGraphReplicationRuntime } from '../../src/server/ConversationGraphReplicationRuntime.js';

type Row = { packet: { eventId: string; sourceSequence: number; idempotencyKey: string } };
function stub(rows: Row[], outcome: (id: string) => string, held: Set<string> = new Set()) {
  const tried: string[] = [];
  const self = {
    alive: () => true, isReady: () => false, options: { leaseCoordinator: { holdsLease: () => true } },
    refreshReadinessCore: async () => true, prepareNativeTailClosure: async () => undefined,
    withMutation: <T,>(work: (token: symbol) => Promise<T> | T) => Promise.resolve(work(Symbol('t'))),
    retryLocalOwnerIntents: async () => undefined, deliveryFinished: () => false,
    deliveryPass: 0, deliveryRetry: new Map(), continuationRetry: new Map(),
    source: { recordsForRepair: () => rows },
    validatedContinuation: async (r: Row) => { tried.push(r.packet.eventId); return held.has(r.packet.eventId) ? null : r; },
    coordinator: { submit: async (r: Row) => ({ state: outcome(r.packet.eventId) }), cancel: async () => ({ state: 'canceled' }) },
  };
  const run = () => (ConversationGraphReplicationRuntime.prototype.reconcilePending as unknown as (this: unknown) => Promise<Array<{ eventId: string; state: string }>>).call(self);
  return { run, tried };
}
const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ packet: { eventId: `e${i + 1}`, sourceSequence: i + 1, idempotencyKey: `k${i + 1}` } }));

describe('reconcilePending: uncertified continuations are bounded per pass', () => {
  it('stops the pass after the first continuation that does not finish', async () => {
    const { run, tried } = stub(rows(5), () => 'saved-pending');
    const results = await run();
    expect(tried).toEqual(['e1']);
    expect(results).toEqual([{ eventId: 'e1', state: 'saved-pending' }]);
  });

  it('keeps going while continuations finish', async () => {
    const { run, tried } = stub(rows(3), () => 'committed');
    expect((await run()).map((r) => r.state)).toEqual(['committed', 'committed', 'committed']);
    expect(tried).toEqual(['e1', 'e2', 'e3']);
  });

  it('a held record stops the pass too, and later passes reach the other records as its retries space out', async () => {
    const { run, tried } = stub(rows(3), () => 'saved-pending', new Set(['e1']));
    for (let i = 0; i < 6; i++) await run();
    // e1 is tried on passes 1, 2, 4 (backoff 1, 2, 4); the passes it sits out reach e2, then e3, which back off too.
    expect(tried.filter((id) => id === 'e1').length).toBeLessThan(6);
    expect(tried).toContain('e2');
    expect(new Set(tried)).toEqual(new Set(['e1', 'e2', 'e3']));
  });

  it('with a backlog larger than the backoff cap, every record is still reached (least recently tried first)', async () => {
    const { run, tried } = stub(rows(50), () => 'saved-pending');
    for (let i = 0; i < 120; i++) await run();
    expect(new Set(tried).size).toBe(50);
    // And it keeps cycling: the later records are tried again, not only once.
    expect(tried.slice(-50).filter((id) => Number(id.slice(1)) > 40).length).toBeGreaterThan(0);
  });

  it('a record that finishes is cleared from the backoff and is tried normally again', async () => {
    let finish = false;
    const { run, tried } = stub(rows(1), () => (finish ? 'committed' : 'saved-pending'));
    await run(); finish = true;
    await run(); await run();
    expect(tried.length).toBeGreaterThanOrEqual(2);
  });
});
