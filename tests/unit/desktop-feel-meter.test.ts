import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

type Summary = {
  actions: number; answered: number; unanswered: number; typicalDelayMs: number | null;
  worstDelayMs: number | null; picturesPerSecond: number | null; longestGapMs: number | null;
};
type Meter = {
  feelReset(): void; feelInput(kind: string, now?: number): void; feelPainted(now?: number): void;
  feelForgetPending(): void; feelOnDecoded(image: { decode?: () => Promise<void> } | null, epoch: number): void;
  feelSummary(): Summary; feelText(summary?: Summary): string;
  send(action: { kind: string; key?: string; button?: string }): Promise<boolean>;
  setScreenSwitch(at: number | null): void; setLockedState(state: string): void; bumpEpoch(): number; epoch(): number;
  syncFeelReadout(): void; setShown(shown: boolean): void; sent: unknown[];
};

function setup(withReadout = true): { meter: Meter; window: JSDOM['window'] } {
  const readout = withReadout
    ? '<button id="speedButton" aria-pressed="false"></button><p id="speedReadout" hidden></p>' : '';
  const dom = new JSDOM(`<!doctype html><body>
    <div id="surface"></div><div id="viewTransform"><img id="screen"><canvas id="videoCanvas" hidden></canvas><div id="localCursor"></div></div>
    <div id="desktopTools" hidden></div><div id="keyboardBar" hidden></div>
    <button id="toolsButton"></button><button id="keyboardButton"></button><button id="hideKeyboardButton"></button>
    <button id="zoomResetButton" hidden></button><button id="fullscreenButton"></button>
    <button id="modeButton"></button><button id="dragButton"></button><button id="rightButton"></button>
    <button id="stopButton"></button><input id="typeText">
    <button id="unlockButton"></button><button id="retryButton"></button><button id="requestButton"></button>
    <div id="status"></div><div id="liveStatus"></div><div id="control"></div><div id="request"></div>
    ${readout}
  </body>`, { url: 'https://instar.example/dashboard/desktop', runScripts: 'outside-only' });
  const { window } = dom;
  const visualViewport = new window.EventTarget();
  Object.assign(visualViewport, { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 });
  Object.defineProperty(window, 'visualViewport', { value: visualViewport });
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: true }) });
  Object.defineProperty(window, 'TextEncoder', { value: TextEncoder });
  Object.defineProperty(window, 'requestAnimationFrame', { value: () => 1 });
  Object.defineProperty(window, 'cancelAnimationFrame', { value: () => {} });
  const source = fs.readFileSync(new URL('../../dashboard/desktop.js', import.meta.url), 'utf8');
  window.eval(`${source}
    inputEnabled = true;
    window.__meter = { feelReset, feelInput, feelPainted, feelSummary, feelText, send, syncFeelReadout,
      feelForgetPending, feelOnDecoded,
      setShown: shown => { feelShown = shown; },
      setScreenSwitch: at => { screenSwitch = at === null ? null : { at }; },
      setLockedState: state => { lockedScreenState = state; },
      bumpEpoch: () => ++streamEpoch, epoch: () => streamEpoch,
      sent: [] };
    sendCommand = command => { window.__meter.sent.push(command); return Promise.resolve(true); };`);
  return { meter: (window as unknown as { __meter: Meter }).__meter, window };
}

