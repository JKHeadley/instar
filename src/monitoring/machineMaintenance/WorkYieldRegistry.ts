/**
 * The work yield contract (docs/specs/machine-self-maintenance.md, Part D).
 *
 * One code-owned table of every kind of long work and how it makes way for a
 * restart. Increment 1 is a contract and a census: each entry says what would
 * happen, and `discover()` reads what is running.
 *
 * There is deliberately no `yield()` here. A kind has no callable that stops it,
 * so nothing built on this table can stop work. The spec's `yield()`, `readBack()`
 * and `undoYield()` arrive with the increment that makes the drain real.
 *
 * Work found running with no declared kind delays a restart by a bounded amount
 * and reaches the owner by name (D2). It neither stalls restarts for ever nor ends
 * silently.
 */

export type YieldClass = 'cancel-requeue' | 'checkpoint-resume' | 'stop-at-boundary' | 'finish-bounded';

export interface WorkItem {
  kind: string;
  /** Stable for one piece of work across ticks. */
  key: string;
  label: string;
  /** A session at its prompt has reached its own yield point. Null when unread. Absent for work with no boundary. */
  atBoundary?: boolean | null;
}

export interface WorkCensusInputs {
  sessions: Array<{
    name: string; tmuxSession: string; topicId?: number; jobSlug?: string; atBoundary: boolean | null;
    /** Slack routing key (`<channel>` or `<channel>:<thread>`) when a Slack conversation owns this session. */
    slackRoutingKey?: string;
  }>;
  autonomousRuns: Array<{ topic: string; goal?: string }>;
  localVerifyRunning: Array<{ pr: number; headSha?: string }>;
  localVerifyQueued: Array<{ pr: number; headSha?: string }>;
  testRuns: Array<{ pid: number; acquiredAt: number; lane: 'suite' | 'targeted' }>;
  scriptRuns: string[];
}

export interface WorkYieldEntry {
  kind: string;
  class: YieldClass;
  /** Minutes before T-0 that this kind would be asked to yield. */
  askOffsetMinutes: number;
  /** The real chokepoint this kind starts from, walked by the registry test. */
  spawnChokepoint: string;
  wouldYield: string;
  comesBackVia: 'resume-queue' | 'slack-channel-resume' | 'requeue' | 'next-trigger' | 'repeat-by-session';
  maxYieldSeconds: number;
  discover(input: WorkCensusInputs): WorkItem[];
}

const sessionLabel = (s: WorkCensusInputs['sessions'][number]): string => (s.topicId !== undefined ? `topic ${s.topicId}` : s.name);
const isSlack = (s: WorkCensusInputs['sessions'][number]): boolean => !s.jobSlug && !!s.slackRoutingKey;

