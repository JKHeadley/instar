/**
 * `instar memory` — Search and manage agent memory index.
 *
 * Commands:
 *   instar memory search "query"   Search memory from CLI
 *   instar memory reindex          Full rebuild of SQLite index
 *   instar memory status           Show index statistics
 */
interface MemoryOptions {
    dir?: string;
    limit?: number;
}
export declare function memorySearch(query: string, opts: MemoryOptions): Promise<void>;
export declare function memoryReindex(opts: MemoryOptions): Promise<void>;
export declare function memoryStatus(opts: MemoryOptions): Promise<void>;
interface ExportOptions extends MemoryOptions {
    output?: string;
    agent?: string;
    minConfidence?: number;
    maxEntities?: number;
}
export declare function memoryExport(opts: ExportOptions): Promise<void>;
export {};
//# sourceMappingURL=memory.d.ts.map