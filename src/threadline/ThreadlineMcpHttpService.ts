/**
 * ThreadlineMcpHttpService — the Threadline MCP tools served from the agent
 * server over MCP streamable HTTP, on loopback, for the agent's own sessions
 * (docs/specs/threadline-mcp-local-http.md).
 *
 * One object owns everything the route and the launcher share:
 *  - the per-agent local secret (D2) and the route's admission check;
 *  - the per-request tool server (D1): stateless transport, the server's own
 *    live discovery / trust / resume objects, `registry: null`;
 *  - the bounds (D1 "Bounds"): batch refusal, 32/24/4 in-flight caps, slots
 *    held until the work itself settles, the 320 s outcome-unknown answer,
 *    stuck-operation reporting;
 *  - readiness (D4): a real authenticated HTTP self-probe, cached, never awaited
 *    on the spawn path;
 *  - the spawn plan (D3/D4): which transport a new session gets, and why not;
 *  - the `threadline.mcpHttp` block of the authenticated `/health`.
 *
 * The route is mounted whenever Threadline runs; the flag
 * (`threadline.mcpHttp.enabled`, read live) only selects the transport of NEW
 * spawns (D6), so turning it off never cuts off a session already wired to HTTP.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ThreadlineMCPServer } from './ThreadlineMCPServer.js';
import type { SendMessageParams, SendMessageResult } from './ThreadlineMCPServer.js';
import type { AgentDiscovery } from './AgentDiscovery.js';
import type { AgentTrustManager } from './AgentTrustManager.js';
import type { ThreadResumeMap } from './ThreadResumeMap.js';
import {
  sendMessageViaHttp,
  getThreadHistoryViaHttp,
  requestSecretViaHttp,
  startPairingViaHttp,
  createPairingInviteViaHttp,
  createHttpRelayDiscoverer,
  OUTCOME_UNKNOWN_ERROR,
} from './mcp-http-client.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { readClaudeVersion } from '../core/ClaudeBinaryRetainer.js';
import {
  LOCAL_MCP_SECRET_ENV,
  LOCAL_MCP_SECRET_RELPATH,
  READINESS_PROBE_SESSION,
  THREADLINE_MCP_CAPS,
  THREADLINE_MCP_DEADLINES,
  VERIFIED_CLIENT_FLOORS,
  buildClaudeThreadlineHttpEntry,
  buildCodexThreadlineHttpArgs,
  clientVersionAdmitted,
  detectCodexSharedThreadlineEntry,
  ensureClaudeThreadlineHttpConfigFile,
  resolveCodexHome,
  threadlineMcpUrlForListen,
  type ThreadlineMcpSpawnWiring,
  type ThreadlineMcpUrl,
  type ThreadlineSpawnPlan,
  type ThreadlineSpawnRequest,
} from '../core/threadlineMcpSpawn.js';

// ── Local secret (D2) ────────────────────────────────────────────────

const SECRET_HEX_RE = /^[0-9a-f]{64}$/;

export function localMcpSecretPath(stateDir: string): string {
  return path.join(stateDir, LOCAL_MCP_SECRET_RELPATH);
}

/** Read the secret without creating it. Null when absent, unreadable or malformed. */
export function readLocalMcpSecret(stateDir: string): string | null {
  try {
    const raw = fs.readFileSync(localMcpSecretPath(stateDir), 'utf-8').trim();
    return SECRET_HEX_RE.test(raw) ? raw : null;
  } catch {
    return null; // @silent-fallback-ok — absent/unreadable ⇒ no secret; the route then refuses everything
  }
}

/**
 * Read-or-create the secret: 32 random bytes, hex, mode 0600. Creation is
 * atomic and exclusive (temp file + hard link, the lifeline-secret pattern), so
 * a reader never observes a half-written file. A file that could not be READ
 * (as opposed to absent or malformed) is never replaced — this throws.
 */
