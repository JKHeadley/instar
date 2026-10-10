/**
 * a2a-single-agent-identity §1.1 / §2.2 — the identity attention items must be re-raisable.
 *
 * The attention store answers a create for any id it has EVER held with the existing row
 * (a resolved one included) and never updates a body. These tests drive the episode-aware
 * helper over a store with exactly that behaviour and prove the three promises that were
 * silently impossible without it: a second loss re-raises, a recurring split re-raises, and
 * a changed refusal reason replaces the open item's text.
 */
import { describe, it, expect } from 'vitest';
import { tolerantRegistryMachines } from '../../src/core/AgentIdentityRuntime.js';
import { IdentityAttentionItems, identityItemBaseId, type IdentityItemRow } from '../../src/core/AgentIdentityItems.js';

/** A store with the production semantics: create is a no-op for a known id; nothing is deleted. */
function store() {
  const rows = new Map<string, IdentityItemRow>();
  const created: string[] = [];
  const s = new IdentityAttentionItems({
    list: () => [...rows.values()],
    create: (i) => {
      if (rows.has(i.id)) return; // the real store returns the existing row
      rows.set(i.id, { id: i.id, status: 'OPEN', description: i.body });
      created.push(i.id);
    },
    resolve: (id) => { const r = rows.get(id); if (r) r.status = 'DONE'; },
  });
  return { s, rows, created };
}

const item = (body: string, id = 'agent-identity-missing:echo:m_b') => ({ id, title: 't', body, priority: 'high' });

