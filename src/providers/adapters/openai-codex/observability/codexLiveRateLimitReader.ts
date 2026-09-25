/**
 * Live codex account rate-limit reader — the ZERO-SPEND path.
 *
 * The rollout tail reader (`codexRateLimitReader.ts`) can only report what the
 * account's last completed turn wrote, so an idle account serves a days-old
 * number and a WALLED account serves nothing at all (no turn completes, so no
 * `codex`-family record is ever written — the dawn@ case, 2026-09-20).
 *
 * The codex CLI's app-server protocol exposes the same call its own `/status`
 * screen uses: `account/rateLimits/read`, a metadata fetch answered by OpenAI's
 * backend WITHOUT running a model turn. No tokens, no quota, ~0.5-1.2s per
 * account measured live across five accounts. This module spawns
 * `codex app-server` against the account's CODEX_HOME, performs the JSON-RPC
 * initialize handshake, reads the limits once, and kills the child.
 *
 * It maps the response into the SAME `CodexUsageSnapshot` shape the rollout
 * reader produces, so consumers are source-agnostic. `source` distinguishes
 * provenance (`codex-app-server` vs `codex-rollout`).
 *
 * RULE 3.1 RATIONALE
 *   Criticality: high (cost-routing / model-swap input)
 *   Frequency:   per-poll (default 15 min cadence per account)
 *   Stability:   semi-stable (experimental app-server protocol; the v2 method
 *                name + response shape are pinned here and any drift degrades
 *                to null → the caller falls back to the rollout reader)
 *   Fallback:    return null on ANY failure (missing binary, spawn error,
 *                timeout, protocol error, unparseable output) — the caller
 *                falls back to the rollout tail, i.e. worst case is exactly
 *                yesterday's behaviour
 *   Verdict:     deterministic protocol exchange; never throws
 */

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CodexRateWindow, CodexUsageSnapshot } from './codexRateLimitReader.js';

export interface ReadLiveCodexRateLimitsOptions {
  /** Override $CODEX_HOME (defaults to the process env / ~/.codex). */
  codexHome?: string;
  /** Hard deadline for the whole exchange (spawn → answer). Default 10s. */
  timeoutMs?: number;
  /** Clock for deriving `resetsInSeconds` + `capturedAt` (defaults to Date.now()). */
  nowMs?: number;
  /** Injected for tests; defaults to spawning the real `codex` binary. */
  spawnImpl?: (
    cmd: string,
    args: string[],
    opts: { env: NodeJS.ProcessEnv },
  ) => ChildProcessWithoutNullStreams;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const UNAVAILABLE = { kind: 'unavailable' } as const;

/** The subset of the app-server v2 `RateLimitSnapshot` this reader consumes. */
interface LiveRateLimitSnapshot {
  limitId?: string | null;
  primary?: LiveRateWindow | null;
  secondary?: LiveRateWindow | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
}

interface LiveRateWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

/**
 * The live read with its failure KIND kept (spec skill-driven-signin-repair): `auth-failed`
 * is the app-server's own "authentication required" refusal — the only failure that says
 * anything about the login. Every other failure (binary missing, spawn error, timeout,
 * protocol drift) is `unavailable`: a transport problem, never evidence of sign-out.
 */
export type CodexLiveRead =
  | { kind: 'ok'; snapshot: CodexUsageSnapshot }
  | { kind: 'auth-failed' }
  | { kind: 'unavailable' };

/** True when an app-server JSON-RPC error names missing/invalid authentication. Exported for tests. */
export function isCodexAuthError(error: unknown): boolean {
  const message = error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message : '';
  return /authenticat|not logged in|log ?in required|login required|unauthori[sz]ed|invalid.*(token|auth)|auth.*(expired|invalid|required)/i
    .test(message);
}

/**
 * Read the account's LIVE rate limits through `codex app-server` — zero quota
 * spend. Returns null on any failure so the caller can fall back to the
 * rollout-tail reader; never throws.
 */
export async function readLiveCodexRateLimits(
  opts: ReadLiveCodexRateLimitsOptions = {},
): Promise<CodexUsageSnapshot | null> {
  const read = await readLiveCodexRateLimitsDetailed(opts);
  return read.kind === 'ok' ? read.snapshot : null;
}

/** As {@link readLiveCodexRateLimits}, but keeps WHY a read failed. Never throws. */
export async function readLiveCodexRateLimitsDetailed(
  opts: ReadLiveCodexRateLimitsOptions = {},
): Promise<CodexLiveRead> {
  const nowMs = opts.nowMs ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnImpl = opts.spawnImpl ?? ((cmd, args, o) => spawn(cmd, args, { ...o, stdio: 'pipe' }));

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnImpl('codex', ['app-server'], {
      env: {
        ...process.env,
        ...(opts.codexHome ? { CODEX_HOME: opts.codexHome } : {}),
      },
    });
  } catch {
    return UNAVAILABLE;
  }

