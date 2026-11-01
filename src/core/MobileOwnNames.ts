/**
 * This machine's own names for the Instar iPhone app (docs/specs/mobile-multi-route.md §4.1).
 *
 * A paired phone's signature names the exact host it was sent to. With multi-route on, the
 * server accepts that host only if it is one of THIS machine's own names: a hostname that
 *   - comes from a local source (the configured Cloudflare tunnel hostname, or this machine's
 *     Tailscale HTTPS name when `tailscale serve` maps 443 to this agent's port), and
 *   - was proven by the extended pairing ping: this process's answer, the Host echoed back
 *     unchanged, an arrival through this machine's own local TLS front, and no sibling
 *     machine claiming the name.
 *
 * Identity and health are separate: a proven name stays listed through probe failures (the
 * outside path may simply be down) and leaves at once when its local source stops naming it
 * or a different process answers for it. Health is reported beside it.
 *
 * Nothing a request carries can add a candidate. Every probe is bounded: one in flight per
 * name, a 3 s timeout, 60 s while healthy, doubling to 15 minutes after a failure, and a
 * breaker after 8 consecutive failures that resumes when the name's source changes, at the
 * next server start, or once every 24 hours.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export type OwnNameKind = 'tailscale' | 'cloudflare';

export interface OwnNameRecord { kind: OwnNameKind; host: string; firstVerifiedAt: string; seeded?: boolean }
interface OwnNamesFile { version: number; names: OwnNameRecord[] }

export interface Candidate { kind: OwnNameKind; host: string; /** What the local source said; a change resets the breaker. */ source: string }

/** Runs the Tailscale CLI with these args and resolves its stdout; rejects on any failure. */
export type TailscaleExec = (args: string[]) => Promise<string>;

/** The answer the extended ping gives. */
export interface PingProbeBody { h?: unknown; host?: unknown; arrival?: unknown }

export const PROBE_TIMEOUT_MS = 3_000;
export const HEALTHY_INTERVAL_MS = 60_000;
export const MAX_BACKOFF_MS = 15 * 60_000;
export const BREAKER_FAILURES = 8;
export const BREAKER_RESUME_MS = 24 * 60 * 60_000;
export const CANDIDATE_REFRESH_MS = 60_000;
const TICK_MS = 5_000;
const HOST_RE = /^[a-z0-9.-]{1,253}$/;

/** Lowercase, a default `:443` stripped; null when it is not a plain hostname. */
export function normalizeRequestHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let h = raw.trim().toLowerCase();
  if (h.endsWith(':443')) h = h.slice(0, -4);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return HOST_RE.test(h) ? h : null;
}

/** The default Tailscale exec: `tailscale` (or `tailscale.exe` from WSL), 3 s, bounded output. */
export function defaultTailscaleExec(isWsl: boolean): TailscaleExec {
  const bin = isWsl ? 'tailscale.exe' : 'tailscale';
  return (args) => new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 3_000, maxBuffer: 1_000_000 }, (err, stdout) => { if (err) reject(err); else resolve(String(stdout)); });
  });
}

/** `tailscale status --json` → this machine's HTTPS name, only when it is in CertDomains. */
export function tailscaleSelfName(statusJson: string): { host: string } | { reason: string } {
  let s: { BackendState?: unknown; Self?: { DNSName?: unknown }; CertDomains?: unknown };
  try { s = JSON.parse(statusJson); } catch { return { reason: 'tailscale-status-unparseable' }; } // @silent-fallback-ok — returned as the candidate's failure reason
  if (!s || typeof s !== 'object') return { reason: 'tailscale-status-unparseable' };
  if (s.BackendState !== 'Running') return { reason: 'tailscale-not-running' };
  const host = normalizeRequestHost(s.Self?.DNSName);
  if (!host) return { reason: 'tailscale-no-dns-name' };
  const certs = Array.isArray(s.CertDomains) ? s.CertDomains.map((d) => normalizeRequestHost(d)) : [];
  if (!certs.includes(host)) return { reason: 'tailscale-name-not-in-cert-domains' };
  return { host };
}

