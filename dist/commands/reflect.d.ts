/**
 * `instar reflect job <slug>` — Show execution journal for a job.
 * `instar reflect all` — Show execution journal summary for all jobs.
 * `instar reflect analyze <slug>` — Detect patterns across execution history.
 * `instar reflect analyze --all` — Detect patterns across all jobs.
 * `instar reflect consolidate` — Run full reflection cycle (analyze + propose + learn).
 * `instar reflect run <slug>` — Run LLM-powered per-job reflection.
 *
 * Part of Living Skills (PROP-229). Reads the execution journal and
 * outputs a formatted summary of what happened during recent job runs.
 */
interface ReflectJobOptions {
    dir?: string;
    days?: number;
    limit?: number;
    agent?: string;
}
interface ReflectAllOptions {
    dir?: string;
    days?: number;
    agent?: string;
}
interface AnalyzeOptions {
    dir?: string;
    days?: number;
    agent?: string;
    all?: boolean;
    proposals?: boolean;
    minRuns?: number;
}
interface ConsolidateOptions {
    dir?: string;
    days?: number;
    agent?: string;
    minRuns?: number;
    dryRun?: boolean;
}
export declare function reflectJob(slug: string, opts: ReflectJobOptions): Promise<void>;
export declare function reflectAll(opts: ReflectAllOptions): Promise<void>;
export declare function analyzePatterns(slug: string | undefined, opts: AnalyzeOptions): Promise<void>;
export declare function consolidateReflection(opts: ConsolidateOptions): Promise<void>;
interface ReflectRunOptions {
    dir?: string;
    days?: number;
    agent?: string;
    session?: string;
    model?: string;
    all?: boolean;
}
export declare function runReflection(slug: string | undefined, opts: ReflectRunOptions): Promise<void>;
export {};
//# sourceMappingURL=reflect.d.ts.map