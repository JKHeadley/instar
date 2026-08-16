/**
 * CapabilityMapper — Fractal self-knowledge for Instar agents.
 *
 * Discovers, classifies, and organizes all agent capabilities into a
 * hierarchical map with provenance tracking and drift detection.
 *
 * Levels:
 *   0: One-liner summary ("52 capabilities across 10 domains")
 *   1: Domain table (counts by provenance)
 *   2: Per-domain capability lists
 *   3: Deep detail per capability (endpoints, files, config refs)
 *
 * Provenance is determined exclusively via INSTAR_BUILTIN_MANIFEST lookup.
 * SKILL.md metadata.author is informational only — never used for classification.
 */
import type { LLMSanitizer } from '../security/LLMSanitizer.js';
export type CapabilityType = 'integration' | 'skill' | 'job' | 'hook' | 'script' | 'api' | 'subsystem' | 'storage' | 'middleware';
export type CapabilityStatus = 'active' | 'configured' | 'available' | 'disabled' | 'broken';
export type Provenance = 'instar' | 'agent' | 'user' | 'inherited' | 'unknown';
export interface Capability {
    id: string;
    name: string;
    domain: string;
    status: CapabilityStatus;
    provenance: Provenance;
    since: string;
    description: string;
    type: CapabilityType;
    contentHash?: string;
    endpoints?: string[];
    files?: string[];
    configRef?: string;
    relatedContext?: string;
    evolutionProposal?: string;
    dependencies?: string[];
    usage?: string;
    aliases?: string[];
}
export interface CapabilityDomain {
    id: string;
    name: string;
    description: string;
    capabilities: Capability[];
    featureCount: number;
}
export interface CapabilityMap {
    agent: string;
    version: string;
    generatedAt: string;
    summary: {
        totalCapabilities: number;
        domains: number;
        instarProvided: number;
        agentEvolved: number;
        userConfigured: number;
        unmapped: number;
    };
    domains: CapabilityDomain[];
    _links: {
        self: string;
        compact: string;
        drift: string;
        refresh: string;
        domains: Record<string, string>;
    };
    freshness: {
        ageSeconds: number;
        isRefreshing: boolean;
        lastRefresh: string;
    };
}
export interface ManifestEntry {
    provenance: Provenance;
    firstSeen: string;
    lastVerified: string;
    contentHash?: string;
    evolutionProposal?: string;
    classificationReason?: string;
    notes?: string;
}
export interface CapabilityManifest {
    schemaVersion: number;
    version: string;
    generatedAt: string;
    entries: Record<string, ManifestEntry>;
    _hmac?: string;
}
export interface DriftReport {
    generatedAt: string;
    previousScan: string;
    added: Capability[];
    removed: Array<{
        id: string;
        name: string;
        domain: string;
    }>;
    changed: Array<{
        id: string;
        field: string;
        previous: unknown;
        current: unknown;
    }>;
    unmapped: string[];
    scanErrors: Array<{
        source: string;
        error: string;
        impact: string;
    }>;
}
export interface BuiltinManifestEntry {
    id: string;
    type: string;
    domain: string;
    sourcePath: string;
    installedPath?: string;
    contentHash: string;
    since: string;
}
export interface CapabilityMapperConfig {
    projectDir: string;
    stateDir: string;
    projectName: string;
    version: string;
    port: number;
    /** Optional LLM sanitizer for untrusted text */
    sanitizer?: LLMSanitizer;
}
export declare class CapabilityMapper {
    private config;
    private builtinManifest;
    private integrity;
    private isRefreshing;
    private lastMap;
    private lastRefreshTime;
    constructor(config: CapabilityMapperConfig);
    /**
     * Perform a full scan and return the capability map.
     * Persists the manifest with HMAC signing.
     */
    refresh(): Promise<CapabilityMap>;
    /**
     * Get the last generated map, or refresh if none exists.
     */
    getMap(): Promise<CapabilityMap>;
    /**
     * Detect drift between current state and last persisted manifest.
     */
    detectDrift(): Promise<DriftReport>;
    /**
     * Render the capability map as markdown.
     */
    renderMarkdown(map: CapabilityMap, level?: 0 | 1 | 2 | 3): string;
    /**
     * Get current refresh state.
     */
    getFreshness(): {
        ageSeconds: number;
        isRefreshing: boolean;
        lastRefresh: string;
    };
    private scan;
    private scanSkills;
    private scanScripts;
    private scanHooks;
    private scanJobs;
    private scanSubsystems;
    private scanContextSegments;
    /**
     * Classify provenance for all capabilities using INSTAR_BUILTIN_MANIFEST.
     * This is the sole source of truth for provenance.
     */
    private classify;
    private buildTree;
    private buildMap;
    private renderCompactMarkdown;
    private renderDomainMarkdown;
    private renderFullMarkdown;
    private get manifestPath();
    private persistManifest;
    private loadPersistedManifest;
    private loadBuiltinManifest;
    private loadEvolutionProposals;
    private hashContent;
    private parseYamlFrontmatter;
    private extractScriptDescription;
    /**
     * Infer a domain for capabilities not in the builtin manifest.
     * Uses simple heuristics based on name/type patterns.
     */
    private inferDomain;
}
//# sourceMappingURL=CapabilityMapper.d.ts.map