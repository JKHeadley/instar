/**
 * PatternAnalyzer — Cross-execution pattern detection for Living Skills (PROP-229).
 *
 * Reads execution journals across runs and detects:
 * - Consistent additions: steps appearing in ≥60% of runs but not in definition
 * - Consistent omissions: defined steps skipped in ≥50% of runs
 * - Novel additions: steps appearing for the first time
 * - Duration drift: execution time trending significantly up/down
 * - Gate effectiveness: whether gate commands consistently pass or fail
 *
 * Outputs a PatternReport with scored findings and optional EvolutionManager proposals.
 */

import type {
  ExecutionRecord,
  ExecutionDeviation,
  EvolutionType,
} from './types.js';
import { ExecutionJournal } from './ExecutionJournal.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type PatternType =
  | 'consistent-addition'
  | 'consistent-omission'
  | 'novel-addition'
  | 'duration-drift'
  | 'gate-ineffective';

export type PatternConfidence = 'high' | 'medium' | 'low';

export interface DetectedPattern {
  /** What kind of pattern */
  type: PatternType;
  /** Human-readable description */
  description: string;
  /** How confident we are (based on sample size and consistency) */
  confidence: PatternConfidence;
  /** The step name involved (null for duration-drift) */
  step: string | null;
  /** How many runs showed this pattern */
  occurrences: number;
  /** Total runs in the analysis window */
  totalRuns: number;
  /** Occurrence rate (0–1) */
  rate: number;
  /** Suggested action */
  suggestion: string;
  /** Data supporting this pattern (e.g., duration values) */
  evidence?: Record<string, unknown>;
}

export interface PatternReport {
  /** Job slug analyzed */
  jobSlug: string;
  /** Agent ID */
  agentId: string;
  /** How many execution records were analyzed */
  runsAnalyzed: number;
  /** Time window (days) */
  days: number;
  /** Detected patterns, sorted by confidence then rate */
  patterns: DetectedPattern[];
  /** Summary statistics */
  summary: {
    /** Total unique steps seen across all runs */
    uniqueSteps: number;
    /** Defined steps in the job */
    definedSteps: number;
    /** Average duration across runs (null if no data) */
    avgDurationMinutes: number | null;
    /** Duration trend: 'increasing', 'decreasing', 'stable', 'insufficient-data' */
    durationTrend: 'increasing' | 'decreasing' | 'stable' | 'insufficient-data';
    /** Overall success rate, or null when there are no runs */
    successRate: number | null;
  };
  /** ISO timestamp when this analysis was generated */
  analyzedAt: string;
}

export interface PatternAnalyzerOptions {
  /** Minimum runs required for pattern detection (default: 3) */
  minRuns?: number;
  /** Threshold for consistent additions (default: 0.6 = 60%) */
  additionThreshold?: number;
  /** Threshold for consistent omissions (default: 0.5 = 50%) */
  omissionThreshold?: number;
  /** Duration drift multiplier (default: 2.0 = 2x expected) */
  durationDriftMultiplier?: number;
  /** Days to analyze (default: 30) */
  days?: number;
  /** Agent ID (default: 'default') */
  agentId?: string;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_MIN_RUNS = 3;
const DEFAULT_ADDITION_THRESHOLD = 0.6;
const DEFAULT_OMISSION_THRESHOLD = 0.5;
const DEFAULT_DRIFT_MULTIPLIER = 2.0;
const DEFAULT_DAYS = 30;
const DEFAULT_AGENT_ID = 'default';

// ─── Analyzer ────────────────────────────────────────────────────────────────

export class PatternAnalyzer {
  private journal: ExecutionJournal;

  constructor(journal: ExecutionJournal) {
    this.journal = journal;
  }

