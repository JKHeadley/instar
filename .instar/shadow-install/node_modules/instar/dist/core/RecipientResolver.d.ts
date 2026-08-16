/**
 * RecipientResolver — Resolves recipient context for review decisions.
 *
 * Queries RelationshipManager and AdaptiveTrust for known contacts and agents.
 * Extracts ONLY structured metadata (communicationStyle, significance, themes,
 * trustLevel, formality) — never free-text fields like notes or descriptions.
 *
 * Trust boundary: Fields allowed in reviewer prompts are strictly limited.
 * See RecipientContext for the full allow-list.
 */
export interface RecipientContext {
    recipientType: 'primary-user' | 'secondary-user' | 'agent' | 'external-contact';
    /** Communication style preference (formal, casual, technical) */
    communicationStyle?: string;
    /** Relationship significance (high, medium, low) */
    significance?: string;
    /** Recurring conversation themes */
    themes?: string[];
    /** Trust level for agent recipients */
    trustLevel?: string;
    /** Formality preference */
    formality?: string;
}
export interface RecipientResolverOptions {
    stateDir: string;
    relationships?: {
        getContextForPerson(id: string): string | null;
    } | null;
    adaptiveTrust?: {
        getProfile(): any;
    } | null;
}
export declare class RecipientResolver {
    private options;
    constructor(options: RecipientResolverOptions);
    /**
     * Resolve recipient context for a given recipient.
     *
     * If recipientId is provided and a RelationshipManager is available,
     * queries for structured metadata. Otherwise returns conservative defaults
     * based on recipientType.
     */
    resolve(recipientId?: string, recipientType?: string): RecipientContext;
    /**
     * Parse the XML context string from RelationshipManager.
     * Extracts ONLY structured metadata — never free-text fields.
     */
    private parseRelationshipContext;
    /**
     * Resolve trust level from AdaptiveTrust profile.
     */
    private resolveTrustLevel;
}
//# sourceMappingURL=RecipientResolver.d.ts.map