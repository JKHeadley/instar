/**
 * `instar semantic` — Manage the semantic memory knowledge graph.
 *
 * Commands:
 *   instar semantic search "query"   Search the knowledge graph
 *   instar semantic remember         Add a knowledge entity
 *   instar semantic forget <id>      Remove an entity
 *   instar semantic stats            Show graph statistics
 *   instar semantic export           Export all entities and edges
 *   instar semantic decay            Run confidence decay
 */
interface SemanticOptions {
    dir?: string;
    limit?: number;
}
export declare function semanticSearch(query: string, opts: SemanticOptions & {
    type?: string;
    domain?: string;
    minConfidence?: string;
}): Promise<void>;
export declare function semanticRemember(opts: SemanticOptions & {
    type: string;
    name: string;
    content: string;
    confidence?: string;
    source?: string;
    tags?: string;
    domain?: string;
}): Promise<void>;
export declare function semanticForget(id: string, opts: SemanticOptions): Promise<void>;
export declare function semanticStats(opts: SemanticOptions): Promise<void>;
export declare function semanticExport(opts: SemanticOptions & {
    output?: string;
}): Promise<void>;
export declare function semanticDecay(opts: SemanticOptions): Promise<void>;
export {};
//# sourceMappingURL=semantic.d.ts.map