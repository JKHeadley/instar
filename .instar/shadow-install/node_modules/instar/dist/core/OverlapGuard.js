/**
 * OverlapGuard — Configurable overlap detection with response tiers.
 *
 * Wraps WorkLedger.detectOverlap() with:
 * - Configurable response actions (log/alert/block) per tier
 * - Architectural conflict heuristics (Tier 3)
 * - Multi-user notification routing (same-user vs different-user)
 * - Integration hooks for BranchManager (auto-branch on overlap)
 *
 * From INTELLIGENT_SYNC_SPEC Section 8 (Conflict Prevention Through Awareness).
 */
// ── Constants ────────────────────────────────────────────────────────
const DEFAULT_NOTIFICATION = {
    sameUser: 'log',
    differentUsers: 'alert',
    architecturalConflict: 'block',
};
/**
 * Pairs of terms that suggest opposing architectural directions.
 * If entry A's task contains a term from column 1 and entry B's
 * task contains the paired term from column 2 (or vice versa),
 * it signals an architectural conflict.
 */
const DEFAULT_OPPOSITION_PATTERNS = [
    ['add', 'remove'],
    ['enable', 'disable'],
    ['session', 'jwt'],
    ['session', 'token'],
    ['sql', 'nosql'],
    ['rest', 'graphql'],
    ['monolith', 'microservice'],
    ['sync', 'async'],
    ['polling', 'websocket'],
    ['centralize', 'decentralize'],
    ['merge', 'split'],
    ['upgrade', 'downgrade'],
    ['create', 'delete'],
    ['encrypt', 'decrypt'],
    ['cache', 'no-cache'],
    ['inline', 'extract'],
];
// ── OverlapGuard ─────────────────────────────────────────────────────
export class OverlapGuard {
    workLedger;
    machineId;
    userId;
    notification;
    oppositionPatterns;
    onAlert;
    onBlock;
    constructor(config) {
        this.workLedger = config.workLedger;
        this.machineId = config.machineId;
        this.userId = config.userId;
        this.notification = { ...DEFAULT_NOTIFICATION, ...config.notification };
        this.oppositionPatterns = config.oppositionPatterns ?? DEFAULT_OPPOSITION_PATTERNS;
        this.onAlert = config.onAlert;
        this.onBlock = config.onBlock;
    }
    // ── Main Check ─────────────────────────────────────────────────────
    /**
     * Check for overlap before starting work.
     * Returns the recommended action and details.
     */
    check(opts) {
        // Step 1: Basic overlap detection (Tier 0/1/2)
        const warnings = this.workLedger.detectOverlap(opts.plannedFiles);
        // Step 2: Architectural conflict detection (Tier 3)
        const architecturalConflicts = this.detectArchitecturalConflicts(opts.task, opts.plannedFiles);
        // Step 3: Determine max tier
        let maxTier = 0;
        if (warnings.length > 0) {
            maxTier = Math.max(...warnings.map(w => w.tier));
        }
        if (architecturalConflicts.length > 0) {
            maxTier = 3;
        }
        // Step 4: Determine action based on tier and user context
        const action = this.determineAction(maxTier, warnings);
        // Step 5: Build suggestion
        const suggestion = this.buildSuggestion(maxTier, warnings, architecturalConflicts);
        const result = {
            action,
            maxTier,
            warnings,
            architecturalConflicts,
            canProceed: action !== 'block',
            suggestion,
        };
        // Step 6: Fire callbacks
        if (action === 'alert' && this.onAlert) {
            this.onAlert(result);
        }
        if (action === 'block' && this.onBlock) {
            this.onBlock(result);
        }
        return result;
    }
    // ── Architectural Conflict Detection ───────────────────────────────
    /**
     * Detect Tier 3 architectural conflicts by analyzing task descriptions.
     *
     * Two entries conflict architecturally when:
     * 1. They have overlapping files (or related directories), AND
     * 2. Their task descriptions contain opposing keywords
     */
    detectArchitecturalConflicts(myTask, myPlannedFiles) {
        const conflicts = [];
        const activeEntries = this.workLedger.getActiveEntries()
            .filter(e => e.machineId !== this.machineId);
        const myTaskLower = myTask.toLowerCase();
        for (const entry of activeEntries) {
            // Check file overlap (including directory-level proximity)
            const fileOverlap = this.findFileOverlap(myPlannedFiles, entry);
            if (fileOverlap.length === 0)
                continue;
            // Check for opposing task descriptions
            const opposingSignals = this.findOpposingSignals(myTaskLower, entry.task.toLowerCase());
            if (opposingSignals.length === 0)
                continue;
            conflicts.push({
                entryA: {
                    id: 'self',
                    machineId: this.machineId,
                    sessionId: '',
                    startedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    status: 'active',
                    task: myTask,
                    filesPlanned: myPlannedFiles,
                    filesModified: [],
                },
                entryB: entry,
                overlappingFiles: fileOverlap,
                opposingSignals,
                message: `Architectural conflict: Your task "${truncate(myTask, 60)}" may have opposing assumptions to "${truncate(entry.task, 60)}" on machine "${entry.machineId}". Overlapping files: ${fileOverlap.join(', ')}. Opposing signals: ${opposingSignals.join(', ')}.`,
            });
        }
        return conflicts;
    }
    // ── Private Helpers ────────────────────────────────────────────────
    /**
     * Determine the action based on overlap tier and user context.
     */
    determineAction(maxTier, warnings) {
        if (maxTier === 0)
            return 'log';
        if (maxTier === 3) {
            return this.notification.architecturalConflict;
        }
        // For Tier 1/2, check if it's same-user or different-user
        const isSameUser = this.isSameUserOverlap(warnings);
        if (isSameUser) {
            return this.notification.sameUser;
        }
        else {
            return this.notification.differentUsers;
        }
    }
    /**
     * Check if all overlapping entries belong to the same user.
     */
    isSameUserOverlap(warnings) {
        if (!this.userId)
            return true; // No userId configured → assume same user
        return warnings.every(w => {
            // If the entry has no userId, assume same user (single-user scenario)
            if (!w.entry.userId)
                return true;
            return w.entry.userId === this.userId;
        });
    }
    /**
     * Find file overlap between planned files and an entry's files.
     * Includes directory-level proximity (same parent directory).
     */
    findFileOverlap(myFiles, entry) {
        const entryFiles = new Set([...entry.filesPlanned, ...entry.filesModified]);
        const directOverlap = myFiles.filter(f => entryFiles.has(f));
        if (directOverlap.length > 0)
            return directOverlap;
        // Check directory proximity — if files are in the same directory,
        // there may be implicit coupling
        const myDirs = new Set(myFiles.map(f => parentDir(f)));
        const entryDirs = new Set([...entryFiles].map(f => parentDir(f)));
        const sharedDirs = [];
        for (const dir of myDirs) {
            if (entryDirs.has(dir)) {
                sharedDirs.push(dir);
            }
        }
        // Only return directory overlap if there are shared directories
        // (architectural conflict needs file OR directory overlap)
        return sharedDirs.length > 0
            ? sharedDirs.map(d => `${d}/*`)
            : [];
    }
    /**
     * Find opposing keywords between two task descriptions.
     */
    findOpposingSignals(taskA, taskB) {
        const signals = [];
        for (const [termA, termB] of this.oppositionPatterns) {
            if ((taskA.includes(termA) && taskB.includes(termB)) ||
                (taskA.includes(termB) && taskB.includes(termA))) {
                signals.push(`${termA}↔${termB}`);
            }
        }
        return signals;
    }
    /**
     * Build a human-readable suggestion based on the check result.
     */
    buildSuggestion(maxTier, warnings, architecturalConflicts) {
        switch (maxTier) {
            case 0:
                return 'No overlap detected. Safe to proceed.';
            case 1:
                return `Planned overlap with ${warnings.length} other entry(s). Consider using a task branch to isolate changes.`;
            case 2: {
                const machines = [...new Set(warnings.filter(w => w.tier === 2).map(w => w.entry.machineId))];
                return `Active overlap with machine(s) ${machines.join(', ')}. Recommend using a task branch. Conflicts will be resolved at merge time.`;
            }
            case 3: {
                const conflict = architecturalConflicts[0];
                return `Architectural conflict detected with "${truncate(conflict.entryB.task, 50)}" on machine "${conflict.entryB.machineId}". Recommend coordinating before proceeding.`;
            }
            default:
                return 'Unknown overlap state.';
        }
    }
}
// ── Utility ──────────────────────────────────────────────────────────
function parentDir(filePath) {
    const parts = filePath.split('/');
    return parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
}
function truncate(str, maxLen) {
    return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
}
//# sourceMappingURL=OverlapGuard.js.map