export type ServeState = 'ours' | 'none' | 'other' | 'unknown';

/**
 * `tailscale serve status --json` → whether HTTPS 443 on `host` serves this agent's `port`.
 * 'none' when 443 has no serve config at all; 'other' when it serves something else.
 */
export function serveStateFor(serveJson: string, host: string, port: number, isWsl: boolean): ServeState {
  let s: { TCP?: Record<string, unknown>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }> };
  try { s = serveJson.trim() ? JSON.parse(serveJson) : {}; } catch { return 'unknown'; } // @silent-fallback-ok — 'unknown' is reported in /health
  if (!s || typeof s !== 'object') return 'unknown';
  const tcp443 = s.TCP && typeof s.TCP === 'object' ? s.TCP['443'] : undefined;
  const webKeys = s.Web && typeof s.Web === 'object' ? Object.keys(s.Web).filter((k) => k.endsWith(':443')) : [];
  if (!tcp443 && webKeys.length === 0) return 'none';
  const web = s.Web?.[`${host}:443`];
  const proxy = web?.Handlers?.['/']?.Proxy;
  if (typeof proxy !== 'string') return 'other';
  let u: URL;
  try { u = new URL(/^\d+$/.test(proxy) ? `http://127.0.0.1:${proxy}` : proxy); } catch { return 'other'; } // @silent-fallback-ok — an unparseable target is not ours
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol !== 'http:' || Number(u.port) !== port) return 'other';
  // A Windows `tailscale serve` for a WSL agent may forward to the WSL address; the ping proof
  // (this process's answer + local-TLS arrival) is what establishes identity, not this filter.
  return loopback || isWsl ? 'ours' : 'other';
}

interface ProbeState {
  kind: OwnNameKind;
  host: string;
  source: string;
  inFlight: boolean;
  consecutiveFailures: number;
  nextProbeAt: number;
  lastProbeAt: number | null;
  lastProbeOk: boolean | null;
  lastFailure: string | null;
  stoppedAt: number | null;
  reported: boolean;
}

export interface MobileOwnNamesDeps {
  stateDir: string;
  port: number;
  /** The configured Cloudflare tunnel hostname, read live; null when there is none. */
  tunnelHost: () => string | null;
  /** Hosts of active paired devices (the upgrade seed). */
  activeDeviceHosts: () => string[];
  /** Register a self-issued ping nonce (bypasses the public ping budget). */
  issueNonce: () => string;
  /** The process answer for a nonce. */
  expectedAnswer: (nonce: string) => string;
  /** Another of this agent's machines claims this host (registry check). */
  siblingClaims: (host: string) => boolean;
  pingPath: string;
  /** Whether phone pairing is on right now (read live); probing pauses while it is off. */
  active?: () => boolean;
  exec?: TailscaleExec | null;
  isWsl?: boolean;
  fetchFn?: typeof fetch;
  reportDegradation?: (what: string, err: unknown) => void;
  now?: () => number;
}

/** Reasons that mean "could not tell", never positive evidence that a name is gone. */
const UNKNOWN_REASONS = new Set(['tailscale-command-failed', 'tailscale-status-unparseable', 'tailscale-serve-status-failed', 'tailscale-serve-status-unparseable']);

const key = (kind: OwnNameKind, host: string): string => `${kind}:${host}`;
const KIND_ORDER: Record<OwnNameKind, number> = { tailscale: 0, cloudflare: 1 };

export class MobileOwnNames {
  readonly file: string;
  private data: OwnNamesFile;
  private candidates: Candidate[] = [];
  private candidateProblems: Array<{ kind: OwnNameKind; reason: string }> = [];
  private probes = new Map<string, ProbeState>();
  private lastCandidateRead = -Infinity;
  private refreshing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  serve: { state: ServeState; detail: string | null } = { state: 'unknown', detail: null };
  private now: () => number;

