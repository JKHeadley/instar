/** The rules machines use to agree on access (team-roles-and-access, "Step 2b"). */
import { describe, it, expect } from 'vitest';
import { findGaps, hasSeen, mayReadMessage, mergeRows, streamKey, type MergeEvent, type MergeRow } from '../../src/core/TeamAccessMerge.js';

const row = (origin: string, seq: number, events: MergeEvent[], seen: Record<string, number> = {}, extra: Partial<MergeRow> = {}): MergeRow => ({
  origin, incarnation: 'i1', seq, prev: seq === 1 ? null : `${origin}-${seq - 1}`, hash: `${origin}-${seq}`, seen, events, ...extra, ...(extra.hash ? {} : { hash: `${origin}-${seq}` }),
});
const A = (seq: number) => ({ [streamKey('A', 'i1')]: seq });
const B = (seq: number) => ({ [streamKey('B', 'i1')]: seq });
const on: MergeEvent = { type: 'team-on' };
const add = (k: string, role = 'member'): MergeEvent => ({ type: 'person-add', personKey: k, role });
const grant = (k: string, ref: string, access: 'read' | 'use' = 'use'): MergeEvent => ({ type: 'grant', personKey: k, ref, access });
const ungrant = (k: string, ref: string): MergeEvent => ({ type: 'grant-remove', personKey: k, ref });

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((p) => [x, ...p]));
}
const flat = (m: ReturnType<typeof mergeRows>) => JSON.stringify({
  on: m.on, people: [...m.people].sort(), grants: [...m.grants].map(([k, v]) => [k, [...v].sort()]).sort(), removed: [...m.removed].sort(), voided: [...m.voided].sort(),
});
function sameEveryOrder(rows: MergeRow[]) {
  const answers = new Set(permutations(rows).map((p) => flat(mergeRows(p))));
  expect(answers.size).toBe(1);
  return mergeRows(rows);
}

describe('hasSeen', () => {
  it('a row saw what came before it on its stream, and what its vector names', () => {
    const a1 = row('A', 1, []); const a2 = row('A', 2, []); const b1 = row('B', 1, [], A(1)); const b2 = row('B', 2, []);
    expect(hasSeen(a2, a1)).toBe(true);
    expect(hasSeen(a1, a2)).toBe(false);
    expect(hasSeen(b1, a1)).toBe(true);
    expect(hasSeen(b2, a1)).toBe(false);
    expect(hasSeen(b1, a2)).toBe(false);
  });
});

