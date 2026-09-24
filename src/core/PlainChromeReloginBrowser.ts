/**
 * PlainChromeReloginBrowser — the sign-in repair browser as a NORMAL Chrome.
 *
 * Operator rule (2026-09-24): auth-sensitive sign-ins run in a normal browser, never an
 * automated one. Under a debugging connection Claude's Authorize stalled behind a human
 * check and Cloudflare holds never cleared; the same profile opened the ordinary way went
 * straight through.
 *
 * So this Chrome is launched exactly as a person would open it (LaunchServices, `open -na`),
 * with NO remote-debugging port or pipe, and is read and acted on through Chrome's own
 * AppleScript "execute javascript" command, addressed to this instance by process id. All
 * page logic (snapshot classes, control enumeration, fills, identity reads) and every floor
 * in the driver are inherited unchanged from {@link ChromeCdpReloginBrowser}; only the
 * transport differs. macOS only. Passkey mode (a virtual authenticator) needs the debugging
 * protocol and is refused here.
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ChromeCdpReloginBrowser, type ChromeCdpReloginBrowserOptions, type WebAuthnCredential } from './ChromeCdpReloginBrowser.js';

/** The JXA runner: pid in argv, page JavaScript on stdin, JSON text out. The code never touches the command line. */
const APPLE_EVENT_RUNNER = `
ObjC.import('Foundation');
function fcc(s){ return (s.charCodeAt(0)<<24)|(s.charCodeAt(1)<<16)|(s.charCodeAt(2)<<8)|s.charCodeAt(3); }
function run(argv){
  const pid = parseInt(argv[0], 10); const timeout = parseInt(argv[1], 10);
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const code = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  const D = $.NSAppleEventDescriptor;
  const ev = D.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(fcc('CrSu'), fcc('ExJa'), D.descriptorWithProcessIdentifier(pid), -1, 0);
  function spec(want, form, seld, from){
    const r = D.recordDescriptor;
    r.setDescriptorForKeyword(D.descriptorWithTypeCode(fcc(want)), fcc('want'));
    r.setDescriptorForKeyword(from || D.nullDescriptor, fcc('from'));
    r.setDescriptorForKeyword(D.descriptorWithEnumCode(fcc(form)), fcc('form'));
    r.setDescriptorForKeyword(seld, fcc('seld'));
    return r.coerceToDescriptorType(fcc('obj '));
  }
  const tab = spec('prop', 'prop', D.descriptorWithTypeCode(fcc('acTa')), spec('cwin', 'indx', D.descriptorWithInt32(1), null));
  ev.setParamDescriptorForKeyword(tab, fcc('----'));
  ev.setParamDescriptorForKeyword(D.descriptorWithString(code), fcc('JvSc'));
  const reply = ev.sendEventWithOptionsTimeoutError(0x3, timeout, null);
  if (!reply || reply.isNil()) return '{"__ae":"no-reply"}';
  const errn = reply.paramDescriptorForKeyword(fcc('errn'));
  if (errn && !errn.isNil()) return JSON.stringify({ __ae: 'error-' + errn.int32Value });
  const out = reply.paramDescriptorForKeyword(fcc('----'));
  return out && !out.isNil() && out.stringValue ? out.stringValue.js : '{"__ae":"no-result"}';
}`;

/** Wrap a page expression so the Apple Event always returns JSON text (values, null, or a thrown error). */
export function wrapForAppleEvent(expression: string): string {
  return `(function(){try{var v=(${expression});return JSON.stringify({ok:true,v:v===undefined?null:v});}`
    + `catch(e){return JSON.stringify({ok:false});}})()`;
}

/** Decode the runner's JSON text. Transport failures and page exceptions both throw. */
export function decodeAppleEventResult<T>(raw: string): T {
  let parsed: { ok?: boolean; v?: T; __ae?: string };
  try { parsed = JSON.parse(raw.trim()); } catch { throw new Error('browser-evaluation-failed'); }
  if (parsed.__ae) throw new Error(`plain-browser-apple-event-${parsed.__ae}`);
  if (parsed.ok !== true) throw new Error('browser-evaluation-failed');
  return parsed.v as T;
}

/** Turn on "Allow JavaScript from Apple Events" in the profile before launch (a per-profile pref). */
export function enableAppleEventJavaScript(userDataDir: string): void {
  const file = path.join(userDataDir, 'Default', 'Preferences');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let prefs: Record<string, unknown> = {};
  try { prefs = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; }
  catch { /* @silent-fallback-ok — a fresh profile has no Preferences yet; Chrome merges its defaults at launch */ }
  const browser = (prefs.browser && typeof prefs.browser === 'object' ? prefs.browser : {}) as Record<string, unknown>;
  if (browser.allow_javascript_apple_events === true) return;
  browser.allow_javascript_apple_events = true;
  prefs.browser = browser;
  fs.writeFileSync(file, JSON.stringify(prefs), { mode: 0o600 });
}