  /**
   * Analyze execution records for a job and detect patterns.
   */
  analyze(jobSlug: string, opts?: PatternAnalyzerOptions): PatternReport {
    const minRuns = opts?.minRuns ?? DEFAULT_MIN_RUNS;
    const additionThreshold = opts?.additionThreshold ?? DEFAULT_ADDITION_THRESHOLD;
    const omissionThreshold = opts?.omissionThreshold ?? DEFAULT_OMISSION_THRESHOLD;
    const driftMultiplier = opts?.durationDriftMultiplier ?? DEFAULT_DRIFT_MULTIPLIER;
    const days = opts?.days ?? DEFAULT_DAYS;
    const agentId = opts?.agentId ?? DEFAULT_AGENT_ID;

    const records = this.journal.read(jobSlug, { agentId, days });
    const patterns: DetectedPattern[] = [];

    // Collect all unique step names and defined steps across runs
    const stepOccurrences = new Map<string, number>();
    const definedStepSet = new Set<string>();
    const allUniqueSteps = new Set<string>();

    for (const record of records) {
      // Track defined steps (union across all runs — definitions may evolve)
      for (const ds of record.definedSteps) {
        definedStepSet.add(ds);
      }
      // Track actual step occurrences
      for (const step of record.actualSteps) {
        allUniqueSteps.add(step.step);
        stepOccurrences.set(step.step, (stepOccurrences.get(step.step) || 0) + 1);
      }
    }

    const totalRuns = records.length;

    if (totalRuns >= minRuns) {
      // Detect consistent additions
      patterns.push(...this.detectConsistentAdditions(
        stepOccurrences, definedStepSet, totalRuns, additionThreshold,
      ));

      // Detect consistent omissions
      patterns.push(...this.detectConsistentOmissions(
        records, definedStepSet, totalRuns, omissionThreshold,
      ));

      // Detect duration drift
      const durationPattern = this.detectDurationDrift(records, driftMultiplier);
      if (durationPattern) patterns.push(durationPattern);

      // Detect gate ineffectiveness
      const gatePattern = this.detectGateIneffective(records);
      if (gatePattern) patterns.push(gatePattern);
    }

    // Always detect novel additions (even with fewer runs)
    if (totalRuns >= 1) {
      patterns.push(...this.detectNovelAdditions(records, definedStepSet));
    }

    // Sort: high confidence first, then by rate descending
    const confidenceOrder: Record<PatternConfidence, number> = { high: 0, medium: 1, low: 2 };
    patterns.sort((a, b) => {
      const cDiff = confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
      if (cDiff !== 0) return cDiff;
      return b.rate - a.rate;
    });

    // Compute summary
    const durations = records
      .map(r => r.durationMinutes)
      .filter((d): d is number => d != null);
    const avgDuration = durations.length > 0
      ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10
      : null;

    return {
      jobSlug,
      agentId,
      runsAnalyzed: totalRuns,
      days,
      patterns,
      summary: {
        uniqueSteps: allUniqueSteps.size,
        definedSteps: definedStepSet.size,
        avgDurationMinutes: avgDuration,
        durationTrend: this.computeDurationTrend(records),
        successRate: totalRuns > 0
          ? Math.round((records.filter(r => r.outcome === 'success').length / totalRuns) * 100) / 100
          : null,
      },
      analyzedAt: new Date().toISOString(),
    };
  }

  /**
   * Analyze all jobs and return reports.
   */
  analyzeAll(opts?: PatternAnalyzerOptions): PatternReport[] {
    const agentId = opts?.agentId ?? DEFAULT_AGENT_ID;
    const jobs = this.journal.listJobs(agentId);
    return jobs.map(slug => this.analyze(slug, opts));
  }

  /**
   * Generate evolution proposals from a pattern report.
   * Returns proposal-ready objects (caller is responsible for submitting to EvolutionManager).
   */
  toProposals(report: PatternReport): Array<{
    title: string;
    source: string;
    description: string;
    type: EvolutionType;
    impact: 'high' | 'medium' | 'low';
    effort: 'high' | 'medium' | 'low';
    proposedBy: string;
    tags: string[];
  }> {
    const proposals: Array<{
      title: string;
      source: string;
      description: string;
      type: EvolutionType;
      impact: 'high' | 'medium' | 'low';
      effort: 'high' | 'medium' | 'low';
      proposedBy: string;
      tags: string[];
    }> = [];

    for (const pattern of report.patterns) {
      // Only generate proposals for high/medium confidence patterns
      if (pattern.confidence === 'low') continue;

      const proposal = this.patternToProposal(report.jobSlug, pattern);
      if (proposal) proposals.push(proposal);
    }

    return proposals;
  }

  // ─── Private: Pattern Detection ──────────────────────────────────────────

  /**
   * Steps appearing in ≥threshold of runs but not in the job definition.
   */
  private detectConsistentAdditions(
    stepOccurrences: Map<string, number>,
    definedSteps: Set<string>,
    totalRuns: number,
    threshold: number,
  ): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];

    for (const [step, count] of stepOccurrences) {
      if (definedSteps.has(step)) continue;
      const rate = count / totalRuns;
      if (rate >= threshold) {
        patterns.push({
          type: 'consistent-addition',
          description: `Step "${step}" appears in ${count}/${totalRuns} runs (${Math.round(rate * 100)}%) but is not in the job definition`,
          confidence: rate >= 0.8 ? 'high' : 'medium',
          step,
          occurrences: count,
          totalRuns,
          rate,
          suggestion: `Consider adding "${step}" to the job's definedSteps`,
        });
      }
    }

