/**
 * Self-Knowledge Tree Types — Shared type definitions for the tree engine.
 *
 * Defines the tree config schema, search results, source types, and cache
 * structures used across all tree modules.
 *
 * Born from: PROP-XXX (Self-Knowledge Tree for Instar Agents)
 */

// ── Tree Config Schema ─────────────────────────────────────────────

export interface SelfKnowledgeTreeConfig {
  version: string;                    // "1.0"
  agentName: string;                  // From AGENT.md
  budget: {
    maxLlmCalls: number;             // Default: 10
    maxSeconds: number;              // Default: 30
    model: 'haiku';                  // Native to Claude Code — no external API keys
  };
  layers: SelfKnowledgeLayer[];
  groundingQuestions: string[];       // Reflective prompts per-search
}

export interface SelfKnowledgeLayer {
  id: string;                         // e.g., "identity", "capabilities"
  name: string;                       // Human-readable
  description: string;
  children: SelfKnowledgeNode[];
}

export interface SelfKnowledgeNode {
  id: string;                         // e.g., "identity.core"
  name: string;
  alwaysInclude: boolean;            // Included regardless of triage
  managed: boolean;                  // true = system-generated, false = agent-evolved
  depth: 'shallow' | 'medium' | 'deep';
  maxTokens: number;                 // Max tokens for this node's content (default: 500)
  sensitivity: 'public' | 'internal'; // "internal" nodes redacted from engagement grounding
  sources: SelfKnowledgeSource[];
  description?: string;
}

export type SelfKnowledgeSource =
  | { type: 'file'; path: string }
  | { type: 'file_section'; path: string; section: string }
  | { type: 'json_file'; path: string; fields: string[] }
  | { type: 'memory_search'; query: string; topK: number }
  | { type: 'knowledge_search'; query: string; topK: number }
  | { type: 'probe'; name: string; args?: Record<string, string> }
  | { type: 'state_file'; key: string }
  | { type: 'decision_journal'; query: string; limit: number };

// ── Search Results ─────────────────────────────────────────────────

export interface SelfKnowledgeResult {
  query: string;
  degraded: boolean;
  fragments: SelfKnowledgeFragment[];
  synthesis: string | null;
  budgetUsed: number;
  elapsedMs: number;
  cacheHitRate: number | null;
  errors: SourceError[];
  triageMethod?: 'llm' | 'rule-based';
  confidence?: number;                     // Max node confidence (0.0-1.0)
}

export interface SelfKnowledgeFragment {
  layerId: string;
  nodeId: string;
  relevance: number;
  content: string;
  cached: boolean;
  sensitivity: 'public' | 'internal';
}

export interface SourceError {
  nodeId: string;
  sourceType: string;
  error: string;
  elapsedMs: number;
}

export interface SearchOptions {
  layerFilter?: string[];
  maxBudget?: number;
  outputFormat?: 'narrative' | 'json';
  publicOnly?: boolean;
}

export interface SearchPlan {
  query: string;
  triageMode: 'llm' | 'rule-based';
  layerScores: Record<string, number>;
  nodesToSearch: string[];
  nodesToSkip: string[];
  estimatedLlmCalls: number;
}

// ── Grounding ──────────────────────────────────────────────────────

export interface GroundingResult {
  topic: string;
  platform?: string;
  fragments: SelfKnowledgeFragment[];
  synthesis: string | null;
  degraded: boolean;
  elapsedMs: number;
  cached: boolean;
}

// ── Probe Registry ─────────────────────────────────────────────────

export type ProbeFn = (args: Record<string, string>) => Promise<ProbeResult>;

export interface ProbeResult {
  content: string;
  truncated: boolean;
  elapsedMs: number;
}

export interface ProbeRegistration {
  name: string;
  fn: ProbeFn;
  timeoutMs: number;
  maxOutputChars: number;
  description?: string;
}

// ── Cache ──────────────────────────────────────────────────────────

export type CacheTier = 'identity' | 'capabilities' | 'state' | 'experience' | 'evolution' | 'synthesis';

export interface CacheEntry<T> {
  value: T;
  createdAt: number;
  tier: CacheTier;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  hitRate: number | null;
}

export const CACHE_TTL_MS: Record<CacheTier, number> = {
  identity: 4 * 60 * 60 * 1000,     // 4 hours
  capabilities: 60 * 60 * 1000,     // 1 hour
  state: 5 * 60 * 1000,             // 5 minutes
  experience: 30 * 60 * 1000,       // 30 minutes
  evolution: 60 * 60 * 1000,        // 1 hour
  synthesis: 10 * 60 * 1000,        // 10 minutes
};

// ── Triage ─────────────────────────────────────────────────────────

export interface TriageResult {
  scores: Record<string, number>;          // Layer-level scores (Stage 1)
  nodeScores?: Record<string, number>;     // Node-level scores (Stage 2)
  mode: 'llm' | 'rule-based';
  elapsedMs: number;
}

// ── Observability ──────────────────────────────────────────────────

export interface TreeTraceEntry {
  timestamp: string;
  query: string;
  triageMode: 'llm' | 'rule-based';
  triageScores: Record<string, number>;
  nodesSearched: string[];
  nodesSkipped: string[];
  cacheHits: string[];
  cacheMisses: string[];
  errors: SourceError[];
  budgetUsed: number;
  budgetLimit: number;
  elapsedMs: number;
  synthesisTokens: number;
  degraded: boolean;
}

// ── Validation ─────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  warnings: ValidationWarning[];
  errors: ValidationError[];
  coverageScore: number;
}

export interface ValidationWarning {
  nodeId: string;
  type: 'missing_source' | 'empty_source' | 'stale_source' | 'orphan_node' | 'missing_coverage';
  message: string;
}

export interface ValidationError {
  nodeId: string;
  type: 'invalid_schema' | 'invalid_source' | 'unregistered_probe';
  message: string;
}

// ── Layer-to-Tier mapping ──────────────────────────────────────────

export function layerToTier(layerId: string): CacheTier {
  switch (layerId) {
    case 'identity': return 'identity';
    case 'capabilities': return 'capabilities';
    case 'state': return 'state';
    case 'experience': return 'experience';
    case 'evolution': return 'evolution';
    default: return 'experience'; // safe default
  }
}
