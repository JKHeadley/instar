import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectAppsRuntime, type ProjectAppsRuntimeDeps, type PinPlatformOps } from '../../src/server/ProjectAppsRuntime.js';
import { projectAppRecordStoreSchema, type UnionEntry } from '../../src/core/ProjectAppStore.js';
import { maturationSummaryFrom, MaturationSummaryProvider } from '../../src/server/projectAppSummaries.js';

const CK = 'telegram:128732';
const REF = 'builtin:maturation-board';
const BASE = 'https://echo.example.dev';

/** A real-shaped journal: builders run, the store schema validates, the union is what readers fold. */
function harness(over: Partial<ProjectAppsRuntimeDeps> = {}) {
  const union: UnionEntry[] = [];
  let t = 1_700_000_000_000;
  const ops = { sent: [] as string[], pinned: [] as Array<[string, boolean]>, edited: [] as string[], nextId: 100, failSend: false, editResult: 'edited' as 'edited' | 'missing' | 'not-modified' };
  const platform: PinPlatformOps = {
    send: async (_ck, text) => { if (ops.failSend) throw new Error('telegram down'); ops.sent.push(text); return String(ops.nextId++); },
    pin: async (_ck, id, on) => { ops.pinned.push([id, on]); },
    edit: async (_ck, id) => { ops.edited.push(id); return ops.editResult; },
  };
  let holds = true; let acting = true;
  const deps: ProjectAppsRuntimeDeps = {
    emit: (_k, build) => {
      const data = build({ physical: t++, logical: 0, node: 'm_a' }, 'm_a');
      if (!data) return { outcome: 'skipped' };
      const v = projectAppRecordStoreSchema.validate(data, { countDroppedField() {}, countJailReject() {} });
      if (!v) return { outcome: 'dropped:invalid' };
      union.push({ data, origin: 'm_a' });
      return { outcome: 'emitted' };
    },
    loadUnion: () => union,
    now: () => t,
    machineId: 'm_a',
    isActingMachine: () => acting,
    holdsLease: () => holds,
    projectKeys: () => [CK],
    publicBase: () => BASE,
    platformFor: () => ({ platform: 'telegram', ops: platform }),
    builtinSummary: () => ({ state: 'ok', headline: '275 features: 89 live, 80 stalled, regressed or blind', counts: [], asOf: '2026-11-17T01:00:00.000Z' }),
    builtinAvailable: () => true,
    ...over,
  };
  const rt = new ProjectAppsRuntime(deps);
  const settle = async () => { for (let i = 0; i < 5; i++) { await rt.process(); await new Promise((r) => setTimeout(r, 5)); } };
  return { rt, union, ops, settle, setLease: (v: boolean) => { holds = v; }, setActing: (v: boolean) => { acting = v; } };
}

const OWNER = { by: 'owner' as const, via: 'console' as const, principal: 'owner' };
const AGENT = { by: 'agent' as const, via: 'bearer' as const };

describe('offers', () => {
  it('once per project and app; refused after a no; only on the lease holder', () => {
    const h = harness();
    expect(h.rt.offer(CK, REF, 'Same table four times.')).toEqual({ ok: true });
    expect(h.rt.offer(CK, REF, 'again')).toMatchObject({ ok: false, error: 'already-offered' });
    const h2 = harness();
    h2.rt.answer(CK, REF, 'attach', OWNER); h2.rt.answer(CK, REF, 'decline', OWNER);
    expect(h2.rt.offer(CK, REF, 'x')).toMatchObject({ ok: false, error: 'owner-declined' });
    const h3 = harness(); h3.setLease(false);
    expect(h3.rt.offer(CK, REF, 'x')).toMatchObject({ ok: false, status: 409, error: 'not-lease-holder' });
  });
  it('refuses unknown projects, unknown apps, custom apps and an app whose feature is off', () => {
    const h = harness({ builtinAvailable: () => false });
    expect(h.rt.offer('telegram:1', REF, 'x')).toMatchObject({ error: 'unknown-project' });
    expect(h.rt.offer(CK, 'builtin:nope', 'x')).toMatchObject({ error: 'unknown-app' });
    expect(h.rt.offer(CK, 'custom:pa_0123456789abcdef', 'x')).toMatchObject({ error: 'custom-apps-not-available' });
    expect(h.rt.offer(CK, REF, 'x')).toMatchObject({ error: 'app-unavailable' });
  });
});

