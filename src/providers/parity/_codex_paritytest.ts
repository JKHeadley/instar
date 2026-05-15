/**
 * Codex-vs-Anthropic parity test — Phase 4 step 4.
 *
 * Runs the same scenario set against `anthropic-headless` (left) and
 * `openai-codex` (right). The Phase 4 acceptance test: can the substrate
 * abstract over BOTH providers correctly, not just two Anthropic flavors?
 *
 * Real-API scenarios are gated by INSTAR_REAL_API=1 AND require valid
 * credentials for both providers. Structural-only scenarios always run.
 *
 * Run with:
 *   npx tsx src/providers/parity/_codex_paritytest.ts
 *   INSTAR_REAL_API=1 npx tsx src/providers/parity/_codex_paritytest.ts
 */

import { createAnthropicHeadlessAdapter } from '../adapters/anthropic-headless/index.js';
import { createOpenAiCodexAdapter } from '../adapters/openai-codex/index.js';
import {
  allParityScenarios,
  runParitySuite,
  reportParityResults,
} from './index.js';

async function main(): Promise<void> {
  const realApi = process.env['INSTAR_REAL_API'] === '1';
  // eslint-disable-next-line no-console
  console.log(`Codex×Anthropic parity suite — realApi=${realApi}`);

  const left = createAnthropicHeadlessAdapter();
  const right = createOpenAiCodexAdapter();

  const results = await runParitySuite(
    {
      left: left as unknown as Parameters<typeof runParitySuite>[0]['left'],
      right: right as unknown as Parameters<typeof runParitySuite>[0]['right'],
      ctx: { realApi, timeoutMs: 120_000 },
    },
    allParityScenarios,
  );

  const exitCode = reportParityResults(results);
  process.exit(exitCode);
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('codex parity suite crashed:', err);
  process.exit(2);
});
