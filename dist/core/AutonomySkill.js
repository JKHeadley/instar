/**
 * AutonomySkill — Conversational interface for autonomy management.
 *
 * Users interact with autonomy through natural language.
 * This module translates between human intent and AutonomyProfileManager
 * operations. The agent calls these functions; the user never types CLI commands.
 *
 * Functions:
 *   - getAutonomyStatus()     → natural language summary of current state
 *   - setAutonomyProfile()    → change profile with confirmation
 *   - getTrustDashboard()     → detailed trust view with elevation opportunities
 *   - handleAutonomyRequest() → parse natural language and dispatch
 *   - notification templates  → formatted strings for Telegram delivery
 *
 * Part of the Adaptive Autonomy System spec.
 */
// ── Profile Descriptions ─────────────────────────────────────────────
const PROFILE_DESCRIPTIONS = {
    cautious: {
        short: 'You approve everything',
        detail: 'I check with you before any risky command, propose changes for your approval, and wait for manual updates. Maximum control, maximum friction.',
        riskNote: 'This is the safest setting. Nothing happens without your say-so.',
    },
    supervised: {
        short: 'Routine is handled, important stuff goes through you',
        detail: 'I handle routine operations on my own and auto-apply updates, but I still propose changes for your approval. Trust auto-elevation is on, so I gradually need to ask less as we build a track record.',
        riskNote: 'Low risk. I may auto-apply safe updates, but all evolution proposals need your sign-off.',
    },
    collaborative: {
        short: 'We work together, I handle most things',
        detail: 'I handle most operations independently, auto-apply updates, and auto-restart after them. I still propose evolution changes for your review, but trust auto-elevates so the approval flow gets lighter over time.',
        riskNote: 'Moderate autonomy. I act independently on most things but still loop you in on evolution.',
    },
    autonomous: {
        short: 'I handle everything, you stay informed',
        detail: 'Full autonomy. I approve my own evolution proposals (you get notified), self-verify risky commands instead of asking, and handle updates end-to-end. You\'re in the loop via notifications, not approvals.',
        riskNote: 'Highest autonomy. I make decisions independently. You can always dial this back.',
    },
};
const INTENT_PATTERNS = [
    // Set autonomous
    {
        patterns: [
            /\b(?:go|set|switch|be)\s+(?:fully\s+)?autonomous\b/i,
            /\bhandle\s+everything\s+(?:yourself|on\s+your\s+own)\b/i,
            /\bfull\s+autonom/i,
            /\bi\s+trust\s+you\s+(?:completely|fully|with\s+everything)\b/i,
            /\bdon'?t\s+(?:need|have)\s+to\s+ask\s+(?:me\s+)?(?:about\s+)?anything\b/i,
            /\bmaximum\s+(?:autonom(?:y|ous)?|freedom)\b/i,
        ],
        intent: () => ({ type: 'set-profile', profile: 'autonomous' }),
    },
    // Set collaborative
    {
        patterns: [
            /\b(?:go|set|switch)\s+(?:to\s+)?collaborative\b/i,
            /\bwork\s+together\b/i,
            /\bi\s+trust\s+(?:your|you)\s+(?:judgment|judgement)\b/i,
            /\bhandle\s+most\s+things\b/i,
        ],
        intent: () => ({ type: 'set-profile', profile: 'collaborative' }),
    },
    // Set supervised
    {
        patterns: [
            /\b(?:go|set|switch)\s+(?:to\s+)?supervised\b/i,
            /\bask\s+(?:me\s+)?(?:about\s+)?important\s+(?:things|stuff)\b/i,
            /\bhandle\s+(?:the\s+)?routine\b/i,
            /\bsome\s+(?:autonom|supervision)\b/i,
        ],
        intent: () => ({ type: 'set-profile', profile: 'supervised' }),
    },
    // Set cautious
    {
        patterns: [
            /\b(?:go|set|switch)\s+(?:to\s+)?cautious\b/i,
            /\bapprove\s+everything\s+(?:myself|first)\b/i,
            /\bi\s+want\s+to\s+(?:approve|see|review)\s+everything\b/i,
            /\bsupervise\s+everything\b/i,
            /\bask\s+(?:me\s+)?(?:about\s+)?everything\b/i,
            /\bno\s+autonom/i,
            /\block\s+(?:it\s+)?down\b/i,
            /\bmaximum\s+(?:control|supervision|oversight)\b/i,
        ],
        intent: () => ({ type: 'set-profile', profile: 'cautious' }),
    },
    // Suggest more autonomy
    {
        patterns: [
            /\b(?:make\s+(?:yourself|you)\s+)?more\s+autonom(?:ous|y)\b/i,
            /\bincrease\s+(?:your\s+)?autonom/i,
            /\bmore\s+(?:freedom|independence)\b/i,
            /\bless\s+(?:oversight|friction|asking|supervision)\b/i,
            /\bstep\s+up\b/i,
            /\bnext\s+level\b/i,
        ],
        intent: () => ({ type: 'suggest-elevation' }),
    },
    // Suggest less autonomy
    {
        patterns: [
            /\b(?:make\s+(?:yourself|you)\s+)?less\s+autonomous\b/i,
            /\bdecrease\s+(?:your\s+)?autonom/i,
            /\bmore\s+(?:oversight|caution|supervision|control)\b/i,
            /\bslow\s+down\b/i,
            /\bpull\s+back\b/i,
            /\bdial\s+(?:it\s+)?back\b/i,
        ],
        intent: () => ({ type: 'revert' }),
    },
    // Revert / undo
    {
        patterns: [
            /\bundo\s+(?:that|the\s+change)\b/i,
            /\bgo\s+back\b/i,
            /\brevert\b/i,
            /\bprevious\s+(?:profile|setting|level)\b/i,
            /\broll\s*back\b/i,
        ],
        intent: () => ({ type: 'revert' }),
    },
    // Trust dashboard
    {
        patterns: [
            /\btrust\s+(?:level|dashboard|status|summary|report)\b/i,
            /\bshow\s+(?:me\s+)?(?:your\s+)?trust\b/i,
            /\bhow\s+much\s+(?:do\s+)?(?:i\s+)?trust\b/i,
            /\btrust\s+(?:score|state|profile)\b/i,
        ],
        intent: () => ({ type: 'trust-dashboard' }),
    },
    // Status / what's my setup
    {
        patterns: [
            /\b(?:what(?:'s| is)\s+(?:my|the|your)\s+)?(?:autonomy|autonom)\s*(?:setup|config|state|status|settings?|level|profile)?\b/i,
            /\b(?:show|tell|give)\s+(?:me\s+)?(?:the\s+)?(?:autonomy|autonom)\b/i,
            /\bhow\s+(?:autonomous|much\s+autonomy)\b/i,
            /\bwhat\s+(?:can|do)\s+you\s+(?:handle|do)\s+(?:on\s+your\s+own|yourself|independently)\b/i,
            /\bcurrent\s+(?:autonomy|profile|settings?)\b/i,
            /\bhow\s+much\s+freedom\b/i,
            /\bwhat\s+(?:are|is)\s+(?:your|the)\s+(?:current\s+)?(?:permission|approval|autonomy)/i,
        ],
        intent: () => ({ type: 'status' }),
    },
];
// ── Main Class ───────────────────────────────────────────────────────
export class AutonomySkill {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    // ── Public API ───────────────────────────────────────────────────
    /**
     * Parse a natural language message and dispatch to the appropriate action.
     * This is the main entry point for conversational autonomy management.
     */
    handleAutonomyRequest(userMessage) {
        const intent = this.classifyIntent(userMessage);
        switch (intent.type) {
            case 'status':
                return this.getAutonomyStatus();
            case 'set-profile':
                return this.setAutonomyProfile(intent.profile);
            case 'trust-dashboard':
                return this.getTrustDashboard();
            case 'suggest-elevation':
                return this.suggestElevation();
            case 'revert':
                return this.revertProfile();
            case 'unknown':
                return this.getAutonomyStatus();
        }
    }
    /**
     * Get a natural language summary of the current autonomy state.
     */
    getAutonomyStatus() {
        const manager = this.deps.autonomyManager;
        const profile = manager.getProfile();
        const resolved = manager.getResolvedState();
        const desc = PROFILE_DESCRIPTIONS[profile];
        const elevations = manager.getPendingElevations();
        const lines = [];
        lines.push(`Your autonomy profile is set to "${profile}" -- ${desc.short}.`);
        lines.push('');
        lines.push(desc.detail);
        // Show any overrides (where resolved state differs from profile defaults)
        const overrides = this.detectOverrides(resolved, profile);
        if (overrides.length > 0) {
            lines.push('');
            lines.push('Active overrides (config values that differ from the profile defaults):');
            for (const o of overrides) {
                lines.push(`  - ${o}`);
            }
        }
        // Elevation opportunities
        if (elevations.length > 0) {
            lines.push('');
            lines.push(`There ${elevations.length === 1 ? 'is' : 'are'} ${elevations.length} trust elevation ${elevations.length === 1 ? 'opportunity' : 'opportunities'}:`);
            for (const e of elevations) {
                lines.push(`  - ${e.service} (${e.operation}): could move from "${e.currentLevel}" to "${e.suggestedLevel}" -- ${e.reason}`);
            }
        }
        // Evolution proposals pending
        const summary = manager.getNaturalLanguageSummary();
        const pendingMatch = summary.match(/Pending evolution proposals: (\d+)/);
        if (pendingMatch) {
            lines.push('');
            lines.push(`You have ${pendingMatch[1]} evolution proposal${pendingMatch[1] === '1' ? '' : 's'} waiting for review.`);
        }
        return {
            text: lines.join('\n'),
            action: 'status',
            resolved,
        };
    }
    /**
     * Set the autonomy profile and return a confirmation with what changed.
     */
    setAutonomyProfile(profile) {
        const manager = this.deps.autonomyManager;
        const oldProfile = manager.getProfile();
        const desc = PROFILE_DESCRIPTIONS[profile];
        if (oldProfile === profile) {
            return {
                text: `You're already on the "${profile}" profile. ${desc.short}.`,
                action: 'set-profile',
                newProfile: profile,
                resolved: manager.getResolvedState(),
            };
        }
        // Determine direction for messaging
        const profileOrder = ['cautious', 'supervised', 'collaborative', 'autonomous'];
        const oldIndex = profileOrder.indexOf(oldProfile);
        const newIndex = profileOrder.indexOf(profile);
        const direction = newIndex > oldIndex ? 'increasing' : 'decreasing';
        const resolved = manager.setProfile(profile, `User request: switch from ${oldProfile} to ${profile}`);
        const lines = [];
        lines.push(`Profile changed: ${oldProfile} -> ${profile}`);
        lines.push('');
        lines.push(desc.detail);
        lines.push('');
        if (direction === 'increasing') {
            lines.push(desc.riskNote);
        }
        else {
            lines.push(`I'll be checking with you more often now. ${desc.riskNote}`);
        }
        // Summarize what concretely changed
        lines.push('');
        lines.push('What this means concretely:');
        lines.push(`  - Evolution: ${resolved.evolutionApprovalMode === 'autonomous' ? 'I approve my own proposals (you get notified)' : 'I propose, you approve'}`);
        lines.push(`  - Safety: ${resolved.safetyLevel === 2 ? 'I self-verify risky commands' : 'I ask you before risky commands'}`);
        lines.push(`  - Updates: ${resolved.autoApplyUpdates ? 'auto-applied' : 'manual'}${resolved.autoRestart ? ', auto-restart' : ', manual restart'}`);
        lines.push(`  - Trust: auto-elevation ${resolved.trustAutoElevate ? 'on' : 'off'}`);
        return {
            text: lines.join('\n'),
            action: 'set-profile',
            newProfile: profile,
            resolved,
        };
    }
    /**
     * Get the trust dashboard — detailed trust view with per-service levels.
     */
    getTrustDashboard() {
        const manager = this.deps.autonomyManager;
        const dashboard = manager.getDashboard();
        const lines = [];
        lines.push('--- Trust Dashboard ---');
        lines.push('');
        lines.push(`Profile: ${dashboard.profile}`);
        lines.push('');
        // Include the trust summary from AutonomyProfileManager (which calls AdaptiveTrust)
        if (dashboard.summary) {
            // Parse out the trust-specific part of the summary
            const summaryLines = dashboard.summary.split('\n');
            const trustStart = summaryLines.findIndex(l => l.startsWith('Trust status:'));
            if (trustStart !== -1) {
                lines.push('Per-service trust levels:');
                for (let i = trustStart + 1; i < summaryLines.length; i++) {
                    const line = summaryLines[i];
                    if (line.startsWith('Elevation opportunities:') || line.startsWith('Pending evolution'))
                        break;
                    if (line.trim())
                        lines.push(`  ${line.trim()}`);
                }
                lines.push('');
            }
        }
        // Elevation opportunities
        if (dashboard.elevations.length > 0) {
            lines.push('Elevation opportunities:');
            for (const e of dashboard.elevations) {
                lines.push(`  - ${e.service} (${e.operation}): ${e.currentLevel} -> ${e.suggestedLevel}`);
                lines.push(`    Reason: ${e.reason}`);
            }
            lines.push('');
        }
        // Rubber-stamp detection from tracker
        if (this.deps.trustElevationTracker) {
            const trackerDashboard = this.deps.trustElevationTracker.getDashboard();
            const rubberStamp = trackerDashboard.rubberStamp;
            if (rubberStamp?.detected) {
                lines.push('Notice: You might be rubber-stamping approvals.');
                lines.push(`  ${rubberStamp.consecutiveFastApprovals} consecutive fast approvals, ${(rubberStamp.approvalRate * 100).toFixed(0)}% approval rate.`);
                lines.push('  Consider moving to a more autonomous profile if you trust the proposals.');
                lines.push('');
            }
        }
        // Recovery suggestions from TrustRecovery
        if (this.deps.trustRecovery) {
            const recoveries = this.deps.trustRecovery.getPendingRecoveries();
            if (recoveries.length > 0) {
                lines.push('Trust recovery available:');
                for (const r of recoveries) {
                    lines.push(`  - ${r.service} (${r.operation}): ${r.message}`);
                }
                lines.push('');
            }
        }
        // Available profiles
        lines.push('Available profiles:');
        for (const p of dashboard.availableProfiles) {
            const marker = p.level === dashboard.profile ? ' [current]' : '';
            lines.push(`  - ${p.level}${marker}: ${p.description}`);
        }
        return {
            text: lines.join('\n'),
            action: 'trust-dashboard',
            resolved: dashboard.resolved,
        };
    }
    // ── Notification Templates ─────────────────────────────────────────
    /**
     * Format a trust elevation suggestion for Telegram delivery.
     */
    static formatElevationSuggestion(opportunity) {
        const lines = [];
        lines.push('Trust elevation opportunity:');
        lines.push('');
        lines.push(`${opportunity.reason}`);
        lines.push(`Currently: ${opportunity.current}`);
        lines.push(`Suggested: ${opportunity.suggested}`);
        lines.push('');
        lines.push(`Evidence: ${opportunity.evidence}`);
        lines.push('');
        lines.push('To accept: tell me to "go more autonomous" or set a specific profile.');
        lines.push('To dismiss: just say "not now" or "keep current settings".');
        return lines.join('\n');
    }
    /**
     * Format a rubber-stamp detection message for Telegram delivery.
     */
    static formatRubberStampAlert(signal) {
        const lines = [];
        lines.push('I noticed you might be rubber-stamping approvals:');
        lines.push('');
        lines.push(`  ${signal.consecutiveFastApprovals} consecutive fast approvals`);
        lines.push(`  ${(signal.approvalRate * 100).toFixed(0)}% approval rate`);
        lines.push(`  Average review time: ${(signal.avgLatencyMs / 1000).toFixed(1)}s`);
        lines.push('');
        lines.push('If you trust my proposals, consider switching to a more autonomous profile.');
        lines.push('That way I handle things directly and just keep you informed.');
        lines.push('');
        lines.push('Say "go more autonomous" or "go autonomous" to reduce the friction.');
        return lines.join('\n');
    }
    /**
     * Format a trust recovery message for Telegram delivery.
     */
    static formatTrustRecovery(suggestion) {
        return suggestion.message;
    }
    /**
     * Format a self-evolution notification for Telegram delivery.
     */
    static formatEvolutionApplied(opts) {
        const lines = [];
        lines.push('Self-evolution applied:');
        lines.push('');
        lines.push(`"${opts.proposalTitle}"`);
        lines.push(`Area: ${opts.affectedArea}`);
        lines.push(`Confidence: ${(opts.confidence * 100).toFixed(0)}%`);
        lines.push('');
        lines.push('This was auto-approved under your current autonomy profile.');
        lines.push('Say "undo that" to revert, or "show evolution history" for details.');
        return lines.join('\n');
    }
    /**
     * Format a profile change notification for Telegram delivery.
     */
    static formatProfileChanged(from, to, reason) {
        const desc = PROFILE_DESCRIPTIONS[to];
        const lines = [];
        lines.push(`Autonomy profile changed: ${from} -> ${to}`);
        lines.push(`Reason: ${reason}`);
        lines.push('');
        lines.push(desc.short);
        lines.push('');
        lines.push('Say "undo that" or "go back" to revert.');
        return lines.join('\n');
    }
    // ── Private ────────────────────────────────────────────────────────
    /**
     * Classify a natural language message into an autonomy intent.
     */
    classifyIntent(message) {
        for (const { patterns, intent } of INTENT_PATTERNS) {
            for (const pattern of patterns) {
                const match = message.match(pattern);
                if (match) {
                    return intent(match);
                }
            }
        }
        return { type: 'unknown', raw: message };
    }
    /**
     * Suggest the next elevation step based on current profile.
     */
    suggestElevation() {
        const manager = this.deps.autonomyManager;
        const current = manager.getProfile();
        const order = ['cautious', 'supervised', 'collaborative', 'autonomous'];
        const currentIdx = order.indexOf(current);
        if (currentIdx >= order.length - 1) {
            return {
                text: 'You\'re already at the most autonomous profile. There\'s no higher level to go to.\n\nIf you want finer-grained control, you can adjust individual trust levels per service.',
                action: 'suggest-elevation',
                resolved: manager.getResolvedState(),
            };
        }
        const next = order[currentIdx + 1];
        const nextDesc = PROFILE_DESCRIPTIONS[next];
        const lines = [];
        lines.push(`You're currently on "${current}". The next level up is "${next}":`);
        lines.push('');
        lines.push(nextDesc.detail);
        lines.push('');
        lines.push(nextDesc.riskNote);
        lines.push('');
        lines.push(`Want me to switch to "${next}"? Just say "go ${next}" to confirm.`);
        return {
            text: lines.join('\n'),
            action: 'suggest-elevation',
            resolved: manager.getResolvedState(),
        };
    }
    /**
     * Revert to the previous profile.
     */
    revertProfile() {
        const manager = this.deps.autonomyManager;
        const history = manager.getHistory();
        const current = manager.getProfile();
        if (history.length === 0) {
            return {
                text: `You're on the "${current}" profile and there's no previous profile to revert to. This is where you started.`,
                action: 'revert',
                resolved: manager.getResolvedState(),
            };
        }
        const lastChange = history[history.length - 1];
        const previous = lastChange.from;
        if (previous === current) {
            // The last change was FROM the current profile — means we already reverted
            // or something odd happened. Try going one more back.
            if (history.length >= 2) {
                const olderChange = history[history.length - 2];
                return this.setAutonomyProfile(olderChange.from);
            }
            return {
                text: `You're already back on "${current}". There's no earlier profile to revert to.`,
                action: 'revert',
                resolved: manager.getResolvedState(),
            };
        }
        return this.setAutonomyProfile(previous);
    }
    /**
     * Detect overrides — config values that differ from profile defaults.
     */
    detectOverrides(resolved, _profile) {
        // The resolved state already accounts for overrides vs defaults.
        // We note this but the manager handles the resolution internally.
        // For now, we can compare resolved to what the profile normally means.
        const overrides = [];
        // Check notifications preferences
        const prefs = this.deps.autonomyManager.getNotificationPreferences();
        if (prefs.evolutionDigest && prefs.evolutionDigest !== 'immediate') {
            overrides.push(`Evolution digest: ${prefs.evolutionDigest} (instead of immediate)`);
        }
        return overrides;
    }
}
//# sourceMappingURL=AutonomySkill.js.map