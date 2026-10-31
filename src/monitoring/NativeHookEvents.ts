/**
 * Native hook events ingest (docs/specs/native-hook-events.md D1).
 *
 * Claude Code `type: "http"` hooks POST their RAW event body — which includes
 * full tool output (megabytes, possibly secrets) — to `/hooks/native-events`.
 * This module:
 *
 *   1. admits a request BEFORE its body is parsed (loopback only, no
 *      forwarding headers, empty credential ⇒ quiet 204, wrong token ⇒ 401,
 *      oversized ⇒ 413) — `admissionGuard` + `bodyParser`, mounted ahead of
 *      the server's global parser;
 *   2. projects the raw body onto a typed, bounded schema (`projectNativeHookEvent`)
 *      — the raw body never reaches storage or any consumer;
 *   3. hands the projected event to a bounded in-memory queue drained by one
 *      worker (≤ 50 events or 10 ms per turn, then `setImmediate`), so the
 *      route answers 204 at once and other server work always interleaves.
 *
 * Delivery is best-effort: a 204 does not prove the event was stored. The
 * counters distinguish admitted, stored and failed-processing events.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { redact } from '../messaging/secret-patterns.js';
import { NATIVE_REPORTER_EVENTS } from '../data/http-hook-templates.js';
import type { HookEventPayload } from './HookEventReceiver.js';

export const NATIVE_HOOK_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
export const NATIVE_HOOK_QUEUE_MAX = 1000;
export const NATIVE_HOOK_DRAIN_MAX_EVENTS = 50;
export const NATIVE_HOOK_DRAIN_MAX_MS = 10;
export const NATIVE_HOOK_TEXT_TAIL_CHARS = 200;

/** The commit test the `/hooks/events` route has always used. */
export const GIT_COMMIT_RE = /git\s+commit\b/;

// ── Projection ──────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const EVENTS = new Set<string>(NATIVE_REPORTER_EVENTS);

function asId(v: unknown): string | undefined {
  return typeof v === 'string' && ID_RE.test(v) ? v : undefined;
}
function asName(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= 128 ? v : undefined;
}
function asPath(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= 1024 && path.isAbsolute(v) ? v : undefined;
}
function asShort(v: unknown): string | undefined {
  return typeof v === 'string' && v.length <= 64 ? v : undefined;
}
/** Redact on the FULL text, then keep the last 200 characters. */
export function redactThenTail(v: string, tail = NATIVE_HOOK_TEXT_TAIL_CHARS): string {
  const red = redact(v);
  return red.length > tail ? red.slice(red.length - tail) : red;
}

export interface NativeProjectionHeaders {
  instarSessionId?: string;
  instarSession?: string;
}

export interface NativeProjection {
  /** null when a key field failed its bound — the whole event is dropped. */
  event: HookEventPayload | null;
  malformedFields: number;
}

/**
 * Project a raw Claude Code hook body onto the stored schema. Only the fields
 * in the spec's table survive, each with its type and bound; anything else
 * (tool_response, every other tool_input field, unknown keys) is dropped.
 */
export function projectNativeHookEvent(raw: unknown, headers: NativeProjectionHeaders): NativeProjection {
  let malformed = 0;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { event: null, malformedFields: 0 };
  const r = raw as Record<string, unknown>;

  const eventName = typeof r.hook_event_name === 'string' && EVENTS.has(r.hook_event_name) ? r.hook_event_name : undefined;
  const sessionId = asId(r.session_id);
  const instarSid = asId(headers.instarSessionId);
  if (!eventName || !sessionId || !instarSid) return { event: null, malformedFields: 0 };

  const out: HookEventPayload = { event: eventName, session_id: sessionId, instar_session_id: instarSid };

  const take = (key: string, value: unknown, check: (v: unknown) => unknown): void => {
    if (value === undefined || value === null) return;
    const ok = check(value);
    if (ok === undefined) { malformed++; return; }
    out[key] = ok;
  };

  take('instar_session', headers.instarSession === '' ? undefined : headers.instarSession, asName);
  take('tool_name', r.tool_name, asName);
  take('agent_type', r.agent_type, asName);
  take('agent_id', r.agent_id, asId);
  take('task_id', r.task_id, asId);
  take('cwd', r.cwd, asPath);
  take('transcript_path', r.transcript_path, asPath);
  take('agent_transcript_path', r.agent_transcript_path, asPath);
  take('reason', r.reason, asShort);
  take('trigger', r.trigger, asShort);
  take('last_assistant_message', r.last_assistant_message, (v) => (typeof v === 'string' ? redactThenTail(v) : undefined));
  take('task_subject', r.task_subject, (v) => (typeof v === 'string' ? redactThenTail(v) : undefined));

  // tool_input: only file_path/path (as `file_path`) and, for Bash, a derived
  // commit boolean. The raw command is never stored.
  const ti = r.tool_input;
  if (ti !== undefined && ti !== null) {
    if (typeof ti === 'object' && !Array.isArray(ti)) {
      const t = ti as Record<string, unknown>;
      const fp = t.file_path ?? t.path;
      if (fp !== undefined && fp !== null) take('file_path', fp, asPath);
      if (out.tool_name === 'Bash') {
        out.is_git_commit = typeof t.command === 'string' && GIT_COMMIT_RE.test(t.command);
      }
    } else {
      malformed++;
    }
  }
  return { event: out, malformedFields: malformed };
}

