/**
 * CoverageAuditor — Detects gaps between agent capabilities and tree coverage.
 *
 * Compares what the agent CAN do (platforms, memory, jobs, etc.) against
 * what the tree KNOWS about (nodes with valid sources). Reports missing
 * coverage and content validity.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  SelfKnowledgeTreeConfig,
  TreeTraceEntry,
  ValidationResult,
} from './types.js';

export interface CoverageGap {
  /** What's missing */
  description: string;
  /** Which layer it belongs to */
  layerId: string;
  /** Suggested node ID */
  suggestedNodeId: string;
  /** Severity: how much this gap matters */
  severity: 'low' | 'medium' | 'high';
}

export interface AuditResult {
  /** Overall content coverage score (0-1) */
  coverageScore: number;
  /** Total nodes in tree */
  totalNodes: number;
  /** Nodes with valid, non-empty sources */
  validNodes: number;
  /** Detected gaps */
  gaps: CoverageGap[];
  /** Validation result from tree */
  validation: ValidationResult;
}

export interface HealthSummary {
  totalNodes: number;
  coverageScore: number;
  cacheHitRate: number | null;
  avgLatencyMs: number | null;
  errorRate: number | null;
  searchCount: number;
  degradedSearches: number;
}

export class CoverageAuditor {
  constructor(
    private projectDir: string,
    private stateDir: string,
  ) {}

  /**
   * Run a full coverage audit.
   */
  audit(
    config: SelfKnowledgeTreeConfig,
    validation: ValidationResult,
    detectedPlatforms: string[] = [],
  ): AuditResult {
    const gaps: CoverageGap[] = [];

    // Detect platform coverage gaps
    const existingNodeIds = new Set<string>();
    for (const layer of config.layers) {
      for (const node of layer.children) {
        existingNodeIds.add(node.id);
      }
    }

    for (const platform of detectedPlatforms) {
      const stateNodeId = `state.${platform.toLowerCase()}`;
      if (!existingNodeIds.has(stateNodeId)) {
        gaps.push({
          description: `Agent has ${platform} binding but no ${stateNodeId} node`,
          layerId: 'state',
          suggestedNodeId: stateNodeId,
          severity: 'medium',
        });
      }
    }

    // Detect missing layers
    const expectedLayers = ['identity', 'experience', 'capabilities', 'state', 'evolution'];
    for (const expected of expectedLayers) {
      if (!config.layers.some(l => l.id === expected)) {
        gaps.push({
          description: `Missing expected layer: ${expected}`,
          layerId: expected,
          suggestedNodeId: `${expected}.core`,
          severity: 'high',
        });
      }
    }

    return {
      coverageScore: validation.coverageScore,
      totalNodes: this.countNodes(config),
      validNodes: Math.round(validation.coverageScore * this.countNodes(config)),
      gaps,
      validation,
    };
  }

  /**
   * Detect platforms from agent config files.
   */
  detectPlatforms(): string[] {
    const platforms: string[] = [];

    // Check instar config
    const configPath = path.join(this.stateDir, 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (Array.isArray(config.messaging)) {
          for (const m of config.messaging) {
            if (m.enabled !== false && m.type) {
              platforms.push(m.type);
            }
          }
        }
        if (Array.isArray(config.platforms)) {
          for (const p of config.platforms) {
            const name = typeof p === 'string' ? p : p.type || p.name;
            if (name && !platforms.includes(name)) {
              platforms.push(name);
            }
          }
        }
      } catch { /* skip */ }
    }

    return platforms;
  }

  /**
   * Build health summary from trace logs.
   */
  healthSummary(): HealthSummary {
    const tracePath = path.join(this.stateDir, 'logs', 'tree-trace.jsonl');
    const defaultSummary: HealthSummary = {
      totalNodes: 0,
      coverageScore: 0,
      cacheHitRate: null,
      avgLatencyMs: null,
      errorRate: null,
      searchCount: 0,
      degradedSearches: 0,
    };

    if (!fs.existsSync(tracePath)) return defaultSummary;

    try {
      const lines = fs.readFileSync(tracePath, 'utf-8').trim().split('\n');
      if (lines.length === 0 || (lines.length === 1 && !lines[0])) return defaultSummary;

      const entries: TreeTraceEntry[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch { /* skip corrupt lines */ }
      }

      if (entries.length === 0) return defaultSummary;

      let totalLatency = 0;
      let totalCacheHits = 0;
      let totalCacheMisses = 0;
      let totalErrors = 0;
      let degradedCount = 0;

      for (const entry of entries) {
        totalLatency += entry.elapsedMs || 0;
        totalCacheHits += entry.cacheHits?.length ?? 0;
        totalCacheMisses += entry.cacheMisses?.length ?? 0;
        totalErrors += entry.errors?.length ?? 0;
        if (entry.degraded) degradedCount++;
      }

      const totalCacheOps = totalCacheHits + totalCacheMisses;

      return {
        totalNodes: 0, // Caller fills this from config
        coverageScore: 0, // Caller fills this from validation
        cacheHitRate: totalCacheOps > 0 ? totalCacheHits / totalCacheOps : null,
        avgLatencyMs: totalLatency / entries.length,
        errorRate: totalErrors / entries.length,
        searchCount: entries.length,
        degradedSearches: degradedCount,
      };
    } catch {
      return defaultSummary;
    }
  }

  private countNodes(config: SelfKnowledgeTreeConfig): number {
    return config.layers.reduce((sum, l) => sum + l.children.length, 0);
  }
}
