/**
 * MentorAutonomousGuardian — the "just be Echo" autonomous-fix loop core
 * (MENTOR-AUTONOMOUS-FIX-LOOP-SPEC).
 *
 * Where {@link runMentorTick} OBSERVES + LOGS (a tool-less haiku composes a
 * check-in, Stage-B captures findings to a read-only ledger, nothing is fixed),
 * this guardian makes the mentor heartbeat KEEP ONE FULL-TOOL OPUS SESSION
 * ALIVE on the manual dogfooding loop. The spawned session IS an Echo clone: it
 * assigns the mentee a real task over Telegram, observes the UX + the mentee's
 * internals, FIXES whatever is broken as a proper fleet-wide PR, and reports —
 * exactly the loop a developer runs by hand. (Justin's constraint: all fixing
 * is done by an Opus model, ideally "just be you taking on that job".)
 *
 * This module is PURE orchestration: every side-effect (the spawn, the
 * already-running check, the goal builder) is injected, so the gate logic is
 * unit-testable with no SessionManager / tmux / LLM. The structural guarantees
 * live HERE, in code, not in a prompt:
 *
 *   - enabled gate    — ships dark; a disabled config never spawns or spends.
 *   - budget gate     — fail-closed BEFORE any spawn (the mentor per-day cap).
 *   - single-instance — never more than ONE loop session. A single cycle
 *     (assign → observe → fix-as-PR → report) outlives MANY heartbeat ticks, so
 *     this is the gate that stops a 15-min heartbeat from spawn-storming
 *     expensive Opus sessions: if a loop session is alive, the tick is a no-op.
 *   - min-interval    — even after a cycle ends, a brief floor before respawn.
 *
 * Order is load-bearing: enabled → budget → single-instance → min-interval → spawn.
 */

export interface AutonomousGuardianDeps {
  /** The framework being mentored (parametric; flows into the goal prompt). */
  framework: string;
  /** mentor.autonomousFix.enabled — the master switch (ships dark when false). */
  enabled: boolean;
  /** Fail-closed budget gate — shared with the observe-pipeline (per-day round
   *  cap). Checked BEFORE any spawn so a depleted budget never starts a cycle. */
  budgetOk: boolean;
  /** True when a loop session (name-prefix match) is already running. The
   *  single-instance invariant: at most one Opus loop session at a time. */
  loopSessionAlive: boolean;
  /** Min-interval floor elapsed since the last spawn (anti spawn-storm). */
  minIntervalElapsed: boolean;
  /** The model the spawned loop session runs on (Justin's constraint: opus). */
  model: string;
  /** Build the dogfooding-loop goal prompt for the spawned session. Injected so
   *  the host can parameterize it (mentee name, topics) without this core
   *  depending on config shape. */
  buildGoal: () => string;
  /** Spawn the full-tool Opus loop session; resolves with its session name.
   *  Injected so the pure guardian has no SessionManager dependency. */
  spawnLoopSession: (goal: string, model: string) => Promise<{ sessionName: string }>;
  /** Tick id for provenance. */
  tickId?: string;
  now?: () => number;
}

export type AutonomousGuardianReason =
  | 'disabled'
  | 'budget'
  | 'loop-active'
  | 'unsafe-interval'
  | 'spawned'
  | 'spawn-failed';

export interface AutonomousGuardianResult {
  ran: boolean;
  reason: AutonomousGuardianReason;
  /** The spawned loop session's name (only when reason === 'spawned'). */
  sessionName?: string;
  /** Underlying error message (only when reason === 'spawn-failed'). */
  error?: string;
}

/**
 * Run one guardian tick. Returns a structured result; the only side effect is
 * the injected {@link AutonomousGuardianDeps.spawnLoopSession}. Order is
 * load-bearing — see the module doc.
 */
export async function runAutonomousGuardian(
  deps: AutonomousGuardianDeps,
): Promise<AutonomousGuardianResult> {
  // 1. enabled — ships dark; a disabled config never spawns or spends.
  if (!deps.enabled) return { ran: false, reason: 'disabled' };

  // 2. budget — fail-closed BEFORE any spawn (reuses the mentor per-day round
  //    cap). A depleted budget must never start an expensive Opus cycle.
  if (!deps.budgetOk) return { ran: false, reason: 'budget' };

  // 3. single-instance — never more than ONE loop session. A cycle outlives many
  //    heartbeat ticks, so without this gate the 15-min heartbeat would
  //    spawn-storm. If one is alive, the tick is a deliberate no-op.
  if (deps.loopSessionAlive) return { ran: false, reason: 'loop-active' };

  // 4. min-interval — a brief floor before respawning after a cycle ends, so a
  //    fast-finishing or fast-failing cycle can't busy-loop.
  if (!deps.minIntervalElapsed) return { ran: false, reason: 'unsafe-interval' };

  // 5. spawn the full-tool Opus loop session (the Echo clone running the loop).
  try {
    const { sessionName } = await deps.spawnLoopSession(deps.buildGoal(), deps.model);
    return { ran: true, reason: 'spawned', sessionName };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ran: false, reason: 'spawn-failed', error: message };
  }
}

