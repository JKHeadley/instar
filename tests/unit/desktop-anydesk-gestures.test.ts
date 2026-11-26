import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

type Action = { kind: string; button?: string; key?: string; dx?: number; dy?: number; count?: number };

function setup() {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="surface"></div><div id="viewTransform"><img id="screen"><canvas id="videoCanvas" hidden></canvas><div id="localCursor"></div></div>
    <div id="desktopTools" hidden></div><div id="keyboardBar" hidden></div>
    <button id="toolsButton"></button><button id="keyboardButton"></button><button id="hideKeyboardButton"></button>
    <button id="zoomResetButton" hidden></button><button id="fullscreenButton"></button>
    <button id="modeButton"></button><button id="dragButton"></button><button id="rightButton"></button>
    <button id="stopButton"></button><input id="typeText">
    <button id="unlockButton"></button><button id="retryButton"></button><button id="requestButton"></button>
    <button data-remote-key="Control" data-modifier="true" aria-pressed="false"></button>
    <div id="status"></div><div id="liveStatus"></div><div id="control"></div><div id="request"></div>
  </body>`, { url: 'https://instar.example/dashboard/desktop', runScripts: 'outside-only' });
  const { window } = dom;
  const visualViewport = new window.EventTarget();
  Object.assign(visualViewport, { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 });
  Object.defineProperty(window, 'visualViewport', { value: visualViewport });
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: true }) });
  Object.defineProperty(window, 'TextEncoder', { value: TextEncoder });
  Object.defineProperty(window, 'requestAnimationFrame', { value: () => 1 });
  Object.defineProperty(window, 'cancelAnimationFrame', { value: () => {} });
  const surface = window.document.getElementById('surface')!;
  Object.defineProperty(surface, 'setPointerCapture', { value: () => {} });
  const source = fs.readFileSync(new URL('../../dashboard/desktop.js', import.meta.url), 'utf8');
  const actions: Action[] = [];
  (window as unknown as { __actions: Action[] }).__actions = actions;
  window.eval(`${source}\ninputEnabled = true; position = event => ({ x: 0.5, y: 0.5 });
    sendCommand = command => { if (command.action) window.__actions.push(command.action); return Promise.resolve(true); };`);
  const pointer = (type: string, pointerId: number, x: number, y: number, pointerType = 'touch') => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ pointerId, pointerType, clientX: x, clientY: y, button: 0, detail: 1 })) {
      Object.defineProperty(event, key, { value });
    }
    surface.dispatchEvent(event);
  };
  const kinds = () => actions.filter(a => a.kind !== 'move').map(a => a.button ? `${a.kind}:${a.button}` : a.kind);
  return { window, pointer, actions, kinds };
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('desktop viewer gestures match the AnyDesk report', () => {
  it('sends a quick mouse click as one click and a mouse drag as press and release', async () => {
    const { pointer, kinds } = setup();
    pointer('pointerdown', 1, 50, 50, 'mouse');
    pointer('pointerup', 1, 50, 50, 'mouse');
    await wait(300);
    expect(kinds()).toEqual(['click:left']);
    pointer('pointerdown', 2, 50, 50, 'mouse');
    pointer('pointermove', 2, 80, 80, 'mouse');
    pointer('pointerup', 2, 80, 80, 'mouse');
    await wait(0); await wait(0);
    expect(kinds()).toEqual(['click:left', 'buttonDown:left', 'buttonUp:left']);
  });

  it('sends a real double tap as one double-click, and a lone tap after the window', async () => {
    const { pointer, kinds, actions } = setup();
    pointer('pointerdown', 1, 60, 60); pointer('pointerup', 1, 60, 60);
    expect(kinds()).toEqual([]);
    pointer('pointerdown', 2, 62, 62); pointer('pointerup', 2, 62, 62);
    await wait(350);
    expect(kinds()).toEqual(['click:left']);
    expect(actions.at(-1)?.count).toBe(2);
    pointer('pointerdown', 3, 200, 200); pointer('pointerup', 3, 200, 200);
    await wait(350);
    expect(kinds()).toEqual(['click:left', 'click:left']);
    expect(actions.at(-1)?.count).toBeUndefined();
  });

  it('right-clicks on a two-finger tap and middle-clicks on a three-finger tap', () => {
    const { pointer, kinds } = setup();
    pointer('pointerdown', 1, 40, 40); pointer('pointerdown', 2, 100, 40);
    pointer('pointerup', 1, 40, 40); pointer('pointerup', 2, 100, 40);
    pointer('pointerdown', 3, 40, 40); pointer('pointerdown', 4, 100, 40); pointer('pointerdown', 5, 160, 40);
    pointer('pointerup', 3, 40, 40); pointer('pointerup', 4, 100, 40); pointer('pointerup', 5, 160, 40);
    expect(kinds()).toEqual(['click:right', 'click:middle']);
  });

  it('right-clicks on a long press and does not also left-click', async () => {
    const { pointer, kinds } = setup();
    pointer('pointerdown', 1, 60, 60);
    await wait(650);
    pointer('pointerup', 1, 60, 60);
    expect(kinds()).toEqual(['click:right']);
  });

  it('scrolls in the natural direction: fingers moving down scroll the content down', () => {
    const { pointer, actions } = setup();
    pointer('pointerdown', 1, 40, 40); pointer('pointerdown', 2, 100, 40);
    pointer('pointermove', 1, 40, 70); pointer('pointermove', 2, 100, 70);
    pointer('pointerup', 1, 40, 70); pointer('pointerup', 2, 100, 70);
    const scroll = actions.find(a => a.kind === 'scroll')!;
    expect(scroll.dy).toBeLessThan(0);
    expect(actions.some(a => a.kind === 'click')).toBe(false);
  });

  it('drags after a double-tap and hold', async () => {
    const { pointer, kinds } = setup();
    pointer('pointerdown', 1, 60, 60); pointer('pointerup', 1, 60, 60);
    pointer('pointerdown', 2, 62, 62);
    pointer('pointermove', 2, 120, 120);
    await wait(0);
    pointer('pointerup', 2, 120, 120);
    await wait(0); await wait(0);
    // No click before the press: the host would read the pair as a double-click
    // and maximize a window being dragged by its title bar.
    expect(kinds()).toEqual(['buttonDown:left', 'buttonUp:left']);
  });

  it('turns a letter typed with Ctrl latched into a shortcut key', async () => {
    const { window, actions } = setup();
    window.document.querySelector<HTMLElement>('[data-remote-key="Control"]')!.click();
    await wait(0);
    const input = window.document.getElementById('typeText') as HTMLInputElement;
    input.value = 'C';
    input.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    await wait(0); await wait(0);
    expect(actions.map(a => `${a.kind}:${a.key ?? ''}`)).toEqual(['keyDown:Control', 'keyDown:c', 'keyUp:c']);
    expect(actions.some(a => a.kind === 'type')).toBe(false);
  });
});