export interface PlainChromeReloginBrowserOptions extends Omit<ChromeCdpReloginBrowserOptions, 'passkeyMode' | 'headless'> {
  /** Test seam: run the JXA runner. Production runs `osascript -l JavaScript`. */
  runAppleEvent?: (pid: number, code: string, timeoutSec: number) => Promise<string>;
  /** Test seam: launch Chrome and return its main process id. Production uses `open -na` and reads the process table. */
  launch?: (userDataDir: string, url: string) => Promise<number>;
  /** Tests only: also accept `data:` URLs (production accepts https only; the driver pins origins). */
  allowFixtureUrls?: boolean;
}

export class PlainChromeReloginBrowser extends ChromeCdpReloginBrowser {
  private pid: number | null = null;
  /** True when a test seam replaced the launcher: no real process to signal, any platform. */
  private readonly seamed: boolean;
  private readonly allowFixtureUrls: boolean;
  private readonly runAppleEvent: (pid: number, code: string, timeoutSec: number) => Promise<string>;
  private readonly launchChrome: (userDataDir: string, url: string) => Promise<number>;

  constructor(options: PlainChromeReloginBrowserOptions) {
    super({ ...options, passkeyMode: false, headless: false });
    this.seamed = options.launch !== undefined;
    this.allowFixtureUrls = options.allowFixtureUrls === true;
    this.runAppleEvent = options.runAppleEvent ?? runOsascript;
    this.launchChrome = options.launch ?? ((dir, url) => launchWithLaunchServices(dir, url, this.chromePath, this.operationTimeoutMs));
  }

  override async open(url: string): Promise<void> {
    if (this.pid !== null) throw new Error('relogin-browser-already-open');
    if (process.platform !== 'darwin' && !this.seamed) throw new Error('plain-browser-macos-only');
    const target = new URL(url);
    if (target.protocol !== 'https:' && !(this.allowFixtureUrls && target.protocol === 'data:')) throw new Error('relogin-open-url-refused');
    fs.mkdirSync(this.userDataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.userDataDir, 0o700);
    enableAppleEventJavaScript(this.userDataDir);
    this.pid = await this.launchChrome(this.userDataDir, target.toString());
    // Chrome answers once its window has a document; poll until it does (or the launch budget ends).
    const deadline = Date.now() + this.operationTimeoutMs;
    for (;;) {
      try {
        const state = await this.evaluate<string>('document.readyState');
        if (state === 'interactive' || state === 'complete') return;
      } catch { /* @silent-fallback-ok — the window is still coming up; retried until the deadline below */ }
      if (Date.now() > deadline) { await this.close(); throw new Error('chrome-launch-timeout'); }
      await this.wait(250);
    }
  }

  /** Already a normal browser: there is nothing to warm up. */
  override async warmUpPlain(_url: string, _ms: number): Promise<void> { /* no-op by design */ }

  protected override async evaluate<T>(expression: string, requireTruthy = false): Promise<T> {
    if (this.pid === null) throw new Error('relogin-browser-not-open');
    const timeoutSec = Math.max(1, Math.round(this.operationTimeoutMs / 1000));
    const value = decodeAppleEventResult<T>(await this.runAppleEvent(this.pid, wrapForAppleEvent(expression), timeoutSec));
    if (requireTruthy && !value) throw new Error('browser-element-not-found');
    return value;
  }

  /**
   * Click inside the page: pointer movement, press, release, then the element's own click.
   * A normal browser has no input-injection channel, and the provider pages measured on
   * 2026-09-24 (Claude Authorize) accept this.
   */
  protected override async clickReal(finderExpression: string): Promise<void> {
    const clicked = await this.evaluate<boolean>(`(() => {
      const el = (${finderExpression});
      if (!(el instanceof HTMLElement)) return false;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const o = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, view: window, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      for (const t of ['pointerover', 'pointerenter', 'mouseover', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o));
      }
      el.click();
      return true;
    })()`);
    if (!clicked) throw new Error('browser-element-not-found');
  }

  /**
   * Claude's Authorize button stayed disabled in a normal Chrome until the page saw pointer
   * activity (measured 2026-09-24). A person's mouse provides that; here the page is read
   * without one, so a short pointer movement over the document precedes every read.
   */
  private async pointerActivity(): Promise<void> {
    try {
      await this.evaluate<boolean>(`(() => {
        for (let i = 0; i < 12; i++) {
          const o = { clientX: 180 + i * 14, clientY: 260 + i * 9, bubbles: true, view: window, pointerId: 1, pointerType: 'mouse', isPrimary: true };
          document.dispatchEvent(new PointerEvent('pointermove', o));
          document.dispatchEvent(new MouseEvent('mousemove', o));
        }
        return true;
      })()`);
    } catch { /* @silent-fallback-ok — a page mid-navigation; the read that follows reports the real state */ }
  }

  override async snapshot(expectedIdentity: string): ReturnType<ChromeCdpReloginBrowser['snapshot']> {
    await this.pointerActivity();
    return super.snapshot(expectedIdentity);
  }

