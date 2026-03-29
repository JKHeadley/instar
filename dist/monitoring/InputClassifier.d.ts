/**
 * Input Classifier — Phase 2 of Prompt Gate.
 *
 * Classifies detected prompts as auto-approvable or relay-required.
 * Uses a two-stage approach:
 *   1. Rule-based classification (fast path) for clear-cut cases
 *   2. LLM classification (Haiku-tier) for ambiguous matches
 *
 * Classification decisions are based on:
 *   - Prompt type (permission, question, plan, selection, confirmation)
 *   - File paths (in-project vs outside-project)
 *   - Operation safety (destructive keywords)
 *   - Config-level overrides (per-topic, per-type)
 */
import type { IntelligenceProvider } from '../core/types.js';
import type { DetectedPrompt, PromptType } from './PromptGate.js';
export type ClassificationAction = 'auto-approve' | 'relay' | 'block';
export interface ClassificationResult {
    action: ClassificationAction;
    reason: string;
    confidence: number;
    promptId: string;
    promptType: PromptType;
    llmClassified: boolean;
    classifiedAt: number;
}
export interface InputClassifierConfig {
    /** Project root directory (for in-project path checks) */
    projectDir: string;
    /** Auto-approve sub-config */
    autoApprove: {
        enabled: boolean;
        fileCreation: boolean;
        fileEdits: boolean;
        planApproval: boolean;
    };
    /** Dry-run mode: log but don't auto-approve */
    dryRun: boolean;
    /** IntelligenceProvider for LLM classification (optional) */
    intelligence?: IntelligenceProvider;
}
export declare class InputClassifier {
    private config;
    private normalizedProjectDir;
    constructor(config: InputClassifierConfig);
    /**
     * Classify a detected prompt.
     * Returns the recommended action and reasoning.
     */
    classify(prompt: DetectedPrompt): Promise<ClassificationResult>;
    private classifyByRules;
    private classifyPermission;
    private classifyPlan;
    private classifyConfirmation;
    private classifyWithLLM;
    /**
     * Check if a file path is within the project directory.
     * Resolves relative paths and prevents path traversal.
     */
    isInProjectDir(filePath: string): boolean;
    /**
     * Check if a path matches any blocked patterns.
     */
    isBlockedPath(filePath: string): boolean;
    private isDestructive;
    private result;
}
//# sourceMappingURL=InputClassifier.d.ts.map