  return new Promise<CodexLiveRead>((resolve) => {
    let settled = false;
    let stdoutBuf = '';

    const finish = (value: CodexLiveRead): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try {
        child.kill();
      } catch {
        // @silent-fallback-ok: child already gone — nothing to clean up
      }
      resolve(value);
    };

    const deadline = setTimeout(() => finish(UNAVAILABLE), timeoutMs);
    // The exchange must never outlive its caller because the timer forgot to
    // fire (e.g. a fake timer environment): unref so a leaked child cannot pin
    // the event loop either way.
    deadline.unref?.();

    const send = (payload: Record<string, unknown>): void => {
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch {
        finish(UNAVAILABLE);
      }
    };

    child.on('error', () => finish(UNAVAILABLE));
    child.on('exit', () => finish(UNAVAILABLE));
    child.stderr?.on('data', () => {
      // Drained so the child can never block on a full stderr pipe. Content is
      // deliberately ignored: any protocol failure surfaces as a null result.
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      let newlineIdx: number;
      while ((newlineIdx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, newlineIdx);
        stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // non-protocol chatter on stdout — ignore
        }
        if (msg.id === 1) {
          if (msg.error) {
            finish(UNAVAILABLE);
            return;
          }
          send({ jsonrpc: '2.0', method: 'initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) {
            finish(isCodexAuthError(msg.error) ? { kind: 'auth-failed' } : UNAVAILABLE);
            return;
          }
          if (!msg.result) {
            finish(UNAVAILABLE);
            return;
          }
          const snapshot = mapLiveResponse(msg.result as Record<string, unknown>, nowMs);
          finish(snapshot ? { kind: 'ok', snapshot } : UNAVAILABLE);
          return;
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'instar-quota-poller', title: 'Instar quota poller', version: '1' },
      },
    });
  });
}

/**
 * Composition-root factory: the production live reader, honoring the
 * `subscriptionPool.codexLiveQuota` rollback lever (`false` → null → callers
 * stay rollout-only). Defaults to ENABLED. This exists so the real
 * subprocess-spawning implementation is injected exactly once (server
 * composition) and never becomes a hidden default inside QuotaPoller or a
 * route — unit and integration tests that build those without injecting a
 * reader stay hermetic (no real `codex` spawn, no network).
 */
export function buildCodexLiveUsageReader(
  subscriptionPool?: { codexLiveQuota?: boolean },
): ((opts?: { codexHome?: string; nowMs?: number }) => Promise<CodexUsageSnapshot | null>) | null {
  if (subscriptionPool?.codexLiveQuota === false) return null;
  return (opts) => readLiveCodexRateLimits({ codexHome: opts?.codexHome, nowMs: opts?.nowMs });
}

/**
 * The same composition-root factory for the DETAILED live read (spec skill-driven-signin-repair):
 * the quota poller uses it so an app-server "authentication required" refusal is told apart
 * from a transport failure. Honors the same `codexLiveQuota: false` rollback lever.
 */
export function buildCodexLiveUsageReaderDetailed(
  subscriptionPool?: { codexLiveQuota?: boolean },
): ((opts?: { codexHome?: string; nowMs?: number }) => Promise<CodexLiveRead>) | null {
  if (subscriptionPool?.codexLiveQuota === false) return null;
  return (opts) => readLiveCodexRateLimitsDetailed({ codexHome: opts?.codexHome, nowMs: opts?.nowMs });
}

/**
 * Map an `account/rateLimits/read` result into the rollout reader's snapshot
 * shape. Exported for unit tests. Returns null when the response carries no
 * codex-family bucket at all; returns a `windowsUnavailable` snapshot when the
 * codex bucket exists but reports no window (entitlement/credits-only account).
 */
export function mapLiveResponse(
  result: Record<string, unknown>,
  nowMs: number,
): CodexUsageSnapshot | null {
  // Prefer the multi-bucket view keyed by limit_id; fall back to the
  // backward-compatible single-bucket `rateLimits` when it is codex-family.
  const byId = result.rateLimitsByLimitId as Record<string, LiveRateLimitSnapshot> | null | undefined;
  let bucket: LiveRateLimitSnapshot | null = null;
  if (byId && typeof byId === 'object' && byId.codex && typeof byId.codex === 'object') {
    bucket = byId.codex;
  } else {
    const single = result.rateLimits as LiveRateLimitSnapshot | null | undefined;
    if (single && typeof single === 'object') {
      const limitId = single.limitId;
      // Same family rule as the rollout reader: absent limitId counts as codex.
      if (limitId === undefined || limitId === null || limitId === 'codex') bucket = single;
    }
  }
  if (!bucket) return null;

  const primary = mapWindow(bucket.primary, nowMs);
  const secondary = mapWindow(bucket.secondary, nowMs);
  const snapshot: CodexUsageSnapshot = {
    source: 'codex-app-server',
    rolloutPath: '',
    threadId: null,
    capturedAt: new Date(nowMs).toISOString(),
    model: null,
    planType: typeof bucket.planType === 'string' ? bucket.planType : null,
    rateLimitReachedType:
      typeof bucket.rateLimitReachedType === 'string' ? bucket.rateLimitReachedType : null,
    primary,
    secondary,
  };
  if (!primary && !secondary) snapshot.windowsUnavailable = true;
  return snapshot;
}

function mapWindow(raw: LiveRateWindow | null | undefined, nowMs: number): CodexRateWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const usedPercent = typeof raw.usedPercent === 'number' ? raw.usedPercent : null;
  const windowMinutes = typeof raw.windowDurationMins === 'number' ? raw.windowDurationMins : null;
  const resetsAt = typeof raw.resetsAt === 'number' ? raw.resetsAt : null;
  if (usedPercent === null || windowMinutes === null || resetsAt === null) return null;
  const validReset = Number.isFinite(resetsAt) && resetsAt > 0;
  return {
    usedPercent,
    remainingPercent: Math.min(100, Math.max(0, 100 - usedPercent)),
    windowMinutes,
    resetsAt,
    resetsAtIso: validReset ? new Date(resetsAt * 1000).toISOString() : null,
    resetsInSeconds: validReset ? Math.round((resetsAt * 1000 - nowMs) / 1000) : null,
  };
}
