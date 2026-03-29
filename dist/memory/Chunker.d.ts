/**
 * Chunker — splits source files into search-friendly chunks.
 *
 * Strategies:
 *   - Markdown: heading-aware, never splits mid-line
 *   - JSON: each top-level key or array element is a chunk
 *   - JSONL: one chunk per line
 *
 * Target ~400 tokens per chunk (~1600 characters),
 * ~80 token overlap (~320 characters).
 */
export interface Chunk {
    /** The chunk text content */
    text: string;
    /** Byte offset in source file */
    offset: number;
    /** Byte length */
    length: number;
    /** Estimated token count */
    tokenCount: number;
}
/**
 * Estimate token count from text (fast ~4 chars/token heuristic).
 */
export declare function estimateTokens(text: string): number;
/**
 * Chunk markdown text with heading-awareness.
 * Headings (## and above) start new chunks. Chunks respect line boundaries.
 */
export declare function chunkMarkdown(text: string, chunkSize?: number, overlap?: number): Chunk[];
/**
 * Chunk JSON text — each top-level array element or object value becomes a chunk.
 */
export declare function chunkJson(text: string): Chunk[];
/**
 * Chunk JSONL text — one chunk per line.
 */
export declare function chunkJsonl(text: string): Chunk[];
//# sourceMappingURL=Chunker.d.ts.map