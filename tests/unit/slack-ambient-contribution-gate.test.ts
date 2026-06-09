import { describe, it, expect, vi } from 'vitest';

import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import {
  AmbientContributionGate,
  type AmbientDecision,
  type AmbientDecisionReason,
} from '../../src/permissions/AmbientContributionGate.js';

/** A canned-response provider: returns whatever JSON we hand it, or throws. */
function fakeProvider(
  responder: (prompt: string, opts?: IntelligenceOptions) => string,
  capture?: { opts?: IntelligenceOptions; prompt?: string; calls: number },
): IntelligenceProvider {
  return {
    async evaluate(prompt: string, opts?: IntelligenceOptions): Promise<string> {
      if (capture) {
        capture.calls++;
        capture.prompt = prompt;
        capture.opts = opts;
      }
      return responder(prompt, opts);
    },
  };
}

const CH = 'C_AMBIENT';
const speakJson = (conf = 0.95) =>
  `{"speak":true,"confidence":${conf},"contribution":"This looks like the onnxruntime-node CDN flake; a gh run rerun --failed cleared it last week."}`;
const silentJson = (conf = 0.4) => `{"speak":false,"confidence":${conf}}`;

describe('AmbientContributionGate — DARK / opt-in (no config ⇒ never speaks, no LLM call)', () => {
  it('a channel that is NOT opted in stays silent and never calls the LLM', async () => {
    const cap = { calls: 0 };
    const gate = new AmbientContributionGate({
      config: { enabledChannelIds: ['C_OTHER'] },
      intelligence: fakeProvider(() => speakJson(), cap),
    });
    const d = await gate.shouldSpeak({ channelId: CH, text: 'engineers stuck on a flaky test again' });
    expect(d.speak).toBe(false);
    expect(d.reason).toBe('channel-not-opted-in');
    expect(cap.calls).toBe(0); // opt-in is checked BEFORE the LLM
  });

  it('with empty config the gate reports no channel enabled and stays silent', async () => {
    const gate = new AmbientContributionGate({ intelligence: fakeProvider(() => speakJson()) });
    expect(gate.isAnyChannelEnabled()).toBe(false);
    expect(gate.isChannelEnabled(CH)).toBe(false);
    const d = await gate.shouldSpeak({ channelId: CH, text: 'anything' });
    expect(d.speak).toBe(false);
    expect(d.reason).toBe('channel-not-opted-in');
  });

  it('isChannelEnabled / isAnyChannelEnabled reflect the opted-in set', () => {
    const gate = new AmbientContributionGate({ config: { enabledChannelIds: [CH] } });
    expect(gate.isAnyChannelEnabled()).toBe(true);
    expect(gate.isChannelEnabled(CH)).toBe(true);
    expect(gate.isChannelEnabled('C_OTHER')).toBe(false);
  });
});

describe('AmbientContributionGate — speak path (ALL fail-to-silence conditions must hold)', () => {
  it('opted-in channel + LLM high-value speak + under rate-limit → speak=true', async () => {
    const gate = new AmbientContributionGate({
      config: { enabledChannelIds: [CH], minConfidence: 0.85 },
      intelligence: fakeProvider(() => speakJson(0.95)),
    });
    const d = await gate.shouldSpeak({ channelId: CH, text: 'CI keeps failing on onnxruntime-node' });
    expect(d.speak).toBe(true);
    expect(d.reason).toBe('speak');
    expect(d.detail).toContain('onnxruntime-node');
  });

  it('calls the LLM at the fast tier with AmbientContributionGate attribution and NOT gating', async () => {
    const cap = { calls: 0 };
    const gate = new AmbientContributionGate({
      config: { enabledChannelIds: [CH] },
      intelligence: fakeProvider(() => speakJson(), cap),
    });
    await gate.shouldSpeak({ channelId: CH, text: 'hello team' });
    expect(cap.calls).toBe(1);
    expect(cap.opts?.model).toBe('fast');
    expect(cap.opts?.attribution?.component).toBe('AmbientContributionGate');
    expect(cap.opts?.attribution?.category).toBe('gate');
    // Deliberately NOT gating — a gating call would provider-swap to keep talking;
    // the safe failure here is silence.
    expect(cap.opts?.attribution?.gating).toBeUndefined();
  });
});

