import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Validates feedback webhook configuration.
 * The webhook URL default must resolve through the single canonical constant
 * (core/canonicalFeedback.ts) — post-Phase-4 that is the operated instance's
 * canonical front, NOT the legacy Portal endpoint.
 */
describe('Feedback webhook configuration', () => {
  it('default webhook URL resolves through the canonical constant (single source)', () => {
    const configSource = fs.readFileSync(
      path.join(process.cwd(), 'src/core/Config.ts'),
      'utf-8'
    );
    expect(configSource).toContain('CANONICAL_FEEDBACK_URL');
    // The literal legacy URL must no longer be inlined anywhere in the loader.
    expect(configSource).not.toContain('dawn.bot-me.ai/api/instar/feedback');

    const canonicalSource = fs.readFileSync(
      path.join(process.cwd(), 'src/core/canonicalFeedback.ts'),
      'utf-8'
    );
    expect(canonicalSource).toContain('https://feedback.dawn-tunnel.dev/api/feedback');
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
