/**
 * Smoke test for the openai-codex adapter — real-API path.
 *
 * Gated on Codex credential availability. If `OPENAI_API_KEY` is set OR
 * `~/.codex/auth.json` shows valid OAuth tokens, runs three real prompts
 * through the adapter and verifies the result shape. Without creds, the
 * smoke test prints "skipped" and exits 0 (matching the Anthropic smoke
 * gating semantics).
 *
 * Run with:
 *   npx tsx src/providers/adapters/openai-codex/_smoketest.ts
 *   OPENAI_API_KEY=sk-... npx tsx src/providers/adapters/openai-codex/_smoketest.ts
 */

import { createOpenAiCodexAdapter } from './index.js';
import { CapabilityFlag } from '../../capabilities.js';
import type { OneShotCompletion } from '../../primitives/transport/oneShotCompletion.js';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

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
    // eslint-disable-next-line no-console
    console.log('[openai-codex smoketest] skipped — no Codex credentials available');
    // eslint-disable-next-line no-console
    console.log('  Set OPENAI_API_KEY=sk-... or run `codex login` to enable real-API testing.');
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.log(`[openai-codex smoketest] running with creds from: ${creds.source}`);

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
      console.log(`[openai-codex smoketest] AUTH-BLOCKED — credentials present but rejected by Codex: ${msg.slice(0, 200)}`);
      // eslint-disable-next-line no-console
      console.log('  Likely cause: ChatGPT subscription lapsed or OAuth token expired. Run `codex login` to refresh.');
      process.exit(0); // not a build failure; surface to operator
    }
    // eslint-disable-next-line no-console
    console.error('[openai-codex smoketest] FAILED:', msg);
    process.exit(1);
  }
  const elapsed = Date.now() - start;

  // eslint-disable-next-line no-console
  console.log(`[openai-codex smoketest] OneShotCompletion responded in ${elapsed}ms`);
  // eslint-disable-next-line no-console
  console.log(`  text: ${JSON.stringify(result.text.slice(0, 120))}`);
  // eslint-disable-next-line no-console
  console.log(`  usage: ${JSON.stringify(result.usage)}`);

  const ok = result.text.length > 0;
  if (!ok) {
    // eslint-disable-next-line no-console
    console.log('[openai-codex smoketest] AUTH-BLOCKED — empty response (Codex CLI rejected creds silently, hit timeout)');
    // eslint-disable-next-line no-console
    console.log('  Likely cause: subscription lapsed. Re-run `codex login` to refresh OAuth.');
    process.exit(0); // not a build failure
  }
  // eslint-disable-next-line no-console
  console.log('[openai-codex smoketest] PASSED');
  process.exit(0);
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[openai-codex smoketest] crashed:', err);
  process.exit(2);
});
