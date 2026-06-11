// safe-git-allow: test file — direct fs usage is fixture setup only.
/**
 * Drift tripwire + unlabeled backstop emission gating (token-audit-
 * completeness): both DegradationReporter emissions use FIXED feature
 * constants and are gated to ONCE PER PROCESS LIFETIME (P17 — the legacy
 * .report path files an external feedback report per event with no
 * feedback-side cooldown; per-call emission would be fleet-spam).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  CodexCliIntelligenceProvider,
  _resetUsageDriftEmissionForTest,
} from '../../src/core/CodexCliIntelligenceProvider.js';
import {
  CircuitBreakingIntelligenceProvider,
  setFeatureMetricsRecorder,
  _resetUnlabeledEmissionForTest,
} from '../../src/core/CircuitBreakingIntelligenceProvider.js';
import { LlmCircuitBreaker } from '../../src/core/LlmCircuitBreaker.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';

let fixtureDir: string;
let reported: Array<{ feature: string; reason: string }>;
let reportSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-tripwire-'));
  _resetUsageDriftEmissionForTest();
  _resetUnlabeledEmissionForTest();
  reported = [];
  reportSpy = vi
    .spyOn(DegradationReporter.getInstance(), 'report')
    .mockImplementation(((event: { feature: string; reason: string }) => {
      reported.push({ feature: event.feature, reason: event.reason });
    }) as never);
});

afterEach(() => {
  reportSpy.mockRestore();
  setFeatureMetricsRecorder(null);
  try {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** Fake codex that succeeds with NO usage events (the drift condition). */
function writeNoUsageCodex(): string {
  const p = path.join(fixtureDir, 'no-usage-codex.sh');
  fs.writeFileSync(
    p,
    `#!/bin/sh
OUTFILE=""
PREV=""
for a in "$@"; do
  if [ "$PREV" = "--output-last-message" ]; then OUTFILE="$a"; fi
  PREV="$a"
done
cat > /dev/null
echo '{"msg":{"type":"agent_message","message":"no usage events here"}}'
printf 'result' > "$OUTFILE"
exit 0
`,
    { mode: 0o755 },
  );
  return p;
}

async function flushDynamicImports(): Promise<void> {
  // The emitters lazy-import DegradationReporter; give the microtask queue a tick.
  await new Promise((r) => setTimeout(r, 50));
}

describe('codex-usage-parse-drift', () => {
  it('a successful --json call with zero recorded usage emits the drift event with the fixed constant — once per process', async () => {
    const provider = new CodexCliIntelligenceProvider({ codexPath: writeNoUsageCodex() });
    await provider.evaluate('p1');
    await provider.evaluate('p2');
    await flushDynamicImports();
    const drift = reported.filter((r) => r.feature === 'codex-usage-parse-drift');
    expect(drift).toHaveLength(1); // once per process, not per call
    expect(drift[0].reason).toContain('no-events');
  });

  it('a call that records usage emits nothing', async () => {
    const p = path.join(fixtureDir, 'with-usage.sh');
    fs.writeFileSync(
      p,
      `#!/bin/sh
OUTFILE=""
PREV=""
for a in "$@"; do
  if [ "$PREV" = "--output-last-message" ]; then OUTFILE="$a"; fi
  PREV="$a"
done
cat > /dev/null
echo '{"msg":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}}'
printf 'result' > "$OUTFILE"
exit 0
`,
      { mode: 0o755 },
    );
    const provider = new CodexCliIntelligenceProvider({ codexPath: p });
    await provider.evaluate('p');
    await flushDynamicImports();
    expect(reported.filter((r) => r.feature === 'codex-usage-parse-drift')).toEqual([]);
  });
});

describe('unlabeled-llm-call backstop', () => {
  it('recording an unlabeled llm row emits the fixed-constant event once per process — and the message still flows', async () => {
    setFeatureMetricsRecorder({ record: () => {} });
    const inner = { evaluate: async () => 'ok' };
    const provider = new CircuitBreakingIntelligenceProvider(inner, new LlmCircuitBreaker());
    // No attribution → 'unlabeled' bucket → backstop fires (signal-only).
    await expect(provider.evaluate('p1')).resolves.toBe('ok');
    await expect(provider.evaluate('p2')).resolves.toBe('ok');
    await flushDynamicImports();
    const hits = reported.filter((r) => r.feature === 'unlabeled-llm-call');
    expect(hits).toHaveLength(1);
  });

  it('an attributed call does not trip the backstop', async () => {
    setFeatureMetricsRecorder({ record: () => {} });
    const inner = { evaluate: async () => 'ok' };
    const provider = new CircuitBreakingIntelligenceProvider(inner, new LlmCircuitBreaker());
    await provider.evaluate('p', { attribution: { component: 'TaggedThing' } });
    await flushDynamicImports();
    expect(reported.filter((r) => r.feature === 'unlabeled-llm-call')).toEqual([]);
  });
});
