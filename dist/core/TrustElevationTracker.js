/**
 * TrustElevationTracker — Monitors trust signals and surfaces elevation opportunities.
 *
 * Part of Phase 2 of the Adaptive Autonomy System.
 *
 * Tracks three kinds of trust signals:
 * 1. Evolution proposal acceptance rates (from EvolutionManager)
 * 2. Operation success streaks (from AdaptiveTrust)
 * 3. Rubber-stamp detection (fast approvals with no modifications)
 *
 * When thresholds are met, generates elevation suggestions that can be
 * surfaced conversationally or via Telegram.
 */
import fs from 'node:fs';
import path from 'node:path';
// ── Implementation ───────────────────────────────────────────────────
export class TrustElevationTracker {
    config;
    statePath;
    state;
    constructor(config) {
        this.config = config;
        this.statePath = path.join(config.stateDir, 'state', 'trust-elevation.json');
        this.state = this.loadOrCreate();
    }
    // ── Public API ───────────────────────────────────────────────────
    /**
     * Record an evolution proposal decision (approve/reject).
     * Call this when a proposal status changes to approved, rejected, or deferred.
     */
    recordApprovalEvent(event) {
        this.state.approvalEvents.push(event);
        // Keep history manageable (last 200 events)
        if (this.state.approvalEvents.length > 200) {
            this.state.approvalEvents = this.state.approvalEvents.slice(-200);
        }
        this.evaluate();
        this.save();
    }
    /**
     * Record a proposal status change and auto-compute latency.
     * Convenience wrapper around recordApprovalEvent.
     */
    recordProposalDecision(proposal, decision, modified = false) {
        const now = new Date();
        const proposedAt = new Date(proposal.proposedAt);
        const latencyMs = now.getTime() - proposedAt.getTime();
        this.recordApprovalEvent({
            proposalId: proposal.id,
            proposedAt: proposal.proposedAt,
            decidedAt: now.toISOString(),
            decision,
            modified,
            latencyMs,
        });
    }
    /**
     * Get evolution acceptance statistics.
     */
    getAcceptanceStats() {
        const windowSize = this.config.recentWindowSize ?? 20;
        const events = this.state.approvalEvents.filter(e => e.decision !== 'deferred');
        const approved = events.filter(e => e.decision === 'approved');
        const rejected = events.filter(e => e.decision === 'rejected');
        const approvedUnmodified = approved.filter(e => !e.modified);
        const recentEvents = events.slice(-windowSize);
        const recentApproved = recentEvents.filter(e => e.decision === 'approved');
        return {
            totalDecided: events.length,
            approved: approved.length,
            rejected: rejected.length,
            approvedUnmodified: approvedUnmodified.length,
            acceptanceRate: events.length > 0 ? approved.length / events.length : 0,
            recentAcceptanceRate: recentEvents.length > 0 ? recentApproved.length / recentEvents.length : 0,
            recentWindowSize: windowSize,
        };
    }
    /**
     * Get the current rubber-stamp signal.
     */
    getRubberStampSignal() {
        return { ...this.state.rubberStamp };
    }
    /**
     * Get all active (non-dismissed) elevation opportunities.
     */
    getActiveOpportunities() {
        const now = new Date();
        return this.state.opportunities.filter(o => {
            if (!o.dismissedUntil)
                return true;
            return new Date(o.dismissedUntil) <= now;
        });
    }
    /**
     * Get all elevation opportunities (including dismissed).
     */
    getAllOpportunities() {
        return [...this.state.opportunities];
    }
    /**
     * Dismiss an elevation opportunity for a specified duration.
     */
    dismissOpportunity(type, days = 30) {
        const opp = this.state.opportunities.find(o => o.type === type);
        if (!opp)
            return false;
        const dismissUntil = new Date();
        dismissUntil.setDate(dismissUntil.getDate() + days);
        opp.dismissedUntil = dismissUntil.toISOString();
        this.save();
        return true;
    }
    /**
     * Dismiss rubber-stamp alert.
     */
    dismissRubberStamp(days) {
        const dismissDays = days ?? this.config.rubberStampDismissDays ?? 30;
        const dismissUntil = new Date();
        dismissUntil.setDate(dismissUntil.getDate() + dismissDays);
        this.state.rubberStamp.dismissedUntil = dismissUntil.toISOString();
        this.save();
    }
    /**
     * Check if an evolution governance upgrade should be suggested.
     * Returns an opportunity if the acceptance rate warrants moving to autonomous.
     */
    checkEvolutionGovernanceElevation(currentMode) {
        if (currentMode === 'autonomous')
            return null;
        const stats = this.getAcceptanceStats();
        const minProposals = this.config.minProposalsForElevation ?? 10;
        const threshold = this.config.acceptanceRateThreshold ?? 0.85;
        if (stats.totalDecided < minProposals)
            return null;
        if (stats.recentAcceptanceRate < threshold)
            return null;
        // Check if this opportunity already exists and is dismissed
        const existing = this.state.opportunities.find(o => o.type === 'evolution-governance');
        if (existing?.dismissedUntil && new Date(existing.dismissedUntil) > new Date()) {
            return null;
        }
        const opportunity = {
            type: 'evolution-governance',
            current: 'ai-assisted (you approve each proposal)',
            suggested: 'autonomous (AI approves, you\'re notified)',
            reason: `Your agent's evolution proposals have a ${(stats.recentAcceptanceRate * 100).toFixed(0)}% acceptance rate over the last ${stats.recentWindowSize} decisions.`,
            evidence: `${stats.approved} approved out of ${stats.totalDecided} total (${stats.approvedUnmodified} without modification).`,
            createdAt: new Date().toISOString(),
            dismissedUntil: null,
        };
        return opportunity;
    }
    /**
     * Check if a profile upgrade should be suggested based on overall trust signals.
     */
    checkProfileElevation(currentProfile, operationElevations) {
        // Already at max
        if (currentProfile === 'autonomous')
            return null;
        const stats = this.getAcceptanceStats();
        const hasGoodAcceptance = stats.totalDecided >= 10 && stats.recentAcceptanceRate >= 0.8;
        const hasOperationTrust = operationElevations.length >= 2;
        if (!hasGoodAcceptance && !hasOperationTrust)
            return null;
        // Determine next profile
        const profileOrder = ['cautious', 'supervised', 'collaborative', 'autonomous'];
        const currentIdx = profileOrder.indexOf(currentProfile);
        if (currentIdx >= profileOrder.length - 1)
            return null;
        const suggestedProfile = profileOrder[currentIdx + 1];
        const existing = this.state.opportunities.find(o => o.type === 'profile-upgrade');
        if (existing?.dismissedUntil && new Date(existing.dismissedUntil) > new Date()) {
            return null;
        }
        const reasons = [];
        if (hasGoodAcceptance) {
            reasons.push(`${(stats.recentAcceptanceRate * 100).toFixed(0)}% evolution acceptance rate`);
        }
        if (hasOperationTrust) {
            reasons.push(`${operationElevations.length} operation trust elevations earned`);
        }
        return {
            type: 'profile-upgrade',
            current: currentProfile,
            suggested: suggestedProfile,
            reason: reasons.join(' and '),
            evidence: `Profile has been at '${currentProfile}' with demonstrated competence.`,
            createdAt: new Date().toISOString(),
            dismissedUntil: null,
        };
    }
    /**
     * Format an elevation opportunity as a conversational Telegram message.
     */
    formatElevationMessage(opportunity) {
        const lines = [];
        switch (opportunity.type) {
            case 'evolution-governance':
                lines.push('Trust Elevation Opportunity');
                lines.push('');
                lines.push(opportunity.reason);
                lines.push(opportunity.evidence);
                lines.push('');
                lines.push(`Current: ${opportunity.current}`);
                lines.push(`Suggested: ${opportunity.suggested}`);
                lines.push('');
                lines.push('Reply "sounds good" to upgrade, or "not yet" to dismiss for 30 days.');
                break;
            case 'profile-upgrade':
                lines.push('Profile Upgrade Available');
                lines.push('');
                lines.push(opportunity.reason);
                lines.push('');
                lines.push(`Current profile: ${opportunity.current}`);
                lines.push(`Suggested profile: ${opportunity.suggested}`);
                lines.push('');
                lines.push(`Reply "upgrade" to move to ${opportunity.suggested}, or "not yet" to dismiss.`);
                break;
            case 'operation-trust':
                lines.push('Operation Trust Earned');
                lines.push('');
                lines.push(opportunity.reason);
                lines.push('');
                lines.push(`Current: ${opportunity.current}`);
                lines.push(`Suggested: ${opportunity.suggested}`);
                lines.push('');
                lines.push('Reply "sounds good" to apply, or "not yet" to dismiss.');
                break;
        }
        return lines.join('\n');
    }
    /**
     * Format rubber-stamp detection as a conversational Telegram message.
     */
    formatRubberStampMessage() {
        const signal = this.state.rubberStamp;
        if (!signal.detected)
            return null;
        if (signal.dismissedUntil && new Date(signal.dismissedUntil) > new Date())
            return null;
        const lines = [];
        lines.push('Approval Pattern Detected');
        lines.push('');
        lines.push(`You've approved ${signal.consecutiveFastApprovals} consecutive proposals in under ${((this.config.rubberStampLatencyMs ?? 5000) / 1000).toFixed(0)} seconds each.`);
        lines.push('This suggests the current approval level may be creating unnecessary friction.');
        lines.push('');
        lines.push('Current: ai-assisted (you approve each proposal)');
        lines.push('Suggested: autonomous (AI approves, you\'re notified, you can revert)');
        lines.push('');
        lines.push('Reply "go for it" to upgrade, or "keep it as is" to dismiss for 60 days.');
        return lines.join('\n');
    }
    /**
     * Get the full tracker state for API responses.
     */
    getDashboard() {
        return {
            acceptanceStats: this.getAcceptanceStats(),
            rubberStamp: this.getRubberStampSignal(),
            activeOpportunities: this.getActiveOpportunities(),
            allOpportunities: this.getAllOpportunities(),
            lastEvaluatedAt: this.state.lastEvaluatedAt,
        };
    }
    // ── Private ──────────────────────────────────────────────────────
    /**
     * Evaluate all trust signals and update opportunities.
     */
    evaluate() {
        this.evaluateRubberStamp();
        this.state.lastEvaluatedAt = new Date().toISOString();
    }
    /**
     * Check for rubber-stamp pattern in recent approvals.
     */
    evaluateRubberStamp() {
        const latencyThreshold = this.config.rubberStampLatencyMs ?? 5000;
        const consecutiveThreshold = this.config.rubberStampConsecutive ?? 10;
        // Look at recent approval events (only approved ones)
        const approved = this.state.approvalEvents
            .filter(e => e.decision === 'approved')
            .slice(-consecutiveThreshold);
        if (approved.length < consecutiveThreshold) {
            this.state.rubberStamp.detected = false;
            this.state.rubberStamp.consecutiveFastApprovals = 0;
            return;
        }
        // Check if all are fast and unmodified
        const allFast = approved.every(e => e.latencyMs < latencyThreshold);
        const allUnmodified = approved.every(e => !e.modified);
        if (allFast && allUnmodified) {
            const totalLatency = approved.reduce((sum, e) => sum + e.latencyMs, 0);
            this.state.rubberStamp = {
                detected: true,
                consecutiveFastApprovals: approved.length,
                avgLatencyMs: totalLatency / approved.length,
                approvalRate: 1.0,
                evaluatedAt: new Date().toISOString(),
                dismissedUntil: this.state.rubberStamp.dismissedUntil, // preserve dismiss state
            };
        }
        else {
            this.state.rubberStamp.detected = false;
        }
    }
    loadOrCreate() {
        if (fs.existsSync(this.statePath)) {
            try {
                return JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
            }
            catch {
                // Corrupt — recreate
            }
        }
        return {
            approvalEvents: [],
            rubberStamp: {
                detected: false,
                consecutiveFastApprovals: 0,
                avgLatencyMs: 0,
                approvalRate: 0,
                evaluatedAt: new Date().toISOString(),
                dismissedUntil: null,
            },
            opportunities: [],
            lastEvaluatedAt: new Date().toISOString(),
        };
    }
    save() {
        try {
            const dir = path.dirname(this.statePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
        }
        catch {
            // Non-fatal
        }
    }
}
//# sourceMappingURL=TrustElevationTracker.js.map