describe('custom app offers (part 2, project-apps-sandbox)', () => {
  const C = 'custom:pa_0123456789abcdef';
  const app = (o: Partial<{ conversationKey: string; specOk: boolean }> = {}) => ({ appId: 'pa_0123456789abcdef', title: 'Sales pipeline', conversationKey: CK, specOk: true, summary: { state: 'ok' as const, headline: 'Ten deals', counts: [], asOf: '2026-11-17T01:00:00.000Z' }, ...o });
  it('offers, attaches and shows a custom app on its own project when custom apps are on', () => {
    const h = harness({ customApp: (ref) => (ref === C ? app() : null) });
    expect(h.rt.offer(CK, C, 'The pipeline is easier to follow as a board.')).toEqual({ ok: true });
    expect(h.rt.view(CK).offers).toEqual([expect.objectContaining({ appRef: C, title: 'Sales pipeline' })]);
    expect(h.rt.answer(CK, C, 'attach', OWNER)).toMatchObject({ ok: true, changed: true });
    const row = h.rt.view(CK).apps.find((a) => a.appRef === C)!;
    expect(row).toMatchObject({ title: 'Sales pipeline', openHref: '/dashboard/project-app/?app=pa_0123456789abcdef', summaryState: 'ok' });
  });
  it('refuses another project\'s app, an unconverged spec, and hides the rows when custom apps are off', () => {
    expect(harness({ customApp: () => app({ conversationKey: 'telegram:1' }) }).rt.offer(CK, C, 'x')).toMatchObject({ error: 'unknown-app' });
    expect(harness({ customApp: () => app({ specOk: false }) }).rt.offer(CK, C, 'x')).toMatchObject({ status: 409, error: 'app-spec-not-converged' });
    let on = true;
    const h = harness({ customApp: () => (on ? app() : null) });
    h.rt.offer(CK, C, 'x'); h.rt.answer(CK, C, 'attach', OWNER);
    expect(h.rt.view(CK).apps.some((a) => a.appRef === C)).toBe(true);
    on = false;
    h.rt.onCommitted();
    expect(h.rt.view(CK).apps.some((a) => a.appRef === C)).toBe(false);
  });
});

describe('answers', () => {
  it('the agent can only withdraw its own open offer, never attach or undo an owner answer', () => {
    const h = harness();
    expect(h.rt.answer(CK, REF, 'attach', AGENT)).toMatchObject({ ok: false, status: 403, error: 'owner-proof-required' });
    expect(h.rt.answer(CK, REF, 'withdraw', AGENT)).toMatchObject({ ok: false, error: 'not-an-open-offer' });
    h.rt.offer(CK, REF, 'why');
    h.rt.answer(CK, REF, 'attach', OWNER);
    expect(h.rt.answer(CK, REF, 'withdraw', AGENT)).toMatchObject({ ok: false, error: 'not-an-open-offer' });
    expect(h.rt.view(CK).apps.map((a) => a.appRef)).toEqual([REF]);
  });
  it('the same requestId is one answer; attaching an attached app writes no act', () => {
    const h = harness();
    h.rt.answer(CK, REF, 'attach', OWNER, 'req-12345678');
    const n = h.union.length;
    expect(h.rt.answer(CK, REF, 'attach', OWNER, 'req-12345678')).toEqual({ ok: true, changed: false });
    expect(h.union.length).toBe(n);
    expect(h.rt.answer(CK, REF, 'attach', OWNER)).toEqual({ ok: true, changed: false });
    expect(h.union.filter((e) => e.data.state === 'act').length).toBe(1);
  });
  it('the view lists offers, attached apps with their summary, recent answers and Add app notes', () => {
    const h = harness();
    h.rt.offer(CK, REF, 'Same table.');
    expect(h.rt.view(CK).offers).toEqual([expect.objectContaining({ appRef: REF, title: 'Feature maturation board', why: 'Same table.' })]);
    h.rt.answer(CK, REF, 'decline', OWNER);
    expect(h.rt.view(CK).addable[0]).toMatchObject({ appRef: REF, note: expect.stringContaining('you said no') });
    h.rt.answer(CK, REF, 'attach', OWNER);
    const v = h.rt.view(CK);
    expect(v.apps[0]).toMatchObject({ title: 'Feature maturation board', openHref: '#/work/maturation', summaryState: 'ok' });
    expect(v.answers.length).toBe(2);
  });
});

