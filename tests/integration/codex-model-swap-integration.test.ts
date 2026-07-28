// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Integration test for the codex model-swap (directive #4b): the policy
 * composed with the REAL on-disk rate-limit reader (not mocked). Proves the
 * end-to-end path an agent's spawn uses — read the codex rollout, decide the
 * launch model — works against a real rollout fixture on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexLaunchModelWithUsage } from '../../src/providers/adapters/openai-codex/observability/codexModelSwapPolicy.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ON = { enabled: true, fallbackModel: 'gpt-5.3-codex-spark' };

describe('codex model-swap × real rate-limit reader (integration)', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-swap-int-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/integration/codex-model-swap-integration.test.ts:cleanup' });
  });

  function writeRollout(weeklyUsedPercent: number, reached: string | null = null): void {
    const dir = path.join(home, 'sessions', '2026', '05', '30');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'rollout-2026-05-30T12-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'),
      JSON.stringify({
        timestamp: '2026-05-30T19:22:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            limit_id: 'codex',
            primary: { used_percent: 10, window_minutes: 300, resets_at: 1780171524 },
            secondary: { used_percent: weeklyUsedPercent, window_minutes: 10080, resets_at: 1780174809 },
            plan_type: 'plus',
            rate_limit_reached_type: reached,
          },
        },
      }) + '\n',
    );
  }

  it('swaps to the fallback when the real rollout shows an exhausted weekly window', async () => {
    writeRollout(93); // 7% weekly remaining
    const d = await resolveCodexLaunchModelWithUsage({
      framework: 'codex-cli',
      requestedModel: 'gpt-5.5',
      config: ON,
      codexHome: home,
    });
    expect(d.swapped).toBe(true);
    expect(d.model).toBe('gpt-5.3-codex-spark');
  });

  it('keeps the requested model when the real rollout shows a healthy window', async () => {
    writeRollout(40); // 60% weekly remaining
    const d = await resolveCodexLaunchModelWithUsage({
      framework: 'codex-cli',
      requestedModel: 'gpt-5.5',
      config: ON,
      codexHome: home,
    });
    expect(d.swapped).toBe(false);
    expect(d.model).toBe('gpt-5.5');
  });

  it('keeps the requested model when there is no codex data on disk', async () => {
    const d = await resolveCodexLaunchModelWithUsage({
      framework: 'codex-cli',
      requestedModel: 'gpt-5.5',
      config: ON,
      codexHome: home,
    });
    expect(d.swapped).toBe(false);
    expect(d.model).toBe('gpt-5.5');
  });
});
