/**
 * End-to-end Layer 4 logic test (mock I/O only): createA2ACheckInScheduler wires the scheduler →
 * runCheckIn → policy → summarizer → guard → surface. A silence-breaker tick produces a REDACTED
 * prompt to the summarizer and surfaces the GUARDED summary to the bound topic.
 */
import { describe, it, expect, vi } from 'vitest';
import { createA2ACheckInScheduler } from '../../../src/threadline/A2ACheckInScheduler.js';

const INTERVAL = 420_000;

describe('createA2ACheckInScheduler — Layer 4 end-to-end (mock I/O)', () => {
  it('keeps overlapping summarizer selections attached to the body each call authored', async () => {
    let now = 0;
    const pending: Array<{ finish: (body: string) => void; call: import('../../../src/messaging/telegram-origin/OriginAutomationAuthor.js').OriginAuthorCall }> = [];
    const surface = vi.fn(async () => undefined);
    const make = (threadId: string) => createA2ACheckInScheduler({
      listActiveThreads: () => [{ threadId, peerName: 'Dawn', topicId: 42 }],
      summarize: (_prompt, call) => new Promise<string>(finish => pending.push({ finish, call })),
      surface, getHistory: () => 'Dawn: still working', now: () => now,
      config: { enabled: true, heartbeatEnabled: true, heartbeatIntervalMs: INTERVAL },
    });
    const first = make('first'), second = make('second'); await first.tick(); await second.tick();
    now = INTERVAL + 1; const runs = [first.tick(), second.tick()];
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0].call.options({ model: 'fast' }).onModel!({ model: 'resolved-first', framework: 'codex-cli' });
    pending[1].call.options({ model: 'fast' }).onModel!({ model: 'initial-second', framework: 'claude-code' });
    pending[1].call.options({ model: 'fast' }).onModel!({ model: 'fallback-second', framework: 'claude-code' });
    pending[1].finish('Dawn says the second check is ready.'); pending[0].finish('Dawn says the first check is ready.');
    await Promise.all(runs);
    const rows = surface.mock.calls.map(call => (call as unknown as [{ threadId: string; body: string; originAuthor: { model: { value: string; status: string } } }])[0]);
    expect(rows.find(row => row.threadId === 'first')).toMatchObject({ body: 'Dawn says the first check is ready.', originAuthor: { model: { value: 'resolved-first', status: 'configured' } } });
    expect(rows.find(row => row.threadId === 'second')).toMatchObject({ body: 'Dawn says the second check is ready.', originAuthor: { model: { value: 'fallback-second', status: 'configured' } } });
  });
  it('a silence-breaker tick redacts the prompt and surfaces a guarded summary to the topic', async () => {
    const clock = { t: 0 };
    const summarize = vi.fn(async () => 'Dawn says the migration is progressing; nothing needs you.');
    const surface = vi.fn(async () => {});
    const getHistory = vi.fn(() => 'Dawn: my key is API_KEY=topsecret9999\nMe: ack');

    const scheduler = createA2ACheckInScheduler({
      listActiveThreads: () => [{ threadId: 't1', peerName: 'Dawn', topicId: 12476 }],
      summarize,
      surface,
      getHistory,
      config: { enabled: true, heartbeatEnabled: true, heartbeatIntervalMs: INTERVAL },
      now: () => clock.t,
    });

    clock.t = 0;
    await scheduler.tick(); // first sight — no surface
    expect(summarize).not.toHaveBeenCalled();

    clock.t = INTERVAL + 1; // silence-breaker fires
    await scheduler.tick();

    // Summarizer got a prompt — and the raw credential from history was redacted out of it.
    expect(summarize).toHaveBeenCalledOnce();
    const prompt = summarize.mock.calls[0][0];
    expect(prompt).not.toContain('topsecret9999');
    expect(prompt).toContain('[REDACTED]');
    expect(prompt).toContain('UNTRUSTED DATA');

    // The guarded summary surfaced to the bound topic as a heartbeat.
    expect(surface).toHaveBeenCalledOnce();
    expect(surface.mock.calls[0][0]).toMatchObject({
      threadId: 't1',
      topicId: 12476,
      kind: 'heartbeat',
      body: 'Dawn says the migration is progressing; nothing needs you.',
    });
  });

  it('does not surface when disabled (start() is a no-op, tick stays quiet)', async () => {
    const surface = vi.fn(async () => {});
    const scheduler = createA2ACheckInScheduler({
      listActiveThreads: () => [{ threadId: 't1', peerName: 'Dawn', topicId: 12476 }],
      summarize: vi.fn(async () => 'x'),
      surface,
      getHistory: () => 'hi',
      config: { enabled: false, heartbeatEnabled: true, heartbeatIntervalMs: INTERVAL },
      now: () => 10 * INTERVAL,
    });
    await scheduler.tick();
    expect(surface).not.toHaveBeenCalled();
  });
});
