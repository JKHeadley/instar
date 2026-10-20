/**
 * The local approval page (spec threadline-standalone-pairing r4, D5).
 *
 * An app without MCP elicitation (Claude Desktop, for one) cannot ask the person a pairing question
 * itself. There, the pairing tools that need the person (open, finish, forget) put the same questions
 * on a small web page served by this process, on 127.0.0.1 only, at a path carrying a one-time
 * random token. The tool call does not wait for the person: it starts the pairing action in the
 * background, opens the person's browser on the page itself, and returns at once. The model never
 * receives the link (Echo review R2-1): an agent that can fetch local URLs could otherwise answer the
 * page itself. Only when the browser cannot be opened does the result carry the link, flagged as the
 * weaker 'link-in-chat' fallback. The action's final result is kept for threadline_pair_status.
 *
 * Honest boundary: the page is weaker than an app's own dialog. Software on this computer that can
 * guess or read the link (and, in the fallback, an assistant that can fetch local URLs) could answer
 * it. Opening an invite still needs the invite itself, which the person pastes into the page and the
 * agent never has.
 *
 * No MCP SDK import, so it is unit-testable on its own.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Elicit, ToolResult } from './pairTools.js';

export type ElicitFields = Parameters<Elicit>[1];

/** What the agent passes on when the page opened in the person's browser (no link in the result). */
export const PAGE_NOTE_OPENED = 'A page opened in your browser to approve the pairing. It stays open for 10 minutes.';
/** When the browser could not be opened: the link has to go through the chat, which is weaker. */
export const PAGE_NOTE_FALLBACK = 'Your browser could not be opened, so give your person this link to open in their browser to approve the pairing. It stays open for 10 minutes. This is weaker than the page opening by itself, because you (the assistant) can see the link; never open it yourself.';

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  // Not 'no-referrer': under that policy a browser sends `Origin: null` with the page's own form POST,
  // so the Origin check below could not tell our form from a sandboxed foreign one. 'same-origin'
  // sends nothing to any other site (there are no links off the page) and a real Origin to us.
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
};
const MAX_BODY = 64 * 1024;

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

interface Question { message: string; fields: ElicitFields; qtoken: string; resolve: (v: Record<string, string> | null) => void }

export interface ApprovalPageOptions {
  /** How long the page stays open (ELICIT_TIMEOUT_MS in server.ts). */
  timeoutMs: number;
  /** Shown as the page heading. */
  title?: string;
  /** After the action finishes, the result stays readable this long, then the page closes. */
  resultGraceMs?: number;
  /** A POST waits this long for the next question or the result before answering "working". */
  postWaitMs?: number;
}

/**
 * One page session for one pending tool action, with its own listener on 127.0.0.1, port 0.
 * `elicit` publishes a question and resolves when the person submits (values) or cancels (null), or
 * when the page expires (null: nothing is decided).
 */
export class ApprovalPage {
  readonly token = crypto.randomBytes(32).toString('hex');
  readonly expiresAt: number;
  private srv: http.Server | null = null;
  private port = 0;
  private current: Question | null = null;
  private result: string | null = null;
  private expired = false;
  private closedFlag = false;
  private expiryTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private waiters: Array<() => void> = [];
  private onClosed: Array<() => void> = [];

  private constructor(private readonly opts: ApprovalPageOptions) {
    this.expiresAt = Date.now() + opts.timeoutMs;
  }

