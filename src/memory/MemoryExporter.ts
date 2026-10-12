/**
 * MemoryExporter — Generates MEMORY.md from SemanticMemory entities.
 *
 * Phase 6 of the memory architecture (PROP-memory-architecture.md).
 * The inverse of MemoryMigrator: reads the knowledge graph and renders
 * a well-structured markdown file suitable for session injection.
 *
 * After Phase 6, MEMORY.md transitions from "source of truth" to
 * "generated snapshot" — a human-readable export of what the agent knows,
 * regenerated periodically from the canonical SemanticMemory store.
 *
 * Design decisions:
 *   - Groups entities by domain first, then by type within each domain
 *   - Filters by minimum confidence (stale entities excluded)
 *   - Sorts by confidence descending within each group
 *   - Includes metadata footer (generation timestamp, entity count, coverage)
 *   - Backward compatible: generated MEMORY.md has the same structure agents expect
 *   - Entities without a domain go under "General Knowledge"
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SemanticMemory } from './SemanticMemory.js';
import type { MemoryEntity, EntityType } from '../core/types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface MemoryExporterConfig {
  /** SemanticMemory instance to read from */
  semanticMemory: SemanticMemory;
  /** Minimum confidence to include in export (default: 0.2) */
  minConfidence?: number;
  /** Maximum entities to include (default: 200) */
  maxEntities?: number;
  /** Maximum words to spend on retained entity content (default: 5000) */
  wordBudget?: number;
  /** Agent name for the header (default: 'Agent') */
  agentName?: string;
  /** Whether to include metadata footer (default: true) */
  includeFooter?: boolean;
}

export interface ExportResult {
  /** The generated markdown content */
  markdown: string;
  /** Number of entities included */
  entityCount: number;
  /** Number of entities excluded (below confidence threshold) */
  excludedCount: number;
  /** Number of otherwise eligible entities excluded by maxEntities */
  excludedByCap: number;
  /** Number of otherwise eligible entities excluded by wordBudget */
  excludedByBudget: number;
  /** Share of otherwise eligible entities excluded by selection caps */
  excludedShare: number;
  /** Configured word budget for retained entity content */
  wordBudget: number;
  /** Retained entity words spent by the selector, excluding section chrome */
  selectedEntityWords: number;
  /** Actual rendered markdown word count */
  actualWords: number;
  /** Words over budget in the rendered markdown, including headings/footer */
  wordsOverBudget: number;
  /** Average rendered words per included entity */
  wordsPerIncludedEntity: number;
  /** Number of domain groups */
  domainCount: number;
  /** Estimated tokens in the output */
  estimatedTokens: number;
}

export interface WriteResult extends ExportResult {
  /** Path the file was written to */
  filePath: string;
  /** File size in bytes */
  fileSizeBytes: number;
}

// ─── Constants ─────────────────────────────────────────────────

/** Human-readable labels for entity types */
const TYPE_LABELS: Record<EntityType, string> = {
  fact: 'Facts',
  person: 'People',
  project: 'Projects',
  tool: 'Tools',
  pattern: 'Patterns',
  decision: 'Decisions',
  lesson: 'Lessons',
};

/** Display order for entity types within a domain section */
const TYPE_ORDER: EntityType[] = [
  'project', 'person', 'tool', 'fact', 'pattern', 'decision', 'lesson',
];

/** Human-readable labels for domains */
const DOMAIN_LABELS: Record<string, string> = {
  infrastructure: 'Infrastructure',
  development: 'Development',
  relationships: 'Relationships',
  business: 'Business',
  frontend: 'Frontend',
  backend: 'Backend',
  security: 'Security',
  communication: 'Communication',
};

/** Display order for domains */
const DOMAIN_ORDER = [
  'infrastructure', 'development', 'backend', 'frontend',
  'security', 'business', 'relationships', 'communication',
];

// ─── Implementation ─────────────────────────────────────────────

export class MemoryExporter {
  private readonly memory: SemanticMemory;
  private readonly minConfidence: number;
  private readonly maxEntities: number;
  private readonly wordBudget: number;
  private readonly agentName: string;
  private readonly includeFooter: boolean;