describe('AmbientContributionGate — silence on a low-value / declined verdict', () => {
  it('LLM says "not worth it" (speak:false) → silent', async () => {
    const gate = new AmbientContributionGate({
      config: { enabledChannelIds: [CH] },
      intelligence: fakeProvider(() => silentJson(0.2)),
    });
    const d = await gate.shouldSpeak({ channelId: CH, text: 'lunch plans?' });
    expect(d.speak).toBe(false);
    expect(d.reason).toBe('llm-declined');
  });

  it('LLM says speak but BELOW the confidence floor → silent (low-confidence)', async () => {
    const gate = new AmbientContributionGate({
      config: { enabledChannelIds: [CH], minConfidence: 0.85 },
      intelligence: fakeProvider(() => speakJson(0.7)), // below 0.85
    });
    const d = await gate.shouldSpeak({ channelId: CH, text: 'maybe relevant?' });
    expect(d.speak).toBe(false);
    expect(d.reason).toBe('low-confidence');
  });

  it('LLM says speak with high confidence but NO named contribution → silent', async () => {
    const gate = new AmbientContributionGate({
      config: { enabledChannelIds: [CH], minConfidence: 0.85 },
      intelligence: fakeProvider(() => '{"speak":true,"confidence":0.99}'), // no contribution
    });
    const d = await gate.shouldSpeak({ channelId: CH, text: 'hmm' });
    expect(d.speak).toBe(false);
    expect(d.reason).toBe('low-confidence');
  });
});

describe('AmbientContributionGate — FAIL-TO-SILENCE (no over-speak on ANY degraded path)', () => {
  // The core invariant: every degraded path must produce speak=false. We enumerate
  // them and assert NO over-speak in each.
  const degradedPaths: Array<{ name: string; deps: () => AmbientContributionGate; expect: AmbientDecisionReason }> = [
    {
      name: 'no LLM provider configured',
      deps: () => new AmbientContributionGate({ config: { enabledChannelIds: [CH] } }),
      expect: 'no-intelligence',
    },
    {
      name: 'LLM throws (network / timeout / circuit open)',
      deps: () =>
        new AmbientContributionGate({
          config: { enabledChannelIds: [CH] },
          intelligence: fakeProvider(() => {
            throw new Error('provider down / circuit open');
          }),
        }),
      expect: 'llm-error',
    },
    {
      name: 'LLM returns chatty prose, not JSON',
      deps: () =>
        new AmbientContributionGate({
          config: { enabledChannelIds: [CH] },
          intelligence: fakeProvider(() => 'Sure, I think I should jump in here!'),
        }),
      expect: 'llm-unparseable',
    },
    {
      name: 'LLM returns JSON with no readable speak key',
      deps: () =>
        new AmbientContributionGate({
          config: { enabledChannelIds: [CH] },
          intelligence: fakeProvider(() => '{"confidence":0.99,"contribution":"x"}'),
        }),
      expect: 'llm-unparseable',
    },
    {
      name: 'LLM returns empty string',
      deps: () =>
        new AmbientContributionGate({
          config: { enabledChannelIds: [CH] },
          intelligence: fakeProvider(() => ''),
        }),
      expect: 'llm-unparseable',
    },
  ];

  for (const path of degradedPaths) {
    it(`${path.name} → speak=false (NO over-speak)`, async () => {
      const gate = path.deps();
      const d = await gate.shouldSpeak({ channelId: CH, text: 'should you speak here?' });
      expect(d.speak).toBe(false); // the invariant
      expect(d.reason).toBe(path.expect);
    });
  }

  it('a malformed/garbage "speak" value (e.g. number) does NOT become an affirmative', async () => {
    const gate = new AmbientContributionGate({
      config: { enabledChannelIds: [CH] },
      intelligence: fakeProvider(() => '{"speak":1,"confidence":0.99,"contribution":"x"}'),
    });
    const d = await gate.shouldSpeak({ channelId: CH, text: 'x' });
    expect(d.speak).toBe(false);
    expect(d.reason).toBe('llm-unparseable');
  });

  it('missing confidence is treated as 0 (floor), never optimistic — stays silent even on speak:true', async () => {
    const gate = new AmbientContributionGate({
      config: { enabledChannelIds: [CH], minConfidence: 0.85 },
      intelligence: fakeProvider(() => '{"speak":true,"contribution":"do the thing"}'),
    });
    const d = await gate.shouldSpeak({ channelId: CH, text: 'x' });
    expect(d.speak).toBe(false);
    expect(d.reason).toBe('low-confidence');
  });

  it('observability throw never affects the verdict (best-effort onDecision)', async () => {
    const gate = new AmbientContributionGate({
      config: { enabledChannelIds: [CH] },
      intelligence: fakeProvider(() => speakJson()),
      onDecision: () => {
        throw new Error('observability blew up');
      },
    });
    const d = await gate.shouldSpeak({ channelId: CH, text: 'CI flake again' });
    expect(d.speak).toBe(true); // a thrown hook must not silence-or-amplify the verdict
  });
});

