/**
 * Install narrow, suite-wide recovery for Supertest loopback transport faults.
 *
 * The suite creates thousands of short-lived HTTP listeners. macOS can briefly
 * time out a new loopback connect while those sockets drain, so every request
 * gets ten narrow retries for `ETIMEDOUT` from the `connect` syscall. Each
 * Supertest-owned listener also stamps responses with a private test nonce, so
 * the rare response from a recycled port is rejected instead of being mistaken
 * for the intended app's result.
 *
 * Initial requests are deliberately NOT paced. Supertest binds a temporary
 * server before `end()` is called; queueing `end()` can leave that listener alive
 * after its test scope has moved on and, under port reuse, route a delayed request
 * into an unrelated app. `minStartIntervalMs` remains injectable only for the
 * helper's scheduling unit tests.
 */

export type SupertestRetryPredicate = (
  error: { code?: string; syscall?: string } | null | undefined,
  response?: unknown,
) => boolean;

interface RetryCapableTest {
  _maxRetries?: number;
  header?: Record<string, unknown>;
  _header?: Record<string, unknown>;
  _server?: {
    listening?: boolean;
    address(): string | { port: number } | null;
    close(callback: (error?: Error) => void): unknown;
    listen(port: number, callback: () => void): unknown;
  };
  url?: string;
  request?: (...args: unknown[]) => unknown;
  _retry?: (...args: unknown[]) => unknown;
  retry(count: number, predicate: SupertestRetryPredicate): unknown;
}

interface SupertestPrototype {
  end(this: RetryCapableTest, ...args: unknown[]): unknown;
  serverAddress?(this: RetryCapableTest, app: SupertestServer, path: string): string;
  request?(this: RetryCapableTest, ...args: unknown[]): unknown;
  _retry?(this: RetryCapableTest, ...args: unknown[]): unknown;
  [key: symbol]: unknown;
}

const INSTALL_MARKER = Symbol.for('instar.tests.supertestConnectRetryInstalled');
const HEADER_SNAPSHOT = Symbol.for('instar.tests.supertestHeaderSnapshot');
const REFRESH_LISTENER_BEFORE_RETRY = Symbol.for('instar.tests.supertestRefreshListenerBeforeRetry');
const SERVER_NONCE = Symbol.for('instar.tests.supertestServerNonce');
const EXPECTED_SERVER_NONCE = Symbol.for('instar.tests.supertestExpectedServerNonce');
const SERVER_NONCE_HEADER = 'x-instar-supertest-server';

interface SupertestServer {
  [SERVER_NONCE]?: string;
  prependListener?(
    event: 'request',
    listener: (_request: unknown, response: { setHeader(name: string, value: string): unknown }) => void,
  ): unknown;
}

interface RetryResponse {
  headers?: Record<string, string | string[] | undefined>;
  header?: Record<string, string | string[] | undefined>;
}

let serverNonceSequence = 0;

interface HeaderSnapshot {
  display?: Record<string, unknown>;
  normalized?: Record<string, unknown>;
}

function restoreHeaders(test: RetryCapableTest, snapshot: HeaderSnapshot | undefined): void {
  if (snapshot?.display) {
    test.header ??= {};
    Object.assign(test.header, snapshot.display);
  }
  if (snapshot?.normalized) {
    test._header ??= {};
    Object.assign(test._header, snapshot.normalized);
  }
}

function markSupertestServer(server: SupertestServer): string | undefined {
  if (typeof server.prependListener !== 'function') return undefined;
  if (server[SERVER_NONCE]) return server[SERVER_NONCE];

  const nonce = `${process.pid}-${++serverNonceSequence}`;
  server[SERVER_NONCE] = nonce;
  server.prependListener('request', (_request, response) => {
    response.setHeader(SERVER_NONCE_HEADER, nonce);
  });
  return nonce;
}

function isMisdirectedResponse(test: RetryCapableTest, response: unknown): boolean {
  const expected = (test as RetryCapableTest & { [EXPECTED_SERVER_NONCE]?: string })[EXPECTED_SERVER_NONCE];
  if (!expected || !response || typeof response !== 'object') return false;
  const retryResponse = response as RetryResponse;
  const actual = retryResponse.headers?.[SERVER_NONCE_HEADER] ?? retryResponse.header?.[SERVER_NONCE_HEADER];
  return actual !== expected;
}

function refreshTemporaryListener(test: RetryCapableTest, ready: () => void): void {
  const server = test._server;
  if (!server || typeof test.url !== 'string') {
    ready();
    return;
  }

  const listenFresh = (): void => {
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address !== 'string') {
        const url = new URL(test.url!);
        url.port = String(address.port);
        test.url = url.toString();
      }
      ready();
    });
  };

  if (server.listening === false) {
    listenFresh();
    return;
  }
  server.close(() => listenFresh());
}

export interface SupertestConnectRetryOptions {
  minStartIntervalMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, delayMs: number) => unknown;
}

