import { describe, it, expect } from 'vitest';
import {
  ConversationSilenceJudge, preparePane, scrubPane, parseRefereeVerdict, PANE_BUDGET_CHARS, type SilenceEvidence,
} from '../../src/monitoring/neverSilent/ConversationSilenceJudge.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const evidence = (pane = '⏺ Login reached its time limit · Please run /login'): SilenceEvidence => ({
  framework: 'claude-code',
  authStatus: { loggedIn: false },
  account: { id: 'claude-a', status: 'active', loginCheck: 'unavailable' },
  healthyByFramework: { 'codex-cli': 3 },
  timing: { acceptedAt: 0, now: 60_000, sessionAlive: true, startedFirstTurn: null },
  pane,
  hints: [],
});

function jevFetch(silence: { choice: string; p: number }, actions = { choice: 'none', p: 0.95 }): typeof fetch {
  return (async () => new Response(JSON.stringify({
    model: 'jev', answers: {
      silence: { choice: silence.choice, probabilities: { [silence.choice]: silence.p } },
      actions: { choice: actions.choice, probabilities: { [actions.choice]: actions.p } },
    },
  }), { status: 200 })) as unknown as typeof fetch;
}

const referee = (reply: string, seen: string[] = []): IntelligenceProvider => ({
  evaluate: async (prompt: string) => { seen.push(prompt); return reply; },
} as unknown as IntelligenceProvider);

describe('ConversationSilenceJudge', () => {
  it('a confident Jev answer decides, with no referee call', async () => {
    const seen: string[] = [];
    const j = new ConversationSilenceJudge({
      readJevKey: () => 'k', fetchImpl: jevFetch({ choice: 'engine-login', p: 0.93 }),
      pickReferee: () => ({ name: 'codex:x', provider: referee('{}', seen) }),
    });
    const v = await j.judge(evidence());
    expect(v).toMatchObject({ silenceClass: 'engine-login', route: 'jev', actionsSinceMessage: 'none' });
    expect(seen).toHaveLength(0);
  });

  it('an unsure Jev escalates to the referee on another engine', async () => {
    const seen: string[] = [];
    const j = new ConversationSilenceJudge({
      readJevKey: () => 'k', fetchImpl: jevFetch({ choice: 'engine-login', p: 0.5 }),
      pickReferee: () => ({ name: 'codex:x', provider: referee('{"class":"engine-login","confidence":0.9,"actions":"none","reason":"login ran out"}', seen) }),
    });
    const v = await j.judge(evidence());
    expect(v).toMatchObject({ silenceClass: 'engine-login', confidence: 0.9, route: 'codex:x', actionsSinceMessage: 'none' });
    expect(seen[0]).toContain('Login reached its time limit');
    expect(seen[0]).toContain('loggedIn=false');
  });

  it('reworded login screens are judged by meaning — the prompt carries no wording list', async () => {
    const seen: string[] = [];
    const j = new ConversationSilenceJudge({
      readJevKey: () => null,
      pickReferee: () => ({ name: 'codex:x', provider: referee('{"class":"engine-login","confidence":0.9,"actions":"none"}', seen) }),
    });
    await j.judge(evidence('⏺ Your session credentials are no longer valid. Authenticate again to continue.'));
    expect(seen[0]).toContain('Judge by meaning, not by exact words');
    expect(seen[0]).not.toMatch(/please run \/login|login expired|oauth token/i);
  });

  it('no Jev key and no independent referee ⇒ undetermined (which is still told)', async () => {
    const j = new ConversationSilenceJudge({ readJevKey: () => null, pickReferee: () => null });
    const v = await j.judge(evidence());
    expect(v).toMatchObject({ silenceClass: 'undetermined', route: 'none', actionsSinceMessage: 'unknown' });
  });

  it('a referee that throws or answers garbage ⇒ undetermined', async () => {
    const thrower = { evaluate: async () => { throw new Error('signed out'); } } as unknown as IntelligenceProvider;
    const a = await new ConversationSilenceJudge({ readJevKey: () => null, pickReferee: () => ({ name: 'r', provider: thrower }) }).judge(evidence());
    const b = await new ConversationSilenceJudge({ readJevKey: () => null, pickReferee: () => ({ name: 'r', provider: referee('I think it is a login problem') }) }).judge(evidence());
    expect(a.silenceClass).toBe('undetermined');
    expect(b.silenceClass).toBe('undetermined');
  });

  it('a referee that never returns is bounded by its deadline', async () => {
    const hang = { evaluate: () => new Promise<string>(() => {}) } as unknown as IntelligenceProvider;
    const j = new ConversationSilenceJudge({ readJevKey: () => null, pickReferee: () => ({ name: 'r', provider: hang }), refereeTimeoutMs: 10 });
    const v = await j.judge(evidence());
    expect(v.silenceClass).toBe('undetermined');
  });

  it('Jev unsure about actions ⇒ actions unknown (never an automatic move)', async () => {
    const j = new ConversationSilenceJudge({
      readJevKey: () => 'k', fetchImpl: jevFetch({ choice: 'engine-login', p: 0.95 }, { choice: 'none', p: 0.5 }),
      pickReferee: () => null,
    });
    expect((await j.judge(evidence())).actionsSinceMessage).toBe('unknown');
  });

  it('the stuck engine is never asked: the selector gets the stuck framework and account', async () => {
    let asked: unknown = null;
    const j = new ConversationSilenceJudge({ readJevKey: () => null, pickReferee: (stuck) => { asked = stuck; return null; } });
    await j.judge(evidence());
    expect(asked).toEqual({ framework: 'claude-code', accountId: 'claude-a' });
  });
});

describe('screen text preparation', () => {
  it('long panes are cut in the middle and say so in-band', () => {
    const pane = 'A'.repeat(PANE_BUDGET_CHARS) + 'B'.repeat(2000);
    const p = preparePane(pane);
    expect(p.truncated).toBe(true);
    expect(p.text).toContain('characters omitted');
    expect(p.text.startsWith('A')).toBe(true);
    expect(p.text.endsWith('B')).toBe(true);
  });
  it('a truncated pane is reported on the verdict', async () => {
    const j = new ConversationSilenceJudge({ readJevKey: () => null, pickReferee: () => ({ name: 'r', provider: referee('{"class":"engine-login","confidence":0.99,"actions":"none"}') }) });
    const v = await j.judge(evidence('x'.repeat(PANE_BUDGET_CHARS + 10)));
    expect(v.truncated).toBe(true);
  });
  it('hints and facts are scrubbed too, not just the screen', async () => {
    const seen: string[] = [];
    const j = new ConversationSilenceJudge({ readJevKey: () => null, pickReferee: () => ({ name: 'r', provider: referee('{"class":"engine-login","confidence":0.9,"actions":"none"}', seen) }) });
    await j.judge({ ...evidence(), hints: ['matched: "signed in as owner@example.org"'], authStatus: { loggedIn: false, detail: 'owner@example.org' } });
    expect(seen[0]).not.toContain('owner@example.org');
  });
  it('e-mail addresses are masked before anything leaves the machine', () => {
    expect(scrubPane('signed in as someone@example.org')).toBe('signed in as [email]');
  });
  it('referee parse is strict', () => {
    expect(parseRefereeVerdict('{"class":"engine-login","confidence":1.2}')).toBeNull();
    expect(parseRefereeVerdict('{"class":"made-up","confidence":0.9}')).toBeNull();
    expect(parseRefereeVerdict('{"class":"crashed","confidence":0.9}')).toMatchObject({ silenceClass: 'crashed', actions: 'unknown' });
  });
});
