/**
 * BootSlowCallbackAttributor — names the callback that holds the event loop during boot.
 *
 * Why: on the Mac Studio the server blocks the loop ~22 s at every boot before it
 * listens (fb-756ec068-89d, 2 of 2 boots on 2026-11-18). The log only shows a silent
 * gap; SleepWakeDetector says "BLOCK" afterwards but cannot say whose. Profiling the
 * live server crashed it (onnxruntime SME2 + SIGPROF), so attribution has to come from
 * inside the process, cheaply.
 *
 * How: for a bounded window after boot (default 120 s), an async_hooks hook times every
 * callback (before → after). A callback over the threshold (default 1 s) is logged with
 * its resource type and the stack that SCHEDULED it. Stacks are captured at init only
 * for non-promise resources (timers, immediates, nextTick, fs/net requests): promise
 * creation is far too frequent to stack-capture during boot. Instead each promise inherits,
 * at its own init, the anchor of its trigger (or of the running callback), so a slow
 * continuation names the timer/IO/immediate that started its chain; when the chain began
 * before the hook was enabled, the line says so plainly.
 *
 * Observation only: it never blocks, delays or changes a callback. It disables itself at
 * the end of the window, and any hook error disables it rather than reach the callback.
 * Dev-gated (monitoring.bootSlowCallbacks): live on development agents, dark on the fleet.
 */
import { createHook, executionAsyncId, type AsyncHook } from 'node:async_hooks';

export interface SlowCallback {
  /** async_hooks resource type, e.g. Immediate, Timeout, TickObject, PROMISE. */
  type: string;
  ms: number;
  /** ms since the attributor started. */
  atMs: number;
  /** The scheduling stack (own, or of the nearest non-promise ancestor), or null. */
  scheduledAt: string | null;
  /** 0 = own scheduling stack; 1 = inherited from the chain's anchor; -1 = unknown. */
  hops: number;
}

export interface BootSlowCallbackOptions {
  windowMs?: number;
  thresholdMs?: number;
  /** Max slow callbacks kept and logged (bounded output). */
  maxReports?: number;
  /** Max resources remembered at once; beyond this, new inits are not tracked. */
  maxTracked?: number;
  log?: (line: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
}

/** A captured stack, formatted only when read (V8 formats `.stack` lazily on first access). */
type Anchor = { stack?: string };
/**
 * `anchor` is a non-promise resource's own scheduling stack. A promise has none of its own;
 * it keeps an object reference to its parent record (`from`, its trigger or the running
 * callback at init) and, when it resolves, the anchor of the callback that resolved it
 * (`resolvedBy`). Object references survive the parent's removal from the map, so a slow
 * continuation can be traced after its parent is gone. `depth` caps how long a retained
 * chain can grow.
 */
interface Tracked { type: string; anchor: Anchor | null; from: Tracked | null; resolvedBy: Anchor | null; depth: number }
const MAX_CHAIN = 64;

/** The nearest anchor for a record: its own, the one that resolved it, else its parent's. */
function anchorOf(t: Tracked | undefined | null): { anchor: Anchor | null; own: boolean } {
  let cur = t ?? null;
  let first = true;
  for (let i = 0; cur && i < MAX_CHAIN; i++, first = false) {
    if (cur.anchor) return { anchor: cur.anchor, own: first };
    if (cur.resolvedBy) return { anchor: cur.resolvedBy, own: false };
    cur = cur.from;
  }
  return { anchor: null, own: false };
}

const STACK_FRAMES = 14;

/** Drop the hook's own frames and Node internals so the first line is the scheduling code. */
export function trimStack(raw: string | undefined): string | null {
  if (!raw) return null;
  const lines = raw.split('\n').slice(1)
    .filter((l) => !l.includes('BootSlowCallbackAttributor') && !l.includes('node:internal') && !l.includes('(node:async_hooks'));
  return lines.length ? lines.slice(0, 8).map((l) => l.trim()).join('\n    ') : null;
}

export class BootSlowCallbackAttributor {
  private hook: AsyncHook | null = null;
  private readonly tracked = new Map<number, Tracked>();
  /** Start time per running callback, keyed by asyncId (a stack breaks when a before has no after). */
  private readonly starts = new Map<number, number>();
  private readonly reports: SlowCallback[] = [];
  private startedAt = 0;
  private stopped = false;
  private readonly opts: Required<Omit<BootSlowCallbackOptions, 'setTimer'>> & Pick<BootSlowCallbackOptions, 'setTimer'>;

  constructor(opts: BootSlowCallbackOptions = {}) {
    this.opts = {
      windowMs: opts.windowMs ?? 120_000,
      thresholdMs: opts.thresholdMs ?? 1_000,
      maxReports: opts.maxReports ?? 20,
      maxTracked: opts.maxTracked ?? 200_000,
      log: opts.log ?? ((l) => console.warn(l)),
      now: opts.now ?? (() => performance.now()),
      setTimer: opts.setTimer,
    };
  }