export function ensureLocalMcpSecret(stateDir: string): string {
  const finalPath = localMcpSecretPath(stateDir);
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(finalPath, 'utf-8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (raw !== null && SECRET_HEX_RE.test(raw)) return raw;
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const value = crypto.randomBytes(32).toString('hex');
  const tmpPath = `${finalPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpPath, value, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmpPath, 0o600);
    if (raw === null) {
      try {
        fs.linkSync(tmpPath, finalPath);
        return value;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const again = readLocalMcpSecret(stateDir);
        if (again) return again; // another process won the race
      }
    }
    // Present and readable but not a secret: replace it.
    fs.renameSync(tmpPath, finalPath);
    return value;
  } finally {
    try {
      if (fs.existsSync(tmpPath)) {
        SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/threadline/ThreadlineMcpHttpService.ts:ensure-secret-tmp-cleanup' });
      }
    } catch {
      // @silent-fallback-ok — best-effort removal of our own private temp file.
    }
  }
}

// ── Admission (D2) ───────────────────────────────────────────────────

export function isLoopbackAddress(addr: string | undefined | null): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export type LocalMcpAdmission =
  | { ok: true }
  | { ok: false; status: 401 | 403; error: string };

/**
 * The route's admission rule. Deterministic; the local secret is the boundary,
 * the rest is defence in depth: loopback peer only, no `Origin`, no
 * `Cf-Connecting-Ip` / `X-Forwarded-For`, then a constant-time compare of
 * `Authorization: Bearer <secret>`. The agent token is NOT accepted here.
 */
export function evaluateLocalMcpAdmission(
  req: { socket?: { remoteAddress?: string | undefined } | null; headers: Record<string, unknown> },
  secret: string | null | undefined,
): LocalMcpAdmission {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    return { ok: false, status: 403, error: 'threadline-mcp-loopback-only' };
  }
  if (req.headers.origin !== undefined) {
    return { ok: false, status: 403, error: 'threadline-mcp-origin-refused' };
  }
  if (req.headers['cf-connecting-ip'] !== undefined || req.headers['x-forwarded-for'] !== undefined) {
    return { ok: false, status: 403, error: 'threadline-mcp-forwarded-refused' };
  }
  const header = req.headers.authorization;
  if (!secret || typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'threadline-mcp-local-secret-required' };
  }
  const ha = crypto.createHash('sha256').update(header.slice(7)).digest();
  const hb = crypto.createHash('sha256').update(secret).digest();
  if (!crypto.timingSafeEqual(ha, hb)) {
    return { ok: false, status: 401, error: 'threadline-mcp-local-secret-required' };
  }
  return { ok: true };
}

// ── Service ──────────────────────────────────────────────────────────

export interface ThreadlineMcpSessionRecord {
  tmuxSession: string;
  framework?: string;
  startedAt?: string;
  status?: string;
  threadlineMcpTransport?: 'http' | 'stdio';
}

export interface ThreadlineMcpReadiness {
  ready: boolean;
  reason: string | null;
  checkedAt: string | null;
  url: string | null;
}

export interface ThreadlineMcpHttpServiceOptions {
  agentName: string;
  stateDir: string;
  projectDir: string;
  /** The server's configured port (inner loopback calls go here, as the helper's do). */
  port: number;
  agentToken: () => string;
  /** `threadline.mcpHttp.enabled`, read live. */
  enabled: () => boolean;
  /** The server's OWN live objects (never second copies, D1). */
  discovery: AgentDiscovery;
  trustManager: AgentTrustManager;
  threadResumeMap: ThreadResumeMap;
  /** The persisted session records (transport counts survive a restart). */
  listSessions?: () => ThreadlineMcpSessionRecord[];
  /** Test seams. */
  sendMessageImpl?: (params: SendMessageParams, originSessionName: string | undefined) => Promise<SendMessageResult>;
  clientVersion?: (framework: string, binaryPath: string) => string | null;
  probe?: (target: ThreadlineMcpUrl, secret: string) => Promise<void>;
  report?: (event: { feature: string; primary: string; fallback: string; reason: string; impact: string }) => void;
  routeAnswerMs?: number;
  stuckAfterMs?: number;
  probeRetryMs?: number;
  now?: () => number;
}

interface InFlightCounts { total: number; waits: number; perSession: Map<string, number> }

const NEVER_CALLED_AFTER_MS = 10 * 60_000;
const CALL_FAILURE_REPORT_INTERVAL_MS = 60 * 60_000;

export class ThreadlineMcpHttpService implements ThreadlineMcpSpawnWiring {
  private readonly opts: ThreadlineMcpHttpServiceOptions;
  private secretValue: string | null;
  private target: ThreadlineMcpUrl | null = null;
  private listenKnown = false;
  private readiness: ThreadlineMcpReadiness = { ready: false, reason: 'not-probed', checkedAt: null, url: null };
  private probing: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private flagWatch: ReturnType<typeof setInterval> | null = null;
  private lastEnabled: boolean | null = null;
  private readonly inFlight: InFlightCounts = { total: 0, waits: 0, perSession: new Map() };
  private stuck = 0;
  private stuckReported = false;
  private readonly firstCallAt = new Map<string, number>();
  private readonly fallbackCounts = new Map<string, Map<string, number>>();
  private readonly noticeCounts = new Map<string, number>();
  private readonly lastCallFailureReport = new Map<string, number>();
  private readonly versionCache = new Map<string, string | null>();
  /** Per-process nonce the service's own readiness probe carries (never persisted, never sent off-host). */
  private readonly probeNonce = crypto.randomBytes(16).toString('hex');
  /** Construction cost of the per-request tool server, sampled (D1: measured). */
  private readonly constructionSamplesMs: number[] = [];

  constructor(opts: ThreadlineMcpHttpServiceOptions) {
    this.opts = opts;
    let secret: string | null = null;
    try {
      secret = ensureLocalMcpSecret(opts.stateDir);
    } catch (err) {
      secret = null;
      this.report('ThreadlineMcpHttp.secret', 'Create the local MCP secret at first boot',
        'The /mcp/threadline route refuses every request; sessions stay on the stdio helper',
        `Why: ${err instanceof Error ? err.message : String(err)}`,
        'No session can use the in-server Threadline tools until the secret file can be created');
    }
    this.secretValue = secret;
  }

  private now(): number { return this.opts.now ? this.opts.now() : Date.now(); }

  private report(feature: string, primary: string, fallback: string, reason: string, impact: string): void {
    try {
      if (this.opts.report) this.opts.report({ feature, primary, fallback, reason, impact });
      else DegradationReporter.getInstance().report({ feature, primary, fallback, reason, impact });
    } catch {
      // @silent-fallback-ok — reporting must never break a request or a spawn
    }
  }

  /** The secret currently on disk (re-read when the cache is empty: a deleted-and-restarted file). */
  secret(): string | null {
    if (!this.secretValue) this.secretValue = readLocalMcpSecret(this.opts.stateDir);
    return this.secretValue;
  }

  private isEnabled(): boolean {
    try { return this.opts.enabled() === true; } catch { return false; /* @silent-fallback-ok — unreadable flag ⇒ off (stdio) */ }
  }

  // ── Admission (shared by the middleware rule and the handler) ──────

  /**
   * The exact-path middleware rule (placed FIRST in authMiddleware). Writes the
   * refusal itself and returns false, or returns true to continue.
   */
  admit(req: Request, res: Response): boolean {
    const verdict = evaluateLocalMcpAdmission(req, this.secret());
    if (verdict.ok) return true;
    if (verdict.status === 401) this.noteCallFailure(headerString(req, 'x-instar-session'), 'authentication-failed');
    res.status(verdict.status).json({ error: verdict.error });
    return false;
  }

  // ── Route handler (D1) ─────────────────────────────────────────────

  async handle(req: Request, res: Response): Promise<void> {
    // Repeated in full: Express matches routes case-insensitively and ignores a
    // trailing slash, so `/MCP/threadline/` reaches here without the exact-path rule.
    if (!this.admit(req, res)) return;
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
      return;
    }
    const body = req.body as unknown;
    if (Array.isArray(body)) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'JSON-RPC batches are not accepted.' }, id: null });
      return;
    }
    if (!body || typeof body !== 'object') {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: a JSON-RPC object is required.' }, id: null });
      return;
    }
    const sessionName = headerString(req, 'x-instar-session') ?? '';
    // The probe's exemptions (per-session cap, first-call record) need the
    // service's own per-process nonce, not just the reserved session name, so a
    // caller cannot claim them by naming itself `__readiness-probe`.
    const isProbe = sessionName === READINESS_PROBE_SESSION
      && constantTimeEqual(headerString(req, PROBE_NONCE_HEADER), this.probeNonce);
    const msg = body as { method?: unknown; params?: { name?: unknown; arguments?: { waitForReply?: unknown } } };
    const isWait = msg.method === 'tools/call' && msg.params?.name === 'threadline_send'
      && msg.params?.arguments?.waitForReply === true;

    // ── In-flight caps ──
    const sessionKey = sessionName || '(none)';
    const perSession = this.inFlight.perSession.get(sessionKey) ?? 0;
    const capRefusal =
      this.inFlight.total >= THREADLINE_MCP_CAPS.global ? 'global'
        : isWait && this.inFlight.waits >= THREADLINE_MCP_CAPS.waits ? 'waits'
          : !isProbe && perSession >= THREADLINE_MCP_CAPS.perSession ? 'per-session'
            : null;
    if (capRefusal) {
      res.setHeader('Retry-After', '5');
      res.status(429).json({ jsonrpc: '2.0', error: { code: -32000, message: `Too many Threadline tool calls in flight (${capRefusal} cap); retry shortly.` }, id: null });
      return;
    }
    this.inFlight.total++;
    if (isWait) this.inFlight.waits++;
    if (!isProbe) this.inFlight.perSession.set(sessionKey, perSession + 1);

    // A slot is held until the response has closed AND every operation the
    // request started has settled — never merely because the client went away.
    const slot = { pending: 0, closed: false, released: false };
    let toolServer: ThreadlineMCPServer | null = null;
    let transport: StreamableHTTPServerTransport | null = null;
    const tryRelease = (): void => {
      if (slot.released || !slot.closed || slot.pending > 0) return;
      slot.released = true;
      this.inFlight.total--;
      if (isWait) this.inFlight.waits--;
      if (!isProbe) {
        const n = (this.inFlight.perSession.get(sessionKey) ?? 1) - 1;
        if (n <= 0) this.inFlight.perSession.delete(sessionKey);
        else this.inFlight.perSession.set(sessionKey, n);
      }
      void transport?.close().catch(() => { /* @silent-fallback-ok — closing a finished transport */ });
      // The per-request server is connected, never start()ed, so close the
      // underlying MCP server directly (ThreadlineMCPServer.stop() is a no-op here).
      void toolServer?.getServer().close().catch(() => { /* @silent-fallback-ok — closing a finished server */ });
    };
    const track = <T>(work: Promise<T>): Promise<T> => {
      slot.pending++;
      let markedStuck = false;
      const timer = setTimeout(() => {
        markedStuck = true;
        this.stuck++;
        if (!this.stuckReported) {
          this.stuckReported = true;
          this.report('ThreadlineMcpHttp.stuck', 'Every Threadline tool call settles within the client tool timeout',
            'A call is still running past 360 s; its capacity slot is kept (not freed) until it settles',
            'Why: a dependency behind a Threadline tool (discovery, pairing, the server) is not answering',
            'Capacity on /mcp/threadline shrinks visibly; see threadline.mcpHttp.stuckOperations on /health');
        }
      }, this.opts.stuckAfterMs ?? THREADLINE_MCP_DEADLINES.clientToolMs);
      timer.unref?.();
      const settle = (): void => {
        clearTimeout(timer);
        if (markedStuck) this.stuck--;
        slot.pending--;
        tryRelease();
      };
      work.then(settle, settle);
      return work;
    };
    res.on('close', () => { slot.closed = true; tryRelease(); });
    // A client that went away before this handler ran has already fired 'close'
    // (it fires once), so the slot would never be released: mark it closed now.
    if (res.destroyed || res.writableEnded || req.socket?.destroyed) {
      slot.closed = true;
      tryRelease();
      return; // nobody to answer: build no tool server, start no work outside the caps
    }
    res.on('finish', () => {
      if (isProbe) return;
      if (res.statusCode >= 200 && res.statusCode < 300) {
        if (sessionName && !this.firstCallAt.has(sessionName)) this.firstCallAt.set(sessionName, this.now());
      } else if (res.statusCode >= 500) {
        this.noteCallFailure(sessionName, `http-${res.statusCode}`);
      }
    });

    try {
      const started = process.hrtime.bigint();
      toolServer = this.buildToolServer(sessionName, track);
      this.recordConstruction(Number(process.hrtime.bigint() - started) / 1e6);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableDnsRebindingProtection: true,
        allowedHosts: this.target ? [this.target.hostHeader] : [],
      });
      await toolServer.getServer().connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      } else if (!res.writableEnded) {
        res.end();
      }
      console.warn(`[threadline-mcp-http] request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private buildToolServer(sessionName: string, track: <T>(work: Promise<T>) => Promise<T>): ThreadlineMCPServer {
    const port = this.opts.port;
    const token = (): string => this.opts.agentToken() ?? '';
    const origin = sessionName && sessionName !== READINESS_PROBE_SESSION ? sessionName : undefined;
    const sendImpl = this.opts.sendMessageImpl
      ?? ((params: SendMessageParams, name: string | undefined) => sendMessageViaHttp(params, port, token(), name));
    const routeAnswerMs = this.opts.routeAnswerMs ?? THREADLINE_MCP_DEADLINES.routeAnswerMs;
    const server = new ThreadlineMCPServer(
      { agentName: this.opts.agentName, protocolVersion: '1.0', transport: 'streamable-http', requireAuth: false },
      {
        discovery: this.opts.discovery,
        threadResumeMap: this.opts.threadResumeMap,
        trustManager: this.opts.trustManager,
        auth: null,
        // The send keeps running past the route's own answer (a message may
        // already be on its way); its slot is held until it settles.
        sendMessage: (params) => {
          const inner = track(sendImpl(params, origin));
          inner.catch(() => { /* @silent-fallback-ok — observed by the race below */ });
          return raceDeadline(inner, routeAnswerMs, () => ({
            success: false,
            threadId: params.threadId ?? '',
            messageId: '',
            error: OUTCOME_UNKNOWN_ERROR,
            outcomeUnknown: true,
          }));
        },
        getThreadHistory: (threadId, limit, before) => track(getThreadHistoryViaHttp(threadId, limit, port, token(), before)),
        requestSecret: (params) => track(requestSecretViaHttp(params, port)),
        startPairing: (peerFp) => track(startPairingViaHttp(peerFp, port, token())),
        createInvite: (o) => track(createPairingInviteViaHttp(o, port, token())),
        // Shared live trust manager: never reload from disk (a reload could drop debounced writes).
        reloadTrustBeforePairingRead: false,
        // Exact parity with today's helper, whose registry login always fails (D1).
        registry: null,
        relayClient: createHttpRelayDiscoverer(port, token),
        stateDir: this.opts.stateDir,
        toolCallTracker: (_name, run) => track(run()),
      },
    );
    // The caller is one of the agent's own sessions: the local-operator view the
    // stdio helper gives today. Not raised, not lowered.
    server.setRequestContext({ authenticated: true, isLocal: true });
    return server;
  }

  private recordConstruction(ms: number): void {
    if (this.constructionSamplesMs.length >= 64) this.constructionSamplesMs.shift();
    this.constructionSamplesMs.push(ms);
  }

  /** Median per-request tool-server construction cost, ms (null before any request). */
  constructionMedianMs(): number | null {
    if (this.constructionSamplesMs.length === 0) return null;
    const sorted = [...this.constructionSamplesMs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  private noteCallFailure(sessionName: string | null | undefined, reason: string): void {
    if (!sessionName || sessionName === READINESS_PROBE_SESSION) return;
    const record = this.sessionRecords()?.find((s) => s.tmuxSession === sessionName);
    if (!record || record.threadlineMcpTransport !== 'http') return; // only a wired session
    const framework = record.framework ?? 'unknown';
    const last = this.lastCallFailureReport.get(framework) ?? -Infinity;
    if (this.now() - last < CALL_FAILURE_REPORT_INTERVAL_MS) return;
    this.lastCallFailureReport.set(framework, this.now());
    this.report('ThreadlineMcpHttp.callFailure', 'An HTTP-wired session reaches its Threadline tools on /mcp/threadline',
      'The session\'s tool calls fail until it is restarted (it then gets a fresh wiring)',
      `Why: ${framework} session request ${reason}`,
      'That session cannot use threadline_* tools; restart it, or switch threadline.mcpHttp.enabled off');
  }

  // ── Listen / readiness (D4) ────────────────────────────────────────

  /** Called once the server listener is up (and again if the address changes). */
  onListening(listenHost: string | undefined, port: number): void {
    const next = threadlineMcpUrlForListen(listenHost, port);
    const changed = !this.listenKnown || next?.url !== this.target?.url;
    this.listenKnown = true;
    this.target = next;
    if (changed) void this.runProbe();
    if (!this.flagWatch) {
      // The flag is read live; a false→true switch re-probes (a spawn never waits on it).
      this.flagWatch = setInterval(() => this.noteEnabled(this.isEnabled()), 30_000);
      this.flagWatch.unref?.();
    }
    this.lastEnabled = this.isEnabled();
  }

  private noteEnabled(enabled: boolean): void {
    const was = this.lastEnabled;
    this.lastEnabled = enabled;
    if (enabled && was === false && this.listenKnown) void this.runProbe();
  }

  /** Run one self-probe now (also the boot probe). Never throws. */
  runProbe(): Promise<void> {
    if (this.probing) return this.probing;
    this.probing = (async () => {
      const target = this.target;
      const at = new Date(this.now()).toISOString();
      try {
        if (!this.listenKnown) throw new ProbeFailure('not-listening');
        if (!target) throw new ProbeFailure('not-listening-on-loopback');
        const secret = this.secret();
        if (!secret) throw new ProbeFailure('no-local-secret');
        await (this.opts.probe ?? defaultProbe(this.opts.agentName, this.probeNonce))(target, secret);
        this.readiness = { ready: true, reason: null, checkedAt: at, url: target.url };
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
      } catch (err) {
        const reason = err instanceof ProbeFailure ? err.reason : `probe-failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
        this.readiness = { ready: false, reason, checkedAt: at, url: target?.url ?? null };
        if (!this.retryTimer) {
          this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.runProbe(); }, this.opts.probeRetryMs ?? 5 * 60_000);
          this.retryTimer.unref?.();
        }
      } finally {
        this.probing = null;
      }
    })();
    return this.probing;
  }

  readinessSnapshot(): ThreadlineMcpReadiness { return { ...this.readiness }; }

  stop(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.flagWatch) clearInterval(this.flagWatch);
    this.retryTimer = null;
    this.flagWatch = null;
  }

  // ── Spawn plan (D3/D4) ─────────────────────────────────────────────

  planSpawn(req: ThreadlineSpawnRequest): ThreadlineSpawnPlan {
    const enabled = this.isEnabled();
    this.noteEnabled(enabled);
    if (!enabled) return { transport: 'stdio', reason: 'flag-off', secretEnvFlags: [] };
    const secret = this.secret();
    // Sessions spawned while the flag is on receive the secret; a stripped one gets it blanked.
    const secretEnvFlags = ['-e', `${LOCAL_MCP_SECRET_ENV}=${req.stripped || !secret ? '' : secret}`];
    if (req.stripped) return { transport: 'stdio', reason: 'stripped', secretEnvFlags };
    if (!VERIFIED_CLIENT_FLOORS[req.framework]) return { transport: 'stdio', reason: 'framework-unsupported', secretEnvFlags };
    const fallback = (reason: string): ThreadlineSpawnPlan => {
      this.noteFallback(req.framework, reason);
      return { transport: 'stdio', reason, secretEnvFlags };
    };
    const version = req.knownVersion ?? this.clientVersion(req.framework, req.binaryPath);
    if (!clientVersionAdmitted(req.framework, version)) return fallback('unverified-client-version');
    if (!secret) return fallback('no-local-secret');
    if (!this.readiness.ready || !this.target) return fallback(this.readiness.reason ?? 'not-ready');
    const url = this.target.url;
    if (req.framework === 'claude-code') {
      let claudeConfigPath: string;
      try {
        claudeConfigPath = ensureClaudeThreadlineHttpConfigFile(this.opts.stateDir, url);
      } catch {
        return fallback('config-write-failed');
      }
      return { transport: 'http', url, claudeConfigPath, claudeEntry: buildClaudeThreadlineHttpEntry(url), secretEnvFlags };
    }
    const shared = detectCodexSharedThreadlineEntry(resolveCodexHome(req.codexHome), this.opts.projectDir);
    if (shared === 'suspect') this.noteOnce('codex-shared-entry-not-disabled');
    return { transport: 'http', url, codexArgs: buildCodexThreadlineHttpArgs(url, shared === 'present'), secretEnvFlags };
  }

  private clientVersion(framework: string, binaryPath: string): string | null {
    const key = `${framework}\0${binaryPath}`;
    if (this.versionCache.has(key)) return this.versionCache.get(key) ?? null;
    let version: string | null = null;
    try {
      if (this.opts.clientVersion) {
        version = this.opts.clientVersion(framework, binaryPath);
      } else if (framework === 'claude-code') {
        let real = binaryPath;
        try { real = fs.realpathSync(binaryPath); } catch { /* @silent-fallback-ok — read the path as given */ }
        version = readClaudeVersion(real).version;
      } else if (framework === 'codex-cli') {
        const out = execFileSync(binaryPath, ['--version'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
        version = /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
      }
    } catch {
      version = null; // @silent-fallback-ok — unreadable ⇒ stdio + unverified-client-version
    }
    // Only a successful read is cached: one transient failure must not pin this
    // binary to stdio for the life of the process.
    if (version !== null) this.versionCache.set(key, version);
    return version;
  }

  private noteFallback(framework: string, reason: string): void {
    let byReason = this.fallbackCounts.get(framework);
    if (!byReason) { byReason = new Map(); this.fallbackCounts.set(framework, byReason); }
    const n = (byReason.get(reason) ?? 0) + 1;
    byReason.set(reason, n);
    if (n === 1) {
      this.report('ThreadlineMcpHttp.fallback', 'A flagged spawn gets the in-server Threadline MCP over local HTTP',
        'The session uses the stdio Threadline helper (today\'s behaviour); tools work',
        `Why: ${framework} ${reason}`,
        'One helper process per session for this framework until the reason clears; counted in threadline.mcpHttp.fallbacks');
    }
  }

  private noteOnce(notice: string): void {
    const n = (this.noticeCounts.get(notice) ?? 0) + 1;
    this.noticeCounts.set(notice, n);
    if (n === 1 && notice === 'codex-shared-entry-not-disabled') {
      this.report('ThreadlineMcpHttp.codexSharedEntry', 'A Codex HTTP session sees the Threadline tools once',
        'The shared ~/.codex stdio threadline entry may run beside threadline_local (duplicate tools, both work)',
        'Why: the shared config names a threadline table the parser could not confirm (or a project-scope .codex/config.toml does)',
        'One extra helper process per Codex session; fix or remove the shared entry');
    }
  }

  // ── Health ─────────────────────────────────────────────────────────

  private sessionRecords(): ThreadlineMcpSessionRecord[] | null {
    if (!this.opts.listSessions) return null;
    try { return this.opts.listSessions(); } catch { return null; /* @silent-fallback-ok — unmeasurable ⇒ null */ }
  }

  health(): Record<string, unknown> {
    const records = this.sessionRecords();
    const live = records?.filter((s) => s.status === undefined || s.status === 'running' || s.status === 'starting') ?? null;
    const onHttp = live?.filter((s) => s.threadlineMcpTransport === 'http') ?? null;
    const now = this.now();
    const fallbacks: Record<string, Record<string, number>> = {};
    for (const [fw, byReason] of this.fallbackCounts) fallbacks[fw] = Object.fromEntries(byReason);
    return {
      enabled: this.isEnabled(),
      sessionsOnHttp: onHttp ? onHttp.length : null,
      sessionsOnStdio: live ? live.filter((s) => s.threadlineMcpTransport === 'stdio').length : null,
      sessionsOnHttpNeverCalled: onHttp
        ? onHttp.filter((s) => {
            const started = s.startedAt ? Date.parse(s.startedAt) : NaN;
            return Number.isFinite(started) && now - started > NEVER_CALLED_AFTER_MS && !this.firstCallAt.has(s.tmuxSession);
          }).length
        : null,
      fallbacks,
      notices: Object.fromEntries(this.noticeCounts),
      stuckOperations: this.stuck,
      inFlight: { total: this.inFlight.total, waits: this.inFlight.waits },
      readiness: this.readinessSnapshot(),
      constructionMedianMs: this.constructionMedianMs(),
    };
  }
}

class ProbeFailure extends Error {
  constructor(readonly reason: string) { super(reason); }
}

const PROBE_NONCE_HEADER = 'x-instar-readiness-probe';

function constantTimeEqual(a: string | null, b: string): boolean {
  if (a === null) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function headerString(req: { headers: Record<string, unknown> }, name: string): string | null {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t.length > 0 && t.length <= 256 ? t : null;
}

function raceDeadline<T>(work: Promise<T>, ms: number, onDeadline: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(onDeadline()), ms);
    timer.unref?.();
    work.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * The real readiness probe: an authenticated `initialize`, `tools/list` and one
 * read-only call (`threadline_agents`) to the exact URL the client configs
 * carry, with the clients' own headers — so it exercises middleware order, the
 * route's body parser, `allowedHosts` and the shared dependencies.
 */
function defaultProbe(agentName: string, probeNonce: string) {
  return async (target: ThreadlineMcpUrl, secret: string): Promise<void> => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const transport = new StreamableHTTPClientTransport(new URL(target.url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${secret}`,
          'X-Instar-Session': READINESS_PROBE_SESSION,
          'X-Instar-AgentId': agentName,
          [PROBE_NONCE_HEADER]: probeNonce,
        },
      },
    });
    const client = new Client({ name: 'instar-threadline-readiness-probe', version: '1.0.0' });
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error('probe timed out after 20 s')), 20_000);
      t.unref?.();
    });
    try {
      await Promise.race([
        (async () => {
          await client.connect(transport);
          const tools = await client.listTools();
          const names = new Set(tools.tools.map((t) => t.name));
          if (!names.has('threadline_send') || !names.has('threadline_agents')) {
            throw new Error('tools/list is missing threadline_send or threadline_agents');
          }
          const result = await client.callTool({ name: 'threadline_agents', arguments: {} });
          if ((result as { isError?: boolean }).isError) throw new Error('threadline_agents returned an error');
        })(),
        timeout,
      ]);
    } finally {
      await client.close().catch(() => { /* @silent-fallback-ok — closing the probe client */ });
    }
  };
}
