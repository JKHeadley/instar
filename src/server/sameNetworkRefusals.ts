/**
 * The home listener's refusal log (builder #63, after builder #62's live iPhone pairing over home Wi-Fi).
 *
 * A phone paired at home got 403s and a 503 the agent could not explain afterwards: the home listener
 * kept no record of what it refused. This keeps a small, bounded record of every refusal there:
 *  - a connection dropped before HTTP (a per-address or total limit, a failed TLS handshake);
 *  - a request answered with a status of 400 or more (by the gate or by a route behind it).
 *
 * Each entry holds only: when, the kind, the method, the route with every id-like part replaced by
 * `:id`, the status, a reason code (the answer's own `error` code when it is a plain code, else
 * `http-<status>`), the first 8 characters of the phone's device id when it sent one, and the caller's
 * address. Never a header value, a body, a query string, a signature, a token or a setup id.
 *
 * Bounded: at most MAX_ENTRIES entries (oldest dropped); a refusal identical to the newest one (same
 * kind, reason, route, status, device and address) only bumps that entry's count and last time, so a
 * flood is one line. Kept in `state/same-network-refusals.json` (mode 0600), written at most once per
 * FLUSH_MS, so it survives a restart and a flood cannot turn into a disk write per connection.
 * Observability only: it never decides anything.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SAME_NETWORK_REFUSALS_FILE = 'state/same-network-refusals.json';
export const SAME_NETWORK_REFUSALS_MAX_ENTRIES = 300;
const FLUSH_MS = 2_000;
const MAX_ROUTE = 120;

export type RefusalKind = 'connection' | 'tls' | 'request';

export interface SameNetworkRefusal {
  /** First time (ISO). */
  at: string;
  /** Last time, when count > 1 (ISO). */
  lastAt?: string;
  count: number;
  kind: RefusalKind;
  reason: string;
  method?: string;
  route?: string;
  status?: number;
  /** The first 8 characters of the `X-Instar-Device` id, when one was sent. */
  device?: string;
  from?: string;
}

export interface RefusalInput {
  kind: RefusalKind;
  reason: string;
  method?: string;
  /** The raw request URL: reduced here to a route with ids replaced (the query is dropped). */
  url?: string;
  status?: number;
  deviceHeader?: unknown;
  from?: string;
}

/** A path reduced to a route: lower case, no query, no trailing slash, every id-like segment `:id`. */
export function refusalRoute(url: string): string {
  const pathOnly = (String(url).split('?')[0] ?? '/').split('#')[0] ?? '/';
  const segs = pathOnly.toLowerCase().split('/').filter((s) => s.length > 0).map((s) => {
    if (!/^[a-z0-9._-]+$/.test(s)) return ':x';
    // Anything long, or carrying a digit with some length, may be an id, a code or a token.
    if (s.length > 24 || (s.length >= 6 && /[0-9]/.test(s))) return ':id';
    return s;
  });
  const r = '/' + segs.join('/');
  return r.length > MAX_ROUTE ? r.slice(0, MAX_ROUTE) : r;
}

/** A reason code: lower-case words and dashes only (an `error` field that is a sentence is not one). */
export function refusalCode(v: unknown): string | null {
  return typeof v === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(v) ? v : null;
}

/** The answer's own `error` code from the start of a JSON body, if it is a plain code. */
export function reasonFromBody(body: string | null): string | null {
  if (!body) return null;
  try { const j = JSON.parse(body) as { error?: unknown }; return refusalCode(j?.error); } catch {
    // @silent-fallback-ok — a body that is not JSON (or was clipped) has no parsed code; a leading "error" field still counts, else the status stands in
    return refusalCode(/^\s*\{\s*"error"\s*:\s*"([a-z][a-z0-9-]{0,63})"/.exec(body)?.[1]);
  }
}

/** The device id's first 8 characters, only when it has a device id's shape. */
export function devicePrefix(v: unknown): string | undefined {
  return typeof v === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(v) ? v.slice(0, 8) : undefined;
}

/** A caller address, only when it has an address's shape (IPv4/IPv6 characters, clipped). */
function addressOf(v: unknown): string | undefined {
  return typeof v === 'string' && /^[0-9a-fA-F:.]{2,45}$/.test(v) ? v : undefined;
}

export class SameNetworkRefusalLog {
  private entries: SameNetworkRefusal[] = [];
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(private readonly opts: { stateDir: string; now?: () => number; max?: number; flushMs?: number }) {
    this.entries = this.read();
  }

  private max(): number { return this.opts.max ?? SAME_NETWORK_REFUSALS_MAX_ENTRIES; }
  private file(): string { return path.join(this.opts.stateDir, SAME_NETWORK_REFUSALS_FILE); }
  private nowIso(): string { return new Date((this.opts.now ?? Date.now)()).toISOString(); }

  private read(): SameNetworkRefusal[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as { version?: unknown; entries?: unknown };
      if (raw && raw.version === 1 && Array.isArray(raw.entries)) {
        return (raw.entries as SameNetworkRefusal[]).filter((e) => e && typeof e.at === 'string' && typeof e.reason === 'string').slice(-this.max());
      }
    } catch {
      // @silent-fallback-ok — no file (or an unreadable one) starts an empty log; it is observability only
    }
    return [];
  }

  record(input: RefusalInput): void {
    const e: SameNetworkRefusal = {
      at: this.nowIso(), count: 1, kind: input.kind,
      reason: refusalCode(input.reason) ?? (input.status ? `http-${input.status}` : 'unknown'),
    };
    if (input.method) e.method = /^[A-Z]{1,10}$/.test(input.method.toUpperCase()) ? input.method.toUpperCase() : 'OTHER';
    if (input.url !== undefined) e.route = refusalRoute(input.url);
    if (typeof input.status === 'number') e.status = input.status;
    const dev = devicePrefix(input.deviceHeader);
    if (dev) e.device = dev;
    const from = addressOf(input.from);
    if (from) e.from = from;
    const last = this.entries[this.entries.length - 1];
    if (last && last.kind === e.kind && last.reason === e.reason && last.method === e.method && last.route === e.route
      && last.status === e.status && last.device === e.device && last.from === e.from) {
      last.count += 1; last.lastAt = e.at;
    } else {
      this.entries.push(e);
      if (this.entries.length > this.max()) this.entries.splice(0, this.entries.length - this.max());
    }
    this.scheduleFlush();
  }

  /** Newest first, at most `limit`. Copies. */
  recent(limit = 100): SameNetworkRefusal[] {
    const n = Math.max(0, Math.min(this.max(), Math.floor(limit)));
    return this.entries.slice(-n).reverse().map((e) => ({ ...e }));
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.opts.flushMs ?? FLUSH_MS);
    this.timer.unref?.();
  }

  /** Writes the log now (also called on stop). */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return;
    this.dirty = false;
    const f = this.file();
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }), { mode: 0o600 });
      fs.renameSync(tmp, f);
    } catch {
      // @silent-fallback-ok — the refusal log is observability only; the entries stay in memory and the next refusal tries again
      this.dirty = true;
    }
  }
}
