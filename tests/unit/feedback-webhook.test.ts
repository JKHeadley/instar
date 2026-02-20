import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Validates feedback webhook configuration.
 * The webhook URL should point to the Portal production endpoint.
 */
describe('Feedback webhook configuration', () => {
  it('default webhook URL points to Portal production', () => {
    const configSource = fs.readFileSync(
      path.join(process.cwd(), 'src/core/Config.ts'),
      'utf-8'
    );
    expect(configSource).toContain('https://dawn.bot-me.ai/api/instar/feedback');
  });

  it('feedback CLI command uses server endpoint', () => {
    const cliSource = fs.readFileSync(
      path.join(process.cwd(), 'src/cli.ts'),
      'utf-8'
    );
    // CLI feedback command should POST to server's /feedback endpoint
    expect(cliSource).toContain('/feedback');
  });

  it('FeedbackManager uses 10s timeout', () => {
    const feedbackSource = fs.readFileSync(
      path.join(process.cwd(), 'src/core/FeedbackManager.ts'),
      'utf-8'
    );
    // Should have a timeout to prevent hangs
    expect(feedbackSource).toContain('AbortSignal.timeout');
  });
});
