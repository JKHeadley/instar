/**
 * SEC-018 companion: approvedDeleteViaHttp — the stdio helper's call to the loopback route.
 * A clean 200 with an ApprovedDeleteResult is returned verbatim; a transport failure, a non-2xx,
 * or an unparseable/ambiguous answer THROWS (→ the handler maps it to OUTCOME-UNKNOWN and never
 * falls back to a local delete, because the server MAY have deleted before the answer was lost).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { approvedDeleteViaHttp } from '../../src/threadline/mcp-http-client.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(impl: () => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>) {
  globalThis.fetch = vi.fn(impl) as unknown as typeof fetch;
}

describe('approvedDeleteViaHttp (SEC-018 companion)', () => {
  it('returns the server result verbatim on a clean 200 (ok:true)', async () => {
    mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, deleted: true, info: { threadId: 't' } }) }));
    await expect(approvedDeleteViaHttp('t', 4042, 'tok')).resolves.toEqual({ ok: true, deleted: true, info: { threadId: 't' } });
  });

  it('returns owner-approval-required (a DEFINITE answer, not outcome-unknown)', async () => {
    mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, reason: 'owner-approval-required' }) }));
    await expect(approvedDeleteViaHttp('t', 4042, 'tok')).resolves.toEqual({ ok: false, reason: 'owner-approval-required' });
  });

  it('THROWS (outcome-unknown) on a transport failure', async () => {
    mockFetch(async () => { throw new Error('ECONNREFUSED'); });
    await expect(approvedDeleteViaHttp('t', 4042, 'tok')).rejects.toThrow();
  });

  it('THROWS (outcome-unknown) on a non-2xx — the server may have deleted before erroring', async () => {
    mockFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(approvedDeleteViaHttp('t', 4042, 'tok')).rejects.toThrow();
  });

  it('THROWS (outcome-unknown) on an unparseable / shapeless 200 — never assume failure', async () => {
    mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ unexpected: 'shape' }) }));
    await expect(approvedDeleteViaHttp('t', 4042, 'tok')).rejects.toThrow();
  });
});