describe('AmbientContributionGate — hard per-channel rate-limit (fail-to-silence)', () => {
  it('N+1th proactive message in the window → silent (rate-limited)', async () => {
    const gate = new AmbientContributionGate({
      config: { enabledChannelIds: [CH], maxProactivePerChannel: 1, windowMs: 60_000 },
      intelligence: fakeProvider(() => speakJson()),
    });

    // 1st proactive turn clears and consumes the single unit of budget.
    const first = await gate.shouldSpeak({ channelId: CH, text: 'first contribution' });
    expect(first.speak).toBe(true);
    gate.recordSpoke(CH); // _handleMessage records after committing to process

    // 2nd is rate-limited even though the LLM would still say speak.
    const second = await gate.shouldSpeak({ channelId: CH, text: 'second contribution' });
    expect(second.speak).toBe(false);
    expect(second.reason).toBe('rate-limited');
  });

  it('rate-limit is checked BEFORE the LLM (no LLM call when budget is exhausted)', async () => {
    const cap = { calls: 0 };
    const gate = new AmbientContributionGate({
      config: { enabledChannelIds: [CH], maxProactivePerChannel: 1, windowMs: 60_000 },
      intelligence: fakeProvider(() => speakJson(), cap),
    });
    gate.recordSpoke(CH); // exhaust the budget directly
    const d = await gate.shouldSpeak({ channelId: CH, text: 'would-be contribution' });
    expect(d.speak).toBe(false);
    expect(d.reason).toBe('rate-limited');
    expect(cap.calls).toBe(0);
  });

  it('budget refills after the rolling window elapses (injected clock)', async () => {
    let t = 1_000_000;
    const gate = new AmbientContributionGate({
      config: { enabledChannelIds: [CH], maxProactivePerChannel: 1, windowMs: 60_000 },
      intelligence: fakeProvider(() => speakJson()),
      now: () => t,
    });

    expect((await gate.shouldSpeak({ channelId: CH, text: 'first' })).speak).toBe(true);
    gate.recordSpoke(CH);
    expect((await gate.shouldSpeak({ channelId: CH, text: 'second' })).reason).toBe('rate-limited');

    // Advance past the window — the old timestamp expires.
    t += 60_001;
    const d = await gate.shouldSpeak({ channelId: CH, text: 'after window' });
    expect(d.speak).toBe(true);
    expect(d.reason).toBe('speak');
  });

  it('maxProactivePerChannel:0 means fully silent (zero is honored, not defaulted)', async () => {
    const gate = new AmbientContributionGate({
      config: { enabledChannelIds: [CH], maxProactivePerChannel: 0 },
      intelligence: fakeProvider(() => speakJson()),
    });
    const d = await gate.shouldSpeak({ channelId: CH, text: 'x' });
    expect(d.speak).toBe(false);
    expect(d.reason).toBe('rate-limited');
    expect(gate.remainingBudget(CH)).toBe(0);
  });

  it('rate-limit is per-channel (one channel exhausted does not silence another)', async () => {
    const CH2 = 'C_AMBIENT_2';
    const gate = new AmbientContributionGate({
      config: { enabledChannelIds: [CH, CH2], maxProactivePerChannel: 1, windowMs: 60_000 },
      intelligence: fakeProvider(() => speakJson()),
    });
    gate.recordSpoke(CH); // exhaust CH only
    expect((await gate.shouldSpeak({ channelId: CH, text: 'x' })).reason).toBe('rate-limited');
    expect((await gate.shouldSpeak({ channelId: CH2, text: 'y' })).speak).toBe(true);
  });
});

describe('AmbientContributionGate — wiring integrity', () => {
  it('actually delegates to the injected provider (not a no-op)', async () => {
    const evalSpy = vi.fn(async () => speakJson());
    const provider: IntelligenceProvider = { evaluate: evalSpy };
    const gate = new AmbientContributionGate({ config: { enabledChannelIds: [CH] }, intelligence: provider });
    await gate.shouldSpeak({ channelId: CH, text: 'CI flake again' });
    expect(evalSpy).toHaveBeenCalledTimes(1);
  });

  it('fires onDecision for every decision with the channel id (FP measurement hook)', async () => {
    const seen: Array<{ d: AmbientDecision; ch: string }> = [];
    const gate = new AmbientContributionGate({
      config: { enabledChannelIds: [CH] },
      intelligence: fakeProvider(() => silentJson()),
      onDecision: (d, ch) => seen.push({ d, ch }),
    });
    await gate.shouldSpeak({ channelId: CH, text: 'x' });
    expect(seen).toHaveLength(1);
    expect(seen[0].ch).toBe(CH);
    expect(seen[0].d.reason).toBe('llm-declined');
  });
});
