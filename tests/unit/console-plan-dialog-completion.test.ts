import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
let dom: JSDOM;
afterEach(() => { vi.useRealTimers(); dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });

async function openApproval() {
  dom = new JSDOM('<main></main>', { url: 'http://localhost/dashboard/console/#/work/plans' });
  vi.useFakeTimers();
  for (const key of ['window', 'document', 'location', 'history'] as const) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key]);
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0));
  dom.window.scrollTo = () => {};
  const p = { id: 'restore-names', title: 'Restore Conversation Names', kind: 'project', status: 'active', autoAdvance: true,
    version: 1, updatedAt: new Date().toISOString(), rounds: [{ name: 'Recover names', status: 'pending', itemIds: [] }] };
  const table: Record<string, unknown> = {
    '/initiatives': { items: [p] }, '/projects': { items: [p] }, '/initiatives/digest': { items: [] },
    '/projects/restore-names?reconcile=false': { project: p, children: [] }, '/blockers': { entries: [] },
    '/autonomous/throughput-floor': { runs: [] }, '/pool': { machines: [] }, '/telegram/topics?scope=pool': { topics: [] },
  };
  let complete!: (result: unknown) => void;
  const pending = new Promise(resolve => { complete = resolve; });
  const get = vi.fn(async (url: string) => ({ ok: true, data: table[url] }));
  const post = vi.fn(async () => pending);
  const { renderPlans } = await import('../../dashboard/console/plans.js');
  const ui = await import('../../dashboard/console/ui.js');
  const main = document.querySelector('main')!;
  await renderPlans(main, { get, post });
  (main.querySelector('#sec-needsYou button.row') as HTMLButtonElement).click();
  const original = document.querySelector('.sheet')!;
  (original.querySelector('.need-card .action button') as HTMLButtonElement).click();
  expect(post).toHaveBeenCalledWith('/projects/restore-names/ack', { forRoundIndex: 0 });
  return { complete, original, get, ui, reads: get.mock.calls.length };
}

describe('Plan completion owns its dialog', () => {
  it.each(['success', 'version mismatch'])('does not close a newer dialog after a delayed %s response', async outcome => {
    const { complete, original, get, reads, ui } = await openApproval();
    ui.closeSheet();
    const newer = ui.sheet({ title: 'Accounts Settings' }, ui.el('p', { text: 'Keep this dialog open.' }));
    complete(outcome === 'success' ? { ok: true, data: {} } : { ok: false, reason: 'version mismatch' });
    await vi.advanceTimersByTimeAsync(1100);
    expect(original.isConnected).toBe(false);
    expect(newer.isConnected).toBe(true);
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Accounts Settings');
    expect(get).toHaveBeenCalledTimes(reads);
  });

  it.each(['success', 'version mismatch'])('still closes and refreshes its own open dialog after %s', async outcome => {
    const { complete, original, get, reads } = await openApproval();
    complete(outcome === 'success' ? { ok: true, data: {} } : { ok: false, reason: 'version mismatch' });
    await vi.advanceTimersByTimeAsync(1100);
    expect(original.isConnected).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(get.mock.calls.length).toBeGreaterThan(reads);
  });
});
