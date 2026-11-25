import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fleetUsageSection } from '../../dashboard/console/fleet-usage.js';

const { askPin } = vi.hoisted(() => ({ askPin: vi.fn() }));
vi.mock('../../dashboard/console/ui.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../dashboard/console/ui.js')>(),
  askPin,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  askPin.mockReset();
});

function mount(body: unknown) {
  const { window } = new JSDOM('', { url: 'https://dashboard.example.test' });
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('localStorage', window.localStorage);
  const fetch = vi.fn().mockResolvedValue(Response.json(body));
  vi.stubGlobal('fetch', fetch);
  const section = fleetUsageSection();
  window.document.body.append(section);
  return { section, button: section.querySelector('button') as HTMLButtonElement, fetch };
}

describe('fleet usage dashboard section', () => {
  it('reads only on request after unlock and labels partial and unavailable agent data', async () => {
    const { section, button, fetch } = mount({
      since: '2026-11-19T00:00:00.000Z', tokens: 90, complete: false,
      agents: [{ label: 'Studio', tokens: 90, coverage: 'partial' }, { label: 'Lab', tokens: null, coverage: 'unavailable' }],
    });
    expect(fetch).not.toHaveBeenCalled();
    askPin.mockResolvedValue({ session: 'fixture-session' });
    button.click();
    await vi.waitFor(() => expect(section.textContent).toContain('90 tokens since 2026-11-19 (UTC) (partial total)'));
    expect(section.textContent).toContain('Lab · Usage unavailable');
    expect(fetch).toHaveBeenCalledWith('/usage/fleet', expect.objectContaining({
      headers: expect.objectContaining({ 'X-Instar-Operator-Session': 'fixture-session' }),
    }));
  });

  it('does not contact the collector when the unlock is canceled', async () => {
    const { button, fetch } = mount({});
    askPin.mockResolvedValue(null);
    button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(fetch).not.toHaveBeenCalled();
  });
});
