/**
 * Policy for which process-level uncaught exceptions are RECOVERABLE (log +
 * continue) vs FATAL (close databases + exit).
 *
 * The server's `process.on('uncaughtException')` handler crashes by default —
 * the safe thing for a truly-unknown exception. But a small set of exceptions
 * are ISOLATED and recoverable: the failing operation has already unwound, the
 * rest of the agent (databases, HTTP, the other messaging platforms) is intact,
 * and the owning subsystem self-heals. For those, crashing the whole agent —
 * which closes its SQLite databases and drops in-flight work — is strictly worse
 * than logging and continuing.
 *
 * Extracted from server.ts so the decision boundary is unit-testable on both
 * sides. Adding a pattern here is a deliberate assertion that the matching error
 * is isolated + recoverable; keep the list tight.
 */
const NON_FATAL_UNCAUGHT_PATTERNS = [
  // HTTP double-response races (common during tunnel reconnect storms). The
  // affected request is already handled; the server keeps serving new requests.
  'Cannot set headers after they are sent',
  'write after end',
  'ERR_HTTP_HEADERS_SENT',
  'ERR_STREAM_WRITE_AFTER_END',
  // Slack Socket Mode reconnect race: a WebSocket send on a still-connecting
  // socket throws ("Sent before connected"). The SocketModeClient reconnects
  // with backoff on its own, and Slack redelivers any unacked event — so an
  // isolated Slack WS hiccup must not crash the whole agent (esp. on a laptop
  // that sleeps/wakes often, where reconnects are frequent). The root cause is
  // also guarded at the ack send site; this is the defense-in-depth backstop.
  'Sent before connected',
];

/**
 * True when an uncaught exception is a known isolated/recoverable error that the
 * server should log-and-continue on, rather than crash. Matches on the error
 * message (substring). Returns false for anything unrecognized (→ crash, the
 * safe default).
 */
export function isNonFatalUncaught(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!msg) return false;
  return NON_FATAL_UNCAUGHT_PATTERNS.some((p) => msg.includes(p));
}
