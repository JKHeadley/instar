/**
 * The Spend tab's operator ON SWITCH (Phase 2 UI for the money-layer enable surface).
 *
 * Phase 1 shipped six routes and no screen, so the operator's report survived the ship:
 * "still has no path/mechanism to enable any options." The tests that matter are therefore
 * not "the form works" — they are the four honesty properties the spec is built around:
 *
 *   - ON is never presented as "spending works" (enabling arms no door)
 *   - a commit that only registered intent is never presented as done (restart is next)
 *   - a disable that CANNOT stop spending (config-enabled) never reads as success
 *   - the operator approves the SERVER's words, and the PIN never travels with a preview
 */
// @ts-nocheck — browser-native ESM module, no types.
import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  enableNote,
  enableHeadline,
  configSourceNotice,
  availableActions,
  planRequest,
  commitRequest,
  restartRequest,
  renderPlanApproval,
  renderRestartConfirmation,
  renderEnablePanel,
  nextStepAfterCommit,
  sha256Hex,
} from '../../dashboard/money-layer-enable.js';

let doc: Document;
beforeEach(() => {
  doc = new JSDOM('<!doctype html><body></body>').window.document;
});

const OFF = {
  lifecycleState: 'disabled',
  enforcementReady: false,
  enableSources: { state: 'disabled', store: false, config: false, surfaced: false },
  restartEligible: false,
  anyKeyFrozen: false,
};
const PENDING = { ...OFF, lifecycleState: 'enable-pending-restart', enableSources: { state: 'operator-enabled', store: true, config: false }, restartEligible: true };
const ON = { ...OFF, lifecycleState: 'probed', enforcementReady: true, enableSources: { state: 'operator-enabled', store: true, config: false } };
const CONFIG_ON = { ...ON, enableSources: { state: 'config-enabled', store: false, config: true } };

describe('enableHeadline — the four states, in the operator’s words', () => {
  it('THE POINT: enforcing never claims spending works — it says nothing is armed', () => {
    const h = enableHeadline(ON);
    expect(h.state).toBe('enforcing');
    expect(h.headline).toMatch(/up and enforcing/i);
    expect(`${h.headline} ${h.detail}`).toMatch(/arms nothing|stays refused/i);
  });

  it('switched on but not built says a restart is what finishes it — not that it is done', () => {
    const h = enableHeadline(PENDING);
    expect(h.state).toBe('pending-restart');
    expect(h.detail).toMatch(/restart/i);
    expect(h.headline).not.toMatch(/enforcing($| )/i);
  });

  it('a refusing layer names the part that refused and does NOT read as working', () => {
    const h = enableHeadline({ ...PENDING, lifecycleState: 'probe-failed', failingComponent: 'MeteredSpendLedger' });
    expect(h.state).toBe('failed');
    expect(h.detail).toContain('MeteredSpendLedger');
    expect(h.headline).toMatch(/NOT enforcing/);
  });

  it('off says whose switch it is, so the operator does not go hunting for a fault', () => {
    const h = enableHeadline(OFF);
    expect(h.state).toBe('off');
    expect(h.detail).toMatch(/your decision/i);
  });

  it('NO lifecycle enum value is ever rendered to the operator', () => {
    // `ready` is rejected legacy terminology and `probed` / `enable-pending-restart` are
    // internal; the operator sees derived copy or the surface leaks the wrong reading.
    for (const st of [OFF, PENDING, ON, { ...PENDING, lifecycleState: 'construction-failed' }]) {
      const h = enableHeadline(st);
      const text = `${h.headline} ${h.detail}`;
      expect(text).not.toContain('probed');
      expect(text).not.toContain('enable-pending-restart');
      expect(text).not.toContain('construction-failed');
    }
  });
});

describe('configSourceNotice — the disable that does not stop spending', () => {
  it('THE POINT: config-enabled leads with freeze and says the disable will NOT stop spending', () => {
    const n = configSourceNotice(CONFIG_ON);
    expect(n).toMatch(/NOT stop spending/);
    expect(n).toMatch(/freeze/i);
  });

  it('both-enabled is informational, not an alarm about spending continuing unchecked', () => {
    const n = configSourceNotice({ ...ON, enableSources: { state: 'both-enabled', store: true, config: true } });
    expect(n).toMatch(/both/i);
  });

  it('CONTROL: an ordinary operator-enabled state gets no notice at all', () => {
    expect(configSourceNotice(ON)).toBeNull();
    expect(configSourceNotice(OFF)).toBeNull();
  });
});

describe('availableActions — buttons are derived from state, never inert', () => {
  it('off offers the turn-on button and nothing that would refuse', () => {
    const a = availableActions(OFF).map((x) => x.action);
    expect(a).toContain('money-layer-enable');
    expect(a).not.toContain('money-layer-disable');
    expect(a).not.toContain('money-layer-mirror-config');
  });

  it('THE RESCUE CASE: switch-on-machinery-down still offers turn-on, so pressing it re-verifies', () => {
    // A UI that treated "already on" as a no-op would leave the operator with a switch
    // reading on, nothing working, and a button that politely did nothing.
    const a = availableActions(PENDING).map((x) => x.action);
    expect(a).toContain('money-layer-enable');
    expect(a).toContain('__restart');
  });

  it('enforcing offers turn-off and does NOT offer turn-on', () => {
    const a = availableActions(ON).map((x) => x.action);
    expect(a).toContain('money-layer-disable');
    expect(a).not.toContain('money-layer-enable');
  });

  it('config-enabled offers the mirror action; an operator-enabled state does not', () => {
    expect(availableActions(CONFIG_ON).map((x) => x.action)).toContain('money-layer-mirror-config');
    expect(availableActions(ON).map((x) => x.action)).not.toContain('money-layer-mirror-config');
  });
});

