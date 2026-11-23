import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChromeCdpReloginBrowser } from '../../src/core/ChromeCdpReloginBrowser.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type Mode = 'normal' | 'close-release' | 'close-pressed' | 'throw-release' | 'reject-release' | 'missing-button' | 'missing-form' | 'pipe-close' | 'lookalike-error' | 'switch-after-point' | 'missing-detach';
type Command = { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
type Internals = { tcpPort: number | null; tcpActiveTargetId: string | null; tcpMainTarget: unknown; tcpTargetsAtOpen: Set<string>;
  sessions: Map<string, { targetId: string; type: string }>; mainSessionId: string; pageOrder: string[];
  attachTransport(transport: ScriptedTransport): void; activeSessionId(): string | null };
class ScriptedTransport {
  open = true;
  calls: Command[] = [];
  forms: Command[] = [];
  private message: (raw: string) => void = () => {};
  private closed: () => void = () => {};
  constructor(private readonly fixture: { mode: Mode; gone: boolean; internals: () => Internals; switchTargets?: () => void }) {}
  onMessage(callback: (raw: string) => void) { this.message = callback; }
  onClose(callback: () => void) { this.closed = callback; }
  close() { this.open = false; this.closed(); }
  send(raw: string) {
    const command = JSON.parse(raw) as Command; this.calls.push(command);
    const reply = (result: Record<string, unknown> = {}, error?: string, after?: () => void) => queueMicrotask(() => { this.message(JSON.stringify({ id: command.id, ...(error ? { error: { message: error } } : { result }) })); after?.(); });
    if (command.method === 'Runtime.evaluate') {
      const expression = String(command.params.expression);
      const point = expression.includes('getBoundingClientRect');
      const form = expression.includes('form.requestSubmit');
      if (point && this.fixture.mode === 'switch-after-point') { reply({ result: { value: { x: 10, y: 20 } } }, undefined, () => this.fixture.switchTargets?.()); return; }
      if (point && this.fixture.mode === 'missing-detach') { reply({ result: { value: null } }, undefined, () => { this.fixture.gone = true; this.fixture.internals().sessions.delete('popup-session'); }); return; }
      if (point) {
        if (['missing-button','missing-form'].includes(this.fixture.mode)) {
          const submits = form && this.fixture.mode === 'missing-button';
          if (submits) this.forms.push(command);
          reply({ result: { value: submits ? { formSubmitted: true } : null } });
        } else reply({ result: { value: { x: 10, y: 20 } } });
      } else {
        const submits = form && this.fixture.mode !== 'missing-form';
        if (submits) this.forms.push(command);
        reply({ result: { value: form ? submits : true } });
      }
      return;
    }
    if (command.method === 'Target.getTargets') { reply({ targetInfos: [{ targetId: 'main', type: 'page' }] }); return; }
    if (command.method === 'Input.dispatchMouseEvent') {
      const type = command.params.type;
      if (this.fixture.mode === 'close-pressed' && type === 'mousePressed') {
        this.fixture.gone = true; this.open = false; queueMicrotask(() => this.closed()); return;
      }
      if (type === 'mouseReleased') {
        if (this.fixture.mode === 'throw-release') { this.fixture.gone = true; this.open = false; throw new Error('synthetic-send-failed'); }
        if (this.fixture.mode === 'reject-release') { reply({}, 'synthetic-release-failed'); return; }
        if (this.fixture.mode === 'lookalike-error') { reply({}, 'browser-element-not-found'); return; }
        if (this.fixture.mode === 'pipe-close') {
          this.fixture.gone = true; this.fixture.internals().sessions.delete('popup-session'); reply({}, 'synthetic-session-closed'); return;
        }
        if (this.fixture.mode === 'close-release') { this.fixture.gone = true; this.open = false; queueMicrotask(() => this.closed()); return; }
      }
    }
    reply();
  }
}
const roots: string[] = [];
const browsers: ChromeCdpReloginBrowser[] = [];
afterEach(async () => {
  for (const browser of browsers.splice(0)) await browser.close();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'scripted popup click fixture' });
});
function rig(mode: Mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-click-')); roots.push(root);
  const state: { mode: Mode; gone: boolean; internals: () => Internals; switchTargets?: () => void } = { mode, gone: false, internals: (): Internals => browser as unknown as Internals };
  const popup = new ScriptedTransport(state); const main = new ScriptedTransport({ ...state, mode: 'normal' });
  let observed = 0;
  class Browser extends ChromeCdpReloginBrowser {
    protected override async followNewestPage() {
      if (!['pipe-close','missing-detach'].includes(mode) && state.gone) {
        state.internals().attachTransport(main); state.internals().tcpActiveTargetId = 'main'; observed++;
      }
    }
    override async wait() {}
  }
  const browser = new Browser({ userDataDir: root }); browsers.push(browser);
  const internal = state.internals();
  internal.tcpPort = ['pipe-close','missing-detach'].includes(mode) ? null : 12345;
  internal.tcpActiveTargetId = 'popup';
  internal.tcpMainTarget = { id: 'main', wsUrl: 'ws://127.0.0.1/main' };
  internal.tcpTargetsAtOpen = new Set(['main']);
  state.switchTargets = () => { internal.attachTransport(main); internal.tcpActiveTargetId = 'main'; };
  if (['pipe-close','missing-detach'].includes(mode)) {
    internal.sessions.set('main-session', { targetId: 'main', type: 'page' });
    internal.sessions.set('popup-session', { targetId: 'popup', type: 'page' });
    internal.mainSessionId = 'main-session'; internal.pageOrder.push('main-session', 'popup-session');
  }
  internal.attachTransport(popup);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
    ...(!state.gone ? [{ id: 'popup', type: 'page', url: 'https://accounts.google.com/' }] : []),
    { id: 'main', type: 'page', url: 'https://chatgpt.com/', webSocketDebuggerUrl: 'ws://127.0.0.1/main' },
  ]))));
  const forms = () => [...popup.forms, ...main.forms];
  return { browser, popup, main, forms, observed: () => observed, internal };
}

