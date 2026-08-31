import { describe, expect, it, vi } from 'vitest';
import {
  installSupertestConnectRetry,
  isLoopbackConnectTimeout,
  type SupertestRetryPredicate,
} from '../setup/supertest-connect-retry.js';

function makePrototype() {
  const originalEnd = vi.fn(function (this: unknown, value: string) {
    return { receiver: this, value };
  });
  const originalRequest = vi.fn(function (this: unknown) {
    return { receiver: this };
  });
  const originalRetry = vi.fn(function (this: unknown) {
    return { receiver: this };
  });
  const originalServerAddress = vi.fn(function (this: unknown, _server: unknown, path: string) {
    return `http://127.0.0.1:12345${path}`;
  });
  const prototype = {
    end: originalEnd,
    serverAddress: originalServerAddress,
    request: originalRequest,
    _retry: originalRetry,
  };
  return { originalEnd, originalServerAddress, originalRequest, originalRetry, prototype };
}

describe('suite-wide Supertest connect retry', () => {
  it('matches only a connect-phase ETIMEDOUT', () => {
    expect(isLoopbackConnectTimeout({ code: 'ETIMEDOUT', syscall: 'connect' })).toBe(true);
    expect(isLoopbackConnectTimeout({ code: 'ETIMEDOUT', syscall: 'read' })).toBe(false);
    expect(isLoopbackConnectTimeout({ code: 'ECONNRESET', syscall: 'connect' })).toBe(false);
    expect(isLoopbackConnectTimeout(undefined)).toBe(false);
  });

  it('starts requests immediately by default so temporary servers cannot go stale in a queue', () => {
    const { originalEnd, prototype } = makePrototype();
    const schedule = vi.fn();
    installSupertestConnectRetry(prototype as never, { schedule });

    const instance = { retry: vi.fn() };
    expect(prototype.end.call(instance, 'now')).toEqual({ receiver: instance, value: 'now' });
    expect(originalEnd).toHaveBeenCalledOnce();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('installs ten narrow retries before delegating to the original end', () => {
    const { originalEnd, prototype } = makePrototype();
    installSupertestConnectRetry(prototype as never, { minStartIntervalMs: 0 });

    let predicate: SupertestRetryPredicate | undefined;
    const instance = {
      header: { Authorization: 'Bearer test-token' } as Record<string, string>,
      _header: { authorization: 'Bearer test-token' } as Record<string, string>,
      retry: vi.fn((count: number, nextPredicate: SupertestRetryPredicate) => {
        expect(count).toBe(10);
        predicate = nextPredicate;
      }),
    };

    const result = prototype.end.call(instance, 'done');
    expect(instance.retry).toHaveBeenCalledOnce();
    instance.header = {};
    instance._header = {};
    expect(predicate?.({ code: 'ETIMEDOUT', syscall: 'connect' })).toBe(true);
    expect(instance.header.Authorization).toBe('Bearer test-token');
    expect(instance._header.authorization).toBe('Bearer test-token');

    instance.header = {};
    instance._header = {};
    expect(predicate?.({ code: 'ETIMEDOUT', syscall: 'read' })).toBe(false);
    expect(instance.header).toEqual({});
    expect(instance._header).toEqual({});
    expect(originalEnd).toHaveBeenCalledOnce();
    expect(result).toEqual({ receiver: instance, value: 'done' });
  });

  it('paces burst request starts at the configured minimum interval', () => {
    const { originalEnd, prototype } = makePrototype();
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
    installSupertestConnectRetry(prototype as never, {
      minStartIntervalMs: 50,
      now: () => 1_000,
      schedule: (fn, delayMs) => scheduled.push({ fn, delayMs }),
    });

    const first = { retry: vi.fn() };
    const second = {
      header: { Authorization: 'Bearer queued-token' } as Record<string, string>,
      _header: { authorization: 'Bearer queued-token' } as Record<string, string>,
      retry: vi.fn(),
    };
    expect(prototype.end.call(first, 'first')).toEqual({ receiver: first, value: 'first' });
    expect(prototype.end.call(second, 'second')).toBe(second);
    expect(originalEnd).toHaveBeenCalledOnce();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delayMs).toBe(50);

    second.header = {};
    second._header = {};
    scheduled[0].fn();
    expect(second.header.Authorization).toBe('Bearer queued-token');
    expect(second._header.authorization).toBe('Bearer queued-token');
    expect(originalEnd).toHaveBeenCalledTimes(2);
    expect(originalEnd.mock.calls[1]).toEqual(['second']);
  });

  it('restores caller headers immediately before every ClientRequest build', () => {
    const { originalRequest, prototype } = makePrototype();
    installSupertestConnectRetry(prototype as never, { minStartIntervalMs: 0 });

    const instance = {
      header: { Authorization: 'Bearer boundary-token' } as Record<string, string>,
      _header: { authorization: 'Bearer boundary-token' } as Record<string, string>,
      retry: vi.fn(),
    };
    prototype.end.call(instance, 'done');

    // Model an internal mutation after end() bookkeeping but before Superagent
    // constructs (or reconstructs) the underlying Node ClientRequest.
    instance.header = {};
    instance._header = {};
    prototype.request.call(instance);

    expect(instance.header.Authorization).toBe('Bearer boundary-token');
    expect(instance._header.authorization).toBe('Bearer boundary-token');
    expect(originalRequest).toHaveBeenCalledOnce();
  });

  it('marks the intended temporary server and retries a response from a recycled port', () => {
    const { prototype } = makePrototype();
    installSupertestConnectRetry(prototype as never, { minStartIntervalMs: 0 });

    let requestListener: ((_request: unknown, response: { setHeader(name: string, value: string): void }) => void) | undefined;
    let predicate: SupertestRetryPredicate | undefined;
    const server = {
      prependListener: vi.fn((_event: 'request', listener: typeof requestListener) => {
        requestListener = listener;
      }),
    };
    const instance = {
      retry: vi.fn((_count: number, nextPredicate: SupertestRetryPredicate) => {
        predicate = nextPredicate;
      }),
    };

    prototype.serverAddress.call(instance, server, '/expected');
    prototype.end.call(instance, 'done');

    const responseHeaders: Record<string, string> = {};
    requestListener?.({}, {
      setHeader: (name, value) => {
        responseHeaders[name] = value;
      },
    });

    expect(server.prependListener).toHaveBeenCalledWith('request', expect.any(Function));
    expect(predicate?.(undefined, { headers: responseHeaders })).toBe(false);
    expect(predicate?.(undefined, {
      headers: { 'x-instar-supertest-server': 'different-server' },
    })).toBe(true);
  });

  it('reopens a Supertest-owned listener on a fresh port before a connect-timeout retry', () => {
    const { originalRetry, prototype } = makePrototype();
    installSupertestConnectRetry(prototype as never, { minStartIntervalMs: 0 });

    let predicate: SupertestRetryPredicate | undefined;
    const server = {
      listening: true,
      address: vi.fn(() => ({ port: 43_210 })),
      close: vi.fn((callback: (error?: Error) => void) => {
        server.listening = false;
        callback();
      }),
      listen: vi.fn((_port: number, callback: () => void) => {
        server.listening = true;
        callback();
        return server;
      }),
    };
    const instance = {
      url: 'http://127.0.0.1:12345/test?x=1',
      _server: server,
      retry: vi.fn((_count: number, nextPredicate: SupertestRetryPredicate) => {
        predicate = nextPredicate;
      }),
    };
    prototype.end.call(instance, 'done');

    expect(predicate?.({ code: 'ETIMEDOUT', syscall: 'connect' })).toBe(true);
    const result = prototype._retry.call(instance);

    expect(result).toBe(instance);
    expect(server.close).toHaveBeenCalledOnce();
    expect(server.listen).toHaveBeenCalledWith(0, expect.any(Function));
    expect(instance.url).toBe('http://127.0.0.1:43210/test?x=1');
    expect(originalRetry).toHaveBeenCalledOnce();
  });

  it('preserves an explicit per-request retry policy, including retry(0)', () => {
    const { prototype } = makePrototype();
    installSupertestConnectRetry(prototype as never, { minStartIntervalMs: 0 });

    const instance = { _maxRetries: 0, retry: vi.fn() };
    prototype.end.call(instance, 'done');
    expect(instance.retry).not.toHaveBeenCalled();
  });

  it('is idempotent when setup is evaluated more than once', () => {
    const { prototype } = makePrototype();
    installSupertestConnectRetry(prototype as never, { minStartIntervalMs: 0 });
    const installedEnd = prototype.end;
    installSupertestConnectRetry(prototype as never, { minStartIntervalMs: 0 });
    expect(prototype.end).toBe(installedEnd);
  });
});