// ── Counters ────────────────────────────────────────────────────────

export interface NativeHookCounters {
  admitted: number;
  stored: number;
  failedProcessing: number;
  /** Expected steady-state traffic (hand-started / unconfined sessions) — not an alarm. */
  emptyCredential: number;
  wrongToken: number;
  forbidden: number;
  tooLarge: number;
  queueOverflow: number;
  malformedFields: number;
  malformedEvents: number;
}

export interface NativeHookBodySizeStats {
  /** Admitted body sizes, bucketed (bytes, upper bounds inclusive). */
  buckets: { le1k: number; le16k: number; le256k: number; le1m: number; le4m: number };
  maxBytes: number;
}

export type NativeHookProcessor = (event: HookEventPayload, instarSessionId: string) => boolean;

export interface NativeHookIngestOptions {
  /** Live token getter (rotation-aware). */
  getAuthToken: () => string | undefined;
  maxQueue?: number;
  drainMaxEvents?: number;
  drainMaxMs?: number;
  /** Test seam for the yield between drain turns. */
  schedule?: (fn: () => void) => void;
  now?: () => number;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function headerValue(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function tokenEquals(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export class NativeHookEventIngest {
  private readonly opts: NativeHookIngestOptions;
  private readonly maxQueue: number;
  private readonly drainMaxEvents: number;
  private readonly drainMaxMs: number;
  private readonly schedule: (fn: () => void) => void;
  private readonly now: () => number;
  private readonly queue: Array<{ event: HookEventPayload; instarSessionId: string }> = [];
  private draining = false;
  private processor: NativeHookProcessor | null = null;
  readonly counters: NativeHookCounters = {
    admitted: 0, stored: 0, failedProcessing: 0, emptyCredential: 0, wrongToken: 0,
    forbidden: 0, tooLarge: 0, queueOverflow: 0, malformedFields: 0, malformedEvents: 0,
  };
  readonly bodySize: NativeHookBodySizeStats = { buckets: { le1k: 0, le16k: 0, le256k: 0, le1m: 0, le4m: 0 }, maxBytes: 0 };
  private readonly jsonParser: RequestHandler;

  constructor(opts: NativeHookIngestOptions) {
    this.opts = opts;
    this.maxQueue = opts.maxQueue ?? NATIVE_HOOK_QUEUE_MAX;
    this.drainMaxEvents = opts.drainMaxEvents ?? NATIVE_HOOK_DRAIN_MAX_EVENTS;
    this.drainMaxMs = opts.drainMaxMs ?? NATIVE_HOOK_DRAIN_MAX_MS;
    this.schedule = opts.schedule ?? ((fn) => setImmediate(fn));
    this.now = opts.now ?? Date.now;
    // Parse whatever content-type Claude Code sends; the 4 MB limit also
    // covers a chunked body that carried no Content-Length.
    this.jsonParser = express.json({ limit: NATIVE_HOOK_BODY_LIMIT_BYTES, type: () => true });
  }

  /** Wire the shared per-event side-effect function (routes.ts). */
  setProcessor(fn: NativeHookProcessor): void {
    this.processor = fn;
  }

  get pending(): number {
    return this.queue.length;
  }

  snapshot(): NativeHookCounters & { pending: number; bodySize: NativeHookBodySizeStats } {
    return { ...this.counters, pending: this.queue.length, bodySize: { buckets: { ...this.bodySize.buckets }, maxBytes: this.bodySize.maxBytes } };
  }

  /**
   * Admission before parsing. Order (spec D1): non-loopback / forwarded ⇒ 403;
   * empty bearer or empty session id ⇒ 204 nothing processed; wrong token ⇒
   * 401; Content-Length over 4 MB ⇒ 413. Nothing here reads the body.
   */
  admissionGuard(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (req.method !== 'POST') { next(); return; }
      const remote = req.socket.remoteAddress ?? '';
      if (!LOOPBACK.has(remote) || req.headers['cf-connecting-ip'] !== undefined || req.headers['x-forwarded-for'] !== undefined) {
        this.counters.forbidden++;
        res.status(403).json({ error: 'native hook events are loopback-only' });
        return;
      }
      const auth = (headerValue(req, 'authorization') ?? '').trim();
      const token = auth.startsWith('Bearer') ? auth.slice('Bearer'.length).trim() : auth;
      const sid = (headerValue(req, 'x-instar-session-id') ?? '').trim();
      if (!token || !sid) {
        this.counters.emptyCredential++;
        res.status(204).end();
        return;
      }
      const expected = this.opts.getAuthToken();
      if (expected && !tokenEquals(token, expected)) {
        this.counters.wrongToken++;
        res.status(401).json({ error: 'invalid token' });
        return;
      }
      const len = Number(headerValue(req, 'content-length') ?? '');
      if (Number.isFinite(len) && len > NATIVE_HOOK_BODY_LIMIT_BYTES) {
        this.counters.tooLarge++;
        res.status(413).json({ error: 'payload too large' });
        return;
      }
      // An unset INSTAR_AGENT_ID expands to an empty header; treat it as absent
      // (the script sends none) so the agent-id binding does not 403 it.
      if (headerValue(req, 'x-instar-agentid') === '') delete req.headers['x-instar-agentid'];
      if (Number.isFinite(len) && len >= 0) this.recordBodySize(len);
      next();
    };
  }

  /** The route's own parser (mounted right after the guard). */
  bodyParser(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (req.method !== 'POST') { next(); return; }
      this.jsonParser(req, res, (err?: unknown) => {
        if (err) {
          const e = err as { type?: string; status?: number };
          if (e.type === 'entity.too.large' || e.status === 413) {
            this.counters.tooLarge++;
            res.status(413).json({ error: 'payload too large' });
            return;
          }
          // Unparseable JSON: never a session error — count and swallow.
          this.counters.malformedEvents++;
          res.status(204).end();
          return;
        }
        next();
      });
    };
  }

  private recordBodySize(n: number): void {
    const b = this.bodySize.buckets;
    if (n <= 1024) b.le1k++;
    else if (n <= 16 * 1024) b.le16k++;
    else if (n <= 256 * 1024) b.le256k++;
    else if (n <= 1024 * 1024) b.le1m++;
    else b.le4m++;
    if (n > this.bodySize.maxBytes) this.bodySize.maxBytes = n;
  }

  /**
   * Route-handler half: project the parsed body and enqueue it. Never throws;
   * the caller answers 204 regardless.
   */
  accept(body: unknown, headers: NativeProjectionHeaders): void {
    this.counters.admitted++;
    let projection: NativeProjection;
    try {
      projection = projectNativeHookEvent(body, headers);
    } catch {
      this.counters.malformedEvents++;
      return;
    }
    this.counters.malformedFields += projection.malformedFields;
    if (!projection.event) {
      this.counters.malformedEvents++;
      return;
    }
    this.enqueue(projection.event, headers.instarSessionId ?? '');
  }

  enqueue(event: HookEventPayload, instarSessionId: string): void {
    if (this.queue.length >= this.maxQueue) {
      // Drop the NEWEST: a burst cannot grow memory.
      this.counters.queueOverflow++;
      return;
    }
    this.queue.push({ event, instarSessionId });
    if (!this.draining) {
      this.draining = true;
      this.schedule(() => this.drainTurn());
    }
  }

  private drainTurn(): void {
    const start = this.now();
    let n = 0;
    while (this.queue.length > 0 && n < this.drainMaxEvents && this.now() - start < this.drainMaxMs) {
      const item = this.queue.shift()!;
      n++;
      try {
        const ok = this.processor ? this.processor(item.event, item.instarSessionId) : false;
        if (ok) this.counters.stored++;
        else this.counters.failedProcessing++;
      } catch {
        this.counters.failedProcessing++;
      }
    }
    if (this.queue.length > 0) {
      this.schedule(() => this.drainTurn());
    } else {
      this.draining = false;
    }
  }
}
