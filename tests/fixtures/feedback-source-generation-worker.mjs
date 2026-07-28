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
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
throw new Error('generation fence remained busy');