describe('mergeRows', () => {
  const base = row('A', 1, [on, add('p')]);

  it('a later change that saw the earlier one simply replaces it, even if it widens', () => {
    const m = sameEveryOrder([base, row('A', 2, [grant('p', 'c', 'read')]), row('B', 1, [grant('p', 'c', 'use')], A(2))]);
    expect(m.grants.get('p')?.get('c')).toBe('use');
  });

  it('of two that did not see each other, the narrower wins, by content and not by clock', () => {
    const m = sameEveryOrder([base, row('A', 2, [grant('p', 'c', 'use')]), row('B', 1, [grant('p', 'c', 'read')], A(1))]);
    expect(m.grants.get('p')?.get('c')).toBe('read');
  });

  it('a removal beats a grant it never saw', () => {
    const m = sameEveryOrder([base, row('A', 2, [grant('p', 'c', 'use')]), row('B', 1, [ungrant('p', 'c')], A(1))]);
    expect(m.grants.get('p')?.has('c') ?? false).toBe(false);
  });

  it('a re-grant that saw the removal stands: only person-remove is for good', () => {
    const m = sameEveryOrder([base, row('A', 2, [grant('p', 'c')]), row('A', 3, [ungrant('p', 'c')]), row('B', 1, [grant('p', 'c')], A(3))]);
    expect(m.grants.get('p')?.get('c')).toBe('use');
  });

  it('different conversations do not conflict', () => {
    const m = sameEveryOrder([base, row('A', 2, [ungrant('p', 'c')]), row('B', 1, [grant('p', 'd')], A(1))]);
    expect(m.grants.get('p')?.get('d')).toBe('use');
  });

  it('a removed person stays removed, whatever comes after, on every machine', () => {
    const m = sameEveryOrder([base, row('A', 2, [{ type: 'person-remove', personKey: 'p' }]), row('B', 1, [add('p'), grant('p', 'c')], A(2))]);
    expect(m.people.has('p')).toBe(false);
    expect(m.grants.has('p')).toBe(false);
    expect(m.removed.has('p')).toBe(true);
  });

  it('roles: the lower of two unseen changes wins; a seen one replaces', () => {
    const lower = sameEveryOrder([base, row('A', 2, [{ type: 'person-set', personKey: 'p', role: 'guest' }]), row('B', 1, [{ type: 'person-set', personKey: 'p', role: 'member' }], A(1))]);
    expect(lower.people.get('p')?.role).toBe('guest');
    const raised = sameEveryOrder([base, row('A', 2, [{ type: 'person-set', personKey: 'p', role: 'guest' }]), row('B', 1, [{ type: 'person-set', personKey: 'p', role: 'member' }], A(2))]);
    expect(raised.people.get('p')?.role).toBe('member');
  });

  it('team-off beats what it never saw, and a new start that saw it stands', () => {
    const off = sameEveryOrder([base, row('A', 2, [{ type: 'team-off' }]), row('B', 1, [add('q')], A(1))]);
    expect(off.on).toBe(false);
    expect(off.people.size).toBe(0);
    const again = sameEveryOrder([base, row('A', 2, [{ type: 'team-off' }]), row('B', 1, [on, add('q')], A(2))]);
    expect(again.on).toBe(true);
    expect([...again.people.keys()]).toEqual(['q']);
  });

  it('the reviewed sequence: a voided re-grant cannot undo a removal', () => {
    // E0 grants on M. R removes on S, not seeing E0. W re-grants on L, having seen R but not E0, then L is declared gone.
    const rows: MergeRow[] = [
      row('O', 1, [on, add('p')]),
      row('M', 1, [grant('p', 'c')], { [streamKey('O', 'i1')]: 1 }),
      row('S', 1, [ungrant('p', 'c')], { [streamKey('O', 'i1')]: 1 }),
      row('L', 1, [grant('p', 'c')], { [streamKey('O', 'i1')]: 1, [streamKey('S', 'i1')]: 1 }),
      row('O', 2, [{ type: 'origin-gone', machine: 'L', incarnation: 'i1', throughSeq: 0 }]),
    ];
    const m = sameEveryOrder(rows);
    expect(m.grants.get('p')?.has('c') ?? false).toBe(false);
    expect(m.voided).toHaveLength(1);
  });

  it('a gone origin that returns can still narrow, and cannot widen', () => {
    const gone: MergeEvent = { type: 'origin-gone', machine: 'L', incarnation: 'i1', throughSeq: 1 };
    const m = sameEveryOrder([
      row('O', 1, [on, add('p'), grant('p', 'c')]),
      row('O', 2, [gone]),
      row('L', 2, [ungrant('p', 'c')], { [streamKey('O', 'i1')]: 1 }),
      row('L', 3, [grant('p', 'd')], { [streamKey('O', 'i1')]: 1 }),
    ]);
    expect(m.grants.get('p')?.has('c') ?? false).toBe(false);
    expect(m.grants.get('p')?.has('d') ?? false).toBe(false);
  });

  it('a grant to someone not on the agent gives nothing', () => {
    const m = sameEveryOrder([row('A', 1, [on, grant('ghost', 'c')])]);
    expect(m.grants.size).toBe(0);
  });

  it('the same row delivered twice counts once', () => {
    const r = row('A', 1, [on, add('p')]);
    expect(flat(mergeRows([r, r]))).toBe(flat(mergeRows([r])));
  });

  it('never depends on arrival order, across many mixed histories', () => {
    let seed = 7;
    const rnd = (k: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
    const pool = (): MergeEvent => [grant('p', 'c', 'use'), grant('p', 'c', 'read'), ungrant('p', 'c'), grant('p', 'd'), { type: 'person-set', personKey: 'p', role: 'guest' } as MergeEvent][rnd(5)];
    for (let i = 0; i < 60; i++) {
      const rows = [row('A', 1, [on, add('p')]), row('A', 2, [pool()]), row('B', 1, [pool()], rnd(2) ? A(rnd(3)) : {}), row('C', 1, [pool()], { ...A(rnd(3)), ...B(rnd(2)) })];
      sameEveryOrder(rows);
    }
  });
});

describe('findGaps', () => {
  it('a whole chain has none', () => {
    expect(findGaps([row('A', 1, []), row('A', 2, []), row('A', 3, [])])).toEqual([]);
  });
  it('a sleeping machine holding rows nobody has here is not a gap', () => {
    expect(findGaps([row('A', 1, []), row('A', 2, [])])).toEqual([]);
  });
  it('a missing middle row is seen', () => {
    expect(findGaps([row('A', 1, []), row('A', 3, [])])).toEqual([{ kind: 'chain-break', origin: 'A', incarnation: 'i1', afterSeq: 1 }]);
  });
  it('a row whose previous hash does not match is seen', () => {
    expect(findGaps([row('A', 1, []), row('A', 2, [], {}, { prev: 'other' })])).toHaveLength(1);
  });
  it('two rows with one identity are a fork', () => {
    const g = findGaps([row('A', 1, []), row('A', 2, []), row('A', 2, [], {}, { hash: 'different' })]);
    expect(g).toContainEqual({ kind: 'fork', origin: 'A', incarnation: 'i1', seq: 2 });
  });
  it('a new incarnation proves a lost tail, unless the owner already named that machine', () => {
    const older = row('A', 1, [], {}, { incarnation: 'i0' });
    expect(findGaps([older, row('A', 2, [])])).toEqual([{ kind: 'new-incarnation', origin: 'A', incarnation: 'i1', previous: 'i0', throughSeq: 1 }]);
    const named: MergeEvent = { type: 'origin-gone', machine: 'A', incarnation: 'i0', throughSeq: 1 };
    expect(findGaps([older, row('A', 2, []), row('B', 1, [named])])).toEqual([]);
  });
  it('a gap the owner accepted does not read as damage again', () => {
    const accepted: MergeEvent = { type: 'origin-gone', machine: 'A', incarnation: 'i1', throughSeq: 3 };
    expect(findGaps([row('A', 1, []), row('A', 4, [], {}, { prev: 'x' }), row('B', 1, [accepted])])).toEqual([]);
  });
  it('does not depend on arrival order', () => {
    const rows = [row('A', 1, []), row('A', 3, []), row('B', 1, [])];
    const answers = new Set(permutations(rows).map((p) => JSON.stringify(findGaps(p))));
    expect(answers.size).toBe(1);
  });
});

describe('mayReadMessage', () => {
  const stream = streamKey('L', 'i1');
  const grantRow = { stream: streamKey('S', 'i1'), seq: 5, seenMessages: { [stream]: 10 } };
  const msg = (seq: number, access: Record<string, number> = {}, authorKey: string | null = null) => ({ authorKey, origin: 'L', incarnation: 'i1', seq, access });

  it('history the grant had seen opens to the reader', () => {
    expect(mayReadMessage(msg(10), 'mia', [grantRow])).toBe(true);
  });
  it('a row written unaware of the reader, after the grant, is held from them', () => {
    expect(mayReadMessage(msg(11), 'mia', [grantRow])).toBe(false);
  });
  it('a row whose session knew of the grant is theirs', () => {
    expect(mayReadMessage(msg(11, { [streamKey('S', 'i1')]: 5 }), 'mia', [grantRow])).toBe(true);
  });
  it('a session that knew an older state does not count as knowing the grant', () => {
    expect(mayReadMessage(msg(11, { [streamKey('S', 'i1')]: 4 }), 'mia', [grantRow])).toBe(false);
  });
  it('an author always sees their own words, with no grant at all', () => {
    expect(mayReadMessage(msg(99, {}, 'mia'), 'mia', [])).toBe(true);
    expect(mayReadMessage(msg(99, {}, 'mia'), 'sam', [])).toBe(false);
  });
  it('any of a reader\'s grants is enough, so a later change does not hide what they had', () => {
    const lagging = { stream: streamKey('T', 'i1'), seq: 2, seenMessages: {} };
    expect(mayReadMessage(msg(10), 'mia', [lagging, grantRow])).toBe(true);
  });
  it('no grant means nothing', () => {
    expect(mayReadMessage(msg(1), 'mia', [])).toBe(false);
  });
  it('a restored machine\'s rewound numbers are a different stream, so they are not mistaken for seen', () => {
    expect(mayReadMessage({ ...msg(5), incarnation: 'i2' }, 'mia', [grantRow])).toBe(false);
  });
});
