/**
 * Per-kind ports for app and Slack conversations (docs/specs/session-swap-any-conversation.md §3.1, §3.2).
 */
import { describe, it, expect } from 'vitest';
import { createConversationPorts, conversationResumeViews, SLACK_RESTART_PROMPT, type ConversationPortsDeps, type Landed } from '../../src/core/conversationPorts.js';

const KEY = '0f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f';
const APP = `app:${KEY}`;

function world(over: { owner?: boolean; noApp?: boolean; noSlack?: boolean; killOk?: boolean } = {}) {
  const running = new Set(['app-s', 'slack-s', 'tg-s']);
  const log: string[] = [];
  const inFlight = new Set<string>();
  const deps: ConversationPortsDeps = {
    runningNames: () => [...running],
    killByTmuxName: (n) => { log.push(`kill ${n}`); if (over.killOk === false) return false; running.delete(n); return true; },
    inFlight,
    app: () => over.noApp ? null : {
      sessionFor: (k) => (k === KEY ? 'app-s' : null),
      isOwner: () => over.owner !== false,
      conversationOfSession: (t) => (t === 'app-s' ? KEY : null),
      start: async (k, want) => { log.push(`app-start ${k} ${want.framework} inflight=${inFlight.has(APP)}`); running.add('app-s2'); return want; },
      disclose: async (k, text) => { log.push(`app-say ${k} ${text}`); },
    },
    slack: () => over.noSlack ? null : {
      sessionFor: (rk) => (rk === 'C0ABC' ? 'slack-s' : null),
      routingKeyOfSession: (t) => (t === 'slack-s' ? 'C0ABC' : null),
      respawn: async (rk, prompt) => { log.push(`slack-respawn ${rk} ${prompt === SLACK_RESTART_PROMPT}`); running.add('slack-s2'); return 'slack-s2'; },
      launchedOn: (n): Landed | null => (n === 'slack-s2' ? { framework: 'codex-cli', model: 'gpt-6' } : null),
      send: async (rk, text) => { log.push(`slack-say ${rk} ${text}`); },
    },
  };
  return { ports: createConversationPorts(deps), log, running, inFlight };
}

describe('conversation ports', () => {
  it('find each kind\'s live session, and nothing for a Telegram key or a gone session', () => {
    const w = world();
    expect(w.ports.session(APP)).toBe('app-s');
    expect(w.ports.session('slack:C0ABC')).toBe('slack-s');
    expect(w.ports.session('slack:C0XYZ')).toBeNull();
    expect(w.ports.session('134088')).toBeNull();
    w.running.delete('app-s');
    expect(w.ports.session(APP)).toBeNull();
  });
  it('list app and Slack sessions with their profile keys, so sweeps and escalation see them', () => {
    expect(world().ports.listSessions()).toEqual([{ topicKey: APP, sessionName: 'app-s' }, { topicKey: 'slack:C0ABC', sessionName: 'slack-s' }]);
    expect(world({ noApp: true, noSlack: true }).ports.listSessions()).toEqual([]);
  });
  it('start answers what each kind landed on', async () => {
    const w = world();
    expect(await w.ports.start(APP, { framework: 'codex-cli', model: 'gpt-6' })).toEqual({ framework: 'codex-cli', model: 'gpt-6' });
    expect(await w.ports.start('slack:C0ABC', { framework: 'codex-cli' })).toEqual({ framework: 'codex-cli', model: 'gpt-6' });
    expect(await w.ports.start(APP, { framework: 'codex-cli', model: 'x', modelTier: 'opus' })).toEqual({ framework: 'codex-cli', model: null });
    expect(await w.ports.start('134088', { framework: 'codex-cli' })).toBeNull();
    expect(w.log).toContain('slack-respawn C0ABC true');
  });
  it('restart: kill by tmux name, start with the in-flight mark set, then clear it', async () => {
    const w = world();
    expect(await w.ports.restart(APP, { framework: 'codex-cli' })).toEqual({ respawned: true });
    expect(w.log.slice(0, 2)).toEqual(['kill app-s', `app-start ${KEY} codex-cli inflight=true`]);
    expect(w.inFlight.size).toBe(0);
  });
  it('restart: nothing running ⇒ no change; a kill that fails ⇒ nothing started, said', async () => {
    expect(await world().ports.restart('slack:C0XYZ', { framework: 'codex-cli' })).toEqual({ respawned: false });
    const w = world({ killOk: false });
    expect(await w.ports.restart(APP, { framework: 'codex-cli' })).toEqual({ respawned: false, error: 'the old session did not stop' });
    expect(w.log.some((l) => l.startsWith('app-start'))).toBe(false);
  });
  it('disclose in the conversation itself; an app notice only where it is served', async () => {
    const w = world();
    await w.ports.disclose(APP, 'Now on Codex.');
    await w.ports.disclose('slack:C0ABC', 'Now on Codex.');
    await w.ports.disclose('134088', 'never here');
    expect(w.log).toEqual([`app-say ${KEY} Now on Codex.`, 'slack-say C0ABC Now on Codex.']);
    const standby = world({ owner: false });
    await standby.ports.disclose(APP, 'x');
    expect(standby.log).toEqual([]);
    expect(standby.ports.canDisclose(APP)).toBe(false);
    expect(world().ports.canDisclose('slack:C0ABC')).toBe(true);
    expect(world({ noSlack: true }).ports.canDisclose('slack:C0ABC')).toBe(false);
  });
});

