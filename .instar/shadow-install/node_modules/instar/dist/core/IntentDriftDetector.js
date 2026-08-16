/**
 * IntentDriftDetector — Analyzes decision journal trends to detect alignment drift.
 *
 * Compares two time windows of decision journal data to identify signals
 * that an agent's behavior is drifting from its stated intent. All computation
 * is deterministic — no LLM calls.
 *
 * Drift signals:
 * - Conflict spike: conflict rate increasing between windows
 * - Confidence drop: average confidence decreasing
 * - Principle shift: top principles changing between windows
 * - Volume change: significant change in decision count
 *
 * Also computes an AlignmentScore (0-100) from journal health metrics.
 */
import { DecisionJournal } from './DecisionJournal.js';
// ── Implementation ──────────────────────────────────────────────────
export class IntentDriftDetector {
    stateDir;
    journal;
    constructor(stateDir) {
        this.stateDir = stateDir;
        this.journal = new DecisionJournal(stateDir);
    }
    /**
     * Analyze recent decisions for drift signals.
     * Compares the last `windowDays` to the preceding `windowDays`.
     */
    analyze(windowDays = 14) {
        const now = Date.now();
        const msPerDay = 24 * 60 * 60 * 1000;
        // Current window: last windowDays
        const currentCutoff = new Date(now - windowDays * msPerDay);
        // Previous window: windowDays before that
        const previousCutoff = new Date(now - 2 * windowDays * msPerDay);
        const allEntries = this.journal.read();
        const currentEntries = allEntries.filter(e => new Date(e.timestamp) >= currentCutoff);
        const previousEntries = allEntries.filter(e => new Date(e.timestamp) >= previousCutoff && new Date(e.timestamp) < currentCutoff);
        const current = this.buildWindow(currentEntries, currentCutoff.toISOString(), new Date(now).toISOString());
        const hasPrevious = previousEntries.length > 0;
        const previous = hasPrevious
            ? this.buildWindow(previousEntries, previousCutoff.toISOString(), currentCutoff.toISOString())
            : null;
        const signals = previous ? this.detectSignals(current, previous) : [];
        const driftScore = this.computeDriftScore(signals);
        const summary = this.buildSummary(current, previous, signals, driftScore);
        return { current, previous, signals, driftScore, summary };
    }
    /**
     * Compute alignment score from decision journal data.
     * Score 0-100 based on: conflict rate, confidence levels, principle consistency.
     */
    alignmentScore(periodDays = 30) {
        const entries = this.journal.read({ days: periodDays });
        if (entries.length === 0) {
            return {
                score: 0,
                components: {
                    conflictFreedom: 0,
                    confidenceLevel: 0,
                    principleConsistency: 0,
                    journalHealth: 0,
                },
                sampleSize: 0,
                periodDays,
                grade: 'F',
                summary: 'No decisions logged — alignment cannot be assessed.',
            };
        }
        const conflictFreedom = this.computeConflictFreedom(entries);
        const confidenceLevel = this.computeConfidenceLevel(entries);
        const principleConsistency = this.computePrincipleConsistency(entries);
        const journalHealth = this.computeJournalHealth(entries, periodDays);
        // Weighted average: conflictFreedom(30%) + confidenceLevel(25%) + principleConsistency(25%) + journalHealth(20%)
        const score = Math.round(conflictFreedom * 0.30 +
            confidenceLevel * 0.25 +
            principleConsistency * 0.25 +
            journalHealth * 0.20);
        const grade = this.scoreToGrade(score);
        const summary = this.buildAlignmentSummary(score, grade, entries.length, periodDays);
        return {
            score,
            components: {
                conflictFreedom: Math.round(conflictFreedom),
                confidenceLevel: Math.round(confidenceLevel),
                principleConsistency: Math.round(principleConsistency),
                journalHealth: Math.round(journalHealth),
            },
            sampleSize: entries.length,
            periodDays,
            grade,
            summary,
        };
    }
    // ── Private helpers ─────────────────────────────────────────────────
    buildWindow(entries, from, to) {
        const decisionCount = entries.length;
        const conflictCount = entries.filter(e => e.conflict).length;
        const conflictRate = decisionCount > 0 ? conflictCount / decisionCount : 0;
        // Top principles
        const principleCounts = {};
        for (const entry of entries) {
            if (entry.principle) {
                principleCounts[entry.principle] = (principleCounts[entry.principle] || 0) + 1;
            }
        }
        const topPrinciples = Object.entries(principleCounts)
            .map(([principle, count]) => ({ principle, count }))
            .sort((a, b) => b.count - a.count);
        // Average confidence (only from entries that have confidence)
        const confidenceEntries = entries.filter(e => e.confidence !== undefined);
        const avgConfidence = confidenceEntries.length > 0
            ? confidenceEntries.reduce((sum, e) => sum + (e.confidence ?? 0), 0) / confidenceEntries.length
            : 0;
        return { from, to, decisionCount, conflictRate, topPrinciples, avgConfidence };
    }
    detectSignals(current, previous) {
        const signals = [];
        // 1. Conflict spike
        if (previous.conflictRate > 0) {
            const ratio = current.conflictRate / previous.conflictRate;
            if (ratio > 3) {
                signals.push({
                    type: 'conflict_spike',
                    severity: 'alert',
                    description: `Conflict rate surged ${ratio.toFixed(1)}x from previous period (${(previous.conflictRate * 100).toFixed(1)}% -> ${(current.conflictRate * 100).toFixed(1)}%)`,
                    delta: current.conflictRate - previous.conflictRate,
                });
            }
            else if (ratio > 2) {
                signals.push({
                    type: 'conflict_spike',
                    severity: 'warning',
                    description: `Conflict rate increased ${ratio.toFixed(1)}x from previous period (${(previous.conflictRate * 100).toFixed(1)}% -> ${(current.conflictRate * 100).toFixed(1)}%)`,
                    delta: current.conflictRate - previous.conflictRate,
                });
            }
        }
        else if (current.conflictRate > 0) {
            // Previous had zero conflicts, current has some — treat as a spike
            signals.push({
                type: 'conflict_spike',
                severity: 'warning',
                description: `Conflicts appeared where none existed before (0% -> ${(current.conflictRate * 100).toFixed(1)}%)`,
                delta: current.conflictRate,
            });
        }
        // 2. Confidence drop
        if (previous.avgConfidence > 0) {
            const drop = previous.avgConfidence - current.avgConfidence;
            if (drop > 0.25) {
                signals.push({
                    type: 'confidence_drop',
                    severity: 'alert',
                    description: `Average confidence dropped by ${drop.toFixed(2)} (${previous.avgConfidence.toFixed(2)} -> ${current.avgConfidence.toFixed(2)})`,
                    delta: -drop,
                });
            }
            else if (drop > 0.15) {
                signals.push({
                    type: 'confidence_drop',
                    severity: 'warning',
                    description: `Average confidence dropped by ${drop.toFixed(2)} (${previous.avgConfidence.toFixed(2)} -> ${current.avgConfidence.toFixed(2)})`,
                    delta: -drop,
                });
            }
        }
        // 3. Principle shift
        const prevTop3 = previous.topPrinciples.slice(0, 3).map(p => p.principle);
        const currTop3 = current.topPrinciples.slice(0, 3).map(p => p.principle);
        if (prevTop3.length > 0 && currTop3.length > 0) {
            const shifted = prevTop3.filter(p => !currTop3.includes(p));
            if (shifted.length >= 2) {
                signals.push({
                    type: 'principle_shift',
                    severity: 'warning',
                    description: `${shifted.length} of top 3 principles changed between periods`,
                    delta: shifted.length,
                });
            }
            else if (prevTop3[0] !== currTop3[0] && prevTop3.length > 0 && currTop3.length > 0) {
                signals.push({
                    type: 'principle_shift',
                    severity: 'info',
                    description: `Top principle changed from "${prevTop3[0]}" to "${currTop3[0]}"`,
                    delta: 1,
                });
            }
        }
        // 4. Volume change
        if (previous.decisionCount > 0) {
            const ratio = current.decisionCount / previous.decisionCount;
            if (ratio < 0.5) {
                signals.push({
                    type: 'volume_change',
                    severity: 'warning',
                    description: `Decision volume dropped ${Math.round((1 - ratio) * 100)}% (${previous.decisionCount} -> ${current.decisionCount})`,
                    delta: ratio - 1,
                });
            }
            else if (ratio > 3) {
                signals.push({
                    type: 'volume_change',
                    severity: 'info',
                    description: `Decision volume increased ${ratio.toFixed(1)}x (${previous.decisionCount} -> ${current.decisionCount})`,
                    delta: ratio - 1,
                });
            }
        }
        return signals;
    }
    computeDriftScore(signals) {
        if (signals.length === 0)
            return 0;
        const weights = {
            info: 0.1,
            warning: 0.3,
            alert: 0.5,
        };
        const total = signals.reduce((sum, s) => sum + weights[s.severity], 0);
        // Cap at 1.0
        return Math.min(1, Math.round(total * 100) / 100);
    }
    buildSummary(current, previous, signals, driftScore) {
        if (current.decisionCount === 0) {
            return 'No decisions in the current window — nothing to analyze.';
        }
        if (!previous) {
            return `${current.decisionCount} decisions in current window, but no previous period for comparison.`;
        }
        if (signals.length === 0) {
            return `Stable: ${current.decisionCount} decisions with no drift signals detected.`;
        }
        const alertCount = signals.filter(s => s.severity === 'alert').length;
        const warningCount = signals.filter(s => s.severity === 'warning').length;
        const level = driftScore > 0.6 ? 'significant' : driftScore > 0.3 ? 'moderate' : 'mild';
        const parts = [`${signals.length} drift signal(s) detected (${level} drift).`];
        if (alertCount > 0)
            parts.push(`${alertCount} alert(s) require attention.`);
        if (warningCount > 0)
            parts.push(`${warningCount} warning(s) noted.`);
        return parts.join(' ');
    }
    // ── Alignment score components ──────────────────────────────────────
    computeConflictFreedom(entries) {
        const conflictCount = entries.filter(e => e.conflict).length;
        const conflictRate = conflictCount / entries.length;
        return (1 - conflictRate) * 100;
    }
    computeConfidenceLevel(entries) {
        const withConfidence = entries.filter(e => e.confidence !== undefined);
        if (withConfidence.length === 0)
            return 50; // neutral default
        const avg = withConfidence.reduce((sum, e) => sum + (e.confidence ?? 0), 0) / withConfidence.length;
        return avg * 100;
    }
    computePrincipleConsistency(entries) {
        const withPrinciple = entries.filter(e => e.principle);
        if (withPrinciple.length === 0)
            return 50; // neutral default
        // Count principle frequencies
        const counts = {};
        for (const entry of withPrinciple) {
            counts[entry.principle] = (counts[entry.principle] || 0) + 1;
        }
        const values = Object.values(counts);
        const total = values.reduce((a, b) => a + b, 0);
        if (values.length <= 1)
            return 100; // Single principle = maximum consistency
        // Shannon entropy
        const maxEntropy = Math.log2(values.length);
        if (maxEntropy === 0)
            return 100;
        let entropy = 0;
        for (const count of values) {
            const p = count / total;
            if (p > 0) {
                entropy -= p * Math.log2(p);
            }
        }
        const normalizedEntropy = entropy / maxEntropy;
        return (1 - normalizedEntropy) * 100;
    }
    computeJournalHealth(entries, periodDays) {
        if (entries.length === 0)
            return 0;
        // Count unique days with entries
        const uniqueDays = new Set(entries.map(e => e.timestamp.slice(0, 10)));
        const activeDays = uniqueDays.size;
        // Rate: active days / total days
        const rate = activeDays / periodDays;
        // Scale: daily (>0.8) = 100, weekly-ish (>0.2) = 70, sporadic (>0.05) = 30, almost none = 0
        if (rate >= 0.8)
            return 100;
        if (rate >= 0.2)
            return 70;
        if (rate >= 0.05)
            return 30;
        return Math.max(0, Math.round(rate * 600)); // linear scale below 0.05
    }
    scoreToGrade(score) {
        if (score >= 85)
            return 'A';
        if (score >= 70)
            return 'B';
        if (score >= 55)
            return 'C';
        if (score >= 40)
            return 'D';
        return 'F';
    }
    buildAlignmentSummary(score, grade, sampleSize, periodDays) {
        if (sampleSize === 0)
            return 'No decisions logged — alignment cannot be assessed.';
        const gradeDescriptions = {
            A: 'Strong alignment — decisions consistently reflect stated intent.',
            B: 'Good alignment — minor areas for improvement.',
            C: 'Moderate alignment — some drift from stated intent.',
            D: 'Weak alignment — significant drift detected.',
            F: 'Poor alignment — decisions are not tracking intent.',
        };
        return `${gradeDescriptions[grade]} (${sampleSize} decisions over ${periodDays} days)`;
    }
}
//# sourceMappingURL=IntentDriftDetector.js.map