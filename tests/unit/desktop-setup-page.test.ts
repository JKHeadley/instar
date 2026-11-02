/** The page renders what the server said, and acts only when told to. */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createDesktopSetup } from '../../dashboard/desktop-setup.js';

const ROW = { machineId: 'm_1', label: 'Mac Mini', ready: false, state: 'needs-screen', title: 'Allow Screen Recording',
  detail: 'Go by this page.', fallback: 'By hand: /x', actions: [
    { id: 'show-prompt', label: 'Show the pop-up' },
    { id: 'open-settings', label: 'Open the settings page', pane: 'screen' },
    { id: 'turn-off', label: 'Turn off' },
  ] };

function page(api: (path: string, method?: string, body?: unknown) => Promise<unknown>) {
  document.body.innerHTML = `<section id="setup" hidden><p id="setupLead"></p><ul id="setupRows"></ul></section><ul id="machineNotes"><li>old</li></ul>`;
  const onReady = vi.fn(async () => {});
  const onPinLost = vi.fn();
  const setup = createDesktopSetup({ api, $: (id: string) => document.getElementById(id), onReady, onPinLost });
  return { setup, onReady, onPinLost };
}
const button = (text: string) => [...document.querySelectorAll('button')].find(item => item.textContent === text)!;

describe('desktop setup page', () => {
  it('renders the server’s step, replaces the short notes, and runs no action by itself', async () => {
    const api = vi.fn(async () => ({ frontElsewhere: false, machines: [ROW] }));
    const { setup } = page(api as never);
    expect(await setup.refresh()).toBe(true);
    expect(document.getElementById('setup')!.hidden).toBe(false);
    expect(document.getElementById('setupRows')!.textContent).toContain('Allow Screen Recording');
    expect(document.querySelector('details')!.textContent).toContain('/x');
    expect(document.getElementById('machineNotes')!.children).toHaveLength(0);
    expect(api).toHaveBeenCalledTimes(1);
    setup.stop();
  });

  it('sends the pane with the settings action', async () => {
    const api = vi.fn(async (_path: string, method?: string) =>
      method === 'POST' ? { step: ROW } : { frontElsewhere: false, machines: [ROW] });
    const { setup } = page(api as never);
    await setup.refresh();
    button('Open the settings page').click();
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith('/desktop/setup/m_1', 'POST', { action: 'open-settings', pane: 'screen' }));
    setup.stop();
  });

  it('asks before turning a machine off', async () => {
    const api = vi.fn(async () => ({ frontElsewhere: false, machines: [ROW] }));
    const { setup } = page(api as never);
    await setup.refresh();
    vi.stubGlobal('confirm', () => false);
    button('Turn off').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(api).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    setup.stop();
  });

  it('points at the front when this is not it', async () => {
    const { setup } = page((async () => ({ frontElsewhere: true, frontLabel: 'Mac Studio', machines: [] })) as never);
    await setup.refresh();
    expect(document.getElementById('setupLead')!.textContent).toContain('Open this page on Mac Studio to set up other machines');
  });

  it('keeps a ready machine visible so its undo stays reachable', async () => {
    const { setup } = page((async () => ({ frontElsewhere: false, machines: [{ ...ROW, ready: true, fallback: undefined }] })) as never);
    await setup.refresh();
    expect(document.getElementById('setup')!.hidden).toBe(false);
    expect(button('Turn off')).toBeTruthy();
  });

  it('stays hidden on an older server', async () => {
    const old = page((async () => { throw new Error('Server answered 404'); }) as never);
    expect(await old.setup.refresh()).toBe(false);
  });

  it('asks for the PIN again when this machine’s restart ends the session', async () => {
    const { setup, onPinLost } = page((async () => { throw new Error('Dashboard operator session required'); }) as never);
    await setup.refresh();
    expect(onPinLost).toHaveBeenCalledOnce();
  });
});
