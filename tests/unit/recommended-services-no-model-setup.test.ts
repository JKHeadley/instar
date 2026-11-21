/**
 * `provider-exhausted` and setup with no AI model (docs/specs/recommended-services.md, Real-problem events,
 * "With every door down"): the predicate over the subscription pool, the episode counter (30 minutes, twice in
 * 7 days), and the second-door recipe as fixed steps.
 */
import { describe, expect, it } from 'vitest';
import {
  DOORS_DOWN_EPISODE_MS, DOORS_DOWN_WINDOW_MS, EMPTY_DOORS_DOWN, SIGN_IN_WAIT_MS, everyDoorDown, noteDoorsSample,
  runSecondDoorWithoutModel, runTailscaleWithoutModel, type NoModelDoorDeps, type NoModelTailscaleDeps, type TailscaleState,
} from '../../src/recommended/noModelSetup.js';

const MIN = 60_000;

describe('everyDoorDown', () => {
  const acct = (framework: string, status: string) => ({ framework, status });
  it('true only when every door the agent uses has accounts and none is active or warming', () => {
    expect(everyDoorDown(['claude-code'], [acct('claude-code', 'rate-limited'), acct('claude-code', 'needs-reauth')])).toBe(true);
    expect(everyDoorDown(['claude-code'], [acct('claude-code', 'rate-limited'), acct('claude-code', 'active')])).toBe(false);
    expect(everyDoorDown(['claude-code'], [acct('claude-code', 'warming')])).toBe(false);
    expect(everyDoorDown(['claude-code', 'codex-cli'], [acct('claude-code', 'rate-limited'), acct('codex-cli', 'active')])).toBe(false);
    expect(everyDoorDown(['claude-code', 'codex-cli'], [acct('claude-code', 'rate-limited'), acct('codex-cli', 'disabled')])).toBe(true);
  });
  it('a door the pool knows nothing about is unknown, never down; no pool at all never trips it', () => {
    expect(everyDoorDown(['claude-code', 'codex-cli'], [acct('claude-code', 'rate-limited')])).toBe(false);
    expect(everyDoorDown(['claude-code'], [])).toBe(false);
    expect(everyDoorDown([], [])).toBe(false);
    expect(everyDoorDown([], [acct('codex-cli', 'rate-limited')])).toBe(true);
    expect(everyDoorDown(['gemini-cli'], [acct('gemini-cli', 'rate-limited')])).toBe(false);
  });
});

describe('noteDoorsSample', () => {
  const run = (samples: Array<[boolean, number]>) => {
    let state = EMPTY_DOORS_DOWN;
    const problems: number[] = [];
    for (const [down, at] of samples) {
      const r = noteDoorsSample(state, down, at);
      state = r.state;
      if (r.problem) problems.push(at);
    }
    return { state, problems };
  };
  it('a short outage is no episode; one long outage is one episode, counted once', () => {
    expect(run([[true, 0], [true, 20 * MIN], [false, 25 * MIN]]).state.episodes).toEqual([]);
    const one = run([[true, 0], [true, 30 * MIN], [true, 60 * MIN], [true, 90 * MIN]]);
    expect(one.state.episodes).toEqual([30 * MIN]);
    expect(one.problems).toEqual([]);
  });
  it('two episodes inside 7 days are one problem, and the count starts over', () => {
    const r = run([[true, 0], [true, 30 * MIN], [false, 40 * MIN], [true, 2 * 24 * 60 * MIN], [true, 2 * 24 * 60 * MIN + 30 * MIN]]);
    expect(r.problems).toEqual([2 * 24 * 60 * MIN + 30 * MIN]);
    expect(r.state.episodes).toEqual([]);
  });
  it('episodes more than 7 days apart are not a problem', () => {
    const later = DOORS_DOWN_WINDOW_MS + 60 * MIN;
    const r = run([[true, 0], [true, DOORS_DOWN_EPISODE_MS], [false, 40 * MIN], [true, later], [true, later + DOORS_DOWN_EPISODE_MS]]);
    expect(r.problems).toEqual([]);
    expect(r.state.episodes).toEqual([later + DOORS_DOWN_EPISODE_MS]);
  });
  it('a clock that goes backwards starts the run over instead of counting it', () => {
    const r = noteDoorsSample({ downSince: 10 * MIN, counted: false, episodes: [] }, true, 5 * MIN);
    expect(r.state.downSince).toBe(5 * MIN);
    expect(r.problem).toBe(false);
  });
});

