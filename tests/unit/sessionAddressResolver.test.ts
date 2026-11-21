import { describe, it, expect } from 'vitest';
import { resolveSessionTarget, normalizeTmuxName, type ResolverSession, type ResolverContext } from '../../src/messaging/sessionAddressResolver.js';

const T0 = Date.parse('2026-11-18T12:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function s(p: Partial<ResolverSession> & { tmuxSession: string }): ResolverSession {
  return { id: p.tmuxSession + ':' + (p.startedAt ?? at(0)), name: p.tmuxSession.replace(/^echo-/, ''), status: 'running', startedAt: at(0), ...p };
}

function ctx(sessions: ResolverSession[], extra: Partial<ResolverContext> = {}): ResolverContext {
  return {
    sessions,
    sessionNameForTopic: () => null,
    isStandingDown: () => false,
    prefix: 'echo',
    asOf: T0 + 60 * 60_000,
    ...extra,
  };
}

describe('sessionAddressResolver', () => {
  it('normalizes one repeated prefix only', () => {
    expect(normalizeTmuxName('echo-echo-x', 'echo')).toBe('echo-x');
    expect(normalizeTmuxName('echo-x', 'echo')).toBe('echo-x');
    expect(normalizeTmuxName('echo-chamber', 'echo')).toBe('echo-chamber');
  });

  it('rule 1: exact running name', () => {
    const r = resolveSessionTarget('echo-a', ctx([s({ tmuxSession: 'echo-a' })]));
    expect(r).toMatchObject({ kind: 'exact', via: 'exact' });
  });

  it('rule 2: topic alias reaches the registry holder', () => {
    const holder = s({ tmuxSession: 'echo-chief-of-staff', name: 'echo-chief-of-staff', telegramTopicId: 141385 });
    const r = resolveSessionTarget('echo-topic-141385', ctx([holder], { sessionNameForTopic: (t) => (t === 141385 ? 'echo-chief-of-staff' : null) }));
    expect(r).toMatchObject({ kind: 'redirected', via: 'topic' });
    if (r.kind === 'redirected') expect(r.session.tmuxSession).toBe('echo-chief-of-staff');
  });

  it('rule 2: the old name of a topic session reaches the respawned holder', () => {
    const old = s({ tmuxSession: 'echo-machine-stewardship', name: 'machine-stewardship', telegramTopicId: 144503, status: 'completed', startedAt: at(-600) });
    const now = s({ tmuxSession: 'echo-echo-machine-stewardship', name: 'echo-machine-stewardship', telegramTopicId: 144503, startedAt: at(-30) });
    const r = resolveSessionTarget('echo-machine-stewardship', ctx([old, now]));
    expect(r).toMatchObject({ kind: 'redirected', via: 'topic' });
  });

  it('topic beats name: a topic record with no holder is none, never a name match', () => {
    const old = s({ tmuxSession: 'echo-x', name: 'x', telegramTopicId: 7, status: 'completed' });
    const other = s({ tmuxSession: 'echo-y', name: 'x', telegramTopicId: 8 });
    const r = resolveSessionTarget('echo-x', ctx([old, other]));
    expect(r).toMatchObject({ kind: 'none', reason: 'topic-not-held-here' });
  });

  it('topic held on another machine names it', () => {
    const old = s({ tmuxSession: 'echo-x', telegramTopicId: 7, status: 'completed' });
    const r = resolveSessionTarget('echo-x', ctx([old], { topicHeldElsewhere: () => 'm_mini' }));
    expect(r).toMatchObject({ kind: 'none', reason: 'topic-held-on', heldOn: 'm_mini' });
  });

  it('two holders of one topic are ambiguous, never a guess', () => {
    const a = s({ tmuxSession: 'echo-a', telegramTopicId: 5 });
    const b = s({ tmuxSession: 'echo-b', telegramTopicId: 5 });
    const r = resolveSessionTarget('echo-topic-5', ctx([a, b]));
    expect(r).toMatchObject({ kind: 'ambiguous', candidates: ['echo-a', 'echo-b'] });
  });

  it('first rule decides: an ambiguous topic rule does not fall through to name', () => {
    const old = s({ tmuxSession: 'echo-r', name: 'r', telegramTopicId: 5, status: 'completed' });
    const a = s({ tmuxSession: 'echo-a', telegramTopicId: 5 });
    const b = s({ tmuxSession: 'echo-b', telegramTopicId: 5 });
    const named = s({ tmuxSession: 'echo-r2', name: 'r' });
    const r = resolveSessionTarget('echo-r', ctx([old, a, b, named]));
    expect(r.kind).toBe('ambiguous');
  });

  it('rule 3: a topic-less role reaches its running session by stored name', () => {
    const old = s({ tmuxSession: 'echo-helper-1', name: 'helper', status: 'completed', startedAt: at(-100) });
    const now = s({ tmuxSession: 'echo-helper-2', name: 'helper', startedAt: at(-10) });
    const r = resolveSessionTarget('echo-helper-1', ctx([old, now]));
    expect(r).toMatchObject({ kind: 'redirected', via: 'name' });
  });

  it('rule 4: double-prefixed respawn of a topic-less role is one role', () => {
    const old = s({ tmuxSession: 'echo-increasing-throughput', name: 'increasing-throughput', status: 'completed', startedAt: at(-500) });
    const now = s({ tmuxSession: 'echo-echo-increasing-throughput', name: 'echo-increasing-throughput', startedAt: at(-20) });
    const r = resolveSessionTarget('echo-increasing-throughput', ctx([old, now]));
    expect(r.kind).toBe('redirected');
  });

  it('rule 4: two different roles sharing a normalized name are ambiguous', () => {
    const chamber = s({ tmuxSession: 'echo-chamber', name: 'chamber', jobSlug: 'chamber-job', status: 'completed' });
    const echoChamber = s({ tmuxSession: 'echo-echo-chamber', name: 'echo-chamber' });
    const r = resolveSessionTarget('echo-chamber', ctx([chamber, echoChamber]));
    expect(r.kind).toBe('ambiguous');
  });

  it('a finished job run never reaches the next run', () => {
    const run1 = s({ tmuxSession: 'echo-job-x-1', name: 'job-x', jobSlug: 'x', status: 'completed' });
    const run2 = s({ tmuxSession: 'echo-job-x-2', name: 'job-x', jobSlug: 'x' });
    const r = resolveSessionTarget('echo-job-x-1', ctx([run1, run2]));
    expect(r).toMatchObject({ kind: 'none', reason: 'job-run-ended' });
  });

  it('freshness: a session started after the message is refused, by every rule', () => {
    const later = s({ tmuxSession: 'echo-a', startedAt: at(90) });
    expect(resolveSessionTarget('echo-a', ctx([later]))).toMatchObject({ kind: 'none', reason: 'role-respawned-after-message' });
    const old = s({ tmuxSession: 'echo-b', telegramTopicId: 9, status: 'completed' });
    const laterTopic = s({ tmuxSession: 'echo-topic-9', telegramTopicId: 9, startedAt: at(90) });
    expect(resolveSessionTarget('echo-b', ctx([old, laterTopic]))).toMatchObject({ kind: 'none', reason: 'role-respawned-after-message' });
  });

  it('freshness filters before counting: a stale twin does not make a fresh holder ambiguous', () => {
    const fresh = s({ tmuxSession: 'echo-a', telegramTopicId: 5, startedAt: at(-5) });
    const stale = s({ tmuxSession: 'echo-b', telegramTopicId: 5, startedAt: at(90) });
    const r = resolveSessionTarget('echo-topic-5', ctx([fresh, stale]));
    expect(r).toMatchObject({ kind: 'redirected' });
  });

  it('a standing-down conversation is never a candidate', () => {
    const a = s({ tmuxSession: 'echo-a', telegramTopicId: 5 });
    const r = resolveSessionTarget('echo-a', ctx([a], { isStandingDown: (t) => t === 5 }));
    expect(r.kind).toBe('none');
  });

  it('nobody holds an unknown role', () => {
    expect(resolveSessionTarget('echo-nope', ctx([s({ tmuxSession: 'echo-a' })]))).toMatchObject({ kind: 'none', reason: 'no-session-holds-this-role' });
  });
});
