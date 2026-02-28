/**
 * Unit tests for WorkingMemoryAssembler.
 *
 * Tests the core assembly logic:
 *   - Query term extraction from triggers
 *   - Token-budgeted rendering (full/compact/name-only tiers)
 *   - Graceful degradation when memory systems unavailable
 *   - Source priority and budget allocation
 *   - Episode assembly with theme matching and recency
 *   - Relationship (person entity) filtering
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  WorkingMemoryAssembler,
  type WorkingMemoryConfig,
  type AssemblyTrigger,
  type TokenBudgets,
} from '../../src/memory/WorkingMemoryAssembler.js';
import type { ScoredEntity, MemoryEntity } from '../../src/core/types.js';
import type { ActivityDigest } from '../../src/memory/EpisodicMemory.js';

// ─── Mock Factories ──────────────────────────────────────────────

function createMockEntity(overrides: Partial<ScoredEntity> = {}): ScoredEntity {
  return {
    id: `entity-${Math.random().toString(36).slice(2, 8)}`,
    type: 'fact',
    name: 'Test Entity',
    content: 'This is the content of a test entity with enough detail to be meaningful.',
    confidence: 0.85,
    createdAt: new Date().toISOString(),
    lastVerified: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
    source: 'test',
    score: 0.75,
    ...overrides,
  };
}

function createMockDigest(overrides: Partial<ActivityDigest> = {}): ActivityDigest {
  return {
    id: `digest-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'test-session',
    sessionName: 'test-worker',
    startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
    endedAt: new Date().toISOString(),
    summary: 'Worked on the episodic memory module, running tests and debugging.',
    actions: ['ran tests', 'fixed bug'],
    entities: [],
    learnings: ['Partitioner needs 500+ chars'],
    significance: 6,
    themes: ['testing', 'memory'],
    boundarySignal: 'task_complete',
    ...overrides,
  };
}

function createMockSemanticMemory(entities: ScoredEntity[] = []) {
  return {
    search: vi.fn((_query: string, options?: { types?: string[]; limit?: number }) => {
      if (options?.types?.includes('person')) {
        return entities.filter(e => e.type === 'person');
      }
      return entities.slice(0, options?.limit ?? 20);
    }),
    // Other methods not used by assembler
    recall: vi.fn(),
    remember: vi.fn(),
    explore: vi.fn(),
  } as any;
}

function createMockEpisodicMemory(digests: ActivityDigest[] = []) {
  return {
    getRecentActivity: vi.fn((_hours: number, _limit: number) => digests),
    getByTheme: vi.fn((_theme: string) => {
      return digests.filter(d => d.themes.some(t => t.includes(_theme)));
    }),
    getSessionActivities: vi.fn(() => []),
  } as any;
}

// ─── Tests ──────────────────────────────────────────────────────

describe('WorkingMemoryAssembler', () => {

  // ─── Query Term Extraction ──────────────────────────────────────

  describe('extractQueryTerms', () => {
    it('extracts significant words from prompt', () => {
      const assembler = new WorkingMemoryAssembler({});
      const terms = assembler.extractQueryTerms({
        prompt: 'Fix the deployment pipeline for faster builds',
      });

      expect(terms).toContain('deployment');
      expect(terms).toContain('pipeline');
      expect(terms).toContain('faster');
      expect(terms).toContain('builds');
    });

    it('filters stop words', () => {
      const assembler = new WorkingMemoryAssembler({});
      const terms = assembler.extractQueryTerms({
        prompt: 'Please create the new authentication system',
      });

      // 'please', 'create', 'the' should be filtered
      expect(terms).not.toContain('please');
      expect(terms).not.toContain('create');
      // 'authentication' and 'system' (>3 chars, not stop) should remain
      expect(terms).toContain('authentication');
    });

    it('extracts terms from job slug', () => {
      const assembler = new WorkingMemoryAssembler({});
      const terms = assembler.extractQueryTerms({
        jobSlug: 'memory-architecture-build',
      });

      expect(terms).toContain('memory');
      expect(terms).toContain('architecture');
      expect(terms).toContain('build');
    });

    it('combines prompt and job slug terms', () => {
      const assembler = new WorkingMemoryAssembler({});
      const terms = assembler.extractQueryTerms({
        prompt: 'Run the integration tests',
        jobSlug: 'episodic-testing',
      });

      expect(terms).toContain('integration');
      expect(terms).toContain('tests');
      expect(terms).toContain('episodic');
      expect(terms).toContain('testing');
    });

    it('deduplicates terms', () => {
      const assembler = new WorkingMemoryAssembler({});
      const terms = assembler.extractQueryTerms({
        prompt: 'test the memory test suite',
        jobSlug: 'memory-test',
      });

      const memoryCount = terms.filter(t => t === 'memory').length;
      expect(memoryCount).toBe(1);
    });

    it('returns empty for empty trigger', () => {
      const assembler = new WorkingMemoryAssembler({});
      const terms = assembler.extractQueryTerms({});
      expect(terms).toHaveLength(0);
    });

    it('limits to 8 terms from prompt', () => {
      const assembler = new WorkingMemoryAssembler({});
      const terms = assembler.extractQueryTerms({
        prompt: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima',
      });

      // prompt alone should produce at most 8
      const promptTerms = terms.filter(t => !t.includes('-'));
      expect(promptTerms.length).toBeLessThanOrEqual(8);
    });
  });

  // ─── Graceful Degradation ──────────────────────────────────────

  describe('graceful degradation', () => {
    it('returns empty context when no memory systems provided', () => {
      const assembler = new WorkingMemoryAssembler({});
      const result = assembler.assemble({ prompt: 'Fix the bug' });

      expect(result.context).toBe('');
      expect(result.sources).toHaveLength(0);
      expect(result.estimatedTokens).toBe(0);
    });

    it('works with only semantic memory', () => {
      const entities = [createMockEntity({ name: 'Deployment', content: 'Deployment process docs.' })];
      const assembler = new WorkingMemoryAssembler({
        semanticMemory: createMockSemanticMemory(entities),
      });

      const result = assembler.assemble({ prompt: 'deployment process' });

      expect(result.context).toContain('Deployment');
      expect(result.sources.some(s => s.name === 'knowledge')).toBe(true);
    });

    it('works with only episodic memory', () => {
      const digests = [createMockDigest({ summary: 'Fixed the scheduler bug.' })];
      const assembler = new WorkingMemoryAssembler({
        episodicMemory: createMockEpisodicMemory(digests),
      });

      const result = assembler.assemble({ prompt: 'scheduler debugging' });

      expect(result.context).toContain('Fixed the scheduler bug');
      expect(result.sources.some(s => s.name === 'episodes')).toBe(true);
    });

    it('includes both when both available', () => {
      const entities = [createMockEntity({ name: 'Scheduler', content: 'The job scheduler runs cron tasks.' })];
      const digests = [createMockDigest({ summary: 'Debugged scheduler stall issue.' })];

      const assembler = new WorkingMemoryAssembler({
        semanticMemory: createMockSemanticMemory(entities),
        episodicMemory: createMockEpisodicMemory(digests),
      });

      const result = assembler.assemble({ prompt: 'scheduler tasks' });

      expect(result.sources.some(s => s.name === 'knowledge')).toBe(true);
      expect(result.sources.some(s => s.name === 'episodes')).toBe(true);
    });
  });

  // ─── Token Budgeting ──────────────────────────────────────────

  describe('token budgets', () => {
    it('respects knowledge budget', () => {
      // Create many entities with long content
      const entities = Array.from({ length: 15 }, (_, i) =>
        createMockEntity({
          name: `Entity ${i}`,
          content: `This is a long content block for entity ${i}. `.repeat(20),
          score: 1 - i * 0.05,
        }),
      );

      const assembler = new WorkingMemoryAssembler({
        semanticMemory: createMockSemanticMemory(entities),
        tokenBudgets: { knowledge: 200, episodes: 0, relationships: 0, total: 200 },
      });

      const result = assembler.assemble({ prompt: 'test query' });
      const knowledgeSource = result.sources.find(s => s.name === 'knowledge');

      expect(knowledgeSource).toBeDefined();
      expect(knowledgeSource!.tokens).toBeLessThanOrEqual(200);
      // Should NOT include all 15 entities
      expect(knowledgeSource!.count).toBeLessThan(15);
    });

    it('respects total budget cap', () => {
      const entities = Array.from({ length: 10 }, (_, i) =>
        createMockEntity({
          name: `Entity ${i}`,
          content: `Content for entity ${i}. `.repeat(10),
        }),
      );
      const digests = Array.from({ length: 10 }, (_, i) =>
        createMockDigest({ summary: `Session ${i} did important work. `.repeat(5) }),
      );

      const assembler = new WorkingMemoryAssembler({
        semanticMemory: createMockSemanticMemory(entities),
        episodicMemory: createMockEpisodicMemory(digests),
        tokenBudgets: { knowledge: 500, episodes: 500, relationships: 500, total: 300 },
      });

      const result = assembler.assemble({ prompt: 'broad query' });

      // Total should be within the total cap
      expect(result.estimatedTokens).toBeLessThanOrEqual(350); // Allow slight estimation variance
    });

    it('uses custom budgets when provided', () => {
      const assembler = new WorkingMemoryAssembler({
        tokenBudgets: { knowledge: 1200, episodes: 600, relationships: 400, total: 3000 },
      });

      const budgets = assembler.getBudgets();
      expect(budgets.knowledge).toBe(1200);
      expect(budgets.episodes).toBe(600);
      expect(budgets.relationships).toBe(400);
      expect(budgets.total).toBe(3000);
    });
  });

  // ─── Render Strategy ──────────────────────────────────────────

  describe('render strategy', () => {
    it('renders top 3 entities with full detail', () => {
      const entities = Array.from({ length: 5 }, (_, i) =>
        createMockEntity({
          name: `Entity-${i}`,
          type: 'fact',
          content: `Detailed content for entity ${i}.`,
          confidence: 0.9 - i * 0.1,
          score: 0.9 - i * 0.1,
        }),
      );

      const assembler = new WorkingMemoryAssembler({
        semanticMemory: createMockSemanticMemory(entities),
        tokenBudgets: { knowledge: 2000, episodes: 0, relationships: 0, total: 2000 },
      });

      const result = assembler.assemble({ prompt: 'test entities' });

      // Top 3 should have ### headers (full render)
      const headerMatches = result.context.match(/### Entity-\d/g);
      expect(headerMatches).toBeTruthy();
      expect(headerMatches!.length).toBeGreaterThanOrEqual(3);

      // Should include confidence percentage
      expect(result.context).toContain('Confidence:');
    });

    it('renders entities 4-10 in compact format', () => {
      const entities = Array.from({ length: 8 }, (_, i) =>
        createMockEntity({
          name: `Item-${i}`,
          content: `First sentence for item ${i}. Second sentence with more detail.`,
          score: 0.9 - i * 0.1,
        }),
      );

      const assembler = new WorkingMemoryAssembler({
        semanticMemory: createMockSemanticMemory(entities),
        tokenBudgets: { knowledge: 5000, episodes: 0, relationships: 0, total: 5000 },
      });

      const result = assembler.assemble({ prompt: 'query' });

      // Items 4+ should be bullet points (compact render)
      const bulletLines = result.context.split('\n').filter(l => l.startsWith('- **Item-'));
      expect(bulletLines.length).toBeGreaterThan(0);
    });

    it('renders 11+ entities as name-only list', () => {
      const entities = Array.from({ length: 15 }, (_, i) =>
        createMockEntity({
          name: `Knowledge-${i}`,
          content: `Short.`,
          score: 0.9 - i * 0.01,
        }),
      );

      const assembler = new WorkingMemoryAssembler({
        semanticMemory: createMockSemanticMemory(entities),
        tokenBudgets: { knowledge: 5000, episodes: 0, relationships: 0, total: 5000 },
      });

      const result = assembler.assemble({ prompt: 'broad search' });

      expect(result.context).toContain('Also related:');
    });
  });

  // ─── Episode Assembly ─────────────────────────────────────────

  describe('episode assembly', () => {
    it('includes recent digests ordered by significance', () => {
      const digests = [
        createMockDigest({ sessionName: 'low-sig', significance: 3, summary: 'Minor cleanup.' }),
        createMockDigest({ sessionName: 'high-sig', significance: 9, summary: 'Major deployment.' }),
        createMockDigest({ sessionName: 'mid-sig', significance: 6, summary: 'Regular work.' }),
      ];

      const assembler = new WorkingMemoryAssembler({
        episodicMemory: createMockEpisodicMemory(digests),
      });

      const result = assembler.assemble({ prompt: 'any query' });

      // High significance should appear first
      const highPos = result.context.indexOf('Major deployment');
      const midPos = result.context.indexOf('Regular work');
      const lowPos = result.context.indexOf('Minor cleanup');

      expect(highPos).toBeLessThan(midPos);
      expect(midPos).toBeLessThan(lowPos);
    });

    it('renders top 3 digests with full detail', () => {
      const digests = [
        createMockDigest({
          sessionName: 'worker-A',
          summary: 'Built the memory module.',
          actions: ['wrote tests', 'committed code'],
          learnings: ['FTS5 requires triggers'],
          themes: ['memory', 'testing'],
        }),
      ];

      const assembler = new WorkingMemoryAssembler({
        episodicMemory: createMockEpisodicMemory(digests),
      });

      const result = assembler.assemble({ prompt: 'memory work' });

      expect(result.context).toContain('worker-A');
      expect(result.context).toContain('Built the memory module');
      expect(result.context).toContain('Actions:');
      expect(result.context).toContain('Learnings:');
      expect(result.context).toContain('Themes:');
    });

    it('queries themes when prompt has relevant terms', () => {
      const mockEpMem = createMockEpisodicMemory([]);

      const assembler = new WorkingMemoryAssembler({
        episodicMemory: mockEpMem,
      });

      assembler.assemble({ prompt: 'deployment pipeline optimization' });

      // Should have called getByTheme with relevant terms
      expect(mockEpMem.getByTheme).toHaveBeenCalled();
    });
  });

  // ─── Relationship Assembly ────────────────────────────────────

  describe('relationship assembly', () => {
    it('searches for person entities', () => {
      const entities = [
        createMockEntity({ name: 'Justin', type: 'person', content: 'Project collaborator.' }),
        createMockEntity({ name: 'Deployment', type: 'fact', content: 'Deployment docs.' }),
      ];

      const mockSemMem = createMockSemanticMemory(entities);
      const assembler = new WorkingMemoryAssembler({
        semanticMemory: mockSemMem,
      });

      assembler.assemble({ prompt: 'Justin asked about deployment' });

      // Should have searched with types: ['person']
      expect(mockSemMem.search).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ types: ['person'] }),
      );
    });

    it('includes people section when person entities found', () => {
      const entities = [
        createMockEntity({ name: 'Alice', type: 'person', content: 'DevOps engineer and key collaborator.' }),
      ];

      const assembler = new WorkingMemoryAssembler({
        semanticMemory: createMockSemanticMemory(entities),
      });

      const result = assembler.assemble({ prompt: 'Alice deployment question' });

      expect(result.sources.some(s => s.name === 'relationships')).toBe(true);
      expect(result.context).toContain('Alice');
    });

    it('omits people section when no person entities', () => {
      const entities = [
        createMockEntity({ name: 'Scheduler', type: 'fact', content: 'Job scheduler docs.' }),
      ];

      // Mock that returns empty for person search
      const mockSemMem = {
        search: vi.fn((_query: string, options?: any) => {
          if (options?.types?.includes('person')) return [];
          return entities;
        }),
      } as any;

      const assembler = new WorkingMemoryAssembler({
        semanticMemory: mockSemMem,
      });

      const result = assembler.assemble({ prompt: 'scheduler question' });

      expect(result.sources.some(s => s.name === 'relationships')).toBe(false);
    });
  });

  // ─── Assembly Output Format ───────────────────────────────────

  describe('output format', () => {
    it('includes section headers', () => {
      const entities = [createMockEntity({ name: 'Test' })];
      const digests = [createMockDigest()];

      const assembler = new WorkingMemoryAssembler({
        semanticMemory: createMockSemanticMemory(entities),
        episodicMemory: createMockEpisodicMemory(digests),
      });

      const result = assembler.assemble({ prompt: 'memory architecture deployment' });

      expect(result.context).toContain('## Relevant Knowledge');
      expect(result.context).toContain('## Recent Activity');
    });

    it('includes assembledAt timestamp', () => {
      const assembler = new WorkingMemoryAssembler({});
      const result = assembler.assemble({ prompt: 'test' });

      expect(result.assembledAt).toBeTruthy();
      expect(new Date(result.assembledAt).getTime()).toBeGreaterThan(0);
    });

    it('includes query terms in result', () => {
      const assembler = new WorkingMemoryAssembler({});
      const result = assembler.assemble({
        prompt: 'deployment pipeline',
        jobSlug: 'infra-build',
      });

      expect(result.queryTerms).toContain('deployment');
      expect(result.queryTerms).toContain('pipeline');
      expect(result.queryTerms).toContain('infra');
    });
  });
});
