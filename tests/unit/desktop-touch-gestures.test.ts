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
      <div id="surface"></div><img id="screen"><canvas id="videoCanvas" hidden></canvas><div id="localCursor"></div>
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
    expect(actions).toEqual(['scroll', 'scroll']);
    window.document.getElementById('dragButton')!.click();
    expect((window as unknown as { __commands: Array<{ action?: { kind: string } }> }).__commands.at(-1)?.action?.kind)
      .toBe('buttonDown');
    touch(window, surface, 'pointercancel', 3, 100, 70);
    await Promise.resolve();
    await Promise.resolve();
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
    dom.window.close();
  });
});
