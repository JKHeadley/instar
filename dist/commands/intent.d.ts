/**
 * `instar intent reflect` — Review recent decisions against stated intent.
 * `instar intent validate` — Validate agent intent against org constraints.
 * `instar intent drift` — Detect intent drift from decision journal trends.
 *
 * Reads the decision journal and AGENT.md Intent section, then outputs
 * a human-readable summary. This is a local command — no Claude session needed.
 */
interface IntentReflectOptions {
    dir?: string;
    days?: number;
    limit?: number;
}
interface IntentValidateOptions {
    dir?: string;
}
/**
 * Extract the ## Intent section from AGENT.md content.
 * Returns the section text, or null if not found.
 */
export declare function extractIntentSection(agentMdContent: string): string | null;
export declare function intentReflect(options: IntentReflectOptions): Promise<void>;
export declare function intentValidate(options: IntentValidateOptions): Promise<void>;
interface IntentDriftOptions {
    dir?: string;
    window?: number;
}
export declare function intentDrift(options: IntentDriftOptions): Promise<void>;
export {};
//# sourceMappingURL=intent.d.ts.map