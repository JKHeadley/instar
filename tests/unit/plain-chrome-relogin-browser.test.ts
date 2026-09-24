import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PlainChromeReloginBrowser,
  decodeAppleEventResult,
  enableAppleEventJavaScript,
  wrapForAppleEvent,
} from '../../src/core/PlainChromeReloginBrowser.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'plain-chrome unit cleanup' });
});
function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-chrome-')); dirs.push(d); return d; }

/** A seam that evaluates the wrapped page code against a tiny fake page and returns the runner's JSON text. */
function fakePage(globals: Record<string, unknown>) {
  const sent: string[] = [];
  const run = async (_pid: number, code: string) => { sent.push(code); return String(vm.runInNewContext(code, { ...globals })); };
  return { sent, run };
}

describe('PlainChromeReloginBrowser — normal-browser transport', () => {
  it('wraps page code so every result (value, undefined, thrown error) comes back as JSON', () => {
    expect(decodeAppleEventResult<number>(String(vm.runInNewContext(wrapForAppleEvent('1+1'))))).toBe(2);
    expect(decodeAppleEventResult<null>(String(vm.runInNewContext(wrapForAppleEvent('undefined'))))).toBeNull();
    expect(() => decodeAppleEventResult(String(vm.runInNewContext(wrapForAppleEvent('(() => { throw new Error("x") })()')))))
      .toThrow('browser-evaluation-failed');
    expect(() => decodeAppleEventResult('{"__ae":"no-reply"}')).toThrow('plain-browser-apple-event-no-reply');
    expect(() => decodeAppleEventResult('not json')).toThrow('browser-evaluation-failed');
  });

  it('turns on Apple Events JavaScript in the profile, keeps other prefs, and is idempotent', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'Default'));
    fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ browser: { other: 1 }, keep: 'x' }));
    enableAppleEventJavaScript(dir);
    enableAppleEventJavaScript(dir);
    const prefs = JSON.parse(fs.readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8'));
    expect(prefs).toEqual({ browser: { other: 1, allow_javascript_apple_events: true }, keep: 'x' });
    const fresh = tmp();
    enableAppleEventJavaScript(fresh);
    expect(JSON.parse(fs.readFileSync(path.join(fresh, 'Default', 'Preferences'), 'utf8')).browser.allow_javascript_apple_events).toBe(true);
  });

  it('opens through the launcher (never a debugging connection), waits for the document, and reads through Apple Events', async () => {
    const page = fakePage({ document: { readyState: 'complete' } });
    const launched: string[] = [];
    const browser = new PlainChromeReloginBrowser({ userDataDir: tmp(), runAppleEvent: page.run,
      launch: async (_dir, url) => { launched.push(url); return 4242; } });
    await browser.open('https://claude.ai/oauth/authorize?x=1');
    expect(launched).toEqual(['https://claude.ai/oauth/authorize?x=1']);
    expect(page.sent.some((c) => c.includes('document.readyState'))).toBe(true);
    await browser.close();
  });

  it('refuses non-https URLs, a second open, and every passkey or data-clearing operation', async () => {
    const page = fakePage({ document: { readyState: 'complete' } });
    const browser = new PlainChromeReloginBrowser({ userDataDir: tmp(), runAppleEvent: page.run, launch: async () => 1 });
    await expect(browser.open('http://claude.ai/')).rejects.toThrow('relogin-open-url-refused');
    await expect(browser.open('data:text/html,x')).rejects.toThrow('relogin-open-url-refused');
    await browser.open('https://claude.ai/');
    await expect(browser.open('https://claude.ai/')).rejects.toThrow('relogin-browser-already-open');
    await expect(browser.addCredential({} as never)).rejects.toThrow('plain-browser-no-passkey');
    await expect(browser.clearBrowsingData()).rejects.toThrow('plain-browser-no-browsing-data-clear');
    expect(await browser.credentialCount()).toBe(0);
    await browser.close();
  });

  it('fails the launch loudly when the window never produces a document', async () => {
    const browser = new PlainChromeReloginBrowser({ userDataDir: tmp(), operationTimeoutMs: 1_000,
      runAppleEvent: async () => '{"__ae":"no-reply"}', launch: async () => 7 });
    await expect(browser.open('https://claude.ai/')).rejects.toThrow('chrome-launch-timeout');
  });

  it('a click that finds no element throws instead of reporting success', async () => {
    const browser = new PlainChromeReloginBrowser({ userDataDir: tmp(), launch: async () => 9,
      runAppleEvent: async (_pid, code) => code.includes('readyState') && !code.includes('scrollIntoView')
        ? '{"ok":true,"v":"complete"}' : '{"ok":true,"v":false}' });
    await browser.open('https://claude.ai/');
    await expect(browser.clickControl(1, 'Authorize')).rejects.toThrow('browser-element-not-found');
    await browser.close();
  });
});

describe('createReloginBrowser — the wiring the server uses', () => {
  it('uses the normal browser on macOS and the debugging-protocol browser elsewhere', async () => {
    const { createReloginBrowser } = await import('../../src/core/PlainChromeReloginBrowser.js');
    const { ChromeCdpReloginBrowser } = await import('../../src/core/ChromeCdpReloginBrowser.js');
    const mac = createReloginBrowser(tmp(), 'darwin');
    expect(mac).toBeInstanceOf(PlainChromeReloginBrowser);
    const linux = createReloginBrowser(tmp(), 'linux');
    expect(linux).toBeInstanceOf(ChromeCdpReloginBrowser);
    expect(linux).not.toBeInstanceOf(PlainChromeReloginBrowser);
  });
});