export const WORK_YIELD_REGISTRY: readonly WorkYieldEntry[] = [
  {
    kind: 'local-verify-run',
    class: 'cancel-requeue',
    askOffsetMinutes: 10,
    spawnChokepoint: 'src/localVerify/LocalVerifyService.ts',
    wouldYield: 'cancel the run, keeping its place first in line',
    comesBackVia: 'requeue',
    maxYieldSeconds: 60,
    discover: (i) => i.localVerifyRunning.map((v) => ({ kind: 'local-verify-run', key: `lv-run:${v.pr}:${v.headSha ?? ''}`, label: `PR ${v.pr}` })),
  },
  {
    kind: 'local-verify-queue',
    class: 'cancel-requeue',
    askOffsetMinutes: 45,
    spawnChokepoint: 'src/localVerify/LocalVerifyService.ts',
    wouldYield: 'offer the queue to the new lease holder in order',
    comesBackVia: 'requeue',
    maxYieldSeconds: 60,
    discover: (i) => i.localVerifyQueued.map((v) => ({ kind: 'local-verify-queue', key: `lv-queue:${v.pr}:${v.headSha ?? ''}`, label: `PR ${v.pr}` })),
  },
  {
    kind: 'test-suite',
    class: 'cancel-requeue',
    askOffsetMinutes: 10,
    spawnChokepoint: 'src/core/hostTestRunnerSemaphore.ts',
    wouldYield: 'end the run; the session is told to repeat it',
    comesBackVia: 'repeat-by-session',
    maxYieldSeconds: 30,
    discover: (i) => i.testRuns.filter((t) => t.lane === 'suite').map((t) => ({ kind: 'test-suite', key: `test:${t.pid}:${t.acquiredAt}`, label: `test run ${t.pid}` })),
  },
  {
    kind: 'test-targeted',
    class: 'cancel-requeue',
    askOffsetMinutes: 10,
    spawnChokepoint: 'src/core/hostTestRunnerSemaphore.ts',
    wouldYield: 'end the run; the session is told to repeat it',
    comesBackVia: 'repeat-by-session',
    maxYieldSeconds: 30,
    discover: (i) => i.testRuns.filter((t) => t.lane === 'targeted').map((t) => ({ kind: 'test-targeted', key: `test:${t.pid}:${t.acquiredAt}`, label: `test run ${t.pid}` })),
  },
  {
    kind: 'session',
    class: 'stop-at-boundary',
    askOffsetMinutes: 20,
    spawnChokepoint: 'src/core/SessionManager.ts',
    wouldYield: 'one stop-at-next-boundary notice, then an interrupt at T-5',
    comesBackVia: 'resume-queue',
    maxYieldSeconds: 900,
    discover: (i) => i.sessions.filter((s) => !s.jobSlug && !isSlack(s)).map((s) => ({ kind: 'session', key: `session:${s.tmuxSession}`, label: sessionLabel(s), atBoundary: s.atBoundary })),
  },
  {
    // A Slack session has a resume path of its own: beforeSessionKill and shutdown save its
    // conversation in the channel-resume map, and the next message in that channel or thread
    // respawns it from there. It returns on that message, not from the resume queue, so it is
    // counted apart. The saved resume lasts 24 hours.
    kind: 'slack-session',
    class: 'stop-at-boundary',
    askOffsetMinutes: 20,
    spawnChokepoint: 'src/core/SessionManager.ts',
    wouldYield: 'one stop-at-next-boundary notice, then an interrupt at T-5',
    comesBackVia: 'slack-channel-resume',
    maxYieldSeconds: 900,
    discover: (i) => i.sessions.filter(isSlack).map((s) => ({ kind: 'slack-session', key: `slack-session:${s.tmuxSession}`, label: `Slack ${s.slackRoutingKey}`, atBoundary: s.atBoundary })),
  },
  {
    kind: 'job-session',
    class: 'checkpoint-resume',
    askOffsetMinutes: 20,
    spawnChokepoint: 'src/scheduler/JobScheduler.ts',
    wouldYield: 'as a session, with a resume entry whether or not the job sets resumeOnReap',
    comesBackVia: 'resume-queue',
    maxYieldSeconds: 900,
    discover: (i) => i.sessions.filter((s) => s.jobSlug).map((s) => ({ kind: 'job-session', key: `job:${s.tmuxSession}`, label: `job ${s.jobSlug}`, atBoundary: s.atBoundary })),
  },
  {
    kind: 'script-job',
    class: 'checkpoint-resume',
    askOffsetMinutes: 5,
    spawnChokepoint: 'src/scheduler/JobScheduler.ts',
    wouldYield: 'end it at T-5 and record the run as yielded, not failed',
    comesBackVia: 'next-trigger',
    maxYieldSeconds: 30,
    discover: (i) => i.scriptRuns.map((id) => ({ kind: 'script-job', key: `script:${id}`, label: `script run ${id}` })),
  },
  {
    kind: 'autonomous-run',
    class: 'checkpoint-resume',
    askOffsetMinutes: 20,
    spawnChokepoint: 'src/core/AutonomousSessions.ts',
    wouldYield: 'mark the state file suspended for this episode so stopping is not a completion',
    comesBackVia: 'resume-queue',
    maxYieldSeconds: 900,
    discover: (i) => i.autonomousRuns.map((r) => ({ kind: 'autonomous-run', key: `autonomous:${r.topic}`, label: `topic ${r.topic}` })),
  },
];

export function discoverWork(input: WorkCensusInputs): WorkItem[] {
  return WORK_YIELD_REGISTRY.flatMap((entry) => entry.discover(input));
}

export function yieldEntryFor(kind: string): WorkYieldEntry | undefined {
  return WORK_YIELD_REGISTRY.find((e) => e.kind === kind);
}
