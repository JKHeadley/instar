/** Types for scripts/lib/instar-dev-trace.mjs (the one trace-verification implementation). */
export declare const TRACE_PATH_RE: RegExp;
export declare const MIN_ARTIFACT_CHARS: number;
export declare function isTracePath(p: unknown): boolean;
export declare function traceIsComplete(trace: unknown): boolean;
export declare function traceMissingCoverage(trace: unknown, files: readonly string[]): string[];
export declare function artifactSha256(text: string): string;
export declare function secondPassConcurred(trace: unknown): boolean;
export declare function independentReviewProblem(a: {
  trace: unknown;
  flaggedPaths: readonly string[] | null;
  artifactText: string | null;
}): string | null;
export declare function secondPassReviewerNamed(artifactText: string | null | undefined): boolean;
