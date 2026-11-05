/**
 * SessionActivitySentinel — pending retry queue durability + idempotency.
 *
 * Field finding (2026-10-26, echo): a retried digest that finally succeeded
 * was removed from the pending queue but never written to durable storage,
 * so the memory was silently lost. The same queue also held hundreds of
 * duplicate entries, many for stretches that already had a stored digest,
 * so every scan re-spent LLM tokens on finished work.
 *
 * These tests pin the contract:
 *   - a successful retry persists its digest BEFORE the queue entry is removed
 *   - a pending entry for a stretch that already has a digest is dropped
 *     without an LLM call
 *   - duplicate pending entries for the same stretch cost one LLM call and
 *     produce one digest
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Session, IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import { SessionActivitySentinel } from '../../src/monitoring/SessionActivitySentinel.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ─── Helpers ────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: 'test-session',
    status: 'running',
    tmuxSession: 'test-tmux-session',
    startedAt: '2026-02-27T10:00:00Z',
    jobSlug: 'test-job',
    prompt: 'Do some work',
    ...overrides,
  };
}

const DIGEST_RESPONSE = JSON.stringify({
  summary: 'Recovered after the provider came back.',
  actions: ['recovered'],
  learnings: ['retries must persist'],
  significance: 5,
  themes: ['recovery'],
});

/**
 * Provider that fails every call while `failing` is true, then answers with a
 * valid digest JSON. Records every prompt it is asked to evaluate.
 */
function createSwitchableProvider(): IntelligenceProvider & {
  failing: boolean;
  calls: Array<{ prompt: string; options?: IntelligenceOptions }>;
} {
  const provider = {
    failing: true,
    calls: [] as Array<{ prompt: string; options?: IntelligenceOptions }>,
    evaluate: async (prompt: string, options?: IntelligenceOptions) => {
      provider.calls.push({ prompt, options });
      if (provider.failing) throw new Error('LLM API unavailable');
      return DIGEST_RESPONSE;
    },
  };
  return provider;
}

// Session output must be > 500 chars to pass ActivityPartitioner minimum threshold
const LONG_SESSION_OUTPUT = [
  '$ npm test',
  'Running test suite with 15 test files...',
  '',
  'PASS tests/unit/auth.test.ts (12 tests)',
  '  ✓ validates JWT tokens correctly',
  '  ✓ rejects expired tokens',
  '  ✓ handles missing authorization header',
  '  ✓ refreshes token when close to expiry',
  '',
  'PASS tests/unit/db.test.ts (8 tests)',
  '  ✓ connects to database successfully',
  '  ✓ handles connection timeouts',
  '  ✓ retries on transient failures',
  '',
  'PASS tests/unit/api.test.ts (15 tests)',
  '  ✓ GET /api/users returns user list',
  '  ✓ POST /api/users creates new user',
  '  ✓ PUT /api/users/:id updates user',
  '  ✓ DELETE /api/users/:id removes user',
  '',
  'Test Suites: 3 passed, 3 total',
  'Tests:       35 passed, 35 total',
  'Time:        2.847s',
  '',
  '$ git add -A',
  '$ git commit -m "feat: add auth module with comprehensive tests"',
  '[main abc1234] feat: add auth module with comprehensive tests',
  ' 5 files changed, 342 insertions(+), 12 deletions(-)',
  '',
  '$ npm run build',
  'Compiling TypeScript...',
  'Compiled 42 files in 3.2 seconds.',
  'Build complete. No errors found.',
].join('\n');

/**
 * A pending entry in the shape the queue held before this fix: only the raw
 * digest prompt, no structured stretch metadata. The prompt header is the
 * only place the stretch identity lives.
 */
function legacyPendingPrompt(session: Session, startedAt: string, endedAt: string): string {
  return [
    "You are analyzing a chunk of an AI agent's work session to create a concise activity digest.",
    '',
    `Session: ${session.name}`,
    `Job: ${session.jobSlug}`,
    `Activity period: ${startedAt} to ${endedAt}`,
    'Boundary signal: task_complete',
    '',
    '=== SESSION OUTPUT (agent actions) ===',
    LONG_SESSION_OUTPUT,
    '',
    'Respond in this EXACT JSON format (no other text):',
    '{ "summary": "..." }',
  ].join('\n');
}

