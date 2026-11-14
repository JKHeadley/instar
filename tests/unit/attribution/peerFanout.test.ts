import { describe, expect, it, vi } from 'vitest';
import { MAX_PEERS, MAX_PEER_RESPONSE_BYTES, PeerFanout } from '../../../src/core/attribution/peerFanout.js';
import type { SourceRef } from '../../../src/core/attribution/marker.js';

const ref: SourceRef = { channel: 'telegram', conversation: '1', message: '2', date: '2026-10-08' };
const peer = (machineId: string) => ({ machineId, url: `http://10.${machineId.length}.0.1:4042`, kind: 'tailscale' });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('PeerFanout', () => {
  it('a peer with the row answers with its own verdict; only `scope=local` is ever asked', async () => {
    const fetchImpl = vi.fn(async () => json({ row: { text: 'x' }, retainedFrom: '2026-01-01', authorship: 'human' }));
    const answers = await new PeerFanout({ peers: () => [peer('mini')], authToken: () => 't', fetchImpl: fetchImpl as never }).askResolve(ref);
    expect(answers[0]).toMatchObject({ machine: 'mini', answered: true, lookup: { authorship: 'human' } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('scope=local');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer t' });
  });

  it('a 404, a 503 or a redirect is no answer, never absence', async () => {
    for (const status of [404, 503, 302]) {
      const fetchImpl = vi.fn(async () => new Response('', { status }));
      const answers = await new PeerFanout({ peers: () => [peer('old')], authToken: () => 't', fetchImpl: fetchImpl as never }).askResolve(ref);
      expect(answers).toEqual([{ machine: 'old', answered: false }]);
    }
  });

  it('one peer down does not hide the other', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('10.4.0.1')) throw new Error('refused');
      return json({ row: null, retainedFrom: '2026-01-01' });
    });
    const answers = await new PeerFanout({ peers: () => [peer('down'), peer('up')], authToken: () => 't', fetchImpl: fetchImpl as never }).askResolve(ref);
    expect(answers.map((a) => a.answered)).toEqual([false, true]);
  });

  it('asks at most 16 peers and reports the rest as not answering', async () => {
    const fetchImpl = vi.fn(async () => json({ row: null, retainedFrom: null }));
    const peers = Array.from({ length: MAX_PEERS + 3 }, (_, i) => peer(`m${i}`));
    const answers = await new PeerFanout({ peers: () => peers, authToken: () => 't', fetchImpl: fetchImpl as never }).askResolve(ref);
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_PEERS);
    expect(answers.filter((a) => !a.answered)).toHaveLength(3);
  });

  it('a registered machine with no usable URL counts as not answering, never as absence', async () => {
    const fetchImpl = vi.fn(async () => json({ row: null, retainedFrom: '2026-01-01' }));
    const answers = await new PeerFanout({ peers: () => [peer('up')], registeredMachines: () => ['up', 'no-url'], authToken: () => 't', fetchImpl: fetchImpl as never }).askResolve(ref);
    expect(answers.map((a) => [a.machine, a.answered])).toEqual([['up', true], ['no-url', false]]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('with no peers dialable yet, a registered machine still blocks a not-found', async () => {
    const answers = await new PeerFanout({ peers: () => [], registeredMachines: () => ['mini'], authToken: () => 't' }).askResolve(ref);
    expect(answers).toEqual([{ machine: 'mini', answered: false }]);
  });

  it('refuses a response over 512KB', async () => {
    const fetchImpl = vi.fn(async () => json({ pad: 'x'.repeat(MAX_PEER_RESPONSE_BYTES + 10) }));
    const answers = await new PeerFanout({ peers: () => [peer('big')], authToken: () => 't', fetchImpl: fetchImpl as never }).askResolve(ref);
    expect(answers[0].answered).toBe(false);
  });

  it('one shared deadline: a hung peer costs the deadline, not more', async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const started = Date.now();
    const answers = await new PeerFanout({ peers: () => [peer('hung')], authToken: () => 't', fetchImpl: fetchImpl as never, deadlineMs: 50 }).askResolve(ref);
    expect(answers[0].answered).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('never dials a URL the credential guard refuses', async () => {
    const fetchImpl = vi.fn(async () => json({}));
    const answers = await new PeerFanout({ peers: () => [{ machineId: 'evil', url: 'http://evil.example.com', kind: 'last-known-url' }], authToken: () => 't', fetchImpl: fetchImpl as never }).askResolve(ref);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(answers[0].answered).toBe(false);
  });
});
