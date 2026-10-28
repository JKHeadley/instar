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
      <div id="surface"></div><img id="screen"><div id="localCursor"></div>
      <button id="modeButton"></button><button id="dragButton"></button><button id="rightButton"></button>
      <button id="typeButton"></button><button id="stopButton"></button><input id="typeText">
      <button id="unlockButton"></button><button id="retryButton"></button><button id="requestButton"></button>
      <button data-remote-key="Meta" data-modifier="true" aria-pressed="false"></button>
      <button data-remote-key="c"></button>
      <div id="status"></div><div id="liveStatus"></div><div id="control"></div><div id="request"></div>
    </body>`, { url: 'https://instar.example/dashboard/desktop', runScripts: 'outside-only' });
    const { window } = dom;
    Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: true }) });
    Object.defineProperty(window, 'TextEncoder', { value: TextEncoder });
    const surface = window.document.getElementById('surface')!;
    Object.defineProperty(surface, 'setPointerCapture', { value: () => {} });
    const source = fs.readFileSync(new URL('../../dashboard/desktop.js', import.meta.url), 'utf8');
    (window as unknown as { __commands: unknown[] }).__commands = [];
    window.eval(`${source}\ninputEnabled = true; sendCommand = command => { window.__commands.push(command); return Promise.resolve(true); };`);
    touch(window, surface, 'pointerdown', 1, 40, 40);
    touch(window, surface, 'pointerdown', 2, 100, 40);
    touch(window, surface, 'pointermove', 1, 40, 70);
    touch(window, surface, 'pointermove', 2, 100, 70);
    touch(window, surface, 'pointerup', 1, 40, 70);
    touch(window, surface, 'pointerup', 2, 100, 70);
    const actions = (window as unknown as { __commands: Array<{ action?: { kind: string } }> }).__commands
      .map(command => command.action?.kind);
    expect(actions).toEqual(['scroll', 'scroll']);
    window.document.getElementById('dragButton')!.click();
    expect((window as unknown as { __commands: Array<{ action?: { kind: string } }> }).__commands.at(-1)?.action?.kind)
      .toBe('buttonDown');
    touch(window, surface, 'pointercancel', 3, 100, 70);
    const finalActions = (window as unknown as { __commands: Array<{ action?: { kind: string } }> }).__commands
      .map(command => command.action?.kind);
    expect(finalActions).toEqual(['scroll', 'scroll', 'buttonDown', 'buttonUp']);
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
    expect(commands.slice(beforePhysical).map(command => `${command.action?.kind}:${command.action?.key}`))
      .toEqual(['keyDown:Meta', 'keyDown:c', 'keyUp:c', 'keyUp:Meta']);
    const typeInput = window.document.getElementById('typeText')!;
    typeInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true }));
    expect(commands).toHaveLength(beforePhysical + 4);
    await new Promise(resolve => setTimeout(resolve, 0));
    const beforeFailedKey = commands.length;
    window.eval(`sendCommand = command => { window.__commands.push(command); return Promise.resolve(false); };`);
    window.document.querySelector<HTMLElement>('[data-remote-key="c"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(commands.slice(beforeFailedKey).map(command => command.action?.kind)).toEqual(['keyDown']);
    expect(window.document.getElementById('status')!.textContent).toContain('Connection interrupted');
    window.eval(`inputEnabled = true;`);
    window.eval(`sendCommand = command => Promise.resolve(command.action?.kind !== 'buttonDown');`);
    window.document.getElementById('dragButton')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(window.document.getElementById('dragButton')!.textContent).toBe('Drag');
    window.eval(`sendCommand = command => Promise.resolve(command.action?.kind !== 'buttonUp');`);
    window.document.getElementById('dragButton')!.click();
    await Promise.resolve();
    window.document.getElementById('dragButton')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(window.document.getElementById('dragButton')!.textContent).toBe('Drag');
    expect(window.document.getElementById('status')!.textContent).toContain('Connection interrupted');
    dom.window.close();
  });
});
