/**
 * Unit tests for the activity-digest → SemanticMemory entity-extraction pipeline.
 *
 * Phase 0d of the topic-intent-layer thread (Telegram 9976). The sentinel
 * was creating digests with `entities: []` because the entity-extraction
 * step was documented as "future." These tests cover the now-implemented
 * extraction, dedup, and edge-resolution paths.
 *
 * Real SemanticMemory + EpisodicMemory; no mocks. Per the verify-against-
 * real-APIs memory, mocked tests on storage layers hide schema drift.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  Session,
  IntelligenceProvider,
  IntelligenceOptions,
} from '../../src/core/types.js';
import { SessionActivitySentinel } from '../../src/monitoring/SessionActivitySentinel.js';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import type { TelegramLogEntry } from '../../src/memory/ActivityPartitioner.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface TestSetup {
  dir: string;
  stateDir: string;
  semanticMemory: SemanticMemory;
  cleanup: () => void;
}

async function createTestSetup(): Promise<TestSetup> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-entity-test-'));
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const sm = new SemanticMemory({ dbPath: path.join(stateDir, 'semantic.db'), stateDir });
  await sm.open();
  return {
    dir,
    stateDir,
    semanticMemory: sm,
    cleanup: () => {
      sm.close();
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/SessionActivitySentinel-entity-extraction.test.ts:cleanup',
      });
    },
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-entity-test',
    name: 'entity-test',
    status: 'running',
    tmuxSession: 'entity-tmux',
    startedAt: '2026-02-27T10:00:00Z',
    jobSlug: undefined,
    prompt: 'Do some work',
    ...overrides,
  };
}

function makeTelegramLog(): TelegramLogEntry[] {
  // 10 entries to clear the minimum-activity threshold the sentinel applies.
  const base = Date.parse('2026-02-27T10:00:00Z');
  const entries: TelegramLogEntry[] = [];
  for (let i = 0; i < 10; i++) {
    entries.push({
      topicId: 1,
      type: 'text',
      from_user: i % 2 === 0 ? 0 : 1,
      text: i === 0
        ? 'Justin asked about Egnyte OAuth strategy for GCI Phase 1.'
        : `Follow-up message ${i}`,
      timestamp: new Date(base + i * 60_000).toISOString(),
    });
  }
  return entries;
}

function makeIntelligence(response: string): IntelligenceProvider {
  return {
    async evaluate(_prompt: string, _options?: IntelligenceOptions) {
      return response;
    },
  };
}

describe('SessionActivitySentinel — activity-digest entity extraction', () => {
  let setup: TestSetup;

  beforeEach(async () => {
    setup = await createTestSetup();
  });
  afterEach(() => setup.cleanup());

  it('buildDigestPrompt asks the LLM for entities in the JSON shape', async () => {
    const sentinel = new SessionActivitySentinel({
      stateDir: setup.stateDir,
      intelligence: makeIntelligence('{}'),
      getActiveSessions: () => [],
      captureSessionOutput: () => 'agent worked on the GCI Phase 1 OAuth design for ten minutes',
      semanticMemory: setup.semanticMemory,
    });
    // Build a prompt via the private builder by digesting a one-unit batch.
    // We just need the prompt string — capture it via a probe intelligence.
    let capturedPrompt = '';
    const probe = new SessionActivitySentinel({
      stateDir: setup.stateDir,
      intelligence: {
        async evaluate(prompt: string) {
          capturedPrompt = prompt;
          return '{"summary":"x","actions":[],"learnings":[],"significance":5,"themes":[],"entities":[]}';
        },
      },
      getActiveSessions: () => [makeSession()],
      captureSessionOutput: () => 'agent worked on the GCI Phase 1 OAuth design for ten minutes',
      getTelegramMessages: () => makeTelegramLog(),
      getTopicForSession: () => 1,
      semanticMemory: setup.semanticMemory,
    });
    await probe.digestActivity(makeSession());
    expect(capturedPrompt).toContain('"entities"');
    expect(capturedPrompt).toContain('fact, person, project, tool, pattern, decision, lesson');
    expect(capturedPrompt).toContain('related_to, built_by, learned_from');
    // Unused stub to satisfy lint about unused `sentinel`.
    void sentinel;
  });

  it('extracts entities and writes them to SemanticMemory with provenance', async () => {
    const llmResponse = JSON.stringify({
      summary: 'Decided to use server-side OAuth for fetchDocument.',
      actions: ['drafted spec', 'wrote backend skeleton'],
      learnings: ['Egnyte rotates refresh tokens — needs durable storage'],
      significance: 7,
      themes: ['oauth', 'gci'],
      entities: [
        {
          type: 'decision',
          name: 'Use Path A service-account OAuth for fetchDocument',
          content: 'Server-side OAuth (service account) for the backend fetch path. Search Action retains per-user OAuth. Rationale: simpler ops, faster pilot.',
          relationships: [
            { to: 'Egnyte refresh-token rotation', relation: 'depends_on' },
          ],
        },
        {
          type: 'fact',
          name: 'Egnyte refresh-token rotation',
          content: 'Egnyte rotates the refresh token on every refresh call. Old token is invalidated. Backend must persist the new token before responding to the original request.',
          relationships: [],
        },
      ],
    });
    const sentinel = new SessionActivitySentinel({
      stateDir: setup.stateDir,
      intelligence: makeIntelligence(llmResponse),
      getActiveSessions: () => [makeSession()],
      captureSessionOutput: () => 'agent worked on the GCI Phase 1 OAuth design for ten minutes',
      getTelegramMessages: () => makeTelegramLog(),
      getTopicForSession: () => 1,
      semanticMemory: setup.semanticMemory,
    });
    const digests = await sentinel.digestActivity(makeSession());
    expect(digests.length).toBeGreaterThan(0);
    const digest = digests[0];
    // Two entities were extracted and materialized — digest holds their IDs.
    expect(digest.entities).toHaveLength(2);

    // Confirm both exist in SemanticMemory with correct provenance.
    const decision = setup.semanticMemory.findByName('Use Path A service-account OAuth for fetchDocument', 'decision');
    expect(decision).not.toBeNull();
    expect(decision!.source).toBe(`session:${makeSession().id}`);
    expect(decision!.sourceSession).toBe(makeSession().id);
    const fact = setup.semanticMemory.findByName('Egnyte refresh-token rotation', 'fact');
    expect(fact).not.toBeNull();
  });

  it('dedups entities across digests via findByName', async () => {
    const llmResponse = JSON.stringify({
      summary: 's', actions: [], learnings: [], significance: 5, themes: [],
      entities: [
        { type: 'person', name: 'Tom Southam', content: 'BD partner introduced GCI. Construction industry connections.', relationships: [] },
      ],
    });
    const sentinel = new SessionActivitySentinel({
      stateDir: setup.stateDir,
      intelligence: makeIntelligence(llmResponse),
      getActiveSessions: () => [makeSession()],
      captureSessionOutput: () => 'agent worked on the GCI Phase 1 OAuth design for ten minutes',
      getTelegramMessages: () => makeTelegramLog(),
      getTopicForSession: () => 1,
      semanticMemory: setup.semanticMemory,
    });
    // First digest creates the entity
    await sentinel.digestActivity(makeSession());
    const tomAfterFirst = setup.semanticMemory.findByName('Tom Southam', 'person');
    expect(tomAfterFirst).not.toBeNull();
    const firstId = tomAfterFirst!.id;

    // Second digest (different activity unit) mentions the same entity —
    // should reuse the existing ID, not create a duplicate.
    await sentinel.digestActivity(makeSession({ id: 'session-entity-test-2' }));
    const tomAfterSecond = setup.semanticMemory.findByName('Tom Southam', 'person');
    expect(tomAfterSecond!.id).toBe(firstId);
  });

  it('resolves intra-batch relationships via name lookup', async () => {
    const llmResponse = JSON.stringify({
      summary: 's', actions: [], learnings: [], significance: 5, themes: [],
      entities: [
        { type: 'project', name: 'GCI Phase 1 build', content: 'fetchDocument backend.', relationships: [
          { to: 'fetchDocument backend', relation: 'part_of' },
        ] },
        { type: 'tool', name: 'fetchDocument backend', content: 'New Vercel serverless backend that fetches Egnyte/ACC files and returns extracted text.', relationships: [] },
      ],
    });
    const sentinel = new SessionActivitySentinel({
      stateDir: setup.stateDir,
      intelligence: makeIntelligence(llmResponse),
      getActiveSessions: () => [makeSession()],
      captureSessionOutput: () => 'agent worked on the GCI Phase 1 OAuth design for ten minutes',
      getTelegramMessages: () => makeTelegramLog(),
      getTopicForSession: () => 1,
      semanticMemory: setup.semanticMemory,
    });
    await sentinel.digestActivity(makeSession());
    // The edge should be resolvable: project → tool via part_of.
    const stats = setup.semanticMemory.stats();
    expect(stats.totalEntities).toBe(2);
    expect(stats.totalEdges).toBeGreaterThanOrEqual(1);
  });

  it('drops malformed entities silently and keeps the rest of the digest', async () => {
    const llmResponse = JSON.stringify({
      summary: 'mixed batch', actions: ['a'], learnings: [], significance: 5, themes: [],
      entities: [
        // valid
        { type: 'lesson', name: 'Always verify migrations on real data', content: 'A migration that passes unit tests can still break in production.', relationships: [] },
        // invalid type
        { type: 'banana', name: 'fruit', content: 'should be dropped', relationships: [] },
        // missing content
        { type: 'fact', name: 'no content', content: '', relationships: [] },
        // valid with a bogus relation
        { type: 'pattern', name: 'observe-act-record', content: 'Loop pattern for autonomous agents.', relationships: [
          { to: 'Always verify migrations on real data', relation: 'time-traveled-with' },
        ] },
      ],
    });
    const sentinel = new SessionActivitySentinel({
      stateDir: setup.stateDir,
      intelligence: makeIntelligence(llmResponse),
      getActiveSessions: () => [makeSession()],
      captureSessionOutput: () => 'agent worked on the GCI Phase 1 OAuth design for ten minutes',
      getTelegramMessages: () => makeTelegramLog(),
      getTopicForSession: () => 1,
      semanticMemory: setup.semanticMemory,
    });
    const digests = await sentinel.digestActivity(makeSession());
    expect(digests.length).toBeGreaterThan(0);
    const d = digests[0];
    // Only the 2 valid entities should have been materialized.
    expect(d.entities).toHaveLength(2);
    // Digest summary is preserved.
    expect(d.summary).toBe('mixed batch');
    // The bogus relation should be filtered out — no edges.
    expect(setup.semanticMemory.stats().totalEdges).toBe(0);
  });

  it('degrades gracefully when SemanticMemory is not wired', async () => {
    const llmResponse = JSON.stringify({
      summary: 'no graph', actions: [], learnings: [], significance: 5, themes: [],
      entities: [
        { type: 'fact', name: 'Test fact', content: 'Should still parse, just not store.', relationships: [] },
      ],
    });
    const sentinel = new SessionActivitySentinel({
      stateDir: setup.stateDir,
      intelligence: makeIntelligence(llmResponse),
      getActiveSessions: () => [makeSession()],
      captureSessionOutput: () => 'agent worked on the GCI Phase 1 OAuth design for ten minutes',
      getTelegramMessages: () => makeTelegramLog(),
      getTopicForSession: () => 1,
      // semanticMemory NOT wired
    });
    const digests = await sentinel.digestActivity(makeSession());
    expect(digests.length).toBeGreaterThan(0);
    // No SemanticMemory, no IDs — digest still persists.
    expect(digests[0].entities).toEqual([]);
    expect(digests[0].summary).toBe('no graph');
  });

  it('handles missing entities key (older LLM responses still work)', async () => {
    const llmResponse = JSON.stringify({
      summary: 'legacy shape', actions: ['x'], learnings: [], significance: 5, themes: [],
      // no entities key
    });
    const sentinel = new SessionActivitySentinel({
      stateDir: setup.stateDir,
      intelligence: makeIntelligence(llmResponse),
      getActiveSessions: () => [makeSession()],
      captureSessionOutput: () => 'agent worked on the GCI Phase 1 OAuth design for ten minutes',
      getTelegramMessages: () => makeTelegramLog(),
      getTopicForSession: () => 1,
      semanticMemory: setup.semanticMemory,
    });
    const digests = await sentinel.digestActivity(makeSession());
    expect(digests.length).toBeGreaterThan(0);
    expect(digests[0].entities).toEqual([]);
    expect(setup.semanticMemory.stats().totalEntities).toBe(0);
  });
});
