/**
 * Scope Coherence Tracker
 *
 * Tracks implementation depth and determines when agents need to
 * zoom out and check the big picture. Born from Dawn's 232nd Lesson:
 * "Implementation depth narrows scope."
 *
 * The pattern: When agents are deep in code (Edit/Write/Bash), their
 * perception narrows to what's in front of them. They stop seeing
 * the system the code lives in. A spec exists — but is never read.
 *
 * This tracker counts implementation-focused tool calls and decrements
 * when scope-checking actions occur (reading specs, docs, proposals).
 * When depth exceeds a threshold, it signals that a checkpoint should fire.
 */
// ── Constants ────────────────────────────────────────────────────────
const STATE_KEY = 'scope-coherence';
const DEFAULT_CONFIG = {
    depthThreshold: 20,
    cooldownMinutes: 30,
    minSessionAgeMinutes: 5,
    scopeCheckReduction: 10,
};
/**
 * Path patterns that indicate a file is a design/scope document.
 * Reading these files counts as a "scope check" and reduces implementation depth.
 */
const SCOPE_DOC_PATTERNS = [
    'docs/',
    'specs/',
    'SPEC',
    'PROPOSAL',
    'DESIGN',
    'ARCHITECTURE',
    'README',
    '.instar/AGENT.md',
    '.instar/USER.md',
    '.claude/context/',
    '.claude/grounding/',
    'CLAUDE.md',
];
/** File extensions typically used for design docs */
const SCOPE_DOC_EXTENSIONS = ['.md', '.txt', '.rst'];
/** Skills that represent explicit scope/identity grounding */
const GROUNDING_SKILLS = ['grounding', 'dawn', 'reflect', 'introspect', 'session-bootstrap'];
/** Simple query commands that don't count as implementation */
const QUERY_COMMAND_PREFIXES = [
    'git status', 'git log', 'git diff', 'ls ', 'cat ', 'grep ',
    'echo ', 'which ', 'head ', 'tail ', 'wc ', 'pwd', 'date',
    'curl -s', 'python3 -c',
];
// ── Tracker ──────────────────────────────────────────────────────────
export class ScopeCoherenceTracker {
    state;
    config;
    constructor(state, config) {
        this.state = state;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /**
     * Record a tool action and update implementation depth accordingly.
     */
    recordAction(toolName, toolInput = {}) {
        const current = this.getState();
        const now = new Date().toISOString();
        // Initialize session start if not set
        if (!current.sessionStart) {
            current.sessionStart = now;
        }
        if (toolName === 'Edit' || toolName === 'Write') {
            current.implementationDepth += 1;
            current.lastImplementationTool = `${toolName}:${now}`;
        }
        else if (toolName === 'Bash') {
            const command = String(toolInput.command || '');
            if (!this.isQueryCommand(command) && command.length > 10) {
                current.implementationDepth += 1;
                current.lastImplementationTool = `Bash:${now}`;
            }
        }
        else if (toolName === 'Read') {
            const filePath = String(toolInput.file_path || '');
            if (this.isScopeDocument(filePath)) {
                current.implementationDepth = Math.max(0, current.implementationDepth - this.config.scopeCheckReduction);
                current.lastScopeCheck = now;
                if (!current.sessionDocsRead.includes(filePath)) {
                    current.sessionDocsRead.push(filePath);
                    if (current.sessionDocsRead.length > 20) {
                        current.sessionDocsRead = current.sessionDocsRead.slice(-20);
                    }
                }
            }
        }
        else if (toolName === 'Skill') {
            const skillName = String(toolInput.skill || '');
            if (GROUNDING_SKILLS.includes(skillName)) {
                current.implementationDepth = 0;
                current.lastScopeCheck = now;
            }
        }
        this.saveState(current);
    }
    /**
     * Check whether a scope coherence checkpoint should trigger.
     */
    shouldTriggerCheckpoint() {
        const current = this.getState();
        const now = new Date();
        // Check depth threshold
        if (current.implementationDepth < this.config.depthThreshold) {
            return {
                trigger: false,
                depth: current.implementationDepth,
                dismissals: current.checkpointsDismissed,
                skipReason: 'below_threshold',
            };
        }
        // Check cooldown
        if (current.lastCheckpointPrompt) {
            const lastPrompt = new Date(current.lastCheckpointPrompt);
            const cooldownMs = this.config.cooldownMinutes * 60 * 1000;
            if (now.getTime() - lastPrompt.getTime() < cooldownMs) {
                return {
                    trigger: false,
                    depth: current.implementationDepth,
                    dismissals: current.checkpointsDismissed,
                    skipReason: 'cooldown',
                };
            }
        }
        // Check minimum session age
        if (current.sessionStart) {
            const start = new Date(current.sessionStart);
            const minAgeMs = this.config.minSessionAgeMinutes * 60 * 1000;
            if (now.getTime() - start.getTime() < minAgeMs) {
                return {
                    trigger: false,
                    depth: current.implementationDepth,
                    dismissals: current.checkpointsDismissed,
                    skipReason: 'session_too_young',
                };
            }
        }
        return {
            trigger: true,
            depth: current.implementationDepth,
            dismissals: current.checkpointsDismissed,
        };
    }
    /**
     * Record that a checkpoint was shown (and presumably dismissed).
     * Called when the checkpoint fires — if the agent then reads a spec,
     * the depth counter will decrease naturally.
     */
    recordCheckpointShown() {
        const current = this.getState();
        current.lastCheckpointPrompt = new Date().toISOString();
        current.checkpointsDismissed += 1;
        this.saveState(current);
    }
    /**
     * Reset all tracking state. Called at session boundaries.
     */
    reset() {
        this.saveState(this.defaultState());
    }
    /**
     * Get the current scope coherence state.
     */
    getState() {
        const stored = this.state.get(STATE_KEY);
        if (!stored)
            return this.defaultState();
        // Merge with defaults for any missing keys
        const defaults = this.defaultState();
        return {
            ...defaults,
            ...stored,
        };
    }
    /**
     * Check if a file path looks like a design/scope document.
     */
    isScopeDocument(filePath) {
        if (!filePath)
            return false;
        const pathLower = filePath.toLowerCase();
        for (const pattern of SCOPE_DOC_PATTERNS) {
            if (pathLower.includes(pattern.toLowerCase())) {
                return true;
            }
        }
        // All-caps filenames with scope extensions are typically design docs
        const parts = filePath.split('/');
        const fileName = parts[parts.length - 1] || '';
        const dotIndex = fileName.lastIndexOf('.');
        if (dotIndex > 0) {
            const ext = fileName.slice(dotIndex);
            const stem = fileName.slice(0, dotIndex);
            if (SCOPE_DOC_EXTENSIONS.includes(ext) && stem === stem.toUpperCase() && stem.length > 3) {
                return true;
            }
        }
        return false;
    }
    // ── Private ────────────────────────────────────────────────────────
    isQueryCommand(command) {
        const trimmed = command.trim();
        return QUERY_COMMAND_PREFIXES.some(prefix => trimmed.startsWith(prefix));
    }
    saveState(state) {
        this.state.set(STATE_KEY, state);
    }
    defaultState() {
        return {
            implementationDepth: 0,
            lastScopeCheck: null,
            lastCheckpointPrompt: null,
            sessionDocsRead: [],
            checkpointsDismissed: 0,
            lastImplementationTool: null,
            sessionStart: null,
        };
    }
}
//# sourceMappingURL=ScopeCoherenceTracker.js.map