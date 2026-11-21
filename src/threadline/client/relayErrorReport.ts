/**
 * SEC-136: relay frames that must never throw out of the agent. ThreadlineClient routes here a relay
 * `{type:'error'}` frame that no caller listens for (an unheard 'error' event throws and exits the
 * server); RelayClient, ThreadlineClient and ThreadlineBootstrap route here malformed frames and
 * failing relay listeners. Each is one log line and one health degradation per code per 10 minutes.
 * Codes the relay documents (RELAY_ERROR_CODES) keep that per-code limit only; every other code also
 * shares a cap of 5 reports per 10 minutes, so a relay cycling made-up codes cannot flood the store
 * or crowd out real errors. The degradation names only the code. The relay's own text is untrusted:
 * it goes only into the labelled log line, cleaned of control, bidi and line-separator characters and
 * cut to 200 code points.
 */
import { DegradationReporter } from '../../monitoring/DegradationReporter.js';
import { RELAY_ERROR_CODES } from '../relay/types.js';

const DOCUMENTED_CODES = new Set<string>(Object.values(RELAY_ERROR_CODES));

const REPORT_EVERY_MS = 10 * 60_000;
/** At most this many reports in any 10-minute window, across all codes, so cycling codes cannot flood the store. */
const MAX_REPORTS_PER_WINDOW = 5;
const lastReported = new Map<string, number>();
const recentReports: number[] = [];

function clean(value: unknown, max: number): string {
  // Control characters (C0, DEL, C1), bidi controls and line/paragraph separators all become spaces.
  // eslint-disable-next-line no-control-regex
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]+/g, ' ').trim() : '';
  const cut = Array.from(text); // code points, so a surrogate pair is never split
  return cut.length > max ? `${cut.slice(0, max).join('')}…` : text;
}

export function reportUnheardRelayError(frame: unknown, now: number = Date.now()): void {
  try {
    const f = (frame && typeof frame === 'object' ? frame : {}) as { code?: unknown; message?: unknown };
    const code = clean(f.code, 64) || 'unknown';
    const message = clean(f.message, 200);
    const last = lastReported.get(code);
    if (last !== undefined && now - last < REPORT_EVERY_MS) return;
    if (!DOCUMENTED_CODES.has(code)) {
      while (recentReports.length && now - recentReports[0] >= REPORT_EVERY_MS) recentReports.shift();
      if (recentReports.length >= MAX_REPORTS_PER_WINDOW) return;
      recentReports.push(now);
    }
    lastReported.set(code, now);
    if (lastReported.size > 256) lastReported.delete(lastReported.keys().next().value as string);
    console.warn(`[threadline] relay error frame (code ${code})${message ? `, relay text: "${message}"` : ''}; no listener, so it was logged instead of thrown`);
    DegradationReporter.getInstance().report({
      feature: 'ThreadlineClient.relayErrorFrame',
      primary: 'Stay connected to the agent network relay',
      fallback: 'The relay error is logged and the connection carries on or reconnects; the server keeps running.',
      // Only the code goes into the report; the relay's own words stay in the log line, labelled.
      reason: `The relay sent an error (code ${code}).`,
      impact: 'Messages through the relay may be delayed while it reports errors.',
    });
  } catch { /* @silent-fallback-ok — reporting must never throw into the relay message handler */ }
}

/** Test seam: forget the throttle state. */
export function resetUnheardRelayErrorReportsForTesting(): void { lastReported.clear(); recentReports.length = 0; }
