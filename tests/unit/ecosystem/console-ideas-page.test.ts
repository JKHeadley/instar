import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
let dom: JSDOM;
afterEach(() => { dom?.window.close(); vi.unstubAllGlobals(); vi.resetModules(); });
function setup(unranked = 150) {
  dom = new JSDOM('<main></main>', { url: 'https://agent.example/dashboard', pretendToBeVisual: true });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document); vi.stubGlobal('localStorage', dom.window.localStorage);
  const suggestion = (id: string, band: string) => ({ id, band, claim: band === 'plan' ? 'The useful next step' : `Unranked <not HTML> ${id}`, project: 'example/project', bandReason: 'Still being checked', effectClass: 'additive-dark' });
  const data = { neverRun: false, funnel: { seen: unranked + 1, verified: 1, decided: 0, adopted: 0, bands: { now: 0, plan: 1, watch: 0, stopped: 0, unranked } },
    admission: [], ideas: [suggestion('primary', 'plan'), ...Array.from({ length: unranked }, (_, i) => suggestion(`i${i}`, 'unranked'))], watchlist: [{ repo: 'example/project' }], proposals: [] };
  return { main: document.querySelector('main')!, api: { get: vi.fn(async () => ({ ok: true, data })) } };
}
describe('Ideas information hierarchy', () => {
  it('keeps the useful next step visible and retains all150 unranked suggestions behind one disclosure', async () => {
    const { main, api } = setup();
    const { renderIdeas } = await import('../../../dashboard/console/ideas.js');
    await renderIdeas(main, api);
    const group = main.querySelector('details.ideas-unranked') as HTMLDetailsElement;
    expect(group).not.toBeNull(); expect(group.open).toBe(false);
    expect(group.querySelector('summary')?.textContent).toContain('Not ranked (150)');
    expect(group.querySelectorAll('.need-card')).toHaveLength(150);
    expect(group.querySelectorAll('button')).toHaveLength(450);
    expect(main.querySelector('.need-card')?.textContent).toContain('The useful next step');
    expect(main.querySelector('.need-card')?.closest('details')).toBeNull();
    expect(main.querySelector('not')).toBeNull();
    expect(main.textContent).toContain('Projects we review');
    const { refreshHeld } = await import('../../../dashboard/console/ui.js');
    expect(refreshHeld(main)).toBe(false);
    group.querySelector('summary')!.click();
    await vi.waitFor(() => expect(refreshHeld(main)).toBe(true));
    group.open = false;
    await vi.waitFor(() => expect(refreshHeld(main)).toBe(false));
    expect(api.get).toHaveBeenCalledTimes(1);
  });
  it.each([0, 1])('handles %s unranked suggestions without hiding the primary group', async count => {
    const { main, api } = setup(count);
    const { renderIdeas } = await import('../../../dashboard/console/ideas.js'); await renderIdeas(main, api);
    expect(!!main.querySelector('details.ideas-unranked')).toBe(count > 0);
    expect(main.querySelector('.need-card')?.textContent).toContain('The useful next step');
    if (count) expect(main.querySelector('summary')?.textContent).toContain('Not ranked (1)');
  });
});
