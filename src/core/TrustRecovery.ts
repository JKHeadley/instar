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
import type { TrustLevel } from './ExternalOperationGate.js';
import type { OperationMutability } from './ExternalOperationGate.js';
import { proofCovers, proposalHashOf, raiseRefusal, TrustRaiseRefusedError, type OperatorProof } from './TrustRaiseGuard.js';

// ── Types ────────────────────────────────────────────────────────────

export interface IncidentRecord {
  /** Unique incident ID */
  id: string;
  /** Service where the incident occurred */
  service: string;
  /** Operation type */
  operation: OperationMutability;
  /** Trust level before the incident */
  previousLevel: TrustLevel;
  /** Trust level after the incident (dropped to) */
  droppedToLevel: TrustLevel;
  /** When the incident occurred */
  incidentAt: string;
  /** Reason for the incident */
  reason: string;
  /** Whether recovery has been offered */
  recoveryOffered: boolean;
  /** Whether recovery was accepted (trust restored) */
  recovered: boolean;
  /** Whether the user dismissed the recovery suggestion */
  dismissed: boolean;
  /** Successful operations since this incident */
  successesSinceIncident: number;
}

export interface RecoverySuggestion {
  /** The incident that triggered this suggestion */
  incidentId: string;
  /** Service name */
  service: string;
  /** Operation type */
  operation: OperationMutability;
  /** What the trust was before the incident */
  previousLevel: TrustLevel;
  /** Current (dropped) level */
  currentLevel: TrustLevel;
  /** How many successes since the incident */
  successCount: number;
  /** Human-readable message for Telegram */
  message: string;
}

export interface TrustRecoveryConfig {
  /** State directory for persistence */
  stateDir: string;
  /** Consecutive successes needed before recovery suggestion (default: 10) */
  recoveryThreshold?: number;
}

// ── Implementation ───────────────────────────────────────────────────

export class TrustRecovery {
  private config: TrustRecoveryConfig;
  private incidentsPath: string;
  private incidents: IncidentRecord[];
  private threshold: number;

  constructor(config: TrustRecoveryConfig) {
    this.config = config;
    this.incidentsPath = path.join(config.stateDir, 'state', 'trust-incidents.json');
    this.threshold = config.recoveryThreshold ?? 10;
    this.incidents = this.load();
  }

  /**
   * Record a new trust incident (called when AdaptiveTrust drops trust).
   */
  recordIncident(
    service: string,
    operation: OperationMutability,
    previousLevel: TrustLevel,
    droppedToLevel: TrustLevel,
    reason: string,
  ): IncidentRecord {
    const incident: IncidentRecord = {
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
  recordSuccess(
    service: string,
    operation: OperationMutability,
  ): RecoverySuggestion | null {
    let suggestion: RecoverySuggestion | null = null;

    for (const incident of this.incidents) {
      if (
        incident.service === service &&
        incident.operation === operation &&
        !incident.recovered &&
        !incident.dismissed &&
        !incident.recoveryOffered
      ) {
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
  acceptRecovery(incidentId: string, proof?: OperatorProof | null): IncidentRecord | null {
    const incident = this.incidents.find(i => i.id === incidentId);
    if (!incident || incident.recovered) return null;
    // Recovering after an incident is a raise (trust-journey decision 4): it needs the person's
    // proof for this exact incident.
    if (!proofCovers(proof, proposalHashOf({ kind: 'trust-recovery', incidentId }))) {
      throw new TrustRaiseRefusedError(raiseRefusal([`recovering trust after incident ${incidentId}`]));
    }

    incident.recovered = true;
    this.save();
    return incident;
  }

  /**
   * Dismiss a recovery suggestion — won't be suggested again.
   */
  dismissRecovery(incidentId: string): IncidentRecord | null {
    const incident = this.incidents.find(i => i.id === incidentId);
    if (!incident || incident.dismissed) return null;

    incident.dismissed = true;
    this.save();
    return incident;
  }

  /**
   * Get all active incidents (not recovered, not dismissed).
   */
  getActiveIncidents(): IncidentRecord[] {
    return this.incidents.filter(i => !i.recovered && !i.dismissed);
  }

  /**
   * Get all pending recovery suggestions.
   */
  getPendingRecoveries(): RecoverySuggestion[] {
    return this.incidents
      .filter(i => i.recoveryOffered && !i.recovered && !i.dismissed)
      .map(i => this.buildSuggestion(i));
  }

  /**
   * Get a specific incident by ID.
   */
  getIncident(id: string): IncidentRecord | null {
    return this.incidents.find(i => i.id === id) ?? null;
  }

  /**
   * Get all incidents for a service.
   */
  getServiceIncidents(service: string): IncidentRecord[] {
    return this.incidents.filter(i => i.service === service);
  }

  /**
   * Get a human-readable summary of the recovery state.
   */
  getSummary(): string {
    const active = this.getActiveIncidents();
    const pending = this.getPendingRecoveries();

    if (active.length === 0) {
      return 'No active trust incidents.';
    }

    const lines: string[] = [];
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

  private buildSuggestion(incident: IncidentRecord): RecoverySuggestion {
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

  private load(): IncidentRecord[] {
    if (!fs.existsSync(this.incidentsPath)) return [];

    try {
      const data = fs.readFileSync(this.incidentsPath, 'utf-8');
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // @silent-fallback-ok — fresh start on corrupt file
      return [];
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.incidentsPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.incidentsPath, JSON.stringify(this.incidents, null, 2) + '\n');
    } catch {
      // @silent-fallback-ok — recovery tracking is non-critical
    }
  }
}
