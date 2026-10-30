import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

function touch(window: Window, surface: HTMLElement, type: string, pointerId: number, x: number, y: number): void {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({ pointerId, pointerType: 'touch', clientX: x, clientY: y, button: 0 })) {
    Object.defineProperty(event, key, { value });
  }
  surface.dispatchEvent(event);
}

describe('desktop touch gestures', () => {
  it('scrolls with two fingers without clicking and releases a cancelled drag', async () => {
    const dom = new JSDOM(`<!doctype html><body>
      <div id="surface"></div><div id="viewTransform"><img id="screen"><canvas id="videoCanvas" hidden></canvas><div id="localCursor"></div></div>
      <div id="desktopTools" hidden></div><div id="keyboardBar" hidden></div>
      <button id="toolsButton"></button><button id="keyboardButton"></button><button id="hideKeyboardButton"></button>
      <button id="zoomResetButton" hidden></button><button id="fullscreenButton"></button>
      <button id="modeButton"></button><button id="dragButton"></button><button id="rightButton"></button>
      <button id="stopButton"></button><input id="typeText">
      <button id="unlockButton"></button><button id="retryButton"></button><button id="requestButton"></button>
      <button data-remote-key="Meta" data-modifier="true" aria-pressed="false"></button>
      <button data-remote-key="c"></button>
      <div id="status"></div><div id="liveStatus"></div><div id="control"></div><div id="request"></div>
    </body>`, { url: 'https://instar.example/dashboard/desktop', runScripts: 'outside-only' });
    const { window } = dom;
    const visualViewport = new window.EventTarget() as EventTarget & {
      width: number; height: number; offsetTop: number; offsetLeft: number;
    };
    Object.assign(visualViewport, { width: 390, height: 844, offsetTop: 0, offsetLeft: 0 });
    Object.defineProperty(window, 'visualViewport', { value: visualViewport });
    Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: true }) });
    Object.defineProperty(window, 'TextEncoder', { value: TextEncoder });
    const surface = window.document.getElementById('surface')!;
    Object.defineProperty(surface, 'setPointerCapture', { value: () => {} });
    const source = fs.readFileSync(new URL('../../dashboard/desktop.js', import.meta.url), 'utf8');
    (window as unknown as { __commands: unknown[] }).__commands = [];
    window.eval(`${source}\ninputEnabled = true;
      window.__viewer = { setInputEnabled(value) { inputEnabled = value; }, leave,
        setSendCommand(fn) { sendCommand = fn; } };
      sendCommand = command => { window.__commands.push(command); return Promise.resolve(true); };`);
    type Command = { action?: { kind: string; key?: string } };
    const viewer = (window as unknown as { __viewer: {
      setInputEnabled(value: boolean): void;
      leave(message: string): void;
      setSendCommand(fn: (command: Command) => Promise<boolean>): void;
    } }).__viewer;
    touch(window, surface, 'pointerdown', 1, 40, 40);
    touch(window, surface, 'pointerdown', 2, 100, 40);
    touch(window, surface, 'pointermove', 1, 40, 70);
    touch(window, surface, 'pointermove', 2, 100, 70);
    touch(window, surface, 'pointerup', 1, 40, 70);
    touch(window, surface, 'pointerup', 2, 100, 70);
    const actions = (window as unknown as { __commands: Array<{ action?: { kind: string } }> }).__commands
      .map(command => command.action?.kind);
    expect(actions).toEqual(['scroll']);
    window.document.getElementById('dragButton')!.click();
    expect((window as unknown as { __commands: Array<{ action?: { kind: string } }> }).__commands.at(-1)?.action?.kind)
      .toBe('buttonDown');
    touch(window, surface, 'pointercancel', 3, 100, 70);
    await Promise.resolve();
    await Promise.resolve();
    const finalActions = (window as unknown as { __commands: Array<{ action?: { kind: string } }> }).__commands
      .map(command => command.action?.kind);
    expect(finalActions).toEqual(['scroll', 'buttonDown', 'buttonUp']);
    const wheelFrames: FrameRequestCallback[] = [];
    Object.defineProperty(window, 'requestAnimationFrame', {
      value: (callback: FrameRequestCallback) => { wheelFrames.push(callback); return wheelFrames.length; },
    });
    const firstWheel = new window.WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaX: 2, deltaY: 10,
    });
    const secondWheel = new window.WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaX: 1, deltaY: 2, deltaMode: 1,
    });
    surface.dispatchEvent(firstWheel);
    surface.dispatchEvent(secondWheel);
    expect(firstWheel.defaultPrevented).toBe(true);
    expect(secondWheel.defaultPrevented).toBe(true);
    expect(wheelFrames).toHaveLength(1);
    expect((window as unknown as { __commands: Array<{ action?: { kind: string } }> }).__commands
      .map(command => command.action?.kind)).toEqual(['scroll', 'buttonDown', 'buttonUp']);
    wheelFrames[0](0);
    expect((window as unknown as { __commands: Array<{ action?: { kind: string; dx?: number; dy?: number } }> }).__commands.at(-1)?.action)
      .toEqual({ kind: 'scroll', dx: 18, dy: 42 });
    const pinchWheel = new window.WheelEvent('wheel', {
      bubbles: true, cancelable: true, ctrlKey: true, deltaY: 5,
    });
    surface.dispatchEvent(pinchWheel);
    expect(pinchWheel.defaultPrevented).toBe(false);
    expect(wheelFrames).toHaveLength(1);
    await Promise.resolve();
    window.document.querySelector<HTMLElement>('[data-remote-key="Meta"]')!.click();
    window.document.querySelector<HTMLElement>('[data-remote-key="c"]')!.click();
    window.document.querySelector<HTMLElement>('[data-remote-key="Meta"]')!.click();
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((window as unknown as { __commands: Array<{ action?: { kind: string; key?: string } }> }).__commands
      .slice(-4).map(command => `${command.action?.kind}:${command.action?.key}`))
      .toEqual(['keyDown:Meta', 'keyDown:c', 'keyUp:c', 'keyUp:Meta']);
    const commands = (window as unknown as { __commands: Array<{ action?: { kind: string; key?: string } }> }).__commands;
    const beforePhysical = commands.length;
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Meta', bubbles: true, cancelable: true }));
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true }));
    window.document.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'c', bubbles: true, cancelable: true }));
    window.document.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Meta', bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(commands.slice(beforePhysical).map(command => `${command.action?.kind}:${command.action?.key}`))
      .toEqual(['keyDown:Meta', 'keyDown:c', 'keyUp:c', 'keyUp:Meta']);
    const typeInput = window.document.getElementById('typeText')!;
    typeInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true }));
    expect(commands).toHaveLength(beforePhysical + 4);
    await new Promise(resolve => setTimeout(resolve, 0));
    const beforeFailedKey = commands.length;
    viewer.setSendCommand(command => { commands.push(command); return Promise.resolve(false); });
    window.document.querySelector<HTMLElement>('[data-remote-key="c"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(commands.slice(beforeFailedKey).map(command => command.action?.kind)).toEqual(['keyDown']);
    expect(window.document.getElementById('status')!.textContent).toContain('Connection interrupted');
    viewer.setInputEnabled(true);
    viewer.setSendCommand(command => Promise.resolve(command.action?.kind !== 'buttonDown'));
    window.document.getElementById('dragButton')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(window.document.getElementById('dragButton')!.textContent).toBe('Drag');
    viewer.setInputEnabled(true);
    viewer.setSendCommand(command => Promise.resolve(command.action?.kind !== 'buttonUp'));
    window.document.getElementById('dragButton')!.click();
    await Promise.resolve();
    window.document.getElementById('dragButton')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(window.document.getElementById('dragButton')!.textContent).toBe('Drag');
    expect(window.document.getElementById('status')!.textContent).toContain('Connection interrupted');
    viewer.leave('Reset old stream.');
    viewer.setInputEnabled(true);
    let resolveOld!: (value: boolean) => void;
    viewer.setSendCommand(() => new Promise(resolve => { resolveOld = resolve; }));
    window.document.getElementById('dragButton')!.click();
    expect(typeof resolveOld).toBe('function');
    viewer.leave('Old stream ended.');
    viewer.setInputEnabled(true);
    viewer.setSendCommand(() => Promise.resolve(true));
    window.document.getElementById('dragButton')!.click();
    await Promise.resolve();
    resolveOld(false);
    await Promise.resolve();
    expect(window.document.getElementById('dragButton')!.textContent).toBe('Release');
    expect(window.document.getElementById('status')!.textContent).toBe('Old stream ended.');
    touch(window, surface, 'pointercancel', 4, 100, 70);
    await Promise.resolve();
    viewer.setInputEnabled(true);
    let resolveOldKey!: (value: boolean) => void;
    viewer.setSendCommand(() => new Promise(resolve => { resolveOldKey = resolve; }));
    const meta = window.document.querySelector<HTMLElement>('[data-remote-key="Meta"]')!;
    meta.click();
    viewer.leave('Old key stream ended.');
    viewer.setInputEnabled(true);
    viewer.setSendCommand(() => Promise.resolve(true));
    meta.click();
    await Promise.resolve();
    resolveOldKey(false);
    await Promise.resolve();
    expect(meta.getAttribute('aria-pressed')).toBe('true');
    expect(window.document.getElementById('status')!.textContent).toBe('Old key stream ended.');
    meta.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    viewer.leave('Quick release test.');
    viewer.setInputEnabled(true);
    const quickActions: string[] = [];
    let resolveDown!: (value: boolean) => void;
    viewer.setSendCommand(command => {
      const kind = command.action?.kind ?? '';
      quickActions.push(kind);
      return kind === 'buttonDown' ? new Promise(resolve => { resolveDown = resolve; }) : Promise.resolve(true);
    });
    window.document.getElementById('dragButton')!.click();
    window.document.getElementById('dragButton')!.click();
    expect(quickActions).toEqual(['buttonDown']);
    resolveDown(false);
    await Promise.resolve();
    expect(quickActions).toEqual(['buttonDown']);
    viewer.leave('Retry quick release.');
    viewer.setInputEnabled(true);
    quickActions.length = 0;
    viewer.setSendCommand(command => {
      const kind = command.action?.kind ?? '';
      quickActions.push(kind);
      return kind === 'buttonDown' ? new Promise(resolve => { resolveDown = resolve; }) : Promise.resolve(true);
    });
    window.document.getElementById('dragButton')!.click();
    window.document.getElementById('dragButton')!.click();
    expect(quickActions).toEqual(['buttonDown']);
    resolveDown(true);
    await Promise.resolve();
    expect(quickActions).toEqual(['buttonDown', 'buttonUp']);
    viewer.leave('Quick key release.');
    viewer.setInputEnabled(true);
    quickActions.length = 0;
    viewer.setSendCommand(command => {
      const kind = command.action?.kind ?? '';
      quickActions.push(kind);
      return kind === 'keyDown' ? new Promise(resolve => { resolveDown = resolve; }) : Promise.resolve(true);
    });
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    window.document.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'c', bubbles: true }));
    expect(quickActions).toEqual(['keyDown']);
    resolveDown(true);
    await Promise.resolve();
    expect(quickActions).toEqual(['keyDown', 'keyUp']);
    await new Promise(resolve => setTimeout(resolve, 0));
    viewer.leave('Finished quick release test.');
    viewer.setInputEnabled(true);
    const gestureActions: Array<{ kind: string; text?: string; key?: string }> = [];
    viewer.setSendCommand(command => {
      if (command.action) gestureActions.push(command.action as { kind: string; text?: string; key?: string });
      return Promise.resolve(true);
    });
    Object.defineProperty(surface, 'getBoundingClientRect', { value: () => ({
      left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300,
    }) });
    touch(window, surface, 'pointerdown', 5, 120, 150);
    touch(window, surface, 'pointerdown', 6, 280, 150);
    touch(window, surface, 'pointermove', 5, 90, 150);
    touch(window, surface, 'pointermove', 6, 310, 150);
    expect(window.document.getElementById('viewTransform')!.getAttribute('style')).toContain('scale(1.375)');
    expect(window.document.getElementById('zoomResetButton')!.hidden).toBe(false);
    expect(gestureActions).toEqual([]);
    touch(window, surface, 'pointerup', 5, 90, 150);
    touch(window, surface, 'pointerup', 6, 310, 150);
    window.document.getElementById('zoomResetButton')!.click();
    expect(window.document.getElementById('viewTransform')!.getAttribute('style')).toContain('scale(1)');
    touch(window, surface, 'pointerdown', 7, 120, 150);
    touch(window, surface, 'pointerdown', 8, 280, 150);
    touch(window, surface, 'pointermove', 7, 80, 150);
    expect(window.document.getElementById('viewTransform')!.getAttribute('style')).toContain('scale(1.25)');
    touch(window, surface, 'pointerup', 7, 80, 150);
    touch(window, surface, 'pointerup', 8, 280, 150);
    window.document.getElementById('zoomResetButton')!.click();
    const keyboard = window.document.getElementById('keyboardButton')!;
    keyboard.click();
    expect(window.document.activeElement).toBe(typeInput);
    expect(window.document.getElementById('keyboardBar')!.hidden).toBe(false);
    (typeInput as HTMLInputElement).value = 'hello';
    typeInput.dispatchEvent(new window.InputEvent('input', { bubbles: true, data: 'hello' }));
    expect(gestureActions.at(-1)).toEqual({ kind: 'type', text: 'hello' });
    expect((typeInput as HTMLInputElement).value).toBe('');
    const beforeComposition = gestureActions.length;
    typeInput.dispatchEvent(new window.Event('compositionstart', { bubbles: true }));
    (typeInput as HTMLInputElement).value = 'あ';
    typeInput.dispatchEvent(new window.InputEvent('input', { bubbles: true, data: 'あ', isComposing: true }));
    typeInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    typeInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    expect(gestureActions).toHaveLength(beforeComposition);
    typeInput.dispatchEvent(new window.Event('compositionend', { bubbles: true }));
    expect(gestureActions.at(-1)).toEqual({ kind: 'type', text: 'あ' });
    (typeInput as HTMLInputElement).value = 'あ';
    typeInput.dispatchEvent(new window.InputEvent('input', { bubbles: true, data: 'あ' }));
    expect(gestureActions.at(-1)).toEqual({ kind: 'type', text: 'あ' });
    expect((typeInput as HTMLInputElement).value).toBe('');
    typeInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(gestureActions.at(-1)).toEqual({ kind: 'type', text: 'あ' });
    await new Promise(resolve => setTimeout(resolve, 0));
    typeInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(gestureActions.slice(-2).map(action => `${action.kind}:${action.key ?? action.text}`))
      .toEqual(['keyDown:Enter', 'keyUp:Enter']);
    window.document.body.classList.add('desktop-live');
    visualViewport.height = 430;
    visualViewport.offsetTop = 36;
    visualViewport.offsetLeft = 4;
    visualViewport.dispatchEvent(new window.Event('resize'));
    const control = window.document.getElementById('control')!;
    expect(control.style.getPropertyValue('--desktop-visible-height')).toBe('430px');
    expect(control.style.getPropertyValue('--desktop-visible-top')).toBe('36px');
    expect(control.style.getPropertyValue('--desktop-visible-left')).toBe('4px');
    visualViewport.offsetTop = 64;
    visualViewport.dispatchEvent(new window.Event('scroll'));
    expect(control.style.getPropertyValue('--desktop-visible-top')).toBe('64px');
    visualViewport.height = 844;
    visualViewport.offsetTop = 0;
    visualViewport.dispatchEvent(new window.Event('resize'));
    expect(control.style.getPropertyValue('--desktop-visible-height')).toBe('844px');
    viewer.leave('Viewer closed.');
    expect(window.document.getElementById('keyboardBar')!.hidden).toBe(true);
    expect(window.document.getElementById('zoomResetButton')!.hidden).toBe(true);
    expect(control.style.getPropertyValue('--desktop-visible-height')).toBe('');
    dom.window.close();
  });
});