describe('the request bodies — what may and may not travel', () => {
  it('THE SECURITY SHAPE: the preview carries NO pin', () => {
    expect(JSON.stringify(planRequest('money-layer-enable'))).not.toMatch(/pin/i);
  });

  it('the commit carries the PLAN identity and the pin — never a field from the page', () => {
    const body = commitRequest({ planId: 'p1', nonce: 'n1', renderedText: 'x' }, '123456');
    expect(body).toEqual({ planId: 'p1', nonce: 'n1', pin: '123456' });
  });

  it('the restart binds to the confirmation text’s hash', () => {
    expect(restartRequest('n', 'h', 'p')).toEqual({ nonce: 'n', confirmationTextHash: 'h', pin: 'p' });
  });

  it('sha256Hex hashes the text that was displayed', async () => {
    // Known vector — the binding is only meaningful if this is a real SHA-256.
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('sha256Hex refuses rather than sending an unbound restart when crypto is unavailable', async () => {
    const real = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
      await expect(sha256Hex('abc')).rejects.toThrow(/secure-context-required/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
    }
  });
});

describe('renderPlanApproval / renderRestartConfirmation — the server’s words, verbatim', () => {
  it('shows the rendered text exactly, without paraphrase', () => {
    const t = doc.createElement('div');
    const text = 'Turn ON the spending-control layer on machine ‘Laptop’.';
    renderPlanApproval(doc, t, { planId: 'p', nonce: 'n', renderedText: text, expiresAt: '2026-08-17T10:00:00Z' });
    expect(t.querySelector('.spend-arm-plan-text')!.textContent).toBe(text);
  });

  it('a plan text is TEXT — hostile server-side content cannot become markup', () => {
    const t = doc.createElement('div');
    renderPlanApproval(doc, t, { renderedText: '<img src=x onerror=alert(1)>' });
    expect(t.querySelector('img')).toBeNull();
    expect(t.querySelector('.spend-arm-plan-text')!.children.length).toBe(0);
  });

  it('the restart confirmation adds the one fact the server cannot know they are missing', () => {
    const t = doc.createElement('div');
    renderRestartConfirmation(doc, t, { nonce: 'n', confirmationText: 'Restart the agent server.', expiresAt: 'x' });
    expect(t.querySelector('.spend-arm-plan-text')!.textContent).toBe('Restart the agent server.');
    expect(t.textContent).toMatch(/whole agent server/i);
  });
});

describe('nextStepAfterCommit — what the operator must do next', () => {
  it('THE POINT: an enable that only registered intent routes to the restart, not to done', () => {
    expect(nextStepAfterCommit({ enforcementReady: false, storeCleared: false })).toBe('restart');
  });

  it('an enable that came up enforcing is done', () => {
    expect(nextStepAfterCommit({ enforcementReady: true, storeCleared: false })).toBe('done');
  });

  it('a store-only disable under a config enable is NOT done — spending did not stop', () => {
    expect(nextStepAfterCommit({
      enforcementReady: true, storeCleared: true, enableSources: { state: 'config-enabled', config: true, store: false },
    })).toBe('still-enabled-by-config');
  });

  it('a real disable is done', () => {
    expect(nextStepAfterCommit({
      enforcementReady: false, storeCleared: true, enableSources: { state: 'disabled', config: false, store: false },
    })).toBe('done');
  });
});

describe('renderEnablePanel', () => {
  it('renders the headline, the actions, and survives a missing status honestly', () => {
    const t = doc.createElement('div');
    renderEnablePanel(doc, t, OFF);
    expect(t.querySelector('.mle-headline')!.textContent).toMatch(/off/i);
    expect(t.querySelectorAll('[data-mle-action]').length).toBeGreaterThan(0);

    const t2 = doc.createElement('div');
    renderEnablePanel(doc, t2, null);
    expect(t2.textContent).toMatch(/Nothing has changed/);
    expect(t2.querySelector('[data-mle-action]')).toBeNull();
  });

  it('the config notice is rendered where the operator is looking, not buried', () => {
    const t = doc.createElement('div');
    renderEnablePanel(doc, t, CONFIG_ON);
    expect(t.querySelector('.mle-config-notice')!.textContent).toMatch(/NOT stop spending/);
  });

  it('a hostile machine nickname cannot reach the DOM as markup', () => {
    const t = doc.createElement('div');
    renderEnablePanel(doc, t, { ...OFF, machineNickname: '<img src=x onerror=alert(1)>' });
    expect(t.querySelector('img')).toBeNull();
  });
});

describe('enableNote — a pre-gate failure is not "your switch is off"', () => {
  it('a 503 here means the SURFACE did not construct, and says nothing changed', () => {
    const n = enableNote('money-layer-surface-unavailable');
    expect(n).toMatch(/Nothing has changed/);
    expect(n).not.toMatch(/your decision/i);
  });

  it('a bad PIN says so plainly', () => {
    expect(enableNote('bad-pin')).toMatch(/PIN was not accepted/);
  });

  it('a stale approval tells them to start again rather than implying a change landed', () => {
    expect(enableNote('stale-nonce')).toMatch(/start it again/i);
  });
});
