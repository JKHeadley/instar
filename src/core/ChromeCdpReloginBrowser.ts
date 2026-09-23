import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { WebSocket } from 'ws';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import type {
  ReloginBrowserClick,
  ReloginBrowserPort,
  ReloginBrowserSnapshot,
} from './AnthropicReloginBrowserDriver.js';
import { classifyGooglePasskeyPage } from './GooglePasskeyPageClasses.js';
import {
  GOOGLE_ORIGIN_POLICY,
  PASSKEY_SESSION_CHROME_ARGS,
  isGoogleOrigin,
  isRpFamilyOrigin,
  mayAddCredential,
  mustRemoveCredentialBefore,
  type OriginPolicy,
} from './PasskeyBrowserPolicy.js';

export interface ChromeCdpReloginBrowserOptions {
  userDataDir: string;
  chromePath?: string;
  headless?: boolean;
  launchTimeoutMs?: number;
  operationTimeoutMs?: number;
  /**
   * Passkey mode (spec agent-held-google-passkey §3.5): CDP over the debugging
   * PIPE (no TCP port, no DevToolsActivePort), extensions and prerendering off,
   * every target created at about:blank and given a virtual authenticator BEFORE
   * its first navigation, popups auto-attached and paused until prepared,
   * service workers bypassed, and request-time credential removal.
   */
  passkeyMode?: boolean;
  /** Where the credential may be present. Production: the Google policy (default). */
  originPolicy?: OriginPolicy;
}

/** Closed structural floor for OpenAI's device confirmation; consent prose can never enter this class. */
export function isClosedOpenAiDeviceApproval(input: {
  origin: string; pathname: string; hasAuthorize: boolean; body: string;
}): boolean {
  return input.origin === 'https://auth.openai.com'
    && /^\/(?:codex\/)?device(?:\/|$)/.test(input.pathname)
    && input.hasAuthorize
    && /codex/.test(input.body)
    && /device|verification code/.test(input.body)
    && !/permission|access|scope|consent|grant|billing|organization/.test(input.body);
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

/** An exported WebAuthn credential, in the shape CDP's WebAuthn domain uses. */
export interface WebAuthnCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

/** The two CDP transports share one interface: text in, text out. */
interface CdpTransport {
  send(text: string): void;
  onMessage(cb: (raw: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
  readonly open: boolean;
}

class WsTransport implements CdpTransport {
  constructor(private readonly socket: WebSocket) {}
  get open(): boolean { return this.socket.readyState === WebSocket.OPEN; }
  send(text: string): void { this.socket.send(text); }
  onMessage(cb: (raw: string) => void): void { this.socket.on('message', (raw) => cb(raw.toString())); }
  onClose(cb: () => void): void { this.socket.on('close', cb); }
  close(): void { this.socket.close(); }
}

/** CDP over Chrome's `--remote-debugging-pipe`: NUL-delimited JSON on fds 3 (write) / 4 (read). */
class PipeTransport implements CdpTransport {
  private buffer = '';
  private closed = false;
  private readonly messageCbs: ((raw: string) => void)[] = [];
  private readonly closeCbs: (() => void)[] = [];
  constructor(private readonly writer: Writable, reader: Readable) {
    reader.setEncoding('utf8');
    reader.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf('\0')) >= 0) {
        const message = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        for (const cb of this.messageCbs) cb(message);
      }
    });
    const onEnd = () => { if (!this.closed) { this.closed = true; for (const cb of this.closeCbs) cb(); } };
    reader.on('end', onEnd);
    reader.on('close', onEnd);
    reader.on('error', onEnd);
    writer.on('error', onEnd);
  }
  get open(): boolean { return !this.closed && !this.writer.destroyed; }
  send(text: string): void { this.writer.write(text + '\0'); }
  onMessage(cb: (raw: string) => void): void { this.messageCbs.push(cb); }
  onClose(cb: () => void): void { this.closeCbs.push(cb); }
  close(): void { this.closed = true; try { this.writer.end(); } catch { /* @silent-fallback-ok — pipe already gone; the process teardown below is authoritative */ } }
}

interface AttachedSession {
  targetId: string;
  type: string;
  authenticatorId?: string;
  mainFrameId?: string;
}

type EventHandler = (params: Record<string, unknown>, sessionId: string | undefined) => void | Promise<void>;

/**
 * Whether a SECONDARY page target (a popup) tolerates the credential being present:
 * every frame is either the holder origin or outside the relying-party family. A target
 * still paused at about:blank has no RP-family frame and passes; one whose top-level
 * frame sits on another RP-family origin fails.
 */