export function isLoopbackConnectTimeout(
  error: { code?: string; syscall?: string } | null | undefined,
): boolean {
  return error?.code === 'ETIMEDOUT' && error.syscall === 'connect';
}

export function installSupertestConnectRetry(
  prototype: SupertestPrototype,
  options: SupertestConnectRetryOptions = {},
): void {
  if (prototype[INSTALL_MARKER] === true) return;

  const minStartIntervalMs = options.minStartIntervalMs ?? 0;
  const now = options.now ?? Date.now;
  // Capture the real scheduler during setup so a later vi.useFakeTimers() in a
  // test file cannot strand an unrelated Supertest request in this pacing gate.
  const schedule = options.schedule ?? globalThis.setTimeout.bind(globalThis);
  let nextStartAt = 0;
  const originalEnd = prototype.end;
  const originalServerAddress = prototype.serverAddress;
  const originalRequest = prototype.request;
  const originalRetry = prototype._retry;

  // Every Supertest-owned listener stamps its responses with a process-local
  // nonce. Under extreme aggregate socket churn macOS can recycle an ephemeral
  // port after the intended listener disappears but before the queued connect
  // reaches it. Without an identity check that request can receive a perfectly
  // valid response from an unrelated test app (typically an inexplicable 401).
  // The nonce turns that silent semantic corruption into a narrow retry.
  if (typeof originalServerAddress === 'function') {
    prototype.serverAddress = function (app: SupertestServer, path: string): string {
      const nonce = markSupertestServer(app);
      if (nonce) {
        (this as RetryCapableTest & { [EXPECTED_SERVER_NONCE]?: string })[EXPECTED_SERVER_NONCE] = nonce;
      }
      return originalServerAddress.call(this, app, path);
    };
  }

  // Superagent rebuilds its ClientRequest inside request() both initially and
  // for every retry. Restore the immutable caller headers at that exact
  // boundary, after all pacing/retry bookkeeping and immediately before Node's
  // request object is constructed. Restoring only in end() is too early: an
  // aggregate run exposed rare authenticated requests reaching Express as 401s
  // after their header maps changed between delayed start and socket creation.
  if (typeof originalRequest === 'function') {
    prototype.request = function (...args: unknown[]): unknown {
      restoreHeaders(this, (this as RetryCapableTest & { [HEADER_SNAPSHOT]?: HeaderSnapshot })[HEADER_SNAPSHOT]);
      return originalRequest.apply(this, args);
    };
  }

  if (typeof originalRetry === 'function') {
    prototype._retry = function (...args: unknown[]): unknown {
      const retryTest = this as RetryCapableTest & { [REFRESH_LISTENER_BEFORE_RETRY]?: boolean };
      if (retryTest[REFRESH_LISTENER_BEFORE_RETRY] !== true) {
        return originalRetry.apply(this, args);
      }
      retryTest[REFRESH_LISTENER_BEFORE_RETRY] = false;
      refreshTemporaryListener(this, () => {
        originalRetry.apply(this, args);
      });
      return this;
    };
  }

  prototype.end = function (...args: unknown[]): unknown {
    const snapshot: HeaderSnapshot = {
      display: this.header ? { ...this.header } : undefined,
      normalized: this._header ? { ...this._header } : undefined,
    };
    (this as RetryCapableTest & { [HEADER_SNAPSHOT]?: HeaderSnapshot })[HEADER_SNAPSHOT] = snapshot;

    // Preserve any retry policy a specific test set explicitly, including 0.
    if (typeof this._maxRetries !== 'number') {
      // Superagent normally retains these maps across `_retry()`. Snapshot them
      // anyway: under aggregate socket pressure we observed an authenticated GET
      // reach the test server as an unauthenticated 401 after reconnecting. The
      // retry is limited to either a pre-handler connect failure or a response
      // carrying the wrong test-server nonce. Restoring the caller's original
      // headers prevents either transport retry from changing request semantics.
      this.retry(10, (error, response) => {
        if (!isLoopbackConnectTimeout(error) && !isMisdirectedResponse(this, response)) return false;
        restoreHeaders(this, snapshot);
        (this as RetryCapableTest & { [REFRESH_LISTENER_BEFORE_RETRY]?: boolean })[REFRESH_LISTENER_BEFORE_RETRY] = true;
        return true;
      });
    }

    const start = (): unknown => {
      // A paced request can sit in the queue after Promise assimilation has
      // returned from end(). Restore the caller's request semantics at the last
      // possible moment before Superagent builds the real ClientRequest.
      restoreHeaders(this, snapshot);
      return originalEnd.apply(this, args);
    };

    if (minStartIntervalMs <= 0) return start();

    const current = now();
    const startAt = Math.max(current, nextStartAt);
    nextStartAt = startAt + minStartIntervalMs;
    const delayMs = startAt - current;
    if (delayMs <= 0) return start();

    schedule(() => {
      start();
    }, delayMs);
    // Supertest's real end() returns the request instance. Preserve that API
    // while the actual socket start waits in the bounded pacing queue.
    return this;
  };

  Object.defineProperty(prototype, INSTALL_MARKER, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}
