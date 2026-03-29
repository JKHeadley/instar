/**
 * RelationshipManager — Core system for tracking everyone the agent interacts with.
 *
 * Relationships are fundamental, not a plugin. Same tier as identity and memory.
 * Every person the agent interacts with — across any channel/platform — gets a
 * relationship record that grows over time.
 *
 * Architecture:
 * - One JSON file per person in .instar/relationships/
 * - Cross-platform identity resolution via channel index
 * - Auto-enrichment from every interaction
 * - Context injection before any interaction with a known person
 */
import type { RelationshipRecord, RelationshipManagerConfig, InteractionSummary, UserChannel } from './types.js';
export declare class RelationshipManager {
    private relationships;
    /** Maps "channel_type:identifier" -> relationship ID for cross-platform resolution */
    private channelIndex;
    /** Maps normalized name -> set of relationship IDs for fuzzy name resolution */
    private nameIndex;
    private config;
    constructor(config: RelationshipManagerConfig);
    /** Normalize a name for fuzzy matching: lowercase, trim, collapse whitespace, strip leading @ */
    private normalizeName;
    /** Add a record to the name index */
    private indexName;
    /** Remove a record from the name index */
    private unindexName;
    /** Validate a record ID is a valid UUID format to prevent path traversal. */
    private validateId;
    /**
     * Find or create a relationship from an incoming interaction.
     * Resolves cross-platform: if the same person messages from Telegram and email,
     * this returns the same relationship.
     */
    findOrCreate(name: string, channel: UserChannel): RelationshipRecord;
    /**
     * LLM-supervised version of findOrCreate.
     * When an intelligence provider is configured:
     * - Heuristics narrow candidates (channel match, name match)
     * - LLM confirms ambiguous name matches before linking
     * - LLM can detect matches that string heuristics miss
     *
     * Falls back to sync findOrCreate when no provider is available.
     */
    findOrCreateAsync(name: string, channel: UserChannel): Promise<RelationshipRecord>;
    /**
     * LLM-supervised duplicate detection.
     * Runs heuristic findDuplicates() first, then asks the LLM to confirm
     * each candidate group. Returns only LLM-confirmed duplicates.
     *
     * Falls back to heuristic-only when no provider is available.
     */
    findDuplicatesAsync(): Promise<Array<{
        records: RelationshipRecord[];
        reason: string;
        confirmed: boolean;
    }>>;
    /**
     * Ask the LLM whether a new name+channel belongs to one of the candidate records.
     * Returns the matching record, or null if the LLM says it's a new person.
     */
    private askIdentityMatch;
    /**
     * Ask the LLM to confirm whether a group of records are truly duplicates.
     */
    private askDuplicateConfirmation;
    /**
     * Resolve a channel identifier to an existing relationship, or null.
     */
    resolveByChannel(channel: UserChannel): RelationshipRecord | null;
    /**
     * Resolve by name using fuzzy matching. Returns all matches.
     * Handles: case differences, leading @, underscores vs hyphens vs spaces.
     * Port of Portal's _find_existing_person() pattern.
     */
    resolveByName(name: string): RelationshipRecord[];
    /**
     * Get a relationship by ID.
     */
    get(id: string): RelationshipRecord | null;
    /**
     * Get all relationships, optionally sorted by significance or recency.
     */
    getAll(sortBy?: 'significance' | 'recent' | 'name'): RelationshipRecord[];
    /**
     * Detect potential duplicate relationships that could be merged.
     * Port of Portal's find_potential_duplicates() pattern.
     * Returns groups of records that likely represent the same person,
     * with a reason string explaining why they were flagged.
     */
    findDuplicates(): Array<{
        records: RelationshipRecord[];
        reason: string;
    }>;
    /**
     * Record an interaction with a person. Updates recency, count, and interaction log.
     */
    recordInteraction(id: string, interaction: InteractionSummary): void;
    /**
     * Update notes or other metadata for a relationship.
     */
    updateNotes(id: string, notes: string): void;
    /**
     * Update the arc summary for a relationship.
     */
    updateArcSummary(id: string, arcSummary: string): void;
    /**
     * Link a new channel to an existing relationship (cross-platform identity merge).
     */
    linkChannel(id: string, channel: UserChannel): void;
    /**
     * Merge two relationship records (when we discover two channels are the same person).
     */
    mergeRelationships(keepId: string, mergeId: string): void;
    /**
     * Delete a relationship and its disk file.
     */
    delete(id: string): boolean;
    /**
     * Update the category for a relationship.
     */
    updateCategory(id: string, category: string): void;
    /**
     * Add tags to a relationship (deduplicates).
     */
    addTags(id: string, tags: string[]): void;
    /**
     * Remove tags from a relationship.
     */
    removeTags(id: string, tags: string[]): void;
    /**
     * Generate context string for injection into a Claude session before interacting
     * with a known person. This is what makes the agent "know" who it's talking to.
     */
    getContextForPerson(id: string): string | null;
    /**
     * Find relationships that haven't been contacted in a while.
     */
    getStaleRelationships(daysThreshold?: number): RelationshipRecord[];
    private loadAll;
    private save;
    private deleteFile;
    private calculateSignificance;
}
//# sourceMappingURL=RelationshipManager.d.ts.map