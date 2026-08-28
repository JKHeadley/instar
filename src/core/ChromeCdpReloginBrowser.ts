import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import type {
  ReloginBrowserPort,
  ReloginBrowserSnapshot,
} from './AnthropicReloginBrowserDriver.js';

export interface ChromeCdpReloginBrowserOptions {
  userDataDir: string;
  chromePath?: string;
  headless?: boolean;
  launchTimeoutMs?: number;
  operationTimeoutMs?: number;
}

const CHROME_EXECUTABLE_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((candidate): candidate is string => Boolean(candidate));

export function resolveChromeExecutable(): string | null {
  return CHROME_EXECUTABLE_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null;
}

interface CdpResponse { id?: number; result?: Record<string, unknown>; error?: { message?: string } }

/**
 * Narrow Chrome DevTools implementation of ReloginBrowserPort.
 * It returns only a closed page classification; raw DOM, URLs-with-query,
 * input values, and secrets never leave this process boundary.
 */
export class ChromeCdpReloginBrowser implements ReloginBrowserPort {
  private readonly chromePath: string;
  private readonly userDataDir: string;
  private readonly headless: boolean;
  private readonly launchTimeoutMs: number;
  private readonly operationTimeoutMs: number;
  private child: ChildProcess | null = null;
  private socket: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(options: ChromeCdpReloginBrowserOptions) {
    this.chromePath = options.chromePath ?? resolveChromeExecutable()
      ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    this.userDataDir = path.resolve(options.userDataDir);
    this.headless = options.headless ?? false;
    this.launchTimeoutMs = Math.max(1_000, Math.min(30_000, options.launchTimeoutMs ?? 10_000));
    this.operationTimeoutMs = Math.max(1_000, Math.min(30_000, options.operationTimeoutMs ?? 10_000));
  }

