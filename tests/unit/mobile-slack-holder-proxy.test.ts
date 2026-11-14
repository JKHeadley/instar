import { describe, it, expect } from 'vitest';
import { buildSlackHolderRead, HOLDER_READ_MAX_PER_HOLDER, type HolderReadDeps } from '../../src/server/mobileSlackHolderProxy.js';

const peer = (machineId: string) => ({ machineId, url: `http://127.0.0.1:1/${machineId}`, kind: 'lan' as const });
const deps = (fetchImpl: typeof fetch, over: Partial<HolderReadDeps> = {}): HolderReadDeps => ({
  peers: () => [peer('m_b'), peer('m_c')], token: () => 'tok', selfMachineId: () => 'm_a', fetchImpl, ...over,
});
const ask = (machine = 'm_b', before: string | null = null) => ({ id: -7, machine, limit: 10, before, stillOwner: () => true });
const good = () => new Response(JSON.stringify({ deviceView: true, conversationId: -7, messages: [] }));

describe('buildSlackHolderRead', () => {
  it('sends only a GET with the token, no redirects followed, and encodes the cursor', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const read = buildSlackHolderRead(deps((async (u: string, i?: RequestInit) => { calls.push([u, i]); return good(); }) as typeof fetch));
    expect((await read(ask('m_b', '2026-11-05T00:00:00Z,slack:1&x=y'))).status).toBe(200);
    expect(calls[0]![0]).toContain('&before=2026-11-05T00%3A00%3A00Z%2Cslack%3A1%26x%3Dy');
    expect(calls[0]![1]).toMatchObject({ redirect: 'manual', headers: { Authorization: 'Bearer tok' } });
    expect(calls[0]![1]?.method).toBeUndefined();
  });

  it('refuses an oversized cursor and a missing token with no request', async () => {
    let calls = 0;
    const f = (async () => { calls++; return good(); }) as unknown as typeof fetch;
    expect((await buildSlackHolderRead(deps(f))(ask('m_b', 'x'.repeat(301)))).status).toBe(400);
    expect((await buildSlackHolderRead(deps(f, { token: () => undefined }))(ask())).status).toBe(503);
    expect(calls).toBe(0);
  });

  it('one dead holder cannot take every slot, and its slots come back', async () => {
    const release: Array<() => void> = [];
    let held = true;
    const f = (async (u: string) => {
      if (held && u.includes('m_b')) await new Promise<void>((go) => release.push(go));
      return good();
    }) as unknown as typeof fetch;
    const read = buildSlackHolderRead(deps(f));
    const stuck = Array.from({ length: HOLDER_READ_MAX_PER_HOLDER }, () => read(ask('m_b')));
    await new Promise((r) => setTimeout(r, 5));
    expect((await read(ask('m_b'))).body.error).toBe('holder-busy');
    expect((await read(ask('m_c'))).status).toBe(200);
    held = false;
    release.forEach((go) => go());
    await Promise.all(stuck);
    expect((await read(ask('m_b'))).status).toBe(200);
  });

  it('a transport failure answers without leaking its message', async () => {
    const read = buildSlackHolderRead(deps((async () => { throw new Error('connect ECONNREFUSED http://secret-host'); }) as unknown as typeof fetch));
    const r = await read(ask());
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toContain('secret-host');
  });
});

describe('owner admission at every transport and emission boundary', () => {
  it('refuses before the first dial without reporting a rope failure', async () => {
    let dials = 0, reports = 0;
    const read = buildSlackHolderRead(deps((async () => { dials++; return good(); }) as typeof fetch,
      { record: () => { reports++; } }));
    const answer = await read({ ...ask(), stillOwner: () => false });
    expect(answer.status).toBe(403); expect(dials).toBe(0); expect(reports).toBe(0);
  });
  it.each(['failed-dial', 'edge'])('does not dial another rope after owner loss following %s', async first => {
    let current = true, dials = 0;
    const reports: boolean[] = [];
    const read = buildSlackHolderRead(deps((async () => {
      dials++; current = false;
      if (first === 'failed-dial') throw new TypeError('dial failed');
      return new Response('edge', { status: 530 });
    }) as typeof fetch, {
      peers: () => [{ machineId: 'm_b', url: 'http://127.0.0.1:1',
        kind: first === 'edge' ? 'cloudflare' : 'lan',
        ropes: [{ url: 'http://127.0.0.1:2', kind: 'lan' }] }],
      record: (_machine, _kind, ok) => { reports.push(ok); },
    }));
    const answer = await read({ ...ask(), stillOwner: () => current });
    expect(answer.status).toBe(403);
    expect(dials).toBe(1); expect(reports).toEqual([false]);
  });
  it('checks current authority again after body formatting', async () => {
    let checks = 0;
    const read = buildSlackHolderRead(deps((async () => good()) as typeof fetch));
    const answer = await read({ ...ask(), stillOwner: () => ++checks < 3 });
    expect(checks).toBe(3); expect(answer.status).toBe(403); expect(answer.body.messages).toBeUndefined();
  });
});
