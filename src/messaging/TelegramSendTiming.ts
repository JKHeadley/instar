/** Observations only: headers are not a Telegram delivery receipt. */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const MAX_PROBES = 16;
let activeProbes = 0;
let nextId = 0;
const finite = (n: number): number | null => Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
const monotonicNow = (): number | null => {
  try { return performance.now(); } catch { return null; /* Optional diagnostic clock. */ }
};
const wallNow = (): number | null => {
  try { return Date.now(); } catch { return null; /* Optional diagnostic clock. */ }
};

function emit(fields: Record<string, unknown>): void {
  try { console.info('[telegram-send-timing] ' + JSON.stringify(fields)); }
  catch { /* Observation must never replace a transport result. */ }
}

/** No request metadata is accepted here, so credentials and text cannot enter the record. */
export async function observeTelegramSend<T>(network: () => Promise<T>, networkTimeoutMs?: number): Promise<T> {
  const id = nextId = nextId >= Number.MAX_SAFE_INTEGER ? 1 : nextId + 1;
  let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
  let ownsSlot = false;
  try {
    if (activeProbes < MAX_PROBES) {
      histogram = monitorEventLoopDelay({ resolution: 10 });
      histogram.enable();
      activeProbes += 1;
      ownsSlot = true;
    }
  } catch {
    try { histogram?.disable(); } catch { /* Probe failure is observational. */ }
    histogram = undefined;
  }
  emit({ event: 'start', id, pid: process.pid, at: wallNow(), method: 'sendMessage',
    networkTimeoutMs: networkTimeoutMs ?? null, sampled: ownsSlot });
  // Setup and start logging precede the EXISTING deadline creation inside network().
  // A logger delay must not consume the transport's configured timeout budget.
  const started = monotonicNow();
  let initialUtilization: ReturnType<typeof performance.eventLoopUtilization> | undefined;
  try { initialUtilization = performance.eventLoopUtilization(); } catch { /* Optional observation. */ }
  let finished = false;
  const finish = (phase: 'headers' | 'error'): void => {
    if (finished) return;
    finished = true;
    const ended = monotonicNow();
    const elapsedMs = started === null || ended === null ? null : finite(ended - started);
    let samples: number | null = null;
    let eventLoopDelayMaxMs: number | null = null;
    let processEventLoopUtilization: number | null = null;
    try {
      if (histogram) {
        samples = Number(histogram.count);
        // Enabling a fresh histogram can miss a stall before its first tick.
        // Zero samples mean UNAVAILABLE, never proof that the loop was responsive.
        if (samples > 0) eventLoopDelayMaxMs = finite(histogram.max / 1e6);
      }
      if (initialUtilization) processEventLoopUtilization = finite(performance.eventLoopUtilization(initialUtilization).utilization);
    } catch { /* Keep partial observations; never inspect or log the transport error. */ }
    finally {
      try { histogram?.disable(); } catch { /* Cleanup cannot replace a transport result. */ }
      if (ownsSlot) { activeProbes -= 1; ownsSlot = false; }
    }
    emit({ event: phase, id, pid: process.pid, at: wallNow(), method: 'sendMessage', elapsedMs,
      samples, eventLoopDelayMaxMs, processEventLoopUtilization });
  };
  try {
    const response = await network();
    finish('headers');
    return response; // Do not clone, consume or replace the response body.
  } catch (error) {
    finish('error');
    throw error; // Preserve identity for the existing known-unsent/unknown classification.
  }
}
