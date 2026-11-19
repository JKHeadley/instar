import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// A session the machine itself ended (a Windows PC that locked) must say why.
function viewer(machines: unknown[]) {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="surface"></div><div id="viewTransform"><img id="screen"><canvas id="videoCanvas" hidden></canvas><div id="localCursor"></div></div>
    <div id="desktopTools" hidden></div><div id="keyboardBar" hidden></div>
    <button id="toolsButton"></button><button id="keyboardButton"></button><button id="hideKeyboardButton"></button>
    <button id="zoomResetButton" hidden></button><button id="fullscreenButton"></button>
    <button id="modeButton"></button><button id="dragButton"></button><button id="rightButton"></button>
    <button id="stopButton"></button><input id="typeText">
    <button id="unlockButton"></button><button id="retryButton"></button><button id="requestButton"></button>
    <div id="status"></div><div id="liveStatus"></div><div id="control"></div><div id="request"></div>
    <div id="unlock"></div><select id="machine"></select><ul id="machineNotes"></ul>
  </body>`, { url: 'https://instar.example/dashboard/desktop', runScripts: 'outside-only' });
  const { window } = dom;
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: true }) });
  Object.defineProperty(window, 'TextEncoder', { value: TextEncoder });
  const fetched: string[] = [];
  Object.defineProperty(window, 'fetch', { value: async (path: string) => {
    fetched.push(path);
    (window as unknown as { __onFetch?: () => void }).__onFetch?.();
    return new Response(JSON.stringify({ machines }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  const source = fs.readFileSync(new URL('../../dashboard/desktop.js', import.meta.url), 'utf8');
  window.eval(`${source}\ntoken = 't'; operatorSession = 's';
    window.__ended = (id, message, onFetch) => { machineId = id; requestId = 'r1'; window.__onFetch = onFetch; return leaveExplained(message); };
    window.__newRequest = () => { requestId = ''; };`);
  const ended = (window as unknown as { __ended(id: string, message: string, onFetch?: () => void): Promise<void> }).__ended;
  const newRequest = (window as unknown as { __newRequest(): void }).__newRequest;
  const status = () => window.document.getElementById('status')!.textContent;
  return { dom, ended, newRequest, status, fetched, window };
}

const lockedReason = 'This Windows PC is locked. Remote desktop cannot unlock Windows yet: sign in at the PC, then tap Retry. The Instar agent is online.';

describe('desktop viewer explains a session the machine ended', () => {
  it('replaces the generic line with the ended machine’s own reason', async () => {
    const v = viewer([
      { machineId: 'm_studio', label: 'Mac Studio', ready: true, targetSigningPublicKey: 'k' },
      { machineId: 'm_mama', label: 'Mama PC', ready: false, unavailableReason: lockedReason },
    ]);
    await v.ended('m_mama', 'Desktop access ended. Open it again when needed.');
    expect(v.fetched.filter(path => path === '/desktop/targets')).toHaveLength(1);
    expect(v.status()).toBe(lockedReason);
    expect(v.window.document.getElementById('machineNotes')!.textContent).toContain('This Windows PC is locked');
    v.dom.window.close();
  });

  it('keeps the generic line when the machine is still ready', async () => {
    const v = viewer([{ machineId: 'm_mama', label: 'Mama PC', ready: true, targetSigningPublicKey: 'k' }]);
    await v.ended('m_mama', 'Desktop access ended. Open it again when needed.');
    expect(v.status()).toBe('Desktop access ended. Open it again when needed.');
    v.dom.window.close();
  });

  it('leaves a new request’s own status alone when the user started one meanwhile', async () => {
    const v = viewer([{ machineId: 'm_mama', label: 'Mama PC', ready: false, unavailableReason: lockedReason }]);
    await v.ended('m_mama', 'Desktop access ended. Open it again when needed.', () => v.newRequest());
    expect(v.status()).toBe('Desktop access ended. Open it again when needed.');
    v.dom.window.close();
  });
});