function mayAddSecondaryTarget(frames: { origin: string; topLevel: boolean }[], policy: OriginPolicy): boolean {
  return frames.every((f) => f.origin === policy.holderOrigin || !isRpFamilyOrigin(f.origin, policy));
}

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
  private readonly passkeyMode: boolean;
  private readonly policy: OriginPolicy;
  private child: ChildProcess | null = null;
  private transport: CdpTransport | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly eventHandlers = new Map<string, EventHandler[]>();
  /** Pipe mode: every attached target by sessionId. */
  private readonly sessions = new Map<string, AttachedSession>();
  private mainSessionId: string | null = null;
  private mainSessionReady: { resolve: () => void; promise: Promise<void> } | null = null;
  /** The credential currently loaded into the authenticators, or null. */
  private credential: WebAuthnCredential | null = null;
  /**
   * Every credential id this browser has EVER loaded into an authenticator. Removal
   * sweeps these from every authenticator regardless of the in-memory flag, so a
   * target that received the key during a prepare/remove interleave can never keep it.
   */
  private readonly knownCredentialIds = new Set<string>();
  /** Serialises add / remove / prepare-time load so they can never interleave. */
  private credentialLock: Promise<void> = Promise.resolve();
  private readonly assertedCredentialIds = new Set<string>();
  /** True if a Google-origin document navigation was ever seen before an attach completed. */
  private navigationBeforeAttach = false;

  constructor(options: ChromeCdpReloginBrowserOptions) {
    this.chromePath = options.chromePath ?? resolveChromeExecutable()
      ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    this.userDataDir = path.resolve(options.userDataDir);
    this.headless = options.headless ?? false;
    this.launchTimeoutMs = Math.max(1_000, Math.min(30_000, options.launchTimeoutMs ?? 10_000));
    this.operationTimeoutMs = Math.max(1_000, Math.min(30_000, options.operationTimeoutMs ?? 10_000));
    this.passkeyMode = options.passkeyMode ?? false;
    this.policy = options.originPolicy ?? GOOGLE_ORIGIN_POLICY;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async open(url: string): Promise<void> {
    if (this.transport) throw new Error('relogin-browser-already-open');
    if (!fs.existsSync(this.chromePath)) throw new Error('chrome-not-installed');
    fs.mkdirSync(this.userDataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.userDataDir, 0o700);
    if (this.passkeyMode) return this.openPipe(url);
    return this.openTcp(url);
  }

  /** Legacy transport: TCP debugging port + a page-level WebSocket (non-passkey sessions). */
  private async openTcp(url: string): Promise<void> {
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
    await this.connectWs(target.webSocketDebuggerUrl);
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.wait(500);
  }

  /**
   * Passkey transport: the debugging pipe. The initial about:blank page is
   * auto-attached and PREPARED (authenticator, interception, service-worker
   * bypass) before the first navigation; popups are paused until prepared.
   */
  private async openPipe(url: string): Promise<void> {
    const args = [
      `--user-data-dir=${this.userDataDir}`,
      ...PASSKEY_SESSION_CHROME_ARGS,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-component-update',
      'about:blank',
    ];
    if (this.headless) args.unshift('--headless=new');
    const child = spawn(this.chromePath, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    this.child = child;
    const writer = child.stdio[3] as Writable | null;
    const reader = child.stdio[4] as Readable | null;
    if (!writer || !reader) throw new Error('chrome-pipe-unavailable');
    this.attachTransport(new PipeTransport(writer, reader));

    let resolveReady!: () => void;
    const promise = new Promise<void>((r) => { resolveReady = r; });
    this.mainSessionReady = { resolve: resolveReady, promise };

    this.on('Target.attachedToTarget', (params) => this.onAttached(params));
    this.on('Target.detachedFromTarget', (params) => { this.sessions.delete(String(params.sessionId)); });
    this.on('Fetch.requestPaused', (params, sessionId) => this.onRequestPaused(params, sessionId));
    this.on('WebAuthn.credentialAsserted', (params) => {
      const cred = params.credential as { credentialId?: string } | undefined;
      if (cred?.credentialId) this.assertedCredentialIds.add(cred.credentialId);
    });
    this.on('Page.frameRequestedNavigation', (params, sessionId) => {
      // Diagnostic only: a navigation observed on a session that was never prepared.
      const s = sessionId ? this.sessions.get(sessionId) : undefined;
      if (s && !s.authenticatorId && typeof params.url === 'string' && params.url !== 'about:blank') this.navigationBeforeAttach = true;
    });

    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('chrome-launch-timeout')), this.launchTimeoutMs)),
    ]);
    await this.send('Page.navigate', { url }, this.mainSessionId ?? undefined);
    await this.wait(500);
  }

  private async onAttached(params: Record<string, unknown>): Promise<void> {
    const sessionId = String(params.sessionId);
    const info = (params.targetInfo ?? {}) as { targetId?: string; type?: string };
    const waiting = params.waitingForDebugger === true;
    const type = info.type ?? 'other';
    const session: AttachedSession = { targetId: String(info.targetId ?? ''), type };
    this.sessions.set(sessionId, session);
    try {
      if (type === 'page' || type === 'iframe' || type === 'webview') {
        await this.prepareSession(sessionId, session);
      }
    } catch { /* @silent-fallback-ok — a target we could not prepare is resumed below so the browser never wedges; the credential is only ever added to PREPARED authenticators */ }
    if (waiting) {
      try { await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId); } catch { /* @silent-fallback-ok — target may have gone away */ }
    }
    if (type === 'page' && !this.mainSessionId) {
      this.mainSessionId = sessionId;
      this.mainSessionReady?.resolve();
    }
  }

  /** Everything a target needs BEFORE it is allowed to navigate. */
  private async prepareSession(sessionId: string, session: AttachedSession): Promise<void> {
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Network.enable', {}, sessionId);
    await this.send('Network.setBypassServiceWorker', { bypass: true }, sessionId);
    await this.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }, sessionId);
    await this.send('WebAuthn.enable', { enableUI: false }, sessionId);
    const auth = await this.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal',
        hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    }, sessionId);
    // The authenticator becomes VISIBLE to removal and receives the credential in one
    // locked step: a concurrent removeCredential() either runs entirely before (so the
    // credential is null here and nothing is loaded) or entirely after (so this
    // authenticator is in its sweep). A target is still paused at about:blank here.
    await this.withCredentialLock(async () => {
      session.authenticatorId = String(auth.authenticatorId);
      if (this.credential) {
        await this.send('WebAuthn.addCredential', { authenticatorId: session.authenticatorId, credential: this.credential }, sessionId);
      }
    });
    try {
      const tree = await this.send('Page.getFrameTree', {}, sessionId) as { frameTree?: { frame?: { id?: string } } };
      session.mainFrameId = tree.frameTree?.frame?.id;
    } catch { /* @silent-fallback-ok — an OOPIF target has no page frame tree; its documents are never top-level */ }
    // Nested auto-attach so cross-origin iframes of THIS target get the same preparation.
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
  }

  private async onRequestPaused(params: Record<string, unknown>, sessionId: string | undefined): Promise<void> {
    const requestId = String(params.requestId);
    const cont = () => this.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {});
    if (params.resourceType !== 'Document') { await cont(); return; }
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    const request = (params.request ?? {}) as { url?: string };
    const url = request.url ?? '';
    // Unknown frame identity (no session record, or Page.getFrameTree failed) is treated
    // as TOP-LEVEL so the stricter rule applies — over-remove, never under-remove.
    const topLevel = session?.type === 'iframe' ? false
      : (session?.mainFrameId === undefined || params.frameId === session.mainFrameId);
    if ((this.credential || this.knownCredentialIds.size > 0) && mustRemoveCredentialBefore({ url, topLevel }, this.policy)) {
      try {
        await this.removeCredential();
      } catch {
        // Fail CLOSED: if the credential cannot be removed, the document must not load.
        await this.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {});
        return;
      }
    }
    await cont();
  }

  // ── Passkey operations (spec §3.5 port additions) ─────────────────────

  /**
   * Add the credential to every prepared authenticator. Allowed only while the
   * main target's frames satisfy the origin policy (top-level on the holder
   * origin, no other RP-family frame). The value stays inside this process.
   */
  async addCredential(credential: WebAuthnCredential): Promise<void> {
    if (!this.passkeyMode) throw new Error('passkey-mode-required');
    await this.withCredentialLock(async () => {
      // EVERY page target (the main page AND every auto-attached popup) must satisfy
      // the policy — a popup that moved to another RP-family origin earlier (and had
      // the key removed then) must not be re-armed by an add on the main page.
      for (const [sid, s] of this.sessions) {
        if (s.type !== 'page' || !s.authenticatorId) continue;
        const frames = await this.frameOrigins(sid);
        if (sid === this.mainSessionId) {
          if (!mayAddCredential(frames, this.policy)) throw new Error('passkey-origin-not-allowed');
          continue;
        }
        // A secondary target may be blank (still paused), on the holder origin, or on an
        // origin OUTSIDE the relying-party family (it cannot claim the key). What it may
        // never be is on another RP-family origin — in any of its frames.
        if (!mayAddSecondaryTarget(frames, this.policy)) throw new Error('passkey-origin-not-allowed');
      }
      this.credential = { ...credential };
      this.knownCredentialIds.add(credential.credentialId);
      for (const [sessionId, s] of this.sessions) {
        if (!s.authenticatorId) continue;
        await this.send('WebAuthn.addCredential', { authenticatorId: s.authenticatorId, credential: this.credential }, sessionId);
      }
    });
  }

  /**
   * Remove every credential this browser ever loaded from EVERY authenticator, and
   * forget the current one. Does not trust the in-memory flag: the sweep runs whenever
   * any id is known, so no target can keep a key the flag says is gone. Idempotent.
   */
  async removeCredential(): Promise<void> {
    if (!this.credential && this.knownCredentialIds.size === 0) return;
    await this.withCredentialLock(async () => {
      let firstError: unknown = null;
      for (const [sessionId, s] of this.sessions) {
        if (!s.authenticatorId) continue;
        for (const credentialId of this.knownCredentialIds) {
          try {
            await this.send('WebAuthn.removeCredential', { authenticatorId: s.authenticatorId, credentialId }, sessionId);
          } catch (err) {
            // A target that already went away, or an authenticator that never held this
            // id, is fine; anything else is reported after the sweep completes.
            if (!(err instanceof Error && /target|session|closed|detached|not found|unknown credential/i.test(err.message))) firstError ??= err;
          }
        }
      }
      this.credential = null;
      if (firstError) throw firstError instanceof Error ? firstError : new Error(String(firstError));
    });
  }

  /** Run `fn` with exclusive access to the credential state (add / remove / prepare-time load). */
  private withCredentialLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.credentialLock.then(fn, fn);
    this.credentialLock = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Whether the credential is currently loaded into the authenticators. */
  hasCredential(): boolean { return this.credential !== null; }

  /** True once Google (or the fixture) actually asked for and received an assertion from this credential. */
  observedAssertion(credentialId: string): boolean { return this.assertedCredentialIds.has(credentialId); }

  /** Export every credential in the MAIN target's authenticator (used at mint). */
  async exportCredentials(): Promise<WebAuthnCredential[]> {
    if (!this.passkeyMode || !this.mainSessionId) throw new Error('passkey-mode-required');
    const s = this.sessions.get(this.mainSessionId);
    if (!s?.authenticatorId) throw new Error('authenticator-missing');
    const out = await this.send('WebAuthn.getCredentials', { authenticatorId: s.authenticatorId }, this.mainSessionId) as { credentials?: WebAuthnCredential[] };
    return (out.credentials ?? []).map((c) => ({ ...c }));
  }

  /** Credential COUNT per prepared target (never material) — proves every attached target's authenticator is loaded. */
  async credentialCountsByTarget(): Promise<number[]> {
    const counts: number[] = [];
    for (const [sid, s] of this.sessions) {
      if (!s.authenticatorId || s.type !== 'page') continue;
      try {
        const out = await this.send('WebAuthn.getCredentials', { authenticatorId: s.authenticatorId }, sid) as { credentials?: unknown[] };
        counts.push((out.credentials ?? []).length);
      } catch { /* @silent-fallback-ok — a target that closed holds nothing */ }
    }
    return counts;
  }

  /** Number of credentials the MAIN authenticator holds (a count, never material). */
  async credentialCount(): Promise<number> {
    return (await this.exportCredentials()).length;
  }

  /**
   * Compare the signed-in identity shown on the current page with the expected
   * email INSIDE the browser; only the boolean leaves. Structural first
   * (`data-email` / `data-identifier` / `aria-label`), then an exact-text element.
   */
  async readSignedInIdentityMatches(expected: string): Promise<boolean> {
    return this.evaluate<boolean>(`(() => {
      const expected = ${JSON.stringify(expected)}.trim().toLowerCase();
      if (!expected) return false;
      const attrNodes = Array.from(document.querySelectorAll('[data-email],[data-identifier],[aria-label]'));
      for (const n of attrNodes) {
        for (const a of ['data-email','data-identifier','aria-label']) {
          const v = (n.getAttribute(a) || '').trim().toLowerCase();
          if (v === expected) return true;
        }
      }
      const all = Array.from(document.querySelectorAll('div,span,p,li,td,a,button'));
      return all.some((n) => n.children.length === 0 && (n.textContent || '').trim().toLowerCase() === expected);
    })()`);
  }

  /**
   * Whether any target was seen navigating before its authenticator was attached. A
   * DIAGNOSTIC only: it observes from `Page.enable` onward, so it can confirm a breach
   * it saw but not prove absence. The guarantee itself is Chrome's
   * `waitForDebuggerOnStart` pause, which the popup test exercises.
   */
  sawNavigationBeforeAttach(): boolean { return this.navigationBeforeAttach; }

  /**
   * Run an expression in the main page. FIXTURE-ONLY: refused under the production
   * Google policy so no caller can turn the repair browser into an arbitrary-evaluate
   * surface on a real account page.
   */
  async runInPage<T>(expression: string): Promise<T> {
    this.assertFixturePolicy('run-in-page');
    return this.evaluate<T>(expression);
  }

  private assertFixturePolicy(op: string): void {
    if (this.policy.holderOrigin === GOOGLE_ORIGIN_POLICY.holderOrigin || isGoogleOrigin(this.policy.holderOrigin)) {
      throw new Error(`${op}-fixture-only`);
    }
  }

  /** Origins of every frame in ONE page target (its own tree plus its out-of-process iframes). */
  private async frameOrigins(pageSessionId: string | null = this.mainSessionId): Promise<{ origin: string; topLevel: boolean }[]> {
    const tree = await this.send('Page.getFrameTree', {}, pageSessionId ?? undefined) as {
      frameTree?: { frame?: { url?: string; securityOrigin?: string }; childFrames?: unknown[] };
    };
    const out: { origin: string; topLevel: boolean }[] = [];
    const walk = (node: { frame?: { url?: string; securityOrigin?: string }; childFrames?: unknown[] } | undefined, top: boolean) => {
      if (!node?.frame) return;
      const origin = node.frame.securityOrigin && node.frame.securityOrigin !== '://' ? node.frame.securityOrigin : (() => { try { return new URL(node.frame!.url ?? '').origin; } catch { return ''; } })();
      out.push({ origin, topLevel: top });
      for (const child of (node.childFrames ?? []) as typeof node[]) walk(child, false);
    };
    walk(tree.frameTree, true);
    // Out-of-process iframes are separate targets: include them as subframes.
    for (const [sid, s] of this.sessions) {
      if (s.type !== 'iframe' || sid === this.mainSessionId) continue;
      try {
        const t = await this.send('Page.getFrameTree', {}, sid) as { frameTree?: { frame?: { url?: string; securityOrigin?: string } } };
        const f = t.frameTree?.frame;
        const origin = f?.securityOrigin && f.securityOrigin !== '://' ? f.securityOrigin : (() => { try { return new URL(f?.url ?? '').origin; } catch { return ''; } })();
        out.push({ origin, topLevel: false });
      } catch { /* @silent-fallback-ok — a vanished OOPIF cannot hold the credential */ }
    }
    return out;
  }

  // ── ReloginBrowserPort ───────────────────────────────────────────────

  async snapshot(expectedIdentity: string): Promise<ReloginBrowserSnapshot> {
    return this.evaluate<ReloginBrowserSnapshot>(`(() => {
      const expected = ${JSON.stringify(expectedIdentity)}.trim().toLowerCase();
      const body = (document.body?.innerText || '').toLowerCase();
      const buttons = Array.from(document.querySelectorAll('button,[role="button"],a,[role="link"],input[type="submit"]'));
      const buttonText = buttons.map((node) => ((node.textContent || node.getAttribute('value') || '')).trim().toLowerCase());
      const googleEntryLabels = new Set(['continue with google', 'sign in with google', 'log in with google']);
      const hasGoogleSignIn = buttonText.some((text) => googleEntryLabels.has(text));
      const has = (pattern) => pattern.test(body);
      const input = (selector) => !!document.querySelector(selector);
      const chooserNodes = Array.from(document.querySelectorAll('[data-email],[data-identifier],button,[role="button"],a,[role="link"],li'));
      const nodeIdentities = (node) => {
        const declared = (node.getAttribute('data-email') || node.getAttribute('data-identifier') || '').trim().toLowerCase();
        if (declared) return [declared];
        return ((node.textContent || '').toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/g) || []);
      };
      const matching = expected.length === 0 ? [] : chooserNodes.filter((node) => nodeIdentities(node).includes(expected));
      const actionableMatches = matching.filter((node) => !matching.some((child) => child !== node && node.contains(child)));
      const expectedMatchCount = actionableMatches.length;
      const expectedVisible = expectedMatchCount === 1;
      const url = new URL(location.href);
      const requestedScopes = (url.searchParams.get('scope') || '').split(/[ ,]+/).filter(Boolean).slice(0, 20);
      const hasAuthorize = buttonText.some((text) => /^(allow|authorize|approve|continue)$/.test(text));
      const isClosedDeviceApproval = (${isClosedOpenAiDeviceApproval.toString()})({
        origin: location.origin, pathname: location.pathname, hasAuthorize, body,
      });
      // ── Closed Google passkey pages FIRST (spec agent-held-google-passkey §3.6):
      // structural facts only (origin, route, ids, exact control labels, roles), the
      // SAME pure classifier the unit tests run, evaluated before the prose chain
      // below so help text can never shadow a passkey page.
      // Only RENDERED elements count (Google keeps hidden dialogs/menus in the DOM):
      // the same visibility test the real click applies. Buttons are listed before
      // links so a footer-heavy page can never truncate the prompt's own control away.
      const visible = (n) => n.getClientRects().length > 0;
      const labelOf = (n) => ((n.textContent || n.getAttribute('value') || '')).trim().toLowerCase();
      const primaryLabels = Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"]')).filter(visible).map(labelOf);
      const linkLabels = Array.from(document.querySelectorAll('a,[role="link"]')).filter(visible).map(labelOf);
      const idList = Array.from(document.querySelectorAll('[id]')).slice(0, 400).map((n) => n.id.toLowerCase());
      const alertNodes = Array.from(document.querySelectorAll('[role="alert"],[aria-live="assertive"]')).filter(visible);
      const facts = {
        origin: location.origin, pathname: location.pathname, ids: idList,
        controlLabels: primaryLabels.concat(linkLabels).slice(0, 300),
        hasPasswordInput: input('input[type="password"]'),
        hasDialog: Array.from(document.querySelectorAll('[role="dialog"],dialog[open]')).some(visible),
        hasAlert: alertNodes.some((n) => (n.textContent || '').trim().length > 0),
        hasCaptchaWidget: input('iframe[src*="recaptcha" i],#captchaimg,.g-recaptcha,[data-sitekey]'),
        hasAdminHelpLink: input('a[href*="support.google.com/a/" i],a[href*="admin.google.com" i]'),
      };
      const structuralClass = (${classifyGooglePasskeyPage.toString()})(facts, ${JSON.stringify({
        holderOrigin: this.policy.holderOrigin, accountOrigin: this.policy.accountOrigin ?? '',
      })});
      // Rendered controls only, like every other structural fact (a hidden "Not now" must not count).
      const hasNotNow = primaryLabels.includes('not now') || linkLabels.includes('not now');
      let pageClass = structuralClass || 'unknown';
      if (structuralClass) { /* structural match wins; the prose chain is skipped */ }
      else if (has(/captcha|recaptcha|prove you(?:'|’)re not a robot|unusual traffic/)) pageClass = 'captcha';
      else if (has(/check your phone|phone verification|text message|send a code to your phone/)) pageClass = 'phone-confirmation';
      else if (hasGoogleSignIn) pageClass = 'provider-choice';
      else if (location.origin === 'https://auth.openai.com'
        && input('input[name*="code" i],input[id*="code" i],input[autocomplete="one-time-code"]')
        && has(/device|enter.*code|verification code/)) pageClass = 'device-code';
      else if (input('input[autocomplete="one-time-code"],input[name*="totp" i],input[id*="totp" i]') || has(/authenticator (?:app|code)|verification code/)) pageClass = 'totp';
      else if (input('input[type="password"]')) pageClass = 'password';
      else if (input('input[type="email"],input[autocomplete="username"]')) pageClass = 'email';
      else if (has(/choose an account|select an account|continue as/)) pageClass = 'account-chooser';
      else if (isClosedDeviceApproval) pageClass = 'device-approval';
      else if (buttonText.some((text) => /^(allow|authorize|approve|continue)$/.test(text)) && has(/permission|access|authorize|allow/)) pageClass = 'authorize';
      else if (Array.from(document.querySelectorAll('code,pre,[data-testid*="code" i]')).some((node) => /^\S{8,512}$/.test((node.textContent || '').trim())) || has(/copy.*code|paste.*code|authorization code/)) pageClass = 'paste-code';
      else if (has(/authorization (?:complete|successful)|you (?:may|can) close this (?:window|tab)|successfully signed in/)) pageClass = 'success';
      return { origin: location.origin, pageClass, expectedAccountVisible: expectedVisible,
        expectedAccountMatchCount: expectedMatchCount, hasGoogleSignIn,
        hasNext: buttonText.some((text) => /^(next|continue)$/.test(text)),
        hasAuthorize,
        hasNotNow,
        requestedScopes };
    })()`);
  }

  async chooseExpectedAccount(expectedIdentity: string): Promise<void> {
    // A REAL input click (spec §3.5): Google's choice-list items do not respond
    // to a script-level element.click().
    await this.clickReal(`(() => {
      const expected = ${JSON.stringify(expectedIdentity)}.trim().toLowerCase();
      const nodes = Array.from(document.querySelectorAll('[data-email],[data-identifier],button,[role="button"],a,[role="link"],li'));
      const identities = (node) => {
        const declared = (node.getAttribute('data-email') || node.getAttribute('data-identifier') || '').trim().toLowerCase();
        if (declared) return [declared];
        return ((node.textContent || '').toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/g) || []);
      };
      const matching = nodes.filter((node) => identities(node).includes(expected));
      const actionable = matching.filter((node) => !matching.some((child) => child !== node && node.contains(child)));
      if (actionable.length !== 1 || !(actionable[0] instanceof HTMLElement)) return null;
      return actionable[0];
    })()`);
  }

  async fillPublic(field: 'email' | 'device-code', value: string): Promise<void> {
    // Google's identifier field is `input[type="text"]#identifierId`, not type=email (measured 2026-09-20).
    const selector = field === 'email'
      ? 'input[type="email"],input[autocomplete="username"],input#identifierId,input[name="identifier"]'
      : 'input[name*="code" i],input[id*="code" i],input[autocomplete="one-time-code"]';
    await this.fillAndSubmit(selector, value);
  }

  async fillSecret(field: 'password' | 'totp' | 'backup-code', value: string): Promise<void> {
    const selector = field === 'password'
      ? 'input[type="password"]'
      : field === 'backup-code'
        ? 'input#backupCodePin,input[name="backupCodePin"]'
        : 'input[autocomplete="one-time-code"],input[name*="totp" i],input[id*="totp" i],input[type="tel"]';
    await this.fillAndSubmit(selector, value);
  }

  async click(action: ReloginBrowserClick): Promise<void> {
    // Exact control labels (spec §3.6: closed page classes, closed action set). The
    // create-confirm click is scoped to an open dialog so a page-level "Continue"
    // can never stand in for the confirmation.
    const pattern = action === 'next' ? '^(next|continue)$'
      : action === 'google' ? '(continue|sign in|log in) with google'
      : action === 'passkey-continue' ? '^continue$'
      : action === 'try-another-way' ? '^try another way$'
      : action === 'create-passkey' ? '^create a passkey$'
      : action === 'create-passkey-confirm' ? '^(continue|create)$'
      : action === 'not-now' ? '^not now$'
      : '^(allow|authorize|approve|continue)$';
    const controls = ['button', '[role="button"]', 'a', '[role="link"]', 'input[type="submit"]'];
    const selector = action === 'create-passkey-confirm'
      ? controls.flatMap((s) => [`[role="dialog"] ${s}`, `dialog[open] ${s}`]).join(',')
      : controls.join(',');
    await this.clickReal(`(() => {
      const re = new RegExp(${JSON.stringify(pattern)}, 'i');
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const node = nodes.find((entry) => re.test(((entry.textContent || entry.getAttribute('value') || '')).trim()));
      return node instanceof HTMLElement ? node : null;
    })()`);
    await this.wait(500);
  }

  /** Click a fixture/test element by CSS selector with a REAL pointer event. FIXTURE-ONLY (see runInPage). */
  async clickSelector(selector: string): Promise<void> {
    this.assertFixturePolicy('click-selector');
    await this.clickReal(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); return n instanceof HTMLElement ? n : null; })()`);
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
    const child = this.child;
    this.credential = null;
    if (this.transport?.open) {
      try { await this.send('Browser.close'); } catch { /* @silent-fallback-ok — process may already be gone; local socket/process teardown continues below */ }
    }
    this.transport?.close();
    this.transport = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer); entry.reject(new Error('relogin-browser-closed'));
    }
    this.pending.clear();
    this.sessions.clear();
    this.mainSessionId = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      if (!await this.waitForChildExit(child, 5_000)) {
        child.kill('SIGKILL');
        await this.waitForChildExit(child, 2_000);
      }
    }
    this.child = null;
  }

  // ── Internals ────────────────────────────────────────────────────────

  private async waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('exit', onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      child.once('exit', onExit);
      const timer = setTimeout(() => finish(false), timeoutMs);
      // Close the check-then-listen gap: the process may have exited between
      // the fast-path check above and listener registration.
      if (child.exitCode !== null || child.signalCode !== null) finish(true);
    });
  }

  /**
   * Real pointer click: resolve the element with `finderExpression` (must
   * evaluate to an HTMLElement or null), scroll it into view, read its centre,
   * and dispatch mouse pressed/released through the Input domain.
   */
  private async clickReal(finderExpression: string): Promise<void> {
    const point = await this.evaluate<{ x: number; y: number } | null>(`(() => {
      const el = (${finderExpression});
      if (!(el instanceof HTMLElement)) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!point) throw new Error('browser-element-not-found');
    const sid = this.mainSessionId ?? undefined;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, sid);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 }, sid);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 }, sid);
  }

  private async fillAndSubmit(selector: string, value: string): Promise<void> {
    const filled = await this.evaluate<boolean>(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!(node instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(node, ${JSON.stringify(value)});
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      // Read back: never submit a field whose value did not stick (measured 2026-09-21).
      return node.value.length === ${JSON.stringify(value)}.length;
    })()`, true);
    if (!filled) throw new Error('browser-element-not-found');
    try {
      await this.clickReal(`(() => {
        const buttons = Array.from(document.querySelectorAll('button,[role="button"],a,[role="link"],input[type="submit"]'));
        const submit = buttons.find((entry) => /^(next|continue|sign in|verify|submit)$/i
          .test(((entry.textContent || entry.getAttribute('value') || '')).trim()));
        return submit instanceof HTMLElement ? submit : null;
      })()`);
    } catch {
      // No submit button: fall back to the form's own submit.
      await this.evaluate<boolean>(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        const form = node instanceof HTMLElement ? node.closest('form') : null;
        if (form instanceof HTMLFormElement) { form.requestSubmit(); return true; }
        return true;
      })()`);
    }
    await this.wait(500);
  }

  private async evaluate<T>(expression: string, requireTruthy = false): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, this.mainSessionId ?? undefined);
    const remote = result.result as { value?: T; exceptionDetails?: unknown } | undefined;
    if (!remote || result.exceptionDetails) throw new Error('browser-evaluation-failed');
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

  private async connectWs(url: string): Promise<void> {
    const socket = new WebSocket(url, { origin: 'http://127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cdp-connect-timeout')), this.operationTimeoutMs);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    this.attachTransport(new WsTransport(socket));
  }

  private attachTransport(transport: CdpTransport): void {
    this.transport = transport;
    transport.onMessage((raw) => {
      let message: CdpMessage;
      try { message = JSON.parse(raw) as CdpMessage; } catch { return; }
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id); if (!entry) return;
        this.pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message ?? 'cdp-error'));
        else entry.resolve(message.result ?? {});
        return;
      }
      if (message.method) {
        for (const handler of this.eventHandlers.get(message.method) ?? []) {
          try {
            const out = handler(message.params ?? {}, message.sessionId);
            if (out && typeof (out as Promise<void>).catch === 'function') (out as Promise<void>).catch(() => {});
          } catch { /* @silent-fallback-ok — an event handler must never take the transport down */ }
        }
      }
    });
    transport.onClose(() => {
      for (const [id, entry] of this.pending) {
        this.pending.delete(id); clearTimeout(entry.timer); entry.reject(new Error('cdp-closed'));
      }
    });
  }

  private on(method: string, handler: EventHandler): void {
    const list = this.eventHandlers.get(method) ?? [];
    list.push(handler);
    this.eventHandlers.set(method, list);
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const transport = this.transport;
    if (!transport || !transport.open) return Promise.reject(new Error('cdp-not-connected'));
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`cdp-timeout:${method}`)); }, this.operationTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        transport.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      } catch (error) {
        this.pending.delete(id); clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
