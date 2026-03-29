/**
 * MemoryMigrator — Ingests knowledge from legacy memory systems into SemanticMemory.
 *
 * Phase 2 of the memory architecture (PROP-memory-architecture.md).
 * Transforms flat files (MEMORY.md, JSON, JSONL) into typed entities
 * with relationships and confidence scores.
 *
 * Supported sources:
 *   - MEMORY.md → fact/pattern entities (confidence 0.7)
 *   - RelationshipManager JSON → person entities + edges
 *   - CanonicalState quick-facts → fact entities (confidence 0.95)
 *   - CanonicalState anti-patterns → lesson entities
 *   - CanonicalState projects → project entities
 *   - DecisionJournal JSONL → decision entities
 *
 * Key design decisions:
 *   - Idempotent: uses sourceKey-based dedup to skip already-migrated items
 *   - Incremental: can be run repeatedly as sources grow
 *   - No mocking in tests: real filesystem, real SQLite
 */
import type { SemanticMemory } from './SemanticMemory.js';
export interface MigrationSource {
    source: string;
    entitiesCreated: number;
    entitiesSkipped: number;
    edgesCreated: number;
    errors: string[];
    durationMs: number;
}
export interface MigrationReport extends MigrationSource {
}
export interface FullMigrationReport {
    sources: MigrationSource[];
    totalEntitiesCreated: number;
    totalEdgesCreated: number;
    totalErrors: number;
    durationMs: number;
}
export interface MemoryMigratorConfig {
    stateDir: string;
    semanticMemory: SemanticMemory;
}
export declare class MemoryMigrator {
    private stateDir;
    private memory;
    constructor(config: MemoryMigratorConfig);
    /**
     * Parse a MEMORY.md file into SemanticMemory entities.
     * Each H2/H3 section becomes a separate entity.
     * Sections about patterns → 'pattern' type; others → 'fact' type.
     */
    migrateMemoryMd(filePath: string): Promise<MigrationReport>;
    /**
     * Migrate RelationshipManager JSON files into person entities.
     * Each .json file in {stateDir}/relationships/ becomes a person entity.
     */
    migrateRelationships(): Promise<MigrationReport>;
    /**
     * Migrate CanonicalState files (quick-facts, anti-patterns, projects)
     * into SemanticMemory entities.
     */
    migrateCanonicalState(): Promise<MigrationReport>;
    private migrateQuickFacts;
    private migrateAntiPatterns;
    private migrateProjects;
    /**
     * Migrate DecisionJournal JSONL entries into decision entities.
     */
    migrateDecisionJournal(): Promise<MigrationReport>;
    /**
     * Run all migration sources. Returns aggregate report.
     */
    migrateAll(options: {
        memoryMdPath?: string;
    }): Promise<FullMigrationReport>;
    /**
     * Check if an entity with this source key already exists.
     * Uses direct SQL lookup on the indexed source column.
     */
    private entityExistsForSource;
    /**
     * Parse markdown content into heading + content sections.
     * Extracts H2 and H3 sections (ignoring H1 which is usually the title).
     */
    private parseMarkdownSections;
    /**
     * Infer entity type from section heading and content.
     */
    private inferEntityType;
    /**
     * Extract simple tags from heading and content.
     */
    private extractTags;
    /**
     * Infer a domain from heading and content.
     */
    private inferDomain;
    /**
     * Safely load a JSON file, returning default on error.
     */
    private loadJson;
}
//# sourceMappingURL=MemoryMigrator.d.ts.map