    return patterns;
  }

  /**
   * Defined steps that are skipped in ≥threshold of runs.
   */
  private detectConsistentOmissions(
    records: ExecutionRecord[],
    definedSteps: Set<string>,
    totalRuns: number,
    threshold: number,
  ): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];

    // Count how many times each defined step is actually executed
    const executedCounts = new Map<string, number>();
    for (const ds of definedSteps) {
      executedCounts.set(ds, 0);
    }

    for (const record of records) {
      const actualStepNames = new Set(record.actualSteps.map(s => s.step));
      for (const ds of definedSteps) {
        if (actualStepNames.has(ds)) {
          executedCounts.set(ds, (executedCounts.get(ds) || 0) + 1);
        }
      }
    }

    for (const [step, executedCount] of executedCounts) {
      const omittedCount = totalRuns - executedCount;
      const omissionRate = omittedCount / totalRuns;
      if (omissionRate >= threshold) {
        patterns.push({
          type: 'consistent-omission',
          description: `Defined step "${step}" was skipped in ${omittedCount}/${totalRuns} runs (${Math.round(omissionRate * 100)}%)`,
          confidence: omissionRate >= 0.8 ? 'high' : 'medium',
          step,
          occurrences: omittedCount,
          totalRuns,
          rate: omissionRate,
          suggestion: `Consider removing "${step}" from the job's definedSteps — it may no longer be relevant`,
        });
      }
    }

    return patterns;
  }

  /**
   * Steps appearing for the first time (only in the most recent run).
   */
  private detectNovelAdditions(
    records: ExecutionRecord[],
    definedSteps: Set<string>,
  ): DetectedPattern[] {
    if (records.length === 0) return [];

    const patterns: DetectedPattern[] = [];
    // records are newest-first from journal.read()
    const latestRun = records[0];
    const olderRuns = records.slice(1);

    // Collect all steps from older runs
    const previousSteps = new Set<string>();
    for (const record of olderRuns) {
      for (const step of record.actualSteps) {
        previousSteps.add(step.step);
      }
    }

    // Check latest run for novel steps
    for (const step of latestRun.actualSteps) {
      if (!previousSteps.has(step.step) && !definedSteps.has(step.step)) {
        // First time seeing this step AND it's not in definition
        patterns.push({
          type: 'novel-addition',
          description: `New step "${step.step}" appeared for the first time in the latest run`,
          confidence: 'low',
          step: step.step,
          occurrences: 1,
          totalRuns: records.length,
          rate: 1 / records.length,
          suggestion: `Monitor "${step.step}" — if it recurs, it may become a consistent addition`,
        });
      }
    }

    return patterns;
  }

  /**
   * Duration trending significantly above historical average.
   * Uses linear regression on the last N runs to detect trend direction.
   */
  private detectDurationDrift(
    records: ExecutionRecord[],
    driftMultiplier: number,
  ): DetectedPattern | null {
    const durations = records
      .filter(r => r.durationMinutes != null)
      .map(r => ({ timestamp: r.timestamp, duration: r.durationMinutes! }));

    if (durations.length < 3) return null;

    // Sort oldest to newest for trend analysis
    durations.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const avg = durations.reduce((s, d) => s + d.duration, 0) / durations.length;

    // Compare first half average to second half average
    const mid = Math.floor(durations.length / 2);
    const firstHalf = durations.slice(0, mid);
    const secondHalf = durations.slice(mid);

    const firstAvg = firstHalf.reduce((s, d) => s + d.duration, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((s, d) => s + d.duration, 0) / secondHalf.length;

    // Check if the second half is significantly different from first half
    if (firstAvg === 0) return null;

    const ratio = secondAvg / firstAvg;

    if (ratio >= driftMultiplier) {
      return {
        type: 'duration-drift',
        description: `Duration trending up: recent average ${Math.round(secondAvg * 10) / 10}min vs earlier ${Math.round(firstAvg * 10) / 10}min (${Math.round(ratio * 10) / 10}x increase)`,
        confidence: ratio >= 3 ? 'high' : 'medium',
        step: null,
        occurrences: secondHalf.length,
        totalRuns: durations.length,
        rate: ratio,
        suggestion: 'Investigate why execution time is increasing — may indicate scope creep or environmental issues',
        evidence: {
          firstHalfAvg: Math.round(firstAvg * 10) / 10,
          secondHalfAvg: Math.round(secondAvg * 10) / 10,
          ratio: Math.round(ratio * 10) / 10,
          overallAvg: Math.round(avg * 10) / 10,
        },
      };
    }

    if (ratio <= 1 / driftMultiplier) {
      return {
        type: 'duration-drift',
        description: `Duration trending down: recent average ${Math.round(secondAvg * 10) / 10}min vs earlier ${Math.round(firstAvg * 10) / 10}min (${Math.round((1 / ratio) * 10) / 10}x decrease)`,
        confidence: 'medium',
        step: null,
        occurrences: secondHalf.length,
        totalRuns: durations.length,
        rate: ratio,
        suggestion: 'Duration has decreased significantly — the job may have become more efficient or may be skipping steps',
        evidence: {
          firstHalfAvg: Math.round(firstAvg * 10) / 10,
          secondHalfAvg: Math.round(secondAvg * 10) / 10,
          ratio: Math.round(ratio * 10) / 10,
          overallAvg: Math.round(avg * 10) / 10,
        },
      };
    }

    return null;
  }

  /**
   * Detect if gate commands are consistently finding nothing to do.
   * If a job consistently runs but has 0 actual steps, the gate may be ineffective.
   */
  private detectGateIneffective(records: ExecutionRecord[]): DetectedPattern | null {
    const emptyRuns = records.filter(r => r.actualSteps.length === 0);
    if (emptyRuns.length === 0) return null;

    const rate = emptyRuns.length / records.length;
    if (rate >= 0.5) {
      return {
        type: 'gate-ineffective',
        description: `${emptyRuns.length}/${records.length} runs (${Math.round(rate * 100)}%) completed with zero steps — the gate may not be filtering effectively`,
        confidence: rate >= 0.8 ? 'high' : 'medium',
        step: null,
        occurrences: emptyRuns.length,
        totalRuns: records.length,
        rate,
        suggestion: 'Review the job\'s gate command — it may be passing too easily, causing unnecessary executions',
      };
    }

    return null;
  }

  // ─── Private: Duration Trend ─────────────────────────────────────────────

  private computeDurationTrend(records: ExecutionRecord[]): 'increasing' | 'decreasing' | 'stable' | 'insufficient-data' {
    const durations = records
      .filter(r => r.durationMinutes != null)
      .map(r => ({ timestamp: r.timestamp, duration: r.durationMinutes! }));

    if (durations.length < 3) return 'insufficient-data';

    // Sort oldest to newest
    durations.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const mid = Math.floor(durations.length / 2);
    const firstAvg = durations.slice(0, mid).reduce((s, d) => s + d.duration, 0) / mid;
    const secondAvg = durations.slice(mid).reduce((s, d) => s + d.duration, 0) / (durations.length - mid);

    if (firstAvg === 0) return 'stable';

    const ratio = secondAvg / firstAvg;
    if (ratio >= 1.5) return 'increasing';
    if (ratio <= 0.67) return 'decreasing';
    return 'stable';
  }

  // ─── Private: Pattern → Proposal Mapping ─────────────────────────────────

  private patternToProposal(
    jobSlug: string,
    pattern: DetectedPattern,
  ): {
    title: string;
    source: string;
    description: string;
    type: EvolutionType;
    impact: 'high' | 'medium' | 'low';
    effort: 'high' | 'medium' | 'low';
    proposedBy: string;
    tags: string[];
  } | null {
    const source = `living-skills:${jobSlug}`;
    const proposedBy = 'living-skills-analyzer';
    const tags = ['living-skills', jobSlug, pattern.type];

    switch (pattern.type) {
      case 'consistent-addition':
        return {
          title: `Add "${pattern.step}" to ${jobSlug} definition`,
          source,
          description: `${pattern.description}. ${pattern.suggestion}`,
          type: 'workflow',
          impact: pattern.confidence === 'high' ? 'medium' : 'low',
          effort: 'low',
          proposedBy,
          tags,
        };

      case 'consistent-omission':
        return {
          title: `Remove "${pattern.step}" from ${jobSlug} definition`,
          source,
          description: `${pattern.description}. ${pattern.suggestion}`,
          type: 'workflow',
          impact: 'low',
          effort: 'low',
          proposedBy,
          tags,
        };

      case 'duration-drift':
        return {
          title: `Investigate duration drift in ${jobSlug}`,
          source,
          description: `${pattern.description}. ${pattern.suggestion}`,
          type: 'performance',
          impact: 'medium',
          effort: 'medium',
          proposedBy,
          tags,
        };

      case 'gate-ineffective':
        return {
          title: `Review gate effectiveness for ${jobSlug}`,
          source,
          description: `${pattern.description}. ${pattern.suggestion}`,
          type: 'infrastructure',
          impact: 'medium',
          effort: 'medium',
          proposedBy,
          tags,
        };

      case 'novel-addition':
        // Novel additions are informational — no proposal needed
        return null;

      default:
        return null;
    }
  }
}