describe('runSecondDoorWithoutModel', () => {
  const make = (over: Partial<NoModelDoorDeps> & { signInAfter?: number } = {}) => {
    let clock = 0;
    const told: string[] = [];
    const enabled: string[] = [];
    let installs = 0;
    const deps: NoModelDoorDeps = {
      enabled: () => ['claude-code'],
      installed: () => installs > 0,
      oneTapSignIn: (d) => d === 'codex-cli',
      install: async () => { installs += 1; return true; },
      startSignIn: async () => ({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' }),
      signedIn: async () => (over.signInAfter !== undefined && clock >= over.signInAfter ? 'signed-in' : 'signed-out'),
      enable: (d) => { enabled.push(d); return true; },
      tell: (t) => told.push(t),
      stillWanted: () => true,
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      ...over,
    };
    return { deps, told, enabled, installs: () => installs };
  };

  it('installs Codex, sends its link and code in fixed words, waits for the tap, then switches it on', async () => {
    const t = make({ signInAfter: 2 * MIN });
    const out = await runSecondDoorWithoutModel(t.deps);
    expect(out.result).toBe('pass');
    expect(t.installs()).toBe(1);
    expect(t.enabled).toEqual(['codex-cli']);
    expect(t.told[0]).toContain('https://auth.openai.com/codex/device');
    expect(t.told[0]).toContain('ABCD-1234');
    expect(t.told[0]).toContain('nothing is bought for you');
    expect(t.told.at(-1)).toContain('signed in and switched on');
  });

  it('already signed in: switches it on and says so, with no link', async () => {
    const t = make({ installed: () => true, signedIn: async () => 'signed-in' });
    expect((await runSecondDoorWithoutModel(t.deps)).result).toBe('pass');
    expect(t.told).toHaveLength(1);
    expect(t.told[0]).toContain('already signed in');
  });

  it('a door whose sign-in needs a pasted code is not attempted without a model, and says why', async () => {
    const t = make({ enabled: () => ['codex-cli'] });
    const out = await runSecondDoorWithoutModel(t.deps);
    expect(out.result).toBe('fail');
    expect(t.installs()).toBe(0);
    expect(t.told[0]).toContain('needs a code pasted back');
  });

  it('a failed install, or no link, ends the attempt with a plain note', async () => {
    const a = make({ install: async () => false });
    expect((await runSecondDoorWithoutModel(a.deps)).result).toBe('fail');
    expect(a.told[0]).toContain("couldn't install");
    const b = make({ startSignIn: async () => null });
    expect((await runSecondDoorWithoutModel(b.deps)).result).toBe('fail');
    expect(b.told[0]).toContain("didn't give me a sign-in link");
  });

  it('an unused link expires after its wait, and nothing is switched on', async () => {
    const t = make();
    const out = await runSecondDoorWithoutModel(t.deps);
    expect(out.result).toBe('fail');
    expect(t.enabled).toEqual([]);
    expect(t.deps.now()).toBeGreaterThanOrEqual(SIGN_IN_WAIT_MS);
    expect(t.told.at(-1)).toContain('expired');
  });

  it('a no while waiting stops the run without switching anything on', async () => {
    let wanted = true;
    const t = make({ stillWanted: () => wanted, signInAfter: 10 * MIN, sleep: async () => { wanted = false; } });
    const out = await runSecondDoorWithoutModel(t.deps);
    expect(out).toEqual({ result: 'fail', detail: 'Setup was stopped.' });
    expect(t.enabled).toEqual([]);
  });
});

describe('runTailscaleWithoutModel', () => {
  const make = (start: TailscaleState, over: Partial<NoModelTailscaleDeps> & { runningAfter?: number } = {}) => {
    let clock = 0;
    let state = start;
    const told: string[] = [];
    const deps: NoModelTailscaleDeps = {
      status: async () => (over.runningAfter !== undefined && clock >= over.runningAfter ? 'running' : state),
      install: async () => { state = 'not-running'; return true; },
      startService: async () => true,
      startSignIn: async () => 'https://login.tailscale.com/a/abc123',
      tell: (t) => told.push(t),
      stillWanted: () => true,
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      ...over,
    };
    return { deps, told };
  };

  it('already running: passes and says so, with no link', async () => {
    const t = make('running');
    expect((await runTailscaleWithoutModel(t.deps)).result).toBe('pass');
    expect(t.told).toHaveLength(1);
  });

  it('missing: installs, starts, sends the sign-in link in fixed words, waits for the tap', async () => {
    const t = make('missing', { runningAfter: 3 * MIN });
    expect((await runTailscaleWithoutModel(t.deps)).result).toBe('pass');
    expect(t.told[0]).toContain('https://login.tailscale.com/a/abc123');
    expect(t.told[0]).toContain('that same tap makes one, free');
    expect(t.told.at(-1)).toContain('Tailscale is signed in');
  });

  it('no install without administrator rights, a service that will not start, or no link: a plain note and fail', async () => {
    const a = make('missing', { install: async () => false });
    expect((await runTailscaleWithoutModel(a.deps)).result).toBe('fail');
    expect(a.told[0]).toContain('without administrator rights');
    const b = make('not-running', { startService: async () => false });
    expect((await runTailscaleWithoutModel(b.deps)).result).toBe('fail');
    expect(b.told[0]).toContain("background service won't start");
    const c = make('not-running', { startSignIn: async () => null });
    expect((await runTailscaleWithoutModel(c.deps)).result).toBe('fail');
    expect(c.told[0]).toContain("didn't give me a sign-in link");
  });

  it('an unused link expires; a no while waiting stops it', async () => {
    const a = make('not-running');
    expect((await runTailscaleWithoutModel(a.deps)).result).toBe('fail');
    expect(a.told.at(-1)).toContain('expired');
    let wanted = true;
    const b = make('not-running', { stillWanted: () => wanted, sleep: async () => { wanted = false; } });
    expect(await runTailscaleWithoutModel(b.deps)).toEqual({ result: 'fail', detail: 'Setup was stopped.' });
  });
});
