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
import fs from 'node:fs';
import path from 'node:path';
const TREE_FILENAME = 'self-knowledge-tree.json';
export class TreeGenerator {
    /**
     * Generate a new tree config or merge with existing.
     * If an existing tree has managed:false nodes, they are preserved.
     */
    generate(options) {
        const existing = this.loadExisting(options.stateDir);
        const agentMdContent = this.readAgentMd(options.projectDir);
        const agentMdSections = this.parseAgentMdSections(agentMdContent);
        const layers = this.buildLayers(options, agentMdSections);
        // Merge: preserve managed:false nodes from existing tree
        if (existing) {
            this.mergeUnmanagedNodes(layers, existing.layers);
        }
        return {
            version: '1.0',
            agentName: options.agentName,
            budget: {
                maxLlmCalls: 10,
                maxSeconds: 30,
                model: 'haiku',
            },
            layers,
            groundingQuestions: [
                'What is most relevant about who I am for this context?',
                'What have I learned that applies here?',
                'What is my current state that matters?',
            ],
        };
    }
    /**
     * Save tree config to state directory.
     * Uses atomic write (temp + rename) for safety.
     */
    save(config, stateDir) {
        const filePath = path.join(stateDir, TREE_FILENAME);
        const tempPath = filePath + '.tmp';
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(tempPath, JSON.stringify(config, null, 2));
        fs.renameSync(tempPath, filePath);
    }
    /**
     * Load existing tree config from state directory.
     */
    loadExisting(stateDir) {
        const filePath = path.join(stateDir, TREE_FILENAME);
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(content);
        }
        catch {
            return null;
        }
    }
    readAgentMd(projectDir) {
        const agentMdPath = path.join(projectDir, 'AGENT.md');
        try {
            return fs.readFileSync(agentMdPath, 'utf-8');
        }
        catch {
            return '';
        }
    }
    parseAgentMdSections(content) {
        const sections = new Map();
        const headings = content.match(/^#{1,3}\s+.+$/gm) ?? [];
        const lower = content.toLowerCase();
        // Check for common sections
        const sectionNames = [
            'values', 'voice', 'personality', 'identity', 'purpose',
            'capabilities', 'tools', 'platforms', 'skills',
            'relationships', 'people', 'connections',
            'goals', 'growth', 'evolution', 'trajectory',
            'lessons', 'learnings', 'experience',
        ];
        for (const name of sectionNames) {
            sections.set(name, headings.some(h => h.toLowerCase().includes(name)) || lower.includes(name));
        }
        return sections;
    }
    buildLayers(options, sections) {
        const layers = [];
        // 1. Identity layer
        layers.push(this.buildIdentityLayer(options, sections));
        // 2. Experience layer
        layers.push(this.buildExperienceLayer(options, sections));
        // 3. Capabilities layer
        layers.push(this.buildCapabilitiesLayer(options));
        // 4. State layer
        layers.push(this.buildStateLayer(options));
        // 5. Evolution layer
        layers.push(this.buildEvolutionLayer(options, sections));
        return layers;
    }
    buildIdentityLayer(options, sections) {
        const children = [
            {
                id: 'identity.core',
                name: 'Core Identity',
                alwaysInclude: true,
                managed: true,
                depth: 'shallow',
                maxTokens: 500,
                sensitivity: 'public',
                sources: [{ type: 'file', path: 'AGENT.md' }],
                description: 'Agent name, purpose, and core identity',
            },
        ];
        if (sections.get('values')) {
            children.push({
                id: 'identity.values',
                name: 'Values & Principles',
                alwaysInclude: true,
                managed: true,
                depth: 'shallow',
                maxTokens: 400,
                sensitivity: 'public',
                sources: [{ type: 'file_section', path: 'AGENT.md', section: 'Values' }],
                description: 'Core values and operating principles',
            });
        }
        // Soul.md — self-authored identity (Being layer)
        if (sections.get('soul') || fs.existsSync(path.join(options.stateDir, 'soul.md'))) {
            children.push({
                id: 'identity.soul',
                name: 'Soul — Self-Authored Identity',
                alwaysInclude: false,
                managed: true,
                depth: 'medium',
                maxTokens: 800,
                sensitivity: 'internal',
                sources: [{ type: 'file', path: 'soul.md' }],
                description: 'Self-authored values, convictions, growth edges, and open questions. The agent\'s reflective identity.',
            });
        }
        if (sections.get('voice') || sections.get('personality')) {
            children.push({
                id: 'identity.voice',
                name: 'Voice & Personality',
                alwaysInclude: false,
                managed: true,
                depth: 'medium',
                maxTokens: 400,
                sensitivity: 'public',
                sources: [
                    { type: 'file_section', path: 'AGENT.md', section: 'Voice' },
                    ...(options.hasMemory
                        ? [{ type: 'memory_search', query: 'voice personality style communication', topK: 3 }]
                        : []),
                ],
                description: 'Communication style and personality traits',
            });
        }
        if (sections.get('relationships') || sections.get('people')) {
            children.push({
                id: 'identity.relationships',
                name: 'Relationships',
                alwaysInclude: false,
                managed: true,
                depth: 'medium',
                maxTokens: 500,
                sensitivity: 'internal',
                sources: [
                    { type: 'state_file', key: 'relationships' },
                ],
                description: 'Known people and relationship context',
            });
        }
        return {
            id: 'identity',
            name: 'Identity',
            description: 'Who the agent is, values, voice, relationships',
            children,
        };
    }
    buildExperienceLayer(options, sections) {
        const children = [];
        if (options.hasMemory) {
            children.push({
                id: 'experience.lessons',
                name: 'Lessons Learned',
                alwaysInclude: false,
                managed: true,
                depth: 'deep',
                maxTokens: 600,
                sensitivity: 'internal',
                sources: [
                    { type: 'memory_search', query: 'lesson learned realization insight', topK: 5 },
                ],
                description: 'Key learnings and realizations from experience',
            });
        }
        if (options.hasDecisionJournal) {
            children.push({
                id: 'experience.decisions',
                name: 'Decision Patterns',
                alwaysInclude: false,
                managed: true,
                depth: 'medium',
                maxTokens: 500,
                sensitivity: 'internal',
                sources: [
                    { type: 'decision_journal', query: 'decision pattern', limit: 10 },
                ],
                description: 'Patterns from past dispatch and decision-making',
            });
        }
        if (options.hasKnowledge) {
            children.push({
                id: 'experience.knowledge',
                name: 'Knowledge Base',
                alwaysInclude: false,
                managed: true,
                depth: 'deep',
                maxTokens: 500,
                sensitivity: 'public',
                sources: [
                    { type: 'knowledge_search', query: '{query}', topK: 5 },
                ],
                description: 'Ingested external knowledge and research',
            });
        }
        children.push({
            id: 'experience.sessions',
            name: 'Recent Sessions',
            alwaysInclude: false,
            managed: true,
            depth: 'medium',
            maxTokens: 400,
            sensitivity: 'internal',
            sources: [
                { type: 'state_file', key: 'session-history' },
            ],
            description: 'Recent session context and work history',
        });
        return {
            id: 'experience',
            name: 'Experience',
            description: 'What the agent has learned, knowledge, decisions',
            children,
        };
    }
    buildCapabilitiesLayer(options) {
        const children = [
            {
                id: 'capabilities.platforms',
                name: 'Platform Bindings',
                alwaysInclude: true,
                managed: true,
                depth: 'shallow',
                maxTokens: 300,
                sensitivity: 'public',
                sources: [
                    { type: 'json_file', path: '.instar/config.json', fields: ['platforms', 'bindings'] },
                ],
                description: 'Connected platforms and communication channels',
            },
        ];
        if (options.skills && options.skills.length > 0) {
            children.push({
                id: 'capabilities.skills',
                name: 'Registered Skills',
                alwaysInclude: false,
                managed: true,
                depth: 'shallow',
                maxTokens: 400,
                sensitivity: 'public',
                sources: [
                    { type: 'state_file', key: 'dispatches' },
                ],
                description: 'Available skills and dispatch capabilities',
            });
        }
        children.push({
            id: 'capabilities.tools',
            name: 'Available Tools',
            alwaysInclude: false,
            managed: true,
            depth: 'shallow',
            maxTokens: 300,
            sensitivity: 'public',
            sources: [
                { type: 'file_section', path: 'AGENT.md', section: 'Tools' },
            ],
            description: 'MCP servers, CLI tools, and external integrations',
        });
        children.push({
            id: 'capabilities.secrets',
            name: 'Secret Drop',
            alwaysInclude: false,
            managed: true,
            depth: 'medium',
            maxTokens: 500,
            sensitivity: 'public',
            sources: [
                { type: 'memory_search', query: 'secret drop password credential token', topK: 3 },
            ],
            description: 'Secure secret collection — generate one-time, time-limited URLs for users to submit passwords, API keys, or tokens without exposing them in chat. Use POST /secrets/request to create a link, then share the tunnelUrl with the user. Never ask users to paste secrets in Telegram or chat.',
        });
        // Discovery framework — feature surfacing guidance
        children.push({
            id: 'capabilities.discovery',
            name: 'Feature Discovery',
            alwaysInclude: false,
            managed: true,
            depth: 'medium',
            maxTokens: 600,
            sensitivity: 'public',
            sources: [
                { type: 'probe', name: 'feature-discovery' },
            ],
            description: 'Opt-in feature discovery framework — what features exist, their discovery state, surfacing rules, and behavioral contract. Query when the user asks about capabilities or when contextually relevant features should be surfaced.',
        });
        if (options.hasDecisionJournal) {
            children.push({
                id: 'capabilities.edges',
                name: 'Known Limitations',
                alwaysInclude: false,
                managed: true,
                depth: 'medium',
                maxTokens: 400,
                sensitivity: 'internal',
                sources: [
                    { type: 'decision_journal', query: 'limitation edge constraint failure', limit: 5 },
                ],
                description: 'Known limitations and capability edges from experience',
            });
        }
        return {
            id: 'capabilities',
            name: 'Capabilities',
            description: 'What the agent can do, tools, platforms, limits',
            children,
        };
    }
    buildStateLayer(options) {
        const children = [];
        if (options.hasJobs) {
            children.push({
                id: 'state.active_jobs',
                name: 'Active Jobs',
                alwaysInclude: true,
                managed: true,
                depth: 'shallow',
                maxTokens: 300,
                sensitivity: 'internal',
                sources: [
                    { type: 'probe', name: 'active-jobs' },
                ],
                description: 'Currently running and scheduled jobs',
            });
        }
        children.push({
            id: 'state.session',
            name: 'Current Session',
            alwaysInclude: false,
            managed: true,
            depth: 'shallow',
            maxTokens: 300,
            sensitivity: 'internal',
            sources: [
                { type: 'probe', name: 'session-context' },
            ],
            description: 'Current session metadata and context',
        });
        children.push({
            id: 'state.health',
            name: 'System Health',
            alwaysInclude: false,
            managed: true,
            depth: 'shallow',
            maxTokens: 200,
            sensitivity: 'internal',
            sources: [
                { type: 'probe', name: 'server-health' },
            ],
            description: 'Server health, process state, resource usage',
        });
        // Add platform-specific state nodes
        for (const platform of options.platforms ?? []) {
            children.push({
                id: `state.${platform.toLowerCase()}`,
                name: `${platform} State`,
                alwaysInclude: false,
                managed: true,
                depth: 'shallow',
                maxTokens: 200,
                sensitivity: 'internal',
                sources: [
                    { type: 'probe', name: 'platform-activity', args: { platform } },
                ],
                description: `Recent activity and state for ${platform}`,
            });
        }
        return {
            id: 'state',
            name: 'State',
            description: 'Current operational state, running jobs, health',
            children,
        };
    }
    buildEvolutionLayer(options, sections) {
        const children = [];
        if (options.hasMemory || sections.get('goals') || sections.get('growth')) {
            children.push({
                id: 'evolution.growth_edges',
                name: 'Growth Edges',
                alwaysInclude: false,
                managed: true,
                depth: 'medium',
                maxTokens: 500,
                sensitivity: 'public',
                sources: [
                    ...(options.hasMemory
                        ? [{ type: 'memory_search', query: 'growth improvement goal aspiration', topK: 5 }]
                        : []),
                    ...(sections.get('goals')
                        ? [{ type: 'file_section', path: 'AGENT.md', section: 'Goals' }]
                        : []),
                ],
                description: 'Current growth edges and improvement areas',
            });
        }
        if (options.hasDecisionJournal) {
            children.push({
                id: 'evolution.dispatch_patterns',
                name: 'Dispatch Patterns',
                alwaysInclude: false,
                managed: true,
                depth: 'shallow',
                maxTokens: 300,
                sensitivity: 'internal',
                sources: [
                    { type: 'probe', name: 'dispatch-trends' },
                ],
                description: 'Trending dispatch patterns and acceptance rates',
            });
        }
        if (options.hasAutonomyProfile) {
            children.push({
                id: 'evolution.autonomy',
                name: 'Autonomy Level',
                alwaysInclude: false,
                managed: true,
                depth: 'shallow',
                maxTokens: 200,
                sensitivity: 'public',
                sources: [
                    { type: 'probe', name: 'autonomy-level' },
                ],
                description: 'Current autonomy level and trajectory',
            });
        }
        children.push({
            id: 'evolution.pending',
            name: 'Pending Work',
            alwaysInclude: false,
            managed: true,
            depth: 'shallow',
            maxTokens: 300,
            sensitivity: 'internal',
            sources: [
                { type: 'state_file', key: 'pending-dispatches' },
            ],
            description: 'Queued actions and pending dispatches',
        });
        return {
            id: 'evolution',
            name: 'Evolution',
            description: 'Growth trajectory, improvement patterns, goals',
            children,
        };
    }
    /**
     * Merge unmanaged (agent-evolved) nodes from existing tree into regenerated layers.
     */
    mergeUnmanagedNodes(newLayers, existingLayers) {
        for (const existingLayer of existingLayers) {
            const newLayer = newLayers.find(l => l.id === existingLayer.id);
            if (!newLayer) {
                // Entire custom layer — preserve it
                const preservedLayer = {
                    ...existingLayer,
                    children: existingLayer.children.filter(n => !n.managed),
                };
                if (preservedLayer.children.length > 0) {
                    newLayers.push(preservedLayer);
                }
                continue;
            }
            // Preserve unmanaged nodes within existing layer
            for (const existingNode of existingLayer.children) {
                if (!existingNode.managed) {
                    // Check for conflict: same ID in new layer
                    const conflict = newLayer.children.findIndex(n => n.id === existingNode.id);
                    if (conflict >= 0) {
                        // Unmanaged wins — replace the managed node
                        newLayer.children[conflict] = existingNode;
                    }
                    else {
                        newLayer.children.push(existingNode);
                    }
                }
            }
        }
    }
}
//# sourceMappingURL=TreeGenerator.js.map