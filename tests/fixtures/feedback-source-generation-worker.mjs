import { FeedbackSourceGenerations } from '../../src/feedback-factory/store/FeedbackSourceGenerations.ts';

const [dir, mode, value] = process.argv.slice(2);
const generations = new FeedbackSourceGenerations(dir);
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    if (mode === 'compact') generations.compact(Number(value));
    else generations.append({ feedbackId: value, status: 'unprocessed' });
    process.exit(0);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('busy')) throw error;
    // Same thundering-herd fix as feedback-performance-concurrent-ingest.mjs:
    // this worker is spawned CONCURRENTLY by the multiprocess test, so a flat
    // 5ms cadence keeps every contender waking on the same tick and colliding
    // on the same slots. This budget was even smaller (100 x 5ms = ~500ms).
    // Jitter de-synchronises; the growth lengthens the budget under real
    // contention; the 40ms cap keeps a stuck lock failing promptly.
    const backoffMs = Math.min(5 * 2 ** Math.min(attempt, 3), 40);
    await new Promise((resolve) => setTimeout(resolve, backoffMs * (0.5 + Math.random())));
  }
}
throw new Error('generation fence remained busy');
