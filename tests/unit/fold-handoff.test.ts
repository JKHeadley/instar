/**
 * Unit — the session-authored fold handoff (context-budget-layered-summaries
 * §7.4; Phase 2 slice P2-1): parser strictness and the deterministic verifier,
 * both sides of every boundary.
 */
import { describe, it, expect } from 'vitest';
import { parseHandoff, verifyHandoff, buildHandoffRequest, HANDOFF_SCHEMA, HANDOFF_LIMITS, type Handoff, type HandoffContext } from '../../src/monitoring/foldHandoff.js';

const OP_TEXT = 'Keep the operator words verbatim across every fold.';

function handoff(over: Partial<Handoff> = {}): Handoff {
  return {
    schema: HANDOFF_SCHEMA,
    finished: [{ fromMessageId: 1, toMessageId: 4, outcome: 'Built the layer store.', artifacts: ['PR #3043'] }],
    stillNeeded: [{ text: OP_TEXT, origin: 'user' }],
    openThreads: ['wire the probe'],
    nextStep: 'Open the PR.',
    background: 'none',
    decisions: [],
    ...over,
  };
}

function ctx(over: Partial<HandoffContext> = {}): HandoffContext {
  const messages = [
    { messageId: 1, fromUser: true, text: OP_TEXT },
    { messageId: 2, fromUser: false, text: 'ok' },
    { messageId: 3, fromUser: true, text: 'Use the sampler.' },
    { messageId: 4, fromUser: false, text: 'done' },
    { messageId: 5, fromUser: true, text: 'next?' },
    { messageId: 6, fromUser: false, text: 'working' },
  ];
  return { messages, archivedEntryIds: new Set(['e-41']), backgroundEvidence: 'none', ...over };
}

