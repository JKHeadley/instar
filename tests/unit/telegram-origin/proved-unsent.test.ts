import { describe, expect, it } from 'vitest';
import { fetchFailureCode, provedUnsentCode } from '../../../src/messaging/telegram-origin/OriginTransportCancellation.js';

const sys = (code: string, syscall?: string) => Object.assign(new Error(code), { code, ...(syscall ? { syscall } : {}) });
const failed = (cause: unknown) => Object.assign(new TypeError('fetch failed'), { cause });

describe('provedUnsentCode — only connect-phase evidence proves a request never left', () => {
  it('accepts DNS failures, refused/unreachable connects and the undici connect timeout', () => {
    expect(provedUnsentCode(failed(sys('ENOTFOUND', 'getaddrinfo')))).toBe('ENOTFOUND');
    expect(provedUnsentCode(failed(sys('EAI_AGAIN', 'getaddrinfo')))).toBe('EAI_AGAIN');
    expect(provedUnsentCode(failed(sys('ECONNREFUSED', 'connect')))).toBe('ECONNREFUSED');
    expect(provedUnsentCode(failed(sys('EHOSTUNREACH', 'connect')))).toBe('EHOSTUNREACH');
    expect(provedUnsentCode(failed(sys('UND_ERR_CONNECT_TIMEOUT')))).toBe('UND_ERR_CONNECT_TIMEOUT');
  });
  it('accepts a multi-address connect only when every address failed to connect', () => {
    const all = Object.assign(new AggregateError([sys('ETIMEDOUT', 'connect'), sys('ENETUNREACH', 'connect')]), { code: 'ETIMEDOUT' });
    expect(provedUnsentCode(failed(all))).toBe('ETIMEDOUT');
    const mixed = Object.assign(new AggregateError([sys('ETIMEDOUT', 'connect'), sys('ECONNRESET', 'read')]), { code: 'ETIMEDOUT' });
    expect(provedUnsentCode(failed(mixed))).toBeNull();
  });
  it('refuses anything after a connection existed, and plain errors', () => {
    expect(provedUnsentCode(failed(sys('ECONNRESET', 'read')))).toBeNull();
    expect(provedUnsentCode(failed(sys('ETIMEDOUT', 'read')))).toBeNull();
    expect(provedUnsentCode(failed(sys('ECONNREFUSED')))).toBeNull(); // no syscall: not provably connect
    expect(provedUnsentCode(failed(sys('UND_ERR_SOCKET')))).toBeNull();
    expect(provedUnsentCode(new Error('boom'))).toBeNull();
    expect(provedUnsentCode(undefined)).toBeNull();
  });
  it('fetchFailureCode names the wrapped code', () => {
    expect(fetchFailureCode(failed(sys('UND_ERR_SOCKET')))).toBe('UND_ERR_SOCKET');
    expect(fetchFailureCode(new Error('x'))).toBeNull();
  });
});