  constructor(private readonly deps: MobileOwnNamesDeps) {
    this.now = deps.now ?? Date.now;
    this.file = path.join(deps.stateDir, 'state', 'mobile-own-names.json');
    const loaded = this.load();
    if (loaded) { this.data = loaded; return; }
    // First boot with this feature: seed the tunnel host when an active phone was paired on it
    // (pairing already proved it with the same ping), so no existing phone is refused.
    this.data = { version: 0, names: [] };
    const tunnel = deps.tunnelHost();
    const seed = tunnel && deps.activeDeviceHosts().map((h) => h.toLowerCase()).includes(tunnel)
      ? [{ kind: 'cloudflare' as const, host: tunnel, firstVerifiedAt: new Date(this.now()).toISOString(), seeded: true }]
      : [];
    try { this.save(seed); } catch (err) { deps.reportDegradation?.('MobileRoutes.ownNamesWrite', err); this.data = { version: this.data.version, names: seed }; }
  }

  private load(): OwnNamesFile | null {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')); } catch { return null; } // @silent-fallback-ok — absent or unreadable file: first boot (the seed rebuilds it)
    const r = raw as Partial<OwnNamesFile>;
    const names = Array.isArray(r.names) ? r.names.filter((n): n is OwnNameRecord =>
      !!n && (n.kind === 'tailscale' || n.kind === 'cloudflare') && typeof n.host === 'string' && normalizeRequestHost(n.host) === n.host && typeof n.firstVerifiedAt === 'string') : [];
    return { version: typeof r.version === 'number' && Number.isFinite(r.version) ? r.version : 0, names };
  }

  /** The name set and its version change together in one atomic write. */
  private save(names: OwnNameRecord[]): void {
    const next: OwnNamesFile = { version: Math.max(this.data.version + 1, this.now()), names };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.data = next;
  }

  private setNames(names: OwnNameRecord[]): void {
    try { this.save(names); } catch (err) {
      // Removal must still take effect in memory (the safe direction); the version still moves.
      this.deps.reportDegradation?.('MobileRoutes.ownNamesWrite', err);
      this.data = { version: Math.max(this.data.version + 1, this.now()), names };
    }
  }

  get version(): number { return this.data.version; }
  listed(): OwnNameRecord[] { return [...this.data.names]; }

  /** Read candidates from local sources only. */
  async readCandidates(): Promise<{ candidates: Candidate[]; problems: Array<{ kind: OwnNameKind; reason: string }>; tailscaleUnknown: boolean }> {
    const r = await this.readCandidatesInner();
    return { ...r, tailscaleUnknown: r.problems.some((p) => UNKNOWN_REASONS.has(p.reason)) };
  }