describe('parseHandoff', () => {
  it('accepts a well-formed handoff, fenced or not', () => {
    const raw = JSON.stringify(handoff());
    expect(parseHandoff(raw).ok).toBe(true);
    expect(parseHandoff('```json\n' + raw + '\n```').ok).toBe(true);
  });

  it('refuses empty, non-JSON, non-object and wrong-schema input by name', () => {
    expect(parseHandoff('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseHandoff('not json')).toEqual({ ok: false, reason: 'not-json' });
    expect(parseHandoff('[]')).toEqual({ ok: false, reason: 'not-an-object' });
    expect(parseHandoff(JSON.stringify({ ...handoff(), schema: 'fold-handoff/0' }))).toEqual({ ok: false, reason: 'schema' });
  });

  it('refuses an invented field instead of storing it', () => {
    const r = parseHandoff(JSON.stringify({ ...handoff(), confidence: 0.9 }));
    expect(r).toEqual({ ok: false, reason: 'unknown-field:confidence' });
  });

  it('refuses bad origins, bad ranges and over-bound lists', () => {
    expect(parseHandoff(JSON.stringify(handoff({ stillNeeded: [{ text: 'x', origin: 'operator' }] }))).ok).toBe(false);
    expect(parseHandoff(JSON.stringify(handoff({ stillNeeded: [{ text: 'x', origin: 'tool:bad id!' }] }))).ok).toBe(false);
    expect(parseHandoff(JSON.stringify(handoff({ finished: [{ fromMessageId: -1, toMessageId: 2, outcome: 'x', artifacts: [] }] }))).ok).toBe(false);
    const many = Array.from({ length: HANDOFF_LIMITS.openThreads + 1 }, (_, i) => `t${i}`);
    expect(parseHandoff(JSON.stringify(handoff({ openThreads: many }))).ok).toBe(false);
    expect(parseHandoff(JSON.stringify(handoff({ openThreads: many.slice(1) }))).ok).toBe(true);
  });

  it('accepts a missing decisions list as empty', () => {
    const { decisions: _d, ...rest } = handoff();
    const r = parseHandoff(JSON.stringify(rest));
    expect(r.ok && r.value.decisions).toEqual([]);
  });
});

describe('verifyHandoff', () => {
  it('passes a clean handoff and accounts for every message once', () => {
    const v = verifyHandoff(handoff(), ctx());
    expect(v.ok).toBe(true);
    expect(v.items[0]).toEqual({ text: OP_TEXT, origin: 'user', messageId: 1, relabelled: false });
    expect(v.coverage).toEqual({ chunked: [{ span: 0, messageIds: [1, 2, 3, 4] }], tail: [5, 6], unclassified: [], total: 6 });
  });

  it('relabels a "user" item that is not a whole operator row, and records it', () => {
    const v = verifyHandoff(handoff({ stillNeeded: [{ text: 'Keep the operator words verbatim', origin: 'user' }] }), ctx());
    expect(v.ok).toBe(true);
    expect(v.items[0]).toMatchObject({ origin: 'agent', relabelled: true });
    expect(v.relabels).toEqual([{ index: 0, reason: 'not-a-whole-operator-row' }]);
  });

  it('never accepts an agent message as a "user" origin even when the bytes match', () => {
    const v = verifyHandoff(handoff({ stillNeeded: [{ text: 'done', origin: 'user' }] }), ctx());
    expect(v.items[0]).toMatchObject({ origin: 'agent', relabelled: true });
  });

  it('a tool origin must resolve to an archived entry', () => {
    expect(verifyHandoff(handoff({ stillNeeded: [{ text: 'exit 0', origin: 'tool:e-41' }] }), ctx()).ok).toBe(true);
    const bad = verifyHandoff(handoff({ stillNeeded: [{ text: 'exit 0', origin: 'tool:e-99' }] }), ctx());
    expect(bad.ok).toBe(false);
    expect(bad.deficiencies.map((d) => d.code)).toEqual(['tool-entry-unresolved']);
  });

  it('flags spans outside the context, inverted and overlapping', () => {
    const v = verifyHandoff(handoff({ finished: [
      { fromMessageId: 1, toMessageId: 3, outcome: 'a', artifacts: [] },
      { fromMessageId: 3, toMessageId: 4, outcome: 'b', artifacts: [] },
      { fromMessageId: 6, toMessageId: 5, outcome: 'c', artifacts: [] },
      { fromMessageId: 5, toMessageId: 99, outcome: 'd', artifacts: [] },
    ] }), ctx());
    expect(v.deficiencies.map((d) => d.code)).toEqual(['span-overlap', 'span-inverted', 'span-out-of-context']);
    expect(v.coverage.chunked).toEqual([{ span: 0, messageIds: [1, 2, 3] }]);
  });

  it('a gap between finished stretches is retained as unclassified', () => {
    const v = verifyHandoff(handoff({ finished: [
      { fromMessageId: 1, toMessageId: 2, outcome: 'a', artifacts: [] },
      { fromMessageId: 4, toMessageId: 5, outcome: 'b', artifacts: [] },
    ] }), ctx());
    expect(v.coverage).toMatchObject({ unclassified: [3], tail: [6], total: 6 });
  });

  it('no finished stretch keeps the whole context as tail', () => {
    const v = verifyHandoff(handoff({ finished: [] }), ctx());
    expect(v.coverage).toMatchObject({ chunked: [], tail: [1, 2, 3, 4, 5, 6], unclassified: [] });
  });

  it('background declared none or paused while the evidence says live is a contradiction; unknown is not', () => {
    expect(verifyHandoff(handoff({ background: 'none' }), ctx({ backgroundEvidence: 'live' })).deficiencies[0].code).toBe('background-contradiction');
    expect(verifyHandoff(handoff({ background: 'paused' }), ctx({ backgroundEvidence: 'live' })).ok).toBe(false);
    expect(verifyHandoff(handoff({ background: 'live' }), ctx({ backgroundEvidence: 'live' })).ok).toBe(true);
    expect(verifyHandoff(handoff({ background: 'none' }), ctx({ backgroundEvidence: 'unknown' })).ok).toBe(true);
  });

  it('a decision binds to an operator row only on an exact whole-row match', () => {
    const v = verifyHandoff(handoff({ decisions: [{ kind: 'decision', quote: 'Use the sampler.' }, { kind: 'evolution', quote: 'Use the sampler' }] }), ctx());
    expect(v.decisions.map((d) => d.boundMessageId)).toEqual([3, null]);
  });
});

describe('buildHandoffRequest and tool provenance', () => {
  it('never asks a session for a transcript entry id it was not given', () => {
    const r = buildHandoffRequest({ foldId: 'f', messages: [{ messageId: 1, at: null, fromUser: true, text: 'hi' }] });
    expect(r).toContain('"origin":"user|agent|tool|other"');
    expect(r).not.toContain('tool:<entry>');
  });

  it('a bare tool origin is accepted, stays tool-origin, and needs no entry id', () => {
    const h = handoff({ stillNeeded: [{ text: 'exit 0', origin: 'tool' }] });
    expect(parseHandoff(JSON.stringify(h)).ok).toBe(true);
    const v = verifyHandoff(h, ctx());
    expect(v.ok).toBe(true);
    expect(v.items[0]).toMatchObject({ origin: 'tool', relabelled: false });
    expect(v.items[0].entryId).toBeUndefined();
  });
});