function writeLegacyPending(stateDir: string, sessionId: string, content: string): string {
  const dir = path.join(stateDir, 'episodes', 'pending', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      sessionId,
      content,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      retryCount: 0,
    }, null, 2),
  );
  return id;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('SessionActivitySentinel pending retry queue', () => {
  let dir: string;
  let stateDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-retry-test-'));
    stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/session-activity-sentinel-retry-queue.test.ts',
    });
  });

  it('persists the digest when a retried pending item succeeds', async () => {
    const session = makeSession();
    const provider = createSwitchableProvider();

    const sentinel = new SessionActivitySentinel({
      stateDir,
      intelligence: provider,
      // The retry pass runs inside scan(); keep the live-session pass empty so
      // the only LLM traffic in the second scan is the retry itself.
      getActiveSessions: () => [],
      captureSessionOutput: () => LONG_SESSION_OUTPUT,
    });
    const memory = sentinel.getEpisodicMemory();

    // 1. Initial digest fails → stretch lands in the pending queue.
    const firstPass = await sentinel.digestActivity(session);
    expect(firstPass).toHaveLength(0);
    const queued = memory.getPending(session.id);
    expect(queued.length).toBeGreaterThanOrEqual(1);
    expect(memory.getSessionActivities(session.id)).toHaveLength(0);

    // 2. Provider recovers; the next scan retries the queue.
    provider.failing = false;
    const callsBeforeRetry = provider.calls.length;
    await sentinel.scan();
    expect(provider.calls.length).toBeGreaterThan(callsBeforeRetry);

    // 3. The successful retry must leave a durable digest behind, not just
    //    an empty queue.
    const stored = memory.getSessionActivities(session.id);
    expect(stored.length).toBe(queued.length);
    expect(stored[0].summary).toBe('Recovered after the provider came back.');
    expect(stored[0].sessionId).toBe(session.id);
    expect(memory.getPending(session.id)).toHaveLength(0);
  });

  it('drops a pending entry whose stretch already has a stored digest without calling the LLM', async () => {
    const session = makeSession();
    const provider = createSwitchableProvider();
    provider.failing = false;

    const sentinel = new SessionActivitySentinel({
      stateDir,
      intelligence: provider,
      getActiveSessions: () => [],
      captureSessionOutput: () => LONG_SESSION_OUTPUT,
    });
    const memory = sentinel.getEpisodicMemory();

    const startedAt = '2026-02-27T10:00:00.000Z';
    const endedAt = '2026-02-27T10:30:00.000Z';
    memory.saveDigest({
      sessionId: session.id,
      sessionName: session.name,
      startedAt,
      endedAt,
      summary: 'Already digested.',
      actions: [],
      entities: [],
      learnings: [],
      significance: 4,
      themes: [],
      boundarySignal: 'task_complete',
    });

    writeLegacyPending(stateDir, session.id, legacyPendingPrompt(session, startedAt, endedAt));
    expect(memory.getPending(session.id)).toHaveLength(1);

    await sentinel.scan();

    expect(provider.calls).toHaveLength(0);
    expect(memory.getPending(session.id)).toHaveLength(0);
    expect(memory.getSessionActivities(session.id)).toHaveLength(1);
  });

  it('collapses duplicate pending entries for one stretch into a single retry and digest', async () => {
    const session = makeSession();
    const provider = createSwitchableProvider();
    provider.failing = false;

    const sentinel = new SessionActivitySentinel({
      stateDir,
      intelligence: provider,
      getActiveSessions: () => [],
      captureSessionOutput: () => LONG_SESSION_OUTPUT,
    });
    const memory = sentinel.getEpisodicMemory();

    const startedAt = '2026-02-27T11:00:00.000Z';
    const endedAt = '2026-02-27T11:45:00.000Z';
    const prompt = legacyPendingPrompt(session, startedAt, endedAt);
    writeLegacyPending(stateDir, session.id, prompt);
    writeLegacyPending(stateDir, session.id, prompt);
    writeLegacyPending(stateDir, session.id, prompt);
    expect(memory.getPending(session.id)).toHaveLength(3);

    await sentinel.scan();

    expect(provider.calls).toHaveLength(1);
    const stored = memory.getSessionActivities(session.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].startedAt).toBe(startedAt);
    expect(stored[0].endedAt).toBe(endedAt);
    expect(memory.getPending(session.id)).toHaveLength(0);
  });

  it('does not enqueue a second pending entry for a stretch that is already queued', async () => {
    const session = makeSession();
    const provider = createSwitchableProvider();

    const sentinel = new SessionActivitySentinel({
      stateDir,
      intelligence: provider,
      getActiveSessions: () => [session],
      captureSessionOutput: () => LONG_SESSION_OUTPUT,
    });
    const memory = sentinel.getEpisodicMemory();

    // Two failing passes from the same last-digested marker, as happens when
    // a scan whose digests all failed never advances sentinel state: the
    // partitioner emits the identical stretch again.
    const lastDigestedAt = '2026-02-27T09:30:00.000Z';
    await sentinel.digestActivity(session, lastDigestedAt);
    const afterFirst = memory.getPending(session.id).length;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    await sentinel.digestActivity(session, lastDigestedAt);
    expect(memory.getPending(session.id)).toHaveLength(afterFirst);
  });
});