  /** Start listening on 127.0.0.1 with a random port. Rejects if it cannot listen. */
  static async open(opts: ApprovalPageOptions): Promise<ApprovalPage> {
    const page = new ApprovalPage(opts);
    const srv = http.createServer((req, res) => page.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => { srv.off('error', reject); resolve(); });
    });
    srv.unref(); // never keep the process alive (it exits when the app closes it)
    page.srv = srv;
    page.port = (srv.address() as AddressInfo).port;
    page.expiryTimer = setTimeout(() => page.expire(), opts.timeoutMs);
    page.expiryTimer.unref();
    return page;
  }

  get link(): string { return `http://127.0.0.1:${this.port}/${this.token}`; }
  get address(): AddressInfo | null { return this.srv ? (this.srv.address() as AddressInfo) : null; }
  get isOpen(): boolean { return !this.closedFlag && !this.expired && this.result === null; }
  get hasQuestion(): boolean { return this.current !== null; }
  get isExpired(): boolean { return this.expired; }

  /** The page-backed Elicit: one question at a time, answered by the person on the page. */
  readonly elicit: Elicit = (message, fields) => new Promise((resolve) => {
    if (!this.isOpen) return resolve(null);
    if (this.current) this.current.resolve(null); // never two at once
    this.current = { message, fields, qtoken: crypto.randomBytes(16).toString('hex'), resolve };
    this.changed();
  });

  /** Resolves on the next question, result, expiry or close (whichever first). */
  nextChange(): Promise<void> { return new Promise((r) => this.waiters.push(r)); }
  whenClosed(): Promise<void> { return this.closedFlag ? Promise.resolve() : new Promise((r) => this.onClosed.push(r)); }

  /** The action finished: no more questions; show the result briefly, then close. */
  finish(resultText: string): void {
    if (this.closedFlag) return;
    if (this.current) { this.current.resolve(null); this.current = null; }
    this.result = resultText;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.changed();
    this.graceTimer = setTimeout(() => this.close(), this.opts.resultGraceMs ?? 60_000);
    this.graceTimer.unref();
  }

  /** Ten minutes passed: an unanswered question counts as no answer, and the page stops serving (404). */
  private expire(): void {
    if (this.closedFlag || this.result !== null) return;
    this.expired = true;
    if (this.current) { const q = this.current; this.current = null; q.resolve(null); }
    this.changed();
    // Keep listening briefly so a late visit gets a plain 404 rather than a dead port.
    this.graceTimer = setTimeout(() => this.close(), this.opts.resultGraceMs ?? 60_000);
    this.graceTimer.unref();
  }

  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    if (this.current) { const q = this.current; this.current = null; q.resolve(null); }
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.srv?.close();
    this.srv?.closeAllConnections?.();
    this.changed();
    for (const r of this.onClosed.splice(0)) r();
  }

  private changed(): void { for (const w of this.waiters.splice(0)) w(); }

  // ── HTTP ─────────────────────────────────────────────────────────

  private send(res: http.ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': body.startsWith('<!doctype') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', ...extra });
    res.end(body);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      // DNS rebinding: only a request addressed to exactly our loopback address and port (no Host: refused).
      if (typeof req.headers.host !== 'string' || req.headers.host !== `127.0.0.1:${this.port}`) return this.send(res, 403, 'Forbidden');
      if (req.method !== 'GET' && req.method !== 'POST') return this.send(res, 405, 'Method not allowed', { Allow: 'GET, POST' });
      // A POST from any other page (including a sandboxed one, Origin: null) is refused.
      if (req.method === 'POST' && req.headers.origin !== undefined && req.headers.origin !== `http://127.0.0.1:${this.port}`) return this.send(res, 403, 'Forbidden');
      const pathname = (req.url ?? '').split('?')[0];
      if (this.expired || this.closedFlag || !sameToken(pathname, `/${this.token}`)) return this.send(res, 404, 'Not found');
      if (req.method === 'GET') return this.send(res, 200, this.render());

      const body = await readBody(req);
      if (body === null) return this.send(res, 413, 'Too large');
      const form = new URLSearchParams(body);
      const q = this.current;
      if (!q || !sameToken(form.get('qt') ?? '', q.qtoken)) {
        // A stale or forged form (another tab, an old question, or a page that is not ours).
        return this.send(res, 403, this.render('That form is out of date. Here is the current page.'));
      }
      if (form.get('action') === 'cancel') {
        this.current = null;
        q.resolve(null);
      } else {
        const values: Record<string, string> = {};
        for (const [name, f] of Object.entries(q.fields)) {
          const v = (form.get(name) ?? '').trim();
          if (!v || (f.enum && !f.enum.includes(v))) return this.send(res, 400, this.render('Please answer every question, or press Cancel.'));
          values[name] = v;
        }
        this.current = null;
        q.resolve(values);
      }
      // Answer with what comes next (the next question or the result), if it comes quickly.
      await Promise.race([this.nextChange(), new Promise((r) => setTimeout(r, this.opts.postWaitMs ?? 5_000).unref())]);
      if (this.expired || this.closedFlag) return this.send(res, 404, 'Not found');
      return this.send(res, 200, this.render());
    } catch {
      if (!res.headersSent) this.send(res, 500, 'Error');
    }
  }

  private render(notice?: string): string {
    const title = escapeHtml(this.opts.title ?? 'Threadline pairing');
    let main: string;
    let refresh = '';
    if (this.result !== null) {
      main = `<p class="result">${escapeHtml(this.result)}</p><p class="hint">You can close this tab.</p>`;
    } else if (this.current) {
      const q = this.current;
      const fields = Object.entries(q.fields).map(([name, f]) => {
        const label = escapeHtml(f.title || name);
        const hint = f.description ? `<p class="hint">${escapeHtml(f.description)}</p>` : '';
        if (f.enum) {
          const radios = f.enum.map((c, i) => `<label class="choice"><input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(c)}" required id="${escapeHtml(name)}-${i}"> ${escapeHtml(c)}</label>`).join('\n');
          return `<fieldset><legend>${label}</legend>${hint}\n${radios}</fieldset>`;
        }
        return `<label for="${escapeHtml(name)}">${label}</label>${hint}<textarea id="${escapeHtml(name)}" name="${escapeHtml(name)}" rows="6" required autocomplete="off" spellcheck="false"></textarea>`;
      }).join('\n');
      main = `<p class="question">${escapeHtml(q.message)}</p>
<form method="post" action="/${this.token}">
<input type="hidden" name="qt" value="${q.qtoken}">
${fields}
<div class="buttons"><button type="submit" name="action" value="submit">Submit</button> <button type="submit" name="action" value="cancel" formnovalidate>Cancel</button></div>
</form>`;
    } else {
      refresh = `<meta http-equiv="refresh" content="2">`;
      main = '<p>Working on it. This page updates by itself.</p>';
    }
    const expires = new Date(this.expiresAt).toLocaleTimeString();
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh}
<title>${title}</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a;background:#fafafa}
h1{font-size:1.4rem}.question,.result{font-size:1.1rem}.hint{color:#555;font-size:.95rem;margin:.2rem 0 .6rem}
textarea{width:100%;box-sizing:border-box;font-family:ui-monospace,monospace;font-size:.9rem}
fieldset{border:1px solid #ccc;border-radius:6px;padding:.6rem 1rem}.choice{display:block;padding:.3rem 0;font-size:1.05rem}
.buttons{margin-top:1rem}button{font-size:1rem;padding:.45rem 1.2rem;margin-right:.5rem}
.notice{background:#fff4d6;border:1px solid #e0c060;padding:.5rem .8rem;border-radius:6px}
footer{margin-top:2rem;color:#666;font-size:.85rem}
@media (prefers-color-scheme: dark){body{background:#161616;color:#eee}.hint,footer{color:#aaa}.notice{background:#3a3110;border-color:#7a6520}}
</style></head><body>
<h1>${title}</h1>
${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ''}
${main}
<footer>This page is served by Threadline on your own computer and closes by ${escapeHtml(expires)}.</footer>
</body></html>`;
  }
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) over = true; else chunks.push(c); });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Open a link in the person's default browser, detached. Resolves true when the opener ran and exited 0
 * (or is still running after a few seconds), false when it could not start, exited non-zero, or
 * THREADLINE_NO_BROWSER=1. Never throws.
 */
export function openInBrowser(url: string, waitMs = 3_000): Promise<boolean> {
  if (process.env.THREADLINE_NO_BROWSER === '1') return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const end = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };
    try {
      const [cmd, args, extra] = process.platform === 'darwin' ? ['open', [url], {}]
        : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url], { windowsVerbatimArguments: true }]
        : ['xdg-open', [url], {}];
      const child = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore', ...(extra as object) });
      child.on('error', () => end(false));
      child.on('exit', (code) => end(code === 0));
      child.unref();
      setTimeout(() => end(true), waitMs).unref();
    } catch { end(false); }
  });
}

export type ApprovalAction = 'open' | 'finish' | 'forget';

export interface ApprovalCoordinatorOptions {
  timeoutMs: number;
  /** Opens the page in the person's browser; resolves false if it could not. Injectable for tests. */
  openBrowser?: (url: string) => Promise<boolean>;
  resultGraceMs?: number;
  postWaitMs?: number;
  now?: () => Date;
}

/** Plain words for the page after the action ends. */
export function describeResult(r: ToolResult): string {
  if (!r.ok) return `Nothing was changed. ${String((r as { error?: string }).error ?? '')}`.trim();
  const agent = typeof r.agent === 'string' ? r.agent : '';
  if (r.result === 'finished') return `Paired with the agent that calls itself "${agent}".`;
  if (r.result === 'approved') return `Approved. You will be paired with the agent that calls itself "${agent}" when the other person finishes.`;
  if (r.result === 'unpaired') return `Unpaired from the agent "${agent}".`;
  return 'Nothing was changed.';
}

type Fallback = 'link-in-chat';

/** A different pairing step asked for while an approval page is open (Echo review MINOR b). */
export const ANOTHER_OPEN = 'Another approval is already open in your browser; finish it first.';

/**
 * At most one page session per server. `start` runs a pairing action with a page-backed elicit and
 * returns as soon as the action asks its first question (pending) or ends without asking (its own
 * result, e.g. "nobody has accepted one of your invites yet"). It never waits for the person.
 * The link reaches the result only in the 'link-in-chat' fallback (the browser could not be opened).
 */
export class ApprovalCoordinator {
  private active: { action: ApprovalAction; page: ApprovalPage; fallback?: Fallback } | null = null;
  private last: { action: ApprovalAction; result: ToolResult; at: string; fallback?: Fallback } | null = null;

  constructor(private readonly opts: ApprovalCoordinatorOptions) {}

  private async present(s: { action: ApprovalAction; page: ApprovalPage; fallback?: Fallback }): Promise<ToolResult> {
    // Also used when the agent asks again while the page is open: the browser is opened again (the person
    // may have closed the tab). Deliberately, if THAT open fails, the live page's link goes into the chat
    // as the flagged 'link-in-chat' fallback, the same as when the first open fails (Echo review MINOR a).
    let opened = false;
    try { opened = await (this.opts.openBrowser ?? openInBrowser)(s.page.link); } catch { opened = false; }
    const expiresAt = new Date(s.page.expiresAt).toISOString();
    if (opened && !s.fallback) return { ok: true, pending: true, opened: true, action: s.action, expiresAt, note: PAGE_NOTE_OPENED };
    if (!opened) s.fallback = 'link-in-chat';
    return { ok: true, pending: true, opened, action: s.action, expiresAt, fallback: 'link-in-chat', link: s.page.link, note: PAGE_NOTE_FALLBACK };
  }

  /** Throws if the page cannot listen (the caller then refuses in plain words). */
  async start(action: ApprovalAction, run: (elicit: Elicit) => Promise<ToolResult>): Promise<ToolResult> {
    // One page at a time: asking again re-opens the same page (the person may have closed the tab).
    if (this.active && this.active.page.isOpen) {
      if (this.active.action !== action) return { ok: false, error: ANOTHER_OPEN };
      return this.present(this.active);
    }
    const page = await ApprovalPage.open({ timeoutMs: this.opts.timeoutMs, resultGraceMs: this.opts.resultGraceMs, postWaitMs: this.opts.postWaitMs, title: 'Threadline pairing' });
    const session: { action: ApprovalAction; page: ApprovalPage; fallback?: Fallback } = { action, page };
    this.active = session;
    let settled = false;
    const done: Promise<ToolResult> = run(page.elicit)
      .catch((err): ToolResult => ({ ok: false, error: `Pairing stopped: ${String((err as Error)?.message ?? err)}` }))
      .then((result) => {
        settled = true;
        page.finish(describeResult(result));
        if (this.active === session) this.active = null;
        return result;
      });
    const firstQuestion = page.hasQuestion ? Promise.resolve() : page.nextChange();
    await Promise.race([done, firstQuestion]);
    if (settled || !page.hasQuestion) {
      // Ended without asking the person anything: answer the tool call with the result itself.
      const result = await done;
      page.close();
      if (this.active === session) this.active = null;
      return result;
    }
    void done.then((result) => { this.last = { action, result, at: (this.opts.now?.() ?? new Date()).toISOString(), ...(session.fallback ? { fallback: session.fallback } : {}) }; });
    return this.present(session);
  }

  /** For threadline_pair_status. Never carries the link, except in the recorded fallback. */
  statusFields(): Record<string, unknown> {
    const a = this.active && this.active.page.isOpen ? this.active : null;
    return {
      ...(a ? { pendingApproval: { action: a.action, expiresAt: new Date(a.page.expiresAt).toISOString(), ...(a.fallback ? { fallback: a.fallback, link: a.page.link } : {}) } } : {}),
      ...(this.last ? { lastApproval: this.last } : {}),
    };
  }

  close(): void { this.active?.page.close(); this.active = null; }
}
