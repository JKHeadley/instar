/**
 * Smoke test — exercises the adapter against a real `claude -p` invocation.
 *
 * Run with: npx tsx src/providers/adapters/anthropic-headless/_smoketest.ts
 *
 * Skipped unless INSTAR_REAL_API=1 (avoids burning quota on every CI run).
 */

import { createAnthropicHeadlessAdapter } from './index.js';
import { CapabilityFlag } from '../../capabilities.js';
import type { OneShotCompletion } from '../../primitives/transport/oneShotCompletion.js';

async function main(): Promise<void> {
  if (process.env['INSTAR_REAL_API'] !== '1') {
    console.log('SKIPPED — set INSTAR_REAL_API=1 to run');
    return;
  }
  const adapter = createAnthropicHeadlessAdapter();
  const oneShot = adapter.primitive(CapabilityFlag.OneShotCompletion) as OneShotCompletion;
  console.log('Calling claude -p ...');
  const start = Date.now();
  const result = await oneShot.evaluate('What is 2+2? Reply with just the number, no other text.', {
    model: 'fast',
    timeoutMs: 60_000,
  });
  const elapsed = Date.now() - start;
  console.log(`Response (${elapsed}ms): ${JSON.stringify(result.text)}`);
  const text = result.text.trim();
  if (!/^4\b/.test(text)) {
    console.error(`FAIL: expected response to start with "4", got: ${JSON.stringify(text)}`);
    process.exit(1);
  }
  console.log('PASS');
}

void main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
