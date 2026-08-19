/**
 * Smoke test for the openai-codex adapter — real-API path.
 *
 * Gated on Codex credential availability. If `OPENAI_API_KEY` is set OR
 * `~/.codex/auth.json` shows valid OAuth tokens, runs a real prompt through
 * the adapter and verifies that it returned non-empty text. Without creds,
 * the smoke test reports BLOCKED and exits 2, which cannot satisfy the
 * acceptance gate.
 *
 * Run with:
 *   npx tsx src/providers/adapters/openai-codex/_smoketest.ts
 *   node node_modules/vite-node/vite-node.mjs src/providers/adapters/openai-codex/_smoketest.ts --json
 *   OPENAI_API_KEY=sk-... npx tsx src/providers/adapters/openai-codex/_smoketest.ts
 */

import { createOpenAiCodexAdapter } from './index.js';
import { CapabilityFlag } from '../../capabilities.js';
import type { OneShotCompletion } from '../../primitives/transport/oneShotCompletion.js';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createCodexSmoketestReporter } from './smoketest-result.js';

const jsonOutput = process.argv.includes('--json');
const reporter = createCodexSmoketestReporter(jsonOutput);

async function hasCredentials(): Promise<{ has: boolean; source: string }> {
  if (process.env['OPENAI_API_KEY']?.startsWith('sk-')) {
    return { has: true, source: 'OPENAI_API_KEY env' };
  }
  const authFile = path.join(process.env['CODEX_HOME'] || path.join(homedir(), '.codex'), 'auth.json');
  try {
    const raw = await fs.readFile(authFile, 'utf-8');
    const parsed = JSON.parse(raw) as { tokens?: { access_token?: string }; OPENAI_API_KEY?: string };
    if (parsed.tokens?.access_token) return { has: true, source: '~/.codex/auth.json oauth' };
    if (parsed.OPENAI_API_KEY) return { has: true, source: '~/.codex/auth.json api-key' };
  } catch {
    /* no file */
  }
  return { has: false, source: '(none)' };
}

async function main(): Promise<void> {
  const creds = await hasCredentials();
  if (!creds.has) {
    reporter.info('[openai-codex smoketest] BLOCKED — no Codex credentials available');
    reporter.info('  Set OPENAI_API_KEY=sk-... or run `codex login` to enable real-API testing.');
    // Exit non-zero: acceptance gates treat missing-creds as BLOCKED, not PASS.
    // The old "exit 0 to keep the autonomous loop moving" was the soft-failure
    // escape hatch that let me claim Phase 4 complete with zero real calls.
    // See memory/feedback_phase_completion_real_api_verified.md.
    process.exitCode = 2;
    return;
  }
  reporter.info(`[openai-codex smoketest] running with creds from: ${creds.source}`);

  const adapter = createOpenAiCodexAdapter();
  const oneShot = adapter.primitive(CapabilityFlag.OneShotCompletion) as OneShotCompletion;

  const start = Date.now();
  let result;
  try {
    result = await oneShot.evaluate('Reply with exactly the word: PONGXYZ', {
      timeoutMs: 30_000,
      model: 'fast',
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (/not supported.*ChatGPT account|unauthorized|invalid.*token|auth/i.test(msg)) {
      // eslint-disable-next-line no-console
      console.error(`[openai-codex smoketest] AUTH-BLOCKED — credentials present but rejected by Codex: ${msg.slice(0, 200)}`);
      // eslint-disable-next-line no-console
      console.error('  Likely cause: ChatGPT subscription lapsed or OAuth token expired. Run `codex login` to refresh.');
      // Exit non-zero: acceptance gates treat auth-blocked as BLOCKED, not PASS.
      process.exitCode = 3;
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[openai-codex smoketest] FAILED:', msg);
    process.exitCode = 1;
    return;
  }
  const elapsed = Date.now() - start;

  reporter.info(`[openai-codex smoketest] OneShotCompletion responded in ${elapsed}ms`);
  reporter.info(`  text: ${JSON.stringify(result.text.slice(0, 120))}`);
  reporter.info(`  usage: ${JSON.stringify(result.usage)}`);

  const success = reporter.success(result.text);
  if (!success) {
    // eslint-disable-next-line no-console
    console.error('[openai-codex smoketest] AUTH-BLOCKED — empty response (Codex CLI rejected creds silently, hit timeout)');
    // eslint-disable-next-line no-console
    console.error('  Likely cause: subscription lapsed. Re-run `codex login` to refresh OAuth.');
    // Exit non-zero: empty response is failure, not a pass.
    process.exitCode = 3;
    return;
  }
  process.exitCode = 0;
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[openai-codex smoketest] crashed:', err);
  process.exitCode = 2;
});