describe('remote desktop speed reading', () => {
  it('times each action to the next picture and reports typical and worst delay', () => {
    const { meter } = setup();
    meter.feelReset();
    const delays = [40, 50, 60, 70, 80, 90, 100, 110, 120, 300];
    let now = 1_000;
    for (const delay of delays) {
      meter.feelInput('click', now);
      meter.feelPainted(now + delay);
      now += 1_000;
    }
    expect(meter.feelSummary()).toMatchObject({ answered: 10, actions: 10, typicalDelayMs: 80,
      worstDelayMs: 300, unanswered: 0 });
  });

  it('times a quick burst of key presses from its first press', () => {
    const { meter } = setup();
    meter.feelReset();
    meter.feelInput('keyDown', 0);
    meter.feelInput('keyDown', 40);
    meter.feelInput('keyDown', 80);
    meter.feelPainted(90);
    expect(meter.feelSummary()).toMatchObject({ actions: 1, typicalDelayMs: 90, unanswered: 0 });
  });

  it('a click after an unanswered action is timed from the click, not the earlier action', () => {
    const { meter } = setup();
    meter.feelReset();
    meter.feelInput('click', 0); // changed nothing on screen
    meter.feelInput('click', 400);
    meter.feelPainted(470);
    expect(meter.feelSummary()).toMatchObject({ actions: 2, unanswered: 1, typicalDelayMs: 70 });
  });

  it('never times plain moves or releases', () => {
    const { meter } = setup();
    meter.feelReset();
    meter.feelInput('move', 0);
    meter.feelInput('buttonUp', 10);
    meter.feelInput('keyUp', 20);
    meter.feelPainted(50);
    expect(meter.feelSummary()).toMatchObject({ actions: 0, answered: 0, unanswered: 0 });
    // A move then a click 400 ms later is timed from the click.
    meter.feelInput('move', 1_000);
    meter.feelInput('click', 1_400);
    meter.feelPainted(1_480);
    expect(meter.feelSummary()).toMatchObject({ actions: 1, typicalDelayMs: 80 });
  });

  it('does not count a picture that arrives too late as an answer', () => {
    const { meter } = setup();
    meter.feelReset();
    meter.feelInput('click', 0);
    meter.feelPainted(2_000);
    expect(meter.feelSummary()).toMatchObject({ answered: 0, unanswered: 1 });
  });

  it('a picture with no action waiting is smoothness only, never a delay', () => {
    const { meter } = setup();
    meter.feelReset();
    for (let i = 0; i <= 20; i++) meter.feelPainted(i * 62.5);
    expect(meter.feelSummary()).toMatchObject({ answered: 0, picturesPerSecond: 16, longestGapMs: 63 });
  });

  it('a still screen with a ticking clock gives no smoothness figure', () => {
    const { meter } = setup();
    meter.feelReset();
    for (let i = 0; i <= 20; i++) meter.feelPainted(i * 1_000);
    expect(meter.feelSummary()).toMatchObject({ picturesPerSecond: null, longestGapMs: null });
  });

  it('gives no smoothness figure from too few gaps', () => {
    const { meter } = setup();
    meter.feelReset();
    for (let i = 0; i < 10; i++) meter.feelPainted(i * 50); // nine gaps
    expect(meter.feelSummary().picturesPerSecond).toBeNull();
    meter.feelPainted(500);
    expect(meter.feelSummary().picturesPerSecond).toBe(20);
  });

  it('says it is still measuring until five actions are answered, then gives the reading', () => {
    const { meter } = setup();
    meter.feelReset();
    expect(meter.feelText()).toMatch(/^Measuring speed/);
    for (let i = 0; i < 4; i++) { meter.feelInput('click', i * 1_000); meter.feelPainted(i * 1_000 + 70); }
    expect(meter.feelText()).toMatch(/^Measuring speed/);
    meter.feelInput('click', 4_000);
    meter.feelPainted(4_070);
    expect(meter.feelText()).toBe('Delay 70 ms typical, 70 ms at worst');
    for (let i = 0; i <= 10; i++) meter.feelPainted(5_000 + i * 100);
    expect(meter.feelText()).toBe('Delay 70 ms typical, 70 ms at worst · 10 pictures a second while it changes');
  });

  it('says one picture, not one pictures', () => {
    const { meter } = setup();
    expect(meter.feelText({ actions: 5, answered: 5, unanswered: 0, typicalDelayMs: 70, worstDelayMs: 90,
      picturesPerSecond: 1, longestGapMs: 400 })).toBe('Delay 70 ms typical, 90 ms at worst · 1 picture a second while it changes');
  });

  it('a new connection forgets an action sent on the old one', () => {
    const { meter } = setup();
    meter.feelReset();
    meter.feelInput('click', 0);
    meter.feelForgetPending();
    meter.feelPainted(100);
    expect(meter.feelSummary()).toMatchObject({ actions: 1, answered: 0 });
  });

  it('times presses sent to the remote machine, not releases', async () => {
    const { meter } = setup();
    meter.feelReset();
    await meter.send({ kind: 'buttonDown', button: 'left' });
    await meter.send({ kind: 'buttonUp', button: 'left' });
    await meter.send({ kind: 'keyUp', key: 'a' });
    expect(meter.feelSummary().actions).toBe(1);
    expect(meter.sent).toHaveLength(3);
  });

  it('a modifier press is not timed, the key it modifies is', async () => {
    const { meter } = setup();
    meter.feelReset();
    for (const key of ['Meta', 'Shift', 'Control', 'Alt']) await meter.send({ kind: 'keyDown', key });
    expect(meter.feelSummary().actions).toBe(0);
    await meter.send({ kind: 'keyDown', key: 'c' });
    expect(meter.feelSummary().actions).toBe(1);
  });

  it('an input the viewer refuses is not timed', async () => {
    const { meter } = setup();
    meter.feelReset();
    meter.setScreenSwitch(Date.now());
    expect(await meter.send({ kind: 'click', button: 'left' })).toBe(false);
    meter.setScreenSwitch(null);
    meter.setLockedState('locked-in-session');
    expect(await meter.send({ kind: 'keyDown', key: 'a' })).toBe(true); // swallowed at the lock
    expect(meter.feelSummary().actions).toBe(0);
    expect(meter.sent).toHaveLength(0);
  });

  it('a JPEG picture counts once decoded, and not if a newer stream replaced it', async () => {
    const { meter } = setup();
    meter.feelReset();
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    let finish: () => void = () => {};
    const image = { decode: () => new Promise<void>(resolve => { finish = resolve; }) };
    meter.feelInput('click');
    meter.feelOnDecoded(image, meter.epoch());
    await settle();
    expect(meter.feelSummary().answered).toBe(0); // not yet decoded
    finish();
    await settle();
    expect(meter.feelSummary().answered).toBe(1);
    meter.feelInput('click', performance.now() + 1_000);
    meter.feelOnDecoded(image, meter.epoch());
    meter.bumpEpoch();
    finish();
    await settle();
    expect(meter.feelSummary().answered).toBe(1);
  });

  it('a rejected decode or a browser without decode counts nothing', async () => {
    const { meter } = setup();
    meter.feelReset();
    meter.feelInput('click');
    meter.feelOnDecoded({ decode: () => Promise.reject(new Error('src changed')) }, meter.epoch());
    meter.feelOnDecoded({}, meter.epoch());
    meter.feelOnDecoded(null, meter.epoch());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(meter.feelSummary()).toMatchObject({ answered: 0, actions: 1 });
  });

  it('shows and hides the reading from the Speed button', () => {
    const { meter, window } = setup();
    const readout = window.document.getElementById('speedReadout')!;
    const button = window.document.getElementById('speedButton')!;
    button.dispatchEvent(new window.Event('click'));
    expect(readout.hidden).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(readout.textContent).toMatch(/^Measuring speed/);
    button.dispatchEvent(new window.Event('click'));
    expect(readout.hidden).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('false');
    meter.setShown(false);
  });

  it('a page without the reading still runs', () => {
    const { meter } = setup(false);
    meter.setShown(true);
    expect(() => meter.syncFeelReadout()).not.toThrow();
    meter.setShown(false);
    meter.syncFeelReadout();
  });
});