  private async readCandidatesInner(): Promise<{ candidates: Candidate[]; problems: Array<{ kind: OwnNameKind; reason: string }> }> {
    const candidates: Candidate[] = [];
    const problems: Array<{ kind: OwnNameKind; reason: string }> = [];
    const tunnel = this.deps.tunnelHost();
    if (tunnel) candidates.push({ kind: 'cloudflare', host: tunnel, source: `tunnel:${tunnel}` });
    const exec = this.deps.exec;
    if (!exec) { problems.push({ kind: 'tailscale', reason: 'tailscale-unavailable' }); return { candidates, problems }; }
    let status: string;
    try { status = await exec(['status', '--json']); } catch (err) { // @silent-fallback-ok — reported as the candidate's reason in /health
      // No tailscale binary at all is positive evidence that Tailscale is gone; any other
      // failure (timeout, daemon busy) is "unknown".
      const gone = (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
      problems.push({ kind: 'tailscale', reason: gone ? 'tailscale-not-installed' : 'tailscale-command-failed' });
      this.serve = { state: 'unknown', detail: 'tailscale is not reachable on this machine' };
      return { candidates, problems };
    }
    const self = tailscaleSelfName(status);
    if ('reason' in self) { problems.push({ kind: 'tailscale', reason: self.reason }); return { candidates, problems }; }
    let serveJson: string;
    try { serveJson = await exec(['serve', 'status', '--json']); } catch { // @silent-fallback-ok — reported as the candidate's reason in /health
      problems.push({ kind: 'tailscale', reason: 'tailscale-serve-status-failed' });
      return { candidates, problems };
    }
    const st = serveStateFor(serveJson, self.host, this.deps.port, !!this.deps.isWsl);
    this.serve = { state: st, detail: st === 'other' ? `HTTPS 443 on ${self.host} serves something other than this agent's port ${this.deps.port}; left unchanged.` : null };
    if (st !== 'ours') { problems.push({ kind: 'tailscale', reason: st === 'none' ? 'tailscale-serve-not-configured' : st === 'other' ? 'tailscale-serve-other-target' : 'tailscale-serve-status-unparseable' }); return { candidates, problems }; }
    candidates.push({ kind: 'tailscale', host: self.host, source: `tailscale:${self.host}:${this.deps.port}` });
    return { candidates, problems };
  }

  /** Re-read candidates; a listed name whose source no longer names it leaves at once. */
  async refreshCandidates(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const r = await this.readCandidates();
      this.lastCandidateRead = this.now();
      // A failed or unreadable Tailscale command is "unknown", not "no longer named": keep the
      // Tailscale candidate we had, so a slow CLI never removes a proven name (spec 4.2).
      // After a restart there is no previous candidate yet: the persisted Tailscale own names
      // stand in, so an unknown first read at boot removes nothing either.
      const prevTs = this.candidates.filter((c) => c.kind === 'tailscale');
      const carried = prevTs.length > 0 ? prevTs : this.data.names.filter((n) => n.kind === 'tailscale')
        .map((n) => ({ kind: 'tailscale' as const, host: n.host, source: `tailscale:${n.host}:${this.deps.port}` }));
      const candidates = r.tailscaleUnknown ? [...r.candidates, ...carried] : r.candidates;
      this.applyCandidates(candidates, r.problems);
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  applyCandidates(candidates: Candidate[], problems: Array<{ kind: OwnNameKind; reason: string }>): void {
    this.candidates = candidates;
    this.candidateProblems = problems;
    const live = new Set(candidates.map((c) => key(c.kind, c.host)));
    const kept = this.data.names.filter((n) => live.has(key(n.kind, n.host)));
    if (kept.length !== this.data.names.length) this.setNames(kept);
    for (const k of [...this.probes.keys()]) if (!live.has(k)) this.probes.delete(k);
    for (const c of candidates) {
      const k = key(c.kind, c.host);
      const p = this.probes.get(k);
      if (!p) {
        this.probes.set(k, { kind: c.kind, host: c.host, source: c.source, inFlight: false, consecutiveFailures: 0, nextProbeAt: this.now(), lastProbeAt: null, lastProbeOk: null, lastFailure: null, stoppedAt: null, reported: false });
      } else if (p.source !== c.source) {
        // The source changed: the breaker resets and the name is probed again now.
        Object.assign(p, { source: c.source, consecutiveFailures: 0, nextProbeAt: this.now(), stoppedAt: null, reported: false });
      }
    }
  }

  /** Whether this name is still named by local configuration right now. */
  private currentlyNamed(kind: OwnNameKind, host: string): boolean {
    if (kind === 'cloudflare') return this.deps.tunnelHost() === host;
    return this.candidates.some((c) => c.kind === kind && c.host === host);
  }

  /**
   * Request-time check (spec 4.2): a listed own name still named by local configuration. The
   * caller also requires the request to have arrived through this machine's local TLS front.
   * Outbound probe health never enters this decision.
   */
  accepts(host: string): boolean {
    return this.data.names.some((n) => n.host === host && this.currentlyNamed(n.kind, host));
  }

  /** Probe one candidate now (bounded: one in flight per name). */
  async probe(kind: OwnNameKind, host: string): Promise<void> {
    const p = this.probes.get(key(kind, host));
    if (!p || p.inFlight) return;
    p.inFlight = true;
    try {
      const failure = await this.proveOnce(p);
      p.lastProbeAt = this.now();
      if (failure === null) {
        p.lastProbeOk = true; p.lastFailure = null; p.consecutiveFailures = 0; p.stoppedAt = null; p.reported = false;
        p.nextProbeAt = this.now() + HEALTHY_INTERVAL_MS;
        if (!this.data.names.some((n) => n.kind === kind && n.host === host) && this.currentlyNamed(kind, host)) {
          this.setNames([...this.data.names, { kind, host, firstVerifiedAt: new Date(this.now()).toISOString() }]);
        }
        return;
      }
      p.lastProbeOk = false; p.lastFailure = failure;
      p.consecutiveFailures += 1;
      p.nextProbeAt = this.now() + Math.min(HEALTHY_INTERVAL_MS * 2 ** p.consecutiveFailures, MAX_BACKOFF_MS);
      if (failure === 'another-process') {
        // A different process answers for this name: it is no longer this machine's.
        const kept = this.data.names.filter((n) => !(n.kind === kind && n.host === host));
        if (kept.length !== this.data.names.length) this.setNames(kept);
      }
      if (p.consecutiveFailures >= BREAKER_FAILURES && p.stoppedAt === null) {
        p.stoppedAt = this.now();
        if (!p.reported) {
          p.reported = true;
          this.deps.reportDegradation?.('MobileRoutes.probe', new Error(`${kind} route ${host}: ${BREAKER_FAILURES} probes in a row failed (last: ${failure}); probing paused until its source changes, the next start, or 24 hours`));
        }
      }
    } finally {
      p.inFlight = false;
    }
  }

  /** The extended pairing ping. Null on proof; otherwise the failure reason. */
  private async proveOnce(p: ProbeState): Promise<string | null> {
    if (this.deps.siblingClaims(p.host)) return 'sibling-claims';
    const nonce = this.deps.issueNonce();
    const f = this.deps.fetchFn ?? fetch;
    let status: number; let body: PingProbeBody;
    try {
      const r = await f(`https://${p.host}${this.deps.pingPath}?n=${nonce}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: 'no-store', redirect: 'error' } as RequestInit);
      status = r.status;
      if (!r.ok) return `http-${status}`;
      body = (await r.json()) as PingProbeBody;
    } catch (err) { // @silent-fallback-ok — the reason is the probe's reported health
      return err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'unreachable';
    }
    if (!body || typeof body !== 'object') return 'bad-answer';
    if (body.h !== this.deps.expectedAnswer(nonce)) return typeof body.h === 'string' ? 'another-process' : 'bad-answer';
    if (normalizeRequestHost(body.host) !== p.host || body.host !== p.host) return 'host-not-echoed';
    if (body.arrival !== 'local-tls') return 'not-local-tls';
    return null;
  }

  /** One scheduling pass: refresh candidates when due, then start every due probe. */
  async tick(): Promise<void> {
    if (this.deps.active && !this.deps.active()) return; // phone pairing switched off: nothing to probe
    if (this.now() - this.lastCandidateRead >= CANDIDATE_REFRESH_MS) await this.refreshCandidates();
    const due: Array<Promise<void>> = [];
    for (const p of this.probes.values()) {
      if (p.inFlight) continue;
      if (p.stoppedAt !== null) {
        if (this.now() - p.stoppedAt < BREAKER_RESUME_MS) continue;
        p.stoppedAt = null; p.consecutiveFailures = 0; p.reported = false; p.nextProbeAt = this.now();
      }
      if (p.nextProbeAt <= this.now()) due.push(this.probe(p.kind, p.host));
    }
    await Promise.all(due);
  }

  /** Mint-time: re-read candidates and probe the named host now, so a fresh phone works at once. */
  async proveNow(host: string): Promise<void> {
    await this.refreshCandidates();
    const c = this.candidates.find((x) => x.host === host);
    if (c) await this.probe(c.kind, c.host);
  }

  /**
   * Boot step (spec 4.1): configure HTTPS 443 → this agent's port only when 443 has no serve
   * config; a different existing config is reported, never overwritten. Idempotent.
   */
  async ensureServe(): Promise<ServeState | 'configured' | 'failed'> {
    const exec = this.deps.exec;
    if (!exec) return 'unknown';
    let status: string;
    try { status = await exec(['status', '--json']); } catch { return 'unknown'; } // @silent-fallback-ok — reported by the candidate read in /health
    const self = tailscaleSelfName(status);
    if ('reason' in self) return 'unknown';
    let serveJson: string;
    try { serveJson = await exec(['serve', 'status', '--json']); } catch { return 'unknown'; } // @silent-fallback-ok — reported by the candidate read in /health
    const st = serveStateFor(serveJson, self.host, this.deps.port, !!this.deps.isWsl);
    if (st !== 'none') {
      this.serve = { state: st, detail: st === 'other' ? `HTTPS 443 on ${self.host} serves something other than this agent's port ${this.deps.port}; left unchanged.` : null };
      return st;
    }
    try {
      await exec(['serve', '--bg', '--https=443', `http://${this.deps.isWsl ? 'localhost' : '127.0.0.1'}:${this.deps.port}`]);
    } catch (err) {
      this.serve = { state: 'none', detail: 'configuring tailscale serve for this agent failed' };
      this.deps.reportDegradation?.('MobileRoutes.serve', err);
      return 'failed';
    }
    this.serve = { state: 'ours', detail: null };
    return 'configured';
  }

  start(): void {
    if (this.timer) return;
    void (async () => {
      try {
        if (this.deps.active && !this.deps.active()) return;
        await this.ensureServe(); await this.tick();
      } catch (err) { this.deps.reportDegradation?.('MobileRoutes.probe', err); }
    })();
    this.timer = setInterval(() => { void this.tick().catch((err) => this.deps.reportDegradation?.('MobileRoutes.probe', err)); }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** `GET /mobile/routes`: every listed own name in preference order, whatever its health. */
  routes(): Array<{ kind: OwnNameKind; origin: string; firstVerifiedAt: string; lastProbeOk: boolean | null; lastProbeAt: string | null }> {
    return [...this.data.names].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]).map((n) => {
      const p = this.probes.get(key(n.kind, n.host));
      return { kind: n.kind, origin: `https://${n.host}`, firstVerifiedAt: n.firstVerifiedAt, lastProbeOk: p?.lastProbeOk ?? null, lastProbeAt: p?.lastProbeAt ? new Date(p.lastProbeAt).toISOString() : null };
    });
  }

  /** Bearer `/health` → `mobileRoutes`: own names with health, never-proven candidates, serve state. */
  healthSnapshot(): Record<string, unknown> {
    const listed = new Set(this.data.names.map((n) => key(n.kind, n.host)));
    const health = (k: string) => {
      const p = this.probes.get(k);
      return {
        lastProbeOk: p?.lastProbeOk ?? null, lastProbeAt: p?.lastProbeAt ? new Date(p.lastProbeAt).toISOString() : null,
        lastFailure: p?.lastFailure ?? null, consecutiveFailures: p?.consecutiveFailures ?? 0, probingPaused: p ? p.stoppedAt !== null : false,
      };
    };
    return {
      enabled: true,
      version: this.data.version,
      ownNames: this.data.names.map((n) => ({ kind: n.kind, host: n.host, firstVerifiedAt: n.firstVerifiedAt, ...(n.seeded ? { seeded: true } : {}), ...health(key(n.kind, n.host)) })),
      candidates: [
        ...this.candidates.filter((c) => !listed.has(key(c.kind, c.host))).map((c) => ({ kind: c.kind, host: c.host, ...health(key(c.kind, c.host)) })),
        ...this.candidateProblems.map((p) => ({ kind: p.kind, host: null, lastFailure: p.reason })),
      ],
      tailscaleServe: this.serve,
    };
  }
}
