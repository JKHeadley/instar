/**
 * End-to-end Layer 4 logic test (mock I/O only): createA2ACheckInScheduler wires the scheduler →
 * runCheckIn → policy → summarizer → guard → surface. A silence-breaker tick produces a REDACTED
 * prompt to the summarizer and surfaces the GUARDED summary to the bound topic.
 */
import { describe, it, expect, vi } from 'vitest';
import { createA2ACheckInScheduler } from '../../../src/threadline/A2ACheckInScheduler.js';

const INTERVAL = 420_000;

describe('createA2ACheckInScheduler — Layer 4 end-to-end (mock I/O)', () => {
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