  override async observeControls(): ReturnType<ChromeCdpReloginBrowser['observeControls']> {
    await this.pointerActivity();
    return super.observeControls();
  }

  /** The front window's active tab IS the newest page (a provider popup opens in front). */
  protected override async followNewestPage(): Promise<void> { /* the Apple Event already addresses it */ }
  protected override async followMainPage(): Promise<void> { /* the Apple Event already addresses it */ }

  override async navigateTo(url: string): Promise<void> {
    const target = new URL(url);
    if (target.protocol !== 'https:') throw new Error('relogin-open-url-refused');
    await this.evaluate<boolean>(`(location.assign(${JSON.stringify(target.toString())}), true)`);
    const deadline = Date.now() + this.operationTimeoutMs;
    for (;;) {
      await this.wait(250);
      try {
        const ready = await this.evaluate<boolean>(`location.href.startsWith(${JSON.stringify(target.origin)}) && document.readyState !== 'loading'`);
        if (ready) return;
      } catch { /* @silent-fallback-ok — mid-navigation the document is being replaced; poll until the deadline */ }
      if (Date.now() > deadline) throw new Error('browser-navigation-timeout');
    }
  }

  override async clearBrowsingData(): Promise<void> { throw new Error('plain-browser-no-browsing-data-clear'); }
  override async addCredential(_credential: WebAuthnCredential): Promise<void> { throw new Error('plain-browser-no-passkey'); }
  override async removeCredential(): Promise<void> { /* no passkey is ever loaded in a plain browser */ }
  override async exportCredentials(): Promise<WebAuthnCredential[]> { return []; }
  override async credentialCountsByTarget(): Promise<number[]> { return []; }
  override async credentialCount(): Promise<number> { return 0; }

  override async close(): Promise<void> {
    const pid = this.pid;
    this.pid = null;
    if (pid === null || this.seamed) return;
    try { process.kill(pid, 'SIGTERM'); } catch { return; /* @silent-fallback-ok — already exited */ }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { return; /* exited */ }
      await this.wait(100);
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* @silent-fallback-ok — exited between the check and the kill */ }
  }
}

function runOsascript(pid: number, code: string, timeoutSec: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', APPLE_EVENT_RUNNER, String(pid), String(timeoutSec)],
      { timeout: (timeoutSec + 5) * 1000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error) { reject(new Error('plain-browser-osascript-failed')); return; }
        resolve(String(stdout));
      });
    child.stdin?.end(code);
  });
}

/** The main (non-helper) Chrome process running this exact profile, or null. */
async function findProfilePid(chromePath: string, userDataDir: string): Promise<number | null> {
  const marker = `--user-data-dir=${userDataDir}`;
  const table = await new Promise<string>((resolve) => execFile('/bin/ps', ['-axww', '-o', 'pid=,args='], { maxBuffer: 16 * 1024 * 1024 },
    (_e, out) => resolve(String(out ?? ''))));
  for (const line of table.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const args = m[2];
    // Exact profile only: the flag is followed by another flag or ends the line (a sibling dir can't match).
    const exact = args.includes(`${marker} --`) || args.endsWith(marker);
    if (exact && !args.includes('--type=') && args.includes(chromePath)) return Number(m[1]);
  }
  return null;
}

/**
 * Open Chrome the ordinary way (LaunchServices). A directly spawned Chrome binary does not
 * answer Apple Events (measured 2026-09-24); one opened through `open -na` does. Returns the
 * main browser process id for this profile. Refuses when the profile is ALREADY open: `open`
 * would hand the URL to that live Chrome (possibly a person finishing a sign-in by hand), and
 * the repair must never drive or close a window it did not start.
 */
async function launchWithLaunchServices(userDataDir: string, url: string, chromePath: string, timeoutMs: number): Promise<number> {
  if (await findProfilePid(chromePath, userDataDir) !== null) throw new Error('relogin-profile-in-use');
  const appPath = chromePath.replace(/\/Contents\/MacOS\/[^/]+$/, '');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/open', ['-na', appPath, '--args', `--user-data-dir=${userDataDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-sync', url], { stdio: 'ignore' });
    child.on('error', () => reject(new Error('chrome-launch-failed')));
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('chrome-launch-failed')));
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await findProfilePid(chromePath, userDataDir);
    if (pid !== null) return pid;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('chrome-launch-timeout');
}

/**
 * The sign-in repair browser for this machine: a NORMAL Chrome on macOS (operator rule
 * 2026-09-24 — auth-sensitive sign-ins never run in an automated browser). Other platforms have
 * no plain-browser transport yet and keep the debugging-protocol browser.
 */
export function createReloginBrowser(userDataDir: string, platform: NodeJS.Platform = process.platform): ChromeCdpReloginBrowser {
  return platform === 'darwin'
    ? new PlainChromeReloginBrowser({ userDataDir })
    : new ChromeCdpReloginBrowser({ userDataDir });
}
