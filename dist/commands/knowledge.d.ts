/**
 * `instar knowledge` — Ingest, list, search, and remove knowledge base entries.
 *
 * Commands:
 *   instar knowledge ingest "content" --title "Title"   Ingest content
 *   instar knowledge list [--tag TAG]                   List catalog
 *   instar knowledge search "query"                     Search knowledge
 *   instar knowledge remove SOURCE_ID                   Remove a source
 */
interface KnowledgeOptions {
    dir?: string;
    title?: string;
    url?: string;
    type?: string;
    tags?: string;
    summary?: string;
    tag?: string;
    limit?: number;
}
export declare function knowledgeIngest(content: string, opts: KnowledgeOptions): Promise<void>;
export declare function knowledgeList(opts: KnowledgeOptions): Promise<void>;
export declare function knowledgeSearch(query: string, opts: KnowledgeOptions): Promise<void>;
export declare function knowledgeRemove(sourceId: string, opts: KnowledgeOptions): Promise<void>;
export {};
//# sourceMappingURL=knowledge.d.ts.map