  start(): this {
    if (this.hook || this.stopped) return this;
    this.startedAt = this.opts.now();
    const self = this;
    this.hook = createHook({
      init(asyncId, type, triggerAsyncId) {
        try {
          if (self.tracked.size >= self.opts.maxTracked) return;
          if (type !== 'PROMISE') {
            const holder: Anchor = {};
            const prev = Error.stackTraceLimit;
            try { Error.stackTraceLimit = STACK_FRAMES; Error.captureStackTrace(holder); }
            finally { Error.stackTraceLimit = prev; }
            self.tracked.set(asyncId, { type, anchor: holder, from: null, resolvedBy: null, depth: 0 });
          } else {
            const parent = self.tracked.get(triggerAsyncId) ?? self.tracked.get(executionAsyncId()) ?? null;
            const from = parent && parent.depth < MAX_CHAIN ? parent : null;
            self.tracked.set(asyncId, { type, anchor: null, from, resolvedBy: null, depth: from ? from.depth + 1 : 0 });
          }
        } catch { self.fail(); } // @silent-fallback-ok — a diagnostic error disables the diagnostic, never the callback
      },
      before(asyncId) {
        try { self.starts.set(asyncId, self.opts.now()); } catch { self.fail(); } // @silent-fallback-ok — see init
      },
      after(asyncId) {
        try {
          const at = self.starts.get(asyncId);
          if (at === undefined) return;
          self.starts.delete(asyncId);
          const ms = self.opts.now() - at;
          if (ms >= self.opts.thresholdMs) self.record(asyncId, ms, at);
          if (self.tracked.get(asyncId)?.type === 'PROMISE') self.tracked.delete(asyncId);
        } catch { self.fail(); } // @silent-fallback-ok — see init
      },
      destroy(asyncId) { self.tracked.delete(asyncId); self.starts.delete(asyncId); },
      promiseResolve(asyncId) {
        try {
          const rec = self.tracked.get(asyncId);
          // Remember which callback resolved it: its children run later and point back here.
          if (rec && !rec.resolvedBy) rec.resolvedBy = anchorOf(self.tracked.get(executionAsyncId())).anchor;
          // A promise resolves inside its own callback, before `after`: keep its record until then.
          if (!self.starts.has(asyncId)) self.tracked.delete(asyncId);
        } catch { self.fail(); } // @silent-fallback-ok — see init
      },
    });
    this.hook.enable();
    const t = (this.opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => this.stop(), this.opts.windowMs);
    t.unref?.();
    return this;
  }

  /** Attribute one slow callback. Exposed for tests. */
  record(asyncId: number, ms: number, startedAtAbs: number): void {
    if (this.reports.length >= this.opts.maxReports) return;
    const own = this.tracked.get(asyncId);
    const found = anchorOf(own);
    const scheduledAt = trimStack(found.anchor?.stack);
    const report: SlowCallback = {
      type: own?.type ?? 'unknown',
      ms: Math.round(ms),
      atMs: Math.round(startedAtAbs - this.startedAt),
      scheduledAt,
      hops: scheduledAt === null ? -1 : found.own ? 0 : 1,
    };
    this.reports.push(report);
    const where = report.scheduledAt
      ? `scheduled at${report.hops > 0 ? ' (inherited from the code that started this promise chain)' : ''}:\n    ${report.scheduledAt}`
      : 'scheduling stack unknown (a promise continuation with no stacked ancestor; compare the log lines either side)';
    this.opts.log(`[boot-slow-callback] ${report.type} held the event loop ${report.ms} ms, ${Math.round(report.atMs / 1000)} s after boot; ${where}`);
  }

  stop(): SlowCallback[] {
    if (this.hook) { this.hook.disable(); this.hook = null; }
    if (!this.stopped) {
      this.stopped = true;
      this.opts.log(`[boot-slow-callback] window closed: ${this.reports.length} callback(s) over ${this.opts.thresholdMs} ms`);
    }
    this.tracked.clear();
    this.starts.clear();
    return this.reports.slice();
  }

  get slow(): SlowCallback[] { return this.reports.slice(); }

  private fail(): void {
    try { if (this.hook) { this.hook.disable(); this.hook = null; } } catch { /* @silent-fallback-ok — already failing closed */ }
    if (!this.stopped) { this.stopped = true; this.opts.log('[boot-slow-callback] disabled after an internal error (observation only; nothing else affected)'); }
  }
}

/** Start the attributor when the dev gate says so. Returns null when off. */
export function startBootSlowCallbackAttributor(enabled: boolean, opts?: BootSlowCallbackOptions): BootSlowCallbackAttributor | null {
  if (!enabled) return null;
  return new BootSlowCallbackAttributor(opts).start();
}
