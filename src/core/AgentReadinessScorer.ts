/**
 * AgentReadinessScorer — Salim Ismail's "task decomposition matrix" (EXO 3.0).
 *
 * EXO 3.0's central diagnostic: score work on its COORDINATION-vs-JUDGMENT ratio.
 * Coordination work — routing information, approvals, scheduling, status
 * tracking, prescriptive/standardized steps — is what AI agents do best, so it's
 * "agent-ready." Judgment work — resolving ambiguity, handling exceptions,
 * navigating relationships, making a call with no playbook — should stay with
 * (or escalate to) humans. Salim: "every task that scores high on coordination
 * has agent readiness — deploy an agent there this week."
 *
 * This is a deterministic, heuristic scorer (no LLM): it counts coordination vs
 * judgment signal words in a task/workflow description and returns a 0–100
 * readiness score with a recommendation. Deterministic so it's testable and so
 * two readers get the same score. Callers may add an LLM pass on top; the core
 * here is pure.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface TaskInput {
  /** Short task name. */
  name?: string;
  /** Free-text description of the work. */
  description: string;
}

export interface WorkflowInput {
  /** Ordered step descriptions. */
  steps: string[];
  name?: string;
}

export type Recommendation = 'deploy-agent' | 'agent-with-oversight' | 'hybrid' | 'human-led';

export interface ReadinessScore {
  /** Count of coordination signals found. */
  coordinationSignals: number;
  /** Count of judgment signals found. */
  judgmentSignals: number;
  /** coordination / (coordination + judgment); 0..1. 0.5 when no signals. */
  coordinationRatio: number;
  /** 0–100 agent-readiness. Higher = better agent candidate. */
  overallReadiness: number;
  recommendation: Recommendation;
  /** Human-readable explanation. */
  reason: string;
  /** The distinct signal words that matched, for transparency. */
  matched: { coordination: string[]; judgment: string[] };
}

// ── Signal lexicons (EXO 3.0's coordination vs judgment) ─────────────

const COORDINATION_SIGNALS = [
  'route', 'routing', 'approve', 'approval', 'schedule', 'scheduling', 'track',
  'tracking', 'status', 'forward', 'collect', 'compile', 'notify', 'notification',
  'sync', 'reconcile', 'data entry', 'standardized', 'standard', 'prescriptive',
  'repetitive', 'template', 'report', 'reporting', 'log', 'logging', 'aggregate',
  'summarize', 'dispatch', 'assign', 'update', 'fill', 'submit', 'process',
  'checklist', 'rote', 'transcribe', 'categorize', 'sort', 'lookup', 'fetch',
];

const JUDGMENT_SIGNALS = [
  'ambiguity', 'ambiguous', 'exception', 'judgment', 'judgement', 'negotiate',
  'negotiation', 'relationship', 'ethical', 'ethics', 'creative', 'strategy',
  'strategic', 'novel', 'sensitive', 'escalate', 'escalation', 'tradeoff',
  'trade-off', 'nuance', 'nuanced', 'discretion', 'interpret', 'interpretation',
  'persuade', 'empathy', 'conflict', 'unprecedented', 'no playbook', 'gut',
  'intuition', 'priorit', 'weigh', 'decide', 'decision', 'design', 'invent',
];

const READINESS_THRESHOLDS = {
  deployAgent: 75,        // strongly coordination-dominant
  agentWithOversight: 55, // coordination-leaning
  hybrid: 40,             // mixed
};

// ── Helpers ──────────────────────────────────────────────────────────

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

/** Distinct signal words present in the text (word-boundary-ish substring). */
function findSignals(normText: string, lexicon: string[]): string[] {
  const found = new Set<string>();
  for (const sig of lexicon) {
    // match as a whole word / phrase (padded text guarantees boundaries)
    if (normText.includes(` ${sig}`) || normText.includes(`${sig} `) || normText.includes(`${sig}`)) {
      // require the signal to appear bounded to avoid e.g. 'log' in 'logical'
      const re = new RegExp(`(^|[^a-z])${sig.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}([^a-z]|$)`);
      if (re.test(normText)) found.add(sig);
    }
  }
  return [...found];
}

function recommend(readiness: number, coordinationSignals: number, judgmentSignals: number): Recommendation {
  if (coordinationSignals === 0 && judgmentSignals === 0) return 'hybrid';
  if (readiness >= READINESS_THRESHOLDS.deployAgent) return 'deploy-agent';
  if (readiness >= READINESS_THRESHOLDS.agentWithOversight) return 'agent-with-oversight';
  if (readiness >= READINESS_THRESHOLDS.hybrid) return 'hybrid';
  return 'human-led';
}

function scoreText(text: string): ReadinessScore {
  const norm = normalize(text);
  const coordination = findSignals(norm, COORDINATION_SIGNALS);
  const judgment = findSignals(norm, JUDGMENT_SIGNALS);
  const c = coordination.length;
  const j = judgment.length;
  const total = c + j;
  const coordinationRatio = total === 0 ? 0.5 : c / total;
  const overallReadiness = Math.round(coordinationRatio * 100);
  const recommendation = recommend(overallReadiness, c, j);
  const reason =
    total === 0
      ? 'No clear coordination or judgment signals — describe the work in more detail to score it.'
      : `${c} coordination signal(s) vs ${j} judgment signal(s) → ${overallReadiness}/100 agent-readiness. ` +
        (recommendation === 'deploy-agent'
          ? 'Coordination-dominant — a strong agent candidate; deploy with human-on-the-loop oversight.'
          : recommendation === 'agent-with-oversight'
            ? 'Coordination-leaning — deploy an agent but keep a human validating exceptions.'
            : recommendation === 'hybrid'
              ? 'Mixed — split the coordination parts to an agent and keep the judgment calls human.'
              : 'Judgment-dominant — keep this human-led; the agent should only assist.');
  return {
    coordinationSignals: c,
    judgmentSignals: j,
    coordinationRatio,
    overallReadiness,
    recommendation,
    reason,
    matched: { coordination, judgment },
  };
}

// ── Public API ───────────────────────────────────────────────────────

export class AgentReadinessScorer {
  /** Score a single task on its coordination-vs-judgment ratio. */
  score(task: TaskInput): ReadinessScore {
    return scoreText([task.name ?? '', task.description].join('. '));
  }

  /** Score a workflow (all steps combined). */
  scoreWorkflow(workflow: WorkflowInput): ReadinessScore {
    return scoreText([workflow.name ?? '', ...workflow.steps].join('. '));
  }
}
