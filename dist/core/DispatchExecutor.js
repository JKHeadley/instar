/**
 * Dispatch Executor — executes action dispatches programmatically and agentically.
 *
 * Two layers of execution:
 *
 *   Layer 1 (Programmatic): Structured actions in JSON — shell commands, file
 *   operations, config merges. Executed mechanically without Claude.
 *
 *   Layer 2 (Agentic): Complex instructions that require interpretation.
 *   Spawns a lightweight Claude session to execute them.
 *
 * Action dispatch content format:
 *   The dispatch `content` field contains a JSON object with:
 *   - description: Human-readable explanation of what this action does
 *   - steps: Array of action steps to execute in order
 *   - verify: Optional verification command (must exit 0 for success)
 *   - rollback: Optional array of steps to undo on failure
 *   - conditions: Optional preconditions (version, file existence, etc.)
 *
 * Step types:
 *   - { type: "shell", command: string } — run a shell command
 *   - { type: "file_write", path: string, content: string } — write a file
 *   - { type: "file_patch", path: string, find: string, replace: string } — search/replace
 *   - { type: "config_merge", path: string, merge: object } — deep merge into JSON config
 *   - { type: "agentic", prompt: string } — spawn Claude to handle complex logic
 *
 * Security:
 *   - Shell commands are run in the project directory with a 60s timeout
 *   - File paths are resolved relative to the project directory
 *   - Path traversal (../) is rejected
 *   - Destructive commands (rm -rf, etc.) are blocked
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
// ── Blocked patterns ───────────────────────────────────────────────
const BLOCKED_COMMANDS = [
    /\brm\s+(-rf?|--force)\s+[\/~]/,
    /\brm\s+-rf?\s+\./,
    /\bmkfs\b/,
    /\bdd\s+if=/,
    /\b(shutdown|reboot|halt)\b/,
    /\bcurl\b.*\|\s*(sh|bash)\b/,
    /\bwget\b.*\|\s*(sh|bash)\b/,
    />\s*\/dev\//,
    /\bchmod\s+777\b/,
];
// ── Executor ───────────────────────────────────────────────────────
export class DispatchExecutor {
    projectDir;
    sessionManager;
    constructor(projectDir, sessionManager) {
        this.projectDir = projectDir;
        this.sessionManager = sessionManager ?? null;
    }
    /**
     * Parse an action payload from dispatch content.
     * Returns null if the content is not valid action JSON.
     */
    parseAction(content) {
        try {
            const parsed = JSON.parse(content);
            if (!parsed || typeof parsed !== 'object')
                return null;
            if (!Array.isArray(parsed.steps) || parsed.steps.length === 0)
                return null;
            return parsed;
        }
        catch {
            // @silent-fallback-ok — malformed JSON rejected
            return null;
        }
    }
    /**
     * Execute an action dispatch.
     *
     * 1. Check preconditions
     * 2. Execute steps in order
     * 3. Verify success
     * 4. Rollback on failure (if rollback steps provided)
     */
    async execute(payload) {
        const stepResults = [];
        let completedSteps = 0;
        // Check preconditions
        if (payload.conditions) {
            const condResult = await this.checkConditions(payload.conditions);
            if (!condResult.met) {
                return {
                    success: false,
                    completedSteps: 0,
                    totalSteps: payload.steps.length,
                    message: `Precondition not met: ${condResult.reason}`,
                    stepResults: [],
                    verified: false,
                    rolledBack: false,
                };
            }
        }
        // Execute steps
        for (let i = 0; i < payload.steps.length; i++) {
            const step = payload.steps[i];
            const result = await this.executeStep(step, i);
            stepResults.push(result);
            if (result.success) {
                completedSteps++;
            }
            else {
                // Step failed — attempt rollback if available
                let rolledBack = false;
                if (payload.rollback && payload.rollback.length > 0) {
                    console.log(`[DispatchExecutor] Step ${i} failed, rolling back...`);
                    for (const rbStep of payload.rollback) {
                        await this.executeStep(rbStep, -1).catch(() => { });
                    }
                    rolledBack = true;
                }
                return {
                    success: false,
                    completedSteps,
                    totalSteps: payload.steps.length,
                    message: `Step ${i + 1} failed: ${result.error || 'Unknown error'}`,
                    stepResults,
                    verified: false,
                    rolledBack,
                };
            }
        }
        // Verify if verification command is provided
        let verified = true;
        if (payload.verify) {
            const verifyResult = await this.runShell(payload.verify);
            verified = verifyResult.success;
            if (!verified) {
                console.log(`[DispatchExecutor] Verification failed: ${verifyResult.error}`);
            }
        }
        return {
            success: true,
            completedSteps,
            totalSteps: payload.steps.length,
            message: `All ${completedSteps} steps completed${verified ? ' and verified' : ' (verification failed)'}`,
            stepResults,
            verified,
            rolledBack: false,
        };
    }
    /**
     * Execute a single step.
     */
    async executeStep(step, index) {
        const base = {
            step: index,
            type: step.type,
        };
        try {
            switch (step.type) {
                case 'shell':
                    return { ...base, ...await this.runShell(step.command) };
                case 'file_write':
                    return { ...base, ...this.writeFile(step.path, step.content) };
                case 'file_patch':
                    return { ...base, ...this.patchFile(step.path, step.find, step.replace) };
                case 'config_merge':
                    return { ...base, ...this.mergeConfig(step.path, step.merge) };
                case 'agentic':
                    return { ...base, ...await this.runAgentic(step.prompt) };
                default:
                    return { ...base, success: false, error: `Unknown step type: ${step.type}` };
            }
        }
        catch (err) {
            return { ...base, success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    // ── Step implementations ─────────────────────────────────────────
    async runShell(command) {
        if (!command || typeof command !== 'string') {
            return { success: false, error: 'Empty command' };
        }
        // Security: block dangerous commands
        for (const pattern of BLOCKED_COMMANDS) {
            if (pattern.test(command)) {
                return { success: false, error: `Blocked: command matches dangerous pattern` };
            }
        }
        return new Promise((resolve) => {
            execFile('sh', ['-c', command], {
                cwd: this.projectDir,
                encoding: 'utf-8',
                timeout: 60_000,
                maxBuffer: 1024 * 1024,
            }, (err, stdout, stderr) => {
                if (err) {
                    resolve({
                        success: false,
                        output: stdout?.trim(),
                        error: stderr?.trim() || err.message,
                    });
                }
                else {
                    resolve({
                        success: true,
                        output: (stdout || '').trim(),
                    });
                }
            });
        });
    }
    writeFile(filePath, content) {
        const resolved = this.resolvePath(filePath);
        if (!resolved)
            return { success: false, error: `Invalid path: ${filePath}` };
        try {
            const dir = path.dirname(resolved);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(resolved, content);
            return { success: true, output: `Wrote ${content.length} bytes to ${filePath}` };
        }
        catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    patchFile(filePath, find, replace) {
        const resolved = this.resolvePath(filePath);
        if (!resolved)
            return { success: false, error: `Invalid path: ${filePath}` };
        if (!fs.existsSync(resolved)) {
            return { success: false, error: `File not found: ${filePath}` };
        }
        try {
            const content = fs.readFileSync(resolved, 'utf-8');
            if (!content.includes(find)) {
                return { success: false, error: `Search string not found in ${filePath}` };
            }
            const patched = content.replace(find, replace);
            fs.writeFileSync(resolved, patched);
            return { success: true, output: `Patched ${filePath}` };
        }
        catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    mergeConfig(filePath, merge) {
        const resolved = this.resolvePath(filePath);
        if (!resolved)
            return { success: false, error: `Invalid path: ${filePath}` };
        try {
            let existing = {};
            if (fs.existsSync(resolved)) {
                existing = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
            }
            const merged = deepMerge(existing, merge);
            const dir = path.dirname(resolved);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(resolved, JSON.stringify(merged, null, 2) + '\n');
            return { success: true, output: `Merged ${Object.keys(merge).length} keys into ${filePath}` };
        }
        catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    async runAgentic(prompt) {
        if (!this.sessionManager) {
            return { success: false, error: 'SessionManager not available for agentic execution' };
        }
        try {
            // Spawn a lightweight session to handle the complex dispatch
            const sessionName = `dispatch-${Date.now().toString(36)}`;
            const fullPrompt = [
                'You are executing an intelligence dispatch from the Instar update system.',
                'Follow the instructions below precisely. Report what you did.',
                '',
                prompt,
            ].join('\n');
            const tmuxSession = await this.sessionManager.spawnSession({
                name: sessionName,
                prompt: fullPrompt,
                maxDurationMinutes: 10,
                model: 'haiku',
                jobSlug: 'dispatch-action',
            });
            return {
                success: true,
                output: `Spawned agentic session: ${tmuxSession}`,
            };
        }
        catch (err) {
            DegradationReporter.getInstance().report({
                feature: 'DispatchExecutor.executeStep',
                primary: 'Spawn agentic session for dispatch action',
                fallback: 'Return error to user',
                reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
                impact: 'Dispatch action failed — user notified but no system alert',
            });
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    // ── Helpers ──────────────────────────────────────────────────────
    /**
     * Resolve a path relative to the project directory.
     * Returns null if the path escapes the project dir.
     */
    resolvePath(filePath) {
        if (!filePath || typeof filePath !== 'string')
            return null;
        // Reject obvious traversal attempts
        if (filePath.includes('..'))
            return null;
        if (path.isAbsolute(filePath))
            return null;
        const resolved = path.resolve(this.projectDir, filePath);
        // Verify the resolved path is still inside the project dir
        if (!resolved.startsWith(this.projectDir))
            return null;
        return resolved;
    }
    /**
     * Check preconditions for an action dispatch.
     */
    async checkConditions(conditions) {
        if (conditions.fileExists) {
            const resolved = this.resolvePath(conditions.fileExists);
            if (!resolved || !fs.existsSync(resolved)) {
                return { met: false, reason: `Required file not found: ${conditions.fileExists}` };
            }
        }
        if (conditions.fileNotExists) {
            const resolved = this.resolvePath(conditions.fileNotExists);
            if (resolved && fs.existsSync(resolved)) {
                return { met: false, reason: `File must not exist: ${conditions.fileNotExists}` };
            }
        }
        // Version conditions are checked by DispatchManager before reaching executor
        return { met: true };
    }
}
// ── Deep merge utility ─────────────────────────────────────────────
function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        const sourceVal = source[key];
        const targetVal = result[key];
        if (sourceVal && typeof sourceVal === 'object' && !Array.isArray(sourceVal) &&
            targetVal && typeof targetVal === 'object' && !Array.isArray(targetVal)) {
            result[key] = deepMerge(targetVal, sourceVal);
        }
        else {
            result[key] = sourceVal;
        }
    }
    return result;
}
//# sourceMappingURL=DispatchExecutor.js.map