/**
 * OpenClawSkillManifest — Generates the OpenClaw skill manifest for publishing
 * Threadline as an OpenClaw skill on ClawHub.
 *
 * Part of Threadline Protocol Phase 6D. The manifest describes the skill's
 * actions, providers, evaluators, and configuration in the format expected
 * by OpenClaw's skill registry.
 */
export interface SkillManifest {
    name: string;
    description: string;
    version: string;
    author: string;
    license: string;
    actions: Array<{
        name: string;
        description: string;
        examples: Array<Array<{
            user: string;
            content: {
                text: string;
            };
        }>>;
    }>;
    providers: Array<{
        name: string;
        description: string;
    }>;
    evaluators: Array<{
        name: string;
        description: string;
    }>;
    configuration: Record<string, {
        type: string;
        description: string;
        required: boolean;
        default?: string;
    }>;
}
/**
 * Generate the OpenClaw skill manifest for the Threadline skill.
 *
 * @param version - Manifest version. Defaults to 0.1.0.
 * @returns The complete skill manifest ready for publishing to ClawHub.
 */
export declare function generateSkillManifest(version?: string): SkillManifest;
//# sourceMappingURL=OpenClawSkillManifest.d.ts.map