describe('pin steps on the acting machine', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });
  it('attach posts once and pins it; detach unpins', async () => {
    h.rt.answer(CK, REF, 'attach', OWNER);
    await h.settle();
    expect(h.ops.sent.length).toBe(1);
    expect(h.ops.sent[0]).toContain(`${BASE}/dashboard/console/#/work/maturation`);
    expect(h.ops.pinned).toEqual([['100', true]]);
    expect(h.rt.view(CK).apps[0].pin).toMatchObject({ state: 'pinned' });
    h.rt.answer(CK, REF, 'detach', OWNER);
    await h.settle();
    expect(h.ops.pinned).toEqual([['100', true], ['100', false]]);
    expect(h.ops.sent.length).toBe(1);
  });
  it('nothing happens on a machine that is not the acting machine', async () => {
    h.setActing(false);
    h.rt.answer(CK, REF, 'attach', OWNER);
    await h.settle();
    expect(h.ops.sent.length).toBe(0);
  });
  it('a failed send is recorded with its reason and never retried on its own; Try again sends once', async () => {
    h.ops.failSend = true;
    h.rt.answer(CK, REF, 'attach', OWNER);
    await h.settle(); await h.settle();
    expect(h.ops.sent.length).toBe(0);
    expect(h.rt.view(CK).apps[0].pin).toMatchObject({ state: 'failed', reason: 'telegram down' });
    h.ops.failSend = false;
    h.rt.requestPinAct(CK, REF, 'retry'); await h.settle();
    expect(h.ops.sent.length).toBe(1);
    expect(h.rt.view(CK).apps[0].pin).toMatchObject({ state: 'pinned' });
  });
  it('a send that may or may not have happened (pending, no outcome) is uncertain: only Post the link again sends', async () => {
    h.rt.answer(CK, REF, 'attach', OWNER);
    // Simulate a crash mid-send: consume the act with a bare pending step written by a lost process.
    const act = h.union.find((e) => e.data.state === 'act')!;
    h.union.push({ origin: 'm_a', data: { ...act.data, state: 'pending', act: undefined, recordKey: 'apppin-x', hlc: { physical: 1, logical: 9, node: 'm_a' } } });
    await h.settle();
    expect(h.ops.sent.length).toBe(0);
    expect(h.rt.view(CK).apps[0].pin).toMatchObject({ state: 'uncertain' });
    h.rt.requestPinAct(CK, REF, 'retry'); await h.settle();
    expect(h.ops.sent.length).toBe(0);
    h.rt.requestPinAct(CK, REF, 'post-again'); await h.settle();
    expect(h.ops.sent.length).toBe(1);
  });
  it('a detach that lands while the attach is being processed leaves nothing pinned', async () => {
    h.rt.answer(CK, REF, 'attach', OWNER);
    h.rt.answer(CK, REF, 'detach', OWNER);
    await h.settle();
    const pinnedNow = new Map<string, boolean>(); for (const [id, on] of h.ops.pinned) pinnedNow.set(id, on);
    expect([...pinnedNow.values()].every((on) => !on)).toBe(true);
  });
});

describe('the maturation summary', () => {
  it('reads the board counts and its as-of time; never zeros for a board without reviews', () => {
    const ok = maturationSummaryFrom({ generatedAt: '2026-11-17T01:00:00.000Z', reviewMachine: 'Mac Studio', counts: { features: 275, live: 89, stalledRegressedBlind: 80, pastDate: 43 } });
    expect(ok).toMatchObject({ state: 'ok', headline: '275 features: 89 live, 80 stalled, regressed or blind', asOf: '2026-11-17T01:00:00.000Z' });
    expect(maturationSummaryFrom({ generatedAt: 'x', reviewMachine: null, counts: { features: 0 } }).state).toBe('unreadable');
    expect(maturationSummaryFrom(null).state).toBe('unreadable');
  });
  it('pending first, then the value; a 429 keeps the last value; off says so with an action', async () => {
    let status = 200;
    const p = new MaturationSummaryProvider({ enabled: () => true, fetch: async () => ({ status, body: { generatedAt: '2026-11-17T01:00:00.000Z', reviewMachine: 'M', counts: { features: 3, live: 1, stalledRegressedBlind: 1, pastDate: 0 } } }) });
    expect(p.get().state).toBe('pending');
    await p.refresh();
    expect(p.get().state).toBe('ok');
    status = 429; await p.refresh();
    expect(p.get().state).toBe('ok');
    const off = new MaturationSummaryProvider({ enabled: () => false, fetch: async () => ({ status: 200, body: null }) });
    expect(off.get()).toMatchObject({ state: 'unreadable', action: expect.objectContaining({ label: 'Turn it on' }) });
  });
});
