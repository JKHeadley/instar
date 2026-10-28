/**
 * Console "What I'm allowed to do" page (docs/specs/console-features/people-settings.md):
 * the profile, the guard listing (local vs other machines), suggestions, honest
 * failures, and the feature state-machine walk on both sides of every decision.
 * Plus the shipped console.js in jsdom driving one real transition walk.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  buildProfile, buildHistory, buildGuards, buildSuggestions, buildFeatures, profileChanges, meaningRows,
  nextStepToEnabled, walkToEnabled, needsLook, guardActions, canTurnOff, canUndoOff, consentRecord, facts,
  flattenFeature, applyText, refusalText,
} from '../../dashboard/console/allowed-model.js';
import { NATIVE_PAGES, tabHref } from '../../dashboard/console/nav-model.js';

const ok = (data: unknown) => ({ ok: true, data });
const fail = (reason: string) => ({ ok: false, reason });

// A small model of the server's registry: the real transition graph and gates.
const GRAPH: Record<string, string[]> = {
  undiscovered: ['aware'], aware: ['interested', 'deferred', 'declined'], interested: ['enabled'],
  deferred: ['aware'], declined: ['aware'], enabled: ['disabled'], disabled: ['enabled'],
};
function fakeServer(tier: string, start: string, apply: Record<string, unknown> | null = null, effective: Record<string, unknown> | null = null) {
  let state = start;
  let pending: string | null = null;
  const bodies: Record<string, unknown>[] = [];
  const def = { id: 'f1', name: 'F1', category: 'safety', consentTier: tier, dataImplications: [{ dataType: 'x', destination: 'local', description: 'stays here' }] };
  return {
    bodies,
    get state() { return state; },
    getInfo: async () => ({ ok: true, data: { definition: def, state: { discoveryState: state }, validTransitions: GRAPH[state] } }),
    transition: async (_id: string, body: Record<string, unknown>) => {
      bodies.push(body);
      const to = body.to as string;
      if (!GRAPH[state].includes(to)) return { ok: false, status: 422, data: { error: { code: 'INVALID_TRANSITION', message: `Cannot transition from '${state}' to '${to}'` } } };
      if (to === 'enabled' && (tier === 'network' || tier === 'self-governing') && !body.consentRecord) return { ok: false, status: 422, data: { error: { code: 'CONSENT_REQUIRED', message: 'requires a consent record' } } };
      if (to === 'enabled' && tier === 'self-governing') {
        if (!body.activationChallenge) { pending = 'tok123'; return { ok: false, status: 400, data: { error: { code: 'ACTIVATION_CHALLENGE_REQUIRED', message: 'verify', details: { challenge: pending } } } }; }
        if (body.activationChallenge !== pending) return { ok: false, status: 400, data: { error: { code: 'INVALID_ACTIVATION_CHALLENGE', message: 'bad' } } };
      }
      state = to;
      const sw = to === 'enabled' || to === 'disabled';
      return { ok: true, status: 200, data: { success: true, newState: to, ...(sw && apply ? { apply, effective } : {}) } };
    },
  };
}
const feature = (tier: string) => ({ id: 'f1', name: 'F1', tier, dataImplications: [{ dataType: 'x', destination: 'local', description: 'stays here' }] });

describe('feature walk', () => {
  it('picks the next step from the server list, never assuming a path', () => {
    expect(nextStepToEnabled(['aware'])).toBe('aware');
    expect(nextStepToEnabled(['interested', 'deferred', 'declined'])).toBe('interested');
    expect(nextStepToEnabled(['enabled'])).toBe('enabled');
    expect(nextStepToEnabled(['disabled'])).toBeNull();
    expect(nextStepToEnabled([])).toBeNull();
    expect(nextStepToEnabled(null)).toBeNull();
  });

  it('walks a local feature undiscovered → aware → interested → enabled with no consent record', async () => {
    const s = fakeServer('local', 'undiscovered');
    const r = await walkToEnabled(feature('local'), { ...s, confirmChallenge: async () => true });
    expect(r.ok).toBe(true);
    expect(r.steps).toEqual(['aware', 'interested', 'enabled']);
    expect(s.state).toBe('enabled');
    expect(s.bodies.every((b) => !b.consentRecord)).toBe(true);
  });

  it('a network feature carries an explicit-written consent record on the enabling step only', async () => {
    const s = fakeServer('network', 'aware');
    const r = await walkToEnabled(feature('network'), { ...s, confirmChallenge: async () => true });
    expect(r.ok).toBe(true);
    expect(s.bodies[0].consentRecord).toBeUndefined();
    const cr = s.bodies[1].consentRecord as Record<string, unknown>;
    expect(cr.mechanism).toBe('explicit-written');
    expect(cr.featureId).toBe('f1');
    expect(cr.dataImplications).toEqual(feature('network').dataImplications);
  });

  it('without a consent record the server refuses and the walk stops with its reason', async () => {
    const s = fakeServer('network', 'interested');
    const noConsent = { ...s, transition: (id: string, b: Record<string, unknown>) => s.transition(id, { ...b, consentRecord: undefined }) };
    const r = await walkToEnabled(feature('network'), { ...noConsent, confirmChallenge: async () => true });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('consent');
    expect(s.state).toBe('interested');
  });

  it('a self-governing feature completes the activation challenge after the operator confirms', async () => {
    const s = fakeServer('self-governing', 'interested');
    const asked = vi.fn(async () => true);
    const r = await walkToEnabled(feature('self-governing'), { ...s, confirmChallenge: asked });
    expect(r.ok).toBe(true);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(s.bodies[1].activationChallenge).toBe('tok123');
    expect(s.bodies[1].consentRecord).toBeTruthy();
  });

  it('a self-governing feature stays off when the operator cancels the challenge', async () => {
    const s = fakeServer('self-governing', 'interested');
    const r = await walkToEnabled(feature('self-governing'), { ...s, confirmChallenge: async () => false });
    expect(r.ok).toBe(false);
    expect(r.cancelled).toBe(true);
    expect(s.state).toBe('interested');
  });

  it('re-enables a disabled feature in one direct step', async () => {
    const s = fakeServer('local', 'disabled');
    const r = await walkToEnabled(feature('local'), { ...s, confirmChallenge: async () => true });
    expect(r.steps).toEqual(['enabled']);
  });

  it('a declined feature goes back through aware; a failed read stops honestly', async () => {
    const s = fakeServer('local', 'declined');
    expect((await walkToEnabled(feature('local'), { ...s, confirmChallenge: async () => true })).steps).toEqual(['aware', 'interested', 'enabled']);
    const r = await walkToEnabled(feature('local'), { getInfo: async () => fail('no answer within 5 seconds'), transition: s.transition, confirmChallenge: async () => true });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('no answer');
  });

  it('turn-off and undo are offered on the right side of each line', () => {
    expect(canTurnOff({ validTransitions: ['disabled'] })).toBe(true);
    expect(canTurnOff({ validTransitions: ['aware'] })).toBe(false);
    expect(canUndoOff({ tier: 'local' })).toBe(true);
    expect(canUndoOff({ tier: 'network' })).toBe(false);
    expect(consentRecord(feature('network') as never, 0).consentedAt).toBe(new Date(0).toISOString());
  });
});

describe('honest feature state (effective, read-only, apply outcome)', () => {
  const eff = (status: string, summary: string, extra: Record<string, unknown> = {}) => ({ status, summary, detail: null, recorded: true, configured: true, atBoot: true, lastAttempt: null, ...extra });
  const info = (def: Record<string, unknown>, state: string, effective?: Record<string, unknown>) => ({ definition: { id: 'f1', name: 'F1', category: 'safety', consentTier: 'local', ...def }, state: { discoveryState: state }, effective, validTransitions: GRAPH[state] });

  it('shows the server sentence, not the discovery state', () => {
    const on = flattenFeature(info({}, 'enabled', eff('on', 'On (the setting was on when the agent started; running is not separately verified).')));
    expect(on.stateWord).toBe('On');
    expect(on.stateText).toContain('running is not separately verified');
    expect(on.notice).toBe(false);
    const later = flattenFeature(info({}, 'enabled', eff('on-after-restart', 'Saved as on; it may not start until the next restart.')));
    expect(later.stateWord).toBe('On after a restart');
    expect(later.stateText).toContain('next restart');
    expect(later.notice).toBe(true);
    expect(later.effectiveOn).toBe(false);
    const rec = flattenFeature(info({}, 'enabled', eff('recorded-only', 'Switched on, but the setting is still off.', { configured: false })));
    expect(rec.stateWord).toBe('Recorded, not applied');
    expect(rec.stateText).toBe('Switched on, but the setting is still off.');
    expect(rec.on).toBe(true); // the switch position still offers "turn off"
    expect(rec.effectiveOn).toBe(false);
    // An older server with no `effective`: the discovery word, honestly labelled as such.
    expect(flattenFeature(info({}, 'aware')).stateWord).toBe('Seen');
  });

  it('a read-only feature carries the server reason and offers no switch or turn-off', () => {
    const ro = flattenFeature(info({ switchable: false, honestyNote: 'This agent currently runs the evolution system regardless of this setting.' }, 'undiscovered', eff('on', 'On. This agent currently runs the evolution system regardless of this setting.')));
    expect(ro.switchable).toBe(false);
    expect(ro.readOnlyReason).toContain('regardless of this setting');
    expect(canTurnOff(ro)).toBe(false);
    expect(flattenFeature(info({}, 'undiscovered')).switchable).toBe(true);
  });

  it('the walk refuses a read-only feature before sending anything', async () => {
    const s = fakeServer('local', 'undiscovered');
    const ro = flattenFeature(info({ switchable: false, honestyNote: 'Read-only here.' }, 'undiscovered'));
    const r = await walkToEnabled(ro, { ...s, confirmChallenge: async () => true });
    expect(r.ok).toBe(false);
    expect(r.readOnly).toBe(true);
    expect(r.message).toBe('This switch is read-only: Read-only here.');
    expect(s.bodies).toEqual([]);
  });

  it('a 409 FEATURE_NOT_SWITCHABLE and a 401 stop the walk as plain sentences, never success', async () => {
    const s = fakeServer('local', 'interested');
    const r409 = await walkToEnabled(feature('local'), { ...s, confirmChallenge: async () => true,
      transition: async () => ({ ok: false, status: 409, data: { error: { code: 'FEATURE_NOT_SWITCHABLE', message: 'The runtime ignores this key.' } } }) });
    expect(r409).toMatchObject({ ok: false, readOnly: true, message: 'This switch is read-only: The runtime ignores this key.' });
    const r401 = await walkToEnabled(feature('local'), { ...s, confirmChallenge: async () => true,
      transition: async () => ({ ok: false, status: 401, data: { error: { code: 'OPERATOR_PROOF_INVALID', message: 'Your dashboard unlock has expired or is not valid here. Unlock with your PIN again and retry.' } } }) });
    expect(r401.ok).toBe(false);
    expect(r401.proofInvalid).toBe(true);
    expect(r401.message).toContain('Unlock with your PIN again');
    expect(refusalText({ status: 401, data: {} })).toContain('expired');
  });

  it('reports the apply outcome on both sides: applied is on, refused/failed/not-applied are not', async () => {
    const applied = fakeServer('local', 'interested', { outcome: 'applied', httpStatus: 200, detail: null }, eff('on-after-restart', 'Saved as on; it may not start until the next restart.'));
    const a = await walkToEnabled(feature('local'), { ...applied, confirmChallenge: async () => true });
    expect(a.ok).toBe(true);
    expect(a.message).toBe('F1: Saved as on; it may not start until the next restart.');
    for (const [outcome, word] of [['refused', 'was refused'], ['failed', 'failed'], ['not-applied', 'was not made']] as const) {
      const s = fakeServer('local', 'interested', { outcome, httpStatus: outcome === 'refused' ? 403 : null, detail: 'the route said no' }, eff('recorded-only', 'Switched on, but the setting is still off.', { configured: false }));
      const r = await walkToEnabled(feature('local'), { ...s, confirmChallenge: async () => true });
      expect(r.ok).toBe(false);
      expect(r.state).toBe('enabled');
      expect(r.message).toBe(`F1 is recorded as on, but the setting change ${word}: the route said no. Switched on, but the setting is still off.`);
    }
    // An older server without `apply` is not dressed up as applied.
    const old = fakeServer('local', 'interested');
    const o = await walkToEnabled(feature('local'), { ...old, confirmChallenge: async () => true });
    expect(o.ok).toBe(true);
    expect(o.message).toContain('did not say whether the setting changed');
    expect(applyText('F1', 'disable', { apply: { outcome: 'applied' }, effective: eff('off', 'Off.') }).text).toBe('F1: Off.');
  });

  it('an already-enabled feature whose setting is still off says so instead of "On."', async () => {
    const r = await walkToEnabled(feature('local'), { getInfo: async () => ok(info({}, 'enabled', eff('recorded-only', 'Switched on, but the setting is still off.', { configured: false }))), transition: async () => ({ ok: true, status: 200, data: {} }), confirmChallenge: async () => true });
    expect(r).toMatchObject({ ok: false, message: 'Switched on, but the setting is still off.' });
  });
});

describe('features list', () => {
  it('groups, counts and states; failures say so', () => {
    const list = [
      { definition: { id: 'a', name: 'A', category: 'communication', consentTier: 'network' }, state: { discoveryState: 'enabled' } },
      { definition: { id: 'b', name: 'B', category: 'safety', consentTier: 'local' }, state: { discoveryState: 'undiscovered' } },
      // Recorded on but the setting is off: not counted as on.
      { definition: { id: 'c', name: 'C', category: 'safety', consentTier: 'local' }, state: { discoveryState: 'enabled' }, effective: { status: 'recorded-only', summary: 'Switched on, but the setting is still off.' } },
    ];
    const f = buildFeatures(ok({ features: list }));
    expect(f.ok).toBe(true);
    expect(f.groups.map((g: { id: string }) => g.id)).toEqual(['safety', 'communication']);
    expect(f.on).toBe(1);
    expect(f.total).toBe(3);
    expect(buildFeatures(fail('the server answered 501')).reason).toContain('aren’t set up');
    expect(buildFeatures(fail('no answer within 5 seconds')).reason).toContain('no answer');
    expect(buildFeatures(ok({})).ok).toBe(false);
  });
});

describe('profile', () => {
  const dash = { profile: 'supervised', resolved: { autoApplyUpdates: true, autoRestart: false, trustAutoElevate: true, evolutionApprovalMode: 'ai-assisted' }, availableProfiles: [{ level: 'cautious', description: 'Approve everything' }] };
  it('reads the sentence and what it means from resolved', () => {
    const p = buildProfile(ok(dash));
    expect(p.sentence).toContain('routine work');
    expect(p.steps.find((s: { current: boolean }) => s.current).id).toBe('supervised');
    expect(p.steps[0].desc).toBe('Approve everything');
    expect(meaningRows(dash.resolved)).toEqual([
      { label: 'Updates install themselves', text: 'yes' }, { label: 'I restart after updates', text: 'no' }, { label: 'I ask before raising my own trust', text: 'no' },
    ]);
  });
  it('says autonomy is not set up on a 404, never pretends supervised', () => {
    expect(buildProfile(fail('the server answered 404')).reason).toBe('Autonomy isn’t set up on this agent.');
    expect(buildProfile(fail('no answer within 5 seconds')).reason).toContain('no answer');
    expect(buildProfile(ok({ profile: 'weird' })).ok).toBe(false);
  });
  it('lists only what a switch would change', () => {
    expect(profileChanges(dash.resolved, 'collaborative')).toEqual(['I will restart myself after an update.']);
    expect(profileChanges(dash.resolved, 'cautious')).toContain('Updates will wait for you to install them.');
    expect(profileChanges(dash.resolved, 'supervised')).toEqual([]);
  });
  it('reads history from { history: [...] }, newest first', () => {
    const h = buildHistory(ok({ history: [{ from: 'cautious', to: 'supervised', at: '2026-10-01T00:00:00Z', reason: 'a' }, { from: 'supervised', to: 'collaborative', at: '2026-10-02T00:00:00Z', reason: 'b' }] }));
    expect(h.rows.map((r: { sub: string }) => r.sub)).toEqual(['b', 'a']);
    expect(buildHistory(ok([])).ok).toBe(false);
  });
});

describe('safety checks', () => {
  const gap = { key: 'monitoring.watchdog.enabled', effective: 'off', offClass: 'dark-default', loadBearing: true, criticalPath: 'stuck command recovery', loadBearingGap: true };
  const accepted = { key: 'monitoring.reaper.enabled', effective: 'off', offClass: 'dark-default', loadBearing: true, loadBearingAccepted: true, acceptedFallbackReason: 'testing' };
  const fine = { key: 'scheduler.enabled', effective: 'on-confirmed', offClass: null };
  const byDesign = { key: 'monitoring.x.enabled', effective: 'off', offClass: 'dark-default' };
  const deviant = { key: 'monitoring.y.enabled', effective: 'off', offClass: 'diverged-from-default' };
  const unverified = { key: 'monitoring.z.enabled', effective: 'on-unverified', offClass: null };

  it('puts off-where-it-should-be-on and unproven checks first', () => {
    expect(needsLook(gap)).toBe(true);
    expect(needsLook(deviant)).toBe(true);
    expect(needsLook(unverified)).toBe(false); // listed, not counted: the same rule as Home
    expect(needsLook(fine)).toBe(false);
    expect(needsLook(byDesign)).toBe(false);
    expect(needsLook(accepted)).toBe(false);
  });

  it('offers writes only on this machine’s load-bearing rows', () => {
    expect(guardActions(gap, true)).toEqual(['accept']);
    expect(guardActions(accepted, true)).toEqual(['stop-accepting']);
    expect(guardActions(gap, false)).toEqual([]);
    expect(guardActions(deviant, true)).toEqual([]);
  });

  it('lists this machine and the pool, names machines, and says what it could not read', () => {
    const g = buildGuards(ok({
      machineId: 'm1', nickname: 'Mac Studio', guards: [gap, fine, accepted],
      pool: { machines: [{ machineId: 'm2', nickname: 'Mac Mini', guards: [{ ...gap }, deviant] }], failed: [{ machineId: 'm3', reason: 'offline' }] },
    }));
    expect(g.ok).toBe(true);
    expect(g.multi).toBe(true);
    expect(g.counts.look).toBe(3);
    const peerGap = g.look.find((r: { local: boolean }) => !r.local && r.guardKey === gap.key);
    expect(peerGap.sub).toContain('Mac Mini');
    expect(peerGap.actions).toEqual([]);
    const localGap = g.look.find((r: { local: boolean }) => r.local);
    expect(localGap.actions).toEqual(['accept']);
    expect(localGap.where).toBe('Mac Studio');
    expect(g.failed[0].sub).toBe('Can’t tell: it is offline');
  });

  it('single machine: no machine chips; failures are can’t tell', () => {
    const g = buildGuards(ok({ machineId: 'm1', nickname: null, guards: [gap] }));
    expect(g.multi).toBe(false);
    expect(g.look[0].sub).toBe('off, nothing guards it');
    expect(g.look[0].where).toBe('this machine');
    expect(buildGuards(fail('the server answered 500')).reason).toContain('500');
    expect(buildGuards(ok({ summary: {} })).ok).toBe(false);
  });
});

describe('suggestions and facts', () => {
  it('shows opportunities with a way to act today, and the rubber-stamp line; a 404 hides the section', () => {
    const s = buildSuggestions(ok({ activeOpportunities: [{ type: 'profile-upgrade', current: 'supervised', suggested: 'collaborative', reason: 'You approved my last 12 config changes.', evidence: '12 of 12' }], rubberStamp: { detected: true, consecutiveFastApprovals: 19, avgLatencyMs: 4000, dismissedUntil: null } }), 0);
    expect(s.items[0].how).toBe('To allow this, move the profile to Collaborative, or tell me in chat.');
    expect(s.items[1].text).toContain('last 19 requests');
    expect(buildSuggestions(ok({ rubberStamp: { detected: true, dismissedUntil: new Date(10_000).toISOString() } }), 0).items).toEqual([]);
    expect(buildSuggestions(fail('the server answered 404')).hidden).toBe(true);
    expect(buildSuggestions(fail('no answer')).hidden).toBe(false);
  });
  it('facts never show a guard count it did not read', () => {
    const f = facts({ profile: { ok: true, profile: 'supervised' }, guards: { ok: false }, features: { ok: true, on: 2, total: 13 }, suggestions: { ok: true, items: [] } });
    expect(f.map((x: { label: string }) => x.label)).toEqual(['profile', 'features on']);
  });
  it('the tile and Home both go to the native page', () => {
    expect(NATIVE_PAGES.features).toBe('#/settings/allowed');
    expect(tabHref('features')).toBe('#/settings/allowed');
  });
});

describe('allowed page in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => dom?.window.close());

  it('boots the shipped console, opens a feature and walks it to on through the server', async () => {
    let state = 'undiscovered';
    const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
    const def = { id: 'external-operation-gate', name: 'Operation gate', category: 'safety', consentTier: 'local', oneLiner: 'Checks risky outside actions first.', dataImplications: [] };
    const ro = { id: 'evolution-system', name: 'Evolution', category: 'intelligence', consentTier: 'local', switchable: false, honestyNote: 'This agent currently runs the evolution system regardless of this setting; the switch is read-only until that changes.', dataImplications: [] };
    const effective = () => (state === 'enabled' ? { status: 'on-after-restart', summary: 'Saved as on; it may not start until the next restart.' } : { status: 'off', summary: 'Off.' });
    const roEntry = { definition: ro, state: { discoveryState: 'undiscovered' }, effective: { status: 'on', summary: 'On. ' + ro.honestyNote, detail: ro.honestyNote } };
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/settings/allowed' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    g.fetch = async (url: string, opts?: { method?: string; body?: string }) => {
      const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(body)) });
      if (opts && opts.method === 'POST' && url === '/features/external-operation-gate/transition') {
        const body = JSON.parse(opts.body || '{}');
        posted.push({ url, body });
        if (!GRAPH[state].includes(body.to)) return reply(422, { error: { code: 'INVALID_TRANSITION', message: 'no' } });
        state = body.to;
        const sw = state === 'enabled' || state === 'disabled';
        return reply(200, { success: true, newState: state, ...(sw ? { apply: { outcome: 'applied', httpStatus: 200, detail: null }, effective: effective() } : {}) });
      }
      const table: Record<string, unknown> = {
        '/sessions': { sessions: [] },
        '/health': { project: { name: 'echo' } },
        '/autonomy': { profile: 'supervised', resolved: { autoApplyUpdates: true, autoRestart: false, trustAutoElevate: true }, availableProfiles: [] },
        '/autonomy/history': { history: [] },
        '/guards?scope=pool': { machineId: 'm1', nickname: null, guards: [{ key: 'scheduler.enabled', effective: 'on-confirmed', offClass: null }] },
      };
      if (url === '/features') return reply(200, { features: [{ definition: def, state: { discoveryState: state }, effective: effective() }, roEntry] });
      if (url === '/features/external-operation-gate') return reply(200, { definition: def, state: { discoveryState: state }, effective: effective(), validTransitions: GRAPH[state] });
      const body = table[url];
      return body === undefined ? reply(404, { error: 'not found' }) : reply(200, body);
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 20));
    const doc = dom.window.document;
    expect(doc.querySelector('.page-title')!.textContent).toContain('routine work');
    expect(doc.querySelector('.seg-step.current .seg-label')!.textContent).toBe('Supervised');
    // /autonomy/elevation answered 404: the suggestions section is hidden, no claim.
    expect(doc.querySelector('#sec-suggestions')).toBeNull();
    // The read-only feature has no switch; its row shows the server's reason.
    expect(doc.querySelector('button.switch[data-feature="evolution-system"]')).toBeNull();
    expect(doc.querySelector('[data-feature-row="evolution-system"]')!.textContent).toContain('Read-only: This agent currently runs the evolution system regardless');
    const sw = doc.querySelector('button.switch[data-feature="external-operation-gate"]') as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    sw.click();
    await new Promise((r) => setTimeout(r, 10));
    const on = [...doc.querySelectorAll('.sheet-actions button')].find((b) => b.textContent === 'Turn on') as HTMLButtonElement;
    on.click();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 10));
    expect(posted.map((p) => p.body.to)).toEqual(['aware', 'interested', 'enabled']);
    expect(doc.querySelector('.sheet .action-status')!.textContent).toBe('Operation gate: Saved as on; it may not start until the next restart.');
    for (let i = 0; i < 110; i++) await new Promise((r) => setTimeout(r, 20));
    expect(doc.querySelector('button.switch[data-feature="external-operation-gate"]')!.getAttribute('aria-checked')).toBe('true');
    expect(doc.querySelector('[data-feature-row="external-operation-gate"] .feat-state')!.textContent).toBe('On after a restart');
  });
});
