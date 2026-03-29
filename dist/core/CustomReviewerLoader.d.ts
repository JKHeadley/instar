/**
 * CustomReviewerLoader — Loads custom reviewer specs from disk.
 *
 * Reads `.instar/reviewers/*.json` at server startup and validates each
 * against the expected schema. Invalid files are logged as warnings but
 * do not break loading of valid specs.
 *
 * v1: Only LLM-powered reviewers (with `prompt` field) are supported.
 * Specs containing a `script` field are rejected.
 */
export interface CustomReviewerSpec {
    name: string;
    description: string;
    mode: 'block' | 'warn' | 'observe';
    prompt: string;
    contextRequirements: {
        message: boolean;
        toolOutput?: boolean;
        valueDocuments?: boolean;
        channel?: boolean;
        customContext?: string;
    };
    priority?: 'p0' | 'p1' | 'p2';
}
export declare class CustomReviewerLoader {
    private stateDir;
    private reviewersDir;
    constructor(stateDir: string);
    /**
     * Load all valid reviewer specs from the reviewers directory.
     * Invalid files are warned about but do not prevent loading of valid ones.
     */
    loadAll(): CustomReviewerSpec[];
    /**
     * Load a specific reviewer by name.
     * Returns null if not found or invalid.
     */
    load(name: string): CustomReviewerSpec | null;
    /**
     * Validate a parsed JSON object against the CustomReviewerSpec schema.
     * Returns the validated spec or null if invalid.
     */
    private validate;
}
//# sourceMappingURL=CustomReviewerLoader.d.ts.map