it('observes the remaining page after a dispatched final click closes its popup, without replaying input', async () => {
  const f = rig('close-release');
  await expect(f.browser.fillPublic('email', 'synthetic@example.invalid')).resolves.toBeUndefined();
  expect(f.observed()).toBe(1); expect(f.internal.tcpActiveTargetId).toBe('main');
  expect(f.popup.calls.filter(call => call.params.type === 'mouseReleased')).toHaveLength(1);
  expect(f.forms()).toHaveLength(0); expect(f.main.calls).toHaveLength(0);
});
it('does not mistake closure before final release for a completed click or submit another form', async () => {
  const f = rig('close-pressed');
  await expect(f.browser.fillPublic('email', 'synthetic@example.invalid')).rejects.toThrow('cdp-closed');
  expect(f.popup.calls.filter(call => call.params.type === 'mouseReleased')).toHaveLength(0);
  expect(f.forms()).toHaveLength(0); expect(f.observed()).toBe(0);
});
it('does not treat a synchronous final-send failure as proof that a click was dispatched', async () => {
  const f = rig('throw-release');
  await expect(f.browser.fillPublic('email', 'synthetic@example.invalid')).rejects.toThrow('synthetic-send-failed');
  expect(f.forms()).toHaveLength(0); expect(f.observed()).toBe(0);
});
it('preserves a real release failure while the original target is still present', async () => {
  const f = rig('reject-release');
  await expect(f.browser.fillPublic('email', 'synthetic@example.invalid')).rejects.toThrow('synthetic-release-failed');
  expect(f.forms()).toHaveLength(0); expect(f.observed()).toBe(0);
});
it('uses the form fallback only when no button exists', async () => {
  const f = rig('missing-button');
  await f.browser.fillPublic('email', 'synthetic@example.invalid');
  expect(f.forms()).toHaveLength(1); expect(f.popup.calls.filter(call => call.method === 'Input.dispatchMouseEvent')).toHaveLength(0);
});
it('refuses when neither a real button nor a form exists', async () => {
  const f = rig('missing-form');
  await expect(f.browser.fillPublic('email', 'synthetic@example.invalid')).rejects.toThrow('browser-element-not-found');
  expect(f.forms()).toHaveLength(0);
  expect(f.popup.calls.filter(call => call.method === 'Runtime.evaluate')).toHaveLength(2);
});
it('keeps a normal real click unchanged', async () => {
  const f = rig('normal'); await f.browser.fillPublic('email', 'synthetic@example.invalid');
  expect(f.popup.calls.filter(call => call.params.type === 'mouseReleased')).toHaveLength(1); expect(f.forms()).toHaveLength(0);
});
it('confirms a detached pipe target and observes the remaining live session without input replay', async () => {
  const f = rig('pipe-close');
  await expect(f.browser.fillPublic('email', 'synthetic@example.invalid')).resolves.toBeUndefined();
  expect(f.internal.activeSessionId()).toBe('main-session');
  expect(f.popup.calls.filter(call => call.method === 'Target.getTargets')).toHaveLength(1);
  expect(f.forms()).toHaveLength(0);
  expect(f.popup.calls.filter(call => call.method === 'Input.dispatchMouseEvent').every(call => call.sessionId === 'popup-session')).toBe(true);
});

it('does not use form fallback for a transport error whose text resembles the missing-control signal', async () => {
  const f = rig('lookalike-error');
  await expect(f.browser.fillPublic('email', 'synthetic@example.invalid')).rejects.toThrow('browser-element-not-found');
  expect(f.forms()).toHaveLength(0);
});

it('never dispatches old coordinates after a concurrent TCP target switch', async () => {
  const f = rig('switch-after-point');
  await expect(f.browser.fillPublic('email', 'synthetic@example.invalid')).rejects.toThrow('cdp-target-changed');
  expect(f.main.calls).toHaveLength(0); expect(f.forms()).toHaveLength(0);
});
it('never submits a replacement page form after a missing-button popup detaches', async () => {
  const f = rig('missing-detach');
  await expect(f.browser.fillPublic('email', 'synthetic@example.invalid')).rejects.toThrow('browser-element-not-found');
  expect(f.internal.activeSessionId()).toBe('main-session');
  expect(f.forms()).toHaveLength(0);
});
