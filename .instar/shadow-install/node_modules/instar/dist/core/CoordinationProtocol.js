/**
 * CoordinationProtocol — Work coordination primitives for multi-machine agents.
 *
 * Provides higher-level coordination on top of AgentBus:
 *   1. File avoidance requests ("please avoid file X for 30 min")
 *   2. Work announcements (broadcast what you're starting/finishing)
 *   3. Status queries (who is working on what?)
 *   4. ETA tracking (when will other machine finish with a file?)
 *   5. Leadership / awake-role management with fencing tokens
 *
 * From INTELLIGENT_SYNC_SPEC Sections 7.4, 8, 13.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
// ── Constants ────────────────────────────────────────────────────────
const DEFAULT_LEASE_TTL = 15 * 60 * 1000; // 15 minutes
const DEFAULT_STATUS_TIMEOUT = 10_000;
const COORDINATION_DIR = 'coordination';
const LEADERSHIP_FILE = 'leadership.json';
const AVOIDANCE_FILE = 'avoidances.json';
// ── CoordinationProtocol ─────────────────────────────────────────────
export class CoordinationProtocol {
    bus;
    machineId;
    stateDir;
    leaseTtlMs;
    statusQueryTimeoutMs;
    coordDir;
    avoidances = [];
    peerWork = new Map();
    onAvoidanceRequest;
    onWorkAnnouncement;
    constructor(config) {
        this.bus = config.bus;
        this.machineId = config.machineId;
        this.stateDir = config.stateDir;
        this.leaseTtlMs = config.leaseTtlMs ?? DEFAULT_LEASE_TTL;
        this.statusQueryTimeoutMs = config.statusQueryTimeoutMs ?? DEFAULT_STATUS_TIMEOUT;
        this.onAvoidanceRequest = config.onAvoidanceRequest;
        this.onWorkAnnouncement = config.onWorkAnnouncement;
        this.coordDir = path.join(config.stateDir, 'state', COORDINATION_DIR);
        if (!fs.existsSync(this.coordDir)) {
            fs.mkdirSync(this.coordDir, { recursive: true });
        }
        // Register message handlers
        this.registerHandlers();
    }
    // ── File Avoidance ──────────────────────────────────────────────────
    /**
     * Request another machine to avoid specific files for a duration.
     */
    async requestFileAvoidance(targetMachineId, request) {
        const reply = await this.bus.request({
            type: 'file-avoidance-request',
            to: targetMachineId,
            payload: request,
            timeoutMs: this.statusQueryTimeoutMs,
        });
        return reply?.payload ?? null;
    }
    /**
     * Broadcast a file avoidance request to all machines.
     */
    async broadcastFileAvoidance(request) {
        await this.bus.send({
            type: 'file-avoidance-request',
            to: '*',
            payload: request,
        });
    }
    /**
     * Check if a file is currently under avoidance.
     */
    isFileAvoided(filePath) {
        this.cleanExpiredAvoidances();
        return this.avoidances.find(a => a.files.includes(filePath));
    }
    /**
     * Get all active avoidances.
     */
    getActiveAvoidances() {
        this.cleanExpiredAvoidances();
        return [...this.avoidances];
    }
    // ── Work Announcements ──────────────────────────────────────────────
    /**
     * Announce work to all machines.
     */
    async announceWork(announcement) {
        await this.bus.send({
            type: 'work-announcement',
            to: '*',
            payload: announcement,
        });
    }
    /**
     * Announce that work has started.
     */
    async announceWorkStarted(opts) {
        const workId = `work_${crypto.randomBytes(6).toString('hex')}`;
        await this.announceWork({
            workId,
            action: 'started',
            ...opts,
        });
        return workId;
    }
    /**
     * Announce that work has completed.
     */
    async announceWorkCompleted(workId, sessionId, files) {
        await this.announceWork({
            workId,
            action: 'completed',
            sessionId,
            task: '',
            files,
        });
    }
    /**
     * Get known work from other machines.
     */
    getPeerWork(machineId) {
        if (machineId) {
            return this.peerWork.get(machineId) ?? [];
        }
        const all = [];
        for (const [, work] of this.peerWork) {
            all.push(...work);
        }
        return all;
    }
    // ── Status Queries ──────────────────────────────────────────────────
    /**
     * Query a specific machine's status.
     */
    async queryStatus(targetMachineId) {
        const reply = await this.bus.request({
            type: 'status-update',
            to: targetMachineId,
            payload: { queryType: 'active-work' },
            timeoutMs: this.statusQueryTimeoutMs,
        });
        return reply?.payload ?? null;
    }
    /**
     * Query all machines for file owners.
     */
    async queryFileOwners(files) {
        // Broadcast the query
        await this.bus.send({
            type: 'status-update',
            to: '*',
            payload: { queryType: 'file-owners', files },
        });
        // Collect responses (imperfect — relies on peer responses arriving before timeout)
        return new Promise((resolve) => {
            const responses = [];
            const timer = setTimeout(() => {
                this.bus.off('message', handler);
                resolve(responses);
            }, this.statusQueryTimeoutMs);
            const handler = (msg) => {
                if (msg.type === 'status-update' && msg.from !== this.machineId) {
                    const payload = msg.payload;
                    if (payload.machineId) {
                        responses.push(payload);
                    }
                }
            };
            this.bus.on('message', handler);
        });
    }
    // ── Leadership ──────────────────────────────────────────────────────
    /**
     * Attempt to claim the awake (leader) role.
     * Returns the new leadership state if successful.
     */
    claimLeadership() {
        const current = this.readLeadership();
        // Check if current leader's lease is still valid
        if (current && current.leaderId !== this.machineId) {
            const expiresAt = new Date(current.leaseExpiresAt).getTime();
            if (Date.now() < expiresAt) {
                return null; // Another machine holds a valid lease
            }
        }
        // Claim leadership
        const newToken = (current?.fencingToken ?? 0) + 1;
        const now = new Date();
        const state = {
            leaderId: this.machineId,
            fencingToken: newToken,
            role: 'awake',
            leaseExpiresAt: new Date(now.getTime() + this.leaseTtlMs).toISOString(),
            acquiredAt: now.toISOString(),
        };
        this.writeLeadership(state);
        return state;
    }
    /**
     * Renew the leadership lease (must already be leader).
     */
    renewLease() {
        const current = this.readLeadership();
        if (!current || current.leaderId !== this.machineId) {
            return null; // Not the leader
        }
        const now = new Date();
        current.leaseExpiresAt = new Date(now.getTime() + this.leaseTtlMs).toISOString();
        this.writeLeadership(current);
        return current;
    }
    /**
     * Relinquish leadership (transition to standby).
     */
    relinquishLeadership() {
        const current = this.readLeadership();
        if (current && current.leaderId === this.machineId) {
            current.role = 'standby';
            current.leaseExpiresAt = new Date().toISOString(); // Expire immediately
            this.writeLeadership(current);
        }
    }
    /**
     * Read current leadership state.
     */
    getLeadership() {
        return this.readLeadership();
    }
    /**
     * Check if this machine is the current leader.
     */
    isLeader() {
        const current = this.readLeadership();
        if (!current)
            return false;
        if (current.leaderId !== this.machineId)
            return false;
        return Date.now() < new Date(current.leaseExpiresAt).getTime();
    }
    /**
     * Check if the current leader's lease has expired.
     */
    isLeaseExpired() {
        const current = this.readLeadership();
        if (!current)
            return true;
        return Date.now() >= new Date(current.leaseExpiresAt).getTime();
    }
    // ── Accessors ───────────────────────────────────────────────────────
    getMachineId() {
        return this.machineId;
    }
    // ── Private: Message Handlers ───────────────────────────────────────
    registerHandlers() {
        // Handle file avoidance requests
        this.bus.onMessage('file-avoidance-request', (msg) => {
            // Record the avoidance
            this.avoidances.push({
                from: msg.from,
                files: msg.payload.files,
                expiresAt: Date.now() + msg.payload.durationMs,
                reason: msg.payload.reason,
            });
            // Invoke callback and possibly respond
            if (this.onAvoidanceRequest) {
                const response = this.onAvoidanceRequest(msg.payload, msg.from);
                // Send response if this was a directed request
                if (msg.to !== '*' && msg.replyTo === undefined) {
                    this.bus.send({
                        type: 'file-avoidance-response',
                        to: msg.from,
                        payload: response,
                        replyTo: msg.id,
                    });
                }
            }
        });
        // Handle file avoidance responses
        this.bus.onMessage('file-avoidance-response', (_msg) => {
            // Handled by request/response pattern in AgentBus
        });
        // Handle work announcements
        this.bus.onMessage('work-announcement', (msg) => {
            const announcement = msg.payload;
            const peerList = this.peerWork.get(msg.from) ?? [];
            if (announcement.action === 'started' || announcement.action === 'resumed') {
                // Add or update work entry
                const existingIdx = peerList.findIndex(w => w.workId === announcement.workId);
                if (existingIdx >= 0) {
                    peerList[existingIdx] = announcement;
                }
                else {
                    peerList.push(announcement);
                }
            }
            else if (announcement.action === 'completed' || announcement.action === 'abandoned') {
                // Remove work entry
                const idx = peerList.findIndex(w => w.workId === announcement.workId);
                if (idx >= 0)
                    peerList.splice(idx, 1);
            }
            else if (announcement.action === 'paused') {
                // Update status
                const existing = peerList.find(w => w.workId === announcement.workId);
                if (existing)
                    existing.action = 'paused';
            }
            this.peerWork.set(msg.from, peerList);
            if (this.onWorkAnnouncement) {
                this.onWorkAnnouncement(announcement, msg.from);
            }
        });
        // Handle status queries
        this.bus.onMessage('status-update', (msg) => {
            // Only respond to queries, not responses
            const payload = msg.payload;
            if (!payload.queryType)
                return;
            const ownWork = this.peerWork.get(this.machineId) ?? [];
            const response = {
                machineId: this.machineId,
                activeWork: ownWork,
                status: 'active',
            };
            // If file-specific query, filter work
            if (payload.queryType === 'file-owners' && payload.files) {
                const targetFiles = new Set(payload.files);
                response.activeWork = ownWork.filter(w => w.files.some(f => targetFiles.has(f)));
            }
            this.bus.send({
                type: 'status-update',
                to: msg.from,
                payload: response,
                replyTo: msg.id,
            });
        });
    }
    // ── Private: Avoidance Cleanup ──────────────────────────────────────
    cleanExpiredAvoidances() {
        const now = Date.now();
        this.avoidances = this.avoidances.filter(a => a.expiresAt > now);
    }
    // ── Private: Leadership State I/O ───────────────────────────────────
    readLeadership() {
        const filePath = path.join(this.coordDir, LEADERSHIP_FILE);
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(content);
        }
        catch {
            // @silent-fallback-ok — leadership file may not exist yet; null signals no leadership state
            return null;
        }
    }
    writeLeadership(state) {
        const filePath = path.join(this.coordDir, LEADERSHIP_FILE);
        fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n');
    }
}
//# sourceMappingURL=CoordinationProtocol.js.map