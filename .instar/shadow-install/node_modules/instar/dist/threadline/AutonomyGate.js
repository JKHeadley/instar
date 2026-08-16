/**
 * AutonomyGate — Autonomy-gated visibility for inter-agent messages.
 *
 * Part of the Threadline Protocol Phase 2. Sits in the message receive pipeline
 * BEFORE ThreadlineRouter. When an inter-agent message arrives, the gate evaluates
 * the autonomy profile and decides what to do:
 *
 * - Cautious: Queue for user approval
 * - Supervised: Deliver immediately, notify user
 * - Collaborative: Deliver silently, add to periodic digest
 * - Autonomous: Deliver silently, log only
 *
 * The gate also handles per-agent blocking/pausing and integrates with
 * the ApprovalQueue and DigestCollector.
 */
import fs from 'node:fs';
import path from 'node:path';
// ── Implementation ──────────────────────────────────────────────────
export class AutonomyGate {
    autonomyManager;
    approvalQueue;
    digestCollector;
    notifier;
    agentControlPath;
    constructor(opts) {
        this.autonomyManager = opts.autonomyManager;
        this.approvalQueue = opts.approvalQueue;
        this.digestCollector = opts.digestCollector;
        this.notifier = opts.notifier ?? null;
        const threadlineDir = path.join(opts.stateDir, 'threadline');
        fs.mkdirSync(threadlineDir, { recursive: true });
        this.agentControlPath = path.join(threadlineDir, 'agent-controls.json');
    }
    /**
     * Evaluate an inbound inter-agent message through the autonomy gate.
     *
     * Pipeline:
     * 1. Check if the sending agent is blocked → block
     * 2. Check if the sending agent is paused → queue-for-approval
     * 3. Evaluate based on current autonomy profile level
     * 4. Execute side effects (notifications, digest, queue)
     */
    async evaluate(envelope) {
        const fromAgent = envelope.message.from.agent;
        // Step 1: Check if agent is blocked
        const agentStatus = this.getAgentStatus(fromAgent);
        if (agentStatus === 'blocked') {
            return {
                decision: 'block',
                reason: `Agent "${fromAgent}" is blocked.`,
            };
        }
        // Step 2: Check if agent is paused
        if (agentStatus === 'paused') {
            const approvalId = this.approvalQueue.enqueue(envelope);
            await this.fireApprovalRequest(approvalId);
            return {
                decision: 'queue-for-approval',
                reason: `Agent "${fromAgent}" is paused. Message queued for approval.`,
                approvalId,
            };
        }
        // Step 3: Evaluate based on autonomy level
        const level = this.autonomyManager.getProfile();
        return await this.evaluateByLevel(level, envelope);
    }
    /**
     * Approve a queued message and return the entry.
     */
    approveMessage(approvalId) {
        return this.approvalQueue.approve(approvalId);
    }
    /**
     * Reject a queued message and return the entry.
     */
    rejectMessage(approvalId) {
        return this.approvalQueue.reject(approvalId);
    }
    /**
     * Get the approval queue entries.
     */
    getApprovalQueue(status) {
        return this.approvalQueue.getQueue(status);
    }
    /**
     * Prune expired approval queue entries.
     */
    pruneExpired() {
        return this.approvalQueue.pruneExpired();
    }
    /**
     * Check if a digest should be sent, and send it if so.
     * Returns true if a digest was sent.
     */
    async checkAndSendDigest() {
        if (!this.digestCollector.shouldSendDigest())
            return false;
        const digest = this.digestCollector.generateDigest();
        if (!digest)
            return false;
        if (this.notifier) {
            try {
                await this.notifier.sendDigest(digest);
            }
            catch {
                // Notification failure is non-fatal
            }
        }
        this.digestCollector.markDigestSent();
        return true;
    }
    // ── Agent Controls ──────────────────────────────────────────────
    /**
     * Temporarily pause all messages from an agent (queues them for approval).
     */
    pauseAgent(agentName, reason) {
        const controls = this.loadAgentControls();
        controls.agents[agentName] = {
            status: 'paused',
            since: new Date().toISOString(),
            reason,
        };
        this.saveAgentControls(controls);
    }
    /**
     * Resume messages from a paused agent.
     */
    resumeAgent(agentName) {
        const controls = this.loadAgentControls();
        if (controls.agents[agentName]?.status === 'paused') {
            delete controls.agents[agentName];
            this.saveAgentControls(controls);
        }
    }
    /**
     * Permanently block all messages from an agent.
     */
    blockAgent(agentName, reason) {
        const controls = this.loadAgentControls();
        controls.agents[agentName] = {
            status: 'blocked',
            since: new Date().toISOString(),
            reason,
        };
        this.saveAgentControls(controls);
    }
    /**
     * Unblock an agent.
     */
    unblockAgent(agentName) {
        const controls = this.loadAgentControls();
        delete controls.agents[agentName];
        this.saveAgentControls(controls);
    }
    /**
     * Get all blocked and paused agents.
     */
    getControlledAgents() {
        const controls = this.loadAgentControls();
        return Object.entries(controls.agents).map(([agent, info]) => ({
            agent,
            ...info,
        }));
    }
    /**
     * Get the DigestCollector instance (for configuration).
     */
    getDigestCollector() {
        return this.digestCollector;
    }
    /**
     * Get the ApprovalQueue instance (for direct access).
     */
    getApprovalQueueInstance() {
        return this.approvalQueue;
    }
    // ── Private ──────────────────────────────────────────────────────
    async evaluateByLevel(level, envelope) {
        switch (level) {
            case 'cautious': {
                const approvalId = this.approvalQueue.enqueue(envelope);
                await this.fireApprovalRequest(approvalId);
                return {
                    decision: 'queue-for-approval',
                    reason: 'Cautious mode: all inter-agent messages require user approval.',
                    approvalId,
                };
            }
            case 'supervised': {
                // Deliver immediately, notify user
                let notificationSent = false;
                if (this.notifier) {
                    try {
                        const summary = this.buildNotificationSummary(envelope);
                        await this.notifier.notifyUser(summary);
                        notificationSent = true;
                    }
                    catch {
                        // Notification failure is non-fatal — still deliver
                    }
                }
                return {
                    decision: 'notify-and-deliver',
                    reason: 'Supervised mode: message delivered, user notified.',
                    notificationSent,
                };
            }
            case 'collaborative': {
                // Deliver silently, add to digest
                this.digestCollector.addEntry(envelope);
                return {
                    decision: 'deliver',
                    reason: 'Collaborative mode: message delivered silently, added to digest.',
                };
            }
            case 'autonomous': {
                // Deliver silently, log only
                return {
                    decision: 'deliver',
                    reason: 'Autonomous mode: message delivered silently.',
                };
            }
        }
    }
    buildNotificationSummary(envelope) {
        const msg = envelope.message;
        const threadTag = msg.threadId ? ` (thread: ${msg.threadId.slice(0, 8)})` : '';
        return `Inter-agent message from ${msg.from.agent}${threadTag}:\n[${msg.type}] ${msg.subject}\n${msg.body.slice(0, 200)}`;
    }
    async fireApprovalRequest(approvalId) {
        if (!this.notifier)
            return;
        const entry = this.approvalQueue.getEntry(approvalId);
        if (!entry)
            return;
        try {
            await this.notifier.requestApproval(entry);
        }
        catch {
            // Notification failure is non-fatal
        }
    }
    getAgentStatus(agentName) {
        const controls = this.loadAgentControls();
        return controls.agents[agentName]?.status ?? null;
    }
    loadAgentControls() {
        try {
            if (fs.existsSync(this.agentControlPath)) {
                return JSON.parse(fs.readFileSync(this.agentControlPath, 'utf-8'));
            }
        }
        catch {
            // Corrupted — start fresh
        }
        return { agents: {} };
    }
    saveAgentControls(controls) {
        try {
            fs.writeFileSync(this.agentControlPath, JSON.stringify(controls, null, 2));
        }
        catch {
            // Non-fatal
        }
    }
}
//# sourceMappingURL=AutonomyGate.js.map