/**
 * TreeGenerator — Auto-generates self-knowledge tree from AGENT.md + config.
 *
 * Reads the agent's AGENT.md file and detected capabilities to produce
 * the initial self-knowledge-tree.json. Not a template copy — structural
 * analysis of what the agent actually has.
 *
 * On regeneration, uses managed/unmanaged merge strategy:
 * - managed:true nodes are fully regenerated
 * - managed:false nodes are preserved as-is
 *
 * Born from: PROP-XXX (Self-Knowledge Tree for Instar Agents)
 */
import type { SelfKnowledgeTreeConfig } from './types.js';
interface GeneratorOptions {
    projectDir: string;
    stateDir: string;
    agentName: string;
    platforms?: string[];
    skills?: string[];
    hasMemory?: boolean;
    hasKnowledge?: boolean;
    hasDecisionJournal?: boolean;
    hasJobs?: boolean;
    hasEvolution?: boolean;
    hasAutonomyProfile?: boolean;
}
export declare class TreeGenerator {
    /**
     * Generate a new tree config or merge with existing.
     * If an existing tree has managed:false nodes, they are preserved.
     */
    generate(options: GeneratorOptions): SelfKnowledgeTreeConfig;
    /**
     * Save tree config to state directory.
     * Uses atomic write (temp + rename) for safety.
     */
    save(config: SelfKnowledgeTreeConfig, stateDir: string): void;
    /**
     * Load existing tree config from state directory.
     */
    loadExisting(stateDir: string): SelfKnowledgeTreeConfig | null;
    private readAgentMd;
    private parseAgentMdSections;
    private buildLayers;
    private buildIdentityLayer;
    private buildExperienceLayer;
    private buildCapabilitiesLayer;
    private buildStateLayer;
    private buildEvolutionLayer;
    /**
     * Merge unmanaged (agent-evolved) nodes from existing tree into regenerated layers.
     */
    private mergeUnmanagedNodes;
}
export {};
//# sourceMappingURL=TreeGenerator.d.ts.map