/**
 * honestDeliveryWiring — the server-side half of honest delivery
 * (docs/specs/a2a-honest-delivery-outcomes.md §3/§5), extracted from
 * `commands/server.ts` so the production wiring is the exact code the tests run.
 *
 *  - wireRelayVerdicts: ONE subscription on the long-lived ThreadlineClient (it
 *    re-forwards across reconnects) — the only writer of relay verdicts into the
 *    tracker. Recording only; it never touches the connection it observes.
 *    Wording drift in the hosted relay's refusal text lands one degradation
 *    event per DISTINCT reason (hash key, class-only text), capped per process.
 *  - startDeliverySweep: the silence sweep — relabels relay rows with no usable
 *    verdict to NON-TERMINAL `unconfirmed` (never `failed`). Single-flight; a
 *    throwing tick reports ONE degradation (class-only) then backs off
 *    1h→2h→4h (ceiling 24h, reset on a clean tick) by skipping ticks — the
 *    interval is never re-created. Audit: metadata-only JSONL, 10 MB with one
 *    rotation. Raises NO operator notice.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { A2ADeliveryTracker } from './A2ADeliveryTracker.js';
import type { RelayVerdict } from './relayVerdict.js';

export interface DegradationSink {
  report(event: { feature: string; primary: string; fallback: string; reason: string; impact: string }): void;
}

export const UNMAPPED_REASON_KEY_CAP = 32;

export function wireRelayVerdicts(
  client: EventEmitter,
  getTracker: () => A2ADeliveryTracker | null,
  degradations: DegradationSink,
  log: (line: string) => void = (l) => console.warn(l),
): () => void {
  const onVerdict = (v: RelayVerdict): void => {
    try { getTracker()?.recordRelayStatus(v); }
    catch (err) {
      // @silent-fallback-ok: recording-only — a tracker write fault must never
      // touch the relay connection it is observing. Logged.
      log(`[a2a-delivery] relay verdict record failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  };
  const seen = new Set<string>();
  let overflowed = false;
  const onUnmapped = (info: { reason?: string }): void => {
    const key = createHash('sha256').update(info?.reason ?? '').digest('hex').slice(0, 16);
    if (seen.has(key)) return;
    if (seen.size >= UNMAPPED_REASON_KEY_CAP) {
      if (overflowed) return;
      overflowed = true;
      degradations.report({
        feature: 'A2ARelayVerdict.unmapped-overflow',
        primary: 'relay refusal text mapped to a fixed reason code',
        fallback: 'retryability unknown (retryLater: null)',
        reason: `more than ${UNMAPPED_REASON_KEY_CAP} distinct unmapped relay reasons this process`,
        impact: 'refusals report unknown retryability until relay-side reason codes land (ACT-017)',
      });
      return;
    }
    seen.add(key);
    degradations.report({
      feature: `A2ARelayVerdict:unmapped:${key}`,
      primary: 'relay refusal text mapped to a fixed reason code',
      fallback: 'retryability unknown (retryLater: null)',
      reason: 'relay refusal wording matched no known prefix',
      impact: 'that refusal reports unknown retryability until relay-side reason codes land (ACT-017)',
    });
  };
  client.on('relay-verdict', onVerdict);
  client.on('relay-unmapped-reason', onUnmapped);
  return () => {
    client.off('relay-verdict', onVerdict);
    client.off('relay-unmapped-reason', onUnmapped);
  };
}

export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
export const SWEEP_BACKOFF_START_MS = 60 * 60 * 1000;
export const SWEEP_BACKOFF_CEILING_MS = 24 * 60 * 60 * 1000;
export const SWEEP_AUDIT_MAX_BYTES = 10 * 1024 * 1024;

export interface DeliverySweepHandle {
  /** One tick now (the interval calls this). Returns the rows relabelled. */
  tick(nowMs?: number): number;
  stop(): void;
  /** Introspection for tests/status. */
  state(): { nextAllowedAt: number; backoffMs: number; reported: boolean };
}

export function startDeliverySweep(opts: {
  tracker: A2ADeliveryTracker;
  auditPath: string;
  degradations: DegradationSink;
  intervalMs?: number;
  /** false = no timer (tests drive tick()). */
  schedule?: boolean;
  log?: (line: string) => void;
}): DeliverySweepHandle {
  const log = opts.log ?? ((l: string) => console.warn(l));
  let running = false;
  let nextAllowedAt = 0;
  let backoffMs = SWEEP_BACKOFF_START_MS;
  let reported = false;

  const appendAudit = (rows: ReturnType<A2ADeliveryTracker['sweepSilence']>, nowMs: number): void => {
    try {
      fs.mkdirSync(path.dirname(opts.auditPath), { recursive: true });
      let size = 0;
      try { size = fs.statSync(opts.auditPath).size; } catch { /* @silent-fallback-ok: no file yet = size 0 */ }
      if (size > SWEEP_AUDIT_MAX_BYTES) fs.renameSync(opts.auditPath, `${opts.auditPath}.1`);
      const ts = new Date(nowMs).toISOString();
      fs.appendFileSync(
        opts.auditPath,
        rows.map((m) => JSON.stringify({ ts, kind: 'sweep', messageId: m.messageId, peerFp: m.peerFp, from: 'awaiting-ack', to: 'unconfirmed', cause: m.cause })).join('\n') + '\n',
      );
    } catch (err) {
      log(`[a2a-delivery] sweep audit append failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  };

  const tick = (nowMs: number = Date.now()): number => {
    if (running || nowMs < nextAllowedAt) return 0;
    running = true;
    try {
      const moved = opts.tracker.sweepSilence(nowMs);
      if (moved.length > 0) appendAudit(moved, nowMs);
      backoffMs = SWEEP_BACKOFF_START_MS;
      reported = false;
      nextAllowedAt = 0;
      return moved.length;
    } catch (err) {
      nextAllowedAt = nowMs + backoffMs;
      const pausedMin = Math.round(backoffMs / 60000);
      backoffMs = Math.min(backoffMs * 2, SWEEP_BACKOFF_CEILING_MS);
      if (!reported) {
        reported = true;
        opts.degradations.report({
          feature: 'A2ADeliverySweep',
          primary: 'silence sweep relabels unanswered relay sends to unconfirmed',
          fallback: `sweep paused with backoff (${pausedMin} min)`,
          reason: `sweep tick threw: ${err instanceof Error ? err.constructor.name : 'error'}`,
          impact: 'rows with no relay verdict stay awaiting-ack until the sweep recovers (still counted as pending/stale)',
        });
      }
      return 0;
    } finally {
      running = false;
    }
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  if (opts.schedule !== false) {
    timer = setInterval(() => { tick(); }, opts.intervalMs ?? SWEEP_INTERVAL_MS);
    timer.unref?.();
  }
  return {
    tick,
    stop: () => { if (timer) { clearInterval(timer); timer = null; } },
    state: () => ({ nextAllowedAt, backoffMs, reported }),
  };
}