  constructor(config: MemoryExporterConfig) {
    this.memory = config.semanticMemory;
    this.minConfidence = config.minConfidence ?? 0.2;
    this.maxEntities = config.maxEntities ?? 200;
    this.wordBudget = config.wordBudget ?? 5000;
    this.agentName = config.agentName ?? 'Agent';
    this.includeFooter = config.includeFooter ?? true;
  }

  /**
   * Generate MEMORY.md content from SemanticMemory.
   * Returns the markdown string and metadata about what was included.
   */
  generate(): ExportResult {
    const allData = this.memory.export();

    // Filter by confidence and expiry
    const now = Date.now();
    const eligible = allData.entities.filter(e => {
      if (e.confidence < this.minConfidence) return false;
      if (e.expiresAt && new Date(e.expiresAt).getTime() < now) return false;
      return true;
    });

    // Sort by confidence descending, then by lastVerified descending
    eligible.sort((a, b) => {
      const confDiff = b.confidence - a.confidence;
      if (Math.abs(confDiff) > 0.01) return confDiff;
      return new Date(b.lastVerified).getTime() - new Date(a.lastVerified).getTime();
    });

    const selection = this.selectWithinBudgets(eligible);
    const included = selection.included;
    const excludedCount = allData.entities.length - included.length;

    // Group by domain, then by type within each domain
    const grouped = this.groupEntities(included);

    // Render to markdown
    const markdown = this.renderMarkdown(grouped, selection);

    const actualWords = this.countWords(markdown);
    const estimatedTokens = Math.ceil(markdown.length / 4);
    const wordsPerIncludedEntity = included.length === 0
      ? 0
      : Math.round((selection.includedEntityWords / included.length) * 10) / 10;
    const excludedBySelection = selection.excludedByCap + selection.excludedByBudget;
    const excludedShare = eligible.length === 0
      ? 0
      : Math.round((excludedBySelection / eligible.length) * 1000) / 1000;

    return {
      markdown,
      entityCount: included.length,
      excludedCount,
      excludedByCap: selection.excludedByCap,
      excludedByBudget: selection.excludedByBudget,
      excludedShare,
      wordBudget: this.wordBudget,
      selectedEntityWords: selection.includedEntityWords,
      actualWords,
      wordsOverBudget: Math.max(0, actualWords - this.wordBudget),
      wordsPerIncludedEntity,
      domainCount: Object.keys(grouped).length,
      estimatedTokens,
    };
  }

  /**
   * Generate and write MEMORY.md to a file path.
   */
  write(filePath: string): WriteResult {
    const result = this.generate();

    // Guard: never overwrite an existing file with empty export.
    // If SemanticMemory has 0 entities (e.g. never populated, migration incomplete),
    // writing would destroy manually-curated MEMORY.md content.
    if (result.entityCount === 0 && fs.existsSync(filePath)) {
      const fileSizeBytes = fs.statSync(filePath).size;
      return { ...result, filePath, fileSizeBytes };
    }

    // Ensure parent directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, result.markdown, 'utf-8');

    const fileSizeBytes = fs.statSync(filePath).size;

    return {
      ...result,
      filePath,
      fileSizeBytes,
    };
  }

  // ─── Private ────────────────────────────────────────────────────

  /**
   * Group entities by domain, then by type within each domain.
   * Returns a map: domain -> type -> entities[]
   */
  private groupEntities(
    entities: MemoryEntity[],
  ): Record<string, Record<string, MemoryEntity[]>> {
    const grouped: Record<string, Record<string, MemoryEntity[]>> = {};

    for (const entity of entities) {
      const domain = entity.domain ?? '_general';
      if (!grouped[domain]) grouped[domain] = {};
      if (!grouped[domain][entity.type]) grouped[domain][entity.type] = [];
      grouped[domain][entity.type].push(entity);
    }

    return grouped;
  }