describe('resume views over one Slack record', () => {
  const rec = () => {
    let e: { uuid: string; framework: string | null; provenance: 'hook' | 'mtime' | null; parked?: string } | null = { uuid: 'u1', framework: 'claude-code', provenance: 'hook' };
    return {
      peek: () => (e && !e.parked ? { uuid: e.uuid, framework: e.framework, provenance: e.provenance } : null),
      park: (_rk: string, why: string) => { if (e && !e.parked) e.parked = why; },
      unpark: () => { if (e?.parked) { delete e.parked; return true; } return false; },
      set: (v: typeof e) => { e = v; },
    };
  };
  it('the Claude view is ready only for a hook id from a claude-code record; the Codex view only for codex-cli', () => {
    const r = rec();
    const v = conversationResumeViews(() => r);
    expect(v.claude.ready('slack:C0ABC')).toBe(true);
    expect(v.claude.resumeId('slack:C0ABC')).toBe('u1');
    expect(v.codex.get('slack:C0ABC')).toBeNull();
    r.set({ uuid: 'u2', framework: 'claude-code', provenance: 'mtime' });
    expect(v.claude.ready('slack:C0ABC')).toBe(false);
    r.set({ uuid: 'u3', framework: 'codex-cli', provenance: 'hook' });
    expect(v.codex.get('slack:C0ABC')).toBe('u3');
    expect(v.claude.resumeId('slack:C0ABC')).toBeNull();
    // Old records (no engine) are never ready.
    r.set({ uuid: 'u4', framework: null, provenance: null });
    expect(v.claude.ready('slack:C0ABC')).toBe(false);
  });
  it('either view parks and unparks the same record, idempotently', async () => {
    const r = rec();
    const v = conversationResumeViews(() => r);
    v.claude.park('slack:C0ABC', 'mid-framework-switch');
    v.codex.park('slack:C0ABC', 'again');
    expect(v.claude.ready('slack:C0ABC')).toBe(false);
    expect(v.codex.unpark('slack:C0ABC')).toBe(true);
    expect(v.claude.unpark('slack:C0ABC')).toBe(false);
    expect(v.claude.ready('slack:C0ABC')).toBe(true);
    expect(await v.codex.captureAtKill()).toEqual({ outcome: 'none', candidateCount: 0 });
  });
  it('an app key keeps no resume id; a Telegram key is not handled here', () => {
    const v = conversationResumeViews(() => rec());
    expect(v.handles(APP)).toBe(true);
    expect(v.claude.ready(APP)).toBe(false);
    expect(v.claude.resumeId(APP)).toBeNull();
    expect(v.codex.get(APP)).toBeNull();
    expect(v.claude.unpark(APP)).toBe(false);
    expect(v.handles('134088')).toBe(false);
  });
});
