import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

let dom: JSDOM;
const flush = () => new Promise((r) => setTimeout(r, 0));
afterEach(async () => {
  if (dom) { const { closeSheet } = await import('../../dashboard/console/ui.js'); closeSheet(); }
  dom?.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
const me = { machineId: 'm_me', name: 'Studio', self: true }, other = { machineId: 'm_other', name: 'Laptop', self: false };
const idle = (members: unknown[]) => ({ state: 'none', held: false, removed: [], failure: null, members, resume: null });
async function boot(status: () => unknown, extra: (path: string, body: any) => unknown = () => ({ ok: true, data: {} })) {
  vi.resetModules();
  dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'http://localhost:4040/dashboard/console/' });
  for (const key of ['window', 'document', 'location', 'history', 'localStorage', 'sessionStorage']) vi.stubGlobal(key, (dom.window as any)[key]);
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => setTimeout(f, 0));
  const { machineControls } = await import('../../dashboard/console/conversation-machines.js');
  const calls: Array<[string, any]> = [], refresh = vi.fn(), unlock = vi.fn();
  const send = vi.fn(async (path: string, body?: any) => { calls.push([path, body]); return path.endsWith('/status') ? { ok: true, status: 200, data: status() } : extra(path, body); });
  const controls = await machineControls({ send, current: () => true, unlock, refresh });
  if (controls) dom.window.document.body.append(controls as any);
  return { controls: controls as HTMLElement | null, calls, refresh, unlock, doc: dom.window.document };
}
const button = (doc: Document, text: string) => [...doc.querySelectorAll('button')].find(b => b.textContent === text) as HTMLButtonElement | undefined;

