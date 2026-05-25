/**
 * Integration — the REAL RateLimitSentinel driven through the REAL recovery
 * factory (buildRateLimitRecoveryDeps), for a NON-topic-bound session.
 *
 * This is the CI-permanent form of the live tmux reproduction. The unit tests
 * cover the factory branching in isolation; this proves the sentinel's actual
 * lifecycle (detect → backoff → resume → verify → recovered) drives those deps
 * and reaches the lifeline for a session with no topic — the exact path that
 * silently no-opped in v1.2.33 and left Justin's dev window stuck on a throttle.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RateLimitSentinel } from '../../src/monitoring/RateLimitSentinel.js';
import { buildRateLimitRecoveryDeps } from '../../src/monitoring/sentinelWiring.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sentinel: RateLimitSentinel | undefined;
let tmp: string | undefined;
afterEach(() => {
  sentinel?.stop();
  sentinel = undefined;
  if (tmp) SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/rate-limit-recovery-sentinel-lifecycle.test.ts' });
  tmp = undefined;
});

function harness(opts: { topic: number | null; lifeline: number | null }) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-recov-'));
  const jsonlRoot = path.join(tmp, 'jsonl');
  fs.mkdirSync(jsonlRoot, { recursive: true });
  const jsonlFile = path.join(jsonlRoot, 'sess.jsonl');
  fs.writeFileSync(jsonlFile, 'x'.repeat(100));

  const notices: Array<{ topicId: number; text: string }> = [];
  const internalNudges: string[] = [];
  const recorded: Array<{ kind: string; detail: string }> = [];

  const deps = buildRateLimitRecoveryDeps({
    isSessionAlive: () => true,
    injectTopicNudge: () => true,
    injectInternalNudge: (_n, text) => { internalNudges.push(text); return true; },
    getTopicForSession: () => opts.topic,
    getLifelineTopicId: () => opts.lifeline,
    deliverNotice: async (topicId, text) => { notices.push({ topicId, text }); return true; },
    recordRecovery: (kind, _n, detail) => { recorded.push({ kind, detail }); },
  });

  sentinel = new RateLimitSentinel(
    { resumeFn: deps.resumeFn, notifyFn: deps.notifyFn, projectDir: tmp, jsonlRoot, getClaudeSessionId: () => 'sess' },
    { enabled: true, backoffScheduleMs: [120], verifyWindowMs: 400 },
  );
  return { jsonlFile, notices, internalNudges, recorded };
}

describe('RateLimitSentinel × recovery factory — non-topic-bound lifecycle', () => {
  it('recovers a non-topic-bound session: internal nudge + lifeline notice + recovered', async () => {
    const h = harness({ topic: null, lifeline: 4242 });

    sentinel!.report('dev-window', 'idle-error');
    // Simulate Claude processing the nudge (jsonl grows) during the verify window.
    setTimeout(() => fs.appendFileSync(h.jsonlFile, 'y'.repeat(500)), 200);
    await delay(900);

    // The notice reached the lifeline (before the fix: nothing).
    expect(h.notices.some((n) => n.topicId === 4242)).toBe(true);
    // The resume nudge went through the internal (non-topic) injection path.
    expect(h.internalNudges.length).toBeGreaterThanOrEqual(1);
    // Everything recorded as reached; nothing unreachable.
    expect(h.recorded.some((r) => r.kind === 'recovery-reached')).toBe(true);
    expect(h.recorded.some((r) => r.kind === 'recovery-unreachable')).toBe(false);
    // Lifecycle completed.
    expect(sentinel!.isRecoveryActive('dev-window')).toBe(false);
  });

  it('no topic AND no lifeline → records recovery-unreachable, never silent', async () => {
    const h = harness({ topic: null, lifeline: null });

    sentinel!.report('orphan', 'idle-error');
    await delay(400);

    expect(h.notices).toHaveLength(0);
    expect(h.recorded.some((r) => r.kind === 'recovery-unreachable')).toBe(true);
  });
});