describe('IdentityAttentionItems', () => {
  it('first raise creates the base id; the same body again is one item, not two', () => {
    const { s, created } = store();
    expect(s.raise(item('no identity: single-witness'))).toEqual({ outcome: 'created', id: 'agent-identity-missing:echo:m_b' });
    expect(s.raise(item('no identity: single-witness')).outcome).toBe('unchanged');
    expect(created).toEqual(['agent-identity-missing:echo:m_b']);
  });

  it('a changed reason REPLACES the open item so the open one always carries the current text', () => {
    const { s, rows } = store();
    s.raise(item('reason: single-witness'));
    const r = s.raise(item('reason: disagree'));
    expect(r).toEqual({ outcome: 'replaced', id: 'agent-identity-missing:echo:m_b#2' });
    expect(rows.get('agent-identity-missing:echo:m_b')?.status).toBe('DONE');
    expect(rows.get('agent-identity-missing:echo:m_b#2')).toMatchObject({ status: 'OPEN', description: 'reason: disagree' });
  });

  it('a second loss after a resolve is a NEW open item (the store alone would swallow it)', () => {
    const { s, rows } = store();
    s.raise(item('lost'));
    expect(s.resolve('agent-identity-missing:echo:m_b')).toBe(1);
    const again = s.raise(item('lost'));
    expect(again).toEqual({ outcome: 'created', id: 'agent-identity-missing:echo:m_b#2' });
    expect([...rows.values()].filter((r) => r.status === 'OPEN').map((r) => r.id)).toEqual(['agent-identity-missing:echo:m_b#2']);
    // …and a third time picks the next free suffix.
    s.resolve('agent-identity-missing:echo:m_b');
    expect(s.raise(item('lost')).id).toBe('agent-identity-missing:echo:m_b#3');
  });

  it('an operator WONT_DO on this exact text stands (no re-post per restart); a CHANGED text is a new fact and is raised', () => {
    const { s, rows, created } = store();
    s.raise(item('split aa/bb', 'agent-identity-split:echo:aa+bb'));
    rows.get('agent-identity-split:echo:aa+bb')!.status = 'WONT_DO';
    expect(s.raise(item('split aa/bb', 'agent-identity-split:echo:aa+bb')).outcome).toBe('unchanged');
    expect(created).toHaveLength(1);
    expect(s.raise(item('split aa/bb — now the laptop too', 'agent-identity-split:echo:aa+bb'))).toEqual({ outcome: 'created', id: 'agent-identity-split:echo:aa+bb#2' });
  });

  it('a WONT_DO stands only while its condition lasts: once resolved, the same text recurring is raised again', () => {
    const { s, rows } = store();
    s.raise(item('split aa/bb', 'agent-identity-split:echo:aa+bb'));
    rows.get('agent-identity-split:echo:aa+bb')!.status = 'WONT_DO';
    expect(s.raise(item('split aa/bb', 'agent-identity-split:echo:aa+bb')).outcome).toBe('unchanged'); // still dismissed
    s.resolve('agent-identity-split:echo:aa+bb'); // the split healed
    expect(rows.get('agent-identity-split:echo:aa+bb')!.status).toBe('DONE');
    expect(s.raise(item('split aa/bb', 'agent-identity-split:echo:aa+bb'))).toEqual({ outcome: 'created', id: 'agent-identity-split:echo:aa+bb#2' });
  });

  it('resolve closes every open episode of the base id and nothing else; an unknown id is a no-op', () => {
    const { s, rows } = store();
    s.raise(item('a', 'agent-identity-split:echo:aa+bb'));
    s.raise(item('b', 'agent-identity-split:echo:aa+bb+cc'));
    expect(s.resolve('agent-identity-split:echo:aa+bb')).toBe(1);
    expect(rows.get('agent-identity-split:echo:aa+bb+cc')?.status).toBe('OPEN');
    expect(s.resolve('agent-identity-split:echo:never-raised')).toBe(0);
  });

  it('openBaseIds lists OPEN items under a prefix by base id — what a restarted detector re-adopts', () => {
    const { s, rows } = store();
    s.raise(item('a', 'agent-identity-split:echo:aa+bb'));
    s.resolve('agent-identity-split:echo:aa+bb');
    s.raise(item('a', 'agent-identity-split:echo:aa+bb')); // recurrence → #2
    s.raise(item('x', 'agent-identity-cannot-tell:echo:m_x'));
    expect(s.openBaseIds('agent-identity-split:echo:')).toEqual(['agent-identity-split:echo:aa+bb']);
    // A dismissed item is re-adopted too (so it is retired when its condition clears); a DONE one is not.
    rows.get('agent-identity-split:echo:aa+bb#2')!.status = 'WONT_DO';
    expect(s.openBaseIds('agent-identity-split:echo:')).toEqual(['agent-identity-split:echo:aa+bb']);
    s.resolve('agent-identity-split:echo:aa+bb');
    expect(s.openBaseIds('agent-identity-split:echo:')).toEqual([]);
    expect(identityItemBaseId('agent-identity-split:echo:aa+bb#2')).toBe('agent-identity-split:echo:aa+bb');
  });

  it('stateless across a restart: a fresh helper over the same store neither duplicates nor loses the open episode', () => {
    const { s, rows, created } = store();
    s.raise(item('still split', 'agent-identity-split:echo:aa+bb'));
    const afterRestart = new IdentityAttentionItems({
      list: () => [...rows.values()],
      create: (i) => { rows.set(i.id, { id: i.id, status: 'OPEN', description: i.body }); created.push(i.id); },
      resolve: (id) => { const r = rows.get(id); if (r) r.status = 'DONE'; },
    });
    expect(afterRestart.raise(item('still split', 'agent-identity-split:echo:aa+bb')).outcome).toBe('unchanged');
    expect(created).toHaveLength(1);
    expect(afterRestart.resolve('agent-identity-split:echo:aa+bb')).toBe(1);
  });
});

describe('tolerantRegistryMachines — a corrupt registry never crashes an identity round', () => {
  it('reads through when healthy; an unreadable registry reads as no machines and is reported once per distinct error, again after a recovery', () => {
    let mode: 'ok' | 'corrupt' | 'denied' | 'undefined' = 'ok';
    const reported: string[] = [];
    const read = tolerantRegistryMachines<{ nickname: string }>(() => {
      if (mode === 'corrupt') throw new Error('REGISTRY_CORRUPT');
      if (mode === 'denied') throw new Error('EACCES');
      if (mode === 'undefined') return undefined;
      return { m_a: { nickname: 'mini' } };
    }, (m) => reported.push(m));
    expect(read()).toEqual({ m_a: { nickname: 'mini' } });
    mode = 'corrupt';
    expect(read()).toEqual({});
    expect(read()).toEqual({});
    expect(reported).toEqual(['REGISTRY_CORRUPT']); // not once per tick
    mode = 'denied';
    expect(read()).toEqual({});
    expect(reported).toEqual(['REGISTRY_CORRUPT', 'EACCES']);
    mode = 'ok';
    expect(read()).toEqual({ m_a: { nickname: 'mini' } });
    mode = 'corrupt';
    read();
    expect(reported).toEqual(['REGISTRY_CORRUPT', 'EACCES', 'REGISTRY_CORRUPT']); // broken anew is reported anew
    mode = 'undefined';
    expect(read()).toEqual({});
  });
});
