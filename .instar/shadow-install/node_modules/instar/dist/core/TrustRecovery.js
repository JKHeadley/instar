/**
 * TrustRecovery — clear recovery path after trust incidents.
 *
 * Part of Phase 4 of the Adaptive Autonomy System (Improvement 10).
 *
 * After an incident drops trust, the system tracks a recovery streak.
 * After N successful operations post-incident (configurable, default: 10),
 * the agent surfaces a recovery message suggesting restoration of
 * the previous trust level.
 *
 * The recovery path is transparent: the agent tells the user exactly
 * what happened, what the track record is since, and what it suggests.
 */
import fs from 'node:fs';
import path from 'node:path';
// ── Implementation ───────────────────────────────────────────────────
export class TrustRecovery {
    config;
    incidentsPath;
    incidents;
    threshold;
    constructor(config) {
        this.config = config;
        this.incidentsPath = path.join(config.stateDir, 'state', 'trust-incidents.json');
        this.threshold = config.recoveryThreshold ?? 10;
        this.incidents = this.load();
    }
    /**
     * Record a new trust incident (called when AdaptiveTrust drops trust).
     */
    recordIncident(service, operation, previousLevel, droppedToLevel, reason) {
        const incident = {
            id: `INC-${Date.now().toString(36)}`,
            service,
            operation,
            previousLevel,
            droppedToLevel,
            incidentAt: new Date().toISOString(),
            reason,
            recoveryOffered: false,
            recovered: false,
            dismissed: false,
            successesSinceIncident: 0,
        };
        this.incidents.push(incident);
        this.save();
        return incident;
    }
    /**
     * Record a successful operation for a service — increments recovery counters.
     * Returns a recovery suggestion if the threshold is met.
     */
    recordSuccess(service, operation) {
        let suggestion = null;
        for (const incident of this.incidents) {
            if (incident.service === service &&
                incident.operation === operation &&
                !incident.recovered &&
                !incident.dismissed &&
                !incident.recoveryOffered) {
                incident.successesSinceIncident++;
                if (incident.successesSinceIncident >= this.threshold) {
                    incident.recoveryOffered = true;
                    suggestion = this.buildSuggestion(incident);
                }
            }
        }
        if (suggestion) {
            this.save();
        }
        return suggestion;
    }
    /**
     * Accept a recovery suggestion — mark the incident as recovered.
     */
    acceptRecovery(incidentId) {
        const incident = this.incidents.find(i => i.id === incidentId);
        if (!incident || incident.recovered)
            return null;
        incident.recovered = true;
        this.save();
        return incident;
    }
    /**
     * Dismiss a recovery suggestion — won't be suggested again.
     */
    dismissRecovery(incidentId) {
        const incident = this.incidents.find(i => i.id === incidentId);
        if (!incident || incident.dismissed)
            return null;
        incident.dismissed = true;
        this.save();
        return incident;
    }
    /**
     * Get all active incidents (not recovered, not dismissed).
     */
    getActiveIncidents() {
        return this.incidents.filter(i => !i.recovered && !i.dismissed);
    }
    /**
     * Get all pending recovery suggestions.
     */
    getPendingRecoveries() {
        return this.incidents
            .filter(i => i.recoveryOffered && !i.recovered && !i.dismissed)
            .map(i => this.buildSuggestion(i));
    }
    /**
     * Get a specific incident by ID.
     */
    getIncident(id) {
        return this.incidents.find(i => i.id === id) ?? null;
    }
    /**
     * Get all incidents for a service.
     */
    getServiceIncidents(service) {
        return this.incidents.filter(i => i.service === service);
    }
    /**
     * Get a human-readable summary of the recovery state.
     */
    getSummary() {
        const active = this.getActiveIncidents();
        const pending = this.getPendingRecoveries();
        if (active.length === 0) {
            return 'No active trust incidents.';
        }
        const lines = [];
        lines.push(`${active.length} active trust incident${active.length > 1 ? 's' : ''}:`);
        for (const incident of active) {
            const progress = `${incident.successesSinceIncident}/${this.threshold}`;
            const status = incident.recoveryOffered ? 'recovery available' : `recovery progress: ${progress}`;
            lines.push(`  ${incident.service}.${incident.operation}: ${incident.droppedToLevel} (was ${incident.previousLevel}) — ${status}`);
        }
        if (pending.length > 0) {
            lines.push('');
            lines.push(`${pending.length} pending recovery suggestion${pending.length > 1 ? 's' : ''}.`);
        }
        return lines.join('\n');
    }
    // ── Private ─────────────────────────────────────────────────────────
    buildSuggestion(incident) {
        const incidentDate = new Date(incident.incidentAt).toLocaleDateString();
        return {
            incidentId: incident.id,
            service: incident.service,
            operation: incident.operation,
            previousLevel: incident.previousLevel,
            currentLevel: incident.droppedToLevel,
            successCount: incident.successesSinceIncident,
            message: [
                '🔄 Trust Recovery',
                '',
                `My ${incident.service} ${incident.operation} trust was dropped after the incident on ${incidentDate}.`,
                `Since then I've had ${incident.successesSinceIncident} consecutive successful operations with no issues.`,
                '',
                `I was previously at ${incident.previousLevel} (earned). I'm currently at ${incident.droppedToLevel}.`,
                `I'm eligible to restore my previous trust level.`,
                '',
                `Want me to go back to ${incident.previousLevel}, or keep the current setting?`,
            ].join('\n'),
        };
    }
    load() {
        if (!fs.existsSync(this.incidentsPath))
            return [];
        try {
            const data = fs.readFileSync(this.incidentsPath, 'utf-8');
            const parsed = JSON.parse(data);
            return Array.isArray(parsed) ? parsed : [];
        }
        catch {
            // @silent-fallback-ok — fresh start on corrupt file
            return [];
        }
    }
    save() {
        try {
            const dir = path.dirname(this.incidentsPath);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.incidentsPath, JSON.stringify(this.incidents, null, 2) + '\n');
        }
        catch {
            // @silent-fallback-ok — recovery tracking is non-critical
        }
    }
}
//# sourceMappingURL=TrustRecovery.js.map