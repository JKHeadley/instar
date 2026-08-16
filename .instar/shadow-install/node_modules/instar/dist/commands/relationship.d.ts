/**
 * `instar relationship list|import|export` — Manage relationship records.
 *
 * PROP-166: Unified Identity Bridge — Portal People-Registry + Instar RelationshipManager
 */
export declare function listRelationships(options: {
    sort?: string;
}): Promise<void>;
export declare function importRelationships(options: {
    file: string;
    dryRun?: boolean;
}): Promise<void>;
export declare function exportRelationships(options: {
    file?: string;
    minSignificance?: string;
}): Promise<void>;
//# sourceMappingURL=relationship.d.ts.map