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
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}
