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
  // The SAME non-OPEN-WebSocket-send race as 'Sent before connected', but the
  // message form thrown by Node's BUILT-IN WebSocket (Node 22+, the default
  // runtime path — the 'ws' polyfill only loads on Node <22). Built-in throws
  // a DOMException `"WebSocket is not open: readyState N"` (see Node's
  // lib/internal/deps/undici/undici.js — sendMessage's not-OPEN guard), which
  // 'Sent before connected' does not match. This is a TRANSPORT-level non-fatal
  // class, correct for EVERY WebSocket user in the tree (Slack Socket Mode,
  // Threadline relay/client, server WebSocketManager, SlackLifeline) — each owns
  // its own reconnect and a dropped frame is best-effort. ANCHORED to
  // "WebSocket is not open" (NOT the bare "is not open", which collides with
  // live "<name> is not open for public registration" and "database connection
  // is not open" messages and would swallow a genuinely-fatal error — guarded by
  // a negative test). Net #1's _safeSend funnel + grep ratchet is the PRIMARY
  // guarantee; this only ever catches an un-funneled future regression.
  'WebSocket is not open',
  // Standby read-only write: when this machine is on standby (a peer holds the
  // multi-machine lease), StateManager.guardWrite() throws on any stray
  // write ("StateManager is read-only (this machine is on standby)"). That is a
  // KNOWN, ISOLATED, recoverable condition — the active machine owns the
  // canonical state; the standby machine simply should not have written. The
  // throw has already unwound the offending write; the server stays useful in
  // send-only mode. Crashing the whole agent here turns a benign dropped write
  // into a crash-loop (boot → demote-to-standby → stray write → FATAL → respawn).
  // This is a crash backstop ONLY — it does not change lease/standby behavior;
  // it stops a standby write from taking the process down.
  'StateManager is read-only',
  // Network-class outbound failures (transient upstream/peer outage). A failed
  // outbound fetch — the multi-machine lease-wire peer broadcast, a Slack
  // connect/reconnect, any HTTP call — is ISOLATED by nature: the call has
  // already unwound and SQLite, HTTP, and the other subsystems are intact. The
  // owning subsystem retries/self-heals (lease-wire re-broadcasts; the socket
  // reconnects with backoff). Crashing the whole agent on a transient network
  // blip is strictly worse than logging + continuing — it was the cause of the
  // 2026-06-15 crash-during-API-instability (an uncaught `fetch failed` took the
  // server down mid-outage). The first-seen-stack logging below still surfaces
  // the un-guarded callsite so the real missing `.catch` gets fixed; this is the
  // crash backstop, NOT a license to skip the catch. (CMT-1548)
  'fetch failed',          // undici / Node global fetch network failure
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'socket hang up',
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

/**
 * Decides whether to attach the FULL stack trace when logging a suppressed
 * non-fatal uncaught exception. These isolated races recur (the HTTP
 * double-response one — "Cannot set headers after they are sent" — fires
 * ~10-20x/hour), so logging the stack on EVERY occurrence would flood the log.
 * Yet without ANY stack the offending call site is undiagnosable: the throw
 * originates in node's http internals, so the suppressed message alone carries
 * no location — the route that double-responded is invisible.
 *
 * The fix: log the full stack the FIRST time a given stack is seen, then
 * message-only for repeats. That surfaces each distinct originating call path
 * exactly once (enough to find + fix the real double-send) without the flood.
 *
 * Dedup key is the full `err.stack` (not just the top frames): the distinguishing
 * frame for an HTTP double-response is the application route DEEP in the stack —
 * the top frames are always the same node internals — so only the whole stack
 * separates one origin from another. Process-local + bounded (cleared past
 * MAX_TRACKED_STACKS so a pathological variety of stacks can't grow it without
 * limit). Returns false for non-Error / stackless input.
 */
const seenUncaughtStacks = new Set<string>();
const MAX_TRACKED_STACKS = 200;

export function shouldLogStackForUncaught(err: unknown): boolean {
  if (!(err instanceof Error) || !err.stack) return false;
  if (seenUncaughtStacks.has(err.stack)) return false;
  // Bound memory: if a pathological variety of distinct stacks accumulates,
  // reset rather than grow without limit (re-surfacing after the reset is fine).
  if (seenUncaughtStacks.size >= MAX_TRACKED_STACKS) seenUncaughtStacks.clear();
  seenUncaughtStacks.add(err.stack);
  return true;
}

/** Test-only: reset the dedup memory so each test starts from a clean slate. */
export function __resetUncaughtStackDedupeForTests(): void {
  seenUncaughtStacks.clear();
}

/**
 * The single crash-vs-continue decision shared by BOTH process-level handlers
 * (`uncaughtException` and `unhandledRejection`). Extracting it into one function
 * is what guarantees the two handlers cannot drift to divergent policies — there
 * is exactly one allowlist, one default-crash posture, one dedup'd log path.
 *
 * Behavior:
 * - A non-fatal match (`isNonFatalUncaught`) → `console.warn` (with the first-seen
 *   stack attached once per distinct origin) and returns `'recovered'`. The server
 *   stays up.
 * - Anything else → `console.error`, run `opts.onFatalCleanup()` (best-effort —
 *   wrapped so a cleanup failure can't mask the original error), then exit(1) and
 *   return `'fatal'`. This is the fail-toward-crash default: an unknown error
 *   crashes, and net #2 respawns a clean process in ~10s.
 *
 * Cleanup and exit are INJECTED callbacks (server.ts passes `closeAllSqlite` and
 * the real `process.exit`) so this module stays pure decision-logic — it does NOT
 * import the SQLite registry, and the unit test injects fakes to assert the fatal
 * path triggers cleanup + exit under BOTH labels without actually exiting.
 *
 * The `exit` callback is typed `(code) => never`, but the function still has a
 * trailing `return 'fatal'`: with the real `process.exit` that line is
 * unreachable; with an injected test fake that returns, the assertion can observe
 * the verdict. This is the standard injectable-exit test pattern.
 */
export function handleProcessLevelError(
  err: unknown,
  label: 'uncaughtException' | 'unhandledRejection',
  opts: { onFatalCleanup: () => void; exit?: (code: number) => never },
): 'recovered' | 'fatal' {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);
  if (isNonFatalUncaught(err)) {
    // Attach the stack the first time a given origin is seen so the offending
    // call site is diagnosable; repeats log message-only to avoid flooding the
    // log (these isolated races recur).
    const stackSuffix =
      shouldLogStackForUncaught(err) && err instanceof Error && err.stack
        ? `\n  first-seen stack (for diagnosis):\n${err.stack}`
        : '';
    console.warn(`[WARN] Non-fatal ${label} (suppressed): ${message}${stackSuffix}`);
    return 'recovered';
  }

  console.error(`[FATAL] Uncaught ${label} — closing databases before crash: ${message}`);
  // Close ALL registered SQLite handles before the crash exit so it doesn't
  // compound into a "mutex lock failed" SIGABRT. onFatalCleanup is best-effort.
  try { opts.onFatalCleanup(); } catch { /* best effort */ }
  (opts.exit ?? process.exit)(1);
  return 'fatal';
}