  async open(url: string): Promise<void> {
    if (this.socket) throw new Error('relogin-browser-already-open');
    if (!fs.existsSync(this.chromePath)) throw new Error('chrome-not-installed');
    fs.mkdirSync(this.userDataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.userDataDir, 0o700);
    const portFile = path.join(this.userDataDir, 'DevToolsActivePort');
    if (fs.existsSync(portFile)) {
      SafeFsExecutor.safeUnlinkSync(portFile, { operation: 'ChromeCdpReloginBrowser stale DevToolsActivePort cleanup' });
    }
    const args = [
      `--user-data-dir=${this.userDataDir}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--remote-allow-origins=http://127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-component-update',
      'about:blank',
    ];
    if (this.headless) args.unshift('--headless=new');
    this.child = spawn(this.chromePath, args, { stdio: 'ignore' });
    const port = await this.waitForPort(portFile);
    const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT', signal: AbortSignal.timeout(this.operationTimeoutMs),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`chrome-target-create-${response.status}`);
      return response.json() as Promise<{ webSocketDebuggerUrl?: string }>;
    });
    if (!target.webSocketDebuggerUrl) throw new Error('chrome-target-missing-websocket');
    await this.connect(target.webSocketDebuggerUrl);
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.wait(500);
  }

  async snapshot(expectedIdentity: string): Promise<ReloginBrowserSnapshot> {
    return this.evaluate<ReloginBrowserSnapshot>(`(() => {
      const expected = ${JSON.stringify(expectedIdentity)}.trim().toLowerCase();
      const body = (document.body?.innerText || '').toLowerCase();
      const buttons = Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"]'));
      const buttonText = buttons.map((node) => ((node.textContent || node.getAttribute('value') || '')).trim().toLowerCase());
      const has = (pattern) => pattern.test(body);
      const input = (selector) => !!document.querySelector(selector);
      const expectedVisible = expected.length > 0 && Array.from(document.querySelectorAll('[data-email],li,div,[role="link"]'))
        .some((node) => ((node.getAttribute('data-email') || node.textContent || '')).trim().toLowerCase().includes(expected));
      const url = new URL(location.href);
      const requestedScopes = (url.searchParams.get('scope') || '').split(/[ ,]+/).filter(Boolean).slice(0, 20);
      let pageClass = 'unknown';
      if (has(/captcha|recaptcha|prove you(?:'|’)re not a robot|unusual traffic/)) pageClass = 'captcha';
      else if (has(/check your phone|phone verification|text message|send a code to your phone/)) pageClass = 'phone-confirmation';
      else if (input('input[autocomplete="one-time-code"],input[name*="totp" i],input[id*="totp" i]') || has(/authenticator (?:app|code)|verification code/)) pageClass = 'totp';
      else if (input('input[type="password"]')) pageClass = 'password';
      else if (input('input[type="email"],input[autocomplete="username"]')) pageClass = 'email';
      else if (expectedVisible && has(/choose an account|select an account|continue as/)) pageClass = 'account-chooser';
      else if (buttonText.some((text) => /^(allow|authorize|approve|continue)$/.test(text)) && has(/permission|access|authorize|allow/)) pageClass = 'authorize';
      else if (Array.from(document.querySelectorAll('code,pre,[data-testid*="code" i]')).some((node) => /^\S{8,512}$/.test((node.textContent || '').trim())) || has(/copy.*code|paste.*code|authorization code/)) pageClass = 'paste-code';
      else if (has(/authorization (?:complete|successful)|you (?:may|can) close this (?:window|tab)|successfully signed in/)) pageClass = 'success';
      return { origin: location.origin, pageClass, expectedAccountVisible: expectedVisible,
        hasNext: buttonText.some((text) => /^(next|continue)$/.test(text)),
        hasAuthorize: buttonText.some((text) => /^(allow|authorize|approve|continue)$/.test(text)),
        requestedScopes };
    })()`);
  }

  async chooseExpectedAccount(expectedIdentity: string): Promise<void> {
    await this.evaluate<boolean>(`(() => {
      const expected = ${JSON.stringify(expectedIdentity)}.trim().toLowerCase();
      const nodes = Array.from(document.querySelectorAll('[data-email],li,div,[role="link"]'));
      const exact = nodes.find((node) => (node.getAttribute('data-email') || '').trim().toLowerCase() === expected);
      const visible = exact || nodes.find((node) => (node.textContent || '').trim().toLowerCase().includes(expected));
      if (!(visible instanceof HTMLElement)) return false;
      visible.click(); return true;
    })()`, true);
  }

  async fillPublic(field: 'email', value: string): Promise<void> {
    await this.fill(field === 'email' ? 'input[type="email"],input[autocomplete="username"]' : '', value);
  }

  async fillSecret(field: 'password' | 'totp', value: string): Promise<void> {
    const selector = field === 'password'
      ? 'input[type="password"]'
      : 'input[autocomplete="one-time-code"],input[name*="totp" i],input[id*="totp" i],input[type="tel"]';
    await this.fill(selector, value);
  }

  async click(action: 'next' | 'authorize'): Promise<void> {
    const pattern = action === 'next' ? '^(next|continue)$' : '^(allow|authorize|approve|continue)$';
    await this.evaluate<boolean>(`(() => {
      const re = new RegExp(${JSON.stringify(pattern)}, 'i');
      const nodes = Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"]'));
      const node = nodes.find((entry) => re.test(((entry.textContent || entry.getAttribute('value') || '')).trim()));
      if (!(node instanceof HTMLElement)) return false;
      node.click(); return true;
    })()`, true);
    await this.wait(500);
  }

  async readPasteCode(): Promise<string | null> {
    return this.evaluate<string | null>(`(() => {
      const candidates = Array.from(document.querySelectorAll('code,pre,[data-testid*="code" i]'))
        .map((node) => (node.textContent || '').trim()).filter((value) => /^\S{8,512}$/.test(value));
      return candidates[0] || null;
    })()`);
  }

  async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(5_000, ms))));
  }

  async close(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      try { await this.send('Browser.close'); } catch { /* @silent-fallback-ok — process may already be gone; local socket/process teardown continues below */ }
    }
    this.socket?.close();
    this.socket = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer); entry.reject(new Error('relogin-browser-closed'));
    }
    this.pending.clear();
    if (this.child && this.child.exitCode === null) this.child.kill('SIGTERM');
    this.child = null;
  }

  private async fill(selector: string, value: string): Promise<void> {
    const expression = `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!(node instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(node, ${JSON.stringify(value)});
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`;
    await this.evaluate<boolean>(expression, true);
  }

  private async evaluate<T>(expression: string, requireTruthy = false): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const remote = result.result as { value?: T; exceptionDetails?: unknown } | undefined;
    if (!remote || remote.exceptionDetails) throw new Error('browser-evaluation-failed');
    if (requireTruthy && !remote.value) throw new Error('browser-element-not-found');
    return remote.value as T;
  }

  private async waitForPort(file: string): Promise<number> {
    const deadline = Date.now() + this.launchTimeoutMs;
    while (Date.now() < deadline) {
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) throw new Error('chrome-launch-exited');
      try {
        const port = Number(fs.readFileSync(file, 'utf8').split(/\r?\n/)[0]);
        if (Number.isInteger(port) && port > 0 && port < 65_536) return port;
      } catch { /* not ready */ }
      await this.wait(100);
    }
    throw new Error('chrome-launch-timeout');
  }

  private async connect(url: string): Promise<void> {
    const socket = new WebSocket(url, { origin: 'http://127.0.0.1' });
    this.socket = socket;
    socket.on('message', (raw) => {
      let message: CdpResponse;
      try { message = JSON.parse(raw.toString()) as CdpResponse; } catch { return; }
      if (message.id === undefined) return;
      const entry = this.pending.get(message.id); if (!entry) return;
      this.pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message ?? 'cdp-error'));
      else entry.resolve(message.result ?? {});
    });
    socket.on('close', () => {
      for (const [id, entry] of this.pending) {
        this.pending.delete(id); clearTimeout(entry.timer); entry.reject(new Error('cdp-closed'));
      }
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cdp-connect-timeout')), this.operationTimeoutMs);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('cdp-not-connected'));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`cdp-timeout:${method}`)); }, this.operationTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const entry = this.pending.get(id); if (!entry) return;
        this.pending.delete(id); clearTimeout(entry.timer); reject(error);
      });
    });
  }
}