export interface AutoloopGoalParams {
  /** The mentee's agent-registry name (e.g. 'instar-codey'). */
  menteeAgentName: string;
  /** The mentee framework (e.g. 'codex-cli'). */
  menteeFramework: string;
  /** Telegram topic the spawned Echo reports progress to (the human's topic). */
  reportTopicId?: number;
  /** Telegram topic the spawned Echo drives the mentee in. */
  menteeTopicId?: number;
}

/**
 * The built-in dogfooding-loop goal prompt for the spawned Opus session. This
 * is the durable encoding of "replicate exactly what you've been doing": one
 * full cycle of health-check → assign → observe → fix-as-PR → report, with the
 * same verify-don't-confabulate discipline, then a clean exit (the guardian —
 * not the session — starts the next cycle). Pure + deterministic so it is
 * unit-testable. A host may override it via mentor.autonomousFix.goalTemplate.
 */
export function buildAutoloopGoal(p: AutoloopGoalParams): string {
  const driveIn = p.menteeTopicId !== undefined ? ` (Telegram topic ${p.menteeTopicId})` : '';
  const reportLine =
    p.reportTopicId !== undefined
      ? `Report what happened — honestly, including anything skipped or still failing — to Telegram topic ${p.reportTopicId} (.instar/scripts/telegram-reply.sh).`
      : `Report what happened — honestly, including anything skipped or still failing — to your owner over Telegram.`;
  return [
    `You are Echo, the instar developer agent, running ONE autonomous cycle of the ${p.menteeFramework} (${p.menteeAgentName}) dogfooding-and-fix loop.`,
    `This is the exact loop a developer runs by hand: drive the mentee through real work, watch the experience from both sides, and FIX what is broken — fully, as shipped code.`,
    ``,
    `Do, in order:`,
    `1. HEALTH FIRST. Check ${p.menteeAgentName}'s health (its server /health, recent logs, sqlite subsystems). If it is down or crash-looping, recover it self-healingly before anything else — that recovery IS this cycle. If a problem can affect other instar agents, fix it fleet-wide.`,
    `2. ASSIGN. If the mentee is healthy and idle, give it ONE real, useful instar development task over Telegram${driveIn} — a genuine improvement, not a toy exercise.`,
    `3. OBSERVE BOTH SIDES. (a) The Telegram UX: is it seamless and coherent — no leaked internals, no confusing receipts, replies that make sense to a human watching? (b) The mentee's internals: logs, health, token/rate-limit pressure, any errors or stalls.`,
    `4. FIX. For any instar or ${p.menteeFramework} issue you find, fix it as a PROPER fleet-wide PR: converged+approved spec → build → all three test tiers green → the instar-dev ship gate → merge to JKHeadley/main → release → deploy → re-verify on the DEPLOYED artifact. All fixing is yours, on this Opus model. A bug that bricks/downs an agent, loses data, breaks the mandatory Telegram relay, or hits security: fix and deploy without asking.`,
    `5. ${reportLine}`,
    ``,
    `Discipline (non-negotiable): verify before you claim — never write a result or a number before the producing tool has returned it. Never narrate a tool call you did not make. One cycle, then exit cleanly — do NOT spawn another copy of this loop or schedule a follow-up; the guardian starts the next cycle on its own heartbeat.`,
    `Gate compliance (ratchet gates): an intentional best-effort/fail-open catch must either report through DegradationReporter or carry an inline @silent-fallback-ok justification — never bump a ratchet baseline to pass CI. When you author a task brief or spec for another agent, spell these gate notes out explicitly: a spec that says "best-effort, never throws" without them invites the exact ratchet failure it is trying to avoid.`,
    `Before you build (parallel-claim check): run \`instar dev:claim-check <paths you intend to touch> [--keywords ...]\` FIRST — if an open/recently-merged PR or a spec already owns a layer of the problem, claim a DIFFERENT layer explicitly (division-of-labor; earned 2026-06-05 when two parallel sessions built the same incident fix twice). And every PR DESCRIPTION must include an \`## ELI16\` section (a required CI gate) — write it in from the start, not after the gate goes red.`,
  ].join('\n');
}
