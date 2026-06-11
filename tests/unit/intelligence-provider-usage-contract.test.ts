// safe-git-allow: test file — direct fs usage is fixture setup only.
/**
 * Provider usage-contract test (token-audit-completeness): which
 * IntelligenceProvider implementations MUST surface per-call usage via
 * onUsage, and which are documented cannot-surface entries. Expectations are
 * derived from FIXTURES per implementation — never from a prose list.
 *
 * Must-surface: claude-code, codex-cli (exec-json mode), pi-cli.
 * Cannot-surface (documented in source, exempt in usageCoverage):
 * gemini-cli, InteractivePoolIntelligenceProvider.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseJsonResult } from '../../src/core/ClaudeCliIntelligenceProvider.js';
import { CodexCliIntelligenceProvider } from '../../src/core/CodexCliIntelligenceProvider.js';
import { PiCliIntelligenceProvider } from '../../src/core/PiCliIntelligenceProvider.js';

let fixtureDir: string;
let prevExecJson: string | undefined;

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-contract-'));
  prevExecJson = process.env.INSTAR_CODEX_EXEC_JSON;
  delete process.env.INSTAR_CODEX_EXEC_JSON;
});

afterEach(() => {
  if (prevExecJson === undefined) delete process.env.INSTAR_CODEX_EXEC_JSON;
  else process.env.INSTAR_CODEX_EXEC_JSON = prevExecJson;
  try {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('must-surface providers', () => {
  it('claude-code: parseJsonResult invokes onUsage with summed input + cache-read subset', () => {
    const stdout = JSON.stringify({
      result: 'the answer',
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 400,
        output_tokens: 30,
      },
    });
    const usages: Array<{ inputTokens: number; outputTokens: number; cachedTokens?: number }> = [];
    const result = parseJsonResult(stdout, (u) => usages.push(u));
    expect(result).toBe('the answer');
    expect(usages).toEqual([{ inputTokens: 550, outputTokens: 30, cachedTokens: 400 }]);
    // Pinned subset invariant: tokensCached ⊆ tokensIn.
    expect(usages[0].cachedTokens!).toBeLessThanOrEqual(usages[0].inputTokens);
  });

  it('codex-cli (exec-json): the provider invokes onUsage from the event stream', async () => {
    const script = path.join(fixtureDir, 'fake-codex.sh');
    fs.writeFileSync(
      script,
      `#!/bin/sh
OUTFILE=""
PREV=""
for a in "$@"; do
  if [ "$PREV" = "--output-last-message" ]; then OUTFILE="$a"; fi
  PREV="$a"
done
cat > /dev/null
echo '{"msg":{"type":"token_count","info":{"total_token_usage":{"input_tokens":90,"cached_input_tokens":30,"output_tokens":9,"total_tokens":99}}}}'
printf 'ok' > "$OUTFILE"
exit 0
`,
      { mode: 0o755 },
    );
    const usages: Array<{ inputTokens: number; outputTokens: number; cachedTokens?: number }> = [];
    const provider = new CodexCliIntelligenceProvider({ codexPath: script });
    await provider.evaluate('p', { onUsage: (u) => usages.push(u) });
    expect(usages).toEqual([{ inputTokens: 90, outputTokens: 9, cachedTokens: 30 }]);
    expect(usages[0].cachedTokens!).toBeLessThanOrEqual(usages[0].inputTokens);
  });

  it('pi-cli: the provider invokes onUsage from the message_end event', async () => {
    const script = path.join(fixtureDir, 'fake-pi.sh');
    fs.writeFileSync(
      script,
      `#!/bin/sh
cat > /dev/null 2>/dev/null || true
echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"pi says hi"}],"usage":{"input":40,"output":4}}}'
exit 0
`,
      { mode: 0o755 },
    );
    const usages: Array<{ inputTokens: number; outputTokens: number }> = [];
    const provider = new PiCliIntelligenceProvider({
      piPath: script,
      model: 'openai/gpt-5.4-mini',
    });
    const result = await provider.evaluate('p', { onUsage: (u) => usages.push(u) });
    expect(result).toBe('pi says hi');
    expect(usages).toEqual([{ inputTokens: 40, outputTokens: 4 }]);
  });
});

describe('cannot-surface providers (documented exemptions)', () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', rel), 'utf-8');

  it('gemini-cli: never invokes onUsage, and the reason is documented in source', () => {
    const src = read('src/core/GeminiCliIntelligenceProvider.ts');
    expect(src).not.toMatch(/options\??\.onUsage\??\.?\(/);
    expect(src).toContain('CANNOT-SURFACE-USAGE');
    expect(src).toContain('no per-call token usage');
  });

  it('interactive pool: never invokes onUsage, and the reason is documented in source', () => {
    const src = read('src/core/InteractivePoolIntelligenceProvider.ts');
    expect(src).not.toMatch(/options\??\.onUsage\??\.?\(\{/);
    expect(src).toMatch(/onUsage is (NEVER invoked|deliberately NOT invoked)/);
  });

  it('the exempt set matches the fixtures: gemini exempt, pi NOT exempt', async () => {
    const { FeatureMetricsLedger } = await import('../../src/monitoring/FeatureMetricsLedger.js');
    const l = new FeatureMetricsLedger({ dbPath: ':memory:' });
    l.record({ feature: 'A', outcome: 'noop', model: 'g', framework: 'gemini-cli' });
    l.record({ feature: 'A', outcome: 'noop', tokensIn: 1, tokensOut: 1, model: 'p', framework: 'pi-cli' });
    const cov = l.summary().totals.usageCoverage;
    expect(cov.find((c) => c.framework === 'gemini-cli')!.exempt).toBe(true);
    expect(cov.find((c) => c.framework === 'pi-cli')!.exempt).toBe(false);
    l.close();
  });
});
