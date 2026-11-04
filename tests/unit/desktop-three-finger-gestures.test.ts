import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

type Action = { kind: string; key?: string; displayId?: string | null };
type Viewer = {
  setDisplays(value: unknown): void;
  overview(): string | null;
  setHeldButton(value: string | null): void;
  commands: Array<{ action?: Action }>;
  chooseDisplay(id: string | null): Promise<void>;
  apiResult: unknown;
  expireSwitch(): void;
  latch(key: string): Promise<boolean>;
};

function load() {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="surface"></div><div id="viewTransform"><img id="screen"><canvas id="videoCanvas" hidden></canvas><div id="localCursor"></div></div>
    <div id="displayMenu" hidden></div>
    <div id="desktopTools" hidden><p id="displayNote" hidden></p>
      <button data-shortcut="overview" hidden></button><button data-shortcut="appWindows" hidden></button>
      <button data-shortcut="previousSpace" hidden></button><button data-shortcut="nextSpace" hidden></button></div>
    <div id="keyboardBar" hidden></div>
    <button id="toolsButton"></button><button id="displaysButton" hidden></button><button id="keyboardButton"></button><button id="hideKeyboardButton"></button>
    <button id="zoomResetButton" hidden></button><button id="fullscreenButton"></button>
    <button id="modeButton"></button><button id="dragButton"></button><button id="rightButton"></button>
    <button id="stopButton"></button><input id="typeText">
    <button id="unlockButton"></button><button id="retryButton"></button><button id="requestButton"></button>
    <div id="status"></div><div id="liveStatus"></div><div id="control"></div><div id="request"></div>
  </body>`, { url: 'https://instar.example/dashboard/desktop', runScripts: 'outside-only' });
  const { window } = dom;
  const viewport = new window.EventTarget();
  Object.assign(viewport, { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 });
  Object.defineProperty(window, 'visualViewport', { value: viewport });
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: true }) });
  Object.defineProperty(window, 'TextEncoder', { value: TextEncoder });
  const surface = window.document.getElementById('surface')!;
  Object.defineProperty(surface, 'setPointerCapture', { value: () => {} });
  const source = fs.readFileSync(new URL('../../dashboard/desktop.js', import.meta.url), 'utf8');
  window.eval(`${source}\ninputEnabled = true;
    window.__viewer = { commands: [], apiResult: null,
      setDisplays(value) { displayInfo = value; renderDisplays(); },
      overview() { return overviewOpen; }, chooseDisplay, expireSwitch() { screenSwitch.at = Date.now() - 3001; }, latch: beginKey,
      setHeldButton(value) { heldButton = value; } };
    sendCommand = command => { window.__viewer.commands.push(command); return Promise.resolve(true); };
    api = async () => window.__viewer.apiResult;`);
  const viewer = (window as unknown as { __viewer: Viewer }).__viewer;
  const touch = (type: string, pointerId: number, x: number, y: number) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ pointerId, pointerType: 'touch', clientX: x, clientY: y, button: 0 })) {
      Object.defineProperty(event, key, { value });
    }
    surface.dispatchEvent(event);
  };
  const swipe = async (dx: number, dy: number) => {
    for (const id of [1, 2, 3]) touch('pointerdown', id, 100 + id * 40, 300);
    for (const step of [0.5, 1]) for (const id of [1, 2, 3]) touch('pointermove', id, 100 + id * 40 + dx * step, 300 + dy * step);
    for (const id of [1, 2, 3]) touch('pointerup', id, 100 + id * 40 + dx, 300 + dy);
    await new Promise(resolve => setTimeout(resolve, 10));
  };
  const keys = () => viewer.commands.flatMap(command => command.action?.key
    ? [`${command.action.kind === 'keyDown' ? '+' : '-'}${command.action.key}`] : []);
  return { window, viewer, swipe, keys, $: (id: string) => window.document.getElementById(id)! };
}

const mac = { supported: true, platform: 'macos', canShowAll: false, currentDisplayId: '1', displays: [
  { id: '1', name: 'Built-in Retina Display', width: 3024, height: 1964, main: true },
  { id: '2', name: 'LG <b>HDR</b>', width: 3840, height: 2160, main: false }] };
const windows = { ...mac, platform: 'windows', canShowAll: true, currentDisplayId: null };
const older = { supported: false, platform: null, canShowAll: false, currentDisplayId: null, displays: [] };

describe('three-finger swipes', () => {
  it('maps the four directions to the standard Mac shortcuts', async () => {
    for (const [dx, dy, expected] of [
      [0, -120, ['+Control', '+ArrowUp', '-ArrowUp', '-Control']],
      [0, 120, ['+Control', '+ArrowDown', '-ArrowDown', '-Control']],
      [-120, 0, ['+Control', '+ArrowRight', '-ArrowRight', '-Control']],
      [120, 0, ['+Control', '+ArrowLeft', '-ArrowLeft', '-Control']],
    ] as Array<[number, number, string[]]>) {
      const v = load();
      v.viewer.setDisplays(mac);
      await v.swipe(dx, dy);
      expect(v.keys()).toEqual(expected);
    }
  });

  it('uses Task View and Ctrl+Win+arrows on Windows, and does nothing for a plain down', async () => {
    const v = load();
    v.viewer.setDisplays(windows);
    await v.swipe(0, -120);
    expect(v.keys()).toEqual(['+Meta', '+Tab', '-Tab', '-Meta']);
    await v.swipe(0, 120); // back out of Task View
    expect(v.keys().slice(4)).toEqual(['+Escape', '-Escape']);
    await v.swipe(0, 120);
    expect(v.keys()).toHaveLength(6);
    await v.swipe(-120, 0);
    expect(v.keys().slice(6)).toEqual(['+Control', '+Meta', '+ArrowRight', '-ArrowRight', '-Meta', '-Control']);
  });

  it('goes back with Escape from an open overview, and a click forgets it', async () => {
    const v = load();
    v.viewer.setDisplays(mac);
    await v.swipe(0, -120);
    expect(v.viewer.overview()).toBe('overview');
    await v.swipe(0, -120); // already open: nothing
    expect(v.keys()).toHaveLength(4);
    await v.swipe(0, 120);
    expect(v.keys().slice(4)).toEqual(['+Escape', '-Escape']);
    expect(v.viewer.overview()).toBeNull();
    await v.swipe(0, 120);
    expect(v.viewer.overview()).toBe('appWindows');
    (v.window as unknown as { eval(code: string): void }).eval("clickCursor('left')");
    expect(v.viewer.overview()).toBeNull();
  });

  it('leaves a latched modifier held', async () => {
    const v = load();
    v.viewer.setDisplays(mac);
    await v.viewer.latch('Control');
    await v.swipe(-120, 0);
    expect(v.keys()).toEqual(['+Control', '+ArrowRight', '-ArrowRight']);
  });

  it('fires once per swipe, ignores a short or diagonal one and a held button', async () => {
    const v = load();
    v.viewer.setDisplays(mac);
    await v.swipe(-40, 0);
    await v.swipe(-100, 90);
    expect(v.keys()).toEqual([]);
    await v.swipe(-400, 0);
    expect(v.keys()).toHaveLength(4);
    v.viewer.setHeldButton('left');
    await v.swipe(-120, 0);
    expect(v.keys()).toHaveLength(4);
  });

  it('sends nothing, and never a click, when the platform is unknown', async () => {
    const v = load();
    v.viewer.setDisplays(older);
    await v.swipe(0, -120);
    expect(v.viewer.commands).toEqual([]);
  });
});

describe('screen picker', () => {
  it('lists screens with name, resolution and main, as text', () => {
    const v = load();
    v.viewer.setDisplays(mac);
    expect(v.$('displaysButton').hidden).toBe(false);
    const rows = [...v.$('displayMenu').querySelectorAll('button')];
    expect(rows.map(row => row.textContent)).toEqual(['Built-in Retina Display · 3024×1964 · Main', 'LG <b>HDR</b> · 3840×2160']);
    expect(v.$('displayMenu').querySelector('b')).toBeNull();
    expect(rows.map(row => row.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
  });

  it('offers All screens where the host can show them, selected by default', () => {
    const v = load();
    v.viewer.setDisplays(windows);
    const first = v.$('displayMenu').querySelector('button')!;
    expect(first.textContent).toBe('All screens');
    expect(first.getAttribute('aria-pressed')).toBe('true');
  });

  it('hides the picker for a single screen but keeps gestures', async () => {
    const v = load();
    v.viewer.setDisplays({ ...mac, displays: mac.displays.slice(0, 1) });
    expect(v.$('displaysButton').hidden).toBe(true);
    await v.swipe(0, -120);
    expect(v.keys()).toHaveLength(4);
  });

  it('on an older host shows a plain note, no buttons, and never sends selectDisplay', async () => {
    const v = load();
    v.viewer.setDisplays(older);
    expect(v.$('displaysButton').hidden).toBe(true);
    expect(v.$('displayNote').hidden).toBe(false);
    expect(v.$('displayNote').textContent).toContain('needs an update');
    for (const node of v.window.document.querySelectorAll('[data-shortcut]')) expect((node as HTMLElement).hidden).toBe(true);
    await v.viewer.chooseDisplay('2');
    expect(v.viewer.commands).toEqual([]);
  });

  it('keeps gestures when the host names its platform but cannot switch screens', async () => {
    const v = load();
    v.viewer.setDisplays({ ...older, platform: 'macos' });
    expect(v.$('displayNote').hidden).toBe(false);
    await v.swipe(0, -120);
    expect(v.keys()).toHaveLength(4);
  });

  it('holds presses until the new screen is showing, so a tap cannot land off target', async () => {
    const v = load();
    v.viewer.setDisplays(mac);
    v.viewer.apiResult = { ...mac, currentDisplayId: '2' };
    const eval_ = (v.window as unknown as { eval(code: string): unknown }).eval.bind(v.window);
    const switching = v.viewer.chooseDisplay('2');
    await new Promise(resolve => setTimeout(resolve, 5));
    eval_("clickCursor('left')");
    expect(v.viewer.commands.map(command => command.action?.kind)).toEqual(['selectDisplay', 'move']);
    v.viewer.expireSwitch();
    eval_("clickCursor('left')");
    expect(v.viewer.commands.at(-1)?.action?.kind).toBe('click');
    await switching;
  });

  it('keeps working controls when a later read fails, and recovers an early one', async () => {
    const v = load();
    v.viewer.setDisplays(mac);
    const refresh = (v.window as unknown as { eval(code: string): () => Promise<unknown> }).eval('refreshDisplays');
    v.viewer.apiResult = older;
    expect(await refresh()).toBeNull();
    expect(v.$('displaysButton').hidden).toBe(false);
    expect(v.$('displayNote').hidden).toBe(true);
    v.viewer.setDisplays(older);
    v.viewer.apiResult = mac;
    await refresh();
    expect(v.$('displaysButton').hidden).toBe(false);
  });

  it('a mouse press forgets an open overview, so a button cannot send a stray Escape', async () => {
    const v = load();
    v.viewer.setDisplays(mac);
    v.$('desktopTools').querySelector<HTMLElement>('[data-shortcut="overview"]')!.click();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(v.viewer.overview()).toBe('overview');
    (v.window as unknown as { eval(code: string): void }).eval("beginHold('left'); setHeldButton(null)");
    expect(v.viewer.overview()).toBeNull();
    v.$('desktopTools').querySelector<HTMLElement>('[data-shortcut="overview"]')!.click();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(v.keys()).not.toContain('+Escape');
  });

  it('switches, moves the pointer onto that screen, and reports a screen that vanished', async () => {
    const v = load();
    v.viewer.setDisplays(mac);
    v.viewer.apiResult = mac; // the host stayed on screen 1
    await v.viewer.chooseDisplay('2');
    expect(v.viewer.commands.map(command => command.action)).toEqual([
      { kind: 'selectDisplay', displayId: '2' }, { kind: 'move', x: 0.5, y: 0.5 }]);
    expect(v.$('status').textContent).toBe('That screen is not available any more.');
  });
});