describe('removing a lost machine on the dashboard', () => {
  it('shows nothing for a one-machine fleet', async () => { expect((await boot(() => idle([me]))).controls).toBeNull(); });
  it('never offers to remove this machine, and offers nothing it cannot finish', async () => {
    const two = await boot(() => idle([me, other]));
    expect(two.controls!.textContent).toContain('Studio (this machine)');
    expect([...two.doc.querySelectorAll('button')].filter(b => b.textContent === 'Remove')).toHaveLength(1);
    const three = await boot(() => idle([me, other, { machineId: 'm_third', name: 'Mini', self: false }]));
    expect(button(three.doc, 'Remove')).toBeUndefined();
    expect(three.controls!.textContent).toContain('only when two remain');
  });
  it('warns first, then sends the owner choice for exactly that machine and reports the result', async () => {
    let state = 'none';
    const page = await boot(() => ({ ...idle([me, other]), state, removed: state === 'done' ? ['m_other'] : [] }), (path) => path.endsWith('/prepare') ? { ok: true, status: 200, data: { draftHash: 'd'.repeat(64), challenge: 'challenge' } } : (state = 'done', { ok: true, status: 202, data: { state: 'running' } }));
    button(page.doc, 'Remove')!.click();
    expect(page.doc.body.textContent).toContain('Only do this if Laptop is gone for good');
    expect(page.calls.filter(([path]) => !path.endsWith('/status'))).toHaveLength(0);
    button(page.doc, 'Remove Laptop')!.click(); await flush(); await flush(); await flush();
    const [prepare, confirm] = page.calls.filter(([path]) => !path.endsWith('/status'));
    expect(prepare[1].removedMachineIds).toEqual(['m_other']);
    expect(confirm[1]).toMatchObject({ requestId: prepare[1].requestId, confirmedMachineIds: ['m_other'], draftHash: 'd'.repeat(64), challenge: 'challenge', lossAcknowledgement: 'removed-local-unshared-edits-may-be-lost', pendingDisposition: 'refuse-all-uncommitted' });
    await flush();
    expect(page.doc.body.textContent).toContain('Machine removed.');
    button(page.doc, 'Done')!.click(); expect(page.refresh).toHaveBeenCalledOnce();
  });
  it('gives a held removal a way to finish, on the same request', async () => {
    const page = await boot(() => ({ ...idle([me, other]), state: 'interrupted', held: true, resume: { requestId: 'held-request', removedMachineIds: ['m_other'] } }), (path) => path.endsWith('/prepare') ? { ok: true, status: 200, data: { draftHash: 'd'.repeat(64), challenge: 'c' } } : { ok: true, status: 202, data: {} });
    expect(page.controls!.textContent).toContain('New changes wait until it does.');
    button(page.doc, 'Finish removing')!.click(); button(page.doc, 'Remove Laptop')!.click(); await flush(); await flush();
    expect(page.calls.find(([path]) => path.endsWith('/prepare'))![1].requestId).toBe('held-request');
  });
  it('offers another try after a refused attempt and a stopped removal', async () => {
    const refused = await boot(() => idle([me, other]), () => ({ ok: false, status: 409, data: { code: 'member-loss-one-survivor-only' } }));
    button(refused.doc, 'Remove')!.click(); button(refused.doc, 'Remove Laptop')!.click(); await flush(); await flush();
    expect(refused.doc.body.textContent).toContain('could not be removed right now');
    expect(button(refused.doc, 'Try again')).toBeTruthy();
    const { closeSheet } = await import('../../dashboard/console/ui.js'); closeSheet();
    const stopped = await boot(() => ({ ...idle([me, other]), state: 'failed', held: true, failure: 'x', resume: null }), (path) => path.endsWith('/prepare') ? { ok: true, status: 200, data: { draftHash: 'd', challenge: 'c' } } : { ok: true, status: 202, data: {} });
    button(stopped.doc, 'Remove')!.click(); button(stopped.doc, 'Remove Laptop')!.click(); await flush(); await flush(); await flush(); await flush();
    expect(stopped.doc.body.textContent).toContain('Removal stopped before it finished');
    expect(button(stopped.doc, 'Try again')).toBeTruthy();
  });
  it('does not claim a removal from an earlier answer, and treats no answer as unknown', async () => {
    const page = await boot(() => ({ ...idle([me, other]), state: 'interrupted', held: true, cancellable: true, removed: [] }), (path) => path.endsWith('/prepare') ? { ok: true, status: 200, data: { draftHash: 'd', challenge: 'c' } } : { ok: false, status: 0 });
    button(page.doc, 'Remove')!.click(); button(page.doc, 'Remove Laptop')!.click(); await flush(); await flush(); await flush(); await flush();
    expect(page.doc.body.textContent).not.toContain('Machine removed.');
    expect(page.doc.body.textContent).not.toContain('Nothing was changed');
    expect(button(page.doc, 'Keep Laptop')).toBeTruthy();
  });
  it('treats a refused confirm as refused, not as running', async () => {
    const page = await boot(() => idle([me, other]), (path) => path.endsWith('/prepare') ? { ok: true, status: 200, data: { draftHash: 'd', challenge: 'c' } } : { ok: false, status: 409, data: { code: 'member-loss-final-consent-conflict' } });
    button(page.doc, 'Remove')!.click(); button(page.doc, 'Remove Laptop')!.click(); await flush(); await flush(); await flush();
    expect(page.doc.body.textContent).toContain('could not be removed right now');
    expect(page.doc.body.textContent).not.toContain('Removing the machine');
  });
  it('asks for the owner again instead of failing when the session has ended', async () => {
    vi.resetModules();
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/' });
    for (const key of ['window', 'document', 'location', 'history', 'localStorage', 'sessionStorage']) vi.stubGlobal(key, (dom.window as any)[key]);
    const { machineControls } = await import('../../dashboard/console/conversation-machines.js');
    const unlock = vi.fn();
    expect(await machineControls({ send: async () => ({ ok: false, status: 403, needsUnlock: true }), current: () => true, unlock, refresh: vi.fn() })).toBeNull();
    expect(unlock).toHaveBeenCalledOnce();
  });
});