  /**
   * Render grouped entities to markdown.
   */
  private renderMarkdown(
    grouped: Record<string, Record<string, MemoryEntity[]>>,
    selection?: SelectionMetrics,
  ): string {
    const lines: string[] = [];

    // Header
    lines.push(`# ${this.agentName} Memory`);
    lines.push('');

    // Sort domains: known domains in order, then unknown, then _general last
    const domains = Object.keys(grouped).sort((a, b) => {
      if (a === '_general') return 1;
      if (b === '_general') return -1;
      const aIdx = DOMAIN_ORDER.indexOf(a);
      const bIdx = DOMAIN_ORDER.indexOf(b);
      if (aIdx === -1 && bIdx === -1) return a.localeCompare(b);
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });

    for (const domain of domains) {
      const types = grouped[domain];
      const domainLabel = domain === '_general'
        ? 'General Knowledge'
        : DOMAIN_LABELS[domain] ?? this.capitalize(domain);

      lines.push(`## ${domainLabel}`);
      lines.push('');

      // Sort types within domain
      const typeKeys = Object.keys(types).sort((a, b) => {
        const aIdx = TYPE_ORDER.indexOf(a as EntityType);
        const bIdx = TYPE_ORDER.indexOf(b as EntityType);
        if (aIdx === -1 && bIdx === -1) return a.localeCompare(b);
        if (aIdx === -1) return 1;
        if (bIdx === -1) return -1;
        return aIdx - bIdx;
      });

      for (const type of typeKeys) {
        const entities = types[type];
        if (entities.length === 0) continue;

        // Only show type subheading if there are multiple types in this domain
        if (typeKeys.length > 1) {
          const typeLabel = TYPE_LABELS[type as EntityType] ?? this.capitalize(type);
          lines.push(`### ${typeLabel}`);
          lines.push('');
        }

        for (const entity of entities) {
          lines.push(this.renderEntity(entity, typeKeys.length > 1));
        }
      }
    }

    // Footer
    if (this.includeFooter) {
      lines.push('---');
      lines.push('');
      const totalEntities = Object.values(grouped)
        .flatMap(d => Object.values(d))
        .reduce((sum, arr) => sum + arr.length, 0);
      lines.push(`*Auto-generated from SemanticMemory (${totalEntities} entities across ${domains.length} domains). Last generated: ${new Date().toISOString()}*`);
      if (selection) {
        const excludedBySelection = selection.excludedByCap + selection.excludedByBudget;
        const excludedSharePct = selection.eligibleCount === 0
          ? '0.0'
          : ((excludedBySelection / selection.eligibleCount) * 100).toFixed(1);
        lines.push(`*Selection health: ${selection.includedEntityWords}/${this.wordBudget} entity words, ${excludedSharePct}% excluded by caps (${selection.excludedByCap} count, ${selection.excludedByBudget} budget).*`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private selectWithinBudgets(eligible: MemoryEntity[]): SelectionMetrics {
    const included: MemoryEntity[] = [];
    let includedEntityWords = 0;
    let excludedByCap = 0;
    let excludedByBudget = 0;

    for (const entity of eligible) {
      if (included.length >= this.maxEntities) {
        excludedByCap++;
        continue;
      }

      const entityWords = this.countWords(this.renderEntity(entity, false));
      if (includedEntityWords + entityWords > this.wordBudget) {
        excludedByBudget++;
        continue;
      }

      included.push(entity);
      includedEntityWords += entityWords;
    }

    return {
      included,
      eligibleCount: eligible.length,
      includedEntityWords,
      excludedByCap,
      excludedByBudget,
    };
  }

  /**
   * Render a single entity to markdown.
   */
  private renderEntity(entity: MemoryEntity, hasTypeHeader: boolean): string {
    const lines: string[] = [];

    // Use H4 if under a type subheading, H3 if not
    const headingLevel = hasTypeHeader ? '####' : '###';
    lines.push(`${headingLevel} ${entity.name}`);

    // Content — use as-is (it's already markdown from MemoryMigrator or direct entry)
    if (entity.content) {
      lines.push(entity.content);
    }

    // Tags inline if present
    if (entity.tags.length > 0) {
      lines.push(`*Tags: ${entity.tags.join(', ')}*`);
    }

    lines.push('');
    return lines.join('\n');
  }

  private capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  private countWords(s: string): number {
    const trimmed = s.trim();
    return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
  }
}

interface SelectionMetrics {
  included: MemoryEntity[];
  eligibleCount: number;
  includedEntityWords: number;
  excludedByCap: number;
  excludedByBudget: number;
}
