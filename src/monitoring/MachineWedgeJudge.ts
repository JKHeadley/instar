/**
 * machineWedgeJudge (docs/specs/machine-self-maintenance.md, Part E "Decision").
 *
 * One bounded judge call per wedge candidate, on the agent's ordinary internal
 * intelligence path, attributed (`MachineWedgeJudge`) and enrolled in the Decision
 * Quality meter. It sees structured evidence only: families, results, fixed
 * reasons, ages, uptime, blockers and a session count. Never window titles,
 * dialog text or command output.
 *
 * Its answer is a PROPOSAL from a bounded space of four. In this build it is
 * recorded and nothing else: no rung exists, and while `wedgeRestart.dryRun` is on
 * even a later build only records it. An unusable answer, an error or a timeout is
 * `null`, and the caller records the deterministic fallback (gentle rungs plus the
 * next window brought forward), never a restart.
 */

import type { IntelligenceProvider } from '../core/types.js';
import { buildBoundedContext, buildStructuredSha256Identity } from '../core/JudgmentProvenanceLog.js';
import { DP_MACHINE_WEDGE_JUDGE } from '../data/provenanceCoverage.js';
import { JUDGE_ACTIONS, type JudgeAction } from './machineMaintenance/wedgeWindow.js';
import type { JudgeAnswer, WedgeJudgeEvidence } from './machineMaintenance/WedgeMonitor.js';

export const MACHINE_WEDGE_JUDGE_PROMPT_ID = 'machine-wedge-judge-v1';
export const MACHINE_WEDGE_JUDGE_COMPONENT = 'MachineWedgeJudge';
export const MACHINE_WEDGE_JUDGE_TIMEOUT_MS = 90_000;
const MAX_REASON_CHARS = 200;

export function buildMachineWedgePrompt(evidence: WedgeJudgeEvidence): string {
  return [
    'You decide what an agent should do about a machine that may be wedged: its GUI or process path looks unusable.',
    'Two independent evidence families have been positive at every observation for the window below.',
    'Families: F1 = launching a no-op through the OS (GUI path), F2 = the process table (ps timing, fork failure, rising uninterruptible processes),',
    'F3 = a stuck system dialog (often not covered), F4 = the agent server itself (impaired or lagging while the CPU is idle, spawn failures).',
    'A result of unknown, ineligible or not-covered means that family could not be read; it is NOT evidence of health.',
    '',
    'Choose exactly one action:',
    '- leave: the evidence does not show a wedge worth acting on.',
    '- gentle: close the agent\'s own idle browsers, clear a known harmless stuck dialog, restart the agent\'s desktop helper.',
    '- restart-next-window: the gentle steps, then restart in the next small-hours maintenance window.',
    '- restart-now: the gentle steps, then a short planned restart now, with work paused first.',
    'Prefer the least disruptive action the evidence supports. A machine that was restarted recently should not be restarted again.',
    '',
    'Evidence (JSON, structured readings only):',
    JSON.stringify(evidence),
    '',
    'Answer with one JSON object and nothing else: {"action":"leave|gentle|restart-next-window|restart-now","reason":"one short sentence"}',
  ].join('\n');
}

/** Strict: the first JSON object, one of the four actions, a short string reason. Anything else is null. */
export function parseMachineWedgeAnswer(raw: string): JudgeAnswer {
  if (typeof raw !== 'string') return null;
  const start = raw.indexOf('{');
  const end = raw.indexOf('}', start);
  if (start < 0 || end < 0) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return null; } // @silent-fallback-ok — unparseable is the documented null
  const obj = parsed as { action?: unknown; reason?: unknown };
  if (typeof obj.action !== 'string' || !JUDGE_ACTIONS.includes(obj.action as JudgeAction)) return null;
  const reason = typeof obj.reason === 'string' ? obj.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS) : '';
  return { action: obj.action as JudgeAction, reason };
}

/** Identity-only provenance context: the evidence numbers and a prompt digest, never text. */
export function buildMachineWedgeDecisionContext(evidence: WedgeJudgeEvidence, prompt: string): Record<string, unknown> {
  const results: Record<string, string> = {};
  for (const [f, r] of Object.entries(evidence.families)) results[f] = r.result;
  return buildBoundedContext({
    promptIdentitySha256: buildStructuredSha256Identity(prompt),
    pair: evidence.pair,
    familyResults: results,
    observations: evidence.observations,
    windowMinutes: evidence.windowMinutes,
    uptimeHours: evidence.uptimeHours,
    recentlyRestarted: evidence.recentlyRestarted,
    sessionsCount: evidence.sessionsCount,
    blockerCount: evidence.blockers.length,
  });
}

/** The judge the WedgeMonitor is given. Null provider: no judge here, and the fallback is recorded. */
export function makeMachineWedgeJudge(intelligence: IntelligenceProvider | null | undefined): ((evidence: WedgeJudgeEvidence) => Promise<JudgeAnswer>) | null {
  if (!intelligence) return null;
  return async (evidence) => {
    const prompt = buildMachineWedgePrompt(evidence);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), MACHINE_WEDGE_JUDGE_TIMEOUT_MS); timer.unref?.(); });
    try {
      const raw = await Promise.race([
        intelligence.evaluate(prompt, {
          model: 'balanced',
          temperature: 0,
          maxTokens: 300,
          attribution: { component: 'MachineWedgeJudge' },
          provenance: {
            decisionPoint: DP_MACHINE_WEDGE_JUDGE,
            context: buildMachineWedgeDecisionContext(evidence, prompt),
            optionsPresented: [...JUDGE_ACTIONS],
            promptId: MACHINE_WEDGE_JUDGE_PROMPT_ID,
          },
        }),
        timeout,
      ]);
      return raw === null ? null : parseMachineWedgeAnswer(raw);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
