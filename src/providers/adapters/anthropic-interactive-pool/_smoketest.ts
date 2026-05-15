/**
 * Smoke test — exercises the adapter against a real `claude` REPL pool.
 *
 * Run with:
 *   INSTAR_REAL_API=1 npx tsx \
 *     src/providers/adapters/anthropic-interactive-pool/_smoketest.ts
 *
 * Skipped unless INSTAR_REAL_API=1 (avoids burning subscription session
 * quota on every CI run). Expected to draw from Max subscription billing,
 * NOT the Agent SDK credit pot.
 */

import { createAnthropicInteractivePoolAdapter } from './index.js';
import { CapabilityFlag } from '../../capabilities.js';
import type { OneShotCompletion } from '../../primitives/transport/oneShotCompletion.js';

async function main(): Promise<void> {
  if (process.env['INSTAR_REAL_API'] !== '1') {
    console.log('SKIPPED — set INSTAR_REAL_API=1 to run');
    return;
  }
  const adapter = createAnthropicInteractivePoolAdapter({ poolSize: 1 });
  console.log('Starting pool (size 1) ...');
  const poolStart = Date.now();
  await adapter.start();
  console.log(`Pool ready in ${Date.now() - poolStart}ms`);

  const oneShot = adapter.primitive(CapabilityFlag.OneShotCompletion) as OneShotCompletion;
  console.log('Sending prompt through pool ...');
  const start = Date.now();
  try {
    const result = await oneShot.evaluate(
      'What is 2+2? Reply with just the number, no other text.',
      { model: 'fast', timeoutMs: 120_000 },
    );
    const elapsed = Date.now() - start;
    console.log(`Response (${elapsed}ms): ${JSON.stringify(result.text)}`);
    const text = result.text.trim();
    if (!/4/.test(text)) {
      console.error(`FAIL: expected response to contain "4", got: ${JSON.stringify(text)}`);
      await adapter.dispose?.();
      process.exit(1);
    }
    console.log('PASS');
  } finally {
    await adapter.dispose?.();
  }
}

void main().catch(async (err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
