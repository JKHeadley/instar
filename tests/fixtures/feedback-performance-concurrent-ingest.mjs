import { FeedbackSourceGenerations } from '../../src/feedback-factory/store/FeedbackSourceGenerations.ts';
const [dir] = process.argv.slice(2);
const source = new FeedbackSourceGenerations(dir);
for (let i = 0; i < 100; i++) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      source.append({ feedbackId: `concurrent-perf-${i}`, title: 'Concurrent scheduler report', description: 'bounded',
        type: 'bug', status: 'unprocessed', receivedAt: '2026-07-20T00:00:00.000Z' });
      break;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('busy') || attempt === 199) throw error;
      // Exponential backoff WITH JITTER, not a flat 5ms.
      //
      // A flat cadence is a thundering herd: every contending worker wakes on
      // the same 5ms tick, so they keep colliding on the same slots and the
      // ~1s budget (200 x 5ms) can expire with nobody making progress. That is
      // how this fixture reddened main on 2026-07-28 under a loaded runner.
      //
      // Jitter de-synchronises the workers; the growth lengthens the budget
      // when contention is real. The 40ms cap keeps the worst case bounded —
      // ~6s per append rather than ~24s, because a genuinely stuck lock should
      // fail promptly rather than stall a 100-iteration loop.
      const backoffMs = Math.min(5 * 2 ** Math.min(attempt, 3), 40);
      await new Promise((resolve) => setTimeout(resolve, backoffMs * (0.5 + Math.random())));
    }
  }
}
